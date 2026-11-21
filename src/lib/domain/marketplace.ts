import type { LatLng, ParkingBooking, ParkingPartner, ParkingSpace, WeeklySchedule } from "../types";
import { inRiyadh, isValidLatLng, nearestNeighborhood } from "../geo";
import { DomainError } from "./errors";
import { iso, newId, riyadhParts, type DomainContext } from "./context";
import { refundPoints, spendPoints } from "./ledger";
import { isRewardEligibleForSpace } from "./rewards";
import { hiveIndexFor } from "../hive/cells";
import type { PlatformSettings } from "../config";
import { isResidential, spaceAvailability } from "./home";
import { pageOf, type Page } from "../data/repo";

const PARTNER_PAGE = 50;

/** Keyset page of bookings on the caller's partner spaces (newest first). */
export async function partnerBookingsPage(ctx: DomainContext, userId: string, limit: number, cursor?: string | null): Promise<Page<ParkingBooking>> {
  const partner = await partnerForOwner(ctx, userId);
  if (!partner) throw new DomainError("partner_not_approved");
  const spaces = await ctx.repo.listSpaces({ partnerId: partner.id });
  if (spaces.length === 0) return { items: [], nextCursor: null };
  return pageOf(await ctx.repo.listBookings({ spaceIds: spaces.map((s) => s.id) }), Math.max(1, Math.min(200, limit)), cursor);
}

/**
 * Private parking marketplace. Only spaces submitted by an APPROVED partner and
 * then approved by an admin are bookable. Ordinary drivers can never list space.
 * Payments are SIMULATED in the MVP.
 */

export async function registerPartner(
  ctx: DomainContext,
  userId: string,
  input: { name: string; nameAr: string; kind: ParkingPartner["kind"]; contactEmail: string; crNumberProvided: boolean },
): Promise<ParkingPartner> {
  const profile = await ctx.repo.getProfile(userId);
  if (!profile) throw new DomainError("unauthenticated");
  if (profile.role !== "partner") throw new DomainError("forbidden", "Use a parking-partner account to register a business");
  const existing = (await ctx.repo.listPartners()).find((p) => p.ownerId === userId && p.status !== "rejected");
  if (existing) throw new DomainError("conflict", "This account already has a partner application");
  return ctx.repo.insertPartner({
    id: newId(),
    ownerId: userId,
    name: input.name,
    nameAr: input.nameAr || input.name,
    kind: input.kind,
    contactEmail: input.contactEmail,
    crNumberProvided: input.crNumberProvided,
    status: "pending",
    createdAt: iso(ctx.now()),
    reviewedAt: null,
    isDemo: ctx.allowSimulatedEvidence,
  });
}

/** The owner's current partner record: a live (non-rejected) application wins over older rejected ones. */
export async function partnerForOwner(ctx: DomainContext, userId: string): Promise<ParkingPartner | null> {
  const mine = (await ctx.repo.listPartners()).filter((p) => p.ownerId === userId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return mine.find((p) => p.status !== "rejected") ?? mine[0] ?? null;
}

export function validateSchedule(s: WeeklySchedule): void {
  const daysOk = Array.isArray(s.days) && s.days.length > 0 && s.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6);
  if (!daysOk || !Number.isInteger(s.openHour) || !Number.isInteger(s.closeHour) || s.openHour < 0 || s.closeHour > 24 || s.openHour >= s.closeHour) {
    throw new DomainError("validation", "Invalid availability schedule");
  }
}

export interface SubmitSpaceInput {
  title: string;
  titleAr: string;
  location: LatLng;
  address: string;
  addressAr: string;
  capacity: number;
  pricePerHour: number;
  schedule: WeeklySchedule;
  conditions: string;
  conditionsAr: string;
  rewardEligible: boolean;
}

/** Authorization: only the owner of an APPROVED partner can submit inventory. */
export async function submitSpace(ctx: DomainContext, userId: string, input: SubmitSpaceInput): Promise<ParkingSpace> {
  const profile = await ctx.repo.getProfile(userId);
  if (!profile) throw new DomainError("unauthenticated");
  if (profile.role !== "partner") throw new DomainError("forbidden", "Only authorized parking partners can list private spaces");
  const partner = await partnerForOwner(ctx, userId);
  if (!partner) throw new DomainError("partner_not_approved", "Register as a parking partner first");
  if (partner.status !== "approved") throw new DomainError("partner_not_approved", "Your partner account is awaiting approval");
  if (!isValidLatLng(input.location) || !inRiyadh(input.location)) throw new DomainError("outside_service_area");
  if (!Number.isInteger(input.capacity) || input.capacity < 1 || input.capacity > 2000) throw new DomainError("validation", "Invalid capacity");
  if (!(input.pricePerHour >= 0 && input.pricePerHour <= 500)) throw new DomainError("validation", "Invalid price");
  validateSchedule(input.schedule);

  return ctx.repo.insertSpace({
    id: newId(),
    partnerId: partner.id,
    title: input.title,
    titleAr: input.titleAr || input.title,
    location: input.location,
    hive: hiveIndexFor(input.location),
    accessibleBays: 0,
    neighborhood: nearestNeighborhood(input.location),
    address: input.address,
    addressAr: input.addressAr || input.address,
    capacity: input.capacity,
    pricePerHour: Math.round(input.pricePerHour * 100) / 100,
    schedule: input.schedule,
    conditions: input.conditions,
    conditionsAr: input.conditionsAr || input.conditions,
    rewardEligible: input.rewardEligible,
    approval: "pending_review",
    createdAt: iso(ctx.now()),
    isDemo: ctx.allowSimulatedEvidence,
    // RAKNA PARTNERS: commercial inventory is verified against the commercial registration on approval.
    spaceCategory: "commercial",
    entitlementType: "commercial_cr",
    verificationStatus: "pending",
    publicLocation: input.location,
    bufferMinutes: 0,
    instantBook: true,
    accessMode: "unobstructed",
    waitlistOnly: false,
  });
}

