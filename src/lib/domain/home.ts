import type {
  AccessCredential,
  AccessMode,
  AvailabilityException,
  AvailabilityRule,
  BookingEvent,
  BookingEventType,
  CredentialType,
  EntitlementType,
  LatLng,
  ParkingBooking,
  ParkingPartner,
  ParkingSpace,
  PaymentStatus,
  ShadeTier,
  SpaceCategory,
  WeeklySchedule,
} from "../types";
import { RESIDENTIAL_CATEGORIES, VILLA_CATEGORIES } from "../types";
import { DEFAULT_PLATFORM_SETTINGS, DEMO_METRO_STATIONS, HOME_FEES, type PlatformSettings } from "../config";
import { distanceM, inRiyadh, isValidLatLng, nearestNeighborhood } from "../geo";
import { cellCenter, hiveIndexFor } from "../hive/cells";
import { DomainError } from "./errors";
import { iso, newId, type DomainContext } from "./context";
import { refundPoints, spendPoints } from "./ledger";
import { isRewardEligibleForSpace } from "./rewards";
import {
  ALLOWED_ENTITLEMENTS,
  baseFare,
  checkCoverage,
  collidesWithBuffer,
  computeFare,
  daysFromMask,
  illustrativeMonthlyNetHalalas,
  keysDiscountForReward,
  overstaySurcharge,
  validateRule,
  withinGeofence,
} from "./home-schedule";

/**
 * RAKNA HOME (villa carports & authorized building bays), RAKNA PARTNERS schedule spaces and
 * PARK & CONNECT. Bookings on spaces with weekly availability rules use THIS path (integer
 * halalas, turnaround buffers, access credentials). The legacy commercial path in
 * marketplace.ts (createBooking, SAR prices) is unchanged.
 *
 * Privacy invariants (server-side):
 *  • A residential space's exact coordinates, street address and access credential are
 *    returned ONLY to the driver of a confirmed booking whose payment is paid/simulated,
 *    from 30 minutes before the start (getBookingAccess). Everyone else sees publicLocation
 *    — the center of the space's r9 hexagon (~150 m) — and no address.
 *  • Title deeds / Ejar contracts are never stored: only the entitlement TYPE and the host's
 *    attestations. Document review happens out-of-band by an administrator.
 */

// ─── Regulatory gates (pure, unit-tested) ─────────────────────────────────

export { ALLOWED_ENTITLEMENTS };

export function isVilla(category: SpaceCategory | undefined): boolean {
  return category !== undefined && VILLA_CATEGORIES.includes(category);
}

export function isResidential(space: Pick<ParkingSpace, "spaceCategory">): boolean {
  return space.spaceCategory !== undefined && RESIDENTIAL_CATEGORIES.includes(space.spaceCategory);
}

export interface ListingGateInput {
  spaceCategory: SpaceCategory;
  entitlementType: EntitlementType;
  landlordConsentConfirmed?: boolean;
  noSubletClauseConfirmed?: boolean;
}

/** Throws a DomainError when the category/entitlement combination is not permitted. Returns the waitlist state. */
export function checkListingGates(input: ListingGateInput, settings: PlatformSettings): { waitlistOnly: boolean } {
  const allowed = ALLOWED_ENTITLEMENTS[input.spaceCategory];
  if (!allowed) throw new DomainError("validation", "Unknown space category");
  if (!allowed.includes(input.entitlementType)) {
    throw new DomainError("entitlement_invalid", `${input.entitlementType} cannot list a ${input.spaceCategory} space`, { allowed });
  }
  if (input.entitlementType === "ejar_authorized" && input.landlordConsentConfirmed !== true) {
    throw new DomainError("entitlement_invalid", "Tenants must confirm written landlord consent to sub-let the parking space", { requires: "landlordConsentConfirmed" });
  }
  if (input.entitlementType === "ejar_authorized" && input.noSubletClauseConfirmed !== true) {
    throw new DomainError("entitlement_invalid", "Tenants must confirm the Ejar contract does not prohibit sub-letting", { requires: "noSubletClauseConfirmed" });
  }
  return { waitlistOnly: isVilla(input.spaceCategory) && !settings.villaBookingsEnabled };
}

/** Effective waitlist state: villas follow the live municipal-sandbox switch. */
export function isWaitlisted(space: Pick<ParkingSpace, "spaceCategory" | "waitlistOnly">, settings: PlatformSettings): boolean {
  if (isVilla(space.spaceCategory)) return !settings.villaBookingsEnabled;
  return space.waitlistOnly === true;
}

/** Legacy rows (before Phase 3) have no verificationStatus and were verified by migration 0007. */
export function isVerified(space: Pick<ParkingSpace, "verificationStatus">): boolean {
  return space.verificationStatus === undefined || space.verificationStatus === "verified";
}

