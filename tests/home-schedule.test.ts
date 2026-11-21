import { describe, expect, it } from "vitest";
import {
  baseFare,
  chargeForMinutes,
  checkCoverage,
  collidesWithBuffer,
  computeFare,
  daysFromMask,
  illustrativeMonthlyNetHalalas,
  keysDiscountForReward,
  maskFromDays,
  maskHasDay,
  overstaySurcharge,
  segmentsByRiyadhDay,
  SUN_THU_MASK,
  validateRule,
  withinGeofence,
} from "@/lib/domain/home-schedule";
import type { AvailabilityException, AvailabilityRule } from "@/lib/types";
import { move } from "./helpers";

/** Pure RAKNA HOME scheduling & integer-halalas pricing. Riyadh = UTC+3 (no DST). */

const rule = (o: Partial<AvailabilityRule> = {}): AvailabilityRule => ({
  id: "r", spaceId: "s", weekdayMask: SUN_THU_MASK, startMinute: 7 * 60, endMinute: 18 * 60, hourlyRateHalalas: 600, dailyCapHalalas: 4000, multiDayDiscountBps: 0, isActive: true, createdAt: "", ...o,
});
const ex = (o: Partial<AvailabilityException>): AvailabilityException => ({ id: "e", spaceId: "s", exceptionDate: "2026-11-17", isBlocked: true, overrideStartMinute: null, overrideEndMinute: null, ...o });
/** Riyadh local "YYYY-MM-DDTHH:MM" → UTC ms. */
const riyadh = (s: string) => Date.parse(`${s}:00+03:00`);

describe("weekday masks", () => {
  it("round-trips days ↔ mask (bit 0 = Sunday)", () => {
    expect(maskFromDays([0, 1, 2, 3, 4])).toBe(31);
    expect(SUN_THU_MASK).toBe(31);
    expect(daysFromMask(96)).toEqual([5, 6]);
    expect(maskHasDay(31, 4)).toBe(true);
    expect(maskHasDay(31, 5)).toBe(false);
  });
});

describe("segmentsByRiyadhDay", () => {
  it("splits a window at Riyadh midnight (not UTC midnight)", () => {
    const segs = segmentsByRiyadhDay(riyadh("2026-11-17T22:00"), riyadh("2026-11-18T02:00"));
    expect(segs.map((s) => [s.date, s.day, s.startMinute, s.endMinute])).toEqual([
      ["2026-11-17", 2, 22 * 60, 1440],
      ["2026-11-18", 3, 0, 120],
    ]);
  });
});

describe("checkCoverage", () => {
  const rules = [rule(), rule({ weekdayMask: 96, startMinute: 0, endMinute: 1440, hourlyRateHalalas: 500 })];

  it("accepts a window inside the weekday rule and prices it by that rule", () => {
    const c = checkCoverage(rules, [], riyadh("2026-11-17T11:00"), riyadh("2026-11-17T13:00"));
    expect(c.ok).toBe(true);
    expect(c.pricing[0].rule.hourlyRateHalalas).toBe(600);
  });

  it("rejects a window that runs past closing time", () => {
    expect(checkCoverage(rules, [], riyadh("2026-11-17T17:00"), riyadh("2026-11-17T19:00"))).toMatchObject({ ok: false, reason: "outside_hours" });
  });

  it("covers Thu evening → Fri only if every day-segment is inside a rule", () => {
    // Thursday closes 18:00, so Thu 20:00 → Fri 10:00 fails on the Thursday segment.
    expect(checkCoverage(rules, [], riyadh("2026-11-19T20:00"), riyadh("2026-11-20T10:00")).ok).toBe(false);
    // Friday all day + Saturday all day: two segments, both weekend-priced.
    const c = checkCoverage(rules, [], riyadh("2026-11-20T10:00"), riyadh("2026-11-21T10:00"));
    expect(c.ok).toBe(true);
    expect(c.pricing.map((p) => p.rule.hourlyRateHalalas)).toEqual([500, 500]);
  });

  it("a blocked exception closes the whole date; an override replaces the hours", () => {
    expect(checkCoverage(rules, [ex({})], riyadh("2026-11-17T11:00"), riyadh("2026-11-17T12:00"))).toMatchObject({ ok: false, reason: "blocked_date" });
    const override = ex({ isBlocked: false, overrideStartMinute: 9 * 60, overrideEndMinute: 12 * 60 });
    expect(checkCoverage(rules, [override], riyadh("2026-11-17T09:30"), riyadh("2026-11-17T11:30")).ok).toBe(true);
    expect(checkCoverage(rules, [override], riyadh("2026-11-17T11:00"), riyadh("2026-11-17T13:00")).ok).toBe(false);
  });

  it("no active rules → not bookable", () => {
    expect(checkCoverage([rule({ isActive: false })], [], riyadh("2026-11-17T11:00"), riyadh("2026-11-17T12:00"))).toMatchObject({ ok: false, reason: "no_rules" });
  });
});

