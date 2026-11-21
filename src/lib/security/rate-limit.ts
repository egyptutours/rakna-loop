import { DomainError } from "../domain/errors";
import type { Repo } from "../data/repo";

/**
 * Fixed-window rate limiter for sensitive actions (blocker B2).
 *  • SUPABASE MODE: the counter lives in Postgres (check_rate_limit() RPC, table rate_limits,
 *    migration 0007), so every server instance shares it.
 *  • DEMO MODE / tests: an in-process map (single instance by definition).
 *  • If the shared limiter errors (database unreachable), the in-process limiter still
 *    applies — the request is never left unlimited.
 */

const windows = new Map<string, { count: number; resetAt: number }>();

export const LIMITS = {
  report: { max: 6, windowMs: 10 * 60_000 },
  claim: { max: 12, windowMs: 10 * 60_000 },
  confirm: { max: 12, windowMs: 10 * 60_000 },
  redeem: { max: 8, windowMs: 10 * 60_000 },
  booking: { max: 10, windowMs: 10 * 60_000 },
  assistant: { max: 20, windowMs: 10 * 60_000 },
  admin: { max: 120, windowMs: 10 * 60_000 },
  partner: { max: 30, windowMs: 10 * 60_000 },
  host: { max: 30, windowMs: 10 * 60_000 },
  bookingEvent: { max: 30, windowMs: 10 * 60_000 },
  access: { max: 60, windowMs: 10 * 60_000 },
  webhook: { max: 300, windowMs: 60_000 },
} as const;

export type RateLimitAction = keyof typeof LIMITS;

function limited(action: RateLimitAction, retryAfterS: number): DomainError {
  return new DomainError("rate_limited", "Too many requests — please slow down", { action, retryAfterS });
}

/** In-process limiter (synchronous). */
export function rateLimitLocal(action: RateLimitAction, subject: string, now = Date.now()): void {
  const { max, windowMs } = LIMITS[action];
  const key = `${action}:${subject}`;
  const w = windows.get(key);
  if (!w || w.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }
  if (w.count >= max) throw limited(action, Math.ceil((w.resetAt - now) / 1000));
  w.count++;
}

async function defaultRepo(): Promise<Repo> {
  const { getRepo } = await import("../data");
  return getRepo();
}

/**
 * Enforce a limit. Pass `repo` explicitly in tests; routes use the configured adapter.
 * Throws DomainError("rate_limited") (HTTP 429) when the window is exhausted.
 */
export async function rateLimit(action: RateLimitAction, subject: string, opts: { repo?: Repo; now?: number } = {}): Promise<void> {
  const now = opts.now ?? Date.now();
  const repo = opts.repo ?? (await defaultRepo());
  if (repo.kind !== "supabase") return rateLimitLocal(action, subject, now);
  const { max, windowMs } = LIMITS[action];
  let allowed: boolean;
  try {
    allowed = await repo.checkRateLimit(`${action}:${subject}`, max, Math.round(windowMs / 1000), new Date(now).toISOString());
  } catch (e) {
    console.error("[rakna] shared rate limiter unavailable; using the in-process limiter", (e as Error)?.message);
    return rateLimitLocal(action, subject, now);
  }
  if (!allowed) throw limited(action, Math.ceil((windowMs - (now % windowMs)) / 1000));
}

export function resetRateLimits(): void {
  windows.clear();
}
