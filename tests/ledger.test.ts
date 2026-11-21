import { describe, expect, it } from "vitest";
import { awardPoints, balanceOf, getBalance, reversePoints, spendPoints, walletSummary } from "@/lib/domain/ledger";
import { decideRedemption, redeemReward } from "@/lib/domain/rewards";
import { claimReport, confirmReport, createReport } from "@/lib/domain/handoff";
import { updateRules } from "@/lib/domain/admin";
import { DEFAULT_RULES } from "@/lib/config";
import { A, ADMIN, B, OLAYA_SPOT, gps, move, none, setup } from "./helpers";

const CAR_WASH = "00000000-0000-4000-9000-000000000003";
const PARKING_20 = "00000000-0000-4000-9000-000000000001";

describe("6. Correct point calculation", () => {
  it("applies the configured reward values, including the handoff bonus", async () => {
    const env = setup();
    const start = await getBalance(env.ctx, A); // seed: 8 (one earlier handoff) + 30
    expect(start).toBe(38);
    // A already has 1 verified handoff in the seed → the 3rd success triggers the bonus.
    for (let i = 0; i < 2; i++) {
      const r = await createReport(env.ctx, A, { ...gps(move(OLAYA_SPOT, i * 400)), departInMinutes: 0 });
      const finder = i === 0 ? B : "00000000-0000-4000-a000-000000000101";
      if (i === 1) await env.repo.updateReport("00000000-0000-4000-c000-000000000001", { status: "expired" }); // free Noura's own active report
      await claimReport(env.ctx, finder, r.id, none);
      env.advance(3);
      await confirmReport(env.ctx, finder, r.id, { ...gps(move(OLAYA_SPOT, i * 400 + 10)), outcome: "found" });
      env.advance(30);
    }
    expect(await getBalance(env.ctx, A)).toBe(start + 2 * DEFAULT_RULES.departureReward + DEFAULT_RULES.streakBonus);
  });

  it("uses edited admin rules for new awards and audits the change", async () => {
    const env = setup();
    await updateRules(env.ctx, ADMIN, { departureReward: 12 });
    const r = await createReport(env.ctx, A, { ...gps(OLAYA_SPOT), departInMinutes: 0 });
    await claimReport(env.ctx, B, r.id, none);
    env.advance(2);
    await confirmReport(env.ctx, B, r.id, { ...gps(OLAYA_SPOT), outcome: "found" });
    expect(await getBalance(env.ctx, A)).toBe(38 + 12);
    expect((await env.repo.listAudit()).find((a) => a.action === "rules.update")?.details).toContain("departureReward: 8 → 12");
    await expect(updateRules(env.ctx, ADMIN, { departureReward: -5 })).rejects.toMatchObject({ code: "validation" });
  });

  it("enforces the configurable daily earning limit", async () => {
    const env = setup();
    await updateRules(env.ctx, ADMIN, { dailyEarnLimit: 10 });
    const first = await awardPoints(env.ctx, { userId: B, amount: 8, type: "departure_reward", reason: "t", idempotencyKey: "t:1" });
    const second = await awardPoints(env.ctx, { userId: B, amount: 8, type: "departure_reward", reason: "t", idempotencyKey: "t:2" });
    const third = await awardPoints(env.ctx, { userId: B, amount: 8, type: "departure_reward", reason: "t", idempotencyKey: "t:3" });
    expect([first.awarded, second.awarded, third.awarded]).toEqual([8, 2, 0]);
    expect(second.capped).toBe(true);
    expect(third.capped).toBe(true);
  });
});

