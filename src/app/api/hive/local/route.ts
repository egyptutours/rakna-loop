import { z } from "zod";
import { route } from "@/lib/api/handler";
import { getCurrentUser } from "@/lib/auth/session";
import { getContext } from "@/lib/data";
import { summarizeCells } from "@/lib/hive/aggregation";
import { hiveIndexFor, neighborhood } from "@/lib/hive/cells";
import { activityRoleFor } from "@/lib/hive/swarm";

export const dynamic = "force-dynamic";

/** Local hive activity around a point (read-only; does NOT record demand). */
export const GET = route(async (req: Request) => {
  const q = z.object({ lat: z.coerce.number().min(-90).max(90), lng: z.coerce.number().min(-180).max(180) }).parse(Object.fromEntries(new URL(req.url).searchParams));
  const ctx = getContext();
  const home = hiveIndexFor(q).r9;
  const ring = neighborhood(home, 1);
  const summaries = await summarizeCells(ctx, 9, ring);
  return {
    homeCell: home,
    home: summaries.get(home),
    neighbors: ring.filter((c) => c !== home).map((c) => summaries.get(c)),
    role: await activityRoleFor(ctx, await getCurrentUser()),
  };
});
