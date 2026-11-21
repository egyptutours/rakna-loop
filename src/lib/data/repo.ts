import type { PlatformSettings } from "../config";
import type {
  AccessCredential,
  AuditLog,
  AvailabilityException,
  AvailabilityRule,
  BookingEvent,
  ChallengeProgress,
  DepartureReport,
  FraudFlag,
  HiveCellStat,
  HiveConfig,
  HiveDemandBucket,
  HiveFeedback,
  LedgerEntry,
  MobilityMission,
  NeighborhoodChallenge,
  ParkingBooking,
  ParkingPartner,
  ParkingSpace,
  Profile,
  ReportClaim,
  ReportConfirmation,
  RewardItem,
  RewardRedemption,
  RewardRules,
} from "../types";

/**
 * Storage port. Business logic in src/lib/domain/* depends only on this
 * interface, so the demo adapter (in-memory) and the Supabase adapter are
 * interchangeable without touching the rules.
 *
 * Invariants every adapter MUST enforce at the storage layer as a backstop:
 *  - `insertLedger` is idempotent on `idempotencyKey` (UNIQUE constraint).
 *  - `insertLedger` refuses any entry that would make a balance negative.
 *  - `withLock` serializes critical sections for the same key.
 */
export interface Repo {
  readonly kind: "demo" | "supabase";

  withLock<T>(key: string, fn: () => Promise<T>): Promise<T>;

  // profiles
  getProfile(id: string): Promise<Profile | null>;
  listProfiles(): Promise<Profile[]>;
  updateProfile(id: string, patch: Partial<Profile>): Promise<Profile>;

  // departure reports
  insertReport(r: DepartureReport): Promise<DepartureReport>;
  getReport(id: string): Promise<DepartureReport | null>;
  updateReport(id: string, patch: Partial<DepartureReport>): Promise<DepartureReport>;
  /**
   * Atomic compare-and-set state transition (a single conditional UPDATE in SQL).
   * Applies `patch` only if the row still matches `expect`; returns null otherwise.
   * This — not in-process locks — is what makes claims and confirmations race-safe
   * across server instances.
   */
  transitionReport(id: string, expect: ReportExpectation, patch: Partial<DepartureReport>): Promise<DepartureReport | null>;
  listReports(filter?: { reporterId?: string; reporterIds?: string[]; sinceIso?: string }): Promise<DepartureReport[]>;

  insertClaim(c: ReportClaim): Promise<ReportClaim>;
  updateClaims(filter: { reportId?: string; claimerId?: string; active?: boolean }, patch: Partial<ReportClaim>): Promise<void>;
  listClaims(filter: { reportId?: string; claimerId?: string }): Promise<ReportClaim[]>;

  insertConfirmation(c: ReportConfirmation): Promise<ReportConfirmation>;
  listConfirmations(filter: { reportId?: string; confirmerId?: string; sinceIso?: string }): Promise<ReportConfirmation[]>;

  // points ledger
  /**
   * Returns inserted=false when the idempotency key already exists. Throws on negative balance.
   * With `cap`, earning entries are clamped to the remaining daily allowance INSIDE the
   * storage-level lock (entry=null when nothing remains).
   */
  insertLedger(e: LedgerEntry, cap?: { limit: number; sinceIso: string }): Promise<{ inserted: boolean; entry: LedgerEntry | null }>;
  listLedger(filter?: { userId?: string; sinceIso?: string; limit?: number }): Promise<LedgerEntry[]>;
  /** Exact program-wide totals, aggregated in storage. */
  ledgerTotals(): Promise<{ earned: number; spent: number; refunded: number; outstanding: number }>;
  findLedgerByKey(key: string): Promise<LedgerEntry | null>;

  // rewards
  listRewards(): Promise<RewardItem[]>;
  getReward(id: string): Promise<RewardItem | null>;
  upsertReward(r: RewardItem): Promise<RewardItem>;
  /** Atomic stock change; false if it would go below zero. Unlimited (null) stock always succeeds. */
  adjustRewardStock(id: string, delta: number): Promise<boolean>;
  insertRedemption(r: RewardRedemption): Promise<RewardRedemption>;
  updateRedemption(id: string, patch: Partial<RewardRedemption>): Promise<RewardRedemption>;
  getRedemption(id: string): Promise<RewardRedemption | null>;
  listRedemptions(filter?: { userId?: string; status?: RewardRedemption["status"] }): Promise<RewardRedemption[]>;