/** Public, privacy-preserving point for a space: the r9 center (~150 m) for residential, exact for commercial. */
export function publicPointFor(location: LatLng, category: SpaceCategory | undefined): LatLng {
  if (category === undefined || category === "commercial") return location;
  return cellCenter(hiveIndexFor(location).r9);
}

/**
 * Strip private fields before a space leaves the server. Commercial spaces are businesses
 * (exact address is public); residential spaces expose only the ~150 m privacy point.
 */
export function toPublicSpace(space: ParkingSpace, viewer?: { id: string; role: string } | null): ParkingSpace {
  if (!isResidential(space)) return space;
  if (viewer && (viewer.role === "admin" || viewer.id === space.hostId)) return space;
  const pub = space.publicLocation ?? publicPointFor(space.location, space.spaceCategory);
  return { ...space, location: pub, address: "", addressAr: "", hive: hiveIndexFor(pub), hostId: null };
}

/** Short per-repo cache: isSpaceBookable runs per space on map/recruitment paths. */
const settingsCache = new WeakMap<object, { at: number; value: PlatformSettings }>();
const SETTINGS_TTL_MS = 5_000;

export async function getPlatformSettings(ctx: DomainContext): Promise<PlatformSettings> {
  const hit = settingsCache.get(ctx.repo);
  const t = Date.now();
  if (hit && t - hit.at < SETTINGS_TTL_MS) return hit.value;
  const value = { ...DEFAULT_PLATFORM_SETTINGS, ...(await ctx.repo.getPlatformSettings()) };
  settingsCache.set(ctx.repo, { at: t, value });
  return value;
}

export async function setVillaBookingsEnabled(ctx: DomainContext, adminId: string, enabled: boolean): Promise<PlatformSettings> {
  const admin = await ctx.repo.getProfile(adminId);
  if (admin?.role !== "admin") throw new DomainError("forbidden");
  const current = await getPlatformSettings(ctx);
  const saved = await ctx.repo.setPlatformSettings({ ...current, villaBookingsEnabled: enabled });
  settingsCache.delete(ctx.repo);
  await ctx.repo.insertAudit({ id: newId(), actorId: adminId, action: "platform.villa_bookings", target: "app_config:platform_settings", details: `villaBookingsEnabled: ${current.villaBookingsEnabled} → ${enabled}`, createdAt: iso(ctx.now()) });
  return saved;
}

// ─── Listing (host side) ──────────────────────────────────────────────────

export type RuleInput = Pick<AvailabilityRule, "weekdayMask" | "startMinute" | "endMinute" | "hourlyRateHalalas" | "dailyCapHalalas" | "multiDayDiscountBps">;

export interface HomeListingInput extends ListingGateInput {
  title: string;
  titleAr: string;
  location: LatLng;
  address: string;
  addressAr: string;
  shadeTier: ShadeTier;
  maxHeightCm?: number | null;
  maxWidthCm?: number | null;
  maxLengthCm?: number | null;
  bufferMinutes: number;
  instantBook: boolean;
  accessMode: AccessMode;
  metroStationCode?: string | null;
  conditions: string;
  conditionsAr: string;
  rules: RuleInput[];
}

function validateDims(v: number | null | undefined, label: string) {
  if (v === null || v === undefined) return;
  if (!Number.isInteger(v) || v < 100 || v > 1500) throw new DomainError("validation", `${label} must be 100–1500 cm`);
}

function validateRules(rules: RuleInput[]) {
  if (!Array.isArray(rules) || rules.length < 1 || rules.length > 14) throw new DomainError("validation", "Add 1–14 weekly availability rules");
  for (const r of rules) {
    const err = validateRule(r);
    if (err) throw new DomainError("validation", err);
  }
}

/** Legacy WeeklySchedule mirror (kept for the existing schema column and commercial UI). */
export function scheduleFromRules(rules: RuleInput[]): WeeklySchedule {
  const days = [...new Set(rules.flatMap((r) => daysFromMask(r.weekdayMask)))].sort();
  const open = Math.min(...rules.map((r) => r.startMinute));
  const close = Math.max(...rules.map((r) => r.endMinute));
  return { days, openHour: Math.floor(open / 60), closeHour: Math.min(24, Math.max(Math.floor(open / 60) + 1, Math.ceil(close / 60))) };
}

function makeRules(spaceId: string, rules: RuleInput[], now: Date): AvailabilityRule[] {
  return rules.map((r) => ({ id: newId(), spaceId, ...r, isActive: true, createdAt: iso(now) }));
}

/**
 * The host's residential "partner" record. Every space references a partner (FK), so a
 * residential host gets ONE record of kind "residential" (status approved: entitlement is
 * verified per SPACE by an admin, which is the gate that matters). An existing approved
 * commercial partner account reuses its own record.
 */
