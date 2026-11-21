import { describe, expect, it } from "vitest";
import { claimReport, computeConfidence, confirmReport, createReport, reliabilityFrom, resolveFlaggedReport } from "@/lib/domain/handoff";
import { getBalance } from "@/lib/domain/ledger";
import { DEFAULT_RULES } from "@/lib/config";
import { A, ADMIN, B, OLAYA_SPOT, PARTNER, gps, move, none, setup, sim } from "./helpers";

async function report(env: ReturnType<typeof setup>, departInMinutes = 0, where = OLAYA_SPOT, user = A) {
  return createReport(env.ctx, user, { ...gps(where, 8), departInMinutes });
}

describe("1. Reporting a valid departure", () => {
  it("creates an available signal with a TTL-based expiry", async () => {
    const env = setup();
    const r = await report(env);
    expect(r.status).toBe("available");
    expect(r.reporterId).toBe(A);
    expect(r.neighborhood).toBe("olaya");
    expect(new Date(r.expiresAt).getTime() - env.now.getTime()).toBe(DEFAULT_RULES.reportTtlMinutes * 60_000);
  });

  it("creates a pending-departure signal that becomes available on time", async () => {
    const env = setup();
    const r = await report(env, 5);
    expect(r.status).toBe("pending_departure");
    env.advance(5);
    const claimed = await claimReport(env.ctx, B, r.id, none);
    expect(claimed.status).toBe("claimed");
  });

  it("rejects reports outside Riyadh, with poor GPS accuracy, or from non-drivers", async () => {
    const env = setup();
    await expect(createReport(env.ctx, A, { ...gps({ lat: 21.5, lng: 39.2 }), departInMinutes: 0 })).rejects.toMatchObject({ code: "outside_service_area" });
    await expect(createReport(env.ctx, A, { ...gps(OLAYA_SPOT, 250), departInMinutes: 0 })).rejects.toMatchObject({ code: "low_accuracy" });
    await expect(createReport(env.ctx, PARTNER, { ...gps(OLAYA_SPOT), departInMinutes: 0 })).rejects.toMatchObject({ code: "forbidden" });
    await expect(createReport(env.ctx, A, { ...none, departInMinutes: 0 })).rejects.toMatchObject({ code: "validation" });
  });

  it("allows only one active report per driver", async () => {
    const env = setup();
    await report(env);
    await expect(report(env, 0, move(OLAYA_SPOT, 500))).rejects.toMatchObject({ code: "duplicate_report" });
  });

  it("rejects simulated location outside demo mode", async () => {
    const env = setup({ simulated: false });
    await expect(createReport(env.ctx, A, { ...sim(OLAYA_SPOT), departInMinutes: 0 })).rejects.toMatchObject({ code: "validation" });
  });
});

describe("2. Rejecting expired reports", () => {
  it("cannot claim a report after its TTL", async () => {
    const env = setup();
    const r = await report(env);
    env.advance(DEFAULT_RULES.reportTtlMinutes + 1);
    await expect(claimReport(env.ctx, B, r.id, none)).rejects.toMatchObject({ code: "report_expired" });
    expect((await env.repo.getReport(r.id))!.status).toBe("expired");
  });

  it("cannot confirm after the claim window and report have expired", async () => {
    const env = setup();
    const r = await report(env);
    await claimReport(env.ctx, B, r.id, gps(move(OLAYA_SPOT, 300)));
    env.advance(DEFAULT_RULES.reportTtlMinutes + DEFAULT_RULES.claimTtlMinutes + 1);
    await expect(confirmReport(env.ctx, B, r.id, { ...gps(OLAYA_SPOT), outcome: "found" })).rejects.toMatchObject({ code: "report_expired" });
    expect(await getBalance(env.ctx, A)).toBe(38); // unchanged seed balance
  });
});

describe("3. Rejecting self-confirmation", () => {
  it("blocks the reporter from claiming or confirming their own report and raises a flag", async () => {
    const env = setup();
    const r = await report(env);
    await expect(claimReport(env.ctx, A, r.id, none)).rejects.toMatchObject({ code: "self_confirmation" });
    await expect(confirmReport(env.ctx, A, r.id, { ...gps(OLAYA_SPOT), outcome: "found" })).rejects.toMatchObject({ code: "self_confirmation" });
    const flags = await env.repo.listFraudFlags({ userId: A });
    expect(flags.map((f) => f.kind)).toContain("self_confirmation_attempt");
    expect(await getBalance(env.ctx, A)).toBe(38);
  });

  it("requires the confirmer to be the active claimer", async () => {
    const env = setup();
    const r = await report(env);
    await expect(confirmReport(env.ctx, B, r.id, { ...gps(OLAYA_SPOT), outcome: "found" })).rejects.toMatchObject({ code: "not_claimer" });
  });
});

