import type { LatLng } from "../types";
import type { DomainContext } from "../domain/context";
import { hiveIndexFor } from "./cells";
import { hourBucket } from "./decay";
import { invalidateHiveCells } from "./aggregation-cache";

/**
 * LocalDemandService — anonymous demand counters.
 * A "forager" intent ("I'm looking for parking here") increments an hourly counter
 * for the r9 cell. No user id or exact location is stored, so demand never becomes
 * a personal location history.
 */
export async function recordDemand(ctx: DomainContext, location: LatLng, count = 1, isDemo = false): Promise<string> {
  const idx = hiveIndexFor(location);
  await ctx.repo.incrementDemand(idx.r9, hourBucket(ctx.now()), count, isDemo);
  invalidateHiveCells([idx.r7, idx.r8, idx.r9]);
  return idx.r9;
}