async function hostPartnerFor(ctx: DomainContext, userId: string, displayName: string): Promise<ParkingPartner> {
  const mine = (await ctx.repo.listPartners()).filter((p) => p.ownerId === userId && p.status !== "rejected");
  const existing = mine[0];
  if (existing) {
    if (existing.status !== "approved") throw new DomainError("partner_not_approved", "Your partner account is awaiting approval");
    return existing;
  }
  return ctx.repo.insertPartner({
    id: newId(),
    ownerId: userId,
    name: `${displayName} (RAKNA HOME host)`,
    nameAr: `${displayName} (مضيف ركنة هوم)`,
    kind: "residential",
    contactEmail: "",
    crNumberProvided: false,
    status: "approved",
    createdAt: iso(ctx.now()),
    reviewedAt: null,
    isDemo: ctx.allowSimulatedEvidence,
  });
}

export async function submitHomeListing(ctx: DomainContext, userId: string, input: HomeListingInput): Promise<{ space: ParkingSpace; rules: AvailabilityRule[] }> {
  const profile = await ctx.repo.getProfile(userId);
  if (!profile || profile.deletedAt) throw new DomainError("unauthenticated");
  if (profile.role === "admin") throw new DomainError("forbidden", "Administrators cannot list spaces");
  if (!RESIDENTIAL_CATEGORIES.includes(input.spaceCategory)) throw new DomainError("validation", "Use the partner flow for commercial parking");
  const settings = await getPlatformSettings(ctx);
  const { waitlistOnly } = checkListingGates(input, settings);
  if (!isValidLatLng(input.location) || !inRiyadh(input.location)) throw new DomainError("outside_service_area");
  if (!input.title?.trim() || input.title.length > 120) throw new DomainError("validation", "Title is required (≤ 120 characters)");
  if (!Number.isInteger(input.bufferMinutes) || input.bufferMinutes < 0 || input.bufferMinutes > 120) throw new DomainError("validation", "Turnaround buffer must be 0–120 minutes");
  validateDims(input.maxHeightCm, "Max height");
  validateDims(input.maxWidthCm, "Max width");
  validateDims(input.maxLengthCm, "Max length");
  if (input.metroStationCode && !DEMO_METRO_STATIONS.some((m) => m.code === input.metroStationCode)) throw new DomainError("validation", "Unknown Metro station");
  validateRules(input.rules);

  const partner = await hostPartnerFor(ctx, userId, profile.displayName);
  const now = ctx.now();
  const id = newId();
  const space = await ctx.repo.insertSpace({
    id,
    partnerId: partner.id,
    hostId: userId,
    title: input.title.trim(),
    titleAr: input.titleAr?.trim() || input.title.trim(),
    location: input.location,
    publicLocation: publicPointFor(input.location, input.spaceCategory),
    hive: hiveIndexFor(input.location),
    accessibleBays: 0,
    neighborhood: nearestNeighborhood(input.location),
    address: input.address,
    addressAr: input.addressAr || input.address,
    capacity: 1,
    pricePerHour: input.rules[0].hourlyRateHalalas / 100,
    schedule: scheduleFromRules(input.rules),
    conditions: input.conditions,
    conditionsAr: input.conditionsAr || input.conditions,
    rewardEligible: true, // Keys discount the PLATFORM fee only; the host's payout is never reduced
    approval: "pending_review",
    createdAt: iso(now),
    isDemo: ctx.allowSimulatedEvidence,
    spaceCategory: input.spaceCategory,
    entitlementType: input.entitlementType,
    verificationStatus: "pending",
    shadeTier: input.shadeTier,
    maxHeightCm: input.maxHeightCm ?? null,
    maxWidthCm: input.maxWidthCm ?? null,
    maxLengthCm: input.maxLengthCm ?? null,
    bufferMinutes: input.bufferMinutes,
    instantBook: input.instantBook,
    accessMode: input.accessMode,
    metroStationCode: input.metroStationCode ?? null,
    waitlistOnly,
    landlordConsentAt: input.entitlementType === "ejar_authorized" ? iso(now) : null,
  });
  const rules = await ctx.repo.replaceAvailabilityRules(id, makeRules(id, input.rules, now));
  return { space, rules };
}

/** Host or the owning partner may manage a space's schedule. */
export async function canManageSpace(ctx: DomainContext, userId: string, space: ParkingSpace): Promise<boolean> {
  if (space.hostId && space.hostId === userId) return true;
  const partner = await ctx.repo.getPartner(space.partnerId);
  return partner?.ownerId === userId;
}

export async function setAvailabilityRules(ctx: DomainContext, userId: string, spaceId: string, rules: RuleInput[]): Promise<AvailabilityRule[]> {
  const space = await ctx.repo.getSpace(spaceId);
  if (!space) throw new DomainError("not_found");
  if (!(await canManageSpace(ctx, userId, space))) throw new DomainError("forbidden", "You can only manage your own spaces");
  validateRules(rules);
  const saved = await ctx.repo.replaceAvailabilityRules(spaceId, makeRules(spaceId, rules, ctx.now()));
  await ctx.repo.updateSpace(spaceId, { schedule: scheduleFromRules(rules), pricePerHour: rules[0].hourlyRateHalalas / 100 });
  return saved;
}

