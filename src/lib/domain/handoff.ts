import type {
  ConfirmationOutcome,
  DepartureReport,
  EvidenceType,
  LatLng,
  ReportConfirmation,
  ReportStatus,
  RewardRules,
  UserReliability,
} from "../types";
import { distanceM, inRiyadh, isValidLatLng, nearestNeighborhood } from "../geo";
import { DomainError } from "./errors";
import { addMinutes, daysAgo, iso, newId, riyadhDayStart, type DomainContext } from "./context";
import { awardPoints, type AwardResult } from "./ledger";
import { IMPOSSIBLE_SPEED_MPS, raiseFlag } from "./fraud";
import { hiveIndexFor, neighborhood } from "../hive/cells";
import { cellTrail, recordSignalOutcome, type Trail } from "../hive/verification";
import { invalidateHiveCells } from "../hive/aggregation-cache";

/**
 * VERIFIED PARKING HANDOFF
 *
 *  User A reports "I'm leaving"  →  pending_departure / available
 *  User B claims ("Navigate")     →  claimed (hidden from others, precise location revealed to B)
 *  User B confirms at the spot    →  found | not_found   (or flagged → admin review)
 *  Nobody confirms in time        →  expired
 *
 * Community reports are informational signals about PUBLIC parking. A claim does not
 * reserve or hold a public space; it only prevents duplicate rewards and stops two
 * drivers being routed to the same signal.
 */

const ACTIVE: ReportStatus[] = ["pending_departure", "available", "claimed"];

export const DEPARTURE_OPTIONS_MIN = [0, 2, 5, 10] as const;

export interface LocationEvidence {
  location: LatLng | null;
  accuracyM: number | null;
  evidence: EvidenceType;
}

function assertEvidence(ctx: DomainContext, ev: LocationEvidence) {
  if (ev.evidence === "simulated" && !ctx.allowSimulatedEvidence) {
    throw new DomainError("validation", "Simulated location is only available in demo mode");
  }
  if (ev.location && !isValidLatLng(ev.location)) throw new DomainError("validation", "Invalid coordinates");
  if (ev.accuracyM !== null && (!Number.isFinite(ev.accuracyM) || ev.accuracyM < 0)) {
    throw new DomainError("validation", "Invalid accuracy");
  }
}

/** Derive the up-to-date status from timestamps (lazy state machine). Pure. */
export function deriveStatus(r: DepartureReport, now: Date): Partial<DepartureReport> | null {
  if (!ACTIVE.includes(r.status)) return null;
  const t = now.getTime();
  if (t >= new Date(r.expiresAt).getTime()) {
    // The signal ended at its expiry time, not whenever someone happened to look at it.
    return { status: "expired", resolvedAt: r.expiresAt };
  }
  if (r.status === "claimed" && r.claimExpiresAt && t >= new Date(r.claimExpiresAt).getTime()) {
    // Claim lapsed without confirmation: release the signal for other drivers.
    return { status: t >= new Date(r.expectedDepartureAt).getTime() ? "available" : "pending_departure", claimedBy: null, claimedAt: null, claimExpiresAt: null, claimLocation: null };
  }
  if (r.status === "pending_departure" && t >= new Date(r.expectedDepartureAt).getTime()) {
    return { status: "available" };
  }
  return null;
}

export async function refreshReport(ctx: DomainContext, r: DepartureReport): Promise<DepartureReport> {
  const now = ctx.now();
  const patch = deriveStatus(r, now);
  if (!patch) return r;
  // Compare-and-set: only apply if nobody changed the row since we read it. An expiry also
  // requires the stored expiry to have passed (a concurrent claim may have extended it).
  const next = await ctx.repo.transitionReport(
    r.id,
    { statuses: [r.status], claimedBy: r.claimedBy, ...(patch.status === "expired" ? { expiresAtOrBeforeIso: iso(now) } : {}) },
    patch,
  );
  if (!next) {
    const current = await ctx.repo.getReport(r.id);
    return current ?? r; // lost the race: the winner's state is authoritative
  }
  if (patch.claimedBy === null && r.claimedBy) {
    await ctx.repo.updateClaims({ reportId: r.id, active: true }, { active: false });
  }
  return next;
}

