import { z } from "zod";
import { body, route } from "@/lib/api/handler";
import { requireRole } from "@/lib/auth/session";
import { getContext } from "@/lib/data";
import { updateOwnSpace } from "@/lib/domain/marketplace";
import { rateLimit } from "@/lib/security/rate-limit";

export const dynamic = "force-dynamic";

const schema = z.object({ rewardEligible: z.boolean().optional(), paused: z.boolean().optional() }).strict();

/** Partner manages reward eligibility / pause state of THEIR OWN listing. */
export const PATCH = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const user = await requireRole(["partner"]);
  await rateLimit("partner", user.id);
  const patch = await body(req, schema);
  return { space: await updateOwnSpace(getContext(), user.id, id, patch) };
});