export async function addAvailabilityException(
  ctx: DomainContext,
  userId: string,
  spaceId: string,
  input: { exceptionDate: string; isBlocked: boolean; overrideStartMinute?: number | null; overrideEndMinute?: number | null },
): Promise<AvailabilityException> {
  const space = await ctx.repo.getSpace(spaceId);
  if (!space) throw new DomainError("not_found");
  if (!(await canManageSpace(ctx, userId, space))) throw new DomainError("forbidden", "You can only manage your own spaces");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.exceptionDate) || Number.isNaN(Date.parse(`${input.exceptionDate}T00:00:00Z`))) throw new DomainError("validation", "Date must be YYYY-MM-DD");
  const s = input.overrideStartMinute ?? null;
  const e = input.overrideEndMinute ?? null;
  if (!input.isBlocked) {
    if (s === null || e === null || !Number.isInteger(s) || !Number.isInteger(e) || s < 0 || e > 1440 || e <= s) throw new DomainError("validation", "Override hours must be a valid window");
  }
  return ctx.repo.upsertAvailabilityException({
    id: newId(),
    spaceId,
    exceptionDate: input.exceptionDate,
    isBlocked: input.isBlocked,
    overrideStartMinute: input.isBlocked ? null : s,
    overrideEndMinute: input.isBlocked ? null : e,
  });
}

// ─── Driver side: quote & book ────────────────────────────────────────────

export type SpaceAvailability = "bookable" | "waitlist" | "hidden";

/** Map/recruitment/booking gate: only VERIFIED, approved spaces of approved partners are ever shown. */
export async function spaceAvailability(ctx: DomainContext, space: ParkingSpace, settings?: PlatformSettings): Promise<SpaceAvailability> {
  if (space.approval !== "approved" || !isVerified(space)) return "hidden";
  const partner = await ctx.repo.getPartner(space.partnerId);
  if (partner?.status !== "approved") return "hidden";
  return isWaitlisted(space, settings ?? (await getPlatformSettings(ctx))) ? "waitlist" : "bookable";
}

export interface HomeBookingInput {
  spaceId: string;
  startAt: string;
  endAt: string;
  rewardId?: string | null;
}

const MAX_HOME_BOOKING_MS = 30 * 86_400_000;

function parseWindow(ctx: DomainContext, startAt: string, endAt: string): { start: number; end: number } {
  const start = Date.parse(startAt);
  const end = Date.parse(endAt);
  if (Number.isNaN(start) || Number.isNaN(end)) throw new DomainError("validation", "Invalid start or end time");
  const now = ctx.now().getTime();
  if (start < now - 10 * 60_000) throw new DomainError("validation", "Start time is in the past");
  if (start > now + 30 * 86_400_000) throw new DomainError("validation", "Bookings open 30 days ahead");
  if (end - start < 30 * 60_000) throw new DomainError("validation", "Minimum booking is 30 minutes");
  if (end - start > MAX_HOME_BOOKING_MS) throw new DomainError("validation", "Maximum booking is 30 days");
  if (start % 60_000 !== 0 || end % 60_000 !== 0) throw new DomainError("validation", "Times must be whole minutes");
  return { start, end };
}

export interface HomeQuote {
  spaceId: string;
  startAt: string;
  endAt: string;
  fare: ReturnType<typeof computeFare>;
  bufferMinutes: number;
}

async function priceWindow(ctx: DomainContext, space: ParkingSpace, start: number, end: number, keysRequested: number) {
  const [rules, exceptions] = await Promise.all([ctx.repo.listAvailabilityRules([space.id]), ctx.repo.listAvailabilityExceptions([space.id])]);
  const coverage = checkCoverage(rules, exceptions, start, end);
  if (!coverage.ok) throw new DomainError("outside_schedule", coverage.reason === "blocked_date" ? "The host has blocked that date" : "The space is not available for that whole window", { reason: coverage.reason });
  const base = baseFare(coverage.pricing, start, end);
  return { fare: computeFare(base, keysRequested), base, rules, coverage };
}

