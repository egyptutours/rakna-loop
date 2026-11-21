import type { DepartureReport, HiveConfig, HiveState, ParkingSpace } from "../types";
import type { DomainContext } from "../domain/context";
import { refreshReport } from "../domain/handoff";
import { availableCapacity, isSpaceBookable, withinSchedule } from "../domain/marketplace";
import { cellAt, hiveIndexFor, parentOf } from "./cells";
import { bucketWeight, signalFreshness } from "./decay";
import { trailFromStats } from "./verification";
import { hiveCacheFor } from "./aggregation-cache";

/**
 * HiveAggregationService — each cell keeps a summarized view of local activity.
 * Summaries are computed from real stored records only (live signals, approved
 * private spaces, anonymized demand counters and outcome trails) and cached briefly.
 */

export interface CellSummary {
  cell: string;
  resolution: number;
  state: HiveState;
  supply: { signals: number; strength: number; privateSpaces: number; privateFree: number; accessibleBays: number };
  demand: { searches: number; claims: number; total: number };
  trail: { score: number; samples: number };
  recentReports: number;
  activity: number;
  ratio: number | null; // demand / effective supply
  updatedAt: string;
}

const ACTIVE: DepartureReport["status"][] = ["pending_departure", "available", "claimed"];

/** Effective supply: decayed community signals + a discounted share of free private bays. */
export function effectiveSupply(s: CellSummary["supply"]): number {
  return s.strength + 0.2 * Math.min(s.privateFree, 20);
}

/** Transparent, configurable state rules (documented in docs/HIVE.md). */
export function classifyState(s: Omit<CellSummary, "state" | "ratio">, cfg: HiveConfig["states"]): { state: HiveState; ratio: number | null } {
  const eff = effectiveSupply(s.supply);
  if (s.activity <= cfg.quietMaxActivity && eff < 1) return { state: "quiet", ratio: null };
  const ratio = s.demand.total / Math.max(eff, 0.25);
  if (ratio >= cfg.overloadedRatio && eff < 1) return { state: "overloaded", ratio };
  if (ratio >= cfg.highDemandRatio) return { state: "high_demand", ratio };
  if (eff >= 1 && ratio <= cfg.resourceRichRatio) return { state: "resource_rich", ratio };
  return { state: "active", ratio };
}

export async function summarizeCells(ctx: DomainContext, res: number, cells: string[]): Promise<Map<string, CellSummary>> {
  const cfg = await ctx.repo.getHiveConfig();
  const hiveCache = hiveCacheFor(ctx.repo);
  hiveCache.setTtl(cfg.cacheTtlSeconds * 1000);
  const out = new Map<string, CellSummary>();
  const missing: string[] = [];
  for (const c of cells) {
    const hit = hiveCache.get(`${res}:${c}`) as CellSummary | undefined;
    if (hit) out.set(c, hit);
    else missing.push(c);
  }
  if (missing.length === 0) return out;

  const now = ctx.now();
  const windowStart = new Date(now.getTime() - cfg.demandWindowMinutes * 60_000).toISOString();
  const statsSince = new Date(now.getTime() - cfg.statsRetentionDays * 86_400_000).toISOString();

  const [rawReports, spaces, stats, demand] = await Promise.all([
    ctx.repo.listReportsInCells(res, missing, { statuses: ACTIVE }),
    ctx.repo.listSpacesInCells(res, missing),
    ctx.repo.listCellStats(res, missing, statsSince),
    ctx.repo.listDemand(Math.min(res, 9), res > 9 ? [...new Set(missing.map((c) => parentOf(c, 9)))] : missing, windowStart),
  ]);
  const reports = await Promise.all(rawReports.map((r) => refreshReport(ctx, r)));

  const blank = (cell: string): Omit<CellSummary, "state" | "ratio"> => ({
    cell, resolution: res, supply: { signals: 0, strength: 0, privateSpaces: 0, privateFree: 0, accessibleBays: 0 },
    demand: { searches: 0, claims: 0, total: 0 }, trail: { score: 0.5, samples: 0 }, recentReports: 0, activity: 0, updatedAt: now.toISOString(),
  });
  const acc = new Map(missing.map((c) => [c, blank(c)]));
  const keyOf = (hiveCell: string) => parentOf(hiveCell, res);

  for (const r of reports) {
    if (!ACTIVE.includes(r.status)) continue;
    const s = acc.get(cellAt(r.hive ?? hiveIndexFor(r.location), res));
    if (!s) continue;
    s.recentReports++;
    if (r.status === "claimed") s.demand.claims++;
    else {
      s.supply.signals++;
      s.supply.strength += signalFreshness(r, now, cfg.signalHalfLifeMinutes);
    }
  }

  for (const sp of spaces as ParkingSpace[]) {
    const s = acc.get(cellAt(sp.hive ?? hiveIndexFor(sp.location), res));
    if (!s || !(await isSpaceBookable(ctx, sp))) continue;
    s.supply.privateSpaces++;
    s.supply.accessibleBays += sp.accessibleBays ?? 0;
    if (withinSchedule(sp.schedule, now, 1)) s.supply.privateFree += await availableCapacity(ctx, sp, now, new Date(now.getTime() + 3_600_000));
  }

  const statsByCell = new Map<string, typeof stats>();
  for (const st of stats) {
    const k = keyOf(st.cell);
    if (!statsByCell.has(k)) statsByCell.set(k, []);
    statsByCell.get(k)!.push(st);
    const s = acc.get(k);
    if (s && st.bucketStart >= windowStart) s.recentReports += st.reports;
  }
  for (const [k, list] of statsByCell) {
    const s = acc.get(k);
    if (!s) continue;
    const t = trailFromStats(list, now, cfg);
    s.trail = { score: Math.round(t.score * 1000) / 1000, samples: Math.round(t.samples * 10) / 10 };
  }

  for (const d of demand) {
    // demand is stored at r9: coarser cells roll up; finer (r10) cells share their r9 parent's demand
    if (res <= 9) {
      const s = acc.get(parentOf(d.cell, res));
      if (s) s.demand.searches += d.searches * Math.max(0.5, bucketWeight(d.bucketStart, now, cfg.demandWindowMinutes / 1440));
    } else {
      for (const c of missing) if (parentOf(c, 9) === d.cell) acc.get(c)!.demand.searches += d.searches / 7; // spread over ~7 children
    }
  }

  for (const s of acc.values()) {
    s.demand.searches = Math.round(s.demand.searches * 10) / 10;
    s.demand.total = Math.round((s.demand.searches + s.demand.claims) * 10) / 10;
    s.supply.strength = Math.round(s.supply.strength * 100) / 100;
    s.activity = s.recentReports + s.demand.total;
    const full: CellSummary = { ...s, ...classifyState(s, cfg.states) };
    out.set(s.cell, full);
    hiveCache.set(`${res}:${s.cell}`, full);
  }
  return out;
}

export function hasData(s: CellSummary): boolean {
  return s.activity > 0 || s.supply.privateSpaces > 0 || s.trail.samples > 0 || s.supply.signals > 0;
}