export async function refreshAll(ctx: DomainContext): Promise<DepartureReport[]> {
  const all = await ctx.repo.listReports();
  return Promise.all(all.map((r) => refreshReport(ctx, r)));
}

// ─── Report ("I'm leaving") ──────────────────────────────────────────────────

export interface CreateReportInput extends LocationEvidence {
  departInMinutes: number;
  note?: string | null;
}

export async function createReport(ctx: DomainContext, userId: string, input: CreateReportInput): Promise<DepartureReport> {
  const profile = await ctx.repo.getProfile(userId);
  if (!profile) throw new DomainError("unauthenticated");
  if (profile.role !== "driver") throw new DomainError("forbidden", "Only drivers can report departures");
  if (profile.deletionRequestedAt) throw new DomainError("forbidden", "Account deletion pending");
  assertEvidence(ctx, input);
  if (!input.location || input.evidence === "none") throw new DomainError("validation", "Location is required to report a departure");
  if (!inRiyadh(input.location)) throw new DomainError("outside_service_area", "The MVP covers Riyadh only");
  if (!(DEPARTURE_OPTIONS_MIN as readonly number[]).includes(input.departInMinutes)) {
    throw new DomainError("validation", "Departure must be now, or in 2, 5 or 10 minutes");
  }

  const rules = await ctx.repo.getRules();
  const accuracy = input.accuracyM ?? rules.maxReportAccuracyM;
  if (accuracy > rules.maxReportAccuracyM) {
    throw new DomainError("low_accuracy", `GPS accuracy must be ${rules.maxReportAccuracyM} m or better`, { accuracyM: accuracy });
  }

  const now = ctx.now();
  return ctx.repo.withLock(`reports:${userId}`, async () => {
    const mine = await Promise.all((await ctx.repo.listReports({ reporterId: userId })).map((r) => refreshReport(ctx, r)));

    if (mine.some((r) => ACTIVE.includes(r.status))) {
      throw new DomainError("duplicate_report", "You already have an active departure report");
    }
    const today = mine.filter((r) => r.createdAt >= iso(riyadhDayStart(now)));
    if (today.length >= rules.dailyReportLimit) {
      throw new DomainError("daily_report_limit", "Daily report limit reached");
    }
    const recentNearby = mine.filter(
      (r) => now.getTime() - new Date(r.createdAt).getTime() < 30 * 60_000 && distanceM(r.location, input.location!) < 50,
    );
    if (recentNearby.length >= 2) {
      await raiseFlag(ctx, { kind: "report_spam", userId, details: "3+ reports at the same spot within 30 minutes", severity: "medium" });
      throw new DomainError("duplicate_report", "Too many reports for the same spot");
    }

    const expected = addMinutes(now, input.departInMinutes);
    const report: DepartureReport = {
      id: newId(),
      reporterId: userId,
      location: input.location!,
      hive: hiveIndexFor(input.location!),
      aggregatedAt: null,
      accuracyM: Math.round(accuracy),
      neighborhood: nearestNeighborhood(input.location!),
      note: input.note?.slice(0, 140) || null,
      createdAt: iso(now),
      expectedDepartureAt: iso(expected),
      expiresAt: iso(addMinutes(expected, rules.reportTtlMinutes)),
      status: input.departInMinutes > 0 ? "pending_departure" : "available",
      claimedBy: null,
      claimedAt: null,
      claimExpiresAt: null,
      claimLocation: null,
      resolvedAt: null,
      isDemo: ctx.allowSimulatedEvidence,
    };
    const saved = await ctx.repo.insertReport(report);
    invalidateHiveCells([report.hive!.r7, report.hive!.r8, report.hive!.r9, report.hive!.r10]);
    return saved;
  });
}