describe("4. Rejecting duplicate reward claims", () => {
  it("pays a handoff once even if confirmed twice", async () => {
    const env = setup();
    const r = await report(env);
    await claimReport(env.ctx, B, r.id, gps(move(OLAYA_SPOT, 400)));
    env.advance(3);
    await confirmReport(env.ctx, B, r.id, { ...gps(move(OLAYA_SPOT, 15)), outcome: "found" });
    await expect(confirmReport(env.ctx, B, r.id, { ...gps(OLAYA_SPOT), outcome: "found" })).rejects.toMatchObject({ code: "already_confirmed" });
    const keys = (await env.repo.listLedger()).filter((e) => e.refId === r.id).map((e) => e.idempotencyKey);
    expect(keys.sort()).toEqual([`report:${r.id}:confirmer`, `report:${r.id}:reporter`]);
  });

  it("prevents a second driver from claiming an already-claimed signal", async () => {
    const env = setup();
    const r = await report(env);
    await claimReport(env.ctx, B, r.id, none);
    await expect(claimReport(env.ctx, "00000000-0000-4000-a000-000000000101", r.id, none)).rejects.toMatchObject({ code: "already_claimed_other" });
  });
});

describe("5. Successfully verifying a parking handoff", () => {
  it("marks the report found and rewards both drivers server-side", async () => {
    const env = setup();
    const before = { a: await getBalance(env.ctx, A), b: await getBalance(env.ctx, B) };
    const r = await report(env);
    await claimReport(env.ctx, B, r.id, gps(move(OLAYA_SPOT, 600)));
    env.advance(4);
    const res = await confirmReport(env.ctx, B, r.id, { ...gps(move(OLAYA_SPOT, 20), 12), outcome: "found" });
    expect(res.heldForReview).toBe(false);
    expect(res.report.status).toBe("found");
    expect(res.confirmation.accepted).toBe(true);
    expect(res.confirmation.distanceM).toBeLessThan(30);
    expect(await getBalance(env.ctx, A)).toBe(before.a + DEFAULT_RULES.departureReward);
    expect(await getBalance(env.ctx, B)).toBe(before.b + DEFAULT_RULES.confirmationReward);
  });

  it("rejects a 'found' confirmation from too far away (GPS tolerance applied)", async () => {
    const env = setup();
    const r = await report(env);
    await claimReport(env.ctx, B, r.id, none);
    env.advance(3);
    await expect(confirmReport(env.ctx, B, r.id, { ...gps(move(OLAYA_SPOT, 600)), outcome: "found" })).rejects.toMatchObject({ code: "too_far" });
    // Within tolerance (120 m + half of 40 m accuracy = 140 m) is accepted.
    const ok = await confirmReport(env.ctx, B, r.id, { ...gps(move(OLAYA_SPOT, 135), 40), outcome: "found" });
    expect(ok.report.status).toBe("found");
  });

  it("releases the signal when 'not available' is reported without on-site evidence", async () => {
    const env = setup();
    const r = await report(env);
    await claimReport(env.ctx, B, r.id, none);
    const res = await confirmReport(env.ctx, B, r.id, { ...none, outcome: "not_found" });
    expect(res.report.status).toBe("available");
    expect(res.report.claimedBy).toBeNull();
    expect(await getBalance(env.ctx, B)).toBe(10 + 2); // seed: 10 mission + 2 confirmation history
  });

  it("records a verified 'not found' and pays only the confirmer", async () => {
    const env = setup();
    const r = await report(env);
    await claimReport(env.ctx, B, r.id, none);
    env.advance(2);
    const res = await confirmReport(env.ctx, B, r.id, { ...gps(move(OLAYA_SPOT, 10)), outcome: "not_found" });
    expect(res.report.status).toBe("not_found");
    expect(res.rewards.reporter).toBeNull();
    expect(res.rewards.confirmer?.awarded).toBe(DEFAULT_RULES.confirmationReward);
  });
});

