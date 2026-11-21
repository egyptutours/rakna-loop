import type { ParkingPartner, ParkingSpace, RewardItem, RewardRules } from "../types";
import { DomainError } from "./errors";
import { iso, newId, type DomainContext } from "./context";
import { reversePoints } from "./ledger";
import { refreshReport } from "./handoff";

const RULE_BOUNDS: Record<keyof RewardRules, [number, number]> = {
  departureReward: [0, 100],
  confirmationReward: [0, 50],
  streakEvery: [0, 50],
  streakBonus: [0, 100],
  missionReward: [0, 100],
  dailyEarnLimit: [0, 1000],
  dailyReportLimit: [1, 100],
  reportTtlMinutes: [5, 120],
  claimTtlMinutes: [3, 60],
  maxConfirmDistanceM: [20, 1000],
  maxReportAccuracyM: [5, 500],
  minClaimToConfirmSeconds: [0, 600],
  locationRetentionHours: [1, 720],
};

async function audit(ctx: DomainContext, actorId: string, action: string, target: string, details: string) {
  await ctx.repo.insertAudit({ id: newId(), actorId, action, target, details, createdAt: iso(ctx.now()) });
}

export async function updateRules(ctx: DomainContext, adminId: string, patch: Partial<RewardRules>): Promise<RewardRules> {
  const current = await ctx.repo.getRules();
  const next = { ...current };
  const changes: string[] = [];
  for (const [k, v] of Object.entries(patch) as [keyof RewardRules, number][]) {
    if (!(k in RULE_BOUNDS)) throw new DomainError("validation", `Unknown rule ${k}`);
    const [min, max] = RULE_BOUNDS[k];
    if (!Number.isInteger(v) || v < min || v > max) throw new DomainError("validation", `${k} must be an integer between ${min} and ${max}`);
    if (current[k] !== v) changes.push(`${k}: ${current[k]} → ${v}`);
    next[k] = v;
  }
  const saved = await ctx.repo.setRules(next);
  if (changes.length) await audit(ctx, adminId, "rules.update", "reward_rules", changes.join("; "));
  return saved;
}

export async function decidePartner(ctx: DomainContext, adminId: string, partnerId: string, status: ParkingPartner["status"]): Promise<ParkingPartner> {
  const p = await ctx.repo.getPartner(partnerId);
  if (!p) throw new DomainError("not_found");
  const updated = await ctx.repo.updatePartner(partnerId, { status, reviewedAt: iso(ctx.now()) });
  await audit(ctx, adminId, `partner.${status}`, `parking_partner:${partnerId}`, p.name);
  return updated;
}

export async function decideSpace(ctx: DomainContext, adminId: string, spaceId: string, approval: ParkingSpace["approval"]): Promise<ParkingSpace> {
  const s = await ctx.repo.getSpace(spaceId);
  if (!s) throw new DomainError("not_found");
  if (approval === "approved") {
    const partner = await ctx.repo.getPartner(s.partnerId);
    if (partner?.status !== "approved") throw new DomainError("partner_not_approved", "Approve the partner before their spaces");
  }
  // Approval IS the entitlement verification (deed / wakalah / Ejar + consent / association
  // resolution / CR reviewed out-of-band). Rejection marks verification rejected.
  const patch: Partial<ParkingSpace> = { approval };
  if (approval === "approved") patch.verificationStatus = "verified";
  if (approval === "rejected") patch.verificationStatus = "rejected";
  const updated = await ctx.repo.updateSpace(spaceId, patch);
  await audit(ctx, adminId, `space.${approval}`, `parking_space:${spaceId}`, s.title);
  return updated;
}

export async function decideFlag(ctx: DomainContext, adminId: string, flagId: string, action: "dismiss" | "reverse", reverseAmount?: number) {
  const flags = await ctx.repo.listFraudFlags();
  const f = flags.find((x) => x.id === flagId);
  if (!f) throw new DomainError("not_found");
  if (f.status !== "open") throw new DomainError("conflict");
  let reversal = null;
  if (action === "reverse") {
    const amount = reverseAmount ?? 0;
    if (!Number.isInteger(amount) || amount <= 0 || amount > 1000) throw new DomainError("validation", "Reversal amount must be 1–1000");
    reversal = await reversePoints(ctx, { userId: f.userId, amount, reason: `Fraud review: ${f.kind}`, idempotencyKey: `reversal:${f.id}`, refId: f.id });
  }
  const updated = await ctx.repo.updateFraudFlag(flagId, { status: action === "dismiss" ? "dismissed" : "actioned", reviewedBy: adminId });
  await audit(ctx, adminId, `fraud.${action}`, `fraud_flag:${flagId}`, reversal ? `reversed ${reversal.reversed}, shortfall ${reversal.shortfall}` : f.kind);
  return { flag: updated, reversal };
}

