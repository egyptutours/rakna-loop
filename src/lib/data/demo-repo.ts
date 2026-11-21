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
import { pageOf, type JobRun, type Page, type PageEntity, type PageItem, type Repo, type ReportExpectation, type ViewportBundle, type ViewportQuery } from "./repo";
import { DEFAULT_PLATFORM_SETTINGS, type PlatformSettings } from "../config";
import { coarsen } from "../geo";
import { cellAt, hiveIndexFor, parentOf } from "../hive/cells";
import { DEFAULT_HIVE_CONFIG } from "../hive/config";
import { cellToCenterChild } from "h3-js";

/** Upgrade a persisted demo state from an earlier version: add hive fields and H3 indexes. */
export function migrateDemoState(s: DemoState): DemoState {
  s.cellStats ??= [];
  s.demand ??= [];
  s.hiveConfig = { ...DEFAULT_HIVE_CONFIG, ...(s.hiveConfig ?? {}), states: { ...DEFAULT_HIVE_CONFIG.states, ...(s.hiveConfig?.states ?? {}) } };
  s.feedback ??= { helpful: 0, notHelpful: 0 };
  s.jobRuns ??= [];
  s.availabilityRules ??= [];
  s.availabilityExceptions ??= [];
  s.credentials ??= [];
  s.bookingEvents ??= [];
  s.rateLimits ??= {};
  s.platformSettings = { ...DEFAULT_PLATFORM_SETTINGS, ...(s.platformSettings ?? {}) };
  for (const r of s.reports) r.hive ??= hiveIndexFor(r.location);
  for (const sp of s.spaces) {
    sp.hive ??= hiveIndexFor(sp.location);
    sp.accessibleBays ??= 0;
  }
  return s;
}

export interface DemoState {
  profiles: Profile[];
  reports: DepartureReport[];
  claims: ReportClaim[];
  confirmations: ReportConfirmation[];
  ledger: LedgerEntry[];
  rewards: RewardItem[];
  redemptions: RewardRedemption[];
  partners: ParkingPartner[];
  spaces: ParkingSpace[];
  bookings: ParkingBooking[];
  challenges: NeighborhoodChallenge[];
  challengeProgress: ChallengeProgress[];
  missions: MobilityMission[];
  fraudFlags: FraudFlag[];
  audit: AuditLog[];
  rules: RewardRules;
  seededAt: string;
  cellStats: HiveCellStat[];
  demand: HiveDemandBucket[];
  hiveConfig: HiveConfig;
  feedback: HiveFeedback;
  jobRuns: JobRun[];
  // Phase 3
  availabilityRules: AvailabilityRule[];
  availabilityExceptions: AvailabilityException[];
  credentials: AccessCredential[];
  bookingEvents: BookingEvent[];
  /** key|windowStart → count (fixed-window limiter, mirrors the rate_limits table). */
  rateLimits: Record<string, number>;
  platformSettings: PlatformSettings;
}

const clone = <T>(v: T): T => structuredClone(v);

/**
 * In-memory adapter used in DEMO MODE (and by the test suite). It enforces the
 * same storage invariants the Postgres schema enforces: unique idempotency keys
 * and non-negative balances.
 */
/** Bump when the adapter's method surface changes (dev hot-reload safety). */
export const DEMO_REPO_VERSION = 4;

export class DemoRepo implements Repo {
  readonly kind = "demo" as const;
  readonly version = DEMO_REPO_VERSION;
  private locks = new Map<string, Promise<unknown>>();

  constructor(
    private state: DemoState,
    private onChange: (s: DemoState) => void = () => {},
  ) {
    migrateDemoState(this.state);
  }

  snapshot(): DemoState {
    return clone(this.state);
  }

  replace(state: DemoState) {
    this.state = migrateDemoState(state);
    this.onChange(this.state);
  }

  private changed() {
    this.onChange(this.state);
  }

