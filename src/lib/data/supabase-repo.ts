import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type {
  AccessCredential,
  AuditLog,
  AvailabilityException,
  AvailabilityRule,
  BookingEvent,
  FareBreakdown,
  ChallengeProgress,
  DepartureReport,
  FraudFlag,
  HiveCellStat,
  HiveConfig,
  HiveDemandBucket,
  HiveFeedback,
  HiveIndex,
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
import { DEFAULT_PLATFORM_SETTINGS, DEFAULT_RULES, type PlatformSettings } from "../config";
import { DEFAULT_HIVE_CONFIG } from "../hive/config";
import { parentOf } from "../hive/cells";

/** Max H3 ids per PostgREST `in.(…)` filter (~1.8 KB of URL per chunk). */
const IN_CHUNK = 100;

const parentsOf = (r10: string) => ({ r7: parentOf(r10, 7), r8: parentOf(r10, 8), r9: parentOf(r10, 9) });
import { decodeCursor, encodeCursor, type JobRun, type Page, type PageEntity, type PageItem, type Repo, type ReportExpectation, type ViewportBundle, type ViewportQuery } from "./repo";
import { DomainError } from "../domain/errors";

/**
 * Supabase / PostgreSQL adapter (RAKNA_DATA_MODE=supabase).
 *
 * Runs ONLY on the server with the service-role key, behind the API routes that
 * authenticate the caller and authorize the action. Row Level Security still
 * protects every table for direct client access (see supabase/migrations/0002_rls.sql).
 *
 * Atomicity: point balances are protected in the database itself —
 * `points_ledger.idempotency_key` is UNIQUE and `insert_ledger_entry()` locks the
 * user's ledger and refuses negative balances. State changes on reports use
 * compare-and-set UPDATEs (`transitionReport`); see `withLock` below.
 *
 * STATUS: the SQL it calls (migrations 0001–0006, RPC functions, RLS) is verified on
 * PostgreSQL 18 + PostGIS (tests/db). This adapter's PostgREST calls have NOT been run
 * against a live Supabase project (no credentials). Verify with docs/STAGING.md §9.
 */

type Row = Record<string, unknown>;

/** Minimal structural view of the PostgREST filter builder used by this adapter. */
interface Query extends PromiseLike<{ data: Row[] | null; error: unknown }> {
  eq(column: string, value: unknown): Query;
  gte(column: string, value: unknown): Query;
  in(column: string, values: unknown[]): Query;
}

const LATLNG_FIELDS = new Set(["location", "claimLocation", "publicLocation"]);
/** Column prefix per lat/lng field (publicLocation is stored as public_lat / public_lng — 0007). */
const LATLNG_PREFIX: Record<string, string> = { location: "location", claimLocation: "claim_location", publicLocation: "public" };
const LATLNG_FROM_PREFIX: Record<string, string> = { location: "location", claim_location: "claimLocation", public: "publicLocation" };

/** FareBreakdown is stored as flat integer-halalas columns on parking_bookings (0007). */
const FARE_COLUMNS: (keyof FareBreakdown)[] = ["baseFareHalalas", "driverFeeHalalas", "hostCommissionHalalas", "vatOnPlatformFeeHalalas", "keysDiscountHalalas", "hostNetPayoutHalalas", "driverTotalHalalas"];

const snake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

function toRow(obj: object): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    if (k === "fare") {
      const f = v as FareBreakdown | null;
      for (const col of FARE_COLUMNS) out[snake(col)] = f ? f[col] : null;
      continue;
    }
    if (k === "hive") {
      const h = v as HiveIndex | null;
      out.h3_r7 = h?.r7 ?? null;
      out.h3_r8 = h?.r8 ?? null;
      out.h3_r9 = h?.r9 ?? null;
      out.h3_r10 = h?.r10 ?? null;
      continue;
    }
    if (LATLNG_FIELDS.has(k)) {
      const p = v as { lat: number; lng: number } | null;
      out[`${LATLNG_PREFIX[k]}_lat`] = p ? p.lat : null;
      out[`${LATLNG_PREFIX[k]}_lng`] = p ? p.lng : null;
    } else {
      out[snake(k)] = v;
    }
  }
  return out;
}

