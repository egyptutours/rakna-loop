import { describe, expect, it, vi } from "vitest";
import { cellToLatLng, getResolution } from "h3-js";
import { childrenOf, hiveIndexFor, neighborhood, parentOf, cellsForViewport, type BBox } from "@/lib/hive/cells";
import { classifyState, summarizeCells } from "@/lib/hive/aggregation";
import { queryHiveMap, bandFor } from "@/lib/hive/map-query";
import { toHiveSignal } from "@/lib/hive/signals";
import { recordSignalOutcome } from "@/lib/hive/verification";
import { recordDemand } from "@/lib/hive/demand";
import { diversify, recruit } from "@/lib/hive/swarm";
import { runHiveLifecycle } from "@/lib/hive/lifecycle";
import { BoundedCache, reconcileIds } from "@/lib/hive/cache";
import { HiveViewportLoader, viewportKey } from "@/lib/client/hive-viewport";
import { DEFAULT_HIVE_CONFIG } from "@/lib/hive/config";
import { signalFreshness } from "@/lib/hive/decay";
import { claimReport, confirmReport, createReport } from "@/lib/domain/handoff";
import { createBooking, submitSpace } from "@/lib/domain/marketplace";
import type { DepartureReport } from "@/lib/types";
import { A, B, OLAYA_SPOT, PARTNER, gps, move, none, setup } from "./helpers";

const OLAYA_STREET: BBox = { west: OLAYA_SPOT.lng - 0.006, east: OLAYA_SPOT.lng + 0.006, south: OLAYA_SPOT.lat - 0.005, north: OLAYA_SPOT.lat + 0.005 };
const SEED_SIGNAL = { lat: 24.69412, lng: 46.68531 }; // seeded live Olaya signal
const around = (p: { lat: number; lng: number }, d = 0.005): BBox => ({ west: p.lng - d, east: p.lng + d, south: p.lat - d, north: p.lat + d });

/** Fill the store with many live reports spread over Riyadh (synthetic, test-only). */
async function seedCity(env: ReturnType<typeof setup>, n: number) {
  for (let i = 0; i < n; i++) {
    const lat = 24.55 + ((i * 7919) % 1000) / 1000 * 0.4;
    const lng = 46.5 + ((i * 104729) % 1000) / 1000 * 0.45;
    const loc = { lat, lng };
    const now = env.now.toISOString();
    const r: DepartureReport = {
      id: crypto.randomUUID(), reporterId: "00000000-0000-4000-a000-000000000101", location: loc, accuracyM: 10, neighborhood: "olaya", note: null,
      createdAt: now, expectedDepartureAt: now, expiresAt: new Date(env.now.getTime() + 20 * 60_000).toISOString(), status: "available",
      claimedBy: null, claimedAt: null, claimExpiresAt: null, claimLocation: null, resolvedAt: null, isDemo: true, hive: hiveIndexFor(loc), aggregatedAt: null,
    };
    await env.repo.insertReport(r);
  }
}

