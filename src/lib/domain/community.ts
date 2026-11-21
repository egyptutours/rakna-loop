import type { ChallengeMetric, DepartureReport, MobilityMission, NeighborhoodChallenge, Profile } from "../types";
import { DomainError } from "./errors";
import { daysAgo, iso, newId, riyadhDayStart, type DomainContext } from "./context";
import { awardPoints } from "./ledger";
import { reliabilityFrom } from "./handoff";

/**
 * Neighborhood challenges, badges and leaderboards. Progress counts ONLY verified
 * outcomes (accepted handoffs, approved missions) — never taps, views, or movement —
 * so nothing rewards meaningless repetition or unnecessary driving.
 */

export type BadgeId = "first_helper" | "reliable_driver" | "parking_explorer" | "community_champion" | "mobility_hero";

export interface Badge {
  id: BadgeId;
  earned: boolean;
  progress: number;
  target: number;
}

interface Activity {
  foundAsReporter: DepartureReport[];
  acceptedFoundConfirmations: { reportId: string; neighborhood: string; createdAt: string }[];
  approvedMissions: MobilityMission[];
  allMyReports: DepartureReport[];
}

async function activityFor(ctx: DomainContext, userId: string): Promise<Activity> {
  const [mine, confirmations, missions, allReports] = await Promise.all([
    ctx.repo.listReports({ reporterId: userId }),
    ctx.repo.listConfirmations({ confirmerId: userId }),
    ctx.repo.listMissions({ userId, status: "approved" }),
    ctx.repo.listReports(),
  ]);
  const byId = new Map(allReports.map((r) => [r.id, r]));
  const accepted = confirmations
    .filter((c) => c.accepted && c.outcome === "found")
    .map((c) => ({ reportId: c.reportId, neighborhood: byId.get(c.reportId)?.neighborhood ?? "", createdAt: c.createdAt }));
  return { foundAsReporter: mine.filter((r) => r.status === "found"), acceptedFoundConfirmations: accepted, approvedMissions: missions, allMyReports: mine };
}

export async function badgesFor(ctx: DomainContext, userId: string): Promise<Badge[]> {
  const a = await activityFor(ctx, userId);
  const rel = reliabilityFrom(a.allMyReports);
  const helped = a.foundAsReporter.length;
  const explored = new Set(a.acceptedFoundConfirmations.map((c) => c.neighborhood).filter(Boolean)).size;
  const total = helped + a.acceptedFoundConfirmations.length;
  return [
    { id: "first_helper", earned: helped >= 1, progress: Math.min(helped, 1), target: 1 },
    { id: "reliable_driver", earned: helped >= 5 && rel.score >= 0.8, progress: Math.min(helped, 5), target: 5 },
    { id: "parking_explorer", earned: explored >= 3, progress: Math.min(explored, 3), target: 3 },
    { id: "community_champion", earned: total >= 10, progress: Math.min(total, 10), target: 10 },
    { id: "mobility_hero", earned: a.approvedMissions.length >= 1 && helped >= 3, progress: Math.min(a.approvedMissions.length, 1) + Math.min(helped, 3), target: 4 },
  ];
}

export async function contributionScore(ctx: DomainContext, userId: string): Promise<number> {
  const a = await activityFor(ctx, userId);
  const rel = reliabilityFrom(a.allMyReports);
  const volume = a.foundAsReporter.length + a.acceptedFoundConfirmations.length;
  return Math.min(100, Math.round(rel.score * 60 + Math.min(volume, 20) * 2));
}

async function metricValue(ctx: DomainContext, userId: string, profile: Profile, metric: ChallengeMetric, neighborhood: string | null): Promise<number> {
  const now = ctx.now();
  const dayStart = iso(riyadhDayStart(now));
  const weekStart = iso(daysAgo(now, 7));
  const a = await activityFor(ctx, userId);
  switch (metric) {
    case "handoffs_today":
      return a.foundAsReporter.filter((r) => (r.resolvedAt ?? "") >= dayStart).length + a.acceptedFoundConfirmations.filter((c) => c.createdAt >= dayStart).length;
    case "handoffs_week":
      return a.foundAsReporter.filter((r) => (r.resolvedAt ?? "") >= weekStart).length;
    case "verified_reports_week":
      return a.allMyReports.filter((r) => r.createdAt >= weekStart && (r.status === "found" || r.status === "not_found")).length;
    case "neighborhood_handoffs_week": {
      const hood = neighborhood ?? profile.neighborhood;
      const all = await ctx.repo.listReports({ sinceIso: weekStart });
      return all.filter((r) => r.status === "found" && r.neighborhood === hood).length;
    }
    case "missions_approved":
      return a.approvedMissions.length;
  }
}

