// Core domain types for RAKNA LOOP. Shared by the demo adapter, the Supabase
// adapter, the API routes and the UI. Mirrors supabase/migrations/0001_schema.sql.

export type Role = "driver" | "partner" | "admin";
export type Lang = "ar" | "en";

export interface LatLng {
  lat: number;
  lng: number;
}

export interface Profile {
  id: string;
  displayName: string;
  displayNameAr: string;
  role: Role;
  neighborhood: string; // neighborhood id, coarse only — never a home location
  lang: Lang;
  locationConsentAt: string | null;
  deletionRequestedAt: string | null;
  createdAt: string;
  isDemo: boolean;
  /** Set when the account was anonymized after a deletion request. */
  deletedAt?: string | null;
}

export type ReportStatus =
  | "pending_departure"
  | "available"
  | "claimed"
  | "found"
  | "not_found"
  | "expired"
  | "flagged";

export interface DepartureReport {
  id: string;
  reporterId: string;
  location: LatLng; // precise; only returned to the reporter, the claimer and admins
  accuracyM: number;
  neighborhood: string;
  note: string | null;
  createdAt: string;
  expectedDepartureAt: string;
  expiresAt: string;
  status: ReportStatus;
  claimedBy: string | null;
  claimedAt: string | null;
  claimExpiresAt: string | null;
  claimLocation: LatLng | null;
  resolvedAt: string | null;
  isDemo: boolean;
  /** RAKNA HIVE indexes (H3). Used for grouping/queries only — never replace `location`. */
  hive?: HiveIndex;
  /** Set once the outcome has been folded into hive_cell_stats (data lifecycle). */
  aggregatedAt?: string | null;
}

/** H3 cell ids of a point at every hive resolution (finest = 10). Denormalized for indexed equality queries. */
export interface HiveIndex {
  r7: string;
  r8: string;
  r9: string;
  r10: string;
}

export type HiveState = "quiet" | "active" | "resource_rich" | "high_demand" | "overloaded";

/** Aggregated, anonymized outcome counters for one H3 cell and one hourly bucket (no user ids). */
export interface HiveCellStat {
  cell: string; // finest-resolution (r10) cell id
  bucketStart: string; // ISO hour
  reports: number;
  found: number;
  notFound: number;
  expired: number;
  isDemo: boolean;
}

/** Anonymous forager demand counter (search intents) per r9 cell and hourly bucket. */
export interface HiveDemandBucket {
  cell: string; // r9 cell id
  bucketStart: string;
  searches: number;
  isDemo: boolean;
}

export interface HiveFeedback {
  helpful: number;
  notHelpful: number;
}

export interface HiveConfig {
  /** Zoom bands → resolution and rendering mode. */
  zoomBands: { maxZoom: number; resolution: number; mode: "aggregate" | "street" }[];
  maxCellsPerQuery: number;
  maxSignalsPerPage: number;
  signalHalfLifeMinutes: number; // freshness decay of a live signal
  trailHalfLifeDays: number; // evaporation of a cell's historical "trail"
  demandWindowMinutes: number; // demand considered "current"
  statsRetentionDays: number; // aggregated buckets kept for trails
  reportRetentionDays: number; // resolved temporary reports deleted after aggregation
  claimRetentionHours: number;
  aggregateAfterMinutes: number; // fold resolved/expired reports into stats after this delay
  recruitmentMaxRings: number; // neighbor search radius (k rings at r9)
  perCellDiversityCap: number; // fairness: max results per r9 cell in a recommendation list
  cacheTtlSeconds: number;
  states: { quietMaxActivity: number; highDemandRatio: number; overloadedRatio: number; resourceRichRatio: number };
}

export interface ReportClaim {
  id: string;
  reportId: string;
  claimerId: string;
  claimLocation: LatLng | null;
  claimAccuracyM: number | null;
  createdAt: string;
  expiresAt: string;
  active: boolean;
}

export type ConfirmationOutcome = "found" | "not_found";
export type EvidenceType = "gps" | "simulated" | "none";

export interface ReportConfirmation {
  id: string;
  reportId: string;
  confirmerId: string;
  outcome: ConfirmationOutcome;
  location: LatLng | null;
  accuracyM: number | null;
  distanceM: number | null;
  evidence: EvidenceType;
  accepted: boolean;
  rejectionReason: string | null;
  createdAt: string;
}

export type LedgerType =
  | "departure_reward"
  | "confirmation_reward"
  | "streak_bonus"
  | "mission_reward"
  | "redemption"
  | "redemption_refund"
  | "admin_reversal"
  | "booking_discount";

