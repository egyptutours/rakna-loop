import { body, route } from "@/lib/api/handler";
import { requireUser } from "@/lib/auth/session";
import { getContext } from "@/lib/data";
import { DomainError } from "@/lib/domain/errors";
import { hostDashboard, submitHomeListing } from "@/lib/domain/home";
import { rateLimit } from "@/lib/security/rate-limit";
import { homeListingSchema } from "@/lib/security/schemas";

export const dynamic = "force-dynamic";

/** Host Dashboard: my RAKNA HOME spaces, schedules, bookings and net earnings (integer halalas). */
export const GET = route(async () => {
  const user = await requireUser();
  if (user.role === "admin") throw new DomainError("forbidden", "Administrators do not host spaces");
  return hostDashboard(getContext(), user.id);
});

/** "List My Parking" wizard submission. Enters admin entitlement review; villas join the waitlist. */
export const POST = route(async (req: Request) => {
  const user = await requireUser();
  await rateLimit("host", user.id);
  const input = await body(req, homeListingSchema);
  return submitHomeListing(getContext(), user.id, input);
});