describe("integer-halalas charges", () => {
  it("time charges round UP to the next halala (never undercharge the host)", () => {
    expect(chargeForMinutes(60, 600)).toBe(600);
    expect(chargeForMinutes(61, 600)).toBe(610);
    expect(chargeForMinutes(1, 100)).toBe(2); // 1.67 → 2
    expect(chargeForMinutes(0, 600)).toBe(0);
  });

  it("caps each 24-hour block at the daily cap", () => {
    const c = checkCoverage([rule()], [], riyadh("2026-11-17T07:00"), riyadh("2026-11-17T18:00"));
    expect(baseFare(c.pricing, riyadh("2026-11-17T07:00"), riyadh("2026-11-17T18:00"))).toBe(4000); // 11 h × 600 = 6600 → cap 4000
  });

  it("applies the multi-day discount (bps) for bookings of 5+ days", () => {
    const allDay = rule({ weekdayMask: 127, startMinute: 0, endMinute: 1440, hourlyRateHalalas: 500, dailyCapHalalas: 3000, multiDayDiscountBps: 1000 });
    const s = riyadh("2026-11-17T00:00");
    const e4 = s + 4 * 86_400_000;
    const e5 = s + 5 * 86_400_000;
    expect(baseFare(checkCoverage([allDay], [], s, e4).pricing, s, e4)).toBe(12_000);
    expect(baseFare(checkCoverage([allDay], [], s, e5).pricing, s, e5)).toBe(13_500); // 15 000 − 10 %
  });
});

describe("computeFare — split and the RAKNA KEYS value firewall", () => {
  it("splits 5% driver fee, 15% host commission, 15% VAT on the platform fee only", () => {
    expect(computeFare(1000)).toEqual({
      baseFareHalalas: 1000, driverFeeHalalas: 50, hostCommissionHalalas: 150, vatOnPlatformFeeHalalas: 30,
      keysDiscountHalalas: 0, hostNetPayoutHalalas: 850, driverTotalHalalas: 1080,
    });
  });

  it("caps Keys at 20% of the platform fee, reduces VAT accordingly, and never touches the host payout", () => {
    const f = computeFare(1000, 1000);
    expect(f.keysDiscountHalalas).toBe(40); // 20% × (50 + 150)
    expect(f.vatOnPlatformFeeHalalas).toBe(24); // 15% × (200 − 40)
    expect(f.hostNetPayoutHalalas).toBe(850);
    expect(f.driverTotalHalalas).toBe(1000 + 50 + 24 - 40);
  });

  it("holds the invariants for many bases and discount requests (all integers)", () => {
    for (let base = 0; base <= 50_000; base += 137) {
      for (const req of [0, 1, 7, 99, 10_000]) {
        const f = computeFare(base, req);
        for (const v of Object.values(f)) expect(Number.isInteger(v) && v >= 0).toBe(true);
        expect(f.hostNetPayoutHalalas).toBe(base - f.hostCommissionHalalas);
        expect(f.keysDiscountHalalas * 5).toBeLessThanOrEqual(f.driverFeeHalalas + f.hostCommissionHalalas);
        expect(f.driverTotalHalalas).toBe(base + f.driverFeeHalalas + f.vatOnPlatformFeeHalalas - f.keysDiscountHalalas);
      }
    }
  });

  it("rounds odd amounts half-up and rejects non-integer bases", () => {
    const f = computeFare(333);
    expect(f.driverFeeHalalas).toBe(17); // 16.65
    expect(f.hostCommissionHalalas).toBe(50); // 49.95
    expect(() => computeFare(10.5)).toThrow();
    expect(() => computeFare(-1)).toThrow();
  });

  it("a reward's percentage applies to the platform fee (then the 20% cap)", () => {
    expect(keysDiscountForReward(1200, 20)).toBe(48); // 20% × 240
    expect(computeFare(1200, keysDiscountForReward(1200, 50)).keysDiscountHalalas).toBe(48); // 120 requested → capped
  });
});

