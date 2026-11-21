import { route } from "@/lib/api/handler";
import { getCurrentUser } from "@/lib/auth/session";
import { getContext } from "@/lib/data";
import { maybeRunLifecycle } from "@/lib/hive/lifecycle";
import { queryHiveMap } from "@/lib/hive/map-query";
import { parseViewport } from "@/lib/security/hive-schemas";

export const dynamic = "force-dynamic";

/** Visible hive cells (aggregate zoom) or signals + spaces (street zoom) for ONE viewport. */
export const GET = route(async (req: Request) => {
  const ctx = getContext();
  const v = parseViewport(new URL(req.url));
  await maybeRunLifecycle(ctx); // throttled: expiry + aggregation keep the hot set small
  return queryHiveMap(ctx, { ...v, viewer: await getCurrentUser() });
});
