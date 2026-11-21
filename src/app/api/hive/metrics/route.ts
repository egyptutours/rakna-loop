import { route } from "@/lib/api/handler";
import { requireRole } from "@/lib/auth/session";
import { getContext } from "@/lib/data";
import { hiveImpactMetrics } from "@/lib/hive/metrics";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  await requireRole(["admin"]);
  const ctx = getContext();
  return { metrics: await hiveImpactMetrics(ctx), config: await ctx.repo.getHiveConfig() };
});
