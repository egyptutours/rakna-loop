import { body, route } from "@/lib/api/handler";
import { getCurrentUser, requireRole } from "@/lib/auth/session";
import { getContext } from "@/lib/data";
import { badgesFor, challengesFor, contributionScore, neighborhoodStats, submitMission, weeklyLeaderboard } from "@/lib/domain/community";
import { rateLimit } from "@/lib/security/rate-limit";
import { missionSchema } from "@/lib/security/schemas";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const ctx = getContext();
  const user = await getCurrentUser();
  const isDriver = user?.role === "driver";
  const [leaderboard, neighborhoods] = await Promise.all([weeklyLeaderboard(ctx), neighborhoodStats(ctx)]);
  return {
    leaderboard,
    neighborhoods,
    challenges: isDriver ? await challengesFor(ctx, user.id) : (await ctx.repo.listChallenges()).map((c) => ({ ...c, progress: 0, completed: false })),
    badges: isDriver ? await badgesFor(ctx, user.id) : [],
    contributionScore: isDriver ? await contributionScore(ctx, user.id) : null,
    missions: isDriver ? (await ctx.repo.listMissions({ userId: user.id })).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) : [],
  };
});

/** Submit a (simulated) Park & Connect mission for admin approval. */
export const POST = route(async (req: Request) => {
  const user = await requireRole(["driver"]);
  await rateLimit("report", user.id);
  const { kind, description } = await body(req, missionSchema);
  return { mission: await submitMission(getContext(), user.id, kind, description) };
});
