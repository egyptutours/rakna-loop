import type { DepartureReport, HiveCellStat, HiveConfig, UserReliability } from "../types";
import type { DomainContext } from "../domain/context";
import { hiveIndexFor } from "./cells";
import { bucketWeight, hourBucket } from "./decay";
import { invalidateHiveCells } from "./aggregation-cache";

/**
 * SignalVerificationService — positive & negative feedback.
 * Each verified outcome is written to the cell's anonymized trail (hive_cell_stats):
 * "found" reinforces the trail, "not found" weakens it. Trails evaporate over time.
 * Reliability uses a Beta(1,1) prior, so a quiet cell with no history starts at 0.5 —
 * low-activity areas are never penalized just for being quiet.
 */

export interface Trail {
  found: number; // decayed
  notFound: number; // decayed
  score: number; // posterior mean 0..1
  samples: number; // decayed sample size
}

export function trailFromStats(stats: HiveCellStat[], now: Date, cfg: Pick<HiveConfig, "trailHalfLifeDays">): Trail {
  let found = 0;
  let notFound = 0;
  for (const s of stats) {
    const w = bucketWeight(s.bucketStart, now, cfg.trailHalfLifeDays);
    found += s.found * w;
    notFound += s.notFound * w;
  }
  return { found, notFound, score: (found + 1) / (found + notFound + 2), samples: found + notFound };
}

export async function cellTrail(ctx: DomainContext, res: number, cell: string): Promise<Trail> {
  const cfg = await ctx.repo.getHiveConfig();
  const since = new Date(ctx.now().getTime() - cfg.statsRetentionDays * 86_400_000).toISOString();
  return trailFromStats(await ctx.repo.listCellStats(res, [cell], since), ctx.now(), cfg);
}

/** Signal reliability = blend of the scout's verified history and the local trail. */
export function signalReliability(reporter: UserReliability, trail: Trail): number {
  return Math.round((0.6 * reporter.score + 0.4 * trail.score) * 1000) / 1000;
}

/**
 * Record a resolved outcome into the trail immediately (positive/negative feedback)
 * and mark the report as aggregated so the lifecycle job never double-counts it.
 */
export async function recordSignalOutcome(ctx: DomainContext, report: DepartureReport): Promise<void> {
  if (report.aggregatedAt) return;
  if (!["found", "not_found", "expired"].includes(report.status)) return;
  const hive = report.hive ?? hiveIndexFor(report.location);
  const when = new Date(report.resolvedAt ?? report.expiresAt);
  await ctx.repo.incrementCellStat({
    cell: hive.r10,
    bucketStart: hourBucket(when),
    reports: 1,
    found: report.status === "found" ? 1 : 0,
    notFound: report.status === "not_found" ? 1 : 0,
    expired: report.status === "expired" ? 1 : 0,
    isDemo: report.isDemo,
  });
  await ctx.repo.updateReport(report.id, { aggregatedAt: ctx.now().toISOString(), hive });
  invalidateHiveCells([hive.r7, hive.r8, hive.r9, hive.r10]);
}