export async function quoteHomeBooking(ctx: DomainContext, input: HomeBookingInput): Promise<HomeQuote> {
  const { start, end } = parseWindow(ctx, input.startAt, input.endAt);
  const space = await ctx.repo.getSpace(input.spaceId);
  if (!space) throw new DomainError("not_found");
  const availability = await spaceAvailability(ctx, space);
  if (availability === "hidden") throw new DomainError("verification_required");
  if (availability === "waitlist") throw new DomainError("waitlist_only");
  let keys = 0;
  if (input.rewardId) {
    const reward = await ctx.repo.getReward(input.rewardId);
    if (!reward || !isRewardEligibleForSpace(reward, space)) throw new DomainError("reward_ineligible");
    const { base } = await priceWindow(ctx, space, start, end, 0);
    keys = keysDiscountForReward(base, reward.discountPercent ?? 0);
  }
  const { fare } = await priceWindow(ctx, space, start, end, keys);
  return { spaceId: space.id, startAt: iso(new Date(start)), endAt: iso(new Date(end)), fare, bufferMinutes: space.bufferMinutes ?? 0 };
}

/** Cryptographically random access secret; shape depends on how the gate is opened. */
export function generateCredential(mode: AccessMode | undefined, bookingId: string, startMs: number, endMs: number): AccessCredential | null {
  const type: CredentialType = mode === "ephemeral_pin" ? "pin" : mode === "dynamic_qr" ? "qr_token" : mode === "guard_pass" ? "guard_code" : "none";
  if (type === "none") return null;
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let secret: string;
  if (type === "pin") secret = String(((bytes[0] << 16) | (bytes[1] << 8) | bytes[2]) % 1_000_000).padStart(6, "0");
  else if (type === "guard_code") secret = Array.from(bytes.slice(0, 8), (b) => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[b % 32]).join("");
  else secret = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return {
    bookingId,
    credentialType: type,
    secretPayload: secret,
    validFrom: iso(new Date(startMs - HOME_FEES.credentialValidBeforeMinutes * 60_000)),
    validUntil: iso(new Date(endMs + HOME_FEES.credentialValidAfterMinutes * 60_000)),
    revokedAt: null,
  };
}

/** Payment mode: demo bookings are simulated; with a PSP configured, access waits for the signed webhook. */
function initialPaymentStatus(ctx: DomainContext): PaymentStatus {
  return ctx.allowSimulatedEvidence || !process.env.RAKNA_PSP_WEBHOOK_SECRET ? "simulated" : "pending";
}

export async function createHomeBooking(ctx: DomainContext, userId: string, input: HomeBookingInput): Promise<ParkingBooking> {
  const profile = await ctx.repo.getProfile(userId);
  if (!profile || profile.deletedAt) throw new DomainError("unauthenticated");
  if (profile.role !== "driver") throw new DomainError("forbidden", "Only driver accounts can book parking");
  const { start, end } = parseWindow(ctx, input.startAt, input.endAt);

  return ctx.repo.withLock(`space:${input.spaceId}`, async () => {
    const space = await ctx.repo.getSpace(input.spaceId);
    if (!space) throw new DomainError("not_found");
    if (space.hostId === userId) throw new DomainError("forbidden", "You can't book your own space");
    const availability = await spaceAvailability(ctx, space);
    if (availability === "hidden") throw new DomainError("verification_required");
    if (availability === "waitlist") throw new DomainError("waitlist_only");
    const buffer = space.bufferMinutes ?? 0;

    // Friendly pre-check (non-authoritative; the SQL function re-checks atomically).
    const existing = (await ctx.repo.listBookings({ spaceId: space.id })).filter((b) => b.status === "confirmed");
    const padded = existing.filter((b) => collidesWithBuffer(start, end, Date.parse(b.startAt), Date.parse(b.endAt), buffer)).length;
    if (padded >= space.capacity) {
      const raw = existing.filter((b) => collidesWithBuffer(start, end, Date.parse(b.startAt), Date.parse(b.endAt), 0)).length;
      throw new DomainError(raw >= space.capacity ? "capacity_full" : "buffer_conflict");
    }

    const id = newId();
    let reward: Awaited<ReturnType<typeof ctx.repo.getReward>> = null;
    let keysRequested = 0;
    if (input.rewardId) {
      reward = await ctx.repo.getReward(input.rewardId);
      if (!reward || !isRewardEligibleForSpace(reward, space)) throw new DomainError("reward_ineligible", "This reward cannot be used for this space");
      const { base } = await priceWindow(ctx, space, start, end, 0);
      keysRequested = keysDiscountForReward(base, reward.discountPercent ?? 0);
    }
    const { fare } = await priceWindow(ctx, space, start, end, keysRequested);

    const redemptionId = reward ? newId() : null;
    if (reward && redemptionId) {
      await spendPoints(ctx, {
        userId,
        amount: reward.keysRequired,
        type: "booking_discount",
        reason: `Platform-fee discount at ${space.title} (simulated)`,
        idempotencyKey: `redeem:${redemptionId}`,
        refType: "parking_booking",
        refId: id,
      });
    }

    const now = ctx.now();
    const booking: ParkingBooking = {
      id,
      spaceId: space.id,
      userId,
      startAt: iso(new Date(start)),
      endAt: iso(new Date(end)),
      hours: Math.ceil((end - start) / 3_600_000),
      priceTotal: fare.driverTotalHalalas / 100,
      discountApplied: fare.keysDiscountHalalas / 100,
      redemptionId: null,
      status: "confirmed",
      simulatedPayment: true,
      createdAt: iso(now),
      fare,
      bufferMinutes: buffer,
      paymentStatus: initialPaymentStatus(ctx),
      pspReference: null,
      arrivedAt: null,
      departedAt: null,
      overstaySurchargeHalalas: 0,
    };
    const credential = generateCredential(space.accessMode, id, start, end);
    const result = await ctx.repo.insertHomeBooking(booking, { capacity: space.capacity, bufferMinutes: buffer, credential });
    if (result !== "ok") {
      if (reward && redemptionId) {
        await refundPoints(ctx, { userId, amount: reward.keysRequired, reason: "Refund: booking slot was no longer available", idempotencyKey: `refund:${redemptionId}`, refType: "parking_booking", refId: id });
      }
      throw new DomainError("capacity_full");
    }
    if (reward && redemptionId) {
      await ctx.repo.insertRedemption({ id: redemptionId, userId, rewardId: reward.id, keysSpent: reward.keysRequired, status: "used", code: null, simulated: true, createdAt: iso(now), decidedAt: iso(now), decidedBy: null, bookingId: id });
      return ctx.repo.updateBooking(id, { redemptionId });
    }
    return booking;
  });
}

