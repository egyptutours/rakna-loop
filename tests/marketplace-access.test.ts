import { describe, expect, it } from "vitest";
import { createBooking, registerPartner, submitSpace, updateOwnSpace, withinSchedule, type SubmitSpaceInput } from "@/lib/domain/marketplace";
import { decidePartner, decideSpace } from "@/lib/domain/admin";
import { getBalance } from "@/lib/domain/ledger";
import { assertRole } from "@/lib/auth/session";
import { DomainError } from "@/lib/domain/errors";
import { A, ADMIN, B, PARTNER, PENDING_PARTNER, T0, setup } from "./helpers";

const OLAYA_P2 = "00000000-0000-4000-f000-000000000001"; // 12 spots, 8 SAR/h, 06–24 daily, reward-eligible
const VISITOR = "00000000-0000-4000-f000-000000000002"; // Sun–Thu 07–20
const PARKING_20 = "00000000-0000-4000-9000-000000000001";
const OLAYA_50 = "00000000-0000-4000-9000-000000000002";

const space: SubmitSpaceInput = {
  title: "Test Garage",
  titleAr: "",
  location: { lat: 24.7, lng: 46.68 },
  address: "Test St",
  addressAr: "",
  capacity: 2,
  pricePerHour: 10,
  schedule: { days: [0, 1, 2, 3, 4, 5, 6], openHour: 0, closeHour: 24 },
  conditions: "",
  conditionsAr: "",
  rewardEligible: true,
};

// Riyadh 2026-11-17 12:00 (Tuesday) = 09:00Z
const NOON = new Date("2026-11-17T09:00:00.000Z").toISOString();