describe("Fraud and suspicious location activity", () => {
  it("holds an impossible-travel handoff for review, then pays after admin approval", async () => {
    const env = setup();
    const r = await report(env);
    await claimReport(env.ctx, B, r.id, gps(move(OLAYA_SPOT, 9000))); // 9 km away
    env.advanceSeconds(30); // "arrives" in 30 s → ~300 m/s
    const res = await confirmReport(env.ctx, B, r.id, { ...gps(move(OLAYA_SPOT, 5)), outcome: "found" });
    expect(res.heldForReview).toBe(true);
    expect(res.report.status).toBe("flagged");
    expect(await getBalance(env.ctx, A)).toBe(38);
    expect((await env.repo.listFraudFlags()).some((f) => f.kind === "impossible_travel" && f.severity === "high")).toBe(true);

    const decided = await resolveFlaggedReport(env.ctx, ADMIN, r.id, true);
    expect(decided.report.status).toBe("found");
    expect(await getBalance(env.ctx, A)).toBe(38 + DEFAULT_RULES.departureReward);
    expect((await env.repo.listAudit()).some((a) => a.action === "report.release_rewards")).toBe(true);
  });

  it("flags a rapid arrival from far away", async () => {
    const env = setup();
    const r = await report(env);
    await claimReport(env.ctx, B, r.id, gps(move(OLAYA_SPOT, 450)));
    env.advanceSeconds(10);
    const res = await confirmReport(env.ctx, B, r.id, { ...gps(OLAYA_SPOT), outcome: "found" });
    expect(res.heldForReview).toBe(true);
    expect((await env.repo.listFraudFlags()).map((f) => f.kind)).toContain("rapid_arrival");
  });

  it("flags repeated handoffs between the same pair of drivers (collusion)", async () => {
    const env = setup();
    let last;
    for (let i = 0; i < 4; i++) {
      const r = await report(env, 0, move(OLAYA_SPOT, i * 200));
      await claimReport(env.ctx, B, r.id, none);
      env.advance(3);
      last = await confirmReport(env.ctx, B, r.id, { ...gps(move(OLAYA_SPOT, i * 200 + 5)), outcome: "found" });
      env.advance(40);
    }
    expect(last!.heldForReview).toBe(true);
    expect((await env.repo.listFraudFlags()).map((f) => f.kind)).toContain("pair_collusion");
  });

  it("flags repeated far-away confirmation attempts", async () => {
    const env = setup();
    for (let i = 0; i < 4; i++) {
      const r = await report(env, 0, move(OLAYA_SPOT, i * 300));
      await claimReport(env.ctx, B, r.id, none);
      await expect(confirmReport(env.ctx, B, r.id, { ...gps(move(OLAYA_SPOT, 5000)), outcome: "found" })).rejects.toMatchObject({ code: "too_far" });
      await confirmReport(env.ctx, B, r.id, { ...none, outcome: "not_found" }); // release
      env.advance(31);
      await env.repo.updateReport(r.id, { status: "expired" });
    }
    expect((await env.repo.listFraudFlags({ userId: B })).map((f) => f.kind)).toContain("too_far_confirmation");
  });

  it("flags report spam at the same spot", async () => {
    const env = setup();
    for (let i = 0; i < 2; i++) {
      const r = await report(env);
      await env.repo.updateReport(r.id, { status: "expired" });
      env.advance(2);
    }
    await expect(report(env)).rejects.toMatchObject({ code: "duplicate_report" });
    expect((await env.repo.listFraudFlags({ userId: A })).map((f) => f.kind)).toContain("report_spam");
  });
});

describe("Confidence score", () => {
  it("is transparent, bounded, and never labelled as a guarantee", async () => {
    const env = setup();
    const r = await report(env);
    const base = { report: r, now: env.now, rules: DEFAULT_RULES, nearbyHistory: [] };
    const strong = computeConfidence({ ...base, reliability: { successful: 9, notFound: 0, expired: 0, score: 10 / 11 }, viewer: move(OLAYA_SPOT, 100) });
    const weak = computeConfidence({ ...base, report: { ...r, accuracyM: 90 }, now: new Date(env.now.getTime() + 18 * 60_000), reliability: { successful: 0, notFound: 4, expired: 0, score: 1 / 6 }, viewer: move(OLAYA_SPOT, 5000) });
    expect(strong.level).toBe("high");
    expect(weak.level).toBe("low");
    expect(strong.factors.map((f) => f.key)).toEqual(["freshness", "accuracy", "distance", "reliability", "history"]);
    expect(strong.factors.reduce((s, f) => s + f.weight, 0)).toBeCloseTo(1);
    expect(strong.score).toBeLessThanOrEqual(100);
    expect(reliabilityFrom([]).score).toBe(0.5);
  });
});