// ─── Access reveal ────────────────────────────────────────────────────────

export interface BookingAccess {
  bookingId: string;
  location: LatLng;
  address: string;
  addressAr: string;
  conditions: string;
  conditionsAr: string;
  accessMode: AccessMode;
  credential: { type: CredentialType; secret: string; validFrom: string; validUntil: string } | null;
}

function paid(b: ParkingBooking): boolean {
  return b.paymentStatus === undefined || b.paymentStatus === "simulated" || b.paymentStatus === "paid";
}

export async function getBookingAccess(ctx: DomainContext, userId: string, bookingId: string): Promise<BookingAccess> {
  const b = await ctx.repo.getBooking(bookingId);
  if (!b || b.userId !== userId) throw new DomainError("not_found"); // never confirm others' bookings exist
  if (b.status !== "confirmed") throw new DomainError("conflict", "This booking is no longer active");
  if (!paid(b)) throw new DomainError("payment_required");
  const now = ctx.now().getTime();
  const unlockAt = Date.parse(b.startAt) - HOME_FEES.accessRevealBeforeMinutes * 60_000;
  if (now < unlockAt) throw new DomainError("access_not_ready", undefined, { unlockAt: iso(new Date(unlockAt)) });
  if (now > Date.parse(b.endAt) + HOME_FEES.credentialValidAfterMinutes * 60_000 + 6 * 3_600_000) throw new DomainError("conflict", "This booking has ended");
  const space = await ctx.repo.getSpace(b.spaceId);
  if (!space) throw new DomainError("not_found");
  const cred = await ctx.repo.getCredential(b.id);
  const live = cred && !cred.revokedAt && now <= Date.parse(cred.validUntil);
  return {
    bookingId: b.id,
    location: space.location,
    address: space.address,
    addressAr: space.addressAr,
    conditions: space.conditions,
    conditionsAr: space.conditionsAr,
    accessMode: space.accessMode ?? "unobstructed",
    credential: live ? { type: cred.credentialType, secret: cred.secretPayload, validFrom: cred.validFrom, validUntil: cred.validUntil } : null,
  };
}

// ─── Booking lifecycle events ─────────────────────────────────────────────

export interface BookingEventInput {
  eventType: Exclude<BookingEventType, "overstay_flagged">;
  location?: LatLng | null;
  evidenceNote?: string | null;
  /** Demo only: treat the device as standing at the space. */
  simulateAtSpace?: boolean;
}