export interface ChallengeView extends NeighborhoodChallenge {
  progress: number;
  completed: boolean;
}

export async function challengesFor(ctx: DomainContext, userId: string): Promise<ChallengeView[]> {
  const profile = await ctx.repo.getProfile(userId);
  if (!profile) throw new DomainError("unauthenticated");
  const challenges = (await ctx.repo.listChallenges()).filter((c) => c.active);
  const out: ChallengeView[] = [];
  for (const c of challenges) {
    const progress = await metricValue(ctx, userId, profile, c.metric, c.neighborhood);
    const completed = progress >= c.target;
    await ctx.repo.upsertChallengeProgress({ challengeId: c.id, userId, progress: Math.min(progress, c.target), completedAt: completed ? iso(ctx.now()) : null });
    out.push({ ...c, progress: Math.min(progress, c.target), completed });
  }
  return out;
}

export interface LeaderboardRow {
  userId: string;
  displayName: string;
  displayNameAr: string;
  neighborhood: string;
  contributions: number;
}

/** Weekly leaderboard ranked by verified contributions (not by Keys, to avoid farming). */
export async function weeklyLeaderboard(ctx: DomainContext): Promise<LeaderboardRow[]> {
  const since = iso(daysAgo(ctx.now(), 7));
  const [profiles, reports, confirmations] = await Promise.all([
    ctx.repo.listProfiles(),
    ctx.repo.listReports({ sinceIso: since }),
    ctx.repo.listConfirmations({ sinceIso: since }),
  ]);
  const counts = new Map<string, number>();
  for (const r of reports.filter((r) => r.status === "found")) counts.set(r.reporterId, (counts.get(r.reporterId) ?? 0) + 1);
  for (const c of confirmations.filter((c) => c.accepted && c.outcome === "found")) counts.set(c.confirmerId, (counts.get(c.confirmerId) ?? 0) + 1);
  return profiles
    .filter((p) => p.role === "driver" && !p.deletionRequestedAt)
    .map((p) => ({ userId: p.id, displayName: p.displayName, displayNameAr: p.displayNameAr, neighborhood: p.neighborhood, contributions: counts.get(p.id) ?? 0 }))
    .sort((a, b) => b.contributions - a.contributions)
    .slice(0, 10);
}

export async function neighborhoodStats(ctx: DomainContext) {
  const since = iso(daysAgo(ctx.now(), 7));
  const reports = await ctx.repo.listReports({ sinceIso: since });
  const by = new Map<string, { reports: number; handoffs: number }>();
  for (const r of reports) {
    const s = by.get(r.neighborhood) ?? { reports: 0, handoffs: 0 };
    s.reports++;
    if (r.status === "found") s.handoffs++;
    by.set(r.neighborhood, s);
  }
  return Object.fromEntries(by);
}

// ─── Park & Connect missions (SIMULATED — no transit integration exists) ────

export async function submitMission(ctx: DomainContext, userId: string, kind: MobilityMission["kind"], description: string): Promise<MobilityMission> {
  const profile = await ctx.repo.getProfile(userId);
  if (!profile || profile.role !== "driver") throw new DomainError("forbidden");
  const today = iso(riyadhDayStart(ctx.now()));
  const mine = await ctx.repo.listMissions({ userId });
  if (mine.some((m) => m.createdAt >= today)) throw new DomainError("rate_limited", "One mission submission per day");
  return ctx.repo.insertMission({
    id: newId(),
    userId,
    kind,
    description: description.slice(0, 280),
    status: "submitted",
    createdAt: iso(ctx.now()),
    decidedAt: null,
    simulated: true,
  });
}

export async function decideMission(ctx: DomainContext, adminId: string, missionId: string, approve: boolean) {
  const m = await ctx.repo.getMission(missionId);
  if (!m) throw new DomainError("not_found");
  if (m.status !== "submitted") throw new DomainError("conflict");
  const updated = await ctx.repo.updateMission(m.id, { status: approve ? "approved" : "rejected", decidedAt: iso(ctx.now()) });
  let award = null;
  if (approve) {
    const rules = await ctx.repo.getRules();
    award = await awardPoints(ctx, {
      userId: m.userId,
      amount: rules.missionReward,
      type: "mission_reward",
      reason: "Approved sustainable mobility mission (simulated)",
      idempotencyKey: `mission:${m.id}`,
      refType: "mobility_mission",
      refId: m.id,
    });
  }
  await ctx.repo.insertAudit({ id: newId(), actorId: adminId, action: approve ? "mission.approve" : "mission.reject", target: `mobility_mission:${m.id}`, details: m.kind, createdAt: iso(ctx.now()) });
  return { mission: updated, award };
}