  // partners, spaces, bookings
  listPartners(): Promise<ParkingPartner[]>;
  getPartner(id: string): Promise<ParkingPartner | null>;
  insertPartner(p: ParkingPartner): Promise<ParkingPartner>;
  updatePartner(id: string, patch: Partial<ParkingPartner>): Promise<ParkingPartner>;
  listSpaces(filter?: { partnerId?: string }): Promise<ParkingSpace[]>;
  getSpace(id: string): Promise<ParkingSpace | null>;
  insertSpace(s: ParkingSpace): Promise<ParkingSpace>;
  updateSpace(id: string, patch: Partial<ParkingSpace>): Promise<ParkingSpace>;
  insertBooking(b: ParkingBooking): Promise<ParkingBooking>;
  /** Atomic capacity check + insert (serialized per space). False when the slot is full. */
  insertBookingIfCapacity(b: ParkingBooking, capacity: number): Promise<boolean>;
  updateBooking(id: string, patch: Partial<ParkingBooking>): Promise<ParkingBooking>;
  listBookings(filter?: { userId?: string; spaceId?: string; spaceIds?: string[] }): Promise<ParkingBooking[]>;

  // community
  listChallenges(): Promise<NeighborhoodChallenge[]>;
  upsertChallengeProgress(p: ChallengeProgress): Promise<void>;
  listChallengeProgress(userId: string): Promise<ChallengeProgress[]>;
  insertMission(m: MobilityMission): Promise<MobilityMission>;
  updateMission(id: string, patch: Partial<MobilityMission>): Promise<MobilityMission>;
  getMission(id: string): Promise<MobilityMission | null>;
  listMissions(filter?: { userId?: string; status?: MobilityMission["status"] }): Promise<MobilityMission[]>;

  // trust & safety
  insertFraudFlag(f: FraudFlag): Promise<FraudFlag>;
  updateFraudFlag(id: string, patch: Partial<FraudFlag>): Promise<FraudFlag>;
  listFraudFlags(filter?: { status?: FraudFlag["status"]; userId?: string }): Promise<FraudFlag[]>;
  insertAudit(a: AuditLog): Promise<void>;
  listAudit(limit?: number): Promise<AuditLog[]>;

  // configuration
  getRules(): Promise<RewardRules>;
  setRules(rules: RewardRules): Promise<RewardRules>;

  /** Privacy retention: drop precise coordinates older than the cutoff. Returns rows coarsened. */
  purgePreciseLocations(beforeIso: string): Promise<number>;

  // ─── RAKNA HIVE (H3) ───────────────────────────────────────────────
  /** Reports whose cell at `res` is one of `cells` (indexed equality in SQL: h3_r{res} = ANY(cells)). */
  listReportsInCells(res: number, cells: string[], opts?: { statuses?: DepartureReport["status"][]; limit?: number }): Promise<DepartureReport[]>;
  listSpacesInCells(res: number, cells: string[]): Promise<ParkingSpace[]>;
  /** Additive upsert of anonymized outcome counters (cell = r10, hourly bucket). */
  incrementCellStat(stat: HiveCellStat): Promise<void>;
  /** Stats whose r10 cell rolls up into one of `cells` at `res`. */
  listCellStats(res: number, cells: string[], sinceIso: string): Promise<HiveCellStat[]>;
  incrementDemand(cellR9: string, bucketStart: string, searches: number, isDemo?: boolean): Promise<void>;
  /** Demand buckets rolling up into `cells` at `res` (demand is stored at r9; finer queries use the r9 parent). */
  listDemand(res: number, cells: string[], sinceIso: string): Promise<HiveDemandBucket[]>;
  deleteReports(ids: string[]): Promise<number>;
  deleteClaimsBefore(beforeIso: string): Promise<number>;
  deleteCellStatsBefore(beforeIso: string): Promise<number>;
  deleteDemandBefore(beforeIso: string): Promise<number>;
  getHiveConfig(): Promise<HiveConfig>;
  setHiveConfig(c: HiveConfig): Promise<HiveConfig>;
  addFeedback(helpful: boolean): Promise<HiveFeedback>;
  getFeedback(): Promise<HiveFeedback>;
  /** Volume counters, used to prove queries never scan or ship the full dataset. */
  stats(): Promise<{ reports: number; spaces: number; cellStats: number; demand: number }>;

  // ─── Operations ───────────────────────────────────────────────────
  /** Run the lifecycle inside the database (Supabase: rakna_hive_lifecycle()); null = not supported → app-level job. */
  runNativeLifecycle(): Promise<Record<string, unknown> | null>;
  recordJobRun(run: JobRun): Promise<void>;
  listJobRuns(job: string, limit: number): Promise<JobRun[]>;
  /** Account deletion: delete temporary personal records, anonymize the profile, keep durable records. */
  anonymizeProfile(userId: string): Promise<Record<string, number>>;

