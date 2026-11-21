import type { HiveState, LatLng, Profile } from "../types";
import type { DomainContext } from "../domain/context";
import { refreshReport } from "../domain/handoff";
import { availableCapacity, isSpaceBookable, withinSchedule } from "../domain/marketplace";
import { distanceM } from "../geo";
import { hiveIndexFor, neighborhood } from "./cells";
import { summarizeCells, type CellSummary } from "./aggregation";
import { buildHiveSignals, type HiveResourceSignal } from "./signals";
import { DEMO_TRANSIT_POINTS } from "./transit";

/**
 * SwarmIntelligenceService — local rules, collective outcome.
 *  • Local recruitment: search the forager's own hive first, then expand ring by ring
 *    (like a forager recruited to the nearest rich patch), stopping once enough
 *    opportunities are found.
 *  • Fairness: a per-cell diversity cap stops one busy hive from crowding out valid
 *    opportunities in quieter hives; cell popularity is never a scoring input.
 *  • Balancing: when the forager's hive is HIGH DEMAND / OVERLOADED, neighboring hives
 *    with spare supply, authorized private parking and transit alternatives are surfaced.
 *  • Safety: no task ever asks anyone to drive somewhere to earn points.
 */

export type ActivityRole = "scout" | "forager" | "verifier" | "steward";

export async function activityRoleFor(ctx: DomainContext, user: Profile | null): Promise<ActivityRole> {
  if (!user) return "forager";
  if (user.role === "partner" || user.role === "admin") return "steward";
  const recent = await ctx.repo.listReports({ reporterId: user.id, sinceIso: new Date(ctx.now().getTime() - 3 * 3_600_000).toISOString() });
  if (recent.some((r) => ["pending_departure", "available", "claimed"].includes(r.status))) return "scout";
  const claims = await ctx.repo.listClaims({ claimerId: user.id });
  if (claims.some((c) => c.active)) return "verifier";
  return "forager";
}

export interface RecruitedOpportunity {
  signal: HiveResourceSignal;
  distanceM: number;
  ring: number;
  score: number;
}

export interface PrivateAlternative {
  id: string;
  title: string;
  titleAr: string;
  location: LatLng;
  distanceM: number;
  pricePerHour: number;
  freeNow: number;
  accessibleBays: number;
  reason: { en: string; ar: string };
}

export interface RecruitmentResult {
  home: CellSummary;
  homeCell: string;
  opportunities: RecruitedOpportunity[];
  neighborAlternatives: { cell: string; state: HiveState; supplyStrength: number; privateFree: number; ring: number }[];
  privateAlternatives: PrivateAlternative[];
  transitAlternatives: { name: string; nameAr: string; location: LatLng; distanceM: number; illustrative: true }[];
  advice: { en: string; ar: string }[];
  ringsSearched: number;
}

/** Greedy pick with a per-cell cap, then fill any remaining slots without the cap. */
export function diversify<T extends { cell: string; score: number }>(items: T[], limit: number, perCellCap: number): T[] {
  const sorted = [...items].sort((a, b) => b.score - a.score);
  const picked: T[] = [];
  const perCell = new Map<string, number>();
  for (const it of sorted) {
    if (picked.length >= limit) break;
    const n = perCell.get(it.cell) ?? 0;
    if (n >= perCellCap) continue;
    perCell.set(it.cell, n + 1);
    picked.push(it);
  }
  for (const it of sorted) {
    if (picked.length >= limit) break;
    if (!picked.includes(it)) picked.push(it);
  }
  return picked;
}

