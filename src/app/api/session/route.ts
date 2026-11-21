import { cookies } from "next/headers";
import { z } from "zod";
import { body, route } from "@/lib/api/handler";
import { DEMO_COOKIE, getCurrentUser } from "@/lib/auth/session";
import { aiConfigured, isDemoMode } from "@/lib/config";
import { getRepo } from "@/lib/data";
import { DEMO_PENDING_PARTNER, DEMO_USERS } from "@/lib/data/seed";
import { DomainError } from "@/lib/domain/errors";

export const dynamic = "force-dynamic";

/** Accounts offered in the demo switcher (plus a pending partner applicant). */
const SWITCHABLE: string[] = [...Object.values(DEMO_USERS), DEMO_PENDING_PARTNER];

export const GET = route(async () => {
  const user = await getCurrentUser();
  const demo = isDemoMode();
  const demoUsers = demo
    ? (await getRepo().listProfiles())
        .filter((p) => p.isDemo && SWITCHABLE.includes(p.id))
        .map((p) => ({ id: p.id, displayName: p.displayName, displayNameAr: p.displayNameAr, role: p.role }))
    : [];
  return { user, demoMode: demo, aiEnabled: aiConfigured(), demoUsers };
});

/** DEMO ONLY: switch between seeded demo accounts. */
export const POST = route(async (req: Request) => {
  if (!isDemoMode()) throw new DomainError("forbidden", "Account switching is only available in demo mode");
  const { userId } = await body(req, z.object({ userId: z.guid() }).strict());
  const profile = await getRepo().getProfile(userId);
  if (!profile || !profile.isDemo) throw new DomainError("not_found", "Unknown demo account");
  (await cookies()).set(DEMO_COOKIE, profile.id, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 60 * 60 * 24 * 7 });
  return { user: profile };
});

export const DELETE = route(async () => {
  (await cookies()).delete(DEMO_COOKIE);
  return { user: null };
});
