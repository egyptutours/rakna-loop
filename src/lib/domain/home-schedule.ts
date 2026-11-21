import type { AvailabilityException, AvailabilityRule, EntitlementType, FareBreakdown, LatLng, SpaceCategory } from "../types";
import { HOME_FEES } from "../config";
import { distanceM } from "../geo";

/**
 * RAKNA HOME scheduling & pricing — PURE functions (no I/O), fully unit-tested.
 *
 * Money is ALWAYS integer halalas (1 SAR = 100 halalas). Every division rounds with an
 * explicit, documented rule so results are deterministic:
 *   • time-based charges round UP to the next halala (ceil) — never undercharge the host;
 *   • percentage splits use round-half-up on integers (Math.round of a non-negative
 *     rational), and the Keys cap rounds DOWN (floor) — never over-discount.
 * Times are evaluated in Riyadh local time (UTC+3, no DST).
 */

/**
 * Saudi entitlement rules: which ownership/authorization may list which space category.
 * Mirrored in SQL by parking_spaces_entitlement_chk (migration 0007).
 *  • Villa / deeded condo bays: title-deed owner, owner's wakalah, or an Ejar tenant
 *    (tenants additionally attest written landlord consent + no sub-let prohibition).
 *  • Common-property building bays belong to the building: owners' association ONLY.
 *  • Commercial parking: commercial registration (CR).
 */
export const ALLOWED_ENTITLEMENTS: Record<SpaceCategory, EntitlementType[]> = {
  villa_shaded: ["deed_owner", "owner_wakalah", "ejar_authorized"],
  villa_open: ["deed_owner", "owner_wakalah", "ejar_authorized"],
  villa_garage: ["deed_owner", "owner_wakalah", "ejar_authorized"],
  condo_deeded: ["deed_owner", "owner_wakalah", "ejar_authorized"],
  condo_association: ["owners_association"],
  commercial: ["commercial_cr"],
};

const RIYADH_OFFSET_MS = 3 * 3_600_000;
const DAY_MS = 86_400_000;

export const DAY_BITS = [1, 2, 4, 8, 16, 32, 64] as const; // Sun … Sat

export function maskHasDay(mask: number, day: number): boolean {
  return (mask & (1 << day)) !== 0;
}

export function maskFromDays(days: number[]): number {
  return days.reduce((m, d) => m | (1 << d), 0);
}

export function daysFromMask(mask: number): number[] {
  return [0, 1, 2, 3, 4, 5, 6].filter((d) => maskHasDay(mask, d));
}

/** Sun–Thu (Saudi working week). */
export const SUN_THU_MASK = maskFromDays([0, 1, 2, 3, 4]);

export interface DaySegment {
  date: string; // YYYY-MM-DD (Riyadh)
  day: number; // 0 = Sunday
  startMinute: number; // within the Riyadh day
  endMinute: number; // ≤ 1440
  startMs: number; // absolute UTC ms of the segment start
}

export function riyadhDateString(ms: number): string {
  return new Date(ms + RIYADH_OFFSET_MS).toISOString().slice(0, 10);
}

/** Split [start, end) into pieces that never cross a Riyadh midnight. */
export function segmentsByRiyadhDay(startMs: number, endMs: number): DaySegment[] {
  const out: DaySegment[] = [];
  let t = startMs;
  while (t < endMs) {
    const local = t + RIYADH_OFFSET_MS;
    const dayStartLocal = Math.floor(local / DAY_MS) * DAY_MS;
    const nextMidnightUtc = dayStartLocal + DAY_MS - RIYADH_OFFSET_MS;
    const segEnd = Math.min(endMs, nextMidnightUtc);
    const startMinute = Math.round((local - dayStartLocal) / 60_000);
    out.push({
      date: new Date(dayStartLocal).toISOString().slice(0, 10),
      day: new Date(dayStartLocal).getUTCDay(),
      startMinute,
      endMinute: startMinute + Math.round((segEnd - t) / 60_000),
      startMs: t,
    });
    t = segEnd;
  }
  return out;
}

export interface CoverageResult {
  ok: boolean;
  reason?: "blocked_date" | "outside_hours" | "no_rules";
  /** The rule that prices each segment (same order as segments). */
  pricing: { segment: DaySegment; rule: AvailabilityRule }[];
}

/**
 * Is [start, end) inside the space's availability?
 *  • an exception with isBlocked=true closes that whole Riyadh date;
 *  • an exception with override minutes REPLACES the opening hours for that date (priced by
 *    the day's matching rule, or the space's first active rule);
 *  • otherwise each day-segment must sit inside one active rule whose weekday mask includes
 *    that day.
 */
