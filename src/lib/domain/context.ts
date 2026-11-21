import type { Repo } from "../data/repo";

/** Everything a domain operation needs. `now` is injectable so tests can control time. */
export interface DomainContext {
  repo: Repo;
  now: () => Date;
  /** True only in demo mode: allows simulated location evidence. */
  allowSimulatedEvidence: boolean;
}

export function newId(): string {
  return globalThis.crypto.randomUUID();
}

export function iso(d: Date): string {
  return d.toISOString();
}

export function addMinutes(d: Date, m: number): Date {
  return new Date(d.getTime() + m * 60_000);
}

/** Riyadh is UTC+3 all year (no DST). */
const RIYADH_OFFSET_MS = 3 * 60 * 60 * 1000;

/** Start of the current Riyadh calendar day, as a UTC Date. */
export function riyadhDayStart(now: Date): Date {
  const local = new Date(now.getTime() + RIYADH_OFFSET_MS);
  local.setUTCHours(0, 0, 0, 0);
  return new Date(local.getTime() - RIYADH_OFFSET_MS);
}

/** Riyadh local parts (day-of-week 0=Sunday, hour) for a UTC instant. */
export function riyadhParts(d: Date): { day: number; hour: number; minute: number } {
  const local = new Date(d.getTime() + RIYADH_OFFSET_MS);
  return { day: local.getUTCDay(), hour: local.getUTCHours(), minute: local.getUTCMinutes() };
}

export function daysAgo(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 86_400_000);
}
