import "server-only";
import type { DomainContext } from "../domain/context";
import { availableCapacity, withinSchedule } from "../domain/marketplace";
import { getPlatformSettings, isResidential, metroWalk, spaceAvailability, toPublicSpace } from "../domain/home";
import type { SpaceView } from "./views";

/**
 * Verified private spaces (bookable, or villa waitlist) with live open/free status.
 * Residential spaces leave the server with the ~150 m privacy point and no address.
 */
export async function bookableSpaceViews(ctx: DomainContext, viewer?: { id: string; role: string } | null): Promise<SpaceView[]> {
  const [spaces, partners, settings] = await Promise.all([ctx.repo.listSpaces(), ctx.repo.listPartners(), getPlatformSettings(ctx)]);
  const now = ctx.now();
  const visible = [];
  for (const s of spaces) {
    const availability = await spaceAvailability(ctx, s, settings);
    if (availability !== "hidden") visible.push({ s, availability });
  }
  const rules = visible.length ? await ctx.repo.listAvailabilityRules(visible.map((v) => v.s.id)) : [];
  const out: SpaceView[] = [];
  for (const { s: raw, availability } of visible) {
    const s = toPublicSpace(raw, viewer);
    const p = partners.find((x) => x.id === s.partnerId)!;
    const myRules = rules.filter((r) => r.spaceId === s.id && r.isActive);
    const openNow = availability === "bookable" && withinSchedule(s.schedule, now, 1);
    const freeNow = openNow ? await availableCapacity(ctx, s, now, new Date(now.getTime() + 3_600_000)) : 0;
    out.push({
      id: s.id,
      partnerId: s.partnerId,
      partnerName: isResidential(s) ? "RAKNA HOME" : p.name,
      partnerNameAr: isResidential(s) ? "ركنة هوم" : p.nameAr,
      title: s.title,
      titleAr: s.titleAr,
      location: s.location,
      neighborhood: s.neighborhood,
      address: s.address,
      addressAr: s.addressAr,
      capacity: s.capacity,
      pricePerHour: s.pricePerHour,
      schedule: s.schedule,
      conditions: s.conditions,
      conditionsAr: s.conditionsAr,
      rewardEligible: s.rewardEligible,
      approval: s.approval,
      openNow,
      freeNow,
      isDemo: s.isDemo,
      spaceCategory: s.spaceCategory ?? "commercial",
      shadeTier: s.shadeTier,
      accessMode: s.accessMode ?? "unobstructed",
      bufferMinutes: s.bufferMinutes ?? 0,
      maxHeightCm: s.maxHeightCm ?? null,
      metro: metroWalk(s),
      approximate: isResidential(raw) && s.location !== raw.location,
      waitlist: availability === "waitlist",
      scheduleBooking: myRules.length > 0,
      rules: myRules.map((r) => ({ weekdayMask: r.weekdayMask, startMinute: r.startMinute, endMinute: r.endMinute, hourlyRateHalalas: r.hourlyRateHalalas, dailyCapHalalas: r.dailyCapHalalas, multiDayDiscountBps: r.multiDayDiscountBps })),
    });
  }
  return out;
}