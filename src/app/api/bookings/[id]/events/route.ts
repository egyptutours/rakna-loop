import { body, route } from "@/lib/api/handler";
import { requireRole } from "@/lib/auth/session";
import { getContext } from "@/lib/data";
import { recordBookingEvent } from "@/lib/domain/home";
import { rateLimit } from "@/lib/security/rate-limit";
import { bookingEventSchema } from "@/lib/security/schemas";

export const dynamic = "force-dynamic";

/**
 * Booking lifecycle: arrived (geofenced ≤ 50 m), extended (+60 min, buffer re-checked),
 * departed (1.5× overstay after a 10-minute grace, credited to the host) and
 * bay_blocked_reported (incident for support/admin).
 */
export const POST = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const user = await requireRole(["driver"]);
  await rateLimit("bookingEvent", user.id);
  const input = await body(req, bookingEventSchema);
  return recordBookingEvent(getContext(), user.id, id, input);
});
