import { body, route } from "@/lib/api/handler";
import { toReportView } from "@/lib/api/views";
import { requireRole } from "@/lib/auth/session";
import { getContext } from "@/lib/data";
import { createReport, refreshReport } from "@/lib/domain/handoff";
import { rateLimit } from "@/lib/security/rate-limit";
import { createReportSchema } from "@/lib/security/schemas";

export const dynamic = "force-dynamic";

/** My departure reports (history). */
export const GET = route(async () => {
  const user = await requireRole(["driver"]);
  const ctx = getContext();
  const mine = await Promise.all((await ctx.repo.listReports({ reporterId: user.id })).map((r) => refreshReport(ctx, r)));
  mine.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  // The signal this driver is currently heading to (if any) — independent of the map viewport.
  const activeClaim = (await ctx.repo.listClaims({ claimerId: user.id })).find((c) => c.active);
  const claimedRaw = activeClaim ? await ctx.repo.getReport(activeClaim.reportId) : null;
  const claimed = claimedRaw ? await refreshReport(ctx, claimedRaw) : null;
  return {
    reports: await Promise.all(mine.slice(0, 30).map((r) => toReportView(ctx, r, user))),
    claimed: claimed && claimed.status === "claimed" && claimed.claimedBy === user.id ? await toReportView(ctx, claimed, user) : null,
  };
});

/** "I'm leaving" — create a community departure report. */
export const POST = route(async (req: Request) => {
  const user = await requireRole(["driver"]);
  await rateLimit("report", user.id);
  const input = await body(req, createReportSchema);
  const ctx = getContext();
  const report = await createReport(ctx, user.id, { ...input, note: input.note ?? null });
  if (!user.locationConsentAt) await ctx.repo.updateProfile(user.id, { locationConsentAt: ctx.now().toISOString() });
  return { report: await toReportView(ctx, report, user) };
});
