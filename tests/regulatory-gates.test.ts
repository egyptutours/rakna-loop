import { describe, expect, it } from "vitest";
import { DEFAULT_PLATFORM_SETTINGS } from "@/lib/config";
import { HOME_SPACES } from "@/lib/data/seed";
import { decideSpace } from "@/lib/domain/admin";
import {
  applyPaymentEvent,
  checkListingGates,
  createHomeBooking,
  getBookingAccess,
  hostDashboard,
  isWaitlisted,
  publicPointFor,
  quoteHomeBooking,
  recordBookingEvent,
  setVillaBookingsEnabled,
  spaceAvailability,
  submitHomeListing,
  toPublicSpace,
  type HomeListingInput,
} from "@/lib/domain/home";
import { distanceM } from "@/lib/geo";
import { A, ADMIN, B, move, setup } from "./helpers";

/**
 * Saudi regulatory & business rules for RAKNA HOME, through the domain layer (DemoRepo).
 * T0 = Tuesday 2026-11-17 10:00 Riyadh (07:00 UTC). The seeded condo bay is open
 * Sun–Thu 07:00–18:00 at SAR 6.00/h (600 halalas, cap 4000) with a 15-minute buffer.
 */

const C = "00000000-0000-4000-a000-000000000101"; // seeded driver (Noura)
const codeOf = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (e) {
    return (e as { code?: string }).code ?? "thrown";
  }
};
const at = (iso: string) => new Date(iso).toISOString();
const W1 = { spaceId: HOME_SPACES.condo, startAt: at("2026-11-17T08:00:00Z"), endAt: at("2026-11-17T10:00:00Z") }; // 11:00–13:00 Riyadh

const listing = (o: Partial<HomeListingInput> = {}): HomeListingInput => ({
  spaceCategory: "condo_deeded",
  entitlementType: "deed_owner",
  title: "Bay 9",
  titleAr: "موقف 9",
  location: { lat: 24.7255, lng: 46.6662 },
  address: "Bldg 3, Al Wurud",
  addressAr: "مبنى 3، الورود",
  shadeTier: "underground",
  bufferMinutes: 15,
  instantBook: true,
  accessMode: "ephemeral_pin",
  conditions: "",
  conditionsAr: "",
  rules: [{ weekdayMask: 31, startMinute: 420, endMinute: 1080, hourlyRateHalalas: 600, dailyCapHalalas: 4000, multiDayDiscountBps: 0 }],
  ...o,
});

describe("listing gates (pure)", () => {
  const off = DEFAULT_PLATFORM_SETTINGS;

  it("blocks tenants unless they list as ejar_authorized WITH landlord consent and no sub-let prohibition", () => {
    expect(codeOf(() => checkListingGates({ spaceCategory: "villa_shaded", entitlementType: "ejar_authorized" }, off))).toBe("entitlement_invalid");
    expect(codeOf(() => checkListingGates({ spaceCategory: "villa_shaded", entitlementType: "ejar_authorized", landlordConsentConfirmed: true }, off))).toBe("entitlement_invalid");
    expect(checkListingGates({ spaceCategory: "villa_shaded", entitlementType: "ejar_authorized", landlordConsentConfirmed: true, noSubletClauseConfirmed: true }, off)).toEqual({ waitlistOnly: true });
  });

  it("blocks shared building bays unless listed by the owners' association", () => {
    expect(codeOf(() => checkListingGates({ spaceCategory: "condo_association", entitlementType: "deed_owner" }, off))).toBe("entitlement_invalid");
    expect(codeOf(() => checkListingGates({ spaceCategory: "condo_association", entitlementType: "ejar_authorized", landlordConsentConfirmed: true, noSubletClauseConfirmed: true }, off))).toBe("entitlement_invalid");
    expect(checkListingGates({ spaceCategory: "condo_association", entitlementType: "owners_association" }, off)).toEqual({ waitlistOnly: false });
  });

  it("villaBookingsEnabled=false (default): villas onboard waitlist-only; condos and commercial are bookable", () => {
    expect(off.villaBookingsEnabled).toBe(false);
    for (const c of ["villa_shaded", "villa_open", "villa_garage"] as const) expect(checkListingGates({ spaceCategory: c, entitlementType: "deed_owner" }, off).waitlistOnly).toBe(true);
    expect(checkListingGates({ spaceCategory: "condo_deeded", entitlementType: "deed_owner" }, off).waitlistOnly).toBe(false);
    expect(checkListingGates({ spaceCategory: "commercial", entitlementType: "commercial_cr" }, off).waitlistOnly).toBe(false);
    expect(checkListingGates({ spaceCategory: "villa_open", entitlementType: "owner_wakalah" }, { villaBookingsEnabled: true }).waitlistOnly).toBe(false);
  });

  it("isWaitlisted follows the live switch for villas, the stored flag otherwise", () => {
    expect(isWaitlisted({ spaceCategory: "villa_shaded", waitlistOnly: false }, off)).toBe(true);
    expect(isWaitlisted({ spaceCategory: "villa_shaded", waitlistOnly: true }, { villaBookingsEnabled: true })).toBe(false);
    expect(isWaitlisted({ spaceCategory: "condo_deeded", waitlistOnly: false }, off)).toBe(false);
  });
});