describe("turnaround buffer", () => {
  const h = 3_600_000;
  it("treats bookings closer than the buffer as colliding", () => {
    expect(collidesWithBuffer(0, 2 * h, 2 * h + 10 * 60_000, 3 * h, 15)).toBe(true);
    expect(collidesWithBuffer(0, 2 * h, 2 * h + 15 * 60_000, 3 * h, 15)).toBe(false);
    expect(collidesWithBuffer(0, 2 * h, 2 * h, 3 * h, 0)).toBe(false);
  });
});

describe("overstay (1.5× after a 10-minute grace)", () => {
  const end = riyadh("2026-11-17T13:00");
  it("is free within the grace period", () => {
    expect(overstaySurcharge(end, end + 10 * 60_000, 600)).toEqual({ minutes: 0, surchargeHalalas: 0 });
  });
  it("charges the WHOLE overstay at 1.5× once past the grace", () => {
    expect(overstaySurcharge(end, end + 11 * 60_000, 600)).toEqual({ minutes: 11, surchargeHalalas: 165 }); // 11 × 900 / 60
    expect(overstaySurcharge(end, end + 20 * 60_000, 600)).toEqual({ minutes: 20, surchargeHalalas: 300 });
  });
  it("leaving early is never charged", () => {
    expect(overstaySurcharge(end, end - 30 * 60_000, 600).surchargeHalalas).toBe(0);
  });
});

describe("geofenced arrival (≤ 50 m)", () => {
  const bay = { lat: 24.72452, lng: 46.66804 };
  it("accepts 49 m and rejects 51 m", () => {
    expect(withinGeofence(move(bay, 49), bay).ok).toBe(true);
    const far = withinGeofence(move(bay, 0, 51), bay);
    expect(far.ok).toBe(false);
    expect(far.distanceM).toBe(51);
  });
});

describe("validation and estimates", () => {
  it("validateRule rejects bad masks, windows, rates and discounts", () => {
    expect(validateRule(rule())).toBeNull();
    expect(validateRule(rule({ weekdayMask: 0 }))).toMatch(/mask/);
    expect(validateRule(rule({ endMinute: 7 * 60 }))).toMatch(/end/);
    expect(validateRule(rule({ hourlyRateHalalas: 12.5 }))).toMatch(/rate/);
    expect(validateRule(rule({ multiDayDiscountBps: 6000 }))).toMatch(/discount/);
  });
  it("illustrative earnings are host-net (after 15% commission) and integer", () => {
    const v = illustrativeMonthlyNetHalalas([rule()]);
    expect(Number.isInteger(v)).toBe(true);
    // 5 days × min(6600, 4000) × 13/3 weeks × 30% = 26 000 gross → 22 100 net
    expect(v).toBe(22_100);
  });
});
