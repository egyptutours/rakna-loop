import fs from "node:fs";
import path from "node:path";
import { describe, it } from "vitest";
import { latLngToCell, cellToParent } from "h3-js";
import { PGlite } from "@electric-sql/pglite";
import { postgis } from "@electric-sql/pglite-postgis";
import { DemoRepo } from "@/lib/data/demo-repo";
import { buildSeed } from "@/lib/data/seed";
import type { DomainContext } from "@/lib/domain/context";
import type { DepartureReport } from "@/lib/types";
import { queryHiveMap } from "@/lib/hive/map-query";
import { HiveViewportLoader } from "@/lib/client/hive-viewport";
import { createDb } from "../tests/db/harness";

/**
 * RAKNA HIVE benchmarks. Results are written to bench/results/hive-bench.json and summarized
 * in docs/BENCHMARKS.md. All numbers come from ONE developer machine (Windows, Node 26) and
 * are for relative comparison, not capacity claims.
 */

const SIZES = (process.env.BENCH_SIZES ?? "2500,10000,50000,100000,250000").split(",").map(Number);
const T0 = new Date("2026-11-17T07:00:00.000Z");
const RIYADH = { south: 24.55, north: 24.95, west: 46.5, east: 46.95 };
const results: Record<string, unknown> = { machine: `${process.platform} ${process.arch} node ${process.version}`, startedAt: new Date().toISOString(), app: [], db: [], client: null };

function synth(n: number): DepartureReport[] {
  const out: DepartureReport[] = [];
  let s = 1234567;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let i = 0; i < n; i++) {
    const lat = RIYADH.south + rnd() * (RIYADH.north - RIYADH.south);
    const lng = RIYADH.west + rnd() * (RIYADH.east - RIYADH.west);
    const r10 = latLngToCell(lat, lng, 10);
    const live = i % 10 === 0; // 10% live signals, 90% recent history (within retention)
    const ageMin = live ? Math.floor(rnd() * 15) : 30 + Math.floor(rnd() * 60 * 24 * 28);
    const created = new Date(T0.getTime() - ageMin * 60_000).toISOString();
    out.push({
      id: `00000000-0000-4000-9${String(i).padStart(3, "0").slice(-3)}-${String(i).padStart(12, "0")}`,
      reporterId: `00000000-0000-4000-b000-${String(i % 5000).padStart(12, "0")}`,
      location: { lat, lng }, accuracyM: 12, neighborhood: "olaya", note: null,
      createdAt: created, expectedDepartureAt: created, expiresAt: new Date(new Date(created).getTime() + 20 * 60_000).toISOString(),
      status: live ? "available" : (["found", "not_found", "expired"] as const)[i % 3],
      claimedBy: null, claimedAt: null, claimExpiresAt: null, claimLocation: null,
      resolvedAt: live ? null : new Date(new Date(created).getTime() + 10 * 60_000).toISOString(),
      isDemo: true, aggregatedAt: live ? null : created,
      hive: { r10, r9: cellToParent(r10, 9), r8: cellToParent(r10, 8), r7: cellToParent(r10, 7) },
    });
  }
  return out;
}

function pct(xs: number[], p: number) {
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] * 10) / 10;
}

const VIEWS = {
  city: { bbox: { west: 46.5, east: 46.95, south: 24.55, north: 24.95 }, zoom: 10.5 },
  neighborhood: { bbox: { west: 46.66, east: 46.71, south: 24.68, north: 24.72 }, zoom: 13.5 },
  street: { bbox: { west: 46.680, east: 46.690, south: 24.690, north: 24.698 }, zoom: 16.5 },
};