export async function cancelReport(ctx: DomainContext, userId: string, reportId: string): Promise<DepartureReport> {
  const r = await ctx.repo.getReport(reportId);
  if (!r) throw new DomainError("not_found");
  if (r.reporterId !== userId) throw new DomainError("forbidden");
  const fresh = await refreshReport(ctx, r);
  if (!ACTIVE.includes(fresh.status)) throw new DomainError("report_not_available");
  const done = await ctx.repo.transitionReport(reportId, { statuses: [fresh.status], claimedBy: fresh.claimedBy }, { status: "expired", resolvedAt: iso(ctx.now()), claimedBy: null, claimExpiresAt: null });
  if (!done) throw new DomainError("conflict", "The report changed — please refresh");
  await ctx.repo.updateClaims({ reportId, active: true }, { active: false });
  return done;
}

// ─── Claim ("Navigate to this spot") ─────────────────────────────────────────

export async function claimReport(ctx: DomainContext, userId: string, reportId: string, ev: LocationEvidence): Promise<DepartureReport> {
  assertEvidence(ctx, ev);
  const profile = await ctx.repo.getProfile(userId);
  if (!profile) throw new DomainError("unauthenticated");
  if (profile.role !== "driver") throw new DomainError("forbidden", "Only drivers can claim reports");

  return ctx.repo.withLock(`report:${reportId}`, async () => {
    const raw = await ctx.repo.getReport(reportId);
    if (!raw) throw new DomainError("not_found");
    const r = await refreshReport(ctx, raw);
    if (r.reporterId === userId) throw new DomainError("self_confirmation", "You cannot claim your own report");
    if (r.status === "expired") throw new DomainError("report_expired");
    if (r.status === "claimed") {
      if (r.claimedBy === userId) return r; // idempotent
      throw new DomainError("already_claimed_other", "Another driver is already heading to this spot");
    }
    if (r.status !== "available" && r.status !== "pending_departure") throw new DomainError("report_not_available");

    const now = ctx.now();
    const rules = await ctx.repo.getRules();
    // One active claim per driver: release any other signal they were heading to.
    const myActive = await ctx.repo.listClaims({ claimerId: userId });
    for (const c of myActive.filter((c) => c.active && c.reportId !== reportId)) {
      await ctx.repo.updateClaims({ reportId: c.reportId, claimerId: userId, active: true }, { active: false });
      await ctx.repo.transitionReport(c.reportId, { statuses: ["claimed"], claimedBy: userId }, { status: "available", claimedBy: null, claimedAt: null, claimExpiresAt: null, claimLocation: null });
    }

    const claimExpires = addMinutes(now, rules.claimTtlMinutes);
    // The claim window defines how long the signal stays valid for this driver.
    const expiresAt = new Date(r.expiresAt) > claimExpires ? r.expiresAt : iso(claimExpires);
    // ATOMIC: exactly one concurrent claimer can move the report out of available/pending,
    // and only while it has not expired (Scenarios A and E).
    const claimed = await ctx.repo.transitionReport(
      reportId,
      { statuses: ["available", "pending_departure"], claimedBy: null, expiresAfterIso: iso(now) },
      { status: "claimed", claimedBy: userId, claimedAt: iso(now), claimExpiresAt: iso(claimExpires), claimLocation: ev.location, expiresAt },
    );
    if (!claimed) {
      const current = await refreshReport(ctx, (await ctx.repo.getReport(reportId))!);
      if (current.status === "claimed" && current.claimedBy === userId) return current;
      if (current.status === "claimed") throw new DomainError("already_claimed_other", "Another driver is already heading to this spot");
      if (current.status === "expired") throw new DomainError("report_expired");
      throw new DomainError("report_not_available");
    }
    await ctx.repo.insertClaim({
      id: newId(),
      reportId,
      claimerId: userId,
      claimLocation: ev.location,
      claimAccuracyM: ev.accuracyM,
      createdAt: iso(now),
      expiresAt: iso(claimExpires),
      active: true,
    });
    return claimed;
  });
}

