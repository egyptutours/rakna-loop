import type { FraudFlag, FraudKind } from "../types";
import { iso, newId, type DomainContext } from "./context";

/** Record a fraud signal for admin review. De-duplicates identical open flags. */
export async function raiseFlag(
  ctx: DomainContext,
  input: { kind: FraudKind; userId: string; relatedUserId?: string | null; reportId?: string | null; details: string; severity: FraudFlag["severity"] },
): Promise<FraudFlag> {
  const open = await ctx.repo.listFraudFlags({ status: "open", userId: input.userId });
  const dup = open.find((f) => f.kind === input.kind && f.reportId === (input.reportId ?? null) && f.relatedUserId === (input.relatedUserId ?? null));
  if (dup) return dup;
  return ctx.repo.insertFraudFlag({
    id: newId(),
    kind: input.kind,
    userId: input.userId,
    relatedUserId: input.relatedUserId ?? null,
    reportId: input.reportId ?? null,
    details: input.details,
    severity: input.severity,
    status: "open",
    createdAt: iso(ctx.now()),
    reviewedBy: null,
  });
}

/** Speed above which travel between two GPS fixes is physically implausible in a city (~200 km/h). */
export const IMPOSSIBLE_SPEED_MPS = 55;
