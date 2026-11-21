import { body, route } from "@/lib/api/handler";
import { requireRole } from "@/lib/auth/session";
import { getContext } from "@/lib/data";
import { myBookings } from "@/lib/domain/home";
import { createBooking } from "@/lib/domain/marketplace";
import { getBalance } from "@/lib/domain/ledger";
import { rateLimit } from "@/lib/security/rate-limit";
import { bookingSchema } from "@/lib/security/schemas";

export const dynamic = "force-dynamic";

/** "My Bookings & Passes": own bookings (newest first, ≤ 100) with the PUBLIC view of each space. */
export const GET = route(async () => {
  const user = await requireRole(["driver"]);
  const bookings = await myBookings(getContext(), user.id);
  // Backwards-compatible fields for the legacy parking page.
  return { bookings: bookings.map((b) => ({ ...b, spaceTitle: b.space?.title ?? "", spaceTitleAr: b.space?.titleAr ?? "" })) };
});

/** Book an approved commercial space by the hour (legacy SAR path). Payment is SIMULATED in the MVP. */
export const POST = route(async (req: Request) => {
  const user = await requireRole(["driver"]);
  await rateLimit("booking", user.id);
  const input = await body(req, bookingSchema);
  const ctx = getContext();
  const booking = await createBooking(ctx, user.id, input);
  return { booking, balance: await getBalance(ctx, user.id) };
});
