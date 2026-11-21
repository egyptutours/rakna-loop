import "server-only";
import { cookies, headers } from "next/headers";
import { createClient } from "@supabase/supabase-js";
import { getDataMode } from "../config";
import { getRepo } from "../data";
import { DomainError } from "../domain/errors";
import type { Profile, Role } from "../types";
import { JwtError, verifyJwt } from "./jwt";

/**
 * Authentication.
 *  - DEMO MODE: the demo account switcher sets an httpOnly cookie with a demo user
 *    id. Only seeded demo accounts can be selected; this is NOT production auth.
 *  - SUPABASE MODE: the browser sends its Supabase access token as a Bearer token;
 *    the server verifies it with Supabase Auth and loads the profile (role is read
 *    from the database, never from the client).
 */

export const DEMO_COOKIE = "rakna_demo_uid";
export const LANG_COOKIE = "rakna_lang";

export async function getCurrentUser(): Promise<Profile | null> {
  const repo = getRepo();
  if (getDataMode() === "demo") {
    const id = (await cookies()).get(DEMO_COOKIE)?.value;
    if (!id) return null;
    const p = await repo.getProfile(id);
    return p && p.isDemo ? p : null;
  }
  const auth = (await headers()).get("authorization");
  const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return null;
  // Fast path (optional): verify the JWT locally against the project's JWKS — no GoTrue round trip.
  const jwksUrl = process.env.SUPABASE_JWKS_URL;
  if (jwksUrl) {
    try {
      const base = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, "");
      const claims = await verifyJwt(token, jwksUrl, { issuer: base ? `${base}/auth/v1` : undefined, audience: "authenticated" });
      return repo.getProfile(claims.sub);
    } catch (e) {
      if (e instanceof JwtError) return null; // invalid/expired token: never fall through to a weaker check
      console.error("[rakna] JWKS verification unavailable; falling back to auth.getUser()", (e as Error)?.message);
    }
  }
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } });
  const { data, error } = await sb.auth.getUser(token);
  if (error || !data.user) return null;
  return repo.getProfile(data.user.id);
}

export async function requireUser(): Promise<Profile> {
  const user = await getCurrentUser();
  if (!user) throw new DomainError("unauthenticated", "Sign in or pick a demo account first");
  if (user.deletedAt) throw new DomainError("unauthenticated", "This account was deleted");
  return user;
}

export function assertRole(user: Profile, roles: Role[]): void {
  if (!roles.includes(user.role)) throw new DomainError("forbidden", `This action requires role: ${roles.join(" or ")}`);
}

export async function requireRole(roles: Role[]): Promise<Profile> {
  const user = await requireUser();
  assertRole(user, roles);
  return user;
}
