import { body, route } from "@/lib/api/handler";
import { requireRole } from "@/lib/auth/session";
import { getContext } from "@/lib/data";
import { partnerDashboard, registerPartner } from "@/lib/domain/marketplace";
import { rateLimit } from "@/lib/security/rate-limit";
import { partnerSchema } from "@/lib/security/schemas";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const user = await requireRole(["partner"]);
  const ctx = getContext();
  const dash = await partnerDashboard(ctx, user.id);
  const rewards = (await ctx.repo.listRewards()).filter((r) => r.category === "parking_discount" && (r.partnerId === null || r.partnerId === dash.partner?.id));
  return { ...dash, eligibleRewards: rewards };
});

/** Apply to become a parking partner (admin approval required). */
export const POST = route(async (req: Request) => {
  const user = await requireRole(["partner"]);
  await rateLimit("partner", user.id);
  const input = await body(req, partnerSchema);
  return { partner: await registerPartner(getContext(), user.id, input) };
});
