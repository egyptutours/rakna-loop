import { route } from "@/lib/api/handler";
import { requireRole } from "@/lib/auth/session";
import { getContext } from "@/lib/data";
import { badgesFor, contributionScore } from "@/lib/domain/community";
import { walletSummary } from "@/lib/domain/ledger";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const user = await requireRole(["driver"]);
  const ctx = getContext();
  const [wallet, redemptions, rewards, badges, score] = await Promise.all([
    walletSummary(ctx, user.id),
    ctx.repo.listRedemptions({ userId: user.id }),
    ctx.repo.listRewards(),
    badgesFor(ctx, user.id),
    contributionScore(ctx, user.id),
  ]);
  return {
    ...wallet,
    redemptions: redemptions
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((r) => ({ ...r, reward: rewards.find((x) => x.id === r.rewardId) ?? null })),
    badges,
    contributionScore: score,
  };
});
