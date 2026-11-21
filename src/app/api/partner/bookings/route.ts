import { route } from "@/lib/api/handler";
import { requireRole } from "@/lib/auth/session";
import { getContext } from "@/lib/data";
import { partnerBookingsPage } from "@/lib/domain/marketplace";
import { rateLimit } from "@/lib/security/rate-limit";
import { pageQuerySchema } from "@/lib/security/schemas";

export const dynamic = "force-dynamic";

/** Keyset-paginated bookings on my partner spaces: `?limit=&cursor=` (newest first). */
export const GET = route(async (req: Request) => {
  const user = await requireRole(["partner"]);
  await rateLimit("partner", user.id);
  const q = pageQuerySchema.parse(Object.fromEntries(new URL(req.url).searchParams));
  return partnerBookingsPage(getContext(), user.id, q.limit, q.cursor ?? null);
});
