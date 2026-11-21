import { route } from "@/lib/api/handler";
import { toReportView } from "@/lib/api/views";
import { getCurrentUser, requireRole } from "@/lib/auth/session";
import { getContext } from "@/lib/data";
import { DomainError } from "@/lib/domain/errors";
import { cancelReport, refreshReport } from "@/lib/domain/handoff";
import { isValidLatLng } from "@/lib/geo";
import { toHiveSignal } from "@/lib/hive/signals";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export const GET = route(async (req: Request, { params }: Params) => {
  const { id } = await params;
  const ctx = getContext();
  const user = await getCurrentUser();
  const raw = await ctx.repo.getReport(id);
  if (!raw) throw new DomainError("not_found");
  const r = await refreshReport(ctx, raw);
  const url = new URL(req.url);
  const lat = Number(url.searchParams.get("lat"));
  const lng = Number(url.searchParams.get("lng"));
  const viewer = url.searchParams.has("lat") && isValidLatLng({ lat, lng }) ? { lat, lng } : null;
  const confirmations = user && (user.id === r.reporterId || user.id === r.claimedBy || user.role === "admin")
    ? (await ctx.repo.listConfirmations({ reportId: id })).map((c) => ({ outcome: c.outcome, accepted: c.accepted, rejectionReason: c.rejectionReason, distanceM: c.distanceM, createdAt: c.createdAt, byMe: c.confirmerId === user.id }))
    : [];
  return { report: await toReportView(ctx, r, user, viewer), signal: await toHiveSignal(ctx, r, user, viewer), confirmations };
});

/** Reporter cancels (e.g. plans changed). */
export const DELETE = route(async (_req: Request, { params }: Params) => {
  const { id } = await params;
  const user = await requireRole(["driver"]);
  const ctx = getContext();
  return { report: await toReportView(ctx, await cancelReport(ctx, user.id, id), user) };
});