/**
 * Partner self-service on their own listings: toggle Keys-discount eligibility and
 * pause/resume an approved space. Anything else (location, price) requires a new
 * submission so admins re-review it.
 */
export async function updateOwnSpace(ctx: DomainContext, userId: string, spaceId: string, patch: { rewardEligible?: boolean; paused?: boolean }): Promise<ParkingSpace> {
  const profile = await ctx.repo.getProfile(userId);
  if (!profile || profile.role !== "partner") throw new DomainError("forbidden");
  const space = await ctx.repo.getSpace(spaceId);
  if (!space) throw new DomainError("not_found");
  const partner = await ctx.repo.getPartner(space.partnerId);
  if (!partner || partner.ownerId !== userId) throw new DomainError("forbidden", "You can only manage your own spaces");
  const next: Partial<ParkingSpace> = {};
  if (patch.rewardEligible !== undefined) next.rewardEligible = patch.rewardEligible;
  if (patch.paused !== undefined) {
    if (patch.paused && space.approval !== "approved") throw new DomainError("conflict", "Only approved spaces can be paused");
    if (!patch.paused && space.approval !== "paused") throw new DomainError("conflict", "Space is not paused");
    next.approval = patch.paused ? "paused" : "approved";
  }
  return ctx.repo.updateSpace(spaceId, next);
}

/**
 * Bookable = approved space of an approved partner, entitlement VERIFIED (Phase 3; legacy rows
 * were verified by migration 0007) and not waitlist-only (villas follow the municipal switch).
 */
export async function isSpaceBookable(ctx: DomainContext, space: ParkingSpace, settings?: PlatformSettings): Promise<boolean> {
  return (await spaceAvailability(ctx, space, settings)) === "bookable";
}

export function withinSchedule(schedule: WeeklySchedule, start: Date, hours: number): boolean {
  const s = riyadhParts(start);
  if (!schedule.days.includes(s.day)) return false;
  const startH = s.hour + s.minute / 60;
  return startH >= schedule.openHour && startH + hours <= schedule.closeHour;
}

function overlaps(aStart: Date, aEnd: Date, b: ParkingBooking): boolean {
  return aStart < new Date(b.endAt) && new Date(b.startAt) < aEnd;
}

export async function availableCapacity(ctx: DomainContext, space: ParkingSpace, start: Date, end: Date): Promise<number> {
  const bookings = await ctx.repo.listBookings({ spaceId: space.id });
  const used = bookings.filter((b) => b.status === "confirmed" && overlaps(start, end, b)).length;
  return Math.max(0, space.capacity - used);
}

export interface BookingInput {
  spaceId: string;
  startAt: string;
  hours: number;
  rewardId?: string | null;
}

