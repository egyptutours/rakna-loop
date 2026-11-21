import { describe, expect, it } from "vitest";
import { bookingSchema, confirmSchema, createReportSchema, redeemSchema, rulesSchema } from "@/lib/security/schemas";
import { buildSeed } from "@/lib/data/seed";

describe("Input validation", () => {
  it("accepts every seeded demo id (regression: strict RFC-variant UUID checks rejected some)", () => {
    const s = buildSeed();
    for (const sp of s.spaces) expect(bookingSchema.safeParse({ spaceId: sp.id, startAt: new Date().toISOString(), hours: 1 }).success).toBe(true);
    for (const r of s.rewards) expect(redeemSchema.safeParse({ rewardId: r.id }).success).toBe(true);
  });

  it("rejects unknown keys, bad ids and out-of-range values", () => {
    expect(redeemSchema.safeParse({ rewardId: "not-an-id" }).success).toBe(false);
    expect(redeemSchema.safeParse({ rewardId: "00000000-0000-4000-9000-000000000001", amount: 999 }).success).toBe(false);
    expect(createReportSchema.safeParse({ location: { lat: 24.7, lng: 46.6 }, accuracyM: 10, evidence: "gps", departInMinutes: 3 }).success).toBe(false);
    expect(confirmSchema.safeParse({ location: { lat: 99, lng: 46.6 }, accuracyM: 10, evidence: "gps", outcome: "found" }).success).toBe(false);
    expect(bookingSchema.safeParse({ spaceId: "00000000-0000-4000-f000-000000000001", startAt: "tomorrow", hours: 1 }).success).toBe(false);
    expect(rulesSchema.safeParse({ departureReward: 1.5 }).success).toBe(false);
  });

  it("never lets a client submit ledger fields such as amount or balance", () => {
    // There is no schema or route that accepts a points amount from the client.
    expect(confirmSchema.safeParse({ location: null, accuracyM: null, evidence: "none", outcome: "found", keys: 100 }).success).toBe(false);
  });
});
