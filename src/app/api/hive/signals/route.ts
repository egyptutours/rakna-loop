import { route } from "@/lib/api/handler";
import { getCurrentUser } from "@/lib/auth/session";
import { getContext } from "@/lib/data";
import { queryHiveMap } from "@/lib/hive/map-query";
import { parseViewport } from "@/lib/security/hive-schemas";

export const dynamic = "force-dynamic";

/**
 * Active community signals for a viewport, paginated (?cursor=). Always street-level
 * detail regardless of zoom, but still bounded by the viewport-size guard and page size.
 * Create / claim / confirm / withdraw signals: POST /api/reports, /api/reports/:id/claim,
 * /api/reports/:id/confirm, DELETE /api/reports/:id.
 */
export const GET = route(async (req: Request) => {
  const v = parseViewport(new URL(req.url));
  const res = await queryHiveMap(getContext(), { ...v, zoom: Math.max(v.zoom, 16), viewer: await getCurrentUser() });
  return { signals: res.signals, clusters: res.clusters, meta: res.meta };
});
