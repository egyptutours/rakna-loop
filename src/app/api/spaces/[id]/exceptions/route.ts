import { body, route } from "@/lib/api/handler";
import { requireUser } from "@/lib/auth/session";
import { getContext } from "@/lib/data";
import { addAvailabilityException } from "@/lib/domain/home";
import { rateLimit } from "@/lib/security/rate-limit";
import { exceptionSchema } from "@/lib/security/schemas";

export const dynamic = "force-dynamic";

/** Block a date or override its hours (one exception per space and date; a new one replaces it). */
export const POST = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const user = await requireUser();
  await rateLimit("host", user.id);
  const input = await body(req, exceptionSchema);
  return { exception: await addAvailabilityException(getContext(), user.id, id, input) };
});
