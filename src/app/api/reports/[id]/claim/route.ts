import { body, route } from "@/lib/api/handler";
import { toReportView } from "@/lib/api/views";
import { requireRole } from "@/lib/auth/session";
import { getContext } from "@/lib/data";
import { claimReport } from "@/lib/domain/handoff";
import { rateLimit } from "@/lib/security/rate-limit";
import { evidenceSchema } from "@/lib/security/schemas";

export const dynamic = "force-dynamic";

/** "Navigate to this spot" — claims the signal for this driver (no reservation of public space). */
export const POST = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const user = await requireRole(["driver"]);
  await rateLimit("claim", user.id);
  const ev = await body(req, evidenceSchema);
  const ctx = getContext();
  const report = await claimReport(ctx, user.id, id, ev);
  return { report: await toReportView(ctx, report, user, ev.location) };
});
