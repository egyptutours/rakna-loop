import { body, route } from "@/lib/api/handler";
import { requireUser } from "@/lib/auth/session";
import { getContext } from "@/lib/data";
import { DomainError } from "@/lib/domain/errors";
import { canManageSpace, setAvailabilityRules } from "@/lib/domain/home";
import { rateLimit } from "@/lib/security/rate-limit";
import { scheduleRulesSchema } from "@/lib/security/schemas";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Weekly rules and upcoming exceptions of a space the caller manages (host or owning partner). */
export const GET = route(async (_req: Request, { params }: Ctx) => {
  const { id } = await params;
  const user = await requireUser();
  const ctx = getContext();
  const space = await ctx.repo.getSpace(id);
  if (!space) throw new DomainError("not_found");
  if (user.role !== "admin" && !(await canManageSpace(ctx, user.id, space))) throw new DomainError("forbidden");
  const [rules, exceptions] = await Promise.all([ctx.repo.listAvailabilityRules([id]), ctx.repo.listAvailabilityExceptions([id], ctx.now().toISOString().slice(0, 10))]);
  return { rules, exceptions };
});

/** Replace the space's weekly availability (integer halalas, Riyadh-local minutes). */
export const POST = route(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const user = await requireUser();
  await rateLimit("host", user.id);
  const { rules } = await body(req, scheduleRulesSchema);
  return { rules: await setAvailabilityRules(getContext(), user.id, id, rules) };
});