describe("1–2. Viewport-only queries; never the whole city", () => {
  it("queries only cells that cover the visible viewport, and never scans all reports", async () => {
    const env = setup();
    const inCells = vi.spyOn(env.repo, "listReportsInCells");
    const fullScan = vi.spyOn(env.repo, "listReports");
    await queryHiveMap(env.ctx, { bbox: OLAYA_STREET, zoom: 16, viewer: null });
    expect(inCells).toHaveBeenCalled();
    for (const [, cells] of inCells.mock.calls) {
      expect(cells.length).toBeLessThanOrEqual(DEFAULT_HIVE_CONFIG.maxCellsPerQuery);
      for (const c of cells) {
        const [lat, lng] = cellToLatLng(c);
        // every queried cell is inside the viewport padded by ~one coarse cell (+1 ring)
        expect(lat).toBeGreaterThan(OLAYA_STREET.south - 0.02);
        expect(lat).toBeLessThan(OLAYA_STREET.north + 0.02);
        expect(lng).toBeGreaterThan(OLAYA_STREET.west - 0.02);
        expect(lng).toBeLessThan(OLAYA_STREET.east + 0.02);
      }
    }
    // Only per-reporter lookups (reliability), never an unfiltered city-wide listReports().
    expect(fullScan.mock.calls.every(([f]) => Boolean(f?.reporterId || f?.reporterIds?.length))).toBe(true);
  });

  it("returns a bounded, viewport-local payload even with thousands of city-wide reports", async () => {
    const env = setup();
    await seedCity(env, 2500);
    expect((await env.repo.stats()).reports).toBeGreaterThan(2500);
    const street = await queryHiveMap(env.ctx, { bbox: around({ lat: 24.75, lng: 46.72 }, 0.004), zoom: 16.5, viewer: null });
    expect(street.mode).toBe("street");
    expect(street.signals.length + street.clusters.reduce((s, c) => s + c.count, 0)).toBeLessThan(150);
    for (const s of street.signals) {
      expect(s.location.lat).toBeGreaterThan(24.746 - 0.001);
      expect(s.location.lat).toBeLessThan(24.754 + 0.001);
    }
    // City-wide view: aggregated cells only, capped, no individual signals.
    const city = await queryHiveMap(env.ctx, { bbox: { west: 46.45, east: 47.0, south: 24.5, north: 25.0 }, zoom: 10, viewer: null });
    expect(city.mode).toBe("aggregate");
    expect(city.signals).toHaveLength(0);
    expect(city.meta.queriedCells).toBeLessThanOrEqual(DEFAULT_HIVE_CONFIG.maxCellsPerQuery);
    expect(JSON.stringify(city).length).toBeLessThan(400_000);
  });

  it("coarsens the resolution instead of exploding the cell count", () => {
    const res = cellsForViewport({ west: 46.3, east: 46.9, south: 24.4, north: 25.0 }, 10, 400);
    expect(res.coarsened).toBe(true);
    expect(res.resolution).toBeLessThan(10);
    expect(res.cells.length).toBeLessThanOrEqual(400);
  });
});

describe("3–4. H3 hierarchy and neighbors", () => {
  it("indexes every resolution consistently and keeps exact coordinates", async () => {
    const idx = hiveIndexFor(OLAYA_SPOT);
    expect([idx.r7, idx.r8, idx.r9, idx.r10].map(getResolution)).toEqual([7, 8, 9, 10]);
    expect(parentOf(idx.r10, 9)).toBe(idx.r9);
    expect(parentOf(idx.r9, 7)).toBe(idx.r7);
    expect(childrenOf(idx.r9, 10)).toContain(idx.r10);
    const env = setup();
    const r = await createReport(env.ctx, A, { ...gps(OLAYA_SPOT, 8), departInMinutes: 0 });
    expect(r.hive?.r10).toBe(idx.r10);
    expect(r.location).toEqual(OLAYA_SPOT); // not replaced by the hexagon center
  });

  it("rolls child cell activity up into the parent cell", async () => {
    const env = setup();
    const idx = hiveIndexFor(SEED_SIGNAL);
    const kids = childrenOf(idx.r8, 9);
    const children = await summarizeCells(env.ctx, 9, kids);
    const parent = (await summarizeCells(env.ctx, 8, [idx.r8])).get(idx.r8)!;
    const sum = (f: (s: (typeof parent)) => number) => [...children.values()].reduce((a, s) => a + f(s), 0);
    expect(parent.supply.signals).toBe(sum((s) => s.supply.signals));
    expect(parent.supply.privateSpaces).toBe(sum((s) => s.supply.privateSpaces));
    expect(parent.demand.searches).toBeCloseTo(sum((s) => s.demand.searches), 0);
  });

  it("returns the ring of neighboring cells with their information", async () => {
    const env = setup();
    const home = hiveIndexFor(SEED_SIGNAL).r9;
    const ring = neighborhood(home, 1);
    expect(ring).toHaveLength(7);
    const s = await summarizeCells(env.ctx, 9, ring);
    expect(s.size).toBe(7);
    // A forager one ring away is recruited to the signal in the neighboring hive.
    const neighborCell = ring.find((c) => c !== home)!;
    const [lat, lng] = cellToLatLng(neighborCell);
    const res = await recruit(env.ctx, { location: { lat, lng }, viewer: null });
    expect(res.opportunities.some((o) => o.signal.cellR9 === home && o.ring >= 1)).toBe(true);
  });
});