// ─── Confirm ("I found it" / "It wasn't available") ─────────────────────────

export interface ConfirmResult {
  report: DepartureReport;
  confirmation: ReportConfirmation;
  heldForReview: boolean;
  rewards: { reporter: AwardResult | null; confirmer: AwardResult | null; streak: AwardResult | null };
}

export function allowedDistanceM(rules: RewardRules, accuracyM: number | null): number {
  // GPS is not perfect: widen the radius by half the reported accuracy, capped at 50 m.
  return rules.maxConfirmDistanceM + Math.min(50, (accuracyM ?? 50) / 2);
}

export async function confirmReport(
  ctx: DomainContext,
  userId: string,
  reportId: string,
  input: LocationEvidence & { outcome: ConfirmationOutcome },
): Promise<ConfirmResult> {
  assertEvidence(ctx, input);

  return ctx.repo.withLock(`report:${reportId}`, async () => {
    const raw = await ctx.repo.getReport(reportId);
    if (!raw) throw new DomainError("not_found");
    const now = ctx.now();
    const rules = await ctx.repo.getRules();

    const record = async (accepted: boolean, rejectionReason: string | null, distance: number | null) =>
      ctx.repo.insertConfirmation({
        id: newId(),
        reportId,
        confirmerId: userId,
        outcome: input.outcome,
        location: input.location,
        accuracyM: input.accuracyM,
        distanceM: distance === null ? null : Math.round(distance),
        evidence: input.evidence,
        accepted,
        rejectionReason,
        createdAt: iso(now),
      });

    // 1. Self-confirmation is never allowed.
    if (raw.reporterId === userId) {
      await record(false, "self_confirmation", null);
      await raiseFlag(ctx, { kind: "self_confirmation_attempt", userId, reportId, details: "Reporter attempted to confirm their own report", severity: "medium" });
      throw new DomainError("self_confirmation", "You cannot confirm your own report");
    }

    // 2. Freshness: reject expired reports.
    const r = await refreshReport(ctx, raw);
    if (r.status === "expired") {
      await record(false, "expired", null);
      throw new DomainError("report_expired", "This report has expired");
    }
    // 3. One accepted confirmation per report → no duplicate rewards.
    if (r.status === "found" || r.status === "not_found" || r.status === "flagged") {
      throw new DomainError("already_confirmed", "This report has already been resolved");
    }
    // 4. Only the active claimer can confirm.
    if (r.status !== "claimed" || r.claimedBy !== userId) {
      throw new DomainError("not_claimer", "Tap “Navigate to this spot” before confirming");
    }

    // 5. Proximity evidence.
    let distance: number | null = null;
    if (input.location && input.evidence !== "none") distance = distanceM(input.location, r.location);
    const verifiedProximity = distance !== null && distance <= allowedDistanceM(rules, input.accuracyM);

    if (input.outcome === "found" && !verifiedProximity) {
      await record(false, distance === null ? "no_location" : "too_far", distance);
      if (distance === null) throw new DomainError("validation", "Location is required to confirm that you found the space");
      const recentTooFar = (await ctx.repo.listConfirmations({ confirmerId: userId, sinceIso: iso(daysAgo(now, 1)) })).filter(
        (c) => c.rejectionReason === "too_far",
      );
      if (recentTooFar.length >= 3) {
        await raiseFlag(ctx, { kind: "too_far_confirmation", userId, reportId, details: `${recentTooFar.length} far-away confirmations in 24h`, severity: "medium" });
      }
      throw new DomainError("too_far", "You need to be at the reported location to confirm", {
        distanceM: Math.round(distance),
        allowedM: Math.round(allowedDistanceM(rules, input.accuracyM)),
      });
    }

    // 6. Suspicious-activity checks → hold for admin review instead of paying out.
    const holdReasons: string[] = [];
    if (input.outcome === "found") {
      const claimedAt = r.claimedAt ? new Date(r.claimedAt) : null;
      const elapsedS = claimedAt ? (now.getTime() - claimedAt.getTime()) / 1000 : null;
      if (r.claimLocation && input.location && elapsedS !== null && elapsedS > 0) {
        const travel = distanceM(r.claimLocation, input.location);
        if (travel / elapsedS > IMPOSSIBLE_SPEED_MPS && travel > 500) {
          holdReasons.push("impossible_travel");
          await raiseFlag(ctx, { kind: "impossible_travel", userId, relatedUserId: r.reporterId, reportId, details: `${Math.round(travel)} m in ${Math.round(elapsedS)} s`, severity: "high" });
        } else if (elapsedS < rules.minClaimToConfirmSeconds && travel > 300) {
          holdReasons.push("rapid_arrival");
          await raiseFlag(ctx, { kind: "rapid_arrival", userId, relatedUserId: r.reporterId, reportId, details: `Confirmed ${Math.round(elapsedS)} s after claiming from ${Math.round(travel)} m away`, severity: "medium" });
        }
      }
      const pairHistory = (await ctx.repo.listReports({ reporterId: r.reporterId, sinceIso: iso(daysAgo(now, 7)) })).filter(
        (x) => x.id !== r.id && x.status === "found" && x.claimedBy === userId,
      );
      if (pairHistory.length >= 3) {
        holdReasons.push("pair_collusion");
        await raiseFlag(ctx, { kind: "pair_collusion", userId, relatedUserId: r.reporterId, reportId, details: `${pairHistory.length + 1} handoffs between the same two drivers in 7 days`, severity: "medium" });
      }
    }

    await ctx.repo.updateClaims({ reportId, active: true }, { active: false });

    // "Not available" without on-site evidence only releases the claim: it neither
    // penalizes the reporter nor pays the confirmer, so it cannot be used to grief.
    // Every outcome is an ATOMIC transition out of "claimed by this driver" (Scenario B):
    // if two confirmations race, exactly one transition succeeds; the loser is rejected and
    // nothing is recorded or paid for it.
    const fromMyClaim = { statuses: ["claimed"] as ReportStatus[], claimedBy: userId };
    const lostRace = () => new DomainError("already_confirmed", "This report has already been resolved");

    if (input.outcome === "not_found" && !verifiedProximity) {
      const back: ReportStatus = now.getTime() >= new Date(r.expectedDepartureAt).getTime() ? "available" : "pending_departure";
      const report = await ctx.repo.transitionReport(reportId, fromMyClaim, { status: back, claimedBy: null, claimedAt: null, claimExpiresAt: null, claimLocation: null });
      if (!report) throw lostRace();
      const confirmation = await record(false, distance === null ? "released_no_location" : "released_too_far", distance);
      return { report, confirmation, heldForReview: false, rewards: { reporter: null, confirmer: null, streak: null } };
    }

    if (holdReasons.length > 0) {
      const report = await ctx.repo.transitionReport(reportId, fromMyClaim, { status: "flagged", resolvedAt: iso(now) });
      if (!report) throw lostRace();
      const confirmation = await record(false, `held_for_review:${holdReasons.join(",")}`, distance);
      return { report, confirmation, heldForReview: true, rewards: { reporter: null, confirmer: null, streak: null } };
    }

    let report = await ctx.repo.transitionReport(reportId, fromMyClaim, { status: input.outcome, resolvedAt: iso(now) });
    if (!report) throw lostRace();
    const confirmation = await record(true, null, distance);
    // Swarm feedback: reinforce (found) or weaken (not found) the local trail right away.
    await recordSignalOutcome(ctx, report);
    report = (await ctx.repo.getReport(reportId))!;

    if (input.outcome === "not_found") {
      const notFound = (await ctx.repo.listReports({ reporterId: r.reporterId, sinceIso: iso(daysAgo(now, 1)) })).filter((x) => x.status === "not_found");
      if (notFound.length >= 3) {
        await raiseFlag(ctx, { kind: "repeated_not_found", userId: r.reporterId, reportId, details: `${notFound.length} reports marked not found in 24h`, severity: "low" });
      }
    }

    const rewards = await payHandoffRewards(ctx, report, userId, verifiedProximity);
    return { report, confirmation, heldForReview: false, rewards };
  });
}

