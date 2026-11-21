import "server-only";
import type { DepartureReport, LatLng, ParkingSpace, Profile } from "../types";
import { coarsen } from "../geo";
import type { DomainContext } from "../domain/context";
import { confidenceFor, type ConfidenceBreakdown } from "../domain/handoff";

/**
 * Public data-transfer objects. Precise report coordinates are returned only to
 * the reporter, the driver who claimed the report, and admins. Everyone else sees
 * a ~110 m grid position. Reporter identity is never exposed on the map.
 */

export interface ReportView {
  id: string;
  status: DepartureReport["status"];
  location: LatLng;
  precise: boolean;
  accuracyM: number;
  neighborhood: string;
  createdAt: string;
  expectedDepartureAt: string;
  expiresAt: string;
  claimExpiresAt: string | null;
  isMine: boolean;
  claimedByMe: boolean;
  claimedByOther: boolean;
  confidence: ConfidenceBreakdown;
  isDemo: boolean;
}

export async function toReportView(ctx: DomainContext, r: DepartureReport, viewer: Profile | null, viewerLoc?: LatLng | null): Promise<ReportView> {
  const isMine = viewer?.id === r.reporterId;
  const claimedByMe = Boolean(viewer && r.claimedBy === viewer.id);
  const precise = isMine || claimedByMe || viewer?.role === "admin";
  return {
    id: r.id,
    status: r.status,
    location: precise ? r.location : coarsen(r.location),
    precise,
    accuracyM: r.accuracyM,
    neighborhood: r.neighborhood,
    createdAt: r.createdAt,
    expectedDepartureAt: r.expectedDepartureAt,
    expiresAt: r.expiresAt,
    claimExpiresAt: claimedByMe || isMine ? r.claimExpiresAt : null,
    isMine,
    claimedByMe,
    claimedByOther: r.status === "claimed" && !claimedByMe,
    confidence: await confidenceFor(ctx, r, viewerLoc ?? null),
    isDemo: r.isDemo,
  };
}

export interface SpaceView {
  id: string;
  partnerId: string;
  partnerName: string;
  partnerNameAr: string;
  title: string;
  titleAr: string;
  location: LatLng;
  neighborhood: string;
  address: string;
  addressAr: string;
  capacity: number;
  pricePerHour: number;
  schedule: ParkingSpace["schedule"];
  conditions: string;
  conditionsAr: string;
  rewardEligible: boolean;
  approval: ParkingSpace["approval"];
  openNow: boolean;
  freeNow: number;
  isDemo: boolean;
  // Phase 3 (residential spaces: location is the ~150 m privacy point and address is empty)
  spaceCategory?: ParkingSpace["spaceCategory"];
  shadeTier?: ParkingSpace["shadeTier"];
  accessMode?: ParkingSpace["accessMode"];
  bufferMinutes?: number;
  maxHeightCm?: number | null;
  metro?: { code: string; name: string; nameAr: string; walkMinutes: number } | null;
  approximate?: boolean;
  waitlist?: boolean;
  scheduleBooking?: boolean;
  rules?: { weekdayMask: number; startMinute: number; endMinute: number; hourlyRateHalalas: number; dailyCapHalalas: number | null; multiDayDiscountBps: number }[];
}