export function checkCoverage(rules: AvailabilityRule[], exceptions: AvailabilityException[], startMs: number, endMs: number): CoverageResult {
  const active = rules.filter((r) => r.isActive);
  if (active.length === 0) return { ok: false, reason: "no_rules", pricing: [] };
  const pricing: CoverageResult["pricing"] = [];
  for (const seg of segmentsByRiyadhDay(startMs, endMs)) {
    const ex = exceptions.find((e) => e.exceptionDate === seg.date);
    if (ex?.isBlocked) return { ok: false, reason: "blocked_date", pricing: [] };
    if (ex && ex.overrideStartMinute !== null && ex.overrideEndMinute !== null) {
      if (seg.startMinute < ex.overrideStartMinute || seg.endMinute > ex.overrideEndMinute) return { ok: false, reason: "outside_hours", pricing: [] };
      pricing.push({ segment: seg, rule: active.find((r) => maskHasDay(r.weekdayMask, seg.day)) ?? active[0] });
      continue;
    }
    const rule = active.find((r) => maskHasDay(r.weekdayMask, seg.day) && r.startMinute <= seg.startMinute && seg.endMinute <= r.endMinute);
    if (!rule) return { ok: false, reason: "outside_hours", pricing: [] };
    pricing.push({ segment: seg, rule });
  }
  return { ok: true, pricing };
}

/** ceil(minutes × hourly / 60) in integer arithmetic. */
export function chargeForMinutes(minutes: number, hourlyRateHalalas: number): number {
  return Math.floor((minutes * hourlyRateHalalas + 59) / 60);
}

/**
 * Base fare: per 24-hour block counted from the booking start, the sum of segment charges is
 * capped at the block's daily cap (the lowest cap among the rules used in that block). If the
 * booking lasts ≥ 5 days, the multi-day discount (bps of the first rule) is applied.
 */
export function baseFare(pricing: CoverageResult["pricing"], startMs: number, endMs: number): number {
  const blocks = new Map<number, { sum: number; cap: number | null }>();
  for (const { segment, rule } of pricing) {
    const segEnd = segment.startMs + (segment.endMinute - segment.startMinute) * 60_000;
    let t = segment.startMs;
    while (t < segEnd) {
      const block = Math.floor((t - startMs) / DAY_MS);
      const blockEnd = startMs + (block + 1) * DAY_MS;
      const pieceEnd = Math.min(segEnd, blockEnd);
      const minutes = Math.round((pieceEnd - t) / 60_000);
      const b = blocks.get(block) ?? { sum: 0, cap: null };
      b.sum += chargeForMinutes(minutes, rule.hourlyRateHalalas);
      if (rule.dailyCapHalalas !== null) b.cap = b.cap === null ? rule.dailyCapHalalas : Math.min(b.cap, rule.dailyCapHalalas);
      blocks.set(block, b);
      t = pieceEnd;
    }
  }
  let total = 0;
  for (const b of blocks.values()) total += b.cap === null ? b.sum : Math.min(b.sum, b.cap);
  const durationDays = (endMs - startMs) / DAY_MS;
  const bps = pricing[0]?.rule.multiDayDiscountBps ?? 0;
  if (durationDays >= HOME_FEES.multiDayThresholdDays && bps > 0) total -= Math.floor((total * bps) / 10_000);
  return total;
}

const pct = (amount: number, bps: number) => Math.round((amount * bps) / 10_000);

/**
 * Fare split + RAKNA KEYS value firewall.
 *  driver fee 5% · host commission 15% · VAT 15% on the platform fee (after any Keys discount,
 *  which reduces the platform's consideration) · Keys discount ≤ 20% of the platform fee.
 *  host_net_payout = base − host commission, ALWAYS — Keys never touch the host's money and
 *  are never convertible to cash.
 */
export function computeFare(baseFareHalalas: number, requestedKeysDiscountHalalas = 0): FareBreakdown {
  if (!Number.isInteger(baseFareHalalas) || baseFareHalalas < 0) throw new Error("base fare must be a non-negative integer (halalas)");
  const driverFee = pct(baseFareHalalas, HOME_FEES.driverFeeBps);
  const hostCommission = pct(baseFareHalalas, HOME_FEES.hostCommissionBps);
  const platformFee = driverFee + hostCommission;
  const maxKeys = Math.floor((platformFee * HOME_FEES.keysMaxDiscountOfPlatformFeeBps) / 10_000);
  const keys = Math.max(0, Math.min(Math.floor(requestedKeysDiscountHalalas), maxKeys));
  const vat = pct(platformFee - keys, HOME_FEES.vatBps);
  return {
    baseFareHalalas,
    driverFeeHalalas: driverFee,
    hostCommissionHalalas: hostCommission,
    vatOnPlatformFeeHalalas: vat,
    keysDiscountHalalas: keys,
    hostNetPayoutHalalas: baseFareHalalas - hostCommission,
    driverTotalHalalas: baseFareHalalas + driverFee + vat - keys,
  };
}