/** Rewards for a verified handoff. Every award has a deterministic idempotency key. */
export async function payHandoffRewards(ctx: DomainContext, report: DepartureReport, confirmerId: string, verifiedProximity: boolean) {
  const rules = await ctx.repo.getRules();
  let reporter: AwardResult | null = null;
  let streak: AwardResult | null = null;
  let confirmer: AwardResult | null = null;

  if (report.status === "found") {
    reporter = await awardPoints(ctx, {
      userId: report.reporterId,
      amount: rules.departureReward,
      type: "departure_reward",
      reason: "Verified parking handoff — your departure report helped another driver",
      idempotencyKey: `report:${report.id}:reporter`,
      refType: "departure_report",
      refId: report.id,
    });
    // Count from the DURABLE ledger, not from temporary reports (which the lifecycle deletes):
    // otherwise the bonus counter would reset after retention and bonuses could be skipped.
    const successes = (await ctx.repo.listLedger({ userId: report.reporterId })).filter((e) => e.type === "departure_reward").length;
    if (rules.streakEvery > 0 && successes > 0 && successes % rules.streakEvery === 0) {
      streak = await awardPoints(ctx, {
        userId: report.reporterId,
        amount: rules.streakBonus,
        type: "streak_bonus",
        reason: `Bonus for ${successes} verified successful handoffs`,
        idempotencyKey: `streak:${report.reporterId}:${successes}`,
        refType: "departure_report",
        refId: report.id,
      });
    }
  }
  if (verifiedProximity) {
    confirmer = await awardPoints(ctx, {
      userId: confirmerId,
      amount: rules.confirmationReward,
      type: "confirmation_reward",
      reason: report.status === "found" ? "Confirmed a community parking signal on site" : "Reported on site that a signal was no longer available",
      idempotencyKey: `report:${report.id}:confirmer`,
      refType: "departure_report",
      refId: report.id,
    });
  }
  return { reporter, confirmer, streak };
}

