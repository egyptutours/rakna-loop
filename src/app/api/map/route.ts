import { route } from "@/lib/api/handler";
import { getCurrentUser } from "@/lib/auth/session";
import { getContext } from "@/lib/data";
import { queryHiveMap } from "@/lib/hive/map-query";
import { parseViewport } from "@/lib/security/hive-schemas";

export const dynamic = "force-dynamic";

/**
 * DEPRECATED alias of /api/hive/map. The previous version returned every report in the
 * city; it now requires a viewport and returns the same bounded, viewport-scoped data.
 */
export const GET = route(async (req: Request) => {
  const url = new URL(req.url);
  if (!url.searchParams.has("w")) {
    // Default: central Riyadh at neighborhood zoom (never the whole city).
    url.searchParams.set("w", "46.64");
    url.searchParams.set("s", "24.68");
    url.searchParams.set("e", "46.71");
    url.searchParams.set("n", "24.74");
    url.searchParams.set("z", "13");
  }
  return queryHiveMap(getContext(), { ...parseViewport(url), viewer: await getCurrentUser() });
});