describe("10. Preventing unauthorized private-space listings", () => {
  it("never lets a driver list a private space", async () => {
    const env = setup();
    await expect(submitSpace(env.ctx, A, space)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("blocks partners that are not yet approved", async () => {
    const env = setup();
    await expect(submitSpace(env.ctx, PENDING_PARTNER, space)).rejects.toMatchObject({ code: "partner_not_approved" });
  });

  it("keeps an approved partner's new space unbookable until an admin approves it", async () => {
    const env = setup();
    const s = await submitSpace(env.ctx, PARTNER, space);
    expect(s.approval).toBe("pending_review");
    await expect(createBooking(env.ctx, A, { spaceId: s.id, startAt: NOON, hours: 1 })).rejects.toMatchObject({ code: "space_not_bookable" });
    await decideSpace(env.ctx, ADMIN, s.id, "approved");
    const b = await createBooking(env.ctx, A, { spaceId: s.id, startAt: NOON, hours: 1 });
    expect(b.status).toBe("confirmed");
    expect(b.simulatedPayment).toBe(true);
  });

  it("refuses to approve a space whose partner isn't approved, and lets partners only manage their own spaces", async () => {
    const env = setup();
    const partnerRow = (await env.repo.listPartners()).find((p) => p.ownerId === PENDING_PARTNER)!;
    const pendingSpace = await env.repo.insertSpace({ ...(await env.repo.getSpace(OLAYA_P2))!, id: crypto.randomUUID(), partnerId: partnerRow.id, approval: "pending_review" });
    await expect(decideSpace(env.ctx, ADMIN, pendingSpace.id, "approved")).rejects.toMatchObject({ code: "partner_not_approved" });
    await expect(updateOwnSpace(env.ctx, PENDING_PARTNER, OLAYA_P2, { rewardEligible: false })).rejects.toMatchObject({ code: "forbidden" });
    const own = await updateOwnSpace(env.ctx, PARTNER, OLAYA_P2, { paused: true });
    expect(own.approval).toBe("paused");
  });

  it("supports the partner application → admin approval flow", async () => {
    const env = setup();
    await env.repo.updatePartner((await env.repo.listPartners()).find((p) => p.ownerId === PENDING_PARTNER)!.id, { status: "rejected" });
    const app = await registerPartner(env.ctx, PENDING_PARTNER, { name: "Hotel", nameAr: "", kind: "hotel", contactEmail: "h@example.invalid", crNumberProvided: true });
    expect(app.status).toBe("pending");
    await expect(registerPartner(env.ctx, A, { name: "x", nameAr: "", kind: "hotel", contactEmail: "x@example.invalid", crNumberProvided: false })).rejects.toMatchObject({ code: "forbidden" });
    const approved = await decidePartner(env.ctx, ADMIN, app.id, "approved");
    expect(approved.status).toBe("approved");
    expect((await submitSpace(env.ctx, PENDING_PARTNER, space)).approval).toBe("pending_review");
  });
});

describe("Private bookings", () => {
  it("rejects bookings outside the schedule and when capacity is full", async () => {
    const env = setup();
    // Visitor deck closes at 20:00 → 19:00 for 2 hours is outside the schedule.
    await expect(createBooking(env.ctx, A, { spaceId: VISITOR, startAt: new Date("2026-11-17T16:00:00.000Z").toISOString(), hours: 2 })).rejects.toMatchObject({ code: "outside_schedule" });
    const s = await submitSpace(env.ctx, PARTNER, { ...space, capacity: 1 });
    await decideSpace(env.ctx, ADMIN, s.id, "approved");
    await createBooking(env.ctx, A, { spaceId: s.id, startAt: NOON, hours: 2 });
    await expect(createBooking(env.ctx, B, { spaceId: s.id, startAt: NOON, hours: 1 })).rejects.toMatchObject({ code: "capacity_full" });
  });

  it("applies an eligible Keys discount and deducts the Keys", async () => {
    const env = setup();
    const b = await createBooking(env.ctx, A, { spaceId: OLAYA_P2, startAt: NOON, hours: 3, rewardId: PARKING_20 });
    expect(b.priceTotal).toBe(24);
    expect(b.discountApplied).toBe(4.8);
    expect(await getBalance(env.ctx, A)).toBe(38 - 15);
    const red = (await env.repo.listRedemptions({ userId: A }))[0];
    expect(red.status).toBe("used");
    expect(red.bookingId).toBe(b.id);
  });

  it("refuses a partner-specific discount at another partner's space or with too few Keys", async () => {
    const env = setup();
    await expect(createBooking(env.ctx, B, { spaceId: OLAYA_P2, startAt: NOON, hours: 1, rewardId: OLAYA_50 })).rejects.toMatchObject({ code: "insufficient_balance" });
    expect(await getBalance(env.ctx, B)).toBe(12);
    expect(await env.repo.listBookings({ userId: B })).toHaveLength(0);
  });

  it("evaluates schedules in Riyadh time", () => {
    const sched = { days: [2], openHour: 9, closeHour: 17 }; // Tuesday 09–17 Riyadh
    expect(withinSchedule(sched, T0, 2)).toBe(true); // T0 = Tue 10:00 Riyadh
    expect(withinSchedule(sched, new Date("2026-11-17T13:30:00.000Z"), 1)).toBe(false); // 16:30 + 1h > 17
    expect(withinSchedule(sched, new Date("2026-11-18T07:00:00.000Z"), 1)).toBe(false); // Wednesday
  });
});

describe("11. Role-based access", () => {
  it("allows only the listed roles", async () => {
    const env = setup();
    const driver = (await env.repo.getProfile(A))!;
    const admin = (await env.repo.getProfile(ADMIN))!;
    const partner = (await env.repo.getProfile(PARTNER))!;
    expect(() => assertRole(admin, ["admin"])).not.toThrow();
    expect(() => assertRole(driver, ["admin"])).toThrow(DomainError);
    expect(() => assertRole(partner, ["driver"])).toThrow(/requires role/);
    try {
      assertRole(driver, ["partner"]);
    } catch (e) {
      expect((e as DomainError).status).toBe(403);
    }
  });

  it("enforces roles inside domain operations too (defence in depth)", async () => {
    const env = setup();
    const { createReport } = await import("@/lib/domain/handoff");
    const { redeemReward } = await import("@/lib/domain/rewards");
    await expect(createReport(env.ctx, ADMIN, { location: { lat: 24.7, lng: 46.68 }, accuracyM: 5, evidence: "gps", departInMinutes: 0 })).rejects.toMatchObject({ code: "forbidden" });
    await expect(createBooking(env.ctx, PARTNER, { spaceId: OLAYA_P2, startAt: NOON, hours: 1 })).rejects.toMatchObject({ code: "forbidden" });
    await expect(redeemReward(env.ctx, PARTNER, "00000000-0000-4000-9000-000000000003")).rejects.toMatchObject({ code: "reward_ineligible" });
  });
});