export async function recordBookingEvent(ctx: DomainContext, userId: string, bookingId: string, input: BookingEventInput): Promise<{ booking: ParkingBooking; events: BookingEvent[] }> {
  const b = await ctx.repo.getBooking(bookingId);
  if (!b || b.userId !== userId) throw new DomainError("not_found");
  if (!b.fare) throw new DomainError("validation", "Lifecycle events apply to schedule bookings only");
  const space = await ctx.repo.getSpace(b.spaceId);
  if (!space) throw new DomainError("not_found");
  const now = ctx.now();
  const nowMs = now.getTime();
  const note = input.evidenceNote ? String(input.evidenceNote).slice(0, 500) : null;
  const event = (eventType: BookingEventType, location: LatLng | null = null): BookingEvent => ({ id: newId(), bookingId: b.id, actorId: userId, eventType, location, evidenceNote: note, createdAt: iso(now) });
  const out: BookingEvent[] = [];

  if (input.eventType === "arrived") {
    if (b.status !== "confirmed") throw new DomainError("conflict", "Booking is not active");
    if (b.arrivedAt) throw new DomainError("conflict", "Already checked in");
    if (nowMs < Date.parse(b.startAt) - HOME_FEES.accessRevealBeforeMinutes * 60_000 || nowMs > Date.parse(b.endAt)) throw new DomainError("conflict", "Check-in is open from 30 minutes before the start until the end");
    const at = input.simulateAtSpace && ctx.allowSimulatedEvidence ? space.location : input.location;
    if (!at || !isValidLatLng(at)) throw new DomainError("validation", "Location is required to check in");
    const geo = withinGeofence(at, space.location);
    if (!geo.ok) throw new DomainError("outside_geofence", undefined, { distanceM: geo.distanceM, radiusM: HOME_FEES.arrivalGeofenceM });
    // Only an approximate point is stored with the event (no precise trail of the driver).
    out.push(await ctx.repo.insertBookingEvent(event("arrived", publicPointFor(at, "villa_open"))));
    return { booking: await ctx.repo.updateBooking(b.id, { arrivedAt: iso(now) }), events: out };
  }

  if (input.eventType === "extended") {
    if (b.status !== "confirmed" || b.departedAt) throw new DomainError("conflict", "Booking is not active");
    if (nowMs > Date.parse(b.endAt)) throw new DomainError("conflict", "Extend before the booking ends");
    const start = Date.parse(b.startAt);
    const newEnd = Date.parse(b.endAt) + HOME_FEES.extendMinutes * 60_000;
    if (newEnd - start > MAX_HOME_BOOKING_MS) throw new DomainError("validation", "Maximum booking is 30 days");
    const { fare } = await priceWindow(ctx, space, start, newEnd, b.fare.keysDiscountHalalas);
    const updated = await ctx.repo.extendHomeBooking(
      b.id,
      iso(new Date(newEnd)),
      { fare, hours: Math.ceil((newEnd - start) / 3_600_000), priceTotal: fare.driverTotalHalalas / 100, discountApplied: fare.keysDiscountHalalas / 100 },
      { capacity: space.capacity, bufferMinutes: space.bufferMinutes ?? 0, credentialValidUntil: iso(new Date(newEnd + HOME_FEES.credentialValidAfterMinutes * 60_000)) },
    );
    if (!updated) throw new DomainError("buffer_conflict", "The next booking (plus turnaround time) leaves no room to extend");
    out.push(await ctx.repo.insertBookingEvent(event("extended")));
    return { booking: updated, events: out };
  }

  if (input.eventType === "departed") {
    if (b.status !== "confirmed") throw new DomainError("conflict", "Booking is not active");
    const rules = await ctx.repo.listAvailabilityRules([space.id]);
    const rate = rules.find((r) => r.isActive)?.hourlyRateHalalas ?? Math.round(space.pricePerHour * 100);
    const over = overstaySurcharge(Date.parse(b.endAt), nowMs, rate);
    out.push(await ctx.repo.insertBookingEvent(event("departed")));
    if (over.surchargeHalalas > 0) {
      out.push(await ctx.repo.insertBookingEvent({ ...event("overstay_flagged"), evidenceNote: `${over.minutes} min over; surcharge ${over.surchargeHalalas} halalas credited to host` }));
    }
    await ctx.repo.updateCredential(b.id, { revokedAt: iso(now) });
    const booking = await ctx.repo.updateBooking(b.id, { departedAt: iso(now), status: "completed", overstaySurchargeHalalas: over.surchargeHalalas });
    return { booking, events: out };
  }

  if (input.eventType === "bay_blocked_reported") {
    if (b.status !== "confirmed") throw new DomainError("conflict", "Booking is not active");
    out.push(await ctx.repo.insertBookingEvent(event("bay_blocked_reported")));
    await ctx.repo.insertAudit({ id: newId(), actorId: userId, action: "booking.bay_blocked", target: `parking_booking:${b.id}`, details: note ?? "Driver reported the bay was blocked", createdAt: iso(now) });
    return { booking: b, events: out };
  }

  throw new DomainError("validation", "Unknown event type");
}

// ─── Payments (PSP webhook) ───────────────────────────────────────────────

const PAYMENT_TRANSITIONS: Record<PaymentStatus, PaymentStatus[]> = {
  simulated: [],
  pending: ["paid", "failed"],
  paid: ["refunded"],
  failed: [],
  refunded: [],
};