export async function upsertRewardItem(ctx: DomainContext, adminId: string, item: RewardItem): Promise<RewardItem> {
  if (!Number.isInteger(item.keysRequired) || item.keysRequired < 1 || item.keysRequired > 10000) throw new DomainError("validation", "Invalid key cost");
  const saved = await ctx.repo.upsertReward(item);
  await audit(ctx, adminId, "reward.upsert", `rewards_catalog:${item.id}`, `${item.title} — ${item.keysRequired} keys, active=${item.active}`);
  return saved;
}

/** Process a user's deletion request: anonymize, keep durable records, audit. */
export async function processAccountDeletion(ctx: DomainContext, adminId: string, userId: string) {
  const p = await ctx.repo.getProfile(userId);
  if (!p) throw new DomainError("not_found");
  if (!p.deletionRequestedAt) throw new DomainError("conflict", "No deletion request for this account");
  if (p.deletedAt) throw new DomainError("conflict", "Already processed");
  const result = await ctx.repo.anonymizeProfile(userId);
  await audit(ctx, adminId, "account.deletion_processed", `profile:${userId}`, JSON.stringify(result));
  return result;
}

export async function adminOverview(ctx: DomainContext) {
  const [profiles, reports, ledger, flags, partners, spaces, redemptions, missions, rules, auditLog, totals] = await Promise.all([
    ctx.repo.listProfiles(),
    // Bounded: the last 7 days of temporary reports (older ones are folded into hive stats).
    ctx.repo.listReports({ sinceIso: new Date(ctx.now().getTime() - 7 * 86_400_000).toISOString() }).then((list) => Promise.all(list.map((r) => refreshReport(ctx, r)))),
    ctx.repo.listLedger({ limit: 60 }), // never the whole ledger (audit F-PERF-2)
    ctx.repo.listFraudFlags(),
    ctx.repo.listPartners(),
    ctx.repo.listSpaces(),
    ctx.repo.listRedemptions(),
    ctx.repo.listMissions(),
    ctx.repo.getRules(),
    ctx.repo.listAudit(40),
    ctx.repo.ledgerTotals(), // exact totals computed in storage, without shipping the ledger
  ]);
  return {
    stats: {
      users: profiles.length,
      drivers: profiles.filter((p) => p.role === "driver").length,
      activeReports: reports.filter((r) => ["pending_departure", "available", "claimed"].includes(r.status)).length,
      successfulHandoffs: reports.filter((r) => r.status === "found").length,
      notFound: reports.filter((r) => r.status === "not_found").length,
      expiredReports: reports.filter((r) => r.status === "expired").length,
      heldForReview: reports.filter((r) => r.status === "flagged").length,
      openFraudFlags: flags.filter((f) => f.status === "open").length,
      totalEarnedKeys: totals.earned,
      totalRedeemedKeys: totals.spent - totals.refunded,
      outstandingKeys: totals.outstanding,
      pendingDeletions: profiles.filter((p) => p.deletionRequestedAt && !p.deletedAt).length,
      pendingPartners: partners.filter((p) => p.status === "pending").length,
      pendingSpaces: spaces.filter((s) => s.approval === "pending_review").length,
      pendingRedemptions: redemptions.filter((r) => r.status === "pending_approval").length,
      pendingMissions: missions.filter((m) => m.status === "submitted").length,
    },
    rules,
    // Bounded (blocker B7): newest 100 here; the full list via GET /api/admin/list?entity=profiles.
    // Pending deletion requests are always included so none can be missed by the cap.
    profiles: [...new Map([...profiles.filter((p) => p.deletionRequestedAt && !p.deletedAt), ...profiles.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100)].map((p) => [p.id, p])).values()],
    profilesTotal: profiles.length,
    reports: reports.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 50),
    flags: flags.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    partners,
    spaces,
    redemptions: redemptions.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    missions: missions.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    ledger: ledger.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 60),
    audit: auditLog,
  };
}
