import { z } from "zod";
import { body, route } from "@/lib/api/handler";
import { getCurrentUser } from "@/lib/auth/session";
import { isDemoMode } from "@/lib/config";
import { getContext, resetDemoData } from "@/lib/data";
import { DomainError } from "@/lib/domain/errors";
import { resetRateLimits } from "@/lib/security/rate-limit";
import { demoDemandBurst } from "@/lib/data/seed";
import { recordDemand } from "@/lib/hive/demand";
import { clearHiveCache } from "@/lib/hive/aggregation-cache";

export const dynamic = "force-dynamic";

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("reset") }).strict(),
  z.object({ action: z.literal("expire_report"), id: z.guid() }).strict(),
  z.object({ action: z.literal("simulate_demand") }).strict(),
]);

/** DEMO-ONLY controls. Disabled (403) whenever the app runs against Supabase. */
export const POST = route(async (req: Request) => {
  if (!isDemoMode()) throw new DomainError("forbidden", "Demo controls are disabled outside demo mode");
  const user = await getCurrentUser();
  if (!user) throw new DomainError("unauthenticated");
  const input = await body(req, schema);
  if (input.action === "reset") {
    resetDemoData();
    resetRateLimits();
    clearHiveCache();
    return { reset: true };
  }
  const ctx = getContext();
  if (input.action === "simulate_demand") {
    // DEMO DATA: anonymous search intents, flagged isDemo, to exercise hive states.
    for (const p of demoDemandBurst()) await recordDemand(ctx, p, p.n, true);
    return { simulated: true };
  }
  const r = await ctx.repo.getReport(input.id);
  if (!r) throw new DomainError("not_found");
  // Time travel for testing freshness rules: move the expiry into the past.
  const past = new Date(ctx.now().getTime() - 1000).toISOString();
  await ctx.repo.updateReport(r.id, { expiresAt: past, claimExpiresAt: r.claimExpiresAt ? past : null });
  return { expired: true };
});
