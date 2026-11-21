import type { DepartureReport, HiveIndex, LatLng, Profile, UserReliability } from "../types";
import type { DomainContext } from "../domain/context";
import { computeConfidence, reliabilityFrom, type ConfidenceBreakdown } from "../domain/handoff";
import { coarsen, distanceM } from "../geo";
import { hiveIndexFor, neighborhood, parentOf } from "./cells";
import { signalFreshness } from "./decay";
import { signalReliability, trailFromStats, type Trail } from "./verification";

/**
 * ParkingSignalService — the HIVE RESOURCE SIGNAL ("waggle dance").
 * A structured, privacy-aware description of one community opportunity, delivered
 * to nearby foragers with a plain-language explanation. Never a guarantee.
 */

export interface HiveResourceSignal {
  id: string;
  cell: string; // r10 for participants/admins; r9 for everyone else (privacy)
  cellR9: string;
  location: LatLng; // precise only for the reporter, the claimer and admins
  precise: boolean;
  reportedAt: string;
  expectedDepartureAt: string;
  expiresAt: string;
  status: DepartureReport["status"];
  claim: "unclaimed" | "claimed_by_you" | "claimed_by_other";
  freshness: number; // 0..1, decays (half-life)
  strength: number; // freshness × reliability
  reliability: number; // scout history ⊕ local trail
  confidence: ConfidenceBreakdown;
  verification: { trailScore: number; trailSamples: number; scoutVerified: number; scoutNotFound: number };
  accuracyM: number;
  guaranteed: false;
  bookable: false;
  explanation: { en: string; ar: string };
  isDemo: boolean;
}

export function explainSignal(s: Pick<HiveResourceSignal, "freshness" | "confidence" | "verification" | "status">): { en: string; ar: string } {
  if (s.status === "pending_departure") {
    return { en: "A driver nearby says they are about to leave. It is a heads-up, not a reservation.", ar: "سائق قريب أفاد بأنه على وشك المغادرة. إنها معلومة مسبقة وليست حجزًا." };
  }
  const fresh = s.freshness >= 0.6 ? { en: "was recently reported", ar: "أُبلغ عنها مؤخرًا" } : s.freshness >= 0.3 ? { en: "was reported a few minutes ago", ar: "أُبلغ عنها قبل دقائق" } : { en: "is getting old", ar: "أصبحت قديمة نسبيًا" };
  const conf = { high: { en: "high", ar: "عالية" }, medium: { en: "medium", ar: "متوسطة" }, low: { en: "low", ar: "منخفضة" } }[s.confidence.level];
  const trail = s.verification.trailSamples >= 2
    ? { en: ` Drivers have found spots in this area ${Math.round(s.verification.trailScore * 100)}% of the time recently.`, ar: ` وجد السائقون مواقف في هذه المنطقة بنسبة ${Math.round(s.verification.trailScore * 100)}% مؤخرًا.` }
    : { en: "", ar: "" };
  return {
    en: `This nearby parking opportunity ${fresh.en} and has a ${conf.en} verification confidence.${trail.en} Availability is not guaranteed.`,
    ar: `فرصة الموقف القريبة هذه ${fresh.ar} وثقة التحقق منها ${conf.ar}.${trail.ar} التوفر غير مضمون.`,
  };
}

export async function toHiveSignal(ctx: DomainContext, r: DepartureReport, viewer: Profile | null, viewerLoc?: LatLng | null): Promise<HiveResourceSignal> {
  return (await buildHiveSignals(ctx, [r], viewer, viewerLoc))[0];
}

/**
 * Batched construction (audit F-PERF-4: the per-signal version issued ~4 storage queries
 * PER SIGNAL — an N+1 pattern that becomes N HTTP round trips on Supabase). Everything a
 * page of signals needs is prefetched with a constant number of queries:
 *   1 × scouts' reports (reporter_id IN …), 1 × trail stats for the involved r9 hives,
 *   1 × resolved history in those hives + neighbor rings, plus config/rules.
 */