/** Keys reward → requested discount: a percentage of the PLATFORM fee (cap enforced in computeFare). */
export function keysDiscountForReward(baseFareHalalas: number, discountPercent: number): number {
  const platformFee = pct(baseFareHalalas, HOME_FEES.driverFeeBps) + pct(baseFareHalalas, HOME_FEES.hostCommissionBps);
  return Math.floor((platformFee * Math.max(0, Math.min(100, discountPercent))) / 100);
}

/** Two intervals collide if they overlap once each is padded by the turnaround buffer. */
export function collidesWithBuffer(aStart: number, aEnd: number, bStart: number, bEnd: number, bufferMinutes: number): boolean {
  const pad = bufferMinutes * 60_000;
  return aStart < bEnd + pad && bStart < aEnd + pad;
}

/**
 * Overstay: departing within the 10-minute grace is free; beyond it the WHOLE overstay since
 * end_at is charged at 1.5× the hourly rate (rounded up), credited 100% to the host.
 */
export function overstaySurcharge(endMs: number, departedMs: number, hourlyRateHalalas: number): { minutes: number; surchargeHalalas: number } {
  const over = Math.max(0, Math.ceil((departedMs - endMs) / 60_000));
  if (over <= HOME_FEES.overstayGraceMinutes) return { minutes: 0, surchargeHalalas: 0 };
  const rate = Math.floor((hourlyRateHalalas * HOME_FEES.overstayMultiplierBps + 9_999) / 10_000);
  return { minutes: over, surchargeHalalas: chargeForMinutes(over, rate) };
}

export function withinGeofence(point: LatLng, target: LatLng, radiusM: number = HOME_FEES.arrivalGeofenceM): { ok: boolean; distanceM: number } {
  const d = distanceM(point, target);
  return { ok: d <= radiusM, distanceM: Math.round(d) };
}

/** Illustrative weekly earnings (host dashboard / waitlist): clearly an estimate, not a promise. */
export function illustrativeMonthlyNetHalalas(rules: AvailabilityRule[], assumedUtilizationBps = 3000): number {
  let weekly = 0;
  for (const r of rules.filter((x) => x.isActive)) {
    const days = daysFromMask(r.weekdayMask).length;
    const perDay = chargeForMinutes(r.endMinute - r.startMinute, r.hourlyRateHalalas);
    weekly += days * (r.dailyCapHalalas !== null ? Math.min(perDay, r.dailyCapHalalas) : perDay);
  }
  const gross = Math.floor((weekly * 13 * assumedUtilizationBps) / (3 * 10_000)); // ≈ 4.33 weeks/month
  return gross - pct(gross, HOME_FEES.hostCommissionBps);
}

export function validateRule(r: Pick<AvailabilityRule, "weekdayMask" | "startMinute" | "endMinute" | "hourlyRateHalalas" | "dailyCapHalalas" | "multiDayDiscountBps">): string | null {
  if (!Number.isInteger(r.weekdayMask) || r.weekdayMask < 1 || r.weekdayMask > 127) return "weekday mask must be 1–127";
  if (!Number.isInteger(r.startMinute) || r.startMinute < 0 || r.startMinute > 1439) return "start minute must be 0–1439";
  if (!Number.isInteger(r.endMinute) || r.endMinute < 1 || r.endMinute > 1440 || r.endMinute <= r.startMinute) return "end minute must be after start (≤ 1440)";
  if (!Number.isInteger(r.hourlyRateHalalas) || r.hourlyRateHalalas <= 0 || r.hourlyRateHalalas > 100_000) return "hourly rate must be a positive integer of halalas";
  if (r.dailyCapHalalas !== null && (!Number.isInteger(r.dailyCapHalalas) || r.dailyCapHalalas <= 0)) return "daily cap must be a positive integer of halalas";
  if (!Number.isInteger(r.multiDayDiscountBps) || r.multiDayDiscountBps < 0 || r.multiDayDiscountBps > 5000) return "multi-day discount must be 0–5000 bps";
  return null;
}

export function halalasToSar(h: number): number {
  return h / 100;
}
