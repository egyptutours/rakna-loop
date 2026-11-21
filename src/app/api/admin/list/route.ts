import { z } from "zod";
import { route } from "@/lib/api/handler";
import { requireRole } from "@/lib/auth/session";
import { getContext } from "@/lib/data";
import { rateLimit } from "@/lib/security/rate-limit";
import { pageQuerySchema } from "@/lib/security/schemas";

export const dynamic = "force-dynamic";

const query = pageQuerySchema.extend({ entity: z.enum(["profiles", "partners", "spaces", "bookings"]) });

/**
 * Keyset-paginated admin lists (blocker B7): newest first, `?entity=&limit=&cursor=`.
 * The next page's cursor is returned as `nextCursor` (null on the last page).
 */
export const GET = route(async (req: Request) => {
  const admin = await requireRole(["admin"]);
  await rateLimit("admin", admin.id);
  const q = query.parse(Object.fromEntries(new URL(req.url).searchParams));
  return getContext().repo.listPage(q.entity, { limit: q.limit, cursor: q.cursor ?? null });
});
