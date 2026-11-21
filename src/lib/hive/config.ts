import type { HiveConfig } from "../types";

/**
 * RAKNA HIVE defaults. Starting points, not fixed assumptions — administrators can
 * tune them (Admin → Hive) and real usage should drive the values (see docs/HIVE.md).
 *
 * H3 average cell areas: r7 ≈ 5.2 km², r8 ≈ 0.74 km², r9 ≈ 0.105 km², r10 ≈ 0.015 km².
 */
export const DEFAULT_HIVE_CONFIG: HiveConfig = {
  zoomBands: [
    { maxZoom: 11, resolution: 7, mode: "aggregate" }, // city: districts
    { maxZoom: 13, resolution: 8, mode: "aggregate" }, // area
    { maxZoom: 14.5, resolution: 9, mode: "aggregate" }, // neighborhood hives
    { maxZoom: 99, resolution: 10, mode: "street" }, // street: individual signals + fine cells
  ],
  maxCellsPerQuery: 400,
  maxSignalsPerPage: 150,
  signalHalfLifeMinutes: 8,
  trailHalfLifeDays: 7,
  demandWindowMinutes: 60,
  statsRetentionDays: 60,
  reportRetentionDays: 30,
  claimRetentionHours: 24,
  aggregateAfterMinutes: 60,
  recruitmentMaxRings: 3,
  perCellDiversityCap: 2,
  cacheTtlSeconds: 15,
  states: { quietMaxActivity: 1, highDemandRatio: 2, overloadedRatio: 4, resourceRichRatio: 0.75 },
};

export const HIVE_RESOLUTIONS = [7, 8, 9, 10] as const;
export type HiveResolution = (typeof HIVE_RESOLUTIONS)[number];
export const FINEST_RES = 10;
export const NEIGHBORHOOD_RES = 9;
