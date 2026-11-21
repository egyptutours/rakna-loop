import { body, route } from "@/lib/api/handler";
import { toReportView } from "@/lib/api/views";
import { requireRole } from "@/lib/auth/session";
import { getContext } from "@/lib/data";
import { confirmReport } from "@/lib/domain/handoff";
import { rateLimit } from "@/lib/security/rate-limit";
import { confirmSchema } from "@/lib/security/schemas";

export const dynamic = "force-dynamic";

/** "I found it" / "It wasn't available". All verification and rewards happen here, server-side. */
export const POST = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const user = await requireRole(["driver"]);
  await rateLimit("confirm", user.id);
  const input = await body(req, confirmSchema);
  const ctx = getContext();
  const res = await confirmReport(ctx, user.id, id, input);
  return {
    report: await toReportView(ctx, res.report, user, input.location),
    heldForReview: res.heldForReview,
    accepted: res.confirmation.accepted,
    released: res.confirmation.rejectionReason?.startsWith("released") ?? false,
    distanceM: res.confirmation.distanceM,
    keysEarned: res.rewards.confirmer?.awarded ?? 0,
    capped: Boolean(res.rewards.confirmer?.capped),
  };
});