function fromRow<T>(row: Row): T {
  const out: Row = {};
  if (typeof row.h3_r10 === "string") {
    out.hive = { r7: row.h3_r7, r8: row.h3_r8, r9: row.h3_r9, r10: row.h3_r10 };
  }
  for (const [k, v] of Object.entries(row)) {
    if (/^h3_r\d+$/.test(k) || k === "geog") continue;
    const m = k.match(/^(.*)_(lat|lng)$/);
    if (m && LATLNG_FROM_PREFIX[m[1]]) {
      const key = LATLNG_FROM_PREFIX[m[1]];
      const lat = row[`${m[1]}_lat`] as number | null;
      const lng = row[`${m[1]}_lng`] as number | null;
      out[key] = lat === null || lng === null ? null : { lat: Number(lat), lng: Number(lng) };
      continue;
    }
    out[camel(k)] = typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v) && /price|amount|total|discount/.test(k) ? Number(v) : v;
  }
  if ("baseFareHalalas" in out) {
    if (out.baseFareHalalas !== null && out.baseFareHalalas !== undefined) {
      const fare = {} as Record<string, number>;
      for (const col of FARE_COLUMNS) fare[col] = Number(out[col]);
      out.fare = fare;
    }
    for (const col of FARE_COLUMNS) delete out[col];
  }
  return out as T;
}

export class SupabaseRepo implements Repo {
  readonly kind = "supabase" as const;
  private db: SupabaseClient;

  constructor() {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error("Supabase env vars missing");
    this.db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  }

  private async one<T>(table: string, id: string): Promise<T | null> {
    const { data, error } = await this.db.from(table).select("*").eq("id", id).maybeSingle();
    if (error) throw error;
    return data ? fromRow<T>(data) : null;
  }
  private async insert<T>(table: string, obj: object): Promise<T> {
    const { data, error } = await this.db.from(table).insert(toRow(obj)).select("*").single();
    if (error) throw error;
    return fromRow<T>(data);
  }
  private async update<T>(table: string, id: string, patch: object): Promise<T> {
    const row = toRow(patch);
    delete row.id;
    const { data, error } = await this.db.from(table).update(row).eq("id", id).select("*").single();
    if (error) throw error;
    return fromRow<T>(data);
  }
  private async list<T>(table: string, apply: (q: Query) => unknown = (q) => q): Promise<T[]> {
    const q = apply(this.db.from(table).select("*") as unknown as Query) as Query;
    const { data, error } = await q;
    if (error) throw error;
    return (data ?? []).map((r) => fromRow<T>(r));
  }

  /**
   * No cross-request lock is taken here (AUDIT F-CONC-4: the previous advisory "lock"
   * was transaction-scoped to a single RPC and therefore protected nothing). Correctness
   * comes from database-level atomicity instead:
   *   • transitionReport → one conditional UPDATE (compare-and-set) per state change
   *   • insert_ledger_entry → per-user advisory lock + UNIQUE idempotency key + cap
   *   • reward_stock_adjust / insert_booking_checked → atomic SQL functions
   *   • partial unique indexes (one live report per driver, one active claim per report
   *     and per driver, one accepted confirmation per report) as backstops
   */
  async withLock<T>(_key: string, fn: () => Promise<T>): Promise<T> {
    return fn();
  }

  async transitionReport(id: string, expect: ReportExpectation, patch: Partial<DepartureReport>) {
    const row = toRow(patch);
    delete row.id;
    let q = this.db.from("departure_reports").update(row).eq("id", id).in("status", expect.statuses);
    if (expect.claimedBy === null) q = q.is("claimed_by", null);
    else if (expect.claimedBy !== undefined) q = q.eq("claimed_by", expect.claimedBy);
    if (expect.expiresAfterIso) q = q.gt("expires_at", expect.expiresAfterIso);
    if (expect.expiresAtOrBeforeIso) q = q.lte("expires_at", expect.expiresAtOrBeforeIso);
    const { data, error } = await q.select("*");
    if (error) throw error;
    return data && data.length === 1 ? fromRow<DepartureReport>(data[0]) : null;
  }

  getProfile(id: string) { return this.one<Profile>("profiles", id); }
  listProfiles() { return this.list<Profile>("profiles"); }
  updateProfile(id: string, patch: Partial<Profile>) { return this.update<Profile>("profiles", id, patch); }

