import { cookies } from "next/headers";
import { body, route } from "@/lib/api/handler";
import { LANG_COOKIE, requireUser } from "@/lib/auth/session";
import { getContext } from "@/lib/data";
import { badgesFor, contributionScore } from "@/lib/domain/community";
import { reliabilityFrom } from "@/lib/domain/handoff";
import { profileSchema } from "@/lib/security/schemas";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const user = await requireUser();
  const ctx = getContext();
  if (user.role !== "driver") return { profile: user, contributionScore: null, reliability: null, badges: [], activity: [] };
  const [reports, confirmations, score, badges] = await Promise.all([
    ctx.repo.listReports({ reporterId: user.id }),
    ctx.repo.listConfirmations({ confirmerId: user.id }),
    contributionScore(ctx, user.id),
    badgesFor(ctx, user.id),
  ]);
  const activity = [
    ...reports.map((r) => ({ kind: "report" as const, id: r.id, status: r.status, neighborhood: r.neighborhood, at: r.createdAt })),
    ...confirmations.map((c) => ({ kind: "confirmation" as const, id: c.reportId, status: c.accepted ? c.outcome : (c.rejectionReason ?? "rejected"), neighborhood: "", at: c.createdAt })),
  ].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 25);
  return { profile: user, contributionScore: score, reliability: reliabilityFrom(reports), badges, activity };
});

/** Language, location consent and account-deletion request. */
export const PATCH = route(async (req: Request) => {
  const user = await requireUser();
  const input = await body(req, profileSchema);
  const ctx = getContext();
  const now = ctx.now().toISOString();
  const patch: Record<string, unknown> = {};
  if (input.lang) {
    patch.lang = input.lang;
    (await cookies()).set(LANG_COOKIE, input.lang, { sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 365 });
  }
  if (input.locationConsent !== undefined) patch.locationConsentAt = input.locationConsent ? now : null;
  if (input.requestDeletion !== undefined) patch.deletionRequestedAt = input.requestDeletion ? now : null;
  const profile = await ctx.repo.updateProfile(user.id, patch);
  if (input.requestDeletion !== undefined) {
    await ctx.repo.insertAudit({ id: crypto.randomUUID(), actorId: user.id, action: input.requestDeletion ? "account.deletion_requested" : "account.deletion_cancelled", target: `profile:${user.id}`, details: "User-initiated", createdAt: now });
  }
  return { profile };
});