/** Idempotent: replaying the same event is a no-op; illegal transitions are rejected. */
export async function applyPaymentEvent(ctx: DomainContext, input: { bookingId: string; status: "paid" | "failed" | "refunded"; pspReference: string }): Promise<{ booking: ParkingBooking; changed: boolean }> {
  const b = await ctx.repo.getBooking(input.bookingId);
  if (!b || !b.fare) throw new DomainError("not_found");
  const current = b.paymentStatus ?? "simulated";
  if (current === input.status && b.pspReference === input.pspReference) return { booking: b, changed: false };
  if (!PAYMENT_TRANSITIONS[current].includes(input.status)) throw new DomainError("conflict", `Cannot move payment from ${current} to ${input.status}`);
  const patch: Partial<ParkingBooking> = { paymentStatus: input.status, pspReference: input.pspReference };
  if (input.status === "failed" || input.status === "refunded") {
    patch.status = "cancelled";
    await ctx.repo.updateCredential(b.id, { revokedAt: iso(ctx.now()) });
  }
  return { booking: await ctx.repo.updateBooking(b.id, patch), changed: true };
}

// ─── Host dashboard ───────────────────────────────────────────────────────

export async function hostDashboard(ctx: DomainContext, userId: string) {
  const profile = await ctx.repo.getProfile(userId);
  if (!profile) throw new DomainError("unauthenticated");
  const mine = (await ctx.repo.listSpaces()).filter((s) => s.hostId === userId);
  const ids = mine.map((s) => s.id);
  const [rules, exceptions, bookings, settings] = await Promise.all([
    ctx.repo.listAvailabilityRules(ids),
    ctx.repo.listAvailabilityExceptions(ids, iso(ctx.now()).slice(0, 10)),
    ids.length ? ctx.repo.listBookings({ spaceIds: ids }) : Promise.resolve([] as ParkingBooking[]),
    getPlatformSettings(ctx),
  ]);
  const live = bookings.filter((b) => b.status !== "cancelled" && b.fare);
  const earned = live.reduce((s, b) => s + (b.fare?.hostNetPayoutHalalas ?? 0) + (b.overstaySurchargeHalalas ?? 0), 0);
  return {
    settings,
    spaces: mine.map((s) => ({
      ...s,
      waitlisted: isWaitlisted(s, settings),
      rules: rules.filter((r) => r.spaceId === s.id),
      exceptions: exceptions.filter((e) => e.spaceId === s.id),
      estimatedMonthlyNetHalalas: illustrativeMonthlyNetHalalas(rules.filter((r) => r.spaceId === s.id)),
    })),
    // Drivers' identities are not shared with hosts beyond the booking window itself.
    bookings: bookings
      .sort((a, b) => b.startAt.localeCompare(a.startAt))
      .slice(0, 100)
      .map((b) => ({ id: b.id, spaceId: b.spaceId, startAt: b.startAt, endAt: b.endAt, status: b.status, paymentStatus: b.paymentStatus ?? "simulated", hostNetPayoutHalalas: b.fare?.hostNetPayoutHalalas ?? 0, overstaySurchargeHalalas: b.overstaySurchargeHalalas ?? 0, arrivedAt: b.arrivedAt ?? null, departedAt: b.departedAt ?? null })),
    stats: { totalBookings: live.length, hostNetEarnedHalalas: earned },
  };
}

/** Driver "My Bookings & Passes": own bookings plus the public view of each space. */
export async function myBookings(ctx: DomainContext, userId: string) {
  const bookings = (await ctx.repo.listBookings({ userId })).sort((a, b) => b.startAt.localeCompare(a.startAt)).slice(0, 100);
  const spaces = new Map<string, ParkingSpace>();
  for (const id of [...new Set(bookings.map((b) => b.spaceId))]) {
    const s = await ctx.repo.getSpace(id);
    if (s) spaces.set(id, toPublicSpace(s, null));
  }
  const now = ctx.now().getTime();
  return bookings.map((b) => {
    const s = spaces.get(b.spaceId);
    return {
      ...b,
      space: s ? { id: s.id, title: s.title, titleAr: s.titleAr, location: s.location, spaceCategory: s.spaceCategory ?? "commercial", accessMode: s.accessMode ?? "unobstructed", shadeTier: s.shadeTier ?? null, metroStationCode: s.metroStationCode ?? null } : null,
      accessUnlocksAt: iso(new Date(Date.parse(b.startAt) - HOME_FEES.accessRevealBeforeMinutes * 60_000)),
      accessOpen: b.status === "confirmed" && paid(b) && now >= Date.parse(b.startAt) - HOME_FEES.accessRevealBeforeMinutes * 60_000,
    };
  });
}

/** PARK & CONNECT: walking distance from a space to its tagged Metro station. */
export function metroWalk(space: Pick<ParkingSpace, "metroStationCode" | "location">): { code: string; name: string; nameAr: string; walkMinutes: number } | null {
  const st = DEMO_METRO_STATIONS.find((m) => m.code === space.metroStationCode);
  if (!st) return null;
  return { code: st.code, name: st.name, nameAr: st.nameAr, walkMinutes: Math.max(1, Math.round(distanceM(space.location, st.location) / 80)) };
}