  insertReport(r: DepartureReport) { return this.insert<DepartureReport>("departure_reports", r); }
  getReport(id: string) { return this.one<DepartureReport>("departure_reports", id); }
  updateReport(id: string, patch: Partial<DepartureReport>) { return this.update<DepartureReport>("departure_reports", id, patch); }
  listReports(filter: { reporterId?: string; reporterIds?: string[]; sinceIso?: string } = {}) {
    if (filter.reporterIds) {
      return this.chunked<DepartureReport>(filter.reporterIds, (chunk) => {
        let q = this.db.from("departure_reports").select("*").in("reporter_id", chunk);
        if (filter.sinceIso) q = q.gte("created_at", filter.sinceIso);
        return q;
      });
    }
    return this.list<DepartureReport>("departure_reports", (q) => {
      let x = q as unknown as { eq: (c: string, v: unknown) => typeof x; gte: (c: string, v: unknown) => typeof x };
      if (filter.reporterId) x = x.eq("reporter_id", filter.reporterId);
      if (filter.sinceIso) x = x.gte("created_at", filter.sinceIso);
      return x;
    });
  }

  insertClaim(c: ReportClaim) { return this.insert<ReportClaim>("report_claims", c); }
  async updateClaims(filter: { reportId?: string; claimerId?: string; active?: boolean }, patch: Partial<ReportClaim>) {
    let q = this.db.from("report_claims").update(toRow(patch));
    if (filter.reportId) q = q.eq("report_id", filter.reportId);
    if (filter.claimerId) q = q.eq("claimer_id", filter.claimerId);
    if (filter.active !== undefined) q = q.eq("active", filter.active);
    const { error } = await q;
    if (error) throw error;
  }
  listClaims(filter: { reportId?: string; claimerId?: string }) {
    return this.list<ReportClaim>("report_claims", (q) => {
      let x = q as unknown as { eq: (c: string, v: unknown) => typeof x };
      if (filter.reportId) x = x.eq("report_id", filter.reportId);
      if (filter.claimerId) x = x.eq("claimer_id", filter.claimerId);
      return x;
    });
  }

  insertConfirmation(c: ReportConfirmation) { return this.insert<ReportConfirmation>("report_confirmations", c); }
  listConfirmations(filter: { reportId?: string; confirmerId?: string; sinceIso?: string }) {
    return this.list<ReportConfirmation>("report_confirmations", (q) => {
      let x = q as unknown as { eq: (c: string, v: unknown) => typeof x; gte: (c: string, v: unknown) => typeof x };
      if (filter.reportId) x = x.eq("report_id", filter.reportId);
      if (filter.confirmerId) x = x.eq("confirmer_id", filter.confirmerId);
      if (filter.sinceIso) x = x.gte("created_at", filter.sinceIso);
      return x;
    });
  }

  async insertLedger(e: LedgerEntry, cap?: { limit: number; sinceIso: string }) {
    // Atomic in Postgres: per-user advisory lock + unique key + non-negative check + daily cap (0005).
    const { data, error } = await this.db.rpc("insert_ledger_entry", {
      p_id: e.id, p_user_id: e.userId, p_amount: e.amount, p_type: e.type, p_reason: e.reason,
      p_idempotency_key: e.idempotencyKey, p_ref_type: e.refType, p_ref_id: e.refId,
      p_cap_limit: cap?.limit ?? null, p_cap_since: cap?.sinceIso ?? null,
    });
    if (error) {
      if ((error as { message?: string }).message?.includes("insufficient_balance")) throw new DomainError("insufficient_balance", "Not enough RAKNA KEYS");
      throw error;
    }
    const row = (Array.isArray(data) ? data[0] : data) as (Row & { inserted: boolean }) | undefined;
    if (!row) return { inserted: false, entry: null }; // capped to zero
    return { inserted: Boolean(row.inserted), entry: fromRow<LedgerEntry>(row) };
  }
  async listLedger(filter: { userId?: string; sinceIso?: string; limit?: number } = {}) {
    let q = this.db.from("points_ledger").select("*");
    if (filter.userId) q = q.eq("user_id", filter.userId);
    if (filter.sinceIso) q = q.gte("created_at", filter.sinceIso);
    if (filter.limit) q = q.order("created_at", { ascending: false }).limit(filter.limit);
    const { data, error } = await q;
    if (error) throw error;
    return (data ?? []).map((r) => fromRow<LedgerEntry>(r));
  }
  async ledgerTotals() {
    const { data, error } = await this.db.rpc("ledger_totals");
    if (error) throw error;
    const d = (data ?? {}) as Record<string, number>;
    return { earned: Number(d.earned ?? 0), spent: Number(d.spent ?? 0), refunded: Number(d.refunded ?? 0), outstanding: Number(d.outstanding ?? 0) };
  }
  async findLedgerByKey(key: string) {
    const { data, error } = await this.db.from("points_ledger").select("*").eq("idempotency_key", key).maybeSingle();
    if (error) throw error;
    return data ? fromRow<LedgerEntry>(data) : null;
  }