export async function buildHiveSignals(ctx: DomainContext, reports: DepartureReport[], viewer: Profile | null, viewerLoc?: LatLng | null): Promise<HiveResourceSignal[]> {
  if (reports.length === 0) return [];
  const now = ctx.now();
  const [cfg, rules] = await Promise.all([ctx.repo.getHiveConfig(), ctx.repo.getRules()]);
  const hives = reports.map((r) => r.hive ?? hiveIndexFor(r.location));
  const r9s = [...new Set(hives.map((h) => h.r9))];
  const ring = [...new Set(r9s.flatMap((c) => neighborhood(c, 1)))];
  const since30 = new Date(now.getTime() - 30 * 86_400_000).toISOString();
  const statsSince = new Date(now.getTime() - cfg.statsRetentionDays * 86_400_000).toISOString();
  const [scoutReports, stats, local] = await Promise.all([
    ctx.repo.listReports({ reporterIds: [...new Set(reports.map((r) => r.reporterId))] }),
    ctx.repo.listCellStats(9, r9s, statsSince),
    ctx.repo.listReportsInCells(9, ring, { statuses: ["found", "not_found"] }),
  ]);
  const byReporter = new Map<string, DepartureReport[]>();
  for (const s of scoutReports) (byReporter.get(s.reporterId) ?? byReporter.set(s.reporterId, []).get(s.reporterId)!).push(s);
  const trails = new Map<string, Trail>();
  for (const c of r9s) trails.set(c, trailFromStats(stats.filter((s) => parentOf(s.cell, 9) === c), now, cfg));

  return reports.map((r, i) => {
    const hive = hives[i];
    const trail = trails.get(hive.r9)!;
    const scout = reliabilityFrom(byReporter.get(r.reporterId) ?? []);
    const nearbyHistory = local.filter((x) => x.id !== r.id && x.createdAt >= since30 && distanceM(x.location, r.location) <= 150);
    const confidence = computeConfidence({ report: r, now, rules, reliability: scout, nearbyHistory, viewer: viewerLoc ?? null, trail });
    return assemble(r, hive, viewer, cfg.signalHalfLifeMinutes, now, confidence, trail, scout);
  });
}

function assemble(r: DepartureReport, hive: HiveIndex, viewer: Profile | null, halfLife: number, now: Date, confidence: ConfidenceBreakdown, trail: Trail, scout: UserReliability): HiveResourceSignal {
  const reliability = signalReliability(scout, trail);
  const freshness = Math.round(signalFreshness(r, now, halfLife) * 1000) / 1000;
  const isMine = viewer?.id === r.reporterId;
  const claimedByMe = Boolean(viewer && r.claimedBy === viewer.id);
  const precise = isMine || claimedByMe || viewer?.role === "admin";
  const base = {
    freshness,
    confidence,
    status: r.status,
    verification: { trailScore: Math.round(trail.score * 1000) / 1000, trailSamples: Math.round(trail.samples * 10) / 10, scoutVerified: scout.successful, scoutNotFound: scout.notFound },
  };
  return {
    id: r.id,
    // Privacy (audit F-PRIV-2): an r10 cell (~65 m) is MORE precise than the ~110 m coarsened
    // position, so non-participants only ever receive the r9 (~320 m) cell.
    cell: precise ? hive.r10 : hive.r9,
    cellR9: hive.r9,
    location: precise ? r.location : coarsen(r.location),
    precise,
    reportedAt: r.createdAt,
    expectedDepartureAt: r.expectedDepartureAt,
    expiresAt: r.expiresAt,
    claim: r.status !== "claimed" ? "unclaimed" : claimedByMe ? "claimed_by_you" : "claimed_by_other",
    strength: Math.round(freshness * reliability * 1000) / 1000,
    reliability,
    accuracyM: r.accuracyM,
    guaranteed: false,
    bookable: false,
    explanation: explainSignal(base),
    isDemo: r.isDemo,
    ...base,
  };
}