  // ─── Phase 3: RAKNA HOME / PARTNERS / PARK & CONNECT ──────────────
  getBooking(id: string): Promise<ParkingBooking | null>;
  listAvailabilityRules(spaceIds: string[]): Promise<AvailabilityRule[]>;
  /** Replace a space's whole weekly rule set (one transaction in SQL). */
  replaceAvailabilityRules(spaceId: string, rules: AvailabilityRule[]): Promise<AvailabilityRule[]>;
  listAvailabilityExceptions(spaceIds: string[], fromDate?: string): Promise<AvailabilityException[]>;
  /** Unique on (spaceId, exceptionDate): a second write for the same date replaces the first. */
  upsertAvailabilityException(e: AvailabilityException): Promise<AvailabilityException>;
  /**
   * insert_booking_checked(jsonb, …) (0007) — ONE atomic step (advisory lock per space in SQL):
   * capacity check counting overlaps padded by the turnaround buffer, booking insert and
   * access-credential insert. Never partially applied.
   */
  insertHomeBooking(b: ParkingBooking, opts: { capacity: number; bufferMinutes: number; credential: AccessCredential | null }): Promise<"ok" | "capacity_full">;
  /** extend_booking_checked — atomic re-check of capacity/buffer for the extension window, then update. */
  extendHomeBooking(id: string, newEndIso: string, patch: Partial<ParkingBooking>, opts: { capacity: number; bufferMinutes: number; credentialValidUntil: string }): Promise<ParkingBooking | null>;
  getCredential(bookingId: string): Promise<AccessCredential | null>;
  updateCredential(bookingId: string, patch: Partial<AccessCredential>): Promise<void>;
  insertBookingEvent(e: BookingEvent): Promise<BookingEvent>;
  listBookingEvents(bookingId: string): Promise<BookingEvent[]>;
  /**
   * Shared fixed-window rate limiter (blocker B2). Returns true when the call is allowed.
   * SQL: check_rate_limit() increments a row keyed by (key, window) atomically, so every
   * server instance sees the same counter.
   */
  checkRateLimit(key: string, limit: number, windowSeconds: number, nowIso: string): Promise<boolean>;
  getPlatformSettings(): Promise<PlatformSettings>;
  setPlatformSettings(s: PlatformSettings): Promise<PlatformSettings>;
  /**
   * hive_viewport(): reports, spaces, cell stats and demand for a viewport in ONE round
   * trip. Exact coordinates are returned to the server only; the API coarsens them.
   */
  viewportBundle(q: ViewportQuery): Promise<ViewportBundle>;
  /** Keyset pagination (blocker B7): newest first, `cursor` = the last item's createdAt|id. */
  listPage<K extends PageEntity>(entity: K, opts: { limit: number; cursor?: string | null }): Promise<Page<PageItem<K>>>;
}

export interface ViewportQuery {
  reportRes: number;
  reportCells: string[];
  reportStatuses: DepartureReport["status"][];
  reportLimit: number;
  spaceRes: number;
  spaceCells: string[];
  statRes: number;
  statCells: string[];
  sinceIso: string;
}

export interface ViewportBundle {
  reports: DepartureReport[];
  spaces: ParkingSpace[];
  cellStats: HiveCellStat[];
  demand: HiveDemandBucket[];
}

export type PageEntity = "profiles" | "partners" | "spaces" | "bookings";
export type PageItem<K extends PageEntity> = K extends "profiles" ? Profile : K extends "partners" ? ParkingPartner : K extends "spaces" ? ParkingSpace : ParkingBooking;
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export function encodeCursor(item: { createdAt: string; id: string }): string {
  return `${item.createdAt}|${item.id}`;
}

export function decodeCursor(cursor: string | null | undefined): { createdAt: string; id: string } | null {
  if (!cursor) return null;
  const i = cursor.lastIndexOf("|");
  if (i <= 0) return null;
  const createdAt = cursor.slice(0, i);
  const id = cursor.slice(i + 1);
  if (Number.isNaN(Date.parse(createdAt)) || !/^[0-9a-f-]{36}$/i.test(id)) return null;
  return { createdAt, id };
}

/** Newest-first keyset slice used by the in-memory adapter (mirrors the SQL ORDER BY created_at desc, id desc). */
export function pageOf<T extends { createdAt: string; id: string }>(all: T[], limit: number, cursor?: string | null): Page<T> {
  const c = decodeCursor(cursor);
  const sorted = [...all].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  const rest = c ? sorted.filter((x) => x.createdAt < c.createdAt || (x.createdAt === c.createdAt && x.id < c.id)) : sorted;
  const items = rest.slice(0, limit);
  return { items, nextCursor: rest.length > limit ? encodeCursor(items[items.length - 1]) : null };
}

export interface ReportExpectation {
  statuses: DepartureReport["status"][];
  claimedBy?: string | null;
  /** Row must expire strictly after this instant (not yet expired). */
  expiresAfterIso?: string;
  /** Row must have expired at or before this instant. */
  expiresAtOrBeforeIso?: string;
}

export interface JobRun {
  job: string;
  startedAt: string;
  finishedAt: string | null;
  ok: boolean | null;
  details: Record<string, unknown> | null;
  error: string | null;
}
