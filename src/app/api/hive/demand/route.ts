import { body, route } from "@/lib/api/handler";
import { requireUser } from "@/lib/auth/session";
import { getContext } from "@/lib/data";
import { recordDemand } from "@/lib/hive/demand";
import { activityRoleFor, recruit } from "@/lib/hive/swarm";
import { rateLimit } from "@/lib/security/rate-limit";
import { demandSchema } from "@/lib/security/hive-schemas";

export const dynamic = "force-dynamic";

/**
 * Forager intent: "I'm looking for parking here". Records ONE anonymous demand count
 * for the r9 hive (no user id, no exact point) and returns locally recruited options.
 */
export const POST = route(async (req: Request) => {
  // Demand writes require a signed-in user (audit F-SEC-3): anonymous callers could
  // otherwise inflate demand and mark hives "overloaded". The stored counter itself
  // remains anonymous (no user id).
  const user = await requireUser();
  await rateLimit("assistant", user.id);
  const input = await body(req, demandSchema);
  const ctx = getContext();
  const cell = await recordDemand(ctx, input.location, 1, ctx.allowSimulatedEvidence);
  const result = await recruit(ctx, { location: input.location, viewer: user, accessibleOnly: input.accessibleOnly, maxWalkM: input.maxWalkM });
  return { recordedCell: cell, role: await activityRoleFor(ctx, user), ...result };
});
