import { route } from "@/lib/api/handler";
import { requireRole } from "@/lib/auth/session";
import { getContext } from "@/lib/data";
import { getBookingAccess } from "@/lib/domain/home";
import { rateLimit } from "@/lib/security/rate-limit";

export const dynamic = "force-dynamic";

/**
 * Exact location, address and the ephemeral PIN / QR / guard code — ONLY for the driver of
 * a confirmed, paid (or simulated) booking, from 30 minutes before the start. Anyone else
 * gets 404 (the booking's existence is not confirmed).
 */
export const GET = route(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const user = await requireRole(["driver"]);
  await rateLimit("access", user.id);
  return { access: await getBookingAccess(getContext(), user.id, id) };
});