export async function createBooking(ctx: DomainContext, userId: string, input: BookingInput): Promise<ParkingBooking> {
  const profile = await ctx.repo.getProfile(userId);
  if (!profile) throw new DomainError("unauthenticated");
  if (profile.role !== "driver") throw new DomainError("forbidden", "Only driver accounts can book parking");
  if (!Number.isInteger(input.hours) || input.hours < 1 || input.hours > 12) throw new DomainError("validation", "Booking must be 1–12 hours");
  const start = new Date(input.startAt);
  if (Number.isNaN(start.getTime())) throw new DomainError("validation", "Invalid start time");
  const now = ctx.now();
  if (start.getTime() < now.getTime() - 10 * 60_000) throw new DomainError("validation", "Start time is in the past");
  if (start.getTime() > now.getTime() + 14 * 86_400_000) throw new DomainError("validation", "Bookings open 14 days ahead");

  return ctx.repo.withLock(`space:${input.spaceId}`, async () => {
    const space = await ctx.repo.getSpace(input.spaceId);
    if (!space) throw new DomainError("not_found");
    if (isResidential(space)) throw new DomainError("validation", "Residential spaces are booked with a start and end time (RAKNA HOME)");
    if (!(await isSpaceBookable(ctx, space))) throw new DomainError("space_not_bookable");
    if (!withinSchedule(space.schedule, start, input.hours)) throw new DomainError("outside_schedule");
    const end = new Date(start.getTime() + input.hours * 3_600_000);
    if ((await availableCapacity(ctx, space, start, end)) <= 0) throw new DomainError("capacity_full");

    const id = newId();
    const priceTotal = Math.round(space.pricePerHour * input.hours * 100) / 100;
    let discountApplied = 0;
    let reward: Awaited<ReturnType<typeof ctx.repo.getReward>> = null;
    const redemptionId = input.rewardId ? newId() : null;

    if (input.rewardId) {
      reward = await ctx.repo.getReward(input.rewardId);
      if (!reward || !isRewardEligibleForSpace(reward, space)) throw new DomainError("reward_ineligible", "This reward cannot be used for this space");
      await spendPoints(ctx, {
        userId,
        amount: reward.keysRequired,
        type: "booking_discount",
        reason: `${reward.discountPercent}% parking discount at ${space.title} (simulated)`,
        idempotencyKey: `redeem:${redemptionId}`,
        refType: "parking_booking",
        refId: id,
      });
      discountApplied = Math.round(priceTotal * (reward.discountPercent! / 100) * 100) / 100;
    }

    const booking: ParkingBooking = {
      id,
      spaceId: space.id,
      userId,
      startAt: iso(start),
      endAt: iso(end),
      hours: input.hours,
      priceTotal,
      discountApplied,
      redemptionId: null, // linked after the redemption row exists (FK order)
      status: "confirmed",
      simulatedPayment: true,
      createdAt: iso(now),
    };
    // ATOMIC capacity check + insert (serialized per space in SQL). If the last spot was
    // taken in the meantime, the Keys spent on the discount are refunded.
    if (!(await ctx.repo.insertBookingIfCapacity(booking, space.capacity))) {
      if (reward && redemptionId) {
        await refundPoints(ctx, { userId, amount: reward.keysRequired, reason: "Refund: booking slot was no longer available", idempotencyKey: `refund:${redemptionId}`, refType: "parking_booking", refId: id });
      }
      throw new DomainError("capacity_full");
    }

    if (reward && redemptionId) {
      await ctx.repo.insertRedemption({
        id: redemptionId,
        userId,
        rewardId: reward.id,
        keysSpent: reward.keysRequired,
        status: "used",
        code: null,
        simulated: true,
        createdAt: iso(now),
        decidedAt: iso(now),
        decidedBy: null,
        bookingId: id,
      });
      return ctx.repo.updateBooking(id, { redemptionId });
    }
    return booking;
  });
}

export async function cancelBooking(ctx: DomainContext, userId: string, bookingId: string): Promise<ParkingBooking> {
  const bookings = await ctx.repo.listBookings({ userId });
  const b = bookings.find((x) => x.id === bookingId);
  if (!b) throw new DomainError("not_found");
  if (b.status !== "confirmed") throw new DomainError("conflict");
  if (b.arrivedAt) throw new DomainError("conflict", "You have already checked in");
  if (b.fare) await ctx.repo.updateCredential(b.id, { revokedAt: iso(ctx.now()) });
  return ctx.repo.updateBooking(b.id, { status: "cancelled" });
}

export async function partnerDashboard(ctx: DomainContext, userId: string) {
  const profile = await ctx.repo.getProfile(userId);
  if (!profile || profile.role !== "partner") throw new DomainError("forbidden");
  const partner = await partnerForOwner(ctx, userId);
  if (!partner || partner.status === "rejected") return { partner: null, spaces: [], bookings: [], stats: null };
  const spaces = await ctx.repo.listSpaces({ partnerId: partner.id });
  const bookings = (await ctx.repo.listBookings({ spaceIds: spaces.map((s) => s.id) })).sort((a, b) => b.startAt.localeCompare(a.startAt));
  const confirmed = bookings.filter((b) => b.status !== "cancelled");

  // Occupancy over the next 7 days: booked space-hours / scheduled space-hours.
  const now = ctx.now();
  const horizon = new Date(now.getTime() + 7 * 86_400_000);
  let scheduled = 0;
  for (const s of spaces.filter((x) => x.approval === "approved")) {
    scheduled += s.schedule.days.length * (s.schedule.closeHour - s.schedule.openHour) * s.capacity;
  }
  const booked = confirmed
    .filter((b) => new Date(b.startAt) >= now && new Date(b.startAt) < horizon)
    .reduce((sum, b) => sum + b.hours, 0);

  // Paginated (blocker B7): the first page here; more via GET /api/partner/bookings?cursor=.
  const firstPage = pageOf(bookings, PARTNER_PAGE);
  return {
    partner,
    spaces,
    bookings: firstPage.items,
    bookingsNextCursor: firstPage.nextCursor,
    stats: {
      totalBookings: confirmed.length,
      occupancy7d: scheduled > 0 ? Math.min(1, booked / scheduled) : 0,
      estimatedRevenue: Math.round(confirmed.reduce((s, b) => s + b.priceTotal - b.discountApplied, 0) * 100) / 100,
      discountsFunded: Math.round(confirmed.reduce((s, b) => s + b.discountApplied, 0) * 100) / 100,
    },
  };
}