export interface LedgerEntry {
  id: string;
  userId: string;
  amount: number; // positive = earned, negative = spent
  type: LedgerType;
  reason: string;
  idempotencyKey: string; // UNIQUE — guarantees no duplicate awards
  refType: string | null;
  refId: string | null;
  createdAt: string;
}

export type RewardCategory = "parking_discount" | "partner_benefit" | "sponsored_voucher" | "membership_perk";

export interface RewardItem {
  id: string;
  title: string;
  titleAr: string;
  description: string;
  descriptionAr: string;
  category: RewardCategory;
  keysRequired: number;
  partnerId: string | null;
  discountPercent: number | null; // for parking_discount
  eligibility: string;
  eligibilityAr: string;
  terms: string;
  termsAr: string;
  active: boolean;
  stock: number | null;
  isDemo: boolean;
}

export type RedemptionStatus = "pending_approval" | "approved" | "rejected" | "used";

export interface RewardRedemption {
  id: string;
  userId: string;
  rewardId: string;
  keysSpent: number;
  status: RedemptionStatus;
  code: string | null;
  simulated: boolean;
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  bookingId: string | null;
}

export type PartnerStatus = "pending" | "approved" | "rejected" | "suspended";

export interface ParkingPartner {
  id: string;
  ownerId: string;
  name: string;
  nameAr: string;
  kind: "hotel" | "office" | "mall" | "operator" | "residential";
  contactEmail: string;
  crNumberProvided: boolean; // commercial registration supplied (value not stored in MVP)
  status: PartnerStatus;
  createdAt: string;
  reviewedAt: string | null;
  isDemo: boolean;
}

export type SpaceApproval = "pending_review" | "approved" | "rejected" | "paused";

export interface WeeklySchedule {
  days: number[]; // 0 = Sunday … 6 = Saturday
  openHour: number; // 0–23
  closeHour: number; // 1–24
}

export interface ParkingSpace {
  id: string;
  partnerId: string;
  title: string;
  titleAr: string;
  location: LatLng;
  neighborhood: string;
  address: string;
  addressAr: string;
  capacity: number;
  pricePerHour: number; // SAR
  schedule: WeeklySchedule;
  conditions: string;
  conditionsAr: string;
  rewardEligible: boolean;
  approval: SpaceApproval;
  createdAt: string;
  isDemo: boolean;
  /** Number of accessible (disabled-badge) bays. */
  accessibleBays?: number;
  hive?: HiveIndex;
  // ─── Phase 3: RAKNA HOME / PARTNERS / PARK & CONNECT (all optional for legacy rows) ───
  spaceCategory?: SpaceCategory;
  entitlementType?: EntitlementType;
  verificationStatus?: VerificationStatus;
  /** ~150 m privacy point (center of the parent r9 hexagon) shown before a confirmed booking. */
  publicLocation?: LatLng | null;
  shadeTier?: ShadeTier;
  maxHeightCm?: number | null;
  maxWidthCm?: number | null;
  maxLengthCm?: number | null;
  bufferMinutes?: number;
  instantBook?: boolean;
  accessMode?: AccessMode;
  metroStationCode?: string | null;
  waitlistOnly?: boolean;
  /** Host account for residential listings (owner of the space). */
  hostId?: string | null;
  /** Ejar tenants: when written landlord consent was attested (the contract itself is never stored). */
  landlordConsentAt?: string | null;
}

export type SpaceCategory = "villa_shaded" | "villa_open" | "villa_garage" | "condo_deeded" | "condo_association" | "commercial";
export type EntitlementType = "deed_owner" | "owner_wakalah" | "ejar_authorized" | "owners_association" | "commercial_cr";
export type VerificationStatus = "pending" | "verified" | "rejected" | "suspended";
export type ShadeTier = "underground" | "enclosed" | "full_carport" | "partial_shade" | "uncovered";
export type AccessMode = "unobstructed" | "ephemeral_pin" | "dynamic_qr" | "guard_pass" | "host_remote";

export const VILLA_CATEGORIES: SpaceCategory[] = ["villa_shaded", "villa_open", "villa_garage"];
export const RESIDENTIAL_CATEGORIES: SpaceCategory[] = ["villa_shaded", "villa_open", "villa_garage", "condo_deeded", "condo_association"];

/** Weekly recurring availability (compact: one row per rule, never per slot). Money in HALALAS. */
export interface AvailabilityRule {
  id: string;
  spaceId: string;
  weekdayMask: number; // bit 0 = Sunday … bit 6 = Saturday (1..127)
  startMinute: number; // 0..1439 (Riyadh local)
  endMinute: number; // 1..1440, > startMinute
  hourlyRateHalalas: number;
  dailyCapHalalas: number | null;
  multiDayDiscountBps: number; // 0..5000, applied when the booking is ≥ 5 days
  isActive: boolean;
  createdAt: string;
}

