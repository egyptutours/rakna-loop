import { body, route } from "@/lib/api/handler";
import { requireUser } from "@/lib/auth/session";
import { getContext } from "@/lib/data";
import { rateLimit } from "@/lib/security/rate-limit";
import { feedbackSchema } from "@/lib/security/hive-schemas";

export const dynamic = "force-dynamic";

/** "Was this helpful?" — stored only as aggregate counters (user satisfaction metric). */
export const POST = route(async (req: Request) => {
  const user = await requireUser();
  await rateLimit("confirm", user.id);
  const { helpful } = await body(req, feedbackSchema);
  return { feedback: await getContext().repo.addFeedback(helpful) };
});