describe("5. Expired signals disappear from active results", () => {
  it("drops a signal from the live map once it expires", async () => {
    const env = setup();
    const r = await createReport(env.ctx, A, { ...gps(OLAYA_SPOT, 8), departInMinutes: 0 });
    const before = await queryHiveMap(env.ctx, { bbox: OLAYA_STREET, zoom: 16.5, viewer: null });
    expect(before.signals.map((s) => s.id)).toContain(r.id);
    expect(signalFreshness(r, new Date(env.now.getTime() + 8 * 60_000), 8)).toBeCloseTo(0.5, 2); // half-life decay
    env.advance(21);
    const after = await queryHiveMap(env.ctx, { bbox: OLAYA_STREET, zoom: 16.5, viewer: null });
    expect(after.signals.map((s) => s.id)).not.toContain(r.id);
    expect(after.inactive.map((s) => s.id)).toContain(r.id);
  });
});

describe("6–7. Signal reliability follows verification feedback", () => {
  async function reliabilityAfter(outcome: "found" | "not_found") {
    const env = setup();
    const spot = move(OLAYA_SPOT, 0, 2500); // a hive with no seeded history
    for (let i = 0; i < 4; i++) {
      const r = await createReport(env.ctx, A, { ...gps(move(spot, i * 25), 8), departInMinutes: 0 });
      await claimReport(env.ctx, B, r.id, none);
      env.advance(2);
      await confirmReport(env.ctx, B, r.id, { ...gps(move(spot, i * 25 + 5)), outcome });
      env.advance(45);
    }
    const probe = await createReport(env.ctx, "00000000-0000-4000-a000-000000000103", { ...gps(move(spot, 10), 8), departInMinutes: 0 }).catch(async () => {
      await env.repo.updateReport("00000000-0000-4000-c000-000000000003", { status: "expired" });
      return createReport(env.ctx, "00000000-0000-4000-a000-000000000103", { ...gps(move(spot, 10), 8), departInMinutes: 0 });
    });
    return toHiveSignal(env.ctx, probe, null);
  }

  it("increases with valid confirmations and decreases with failed ones", async () => {
    const env = setup();
    const spot = move(OLAYA_SPOT, 0, 2500);
    await env.repo.updateReport("00000000-0000-4000-c000-000000000003", { status: "expired" });
    const baseline = await toHiveSignal(env.ctx, await createReport(env.ctx, "00000000-0000-4000-a000-000000000103", { ...gps(spot, 8), departInMinutes: 0 }), null);
    const good = await reliabilityAfter("found");
    const bad = await reliabilityAfter("not_found");
    expect(baseline.verification.trailSamples).toBe(0);
    expect(good.verification.trailScore).toBeGreaterThan(baseline.verification.trailScore);
    expect(good.reliability).toBeGreaterThan(baseline.reliability);
    expect(bad.verification.trailScore).toBeLessThan(baseline.verification.trailScore);
    expect(bad.reliability).toBeLessThan(baseline.reliability);
    expect(good.confidence.score).toBeGreaterThan(bad.confidence.score);
  });
});

