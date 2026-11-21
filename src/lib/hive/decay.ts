import type { DepartureReport } from "../types";

/**
 * SignalDecayService — pheromone-style evaporation.
 *  • A live signal's strength halves every `signalHalfLifeMinutes` after the stated
 *    departure time, and is 0 once it expires (hard cut, so stale signals vanish).
 *  • A cell's historical trail evaporates with `trailHalfLifeDays`, so old patterns
 *    fade instead of dominating forever.
 */

export function halfLifeWeight(ageMs: number, halfLifeMs: number): number {
  if (ageMs <= 0) return 1;
  return Math.pow(0.5, ageMs / halfLifeMs);
}

export function signalFreshness(r: Pick<DepartureReport, "status" | "expectedDepartureAt" | "expiresAt" | "createdAt">, now: Date, halfLifeMinutes: number): number {
  if (!["pending_departure", "available", "claimed"].includes(r.status)) return 0;
  const t = now.getTime();
  if (t >= new Date(r.expiresAt).getTime()) return 0;
  if (r.status === "pending_departure") return 1; // not yet started decaying
  const start = Math.max(new Date(r.expectedDepartureAt).getTime(), new Date(r.createdAt).getTime());
  return halfLifeWeight(t - start, halfLifeMinutes * 60_000);
}

export function bucketWeight(bucketStartIso: string, now: Date, halfLifeDays: number): number {
  return halfLifeWeight(now.getTime() - new Date(bucketStartIso).getTime(), halfLifeDays * 86_400_000);
}

/** Start of the UTC hour (hourly aggregation buckets). */
export function hourBucket(d: Date): string {
  const b = new Date(d.getTime());
  b.setUTCMinutes(0, 0, 0);
  return b.toISOString();
}
