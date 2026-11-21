import { cookies } from "next/headers";
import { z } from "zod";
import { body, route } from "@/lib/api/handler";
import { LANG_COOKIE } from "@/lib/auth/session";

export const POST = route(async (req: Request) => {
  const { lang } = await body(req, z.object({ lang: z.enum(["ar", "en"]) }).strict());
  (await cookies()).set(LANG_COOKIE, lang, { sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 365 });
  return { lang };
});
