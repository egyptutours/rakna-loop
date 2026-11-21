import { z } from "zod";
import { DomainError } from "../domain/errors";

const coord = (min: number, max: number) => z.coerce.number().min(min).max(max);

/** Viewport query (?w=&s=&e=&n=&z=&cursor=&lat=&lng=). Rejects viewports larger than ~0.6° per side. */
export const viewportSchema = z
  .object({
    w: coord(-180, 180),
    s: coord(-85, 85),
    e: coord(-180, 180),
    n: coord(-85, 85),
    z: coord(0, 22),
    cursor: z.coerce.number().int().min(0).max(100_000).optional(),
    lat: coord(-90, 90).optional(),
    lng: coord(-180, 180).optional(),
  })
  .refine((v) => v.e > v.w && v.n > v.s, "Invalid viewport");

export function parseViewport(url: URL) {
  const v = viewportSchema.parse(Object.fromEntries(url.searchParams));
  // Server-side guard: a single request may cover at most ~65 km × 65 km.
  if (v.e - v.w > 0.6 || v.n - v.s > 0.6) throw new DomainError("validation", "Viewport too large — zoom in");
  return {
    bbox: { west: v.w, south: v.s, east: v.e, north: v.n },
    zoom: v.z,
    cursor: v.cursor,
    viewerLoc: v.lat !== undefined && v.lng !== undefined ? { lat: v.lat, lng: v.lng } : null,
  };
}

export const demandSchema = z
  .object({
    location: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).strict(),
    accessibleOnly: z.boolean().optional(),
    maxWalkM: z.number().int().min(100).max(3000).optional(),
  })
  .strict();

export const feedbackSchema = z.object({ helpful: z.boolean(), reportId: z.guid().optional() }).strict();

export const hiveConfigPatchSchema = z
  .object({
    maxCellsPerQuery: z.number().int().min(50).max(2000),
    maxSignalsPerPage: z.number().int().min(10).max(500),
    signalHalfLifeMinutes: z.number().min(1).max(120),
    trailHalfLifeDays: z.number().min(0.5).max(90),
    demandWindowMinutes: z.number().int().min(10).max(720),
    statsRetentionDays: z.number().int().min(1).max(365),
    reportRetentionDays: z.number().int().min(1).max(365),
    claimRetentionHours: z.number().int().min(1).max(720),
    aggregateAfterMinutes: z.number().int().min(1).max(1440),
    recruitmentMaxRings: z.number().int().min(0).max(6),
    perCellDiversityCap: z.number().int().min(1).max(10),
    cacheTtlSeconds: z.number().int().min(0).max(600),
    states: z
      .object({
        quietMaxActivity: z.number().min(0).max(100),
        highDemandRatio: z.number().min(0.5).max(50),
        overloadedRatio: z.number().min(0.5).max(100),
        resourceRichRatio: z.number().min(0).max(10),
      })
      .partial()
      .strict(),
  })
  .partial()
  .strict();
