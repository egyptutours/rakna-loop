import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigurationError, getDataMode } from "@/lib/config";
import { createReport } from "@/lib/domain/handoff";
import { toHiveSignal } from "@/lib/hive/signals";
import { queryHiveMap } from "@/lib/hive/map-query";
import { recruit } from "@/lib/hive/swarm";
import { recordDemand } from "@/lib/hive/demand";
import { adminOverview, processAccountDeletion } from "@/lib/domain/admin";
import { awardPoints } from "@/lib/domain/ledger";
import { runHiveLifecycle } from "@/lib/hive/lifecycle";
import { hiveImpactMetrics } from "@/lib/hive/metrics";
import { A, ADMIN, B, OLAYA_SPOT, gps, setup } from "./helpers";

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}
const SRC = walk(path.resolve("src")).filter((f) => /\.(ts|tsx)$/.test(f));
const read = (f: string) => fs.readFileSync(f, "utf8");

describe("F-SEC-2: production never falls back to demo mode implicitly", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("requires an explicit data mode in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("RAKNA_DATA_MODE", "");
    expect(() => getDataMode()).toThrow(ConfigurationError);
  });
  it("fails instead of silently using demo when Supabase variables are missing in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("RAKNA_DATA_MODE", "supabase");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    expect(() => getDataMode()).toThrow(ConfigurationError);
  });
  it("allows an explicit public demo", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("RAKNA_DATA_MODE", "demo");
    expect(getDataMode()).toBe("demo");
  });
});

describe("F-PRIV-2: hive data never pinpoints someone else's signal", () => {
  it("gives non-participants only the r9 cell and a coarsened position", async () => {
    const env = setup();
    const r = await createReport(env.ctx, A, { ...gps(OLAYA_SPOT, 8), departInMinutes: 0 });
    const publicView = await toHiveSignal(env.ctx, r, (await env.repo.getProfile(B))!);
    const ownView = await toHiveSignal(env.ctx, r, (await env.repo.getProfile(A))!);
    expect(publicView.cell).toBe(r.hive!.r9);
    expect(publicView.precise).toBe(false);
    expect(ownView.cell).toBe(r.hive!.r10);
  });

  it("draws the street-level overlay at r9, not r10", async () => {
    const env = setup();
    const res = await queryHiveMap(env.ctx, { bbox: { west: 46.680, east: 46.690, south: 24.690, north: 24.698 }, zoom: 16.5, viewer: null });
    expect(res.resolution).toBe(10);
    expect(res.overlayResolution).toBe(9);
  });

  it("hides illustrative transit points outside demo mode", async () => {
    const env = setup({ simulated: false });
    for (let i = 0; i < 6; i++) await recordDemand(env.ctx, { lat: 24.689, lng: 46.6905 });
    const res = await recruit(env.ctx, { location: { lat: 24.689, lng: 46.6905 }, viewer: null });
    expect(res.transitAlternatives).toHaveLength(0);
  });
});

describe("F-PRIV-1: account deletion is processable", () => {
  it("anonymizes the profile, deletes temporary location data, keeps the ledger", async () => {
    const env = setup();
    await createReport(env.ctx, A, { ...gps(OLAYA_SPOT, 8), departInMinutes: 0 });
    await expect(processAccountDeletion(env.ctx, ADMIN, A)).rejects.toMatchObject({ code: "conflict" }); // no request yet
    await env.repo.updateProfile(A, { deletionRequestedAt: env.now.toISOString() });
    const ledgerBefore = (await env.repo.listLedger({ userId: A })).length;
    const res = await processAccountDeletion(env.ctx, ADMIN, A);
    expect(res.reports_deleted).toBeGreaterThanOrEqual(1);
    const p = (await env.repo.getProfile(A))!;
    expect(p.displayName).toBe("Deleted user");
    expect(p.deletedAt).toBeTruthy();
    expect(await env.repo.listReports({ reporterId: A })).toHaveLength(0);
    expect((await env.repo.listLedger({ userId: A })).length).toBe(ledgerBefore);
    expect((await env.repo.listAudit()).some((a) => a.action === "account.deletion_processed")).toBe(true);
  });
});

describe("F-PERF-2 / F-BIZ: admin totals stay exact without loading the full ledger", () => {
  it("reports totals from storage aggregates", async () => {
    const env = setup();
    for (let i = 0; i < 70; i++) await awardPoints(env.ctx, { userId: `00000000-0000-4000-a000-000000000${String(100 + (i % 3)).padStart(3, "0")}`, amount: 1, type: "mission_reward", reason: "x", idempotencyKey: `t:${i}` });
    const o = await adminOverview(env.ctx);
    const all = await env.repo.listLedger();
    expect(o.ledger.length).toBeLessThanOrEqual(60);
    expect(o.stats.outstandingKeys).toBe(all.reduce((s, e) => s + e.amount, 0));
  });
});

describe("F-OPS-1: lifecycle runs are recorded for monitoring", () => {
  it("logs successful runs and exposes health in metrics", async () => {
    const env = setup();
    await runHiveLifecycle(env.ctx);
    const m = await hiveImpactMetrics(env.ctx);
    expect(m.lifecycle.lastRuns[0].ok).toBe(true);
    expect(m.lifecycle.overdue).toBe(false);
  });
});

describe("Static checks: tracking, secrets, server-only boundaries", () => {
  it("never tracks location continuously (no watchPosition anywhere)", () => {
    for (const f of SRC) expect(read(f), f).not.toMatch(/watchPosition/);
    const uses = SRC.filter((f) => /getCurrentPosition/.test(read(f)));
    // Only in user-initiated handlers: location picker, "locate me" button, booking check-in
    // ("I've arrived", geofence ≤ 50 m) and the List-My-Parking "use my location" button.
    const rel = uses.map((f) => path.relative(path.resolve("src"), f).replace(/\\/g, "/")).sort();
    expect(rel).toEqual(["app/bookings/page.tsx", "app/host/list/page.tsx", "app/page.tsx", "components/location-picker.tsx"]);
  });

  it("reads secrets only in server-only modules", () => {
    for (const f of SRC) {
      const t = read(f);
      if (/SUPABASE_SERVICE_ROLE_KEY|ANTHROPIC_API_KEY/.test(t) && !/config\.ts$/.test(f)) {
        expect(t.includes('"use client"'), f).toBe(false);
        expect(/import "server-only"|supabase-repo\.ts$/.test(f) || /from "\.\.\/config"|getDataMode/.test(t), f).toBe(true);
      }
    }
    for (const f of SRC) expect(read(f), f).not.toMatch(/NEXT_PUBLIC_[A-Z_]*(SERVICE|SECRET|ANTHROPIC)/);
  });

  it("client components never import the service-role data layer", () => {
    for (const f of SRC.filter((x) => read(x).startsWith('"use client"'))) {
      expect(read(f), f).not.toMatch(/from "@\/lib\/data(\/index)?"|supabase-repo|@\/lib\/auth\/session/);
    }
  });
});