  listRewards() { return this.list<RewardItem>("rewards_catalog"); }
  getReward(id: string) { return this.one<RewardItem>("rewards_catalog", id); }
  async upsertReward(r: RewardItem) {
    const { data, error } = await this.db.from("rewards_catalog").upsert(toRow(r)).select("*").single();
    if (error) throw error;
    return fromRow<RewardItem>(data);
  }
  async adjustRewardStock(id: string, delta: number) {
    const { data, error } = await this.db.rpc("reward_stock_adjust", { p_reward_id: id, p_delta: delta });
    if (error) throw error;
    return Boolean(data);
  }
  insertRedemption(r: RewardRedemption) { return this.insert<RewardRedemption>("reward_redemptions", r); }
  updateRedemption(id: string, patch: Partial<RewardRedemption>) { return this.update<RewardRedemption>("reward_redemptions", id, patch); }
  getRedemption(id: string) { return this.one<RewardRedemption>("reward_redemptions", id); }
  listRedemptions(filter: { userId?: string; status?: RewardRedemption["status"] } = {}) {
    return this.list<RewardRedemption>("reward_redemptions", (q) => {
      let x = q as unknown as { eq: (c: string, v: unknown) => typeof x };
      if (filter.userId) x = x.eq("user_id", filter.userId);
      if (filter.status) x = x.eq("status", filter.status);
      return x;
    });
  }

  listPartners() { return this.list<ParkingPartner>("parking_partners"); }
  getPartner(id: string) { return this.one<ParkingPartner>("parking_partners", id); }
  insertPartner(p: ParkingPartner) { return this.insert<ParkingPartner>("parking_partners", p); }
  updatePartner(id: string, patch: Partial<ParkingPartner>) { return this.update<ParkingPartner>("parking_partners", id, patch); }
  listSpaces(filter: { partnerId?: string } = {}) {
    return this.list<ParkingSpace>("parking_spaces", (q) => {
      const x = q as unknown as { eq: (c: string, v: unknown) => unknown };
      return filter.partnerId ? x.eq("partner_id", filter.partnerId) : x;
    });
  }
  getSpace(id: string) { return this.one<ParkingSpace>("parking_spaces", id); }
  insertSpace(s: ParkingSpace) { return this.insert<ParkingSpace>("parking_spaces", s); }
  updateSpace(id: string, patch: Partial<ParkingSpace>) { return this.update<ParkingSpace>("parking_spaces", id, patch); }
  insertBooking(b: ParkingBooking) { return this.insert<ParkingBooking>("parking_bookings", b); }
  async insertBookingIfCapacity(b: ParkingBooking, capacity: number) {
    const { data, error } = await this.db.rpc("insert_booking_checked", {
      p_id: b.id, p_space_id: b.spaceId, p_user_id: b.userId, p_start: b.startAt, p_end: b.endAt, p_hours: b.hours,
      p_price: b.priceTotal, p_discount: b.discountApplied, p_redemption_id: b.redemptionId, p_capacity: capacity,
    });
    if (error) throw error;
    return Boolean(data);
  }
  updateBooking(id: string, patch: Partial<ParkingBooking>) { return this.update<ParkingBooking>("parking_bookings", id, patch); }
  listBookings(filter: { userId?: string; spaceId?: string; spaceIds?: string[] } = {}) {
    return this.list<ParkingBooking>("parking_bookings", (q) => {
      let x = q as unknown as { eq: (c: string, v: unknown) => typeof x; in: (c: string, v: unknown[]) => typeof x };
      if (filter.userId) x = x.eq("user_id", filter.userId);
      if (filter.spaceId) x = x.eq("space_id", filter.spaceId);
      if (filter.spaceIds) x = x.in("space_id", filter.spaceIds);
      return x;
    });
  }

