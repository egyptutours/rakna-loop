import { body, route } from "@/lib/api/handler";
import { requireRole } from "@/lib/auth/session";
import { getContext } from "@/lib/data";
import { createHomeBooking } from "@/lib/domain/home";
import { getBalance } from "@/lib/domain/ledger";
import { rateLimit } from "@/lib/security/rate-limit";
import { homeBookingSchema } from "@/lib/security/schemas";

export const dynamic = "force-dynamic";

/**
 * Book a schedule space (RAKNA HOME / PARTNERS / PARK & CONNECT) for an exact window.
 * Atomic in storage: padded-by-buffer capacity check + booking + access credential.
 * The access pass is revealed via GET /api/bookings/:id/access once paid, 30 min before start.
 */
export const POST = route(async (req: Request) => {
  const user = await requireRole(["driver"]);
  await rateLimit("booking", user.id);
  const input = await body(req, homeBookingSchema);
  const ctx = getContext();
  const booking = await createHomeBooking(ctx, user.id, input);
  return { booking, balance: await getBalance(ctx, user.id) };
});
