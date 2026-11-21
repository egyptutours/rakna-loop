import { body, route } from "@/lib/api/handler";
import { getCurrentUser } from "@/lib/auth/session";
import { getContext } from "@/lib/data";
import { quoteHomeBooking } from "@/lib/domain/home";
import { rateLimit } from "@/lib/security/rate-limit";
import { homeBookingSchema } from "@/lib/security/schemas";
import { headers } from "next/headers";

export const dynamic = "force-dynamic";

/** Price a window (no side effects): base fare, 5% driver fee, VAT on the platform fee, Keys discount. */
export const POST = route(async (req: Request) => {
  const user = await getCurrentUser();
  const ip = (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  await rateLimit("access", user?.id ?? `ip:${ip}`);
  const input = await body(req, homeBookingSchema);
  return { quote: await quoteHomeBooking(getContext(), input) };
});