describe("RAKNA HIVE benchmarks", () => {
  it("application query path (in-memory adapter) at increasing dataset sizes", async () => {
    for (const n of SIZES) {
      const state = buildSeed(T0);
      for (const r of synth(n)) state.reports.push(r); // (spread of 250k args overflows the stack)
      const inner = new DemoRepo(state);
      let calls = 0;
      const counted = new Proxy(inner, {
        get(t, p, r) {
          const v = Reflect.get(t, p, r);
          if (typeof v !== "function" || p === "withLock") return v;
          return (...a: unknown[]) => { calls++; return (v as (...x: unknown[]) => unknown).apply(t, a); };
        },
      }) as unknown as DemoRepo;
      const ctx: DomainContext = { repo: counted, now: () => new Date(T0.getTime()), allowSimulatedEvidence: true };
      const row: Record<string, unknown> = { reports: n + state.reports.length - n };
      for (const [name, v] of Object.entries(VIEWS)) {
        const times: number[] = [];
        let res = await queryHiveMap(ctx, { ...v, viewer: null }); // warm
        // cold = first query on a fresh cache for this view's cells
        for (let i = 0; i < 8; i++) {
          calls = 0;
          const t = performance.now();
          res = await queryHiveMap(ctx, { ...v, viewer: null });
          times.push(performance.now() - t);
        }
        const callsPerQuery = calls;
        row[name] = {
          mode: res.mode, resolution: res.resolution, overlayResolution: res.overlayResolution,
          p50ms: pct(times, 50), p95ms: pct(times, 95),
          queriedCells: res.meta.queriedCells, returnedCells: res.cells.length,
          markers: res.signals.length + res.spaces.length + res.clusters.length + res.inactive.length,
          payloadKB: Math.round(JSON.stringify(res).length / 102.4) / 10,
          storageCallsPerQuery: callsPerQuery,
        };
      }
      // Cache effect: cold vs warm summary for a fresh neighborhood view.
      const fresh = { bbox: { west: 46.72, east: 46.77, south: 24.75, north: 24.79 }, zoom: 13.5 };
      const c0 = performance.now(); await queryHiveMap(ctx, { ...fresh, viewer: null }); const cold = performance.now() - c0;
      const w0 = performance.now(); await queryHiveMap(ctx, { ...fresh, viewer: null }); const warm = performance.now() - w0;
      row.cache = { coldMs: Math.round(cold * 10) / 10, warmMs: Math.round(warm * 10) / 10 };
      (results.app as unknown[]).push(row);
      console.log(JSON.stringify(row));
    }
  });

  it("PostgreSQL (PGlite + PostGIS) viewport query duration and plans", async () => {
    for (const n of SIZES) {
      const db = await createDb();
      const pg: PGlite = db.pg;
      await db.createUser("abcdef00-0000-4000-8000-000000000001");
      const rows = synth(n);
      // Bulk load via VALUES batches.
      for (let i = 0; i < rows.length; i += 2000) {
        const chunk = rows.slice(i, i + 2000);
        const vals: unknown[] = [];
        const tuples = chunk.map((r, j) => {
          const b = j * 10;
          vals.push(r.location.lat, r.location.lng, r.status, r.createdAt, r.expiresAt, r.hive!.r7, r.hive!.r8, r.hive!.r9, r.hive!.r10, r.aggregatedAt);
          return `('abcdef00-0000-4000-8000-000000000001', $${b + 1}, $${b + 2}, 12, 'olaya', $${b + 4}::timestamptz, $${b + 4}::timestamptz, $${b + 5}::timestamptz, $${b + 3}::text::report_status, $${b + 6}, $${b + 7}, $${b + 8}, $${b + 9}, $${b + 10}::timestamptz)`;
        });
        // the partial unique index allows one LIVE report per driver → live rows go to distinct drivers below
        await pg.query(
          `insert into departure_reports (reporter_id, location_lat, location_lng, accuracy_m, neighborhood, created_at, expected_departure_at, expires_at, status, h3_r7, h3_r8, h3_r9, h3_r10, aggregated_at)
           select reporter_id::uuid, location_lat::double precision, location_lng::double precision, accuracy_m, neighborhood, created_at, expected_departure_at, expires_at,
                  case when status = 'available' then 'expired'::report_status else status end, h3_r7, h3_r8, h3_r9, h3_r10, aggregated_at
             from (values ${tuples.join(",")}) v(reporter_id, location_lat, location_lng, accuracy_m, neighborhood, created_at, expected_departure_at, expires_at, status, h3_r7, h3_r8, h3_r9, h3_r10, aggregated_at)`,
          vals,
        );
      }
      // Live signals: one per synthetic driver (auth users needed for FK).
      const live = rows.filter((r) => r.status === "available").slice(0, 2000);
      for (let i = 0; i < live.length; i++) {
        const uid = `abcdef01-0000-4000-8000-${String(i).padStart(12, "0")}`;
        await pg.query(`insert into auth.users (id) values ($1)`, [uid]);
        const r = live[i];
        await pg.query(
          `insert into departure_reports (reporter_id, location_lat, location_lng, accuracy_m, neighborhood, created_at, expected_departure_at, expires_at, status, h3_r7, h3_r8, h3_r9, h3_r10)
           values ($1, $2, $3, 12, 'olaya', $4, $4, $5, 'available', $6, $7, $8, $9)`,
          [uid, r.location.lat, r.location.lng, T0.toISOString(), new Date(T0.getTime() + 20 * 60_000).toISOString(), r.hive!.r7, r.hive!.r8, r.hive!.r9, r.hive!.r10],
        );
      }
      await pg.exec("analyze departure_reports;");
      const street = rows.filter((r) => r.location.lat > 24.69 && r.location.lat < 24.698 && r.location.lng > 46.68 && r.location.lng < 46.69).map((r) => r.hive!.r10);
      const streetCells = [...new Set(street)].slice(0, 120);
      const nbCells = [...new Set(rows.filter((r) => r.location.lat > 24.68 && r.location.lat < 24.72 && r.location.lng > 46.66 && r.location.lng < 46.71).map((r) => r.hive!.r9))].slice(0, 200);
      const timeQuery = async (sql: string, params: unknown[]) => {
        const ts: number[] = [];
        let plan = "";
        for (let i = 0; i < 6; i++) {
          const ex = (await pg.query(`explain (analyze, format json) ${sql}`, params)).rows[0] as { "QUERY PLAN": [{ "Execution Time": number; Plan: unknown }] };
          ts.push(ex["QUERY PLAN"][0]["Execution Time"]);
          plan = JSON.stringify(ex["QUERY PLAN"][0].Plan);
        }
        return { p50ms: pct(ts, 50), usesIndex: /Index/.test(plan) && !/"Node Type":"Seq Scan","Parent Relationship":"Outer","Parallel Aware":false,"Async Capable":false,"Relation Name":"departure_reports"/.test(plan), seqScan: /"Node Type":"Seq Scan"/.test(plan) };
      };
      const row = {
        reports: n + live.length,
        streetLiveSignals: await timeQuery(`select * from departure_reports where h3_r10 = any($1) and status in ('available','pending_departure','claimed')`, [streetCells]),
        neighborhoodAllStatuses: await timeQuery(`select h3_r9, count(*) from departure_reports where h3_r9 = any($1) group by h3_r9`, [nbCells]),
        radius300m: await timeQuery(`select id from departure_reports where st_dwithin(geog, st_setsrid(st_makepoint(46.6853, 24.6941), 4326)::geography, 300)`, []),
        cityWideScanForComparison: await timeQuery(`select count(*) from departure_reports where status = 'available'`, []),
      };
      (results.db as unknown[]).push(row);
      console.log(JSON.stringify(row));
      await pg.close();
    }
  });

  it("client viewport loader: cancellation, cache bound and memory under 1,000 map movements", async () => {
    let aborted = 0;
    let completed = 0;
    const payload = JSON.stringify({ cells: Array.from({ length: 60 }, (_, i) => ({ id: i, ring: Array(7).fill([46.6, 24.7]) })) });
    const loader = new HiveViewportLoader<string>(
      (q, signal) => new Promise((resolve, reject) => {
        const t = setTimeout(() => { completed++; resolve(payload + q); }, 2 + Math.random() * 6);
        signal.addEventListener("abort", () => { clearTimeout(t); aborted++; const e = new Error("aborted"); e.name = "AbortError"; reject(e); });
      }),
      () => {},
      { debounceMs: 0, maxEntries: 24, ttlMs: 15_000 },
    );
    global.gc?.();
    const heap0 = process.memoryUsage().heapUsed;
    const pending: Promise<void>[] = [];
    for (let i = 0; i < 1000; i++) {
      const lng = 46.5 + (i % 400) * 0.001;
      pending.push(loader.load({ west: lng, east: lng + 0.01, south: 24.7, north: 24.71, zoom: 15 }));
      if (i % 5 === 4) await Promise.allSettled(pending.splice(0));
    }
    await Promise.allSettled(pending);
    global.gc?.();
    const heap1 = process.memoryUsage().heapUsed;
    results.client = {
      movements: 1000, requestsStarted: loader.requests, aborted, completed, cacheEntries: loader.cache.size, cacheBound: 24,
      heapDeltaKB: Math.round((heap1 - heap0) / 1024), note: "Node heap (not a browser); debounce disabled to stress cancellation",
    };
    console.log(JSON.stringify(results.client));
    loader.dispose();
    const out = path.resolve("bench/results");
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, "hive-bench.json"), JSON.stringify({ ...results, finishedAt: new Date().toISOString() }, null, 2));
  });
});

void PGlite; void postgis;
