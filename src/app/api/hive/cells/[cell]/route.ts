import { z } from "zod";
import { route } from "@/lib/api/handler";
import { getContext } from "@/lib/data";
import { getCurrentUser } from "@/lib/auth/session";
import { DomainError } from "@/lib/domain/errors";
import { summarizeCells } from "@/lib/hive/aggregation";
import { cellCenter, cellRing, childrenOf, isCell, neighborhood, parentOf, resolutionOf } from "@/lib/hive/cells";

export const dynamic = "force-dynamic";

/** One hive cell: summary, parent, neighbors (k rings) and optionally child summaries. */
export const GET = route(async (req: Request, { params }: { params: Promise<{ cell: string }> }) => {
  const { cell } = await params;
  if (!isCell(cell)) throw new DomainError("validation", "Invalid H3 cell");
  const res = resolutionOf(cell);
  if (res < 7 || res > 10) throw new DomainError("validation", "Hive resolutions are 7–10");
  const url = new URL(req.url);
  const { k, children } = z.object({ k: z.coerce.number().int().min(0).max(3).default(1), children: z.enum(["0", "1"]).default("0") }).parse(Object.fromEntries(url.searchParams));
  // Privacy (audit F-PRIV-2): street-level (r10) live summaries could pinpoint a single
  // signal, so r10 cells — directly or as children — are admin-only.
  const user = await getCurrentUser();
  if ((res === 10 || (children === "1" && res === 9)) && user?.role !== "admin") throw new DomainError("forbidden", "Street-level hive detail is restricted");
  const ctx = getContext();
  const ring = neighborhood(cell, k);
  const summaries = await summarizeCells(ctx, res, ring);
  const kids = children === "1" && res < 10 ? await summarizeCells(ctx, res + 1, childrenOf(cell, res + 1)) : null;
  return {
    cell,
    resolution: res,
    parent: res > 7 ? parentOf(cell, res - 1) : null,
    center: cellCenter(cell),
    ring: cellRing(cell),
    summary: summaries.get(cell),
    neighbors: ring.filter((c) => c !== cell).map((c) => summaries.get(c)),
    children: kids ? [...kids.values()] : undefined,
  };
});