describe("7. Correct points ledger balance", () => {
  it("derives balances only from ledger entries and is idempotent on keys", async () => {
    const env = setup();
    const r1 = await awardPoints(env.ctx, { userId: B, amount: 5, type: "mission_reward", reason: "x", idempotencyKey: "same-key" });
    const r2 = await awardPoints(env.ctx, { userId: B, amount: 5, type: "mission_reward", reason: "x", idempotencyKey: "same-key" });
    expect(r1.awarded).toBe(5);
    expect(r2.duplicate).toBe(true);
    const entries = await env.repo.listLedger({ userId: B });
    expect(balanceOf(entries)).toBe(await getBalance(env.ctx, B));
    expect(balanceOf(entries)).toBe(12 + 5);
    const w = await walletSummary(env.ctx, B);
    expect(w.balance).toBe(17);
    expect(w.earned).toBe(17);
    expect(w.redeemed).toBe(0);
  });

  it("rejects non-positive award amounts", async () => {
    const env = setup();
    await expect(awardPoints(env.ctx, { userId: B, amount: 0, type: "mission_reward", reason: "x", idempotencyKey: "k0" })).rejects.toMatchObject({ code: "validation" });
    await expect(awardPoints(env.ctx, { userId: B, amount: 2.5, type: "mission_reward", reason: "x", idempotencyKey: "k1" })).rejects.toMatchObject({ code: "validation" });
  });
});

describe("8. Preventing negative balances", () => {
  it("refuses to spend more than the balance at both domain and storage layers", async () => {
    const env = setup();
    await expect(spendPoints(env.ctx, { userId: B, amount: 13, type: "redemption", reason: "x", idempotencyKey: "s1" })).rejects.toMatchObject({ code: "insufficient_balance" });
    await expect(
      env.repo.insertLedger({ id: crypto.randomUUID(), userId: B, amount: -500, type: "redemption", reason: "bypass", idempotencyKey: "raw", refType: null, refId: null, createdAt: new Date().toISOString() }),
    ).rejects.toThrow(/negative balance/);
    expect(await getBalance(env.ctx, B)).toBe(12);
  });

  it("caps fraud reversals at the available balance", async () => {
    const env = setup();
    const res = await reversePoints(env.ctx, { userId: B, amount: 50, reason: "fraud", idempotencyKey: "rev:1" });
    expect(res).toEqual({ reversed: 12, shortfall: 38 });
    expect(await getBalance(env.ctx, B)).toBe(0);
  });

  it("serializes concurrent spends so the balance can't go below zero", async () => {
    const env = setup();
    const attempts = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) => spendPoints(env.ctx, { userId: A, amount: 10, type: "redemption", reason: "race", idempotencyKey: `race:${i}` })),
    );
    expect(attempts.filter((a) => a.status === "fulfilled")).toHaveLength(3); // 38 → 8
    expect(await getBalance(env.ctx, A)).toBe(8);
  });
});

describe("9. Redeeming eligible rewards", () => {
  it("deducts Keys, creates a simulated pending redemption, and refunds on rejection", async () => {
    const env = setup();
    const red = await redeemReward(env.ctx, A, CAR_WASH);
    expect(red.status).toBe("pending_approval");
    expect(red.simulated).toBe(true);
    expect(await getBalance(env.ctx, A)).toBe(38 - 25);
    expect((await env.repo.getReward(CAR_WASH))!.stock).toBe(19);

    const rejected = await decideRedemption(env.ctx, ADMIN, red.id, false);
    expect(rejected.status).toBe("rejected");
    expect(await getBalance(env.ctx, A)).toBe(38);
    expect((await env.repo.getReward(CAR_WASH))!.stock).toBe(20);
    await expect(decideRedemption(env.ctx, ADMIN, red.id, true)).rejects.toMatchObject({ code: "conflict" });
  });

  it("issues a DEMO code on approval", async () => {
    const env = setup();
    const red = await redeemReward(env.ctx, A, CAR_WASH);
    const ok = await decideRedemption(env.ctx, ADMIN, red.id, true);
    expect(ok.code).toMatch(/^DEMO-[A-Z0-9]{6}$/);
  });

  it("rejects redemptions without enough Keys or by non-drivers, and routes discounts to bookings", async () => {
    const env = setup();
    await expect(redeemReward(env.ctx, B, CAR_WASH)).rejects.toMatchObject({ code: "insufficient_balance" });
    await expect(redeemReward(env.ctx, ADMIN, CAR_WASH)).rejects.toMatchObject({ code: "reward_ineligible" });
    await expect(redeemReward(env.ctx, A, PARKING_20)).rejects.toMatchObject({ code: "reward_ineligible" });
  });
});
