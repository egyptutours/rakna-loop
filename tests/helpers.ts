import { DemoRepo } from "@/lib/data/demo-repo";
import { buildSeed, DEMO_USERS } from "@/lib/data/seed";
import type { DomainContext } from "@/lib/domain/context";
import type { LatLng } from "@/lib/types";

export const A = DEMO_USERS.driverA;
export const B = DEMO_USERS.driverB;
export const PARTNER = DEMO_USERS.partner;
export const ADMIN = DEMO_USERS.admin;
export const PENDING_PARTNER = "00000000-0000-4000-a000-0000000000c2";

/** A fixed Riyadh instant: Tuesday 2026-11-17 10:00 local (07:00 UTC). */
export const T0 = new Date("2026-11-17T07:00:00.000Z");

export const OLAYA_SPOT: LatLng = { lat: 24.7001, lng: 46.6801 };

export function setup(opts: { simulated?: boolean; now?: Date } = {}) {
  let now = new Date((opts.now ?? T0).getTime());
  const repo = new DemoRepo(buildSeed(now));
  const ctx: DomainContext = { repo, now: () => new Date(now.getTime()), allowSimulatedEvidence: opts.simulated ?? true };
  return {
    repo,
    ctx,
    advance(minutes: number) {
      now = new Date(now.getTime() + minutes * 60_000);
    },
    advanceSeconds(s: number) {
      now = new Date(now.getTime() + s * 1000);
    },
    get now() {
      return now;
    },
  };
}

/** Move a point by metres. */
export function move(p: LatLng, northM: number, eastM = 0): LatLng {
  return { lat: p.lat + northM / 111_320, lng: p.lng + eastM / (111_320 * Math.cos((p.lat * Math.PI) / 180)) };
}

export const gps = (location: LatLng, accuracyM = 10) => ({ location, accuracyM, evidence: "gps" as const });
export const sim = (location: LatLng, accuracyM = 10) => ({ location, accuracyM, evidence: "simulated" as const });
export const none = { location: null, accuracyM: null, evidence: "none" as const };