describe("8. Duplicate reports/confirmations never duplicate rewards or trail counts", () => {
  it("counts an outcome once in the ledger and once in the hive trail", async () => {
    const env = setup();
    const r = await createReport(env.ctx, A, { ...gps(OLAYA_SPOT, 8), departInMinutes: 0 });
    await claimReport(env.ctx, B, r.id, none);
    env.advance(2);
    await confirmReport(env.ctx, B, r.id, { ...gps(OLAYA_SPOT), outcome: "found" });
    await expect(confirmReport(env.ctx, B, r.id, { ...gps(OLAYA_SPOT), outcome: "found" })).rejects.toMatchObject({ code: "already_confirmed" });
    await recordSignalOutcome(env.ctx, (await env.repo.getReport(r.id))!); // replay is a no-op
    await runHiveLifecycle(env.ctx); // lifecycle must not re-fold it
    const cell = hiveIndexFor(OLAYA_SPOT).r10;
    const stats = (await env.repo.listCellStats(10, [cell], "2000-01-01T00:00:00.000Z")).reduce((s, x) => s + x.found, 0);
    expect(stats).toBe(1);
    expect((await env.repo.listLedger()).filter((e) => e.refId === r.id)).toHaveLength(2);
  });
});

describe("9. A high-demand hive discovers nearby alternatives", () => {
  it("surfaces neighbor hives, private parking and transit when the home hive is strained", async () => {
    const env = setup();
    const busy = { lat: 24.6890, lng: 46.6905 }; // seeded: demand, no verified supply
    for (let i = 0; i < 5; i++) await recordDemand(env.ctx, busy);
    const res = await recruit(env.ctx, { location: busy, viewer: null });
    expect(["high_demand", "overloaded"]).toContain(res.home.state);
    expect(res.opportunities.every((o) => o.ring >= 1)).toBe(true);
    expect(res.opportunities.length + res.privateAlternatives.length + res.neighborAlternatives.length).toBeGreaterThan(0);
    expect(res.transitAlternatives.every((t) => t.illustrative)).toBe(true);
    expect(res.advice.some((a) => a.en.includes("Rather than circling"))).toBe(true);
    // No task ever asks the user to drive somewhere for points.
    expect(JSON.stringify(res.advice)).not.toMatch(/earn|keys|points/i);
  });

  it("keeps valid opportunities from quiet hives in the list (fairness cap)", () => {
    const busy = Array.from({ length: 8 }, (_, i) => ({ id: `b${i}`, cell: "busy", score: 0.9 - i * 0.01 }));
    const quiet = [{ id: "q1", cell: "quiet", score: 0.5 }];
    const picked = diversify([...busy, ...quiet], 4, 2);
    expect(picked.map((p) => p.id)).toContain("q1");
    expect(picked.filter((p) => p.cell === "busy").length).toBe(3); // 2 capped + 1 fill
  });
});

describe("10. Zoom changes the level of detail", () => {
  it("aggregates at low zoom and reveals individual signals at street zoom", async () => {
    const env = setup();
    const low = await queryHiveMap(env.ctx, { bbox: around(SEED_SIGNAL, 0.08), zoom: 11, viewer: null });
    const mid = await queryHiveMap(env.ctx, { bbox: around(SEED_SIGNAL, 0.02), zoom: 14, viewer: null });
    const street = await queryHiveMap(env.ctx, { bbox: around(SEED_SIGNAL, 0.004), zoom: 16.5, viewer: null });
    expect(low.mode).toBe("aggregate");
    expect(low.signals).toHaveLength(0);
    expect(low.spaces).toHaveLength(0);
    expect(mid.resolution).toBeGreaterThan(low.resolution);
    expect(street.mode).toBe("street");
    expect(street.resolution).toBe(10);
    expect(street.signals.length + street.spaces.length).toBeGreaterThan(0);
    expect(bandFor(11, DEFAULT_HIVE_CONFIG.zoomBands).resolution).toBe(7);
    expect(bandFor(16, DEFAULT_HIVE_CONFIG.zoomBands).mode).toBe("street");
  });
});