  async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((r) => (release = r));
    const chained = prev.then(() => next);
    this.locks.set(key, chained);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(key) === chained) this.locks.delete(key);
    }
  }

  private patch<T extends { id: string }>(list: T[], id: string, patch: Partial<T>, label: string): T {
    const i = list.findIndex((x) => x.id === id);
    if (i < 0) throw new Error(`${label} ${id} not found`);
    list[i] = { ...list[i], ...patch, id };
    this.changed();
    return clone(list[i]);
  }

  // profiles
  async getProfile(id: string) { return clone(this.state.profiles.find((p) => p.id === id) ?? null); }
  async listProfiles() { return clone(this.state.profiles); }
  async updateProfile(id: string, patch: Partial<Profile>) { return this.patch(this.state.profiles, id, patch, "profile"); }

  // reports
  async insertReport(r: DepartureReport) { this.state.reports.push(clone(r)); this.changed(); return clone(r); }
  async getReport(id: string) { return clone(this.state.reports.find((r) => r.id === id) ?? null); }
  async updateReport(id: string, patch: Partial<DepartureReport>) { return this.patch(this.state.reports, id, patch, "report"); }
  /** Compare-and-set: check and write happen with no await in between, so it is atomic in-process. */
  async transitionReport(id: string, expect: ReportExpectation, patch: Partial<DepartureReport>) {
    const i = this.state.reports.findIndex((r) => r.id === id);
    if (i < 0) return null;
    const r = this.state.reports[i];
    if (!expect.statuses.includes(r.status)) return null;
    if (expect.claimedBy !== undefined && r.claimedBy !== expect.claimedBy) return null;
    if (expect.expiresAfterIso && !(r.expiresAt > expect.expiresAfterIso)) return null;
    if (expect.expiresAtOrBeforeIso && !(r.expiresAt <= expect.expiresAtOrBeforeIso)) return null;
    this.state.reports[i] = { ...r, ...patch, id };
    this.changed();
    return clone(this.state.reports[i]);
  }
  async listReports(filter: { reporterId?: string; reporterIds?: string[]; sinceIso?: string } = {}) {
    const ids = filter.reporterIds ? new Set(filter.reporterIds) : null;
    return clone(this.state.reports.filter((r) => (!filter.reporterId || r.reporterId === filter.reporterId) && (!ids || ids.has(r.reporterId)) && (!filter.sinceIso || r.createdAt >= filter.sinceIso)));
  }

  async insertClaim(c: ReportClaim) { this.state.claims.push(clone(c)); this.changed(); return clone(c); }
  async updateClaims(filter: { reportId?: string; claimerId?: string; active?: boolean }, patch: Partial<ReportClaim>) {
    this.state.claims = this.state.claims.map((c) =>
      (!filter.reportId || c.reportId === filter.reportId) && (!filter.claimerId || c.claimerId === filter.claimerId) && (filter.active === undefined || c.active === filter.active)
        ? { ...c, ...patch, id: c.id }
        : c,
    );
    this.changed();
  }
  async listClaims(filter: { reportId?: string; claimerId?: string }) {
    return clone(this.state.claims.filter((c) => (!filter.reportId || c.reportId === filter.reportId) && (!filter.claimerId || c.claimerId === filter.claimerId)));
  }

  async insertConfirmation(c: ReportConfirmation) { this.state.confirmations.push(clone(c)); this.changed(); return clone(c); }
  async listConfirmations(filter: { reportId?: string; confirmerId?: string; sinceIso?: string }) {
    return clone(this.state.confirmations.filter((c) => (!filter.reportId || c.reportId === filter.reportId) && (!filter.confirmerId || c.confirmerId === filter.confirmerId) && (!filter.sinceIso || c.createdAt >= filter.sinceIso)));
  }

  // ledger — UNIQUE(idempotency_key) and CHECK(balance >= 0) equivalents
  async insertLedger(e: LedgerEntry, cap?: { limit: number; sinceIso: string }) {
    const existing = this.state.ledger.find((x) => x.idempotencyKey === e.idempotencyKey);
    if (existing) return { inserted: false, entry: clone(existing) };
    const EARN = ["departure_reward", "confirmation_reward", "streak_bonus", "mission_reward"];
    if (cap && e.amount > 0 && EARN.includes(e.type)) {
      const earned = this.state.ledger.filter((x) => x.userId === e.userId && x.createdAt >= cap.sinceIso && EARN.includes(x.type)).reduce((s, x) => s + x.amount, 0);
      const allowed = Math.max(0, cap.limit - earned);
      if (allowed <= 0) return { inserted: false, entry: null };
      if (allowed < e.amount) e = { ...e, amount: allowed, reason: `${e.reason} (daily limit applied: ${allowed}/${e.amount})` };
    }
    if (e.amount < 0) {
      const balance = this.state.ledger.filter((x) => x.userId === e.userId).reduce((s, x) => s + x.amount, 0);
      if (balance + e.amount < 0) throw new Error("ledger invariant violated: negative balance");
    }
    this.state.ledger.push(clone(e));
    this.changed();
    return { inserted: true, entry: clone(e) };
  }
  async listLedger(filter: { userId?: string; sinceIso?: string; limit?: number } = {}) {
    const rows = this.state.ledger.filter((e) => (!filter.userId || e.userId === filter.userId) && (!filter.sinceIso || e.createdAt >= filter.sinceIso));
    if (filter.limit) return clone([...rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, filter.limit));
    return clone(rows);
  }
  async ledgerTotals() {
    const L = this.state.ledger;
    return {
      earned: L.filter((e) => e.amount > 0 && e.type !== "redemption_refund").reduce((s, e) => s + e.amount, 0),
      spent: -L.filter((e) => e.amount < 0 && e.type !== "admin_reversal").reduce((s, e) => s + e.amount, 0),
      refunded: L.filter((e) => e.type === "redemption_refund").reduce((s, e) => s + e.amount, 0),
      outstanding: L.reduce((s, e) => s + e.amount, 0),
    };
  }
  async findLedgerByKey(key: string) { return clone(this.state.ledger.find((e) => e.idempotencyKey === key) ?? null); }

  // rewards
  async listRewards() { return clone(this.state.rewards); }
  async getReward(id: string) { return clone(this.state.rewards.find((r) => r.id === id) ?? null); }
  async upsertReward(r: RewardItem) {
    const i = this.state.rewards.findIndex((x) => x.id === r.id);
    if (i >= 0) this.state.rewards[i] = clone(r);
    else this.state.rewards.push(clone(r));
    this.changed();
    return clone(r);
  }
  async adjustRewardStock(id: string, delta: number) {
    const r = this.state.rewards.find((x) => x.id === id);
    if (!r) return false;
    if (r.stock === null) return true;
    if (r.stock + delta < 0) return false;
    r.stock += delta;
    this.changed();
    return true;
  }
  async insertRedemption(r: RewardRedemption) { this.state.redemptions.push(clone(r)); this.changed(); return clone(r); }
  async updateRedemption(id: string, patch: Partial<RewardRedemption>) { return this.patch(this.state.redemptions, id, patch, "redemption"); }
  async getRedemption(id: string) { return clone(this.state.redemptions.find((r) => r.id === id) ?? null); }
  async listRedemptions(filter: { userId?: string; status?: RewardRedemption["status"] } = {}) {
    return clone(this.state.redemptions.filter((r) => (!filter.userId || r.userId === filter.userId) && (!filter.status || r.status === filter.status)));
  }

  // partners & spaces & bookings
  async listPartners() { return clone(this.state.partners); }
  async getPartner(id: string) { return clone(this.state.partners.find((p) => p.id === id) ?? null); }
  async insertPartner(p: ParkingPartner) { this.state.partners.push(clone(p)); this.changed(); return clone(p); }
  async updatePartner(id: string, patch: Partial<ParkingPartner>) { return this.patch(this.state.partners, id, patch, "partner"); }
  async listSpaces(filter: { partnerId?: string } = {}) { return clone(this.state.spaces.filter((s) => !filter.partnerId || s.partnerId === filter.partnerId)); }
  async getSpace(id: string) { return clone(this.state.spaces.find((s) => s.id === id) ?? null); }
  async insertSpace(s: ParkingSpace) { this.state.spaces.push(clone(s)); this.changed(); return clone(s); }
  async updateSpace(id: string, patch: Partial<ParkingSpace>) { return this.patch(this.state.spaces, id, patch, "space"); }
  async insertBooking(b: ParkingBooking) { this.state.bookings.push(clone(b)); this.changed(); return clone(b); }
  async insertBookingIfCapacity(b: ParkingBooking, capacity: number) {
    const used = this.state.bookings.filter((x) => x.spaceId === b.spaceId && x.status === "confirmed" && x.startAt < b.endAt && b.startAt < x.endAt).length;
    if (used >= capacity) return false;
    this.state.bookings.push(clone(b));
    this.changed();
    return true;
  }
  async updateBooking(id: string, patch: Partial<ParkingBooking>) { return this.patch(this.state.bookings, id, patch, "booking"); }
  async listBookings(filter: { userId?: string; spaceId?: string; spaceIds?: string[] } = {}) {
    return clone(this.state.bookings.filter((b) => (!filter.userId || b.userId === filter.userId) && (!filter.spaceId || b.spaceId === filter.spaceId) && (!filter.spaceIds || filter.spaceIds.includes(b.spaceId))));
  }

  // community
  async listChallenges() { return clone(this.state.challenges); }
  async upsertChallengeProgress(p: ChallengeProgress) {
    const i = this.state.challengeProgress.findIndex((x) => x.challengeId === p.challengeId && x.userId === p.userId);
    const prev = i >= 0 ? this.state.challengeProgress[i] : null;
    const next = { ...p, completedAt: prev?.completedAt ?? p.completedAt };
    if (prev && prev.progress === next.progress && prev.completedAt === next.completedAt) return;
    if (i >= 0) this.state.challengeProgress[i] = next;
    else this.state.challengeProgress.push(next);
    this.changed();
  }
  async listChallengeProgress(userId: string) { return clone(this.state.challengeProgress.filter((p) => p.userId === userId)); }
  async insertMission(m: MobilityMission) { this.state.missions.push(clone(m)); this.changed(); return clone(m); }
  async updateMission(id: string, patch: Partial<MobilityMission>) { return this.patch(this.state.missions, id, patch, "mission"); }
  async getMission(id: string) { return clone(this.state.missions.find((m) => m.id === id) ?? null); }
  async listMissions(filter: { userId?: string; status?: MobilityMission["status"] } = {}) {
    return clone(this.state.missions.filter((m) => (!filter.userId || m.userId === filter.userId) && (!filter.status || m.status === filter.status)));
  }

  // trust & safety
  async insertFraudFlag(f: FraudFlag) { this.state.fraudFlags.push(clone(f)); this.changed(); return clone(f); }
  async updateFraudFlag(id: string, patch: Partial<FraudFlag>) { return this.patch(this.state.fraudFlags, id, patch, "fraud flag"); }
  async listFraudFlags(filter: { status?: FraudFlag["status"]; userId?: string } = {}) {
    return clone(this.state.fraudFlags.filter((f) => (!filter.status || f.status === filter.status) && (!filter.userId || f.userId === filter.userId)));
  }
  async insertAudit(a: AuditLog) { this.state.audit.push(clone(a)); this.changed(); }
  async listAudit(limit = 50) { return clone([...this.state.audit].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit)); }

  // config
  async getRules() { return clone(this.state.rules); }
  async setRules(rules: RewardRules) { this.state.rules = clone(rules); this.changed(); return clone(rules); }

  // ─── RAKNA HIVE ────────────────────────────────────────────────────
  async listReportsInCells(res: number, cells: string[], opts: { statuses?: DepartureReport["status"][]; limit?: number } = {}) {
    const set = new Set(cells);
    const out: DepartureReport[] = [];
    for (const r of this.state.reports) {
      r.hive ??= hiveIndexFor(r.location);
      if (!set.has(cellAt(r.hive, res))) continue;
      if (opts.statuses && !opts.statuses.includes(r.status)) continue;
      out.push(r);
      if (opts.limit && out.length >= opts.limit) break;
    }
    return clone(out);
  }
  async listSpacesInCells(res: number, cells: string[]) {
    const set = new Set(cells);
    return clone(this.state.spaces.filter((s) => set.has(cellAt((s.hive ??= hiveIndexFor(s.location)), res))));
  }
  async incrementCellStat(stat: HiveCellStat) {
    const existing = this.state.cellStats.find((x) => x.cell === stat.cell && x.bucketStart === stat.bucketStart);
    if (existing) {
      existing.reports += stat.reports;
      existing.found += stat.found;
      existing.notFound += stat.notFound;
      existing.expired += stat.expired;
    } else this.state.cellStats.push({ ...stat });
    this.changed();
  }
  async listCellStats(res: number, cells: string[], sinceIso: string) {
    const set = new Set(cells);
    return clone(this.state.cellStats.filter((s) => s.bucketStart >= sinceIso && set.has(parentOf(s.cell, res))));
  }
  async incrementDemand(cellR9: string, bucketStart: string, searches: number, isDemo = false) {
    const existing = this.state.demand.find((d) => d.cell === cellR9 && d.bucketStart === bucketStart);
    if (existing) existing.searches += searches;
    else this.state.demand.push({ cell: cellR9, bucketStart, searches, isDemo });
    this.changed();
  }
  async listDemand(res: number, cells: string[], sinceIso: string) {
    const set = new Set(cells);
    return clone(
      this.state.demand.filter((d) => {
        if (d.bucketStart < sinceIso) return false;
        // demand lives at r9: coarser queries roll up, finer queries match their r9 parent
        return res <= 9 ? set.has(parentOf(d.cell, res)) : cells.some((c) => parentOf(c, 9) === d.cell);
      }),
    );
  }
  async deleteReports(ids: string[]) {
    const set = new Set(ids);
    const before = this.state.reports.length;
    this.state.reports = this.state.reports.filter((r) => !set.has(r.id));
    this.state.claims = this.state.claims.filter((c) => !set.has(c.reportId));
    this.state.confirmations = this.state.confirmations.filter((c) => !set.has(c.reportId));
    const n = before - this.state.reports.length;
    if (n) this.changed();
    return n;
  }
  async deleteClaimsBefore(beforeIso: string) {
    const before = this.state.claims.length;
    this.state.claims = this.state.claims.filter((c) => c.active || c.createdAt >= beforeIso);
    const n = before - this.state.claims.length;
    if (n) this.changed();
    return n;
  }
  async deleteCellStatsBefore(beforeIso: string) {
    const before = this.state.cellStats.length;
    this.state.cellStats = this.state.cellStats.filter((s) => s.bucketStart >= beforeIso);
    const n = before - this.state.cellStats.length;
    if (n) this.changed();
    return n;
  }
  async deleteDemandBefore(beforeIso: string) {
    const before = this.state.demand.length;
    this.state.demand = this.state.demand.filter((d) => d.bucketStart >= beforeIso);
    const n = before - this.state.demand.length;
    if (n) this.changed();
    return n;
  }
  async getHiveConfig() { return clone(this.state.hiveConfig); }
  async setHiveConfig(c: HiveConfig) { this.state.hiveConfig = clone(c); this.changed(); return clone(c); }
  async addFeedback(helpful: boolean) {
    if (helpful) this.state.feedback.helpful++;
    else this.state.feedback.notHelpful++;
    this.changed();
    return clone(this.state.feedback);
  }
  async getFeedback() { return clone(this.state.feedback); }
  async stats() {
    return { reports: this.state.reports.length, spaces: this.state.spaces.length, cellStats: this.state.cellStats.length, demand: this.state.demand.length };
  }

  async runNativeLifecycle() {
    return null; // demo: the application-level job in src/lib/hive/lifecycle.ts runs instead
  }
  async recordJobRun(run: JobRun) {
    this.state.jobRuns.push(clone(run));
    if (this.state.jobRuns.length > 200) this.state.jobRuns = this.state.jobRuns.slice(-200);
    this.changed();
  }
  async listJobRuns(job: string, limit: number) {
    return clone(this.state.jobRuns.filter((r) => r.job === job).slice(-limit).reverse());
  }
  async anonymizeProfile(userId: string) {
    const reportIds = new Set(this.state.reports.filter((r) => r.reporterId === userId && r.status !== "flagged").map((r) => r.id));
    const before = { reports: this.state.reports.length, claims: this.state.claims.length, conf: this.state.confirmations.length };
    this.state.confirmations = this.state.confirmations.filter((c) => c.confirmerId !== userId && !reportIds.has(c.reportId));
    this.state.claims = this.state.claims.filter((c) => c.claimerId !== userId && !reportIds.has(c.reportId));
    this.state.reports = this.state.reports.filter((r) => !reportIds.has(r.id));
    this.state.challengeProgress = this.state.challengeProgress.filter((p) => p.userId !== userId);
    this.state.missions = this.state.missions.filter((m) => m.userId !== userId);
    const p = this.state.profiles.find((x) => x.id === userId);
    if (p) Object.assign(p, { displayName: "Deleted user", displayNameAr: "مستخدم محذوف", locationConsentAt: null, deletedAt: new Date().toISOString() });
    // Access secrets of the user's bookings are revoked; booking events keep only coarse points.
    const mine = new Set(this.state.bookings.filter((b) => b.userId === userId).map((b) => b.id));
    for (const cr of this.state.credentials) if (mine.has(cr.bookingId) && !cr.revokedAt) cr.revokedAt = new Date().toISOString();
    this.changed();
    return { reports_deleted: before.reports - this.state.reports.length, claims_deleted: before.claims - this.state.claims.length, confirmations_deleted: before.conf - this.state.confirmations.length };
  }

  async purgePreciseLocations(beforeIso: string) {
    let n = 0;
    for (const r of this.state.reports) {
      if (r.createdAt < beforeIso && !["pending_departure", "available", "claimed"].includes(r.status)) {
        const c = coarsen(r.location, 2);
        if (c.lat !== r.location.lat || c.lng !== r.location.lng || r.claimLocation) {
          r.location = c;
          r.claimLocation = null;
          // Keep neighborhood-level (r9) grouping only; drop street-level precision from the row.
          if (r.hive) r.hive = { ...r.hive, r10: cellToCenterChild(r.hive.r9, 10) };
          n++;
        }
      }
    }
    for (const c of this.state.confirmations) if (c.createdAt < beforeIso && c.location) { c.location = null; n++; }
    for (const c of this.state.claims) if (c.createdAt < beforeIso && c.claimLocation) { c.claimLocation = null; n++; }
    if (n) this.changed();
    return n;
  }

  // ─── Phase 3 ───────────────────────────────────────────────────────
  async getBooking(id: string) { return clone(this.state.bookings.find((b) => b.id === id) ?? null); }
  async listAvailabilityRules(spaceIds: string[]) {
    const set = new Set(spaceIds);
    return clone(this.state.availabilityRules.filter((r) => set.has(r.spaceId)));
  }
  async replaceAvailabilityRules(spaceId: string, rules: AvailabilityRule[]) {
    this.state.availabilityRules = [...this.state.availabilityRules.filter((r) => r.spaceId !== spaceId), ...clone(rules)];
    this.changed();
    return clone(rules);
  }
  async listAvailabilityExceptions(spaceIds: string[], fromDate?: string) {
    const set = new Set(spaceIds);
    return clone(this.state.availabilityExceptions.filter((e) => set.has(e.spaceId) && (!fromDate || e.exceptionDate >= fromDate)));
  }
  async upsertAvailabilityException(e: AvailabilityException) {
    const i = this.state.availabilityExceptions.findIndex((x) => x.spaceId === e.spaceId && x.exceptionDate === e.exceptionDate);
    const saved = i >= 0 ? { ...clone(e), id: this.state.availabilityExceptions[i].id } : clone(e);
    if (i >= 0) this.state.availabilityExceptions[i] = saved;
    else this.state.availabilityExceptions.push(saved);
    this.changed();
    return clone(saved);
  }
  /** Mirrors insert_booking_checked(jsonb, …): padded-overlap count + insert + credential, no await in between. */
  async insertHomeBooking(b: ParkingBooking, opts: { capacity: number; bufferMinutes: number; credential: AccessCredential | null }) {
    if (this.paddedOverlaps(b.spaceId, b.startAt, b.endAt, opts.bufferMinutes, null) >= opts.capacity) return "capacity_full" as const;
    this.state.bookings.push(clone(b));
    if (opts.credential) this.state.credentials.push(clone(opts.credential));
    this.changed();
    return "ok" as const;
  }
  async extendHomeBooking(id: string, newEndIso: string, patch: Partial<ParkingBooking>, opts: { capacity: number; bufferMinutes: number; credentialValidUntil: string }) {
    const b = this.state.bookings.find((x) => x.id === id);
    if (!b || b.status !== "confirmed") return null;
    // Other confirmed bookings overlapping the extended window (padded) must leave room.
    if (this.paddedOverlaps(b.spaceId, b.startAt, newEndIso, opts.bufferMinutes, id) >= opts.capacity) return null;
    Object.assign(b, patch, { endAt: newEndIso, id });
    const cr = this.state.credentials.find((x) => x.bookingId === id);
    if (cr && !cr.revokedAt) cr.validUntil = opts.credentialValidUntil;
    this.changed();
    return clone(b);
  }
  private paddedOverlaps(spaceId: string, startIso: string, endIso: string, bufferMinutes: number, excludeId: string | null) {
    const pad = bufferMinutes * 60_000;
    const s = Date.parse(startIso);
    const e = Date.parse(endIso);
    return this.state.bookings.filter((x) => x.spaceId === spaceId && x.id !== excludeId && x.status === "confirmed" && s < Date.parse(x.endAt) + pad && Date.parse(x.startAt) < e + pad).length;
  }
  async getCredential(bookingId: string) { return clone(this.state.credentials.find((c) => c.bookingId === bookingId) ?? null); }
  async updateCredential(bookingId: string, patch: Partial<AccessCredential>) {
    const c = this.state.credentials.find((x) => x.bookingId === bookingId);
    if (!c) return;
    Object.assign(c, patch, { bookingId });
    this.changed();
  }
  async insertBookingEvent(e: BookingEvent) { this.state.bookingEvents.push(clone(e)); this.changed(); return clone(e); }
  async listBookingEvents(bookingId: string) {
    return clone(this.state.bookingEvents.filter((e) => e.bookingId === bookingId).sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
  }
  async checkRateLimit(key: string, limit: number, windowSeconds: number, nowIso: string) {
    const windowMs = windowSeconds * 1000;
    const t = Date.parse(nowIso);
    const windowStart = Math.floor(t / windowMs) * windowMs;
    const k = `${key}|${windowStart}`;
    const n = (this.state.rateLimits[k] ?? 0) + 1;
    this.state.rateLimits[k] = n;
    // Garbage-collect expired windows occasionally (bounded memory); not persisted on every call.
    if (Object.keys(this.state.rateLimits).length > 5000) {
      for (const key2 of Object.keys(this.state.rateLimits)) if (Number(key2.slice(key2.lastIndexOf("|") + 1)) < t - 3_600_000) delete this.state.rateLimits[key2];
    }
    return n <= limit;
  }
  async getPlatformSettings() { return clone(this.state.platformSettings); }
  async setPlatformSettings(s: PlatformSettings) {
    this.state.platformSettings = clone(s);
    for (const sp of this.state.spaces) if (sp.spaceCategory?.startsWith("villa_")) sp.waitlistOnly = !s.villaBookingsEnabled;
    this.changed();
    return clone(s);
  }
  async viewportBundle(q: ViewportQuery): Promise<ViewportBundle> {
    const [reports, spaces, cellStats, demand] = await Promise.all([
      q.reportCells.length ? this.listReportsInCells(q.reportRes, q.reportCells, { statuses: q.reportStatuses, limit: q.reportLimit }) : [],
      q.spaceCells.length ? this.listSpacesInCells(q.spaceRes, q.spaceCells) : [],
      q.statCells.length ? this.listCellStats(q.statRes, q.statCells, q.sinceIso) : [],
      q.statCells.length ? this.listDemand(q.statRes, q.statCells, q.sinceIso) : [],
    ]);
    return { reports, spaces, cellStats, demand };
  }
  async listPage<K extends PageEntity>(entity: K, opts: { limit: number; cursor?: string | null }): Promise<Page<PageItem<K>>> {
    const src = (entity === "profiles" ? this.state.profiles : entity === "partners" ? this.state.partners : entity === "spaces" ? this.state.spaces : this.state.bookings) as unknown as PageItem<K>[];
    const page = pageOf(src as unknown as { createdAt: string; id: string }[], Math.max(1, Math.min(200, opts.limit)), opts.cursor);
    return clone(page) as unknown as Page<PageItem<K>>;
  }
}