  listChallenges() { return this.list<NeighborhoodChallenge>("neighborhood_challenges"); }
  async upsertChallengeProgress(p: ChallengeProgress) {
    const { error } = await this.db.from("challenge_progress").upsert(toRow(p), { onConflict: "challenge_id,user_id" });
    if (error) throw error;
  }
  listChallengeProgress(userId: string) {
    return this.list<ChallengeProgress>("challenge_progress", (q) => (q as unknown as { eq: (c: string, v: unknown) => unknown }).eq("user_id", userId));
  }
  insertMission(m: MobilityMission) { return this.insert<MobilityMission>("mobility_missions", m); }
  updateMission(id: string, patch: Partial<MobilityMission>) { return this.update<MobilityMission>("mobility_missions", id, patch); }
  getMission(id: string) { return this.one<MobilityMission>("mobility_missions", id); }
  listMissions(filter: { userId?: string; status?: MobilityMission["status"] } = {}) {
    return this.list<MobilityMission>("mobility_missions", (q) => {
      let x = q as unknown as { eq: (c: string, v: unknown) => typeof x };
      if (filter.userId) x = x.eq("user_id", filter.userId);
      if (filter.status) x = x.eq("status", filter.status);
      return x;
    });
  }

  insertFraudFlag(f: FraudFlag) { return this.insert<FraudFlag>("fraud_flags", f); }
  updateFraudFlag(id: string, patch: Partial<FraudFlag>) { return this.update<FraudFlag>("fraud_flags", id, patch); }
  listFraudFlags(filter: { status?: FraudFlag["status"]; userId?: string } = {}) {
    return this.list<FraudFlag>("fraud_flags", (q) => {
      let x = q as unknown as { eq: (c: string, v: unknown) => typeof x };
      if (filter.status) x = x.eq("status", filter.status);
      if (filter.userId) x = x.eq("user_id", filter.userId);
      return x;
    });
  }
  async insertAudit(a: AuditLog) { await this.insert<AuditLog>("admin_audit_logs", a); }
  async listAudit(limit = 50) {
    const { data, error } = await this.db.from("admin_audit_logs").select("*").order("created_at", { ascending: false }).limit(limit);
    if (error) throw error;
    return (data ?? []).map((r) => fromRow<AuditLog>(r));
  }

  async getRules(): Promise<RewardRules> {
    const { data, error } = await this.db.from("app_config").select("value").eq("key", "reward_rules").maybeSingle();
    if (error) throw error;
    return { ...DEFAULT_RULES, ...((data?.value as Partial<RewardRules>) ?? {}) };
  }
  async setRules(rules: RewardRules) {
    const { error } = await this.db.from("app_config").upsert({ key: "reward_rules", value: rules });
    if (error) throw error;
    return rules;
  }

