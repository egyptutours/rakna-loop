import { body, route } from "@/lib/api/handler";
import { getCurrentUser, requireRole } from "@/lib/auth/session";
import { getContext } from "@/lib/data";
import { getBalance } from "@/lib/domain/ledger";
import { redeemReward } from "@/lib/domain/rewards";
import { rateLimit } from "@/lib/security/rate-limit";
import { redeemSchema } from "@/lib/security/schemas";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const ctx = getContext();
  const user = await getCurrentUser();
  const rewards = (await ctx.repo.listRewards()).filter((r) => r.active);
  const balance = user?.role === "driver" ? await getBalance(ctx, user.id) : null;
  return { rewards, balance };
});

/** Redeem a non-booking reward (simulated). Parking discounts are redeemed during booking. */
export const POST = route(async (req: Request) => {
  const user = await requireRole(["driver"]);
  await rateLimit("redeem", user.id);
  const { rewardId } = await body(req, redeemSchema);
  const ctx = getContext();
  const redemption = await redeemReward(ctx, user.id, rewardId);
  return { redemption, balance: await getBalance(ctx, user.id) };
});