describe("verification and visibility", () => {
  it("a new listing is pending, hidden from drivers, and becomes bookable only after admin verification", async () => {
    const { ctx } = setup();
    const { space } = await submitHomeListing(ctx, A, listing());
    expect(space.verificationStatus).toBe("pending");
    expect(await spaceAvailability(ctx, space)).toBe("hidden");
    await expect(quoteHomeBooking(ctx, { spaceId: space.id, startAt: W1.startAt, endAt: W1.endAt })).rejects.toMatchObject({ code: "verification_required" });
    const verified = await decideSpace(ctx, ADMIN, space.id, "approved");
    expect(verified.verificationStatus).toBe("verified");
    expect(await spaceAvailability(ctx, verified)).toBe("bookable");
  });

  it("a verified villa stays on the waitlist until an admin enables villa bookings (audited)", async () => {
    const { ctx, repo } = setup();
    const { space } = await submitHomeListing(ctx, A, listing({ spaceCategory: "villa_open" }));
    expect(space.waitlistOnly).toBe(true);
    const v = await decideSpace(ctx, ADMIN, space.id, "approved");
    expect(await spaceAvailability(ctx, v)).toBe("waitlist");
    await expect(setVillaBookingsEnabled(ctx, A, true)).rejects.toMatchObject({ code: "forbidden" });
    await setVillaBookingsEnabled(ctx, ADMIN, true);
    expect(await spaceAvailability(ctx, (await repo.getSpace(space.id))!)).toBe("bookable");
    expect((await repo.listAudit(5)).some((a) => a.action === "platform.villa_bookings")).toBe(true);
  });

  it("stores only the Ejar consent timestamp (never the contract)", async () => {
    const { ctx } = setup();
    const { space } = await submitHomeListing(ctx, A, listing({ spaceCategory: "condo_deeded", entitlementType: "ejar_authorized", landlordConsentConfirmed: true, noSubletClauseConfirmed: true }));
    expect(space.landlordConsentAt).toBeTruthy();
    expect(JSON.stringify(space)).not.toMatch(/contract|deed_number|iban/i);
  });

  it("admins cannot list spaces; listings outside Riyadh are refused", async () => {
    const { ctx } = setup();
    await expect(submitHomeListing(ctx, ADMIN, listing())).rejects.toMatchObject({ code: "forbidden" });
    await expect(submitHomeListing(ctx, A, listing({ location: { lat: 21.5, lng: 39.2 } }))).rejects.toMatchObject({ code: "outside_service_area" });
  });
});

describe("pre-booking privacy (~150 m)", () => {
  it("residential spaces leave the server with a coarse point, no address and no host id", async () => {
    const { repo } = setup();
    const condo = (await repo.getSpace(HOME_SPACES.condo))!;
    const pub = toPublicSpace(condo, { id: A, role: "driver" });
    expect(pub.location).not.toEqual(condo.location);
    expect(distanceM(pub.location, condo.location)).toBeLessThan(250);
    expect(pub.address).toBe("");
    expect(pub.hostId).toBeNull();
    expect(toPublicSpace(condo, { id: B, role: "driver" }).address).toBe(condo.address); // the host
    const kafd = (await repo.getSpace(HOME_SPACES.kafd))!;
    expect(toPublicSpace(kafd, null).location).toEqual(kafd.location); // commercial: exact
    expect(publicPointFor(condo.location, "condo_deeded")).toEqual(pub.location);
  });
});