// ─── Reliability & confidence ───────────────────────────────────────────────

export function reliabilityFrom(reports: DepartureReport[]): UserReliability {
  const successful = reports.filter((r) => r.status === "found").length;
  const notFound = reports.filter((r) => r.status === "not_found").length;
  const expired = reports.filter((r) => r.status === "expired").length;
  // Bayesian (Laplace) estimate: new users start at 0.5 rather than 0 or 1.
  const score = (successful + 1) / (successful + notFound + 2);
  return { successful, notFound, expired, score };
}

export type ConfidenceLevel = "high" | "medium" | "low";

export interface ConfidenceBreakdown {
  level: ConfidenceLevel;
  score: number; // 0–100
  factors: { key: "freshness" | "accuracy" | "distance" | "reliability" | "history"; value: number; weight: number }[];
}

export function computeConfidence(args: {
  report: DepartureReport;
  now: Date;
  rules: RewardRules;
  reliability: UserReliability;
  nearbyHistory: DepartureReport[]; // resolved reports near the same spot (last 30 days)
  viewer?: LatLng | null;
  /** Local hive trail (decayed verified outcomes). When it has samples it drives the history factor. */
  trail?: Trail | null;
}): ConfidenceBreakdown {
  const { report, now, rules, reliability, nearbyHistory, viewer, trail } = args;
  const start = Math.max(new Date(report.expectedDepartureAt).getTime(), new Date(report.createdAt).getTime());
  const ageMin = (now.getTime() - start) / 60_000;
  const freshness = report.status === "pending_departure" ? 0.9 : Math.max(0, Math.min(1, 1 - ageMin / rules.reportTtlMinutes));

  const a = report.accuracyM;
  const accuracy = a <= 10 ? 1 : a <= 25 ? 0.85 : a <= 50 ? 0.65 : 0.4;

  let distance = 0.6; // neutral when the viewer's location is unknown
  if (viewer) {
    const d = distanceM(viewer, report.location);
    distance = d <= 300 ? 1 : d <= 1000 ? 0.8 : d <= 3000 ? 0.5 : 0.25;
  }

  const hSuccess = nearbyHistory.filter((r) => r.status === "found").length;
  const hFail = nearbyHistory.filter((r) => r.status === "not_found").length;
  const history = trail && trail.samples >= 1 ? trail.score : (hSuccess + 1) / (hSuccess + hFail + 2);

  const factors: ConfidenceBreakdown["factors"] = [
    { key: "freshness", value: freshness, weight: 0.3 },
    { key: "accuracy", value: accuracy, weight: 0.2 },
    { key: "distance", value: distance, weight: 0.15 },
    { key: "reliability", value: reliability.score, weight: 0.25 },
    { key: "history", value: history, weight: 0.1 },
  ];
  const score = Math.round(factors.reduce((s, f) => s + f.value * f.weight, 0) * 100);
  const level: ConfidenceLevel = score >= 70 ? "high" : score >= 45 ? "medium" : "low";
  return { level, score, factors };
}