export async function recruit(
  ctx: DomainContext,
  input: { location: LatLng; viewer: Profile | null; accessibleOnly?: boolean; maxWalkM?: number; limit?: number },
): Promise<RecruitmentResult> {
  const cfg = await ctx.repo.getHiveConfig();
  const home = hiveIndexFor(input.location).r9;
  const limit = input.limit ?? 6;
  const maxWalk = input.maxWalkM ?? 800;

  // Ring-by-ring local recruitment at r9.
  const ringOf = new Map<string, number>();
  let found: RecruitedOpportunity[] = [];
  let ringsSearched = 0;
  for (let k = 0; k <= cfg.recruitmentMaxRings; k++) {
    ringsSearched = k;
    const disk = neighborhood(home, k);
    const newCells = disk.filter((c) => !ringOf.has(c));
    newCells.forEach((c) => ringOf.set(c, k));
    const raw = await ctx.repo.listReportsInCells(9, newCells, { statuses: ["available", "pending_departure"] });
    const fresh = (await Promise.all(raw.map((r0) => refreshReport(ctx, r0)))).filter((r) => ["available", "pending_departure"].includes(r.status) && r.reporterId !== input.viewer?.id);
    const signals = await buildHiveSignals(ctx, fresh, input.viewer, input.location); // batched, not per signal
    for (let i = 0; i < fresh.length; i++) {
      const r = fresh[i];
      const signal = signals[i];
      const d = distanceM(input.location, r.location);
      // Score: strength (fresh × reliable) and proximity. Never the cell's popularity.
      const proximity = Math.max(0, 1 - d / 3000);
      found.push({ signal, distanceM: Math.round(d), ring: k, score: Math.round((0.65 * signal.strength + 0.35 * proximity) * 1000) / 1000 });
    }
    if (found.length >= limit) break;
  }
  found = diversify(found.map((o) => ({ ...o, cell: o.signal.cellR9 })), limit, cfg.perCellDiversityCap);

  // Hive states for home + neighbors (balancing).
  const ringCells = [...ringOf.keys()];
  const summaries = await summarizeCells(ctx, 9, ringCells);
  const homeSummary = summaries.get(home)!;
  const neighborAlternatives = [...summaries.values()]
    .filter((s) => s.cell !== home && (s.state === "resource_rich" || (s.state === "active" && s.supply.strength + s.supply.privateFree > 0)))
    .map((s) => ({ cell: s.cell, state: s.state, supplyStrength: s.supply.strength, privateFree: s.supply.privateFree, ring: ringOf.get(s.cell) ?? 0 }))
    .sort((a, b) => a.ring - b.ring || b.supplyStrength + b.privateFree * 0.2 - (a.supplyStrength + a.privateFree * 0.2))
    .slice(0, 4);

  // Authorized private parking within walking range (bookable subject to availability).
  const spaces = await ctx.repo.listSpacesInCells(9, ringCells);
  const now = ctx.now();
  const privateAlternatives: PrivateAlternative[] = [];
  for (const s of spaces) {
    if (!(await isSpaceBookable(ctx, s)) || !withinSchedule(s.schedule, now, 1)) continue;
    const free = await availableCapacity(ctx, s, now, new Date(now.getTime() + 3_600_000));
    const d = distanceM(input.location, s.location);
    if (free <= 0 || d > maxWalk * 2.5) continue;
    if (input.accessibleOnly && !(s.accessibleBays && s.accessibleBays > 0)) continue;
    privateAlternatives.push({
      id: s.id, title: s.title, titleAr: s.titleAr, location: s.location, distanceM: Math.round(d), pricePerHour: s.pricePerHour, freeNow: free, accessibleBays: s.accessibleBays ?? 0,
      reason: s.accessibleBays
        ? { en: `Approved private parking ${Math.round(d)} m away with ${s.accessibleBays} accessible bay(s). Bookable subject to availability.`, ar: `موقف خاص معتمد على بُعد ${Math.round(d)} م مع ${s.accessibleBays} موقف لذوي الإعاقة. قابل للحجز حسب التوفر.` }
        : { en: `Approved private parking ${Math.round(d)} m away. Bookable subject to availability.`, ar: `موقف خاص معتمد على بُعد ${Math.round(d)} م. قابل للحجز حسب التوفر.` },
    });
  }
  privateAlternatives.sort((a, b) => a.distanceM - b.distanceM);

  const strained = homeSummary.state === "high_demand" || homeSummary.state === "overloaded";
  // Illustrative transit points are DEMO DATA: never shown outside demo mode (audit F-DEMO-1).
  const transitAlternatives = ctx.allowSimulatedEvidence && (strained || found.length === 0)
    ? DEMO_TRANSIT_POINTS.map((t) => ({ ...t, distanceM: Math.round(distanceM(input.location, t.location)), illustrative: true as const })).filter((t) => t.distanceM <= 3000).sort((a, b) => a.distanceM - b.distanceM).slice(0, 2)
    : [];

  const advice: RecruitmentResult["advice"] = [];
  if (strained) {
    advice.push({ en: "This hive has more searches than verified spots right now. Rather than circling, consider the nearby options below.", ar: "هذه الخلية فيها طلبات بحث أكثر من المواقف الموثقة حاليًا. بدل الدوران، فكّر في الخيارات القريبة أدناه." });
  }
  if (found.length === 0) advice.push({ en: "No live community signals nearby. Private parking or transit may save you a search.", ar: "لا توجد إشارات مجتمعية حية قريبة. قد توفر عليك المواقف الخاصة أو النقل العام عناء البحث." });
  advice.push({ en: "Please don't use the app while driving. Pull over safely or ask a passenger.", ar: "لا تستخدم التطبيق أثناء القيادة. توقف بأمان أو اطلب من مرافق." });

  return {
    home: homeSummary, homeCell: home, opportunities: found, neighborAlternatives, privateAlternatives: privateAlternatives.slice(0, 3), transitAlternatives, advice, ringsSearched,
  };
}