describe("11. Frontend memory stays bounded during repeated map movement", () => {
  it("keeps the viewport cache within its LRU bound and applies only the latest viewport", async () => {
    const applied: string[] = [];
    const loader = new HiveViewportLoader<{ q: string }>(async (q) => ({ q }), (_d, key) => applied.push(key), { debounceMs: 0, maxEntries: 24 });
    for (let i = 0; i < 600; i++) {
      const lng = 46.6 + (i % 300) * 0.003;
      await loader.load({ west: lng, east: lng + 0.01, south: 24.7, north: 24.71, zoom: 15 });
    }
    expect(loader.cache.size).toBeLessThanOrEqual(24);
    // Revisiting a recent viewport is served from cache (no new request).
    const before = loader.requests;
    await loader.load({ west: 46.6 + 299 * 0.003, east: 46.6 + 299 * 0.003 + 0.01, south: 24.7, north: 24.71, zoom: 15 });
    expect(loader.requests).toBe(before);
    loader.dispose();
    expect(loader.cache.size).toBe(0);
  });

  it("removes obsolete markers so the marker set equals the latest response", () => {
    let markers = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const next = Array.from({ length: 20 }, (_, k) => `r${i + k}`);
      const { add, remove } = reconcileIds(markers, next);
      remove.forEach((id) => markers.delete(id));
      add.forEach((id) => markers.add(id));
      expect(markers.size).toBe(20);
    }
    markers = new Set();
    expect(markers.size).toBe(0);
  });

  it("rounds tiny pans to the same key and evicts least-recently-used entries", () => {
    expect(viewportKey({ west: 46.6801, east: 46.6901, south: 24.7, north: 24.71, zoom: 15.1 })).toBe(viewportKey({ west: 46.6803, east: 46.6902, south: 24.7001, north: 24.7101, zoom: 15.2 }));
    const c = new BoundedCache<number>(2, 1000);
    c.set("a", 1, 0);
    c.set("b", 2, 0);
    c.get("a", 1);
    c.set("c", 3, 2);
    expect(c.get("b", 3)).toBeUndefined();
    expect(c.get("a", 3)).toBe(1);
    expect(c.get("a", 5000)).toBeUndefined(); // TTL expiry
  });
});

describe("12. Public reports stay informational, never reservable", () => {
  it("marks signals as not guaranteed / not bookable and releases a lapsed claim", async () => {
    const env = setup();
    const r = await createReport(env.ctx, A, { ...gps(OLAYA_SPOT, 8), departInMinutes: 0 });
    const s = await toHiveSignal(env.ctx, r, null);
    expect(s.guaranteed).toBe(false);
    expect(s.bookable).toBe(false);
    expect(s.precise).toBe(false); // other users see a coarsened position
    expect(s.explanation.en).toContain("not guaranteed");
    // A report id can never be booked like private inventory.
    await expect(createBooking(env.ctx, B, { spaceId: r.id, startAt: env.now.toISOString(), hours: 1 })).rejects.toMatchObject({ code: "not_found" });
    // A claim holds the signal briefly, then lapses back to everyone.
    await claimReport(env.ctx, B, r.id, none);
    env.advance(16);
    const later = await queryHiveMap(env.ctx, { bbox: OLAYA_STREET, zoom: 16.5, viewer: null });
    expect(later.signals.find((x) => x.id === r.id)?.status).toBe("available");
  });
});

describe("13. Private bookings remain restricted to authorized inventory", () => {
  it("never shows or books spaces that are not approved", async () => {
    const env = setup();
    const pending = await submitSpace(env.ctx, PARTNER, {
      title: "Hidden Garage", titleAr: "", location: { lat: 24.6962, lng: 46.6839 }, address: "x", addressAr: "", capacity: 3, pricePerHour: 5,
      schedule: { days: [0, 1, 2, 3, 4, 5, 6], openHour: 0, closeHour: 24 }, conditions: "", conditionsAr: "", rewardEligible: false,
    });
    const map = await queryHiveMap(env.ctx, { bbox: around({ lat: 24.6962, lng: 46.6839 }, 0.004), zoom: 16.5, viewer: null });
    expect(map.spaces.map((s) => s.id)).not.toContain(pending.id);
    expect(map.spaces.length).toBeGreaterThan(0); // approved neighbors still appear
    await expect(createBooking(env.ctx, A, { spaceId: pending.id, startAt: new Date("2026-11-17T09:00:00.000Z").toISOString(), hours: 1 })).rejects.toMatchObject({ code: "space_not_bookable" });
    const rec = await recruit(env.ctx, { location: { lat: 24.6962, lng: 46.6839 }, viewer: null });
    expect(rec.privateAlternatives.map((p) => p.id)).not.toContain(pending.id);
  });
});

