import type { DomainContext } from "../domain/context";
import { refreshReport } from "../domain/handoff";
import { recordSignalOutcome } from "./verification";
import { clearHiveCache } from "./aggregation-cache";

/**
 * Data lifecycle (SignalDecayService + retention).
 *
 *  TEMPORARY  departure reports, claims, live signals ........ expire fast; folded into
 *                                                               aggregates, then deleted
 *  AGGREGATED hive_cell_stats, hive_demand_buckets ............ anonymized hourly counters,
 *                                                               kept statsRetentionDays
 *  DURABLE    profiles, partners, spaces, bookings, ledger,
 *             redemptions, audit logs ......................... NEVER touched here
 */

export interface LifecycleReport {
  refreshed: number;
  aggregated: number;
  reportsDeleted: number;
  claimsDeleted: number;
  locationsCoarsened: number;
  statsDeleted: number;
  demandDeleted: number;
  ranAt: string;
}

/**
 * Entry point. In Supabase mode the job runs INSIDE the database (rakna_hive_lifecycle():
 * set-based, non-overlapping via advisory lock, logged in hive_job_runs, scheduled by
 * pg_cron). In demo mode the application-level implementation below runs and logs to
 * the demo store. Either way a failed run is recorded and a retry is safe (idempotent).
 */
export async function runHiveLifecycle(ctx: DomainContext): Promise<LifecycleReport | Record<string, unknown>> {
  const native = await ctx.repo.runNativeLifecycle();
  if (native) return native;
  const startedAt = ctx.now().toISOString();
  try {
    const report = await runAppLifecycle(ctx);
    await ctx.repo.recordJobRun({ job: "hive_lifecycle", startedAt, finishedAt: ctx.now().toISOString(), ok: true, details: { ...report }, error: null });
    return report;
  } catch (e) {
    await ctx.repo.recordJobRun({ job: "hive_lifecycle", startedAt, finishedAt: ctx.now().toISOString(), ok: false, details: null, error: (e as Error).message });
    throw e;
  }
}

async function runAppLifecycle(ctx: DomainContext): Promise<LifecycleReport> {
  const cfg = await ctx.repo.getHiveConfig();
  const rules = await ctx.repo.getRules();
  const now = ctx.now();
  const t = now.getTime();
  const iso = (ms: number) => new Date(ms).toISOString();

  // 1. Expire stale live signals. Active reports are recent by construction, so a bounded window suffices.
  const recent = await ctx.repo.listReports({ sinceIso: iso(t - 6 * 3_600_000) });
  let refreshed = 0;
  for (const r of recent) {
    const next = await refreshReport(ctx, r);
    if (next.status !== r.status) refreshed++;
  }

  // 2. Fold resolved/expired temporary reports into anonymized cell stats (idempotent via aggregatedAt).
  const foldBefore = iso(t - cfg.aggregateAfterMinutes * 60_000);
  const retentionCut = iso(t - cfg.reportRetentionDays * 86_400_000);
  const candidates = await ctx.repo.listReports({ sinceIso: iso(t - (cfg.reportRetentionDays + 30) * 86_400_000) });
  let aggregated = 0;
  const deletable: string[] = [];
  for (const r of candidates) {
    const terminal = ["found", "not_found", "expired"].includes(r.status);
    if (!terminal) continue;
    let isAggregated = Boolean(r.aggregatedAt);
    if (!isAggregated && (r.resolvedAt ?? r.expiresAt) <= foldBefore) {
      await recordSignalOutcome(ctx, r);
      aggregated++;
      isAggregated = true;
    }
    // 3. Delete temporary rows past retention ONLY once aggregated. Flagged reports are kept for review.
    if (isAggregated && r.createdAt < retentionCut) deletable.push(r.id);
  }
  const reportsDeleted = await ctx.repo.deleteReports(deletable);

  // 4. Inactive claims after a short window; 5. precise coordinates after the privacy window.
  const claimsDeleted = await ctx.repo.deleteClaimsBefore(iso(t - cfg.claimRetentionHours * 3_600_000));
  const locationsCoarsened = await ctx.repo.purgePreciseLocations(iso(t - rules.locationRetentionHours * 3_600_000));

  // 6. Aggregates past their own retention.
  const statsDeleted = await ctx.repo.deleteCellStatsBefore(iso(t - cfg.statsRetentionDays * 86_400_000));
  const demandDeleted = await ctx.repo.deleteDemandBefore(iso(t - cfg.statsRetentionDays * 86_400_000));

  clearHiveCache();
  return { refreshed, aggregated, reportsDeleted, claimsDeleted, locationsCoarsened, statsDeleted, demandDeleted, ranAt: now.toISOString() };
}

/** Opportunistic trigger from read paths, at most once per interval per server process. */
const g = globalThis as unknown as { __raknaLifecycleAt?: number };
export async function maybeRunLifecycle(ctx: DomainContext, intervalMs = 60_000): Promise<LifecycleReport | Record<string, unknown> | null> {
  // Production (Supabase) relies on pg_cron, never on user read paths (audit F-PERF-1).
  if (ctx.repo.kind !== "demo") return null;
  const t = ctx.now().getTime();
  if (g.__raknaLifecycleAt && t - g.__raknaLifecycleAt < intervalMs) return null;
  g.__raknaLifecycleAt = t;
  return runHiveLifecycle(ctx);
}

export function resetLifecycleThrottle() {
  g.__raknaLifecycleAt = undefined;
}
