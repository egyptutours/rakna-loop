import { body, route } from "@/lib/api/handler";
import { bookableSpaceViews } from "@/lib/api/spaces";
import { requireRole } from "@/lib/auth/session";
import { getContext } from "@/lib/data";
import { submitSpace } from "@/lib/domain/marketplace";
import { rateLimit } from "@/lib/security/rate-limit";
import { spaceSchema } from "@/lib/security/schemas";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const ctx = getContext();
  const rewards = (await ctx.repo.listRewards()).filter((r) => r.active && r.category === "parking_discount");
  return { spaces: await bookableSpaceViews(ctx), discountRewards: rewards };
});

/** Partner submits a private space. Enters admin review; never bookable until approved. */
export const POST = route(async (req: Request) => {
  const user = await requireRole(["partner"]);
  await rateLimit("partner", user.id);
  const input = await body(req, spaceSchema);
  return { space: await submitSpace(getContext(), user.id, input) };
});