describe("booking, access reveal and the Keys firewall", () => {
  it("books with integer halalas, generates a PIN, and reveals access only to the paid driver 30 min before start", async () => {
    const t = setup();
    const b = await createHomeBooking(t.ctx, A, W1);
    expect(b.fare).toEqual({ baseFareHalalas: 1200, driverFeeHalalas: 60, hostCommissionHalalas: 180, vatOnPlatformFeeHalalas: 36, keysDiscountHalalas: 0, hostNetPayoutHalalas: 1020, driverTotalHalalas: 1296 });
    await expect(getBookingAccess(t.ctx, A, b.id)).rejects.toMatchObject({ code: "access_not_ready" });
    await expect(getBookingAccess(t.ctx, C, b.id)).rejects.toMatchObject({ code: "not_found" });
    t.advance(31);
    const access = await getBookingAccess(t.ctx, A, b.id);
    expect(access.credential?.type).toBe("pin");
    expect(access.credential?.secret).toMatch(/^\d{6}$/);
    expect(access.address).toContain("Al Wurud");
  });

  it("Keys reduce only the platform fee (≤ 20%) — the host payout is identical with or without Keys", async () => {
    const t = setup();
    await t.repo.upsertReward({ ...(await t.repo.getReward("00000000-0000-4000-9000-000000000001"))!, id: "00000000-0000-4000-9000-0000000000ff", discountPercent: 90, keysRequired: 5 });
    const withKeys = await createHomeBooking(t.ctx, A, { ...W1, rewardId: "00000000-0000-4000-9000-0000000000ff" });
    expect(withKeys.fare!.keysDiscountHalalas).toBe(48); // 90% requested → capped at 20% × 240
    expect(withKeys.fare!.hostNetPayoutHalalas).toBe(1020);
    expect(withKeys.redemptionId).toBeTruthy();
  });

  it("partner-specific rewards can't be used on a RAKNA HOME space", async () => {
    const t = setup();
    await expect(createHomeBooking(t.ctx, A, { ...W1, rewardId: "00000000-0000-4000-9000-000000000002" })).rejects.toMatchObject({ code: "reward_ineligible" });
  });

  it("refuses: waitlisted villas, the host's own space, windows outside the schedule, and buffer clashes", async () => {
    const t = setup();
    await expect(createHomeBooking(t.ctx, A, { ...W1, spaceId: HOME_SPACES.villa })).rejects.toMatchObject({ code: "waitlist_only" });
    await expect(createHomeBooking(t.ctx, B, W1)).rejects.toMatchObject({ code: "forbidden" });
    await expect(createHomeBooking(t.ctx, A, { ...W1, endAt: at("2026-11-17T16:00:00Z") })).rejects.toMatchObject({ code: "outside_schedule" }); // 19:00 Riyadh
    await createHomeBooking(t.ctx, A, W1);
    await expect(createHomeBooking(t.ctx, C, { ...W1, startAt: at("2026-11-17T10:10:00Z"), endAt: at("2026-11-17T11:00:00Z") })).rejects.toMatchObject({ code: "buffer_conflict" });
    await expect(createHomeBooking(t.ctx, C, { ...W1, startAt: at("2026-11-17T09:00:00Z"), endAt: at("2026-11-17T11:00:00Z") })).rejects.toMatchObject({ code: "capacity_full" });
    await expect(createHomeBooking(t.ctx, C, { ...W1, startAt: at("2026-11-17T10:15:00Z"), endAt: at("2026-11-17T11:00:00Z") })).resolves.toBeTruthy();
  });

  it("a host-blocked date is not bookable", async () => {
    const t = setup();
    const { addAvailabilityException } = await import("@/lib/domain/home");
    await addAvailabilityException(t.ctx, B, HOME_SPACES.condo, { exceptionDate: "2026-11-17", isBlocked: true });
    await expect(createHomeBooking(t.ctx, A, W1)).rejects.toMatchObject({ code: "outside_schedule" });
    await expect(addAvailabilityException(t.ctx, A, HOME_SPACES.condo, { exceptionDate: "2026-11-18", isBlocked: true })).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("arrival geofence, overstay and incidents", () => {
  it("check-in requires being within 50 m of the bay (no demo shortcut when simulation is off)", async () => {
    const t = setup({ simulated: false });
    const b = await createHomeBooking(t.ctx, A, W1);
    t.advance(35);
    const bay = (await t.repo.getSpace(HOME_SPACES.condo))!.location;
    await expect(recordBookingEvent(t.ctx, A, b.id, { eventType: "arrived", simulateAtSpace: true })).rejects.toMatchObject({ code: "validation" });
    await expect(recordBookingEvent(t.ctx, A, b.id, { eventType: "arrived", location: move(bay, 60) })).rejects.toMatchObject({ code: "outside_geofence" });
    const ok = await recordBookingEvent(t.ctx, A, b.id, { eventType: "arrived", location: move(bay, 45) });
    expect(ok.booking.arrivedAt).toBeTruthy();
    // The stored event point is coarse, not the driver's exact position.
    expect(ok.events[0].location).not.toEqual(move(bay, 45));
  });

  it("departing within the 10-minute grace is free; beyond it, 1.5× for the whole overstay, credited to the host", async () => {
    const t = setup();
    const b = await createHomeBooking(t.ctx, A, W1);
    t.advance(180 + 20); // end (10:00Z) + 20 min
    const r = await recordBookingEvent(t.ctx, A, b.id, { eventType: "departed" });
    expect(r.booking.overstaySurchargeHalalas).toBe(300); // 20 min × 900/h
    expect(r.events.map((e) => e.eventType)).toEqual(["departed", "overstay_flagged"]);
    expect((await t.repo.getCredential(b.id))!.revokedAt).toBeTruthy();
    const dash = await hostDashboard(t.ctx, B);
    expect(dash.stats.hostNetEarnedHalalas).toBe(1020 + 300);

    const t2 = setup();
    const b2 = await createHomeBooking(t2.ctx, A, W1);
    t2.advance(180 + 9);
    expect((await recordBookingEvent(t2.ctx, A, b2.id, { eventType: "departed" })).booking.overstaySurchargeHalalas).toBe(0);
  });

  it("a blocked bay creates an incident event and an audit entry", async () => {
    const t = setup();
    const b = await createHomeBooking(t.ctx, A, W1);
    t.advance(60);
    const r = await recordBookingEvent(t.ctx, A, b.id, { eventType: "bay_blocked_reported", evidenceNote: "Another car is parked in B-14" });
    expect(r.events[0].eventType).toBe("bay_blocked_reported");
    expect((await t.repo.listAudit(5)).some((a) => a.action === "booking.bay_blocked" && a.target.endsWith(b.id))).toBe(true);
  });

  it("extension re-checks the next booking plus its buffer", async () => {
    const t = setup();
    const b = await createHomeBooking(t.ctx, A, W1);
    await createHomeBooking(t.ctx, C, { ...W1, startAt: at("2026-11-17T11:00:00Z"), endAt: at("2026-11-17T12:00:00Z") });
    t.advance(90);
    await expect(recordBookingEvent(t.ctx, A, b.id, { eventType: "extended" })).rejects.toMatchObject({ code: "buffer_conflict" }); // 11:00 end + 15 min buffer
  });
});

describe("payments (PSP webhook domain)", () => {
  it("access waits for 'paid'; replays are idempotent; illegal transitions are refused", async () => {
    const t = setup();
    const b = await createHomeBooking(t.ctx, A, W1);
    await t.repo.updateBooking(b.id, { paymentStatus: "pending" });
    t.advance(31);
    await expect(getBookingAccess(t.ctx, A, b.id)).rejects.toMatchObject({ code: "payment_required" });
    expect((await applyPaymentEvent(t.ctx, { bookingId: b.id, status: "paid", pspReference: "psp_1" })).changed).toBe(true);
    expect((await applyPaymentEvent(t.ctx, { bookingId: b.id, status: "paid", pspReference: "psp_1" })).changed).toBe(false);
    expect((await getBookingAccess(t.ctx, A, b.id)).credential).not.toBeNull();
    await expect(applyPaymentEvent(t.ctx, { bookingId: b.id, status: "failed", pspReference: "psp_1" })).rejects.toMatchObject({ code: "conflict" });
    const refunded = await applyPaymentEvent(t.ctx, { bookingId: b.id, status: "refunded", pspReference: "psp_1" });
    expect(refunded.booking.status).toBe("cancelled");
    expect((await t.repo.getCredential(b.id))!.revokedAt).toBeTruthy();
  });
});