  // ─── RAKNA HIVE — indexed equality on denormalized h3_r{res} columns ──
  private col(res: number) {
    if (![7, 8, 9, 10].includes(res)) throw new Error(`Unsupported hive resolution ${res}`);
    return `h3_r${res}`;
  }
  /**
   * PostgREST encodes `.in()` filters in the URL. 400 H3 ids ≈ 7 KB of query string, which
   * can exceed gateway URL limits (audit F-PERF-3), so cell lists are queried in chunks.
   */
  private async chunked<T>(cells: string[], run: (chunk: string[]) => PromiseLike<{ data: unknown[] | null; error: unknown }>): Promise<T[]> {
    const out: T[] = [];
    for (let i = 0; i < cells.length; i += IN_CHUNK) {
      const { data, error } = await run(cells.slice(i, i + IN_CHUNK));
      if (error) throw error;
      for (const r of data ?? []) out.push(fromRow<T>(r as Row));
    }
    return out;
  }
  async listReportsInCells(res: number, cells: string[], opts: { statuses?: DepartureReport["status"][]; limit?: number } = {}) {
    const rows = await this.chunked<DepartureReport>(cells, (chunk) => {
      let q = this.db.from("departure_reports").select("*").in(this.col(res), chunk);
      if (opts.statuses) q = q.in("status", opts.statuses);
      if (opts.limit) q = q.limit(opts.limit);
      return q;
    });
    return opts.limit ? rows.slice(0, opts.limit) : rows;
  }
  listSpacesInCells(res: number, cells: string[]) {
    return this.chunked<ParkingSpace>(cells, (chunk) => this.db.from("parking_spaces").select("*").in(this.col(res), chunk));
  }
  async incrementCellStat(stat: HiveCellStat) {
    // Parent columns (h3_r7…r9) are derived in SQL from the r10 cell by the caller-supplied ids.
    const p = parentsOf(stat.cell);
    const { error } = await this.db.rpc("hive_increment_cell_stat", {
      p_r7: p.r7, p_r8: p.r8, p_r9: p.r9,
      p_cell: stat.cell, p_bucket: stat.bucketStart, p_reports: stat.reports, p_found: stat.found, p_not_found: stat.notFound, p_expired: stat.expired, p_is_demo: stat.isDemo,
    });
    if (error) throw error;
  }
  listCellStats(res: number, cells: string[], sinceIso: string) {
    return this.chunked<HiveCellStat>(cells, (chunk) =>
      this.db.from("hive_cell_stats").select("cell:h3_r10, bucket_start, reports, found, not_found, expired, is_demo").in(this.col(res), chunk).gte("bucket_start", sinceIso),
    );
  }
  async incrementDemand(cellR9: string, bucketStart: string, searches: number, isDemo = false) {
    const { error } = await this.db.rpc("hive_increment_demand", {
      p_cell_r9: cellR9, p_bucket: bucketStart, p_searches: searches, p_is_demo: isDemo, p_r8: parentOf(cellR9, 8), p_r7: parentOf(cellR9, 7),
    });
    if (error) throw error;
  }
  async listDemand(res: number, cells: string[], sinceIso: string) {
    if (cells.length === 0) return [];
    const column = res >= 9 ? "h3_r9" : this.col(res);
    const target = res > 9 ? [...new Set(cells.map((c) => parentOf(c, 9)))] : cells; // demand is stored at r9
    return this.chunked<HiveDemandBucket>(target, (chunk) =>
      this.db.from("hive_demand_buckets").select("cell:h3_r9, bucket_start, searches, is_demo").in(column, chunk).gte("bucket_start", sinceIso),
    );
  }
  private async countDelete(table: string, build: (q: ReturnType<ReturnType<SupabaseClient["from"]>["delete"]>) => unknown): Promise<number> {
    const q = build(this.db.from(table).delete({ count: "exact" })) as PromiseLike<{ count: number | null; error: unknown }>;
    const { count, error } = await q;
    if (error) throw error;
    return count ?? 0;
  }
  deleteReports(ids: string[]) { return ids.length ? this.countDelete("departure_reports", (q) => q.in("id", ids)) : Promise.resolve(0); }
  deleteClaimsBefore(beforeIso: string) { return this.countDelete("report_claims", (q) => q.eq("active", false).lt("created_at", beforeIso)); }
  deleteCellStatsBefore(beforeIso: string) { return this.countDelete("hive_cell_stats", (q) => q.lt("bucket_start", beforeIso)); }
  deleteDemandBefore(beforeIso: string) { return this.countDelete("hive_demand_buckets", (q) => q.lt("bucket_start", beforeIso)); }
  async getHiveConfig(): Promise<HiveConfig> {
    const { data, error } = await this.db.from("app_config").select("value").eq("key", "hive_config").maybeSingle();
    if (error) throw error;
    const v = (data?.value as Partial<HiveConfig>) ?? {};
    return { ...DEFAULT_HIVE_CONFIG, ...v, states: { ...DEFAULT_HIVE_CONFIG.states, ...(v.states ?? {}) } };
  }
  async setHiveConfig(c: HiveConfig) {
    const { error } = await this.db.from("app_config").upsert({ key: "hive_config", value: c });
    if (error) throw error;
    return c;
  }
  async addFeedback(helpful: boolean): Promise<HiveFeedback> {
    const { data, error } = await this.db.rpc("hive_add_feedback", { p_helpful: helpful });
    if (error) throw error;
    return (data as HiveFeedback) ?? { helpful: 0, notHelpful: 0 };
  }
  async getFeedback(): Promise<HiveFeedback> {
    const { data, error } = await this.db.from("app_config").select("value").eq("key", "hive_feedback").maybeSingle();
    if (error) throw error;
    return (data?.value as HiveFeedback) ?? { helpful: 0, notHelpful: 0 };
  }
  async stats() {
    const count = async (t: string) => (await this.db.from(t).select("*", { count: "exact", head: true })).count ?? 0;
    const [reports, spaces, cellStats, demand] = await Promise.all([count("departure_reports"), count("parking_spaces"), count("hive_cell_stats"), count("hive_demand_buckets")]);
    return { reports, spaces, cellStats, demand };
  }