describe("Data lifecycle", () => {
  it("folds temporary signals into aggregates, deletes them after retention, and never touches durable records", async () => {
    const env = setup();
    const ledgerBefore = (await env.repo.listLedger()).length;
    const bookingsBefore = (await env.repo.listBookings()).length;
    const r = await createReport(env.ctx, A, { ...gps(move(OLAYA_SPOT, 0, 1200), 8), departInMinutes: 0 });
    env.advance(21 + 61); // expired, then past aggregateAfterMinutes
    const first = await runHiveLifecycle(env.ctx);
    expect(first.aggregated).toBeGreaterThanOrEqual(1);
    expect((await env.repo.getReport(r.id))?.aggregatedAt).toBeTruthy();
    const cell = hiveIndexFor(move(OLAYA_SPOT, 0, 1200)).r10;
    expect((await env.repo.listCellStats(10, [cell], "2000-01-01T00:00:00.000Z")).reduce((s, x) => s + x.expired, 0)).toBe(1);

    env.advance(31 * 24 * 60); // past reportRetentionDays
    const second = await runHiveLifecycle(env.ctx);
    expect(second.reportsDeleted).toBeGreaterThanOrEqual(1);
    expect(await env.repo.getReport(r.id)).toBeNull();
    // Aggregates survive the temporary rows; durable financial/business records are untouched.
    expect((await env.repo.listCellStats(10, [cell], "2000-01-01T00:00:00.000Z")).length).toBe(1);
    expect((await env.repo.listLedger()).length).toBe(ledgerBefore);
    expect((await env.repo.listBookings()).length).toBe(bookingsBefore);
  });
});

describe("Hive state classification", () => {
  const base = { cell: "x", resolution: 9, trail: { score: 0.5, samples: 0 }, recentReports: 0, updatedAt: "" };
  const s = DEFAULT_HIVE_CONFIG.states;
  it("computes states transparently from supply and demand", () => {
    const sup = (strength: number, privateFree = 0) => ({ signals: strength > 0 ? 1 : 0, strength, privateSpaces: 0, privateFree, accessibleBays: 0 });
    expect(classifyState({ ...base, supply: sup(0), demand: { searches: 0, claims: 0, total: 0 }, activity: 0 }, s).state).toBe("quiet");
    expect(classifyState({ ...base, supply: sup(0), demand: { searches: 6, claims: 0, total: 6 }, activity: 6 }, s).state).toBe("overloaded");
    expect(classifyState({ ...base, supply: sup(1.5), demand: { searches: 4, claims: 0, total: 4 }, activity: 5 }, s).state).toBe("high_demand");
    expect(classifyState({ ...base, supply: sup(2), demand: { searches: 1, claims: 0, total: 1 }, activity: 3 }, s).state).toBe("resource_rich");
    expect(classifyState({ ...base, supply: sup(1), demand: { searches: 1, claims: 0, total: 1 }, activity: 2 }, s).state).toBe("active");
  });

  it("derives demo hive states from stored data (seeded demand vs. supply)", async () => {
    const env = setup();
    const olaya = hiveIndexFor(SEED_SIGNAL).r9;
    const empty = hiveIndexFor({ lat: 24.6890, lng: 46.6905 }).r9;
    const sum = await summarizeCells(env.ctx, 9, [olaya, empty]);
    expect(sum.get(empty)!.state).toBe("overloaded");
    expect(sum.get(olaya)!.demand.searches).toBeGreaterThan(0);
    expect(sum.get(olaya)!.supply.signals).toBe(1);
  });
});