export async function confidenceFor(ctx: DomainContext, report: DepartureReport, viewer?: LatLng | null): Promise<ConfidenceBreakdown> {
  const now = ctx.now();
  const hive = report.hive ?? hiveIndexFor(report.location);
  // Bounded, indexed lookups: the report's own hive and its ring of neighbors — never a city-wide scan.
  const since = iso(daysAgo(now, 30));
  const [rules, reporterReports, local, trail] = await Promise.all([
    ctx.repo.getRules(),
    ctx.repo.listReports({ reporterId: report.reporterId }),
    ctx.repo.listReportsInCells(9, neighborhood(hive.r9, 1), { statuses: ["found", "not_found"] }),
    cellTrail(ctx, 9, hive.r9),
  ]);
  const nearbyHistory = local.filter((r) => r.id !== report.id && r.createdAt >= since && distanceM(r.location, report.location) <= 150);
  return computeConfidence({ report, now, rules, reliability: reliabilityFrom(reporterReports), nearbyHistory, viewer, trail });
}

/** Admin decision on a report held for review. */
export async function resolveFlaggedReport(ctx: DomainContext, adminId: string, reportId: string, approve: boolean) {
  const r = await ctx.repo.getReport(reportId);
  if (!r) throw new DomainError("not_found");
  if (r.status !== "flagged") throw new DomainError("conflict", "Report is not awaiting review");
  const confirmations = await ctx.repo.listConfirmations({ reportId });
  const held = confirmations.find((c) => c.rejectionReason?.startsWith("held_for_review"));
  const decided = await ctx.repo.transitionReport(reportId, { statuses: ["flagged"] }, { status: approve ? (held?.outcome ?? "found") : "not_found" });
  if (!decided) throw new DomainError("conflict", "Report is not awaiting review");
  let report = decided;
  await recordSignalOutcome(ctx, report);
  report = (await ctx.repo.getReport(reportId))!;
  let rewards = null;
  if (approve && held) rewards = await payHandoffRewards(ctx, report, held.confirmerId, true);
  await ctx.repo.insertAudit({
    id: newId(),
    actorId: adminId,
    action: approve ? "report.release_rewards" : "report.reject_handoff",
    target: `departure_report:${reportId}`,
    details: approve ? "Held handoff approved after review" : "Held handoff rejected after review",
    createdAt: iso(ctx.now()),
  });
  return { report, rewards };
}