  async runNativeLifecycle() {
    const { data, error } = await this.db.rpc("rakna_hive_lifecycle");
    if (error) throw error;
    return (data ?? {}) as Record<string, unknown>;
  }
  async recordJobRun(run: JobRun) {
    // In Supabase mode runs are logged by rakna_hive_lifecycle() itself (hive_job_runs).
    void run;
  }
  async listJobRuns(job: string, limit: number): Promise<JobRun[]> {
    const { data, error } = await this.db.from("hive_job_runs").select("*").eq("job", job).order("started_at", { ascending: false }).limit(limit);
    if (error) throw error;
    return (data ?? []).map((r) => fromRow<JobRun>(r as Row));
  }
  async anonymizeProfile(userId: string) {
    const { data, error } = await this.db.rpc("anonymize_profile", { p_user_id: userId });
    if (error) throw error;
    // Blocker B6: soft-delete the GoTrue identity (shouldSoftDelete=true keeps the auth row so
    // profile/ledger foreign keys stay intact, but the user can no longer sign in).
    const del = await this.db.auth.admin.deleteUser(userId, true);
    const result = { ...((data ?? {}) as Record<string, number>), auth_identity_soft_deleted: del.error ? 0 : 1 };
    if (del.error) console.error("[rakna] auth soft-delete failed; finish manually in the Supabase dashboard", { status: del.error.status });
    return result;
  }

  async purgePreciseLocations(beforeIso: string) {
    const { data, error } = await this.db.rpc("purge_precise_locations", { p_before: beforeIso });
    if (error) throw error;
    return Number(data ?? 0);
  }