export interface AvailabilityException {
  id: string;
  spaceId: string;
  exceptionDate: string; // YYYY-MM-DD (Riyadh)
  isBlocked: boolean;
  overrideStartMinute: number | null;
  overrideEndMinute: number | null;
}

export type CredentialType = "none" | "pin" | "qr_token" | "guard_code";

export interface AccessCredential {
  bookingId: string;
  credentialType: CredentialType;
  secretPayload: string;
  validFrom: string;
  validUntil: string;
  revokedAt: string | null;
}

export type BookingEventType = "arrived" | "extended" | "departed" | "overstay_flagged" | "bay_blocked_reported";

export interface BookingEvent {
  id: string;
  bookingId: string;
  actorId: string;
  eventType: BookingEventType;
  location: LatLng | null;
  evidenceNote: string | null;
  createdAt: string;
}

export type PaymentStatus = "simulated" | "pending" | "paid" | "failed" | "refunded";

/** Integer-halalas fare breakdown (1 SAR = 100 halalas). */
export interface FareBreakdown {
  baseFareHalalas: number;
  driverFeeHalalas: number;
  hostCommissionHalalas: number;
  vatOnPlatformFeeHalalas: number;
  keysDiscountHalalas: number;
  hostNetPayoutHalalas: number;
  driverTotalHalalas: number;
}

export type BookingStatus = "confirmed" | "cancelled" | "completed";

export interface ParkingBooking {
  id: string;
  spaceId: string;
  userId: string;
  startAt: string;
  endAt: string;
  hours: number;
  priceTotal: number;
  discountApplied: number;
  redemptionId: string | null;
  status: BookingStatus;
  simulatedPayment: true;
  createdAt: string;
  // ─── Phase 3 (home/schedule bookings; absent on legacy bookings) ───
  fare?: FareBreakdown;
  bufferMinutes?: number;
  paymentStatus?: PaymentStatus;
  pspReference?: string | null;
  arrivedAt?: string | null;
  departedAt?: string | null;
  overstaySurchargeHalalas?: number;
}

export type ChallengeMetric =
  | "handoffs_today"
  | "handoffs_week"
  | "verified_reports_week"
  | "neighborhood_handoffs_week"
  | "missions_approved";

export interface NeighborhoodChallenge {
  id: string;
  title: string;
  titleAr: string;
  description: string;
  descriptionAr: string;
  metric: ChallengeMetric;
  target: number;
  neighborhood: string | null; // null = applies to the user's own neighborhood
  // Challenges grant recognition and badges only. Keys come exclusively from the
  // verified actions in RewardRules, so no activity is ever paid twice.
  active: boolean;
  isDemo: boolean;
}

export interface ChallengeProgress {
  challengeId: string;
  userId: string;
  progress: number;
  completedAt: string | null;
}

export type MissionStatus = "submitted" | "approved" | "rejected";

export interface MobilityMission {
  id: string;
  userId: string;
  kind: "park_and_metro" | "walk_connection" | "carpool";
  description: string;
  status: MissionStatus;
  createdAt: string;
  decidedAt: string | null;
  simulated: true;
}

export type FraudKind =
  | "self_confirmation_attempt"
  | "too_far_confirmation"
  | "impossible_travel"
  | "repeated_not_found"
  | "pair_collusion"
  | "report_spam"
  | "rapid_arrival";

export interface FraudFlag {
  id: string;
  kind: FraudKind;
  userId: string;
  relatedUserId: string | null;
  reportId: string | null;
  details: string;
  severity: "low" | "medium" | "high";
  status: "open" | "dismissed" | "actioned";
  createdAt: string;
  reviewedBy: string | null;
}

export interface AuditLog {
  id: string;
  actorId: string;
  action: string;
  target: string;
  details: string;
  createdAt: string;
}

export interface RewardRules {
  departureReward: number;
  confirmationReward: number;
  streakEvery: number;
  streakBonus: number;
  missionReward: number;
  dailyEarnLimit: number;
  dailyReportLimit: number;
  reportTtlMinutes: number;
  claimTtlMinutes: number;
  maxConfirmDistanceM: number;
  maxReportAccuracyM: number;
  minClaimToConfirmSeconds: number;
  locationRetentionHours: number;
}

export interface UserReliability {
  successful: number;
  notFound: number;
  expired: number;
  score: number; // 0..1 Bayesian estimate
}