  // ─── Phase 3 ───────────────────────────────────────────────────────
  getBooking(id: string) { return this.one<ParkingBooking>("parking_bookings", id); }
  listAvailabilityRules(spaceIds: string[]) {
    if (spaceIds.length === 0) return Promise.resolve([] as AvailabilityRule[]);
    return this.chunked<AvailabilityRule>(spaceIds, (chunk) => this.db.from("space_availability_rules").select("*").in("space_id", chunk));
  }
  async replaceAvailabilityRules(spaceId: string, rules: AvailabilityRule[]) {
    // One transaction in SQL: delete + insert, so a space is never left without rules mid-edit.
    const { data, error } = await this.db.rpc("replace_availability_rules", { p_space_id: spaceId, p_rules: rules.map((r) => toRow(r)) });
    if (error) throw error;
    return ((data ?? []) as Row[]).map((r) => fromRow<AvailabilityRule>(r));
  }
  listAvailabilityExceptions(spaceIds: string[], fromDate?: string) {
    if (spaceIds.length === 0) return Promise.resolve([] as AvailabilityException[]);
    return this.chunked<AvailabilityException>(spaceIds, (chunk) => {
      let q = this.db.from("space_availability_exceptions").select("*").in("space_id", chunk);
      if (fromDate) q = q.gte("exception_date", fromDate);
      return q;
    });
  }
  async upsertAvailabilityException(e: AvailabilityException) {
    const row = toRow(e);
    delete row.id; // keep the existing row id on conflict
    const { data, error } = await this.db.from("space_availability_exceptions").upsert(row, { onConflict: "space_id,exception_date" }).select("*").single();
    if (error) throw error;
    return fromRow<AvailabilityException>(data);
  }
  async insertHomeBooking(b: ParkingBooking, opts: { capacity: number; bufferMinutes: number; credential: AccessCredential | null }) {
    // jsonb overload of insert_booking_checked (0007); PostgREST resolves it by argument names.
    const { data, error } = await this.db.rpc("insert_booking_checked", {
      p_booking: toRow(b), p_capacity: opts.capacity, p_buffer_minutes: opts.bufferMinutes, p_credential: opts.credential ? toRow(opts.credential) : null,
    });
    if (error) {
      const msg = String((error as { message?: string }).message ?? "");
      if (msg.includes("space_not_bookable")) throw new DomainError("space_not_bookable");
      if (msg.includes("cannot_book_own_space")) throw new DomainError("forbidden", "You can't book your own space");
      throw error;
    }
    return data === "ok" ? ("ok" as const) : ("capacity_full" as const);
  }
  async extendHomeBooking(id: string, newEndIso: string, patch: Partial<ParkingBooking>, opts: { capacity: number; bufferMinutes: number; credentialValidUntil: string }) {
    const { data, error } = await this.db.rpc("extend_booking_checked", {
      p_id: id, p_new_end: newEndIso, p_patch: toRow(patch), p_capacity: opts.capacity, p_buffer_minutes: opts.bufferMinutes, p_credential_valid_until: opts.credentialValidUntil,
    });
    if (error) throw error;
    return data ? fromRow<ParkingBooking>(data as Row) : null;
  }
  async getCredential(bookingId: string) {
    const { data, error } = await this.db.from("booking_access_credentials").select("*").eq("booking_id", bookingId).maybeSingle();
    if (error) throw error;
    return data ? fromRow<AccessCredential>(data) : null;
  }
  async updateCredential(bookingId: string, patch: Partial<AccessCredential>) {
    const row = toRow(patch);
    delete row.booking_id;
    const { error } = await this.db.from("booking_access_credentials").update(row).eq("booking_id", bookingId);
    if (error) throw error;
  }
  insertBookingEvent(e: BookingEvent) { return this.insert<BookingEvent>("booking_events", e); }
  async listBookingEvents(bookingId: string) {
    const { data, error } = await this.db.from("booking_events").select("*").eq("booking_id", bookingId).order("created_at", { ascending: true });
    if (error) throw error;
    return (data ?? []).map((r) => fromRow<BookingEvent>(r));
  }
  async checkRateLimit(key: string, limit: number, windowSeconds: number, nowIso: string) {
    const { data, error } = await this.db.rpc("check_rate_limit", { p_key: key, p_limit: limit, p_window_seconds: windowSeconds, p_now: nowIso });
    if (error) throw error;
    return Boolean(data);
  }
  async getPlatformSettings(): Promise<PlatformSettings> {
    const { data, error } = await this.db.from("app_config").select("value").eq("key", "platform_settings").maybeSingle();
    if (error) throw error;
    return { ...DEFAULT_PLATFORM_SETTINGS, ...((data?.value as Partial<PlatformSettings>) ?? {}) };
  }
  async setPlatformSettings(s: PlatformSettings) {
    // Also flips waitlist_only on villa spaces in the same transaction.
    const { error } = await this.db.rpc("set_platform_settings", { p_value: s });
    if (error) throw error;
    return s;
  }
  async viewportBundle(q: ViewportQuery): Promise<ViewportBundle> {
    const { data, error } = await this.db.rpc("hive_viewport", {
      p_report_res: q.reportRes, p_report_cells: q.reportCells, p_statuses: q.reportStatuses, p_report_limit: q.reportLimit,
      p_space_res: q.spaceRes, p_space_cells: q.spaceCells, p_stat_res: q.statRes, p_stat_cells: q.statCells, p_since: q.sinceIso,
      // Demand is stored at r9: finer viewports query their r9 parents (no h3-pg in the database).
      p_demand_cells: q.statRes > 9 ? [...new Set(q.statCells.map((c) => parentOf(c, 9)))] : q.statCells,
    });
    if (error) throw error;
    const d = (data ?? {}) as { reports?: Row[]; spaces?: Row[]; cell_stats?: Row[]; demand?: Row[] };
    return {
      reports: (d.reports ?? []).map((r) => fromRow<DepartureReport>(r)),
      spaces: (d.spaces ?? []).map((r) => fromRow<ParkingSpace>(r)),
      cellStats: (d.cell_stats ?? []).map((r) => fromRow<HiveCellStat>(r)),
      demand: (d.demand ?? []).map((r) => fromRow<HiveDemandBucket>(r)),
    };
  }
  async listPage<K extends PageEntity>(entity: K, opts: { limit: number; cursor?: string | null }): Promise<Page<PageItem<K>>> {
    const table = { profiles: "profiles", partners: "parking_partners", spaces: "parking_spaces", bookings: "parking_bookings" }[entity];
    const limit = Math.max(1, Math.min(200, opts.limit));
    let q = this.db.from(table).select("*").order("created_at", { ascending: false }).order("id", { ascending: false }).limit(limit + 1);
    const c = decodeCursor(opts.cursor);
    if (c) q = q.or(`created_at.lt."${c.createdAt}",and(created_at.eq."${c.createdAt}",id.lt.${c.id})`);
    const { data, error } = await q;
    if (error) throw error;
    const rows = (data ?? []).map((r) => fromRow<PageItem<K>>(r as Row));
    const items = rows.slice(0, limit);
    const last = items[items.length - 1] as unknown as { createdAt: string; id: string } | undefined;
    return { items, nextCursor: rows.length > limit && last ? encodeCursor(last) : null };
  }
}