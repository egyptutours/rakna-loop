import { describe, expect, it } from "vitest";
import { DemoRepo } from "@/lib/data/demo-repo";
import { buildSeed, HOME_SPACES } from "@/lib/data/seed";
import { createHomeBooking } from "@/lib/domain/home";
import type { DomainContext } from "@/lib/domain/context";
import type { Repo } from "@/lib/data/repo";
import { claimReport, confirmReport, createReport, refreshReport } from "@/lib/domain/handoff";
import { awardPoints, getBalance, spendPoints } from "@/lib/domain/ledger";
import { redeemReward } from "@/lib/domain/rewards";
import { createBooking, submitSpace } from "@/lib/domain/marketplace";
import { decideSpace, updateRules } from "@/lib/domain/admin";
import { A, ADMIN, B, OLAYA_SPOT, PARTNER, T0, gps, move, none } from "./helpers";

/**
 * Concurrency scenarios A–E under conditions that mimic several cloud server instances:
 *  • withLock is a NO-OP (no in-process serialization, exactly like the Supabase adapter)
 *  • every storage call is delayed by a random 0–4 ms so concurrent requests interleave
 * Only the storage-level atomic operations (compare-and-set transitions, idempotent ledger
 * inserts with balance/cap checks, atomic stock and capacity) can keep the results correct.
 * The same primitives are implemented in SQL and verified in tests/db/supabase-sql.test.ts.
 */
function racingRepo(now: Date): { repo: Repo; ctx: DomainContext } {
  const inner = new DemoRepo(buildSeed(now));
  const jitter = () => new Promise((r) => setTimeout(r, Math.floor(Math.random() * 5)));
  const repo = new Proxy(inner, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (prop === "withLock") return async (_k: string, fn: () => Promise<unknown>) => fn();
      if (typeof v !== "function") return v;
      return async (...args: unknown[]) => {
        await jitter();
        return (v as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as unknown as Repo;
  return { repo, ctx: { repo, now: () => new Date(now.getTime()), allowSimulatedEvidence: true } };
}

const C = "00000000-0000-4000-a000-000000000101"; // seeded driver (Noura)
const D = "00000000-0000-4000-a000-000000000102"; // seeded driver (Abdullah)

async function freeDrivers(repo: Repo) {
  // Seeded live reports would block the "one live report per driver" rule for C/D.
  for (const id of ["00000000-0000-4000-c000-000000000001", "00000000-0000-4000-c000-000000000002", "00000000-0000-4000-c000-000000000004"]) await repo.updateReport(id, { status: "expired" });
}

describe("Scenario A — two drivers claim the same report at the same instant", () => {
  it("exactly one claim succeeds (repeated 25×)", async () => {
    for (let run = 0; run < 25; run++) {
      const { repo, ctx } = racingRepo(T0);
      await freeDrivers(repo);
      const r = await createReport(ctx, A, { ...gps(OLAYA_SPOT, 8), departInMinutes: 0 });
      const results = await Promise.allSettled([B, C, D].map((u) => claimReport(ctx, u, r.id, none)));
      const ok = results.filter((x) => x.status === "fulfilled");
      expect(ok).toHaveLength(1);
      for (const f of results.filter((x) => x.status === "rejected")) expect((f as PromiseRejectedResult).reason.code).toBe("already_claimed_other");
      const final = (await repo.getReport(r.id))!;
      expect(final.status).toBe("claimed");
      expect((await repo.listClaims({ reportId: r.id })).filter((c) => c.active)).toHaveLength(1);
    }
  }, 120_000);
});

describe("Scenario B — two confirmation requests arrive simultaneously", () => {
  it("processes the handoff exactly once (repeated 25×)", async () => {
    for (let run = 0; run < 25; run++) {
      const { repo, ctx } = racingRepo(T0);
      const r = await createReport(ctx, A, { ...gps(OLAYA_SPOT, 8), departInMinutes: 0 });
      await claimReport(ctx, B, r.id, none);
      const before = await getBalance(ctx, A);
      const results = await Promise.allSettled([1, 2, 3].map(() => confirmReport(ctx, B, r.id, { ...gps(move(OLAYA_SPOT, 5)), outcome: "found" })));
      expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
      for (const f of results.filter((x) => x.status === "rejected")) expect(["already_confirmed", "not_claimer"]).toContain((f as PromiseRejectedResult).reason.code);
      expect((await repo.listConfirmations({ reportId: r.id })).filter((c) => c.accepted)).toHaveLength(1);
      expect((await repo.listLedger()).filter((e) => e.refId === r.id && e.type === "departure_reward")).toHaveLength(1);
      expect(await getBalance(ctx, A)).toBe(before + 8);
    }
  }, 120_000);
});

describe("Scenario C — the same reward request is submitted repeatedly", () => {
  it("never awards duplicate points for one idempotency key", async () => {
    const { repo, ctx } = racingRepo(T0);
    const results = await Promise.all(
      Array.from({ length: 20 }, () => awardPoints(ctx, { userId: B, amount: 5, type: "mission_reward", reason: "x", idempotencyKey: "mission:same" })),
    );
    expect(results.filter((r) => r.awarded > 0)).toHaveLength(1);
    expect((await repo.listLedger()).filter((e) => e.idempotencyKey === "mission:same")).toHaveLength(1);
  });

  it("enforces the daily earning cap under concurrent awards", async () => {
    const { repo, ctx } = racingRepo(T0);
    await updateRules(ctx, ADMIN, { dailyEarnLimit: 40 });
    await Promise.all(Array.from({ length: 12 }, (_, i) => awardPoints(ctx, { userId: C, amount: 8, type: "departure_reward", reason: "x", idempotencyKey: `cap:${i}` })));
    const today = (await repo.listLedger({ userId: C })).filter((e) => e.createdAt >= "2026-11-16T21:00:00.000Z" && e.type === "departure_reward");
    expect(today.reduce((s, e) => s + e.amount, 0)).toBe(40);
  });
});

describe("Scenario D — redeeming more than the available balance", () => {
  it("rejects a single over-balance redemption server-side", async () => {
    const { ctx } = racingRepo(T0);
    expect(await getBalance(ctx, B)).toBe(12);
    await expect(redeemReward(ctx, B, "00000000-0000-4000-9000-000000000003")).rejects.toMatchObject({ code: "insufficient_balance" });
    expect(await getBalance(ctx, B)).toBe(12);
  });

  it("concurrent spends can never push the balance below zero or oversell stock", async () => {
    const { repo, ctx } = racingRepo(T0);
    // Balance 38: at most one 25-Key voucher fits; stock is 20.
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => redeemReward(ctx, A, "00000000-0000-4000-9000-000000000003")));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await getBalance(ctx, A)).toBe(13);
    expect((await repo.getReward("00000000-0000-4000-9000-000000000003"))!.stock).toBe(19); // failed attempts released their reserved unit
    const spends = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => spendPoints(ctx, { userId: A, amount: 5, type: "redemption", reason: "x", idempotencyKey: `s:${i}` })));
    expect(spends.filter((s) => s.status === "fulfilled")).toHaveLength(2);
    expect(await getBalance(ctx, A)).toBe(3);
  });

  it("concurrent bookings never exceed a space's capacity", async () => {
    const { repo, ctx } = racingRepo(T0);
    const s = await submitSpace(ctx, PARTNER, {
      title: "Two-bay garage", titleAr: "", location: { lat: 24.7, lng: 46.68 }, address: "x", addressAr: "", capacity: 2, pricePerHour: 5,
      schedule: { days: [0, 1, 2, 3, 4, 5, 6], openHour: 0, closeHour: 24 }, conditions: "", conditionsAr: "", rewardEligible: false,
    });
    await decideSpace(ctx, ADMIN, s.id, "approved");
    const start = new Date(T0.getTime() + 2 * 3_600_000).toISOString();
    const results = await Promise.allSettled([A, B, C, D, A, B].map((u) => createBooking(ctx, u, { spaceId: s.id, startAt: start, hours: 2 })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect((await repo.listBookings({ spaceId: s.id })).filter((b) => b.status === "confirmed")).toHaveLength(2);
  });
});

describe("Scenario E — a report expires while someone is claiming it", () => {
  it("resolves consistently: claimed (before expiry) XOR expired, never both (repeated 40×)", async () => {
    let claimedWins = 0;
    let expiredWins = 0;
    for (let run = 0; run < 40; run++) {
      const created = new Date(T0.getTime());
      const { repo, ctx } = racingRepo(created);
      const r = await createReport(ctx, A, { ...gps(OLAYA_SPOT, 8), departInMinutes: 0 });
      // Park the clock exactly at the expiry boundary for one racer and just before it for the other.
      const atExpiry: DomainContext = { ...ctx, now: () => new Date(r.expiresAt) };
      const justBefore: DomainContext = { ...ctx, now: () => new Date(new Date(r.expiresAt).getTime() - 1) };
      const [claim] = await Promise.allSettled([claimReport(justBefore, B, r.id, none), refreshReport(atExpiry, (await repo.getReport(r.id))!)]);
      const final = (await repo.getReport(r.id))!;
      if (claim.status === "fulfilled") {
        claimedWins++;
        expect(final.status).toBe("claimed");
        expect(new Date(final.expiresAt).getTime()).toBeGreaterThan(new Date(r.expiresAt).getTime()); // claim window extended validity
        expect((await repo.listClaims({ reportId: r.id })).filter((c) => c.active)).toHaveLength(1);
      } else {
        expiredWins++;
        expect(["report_expired", "report_not_available"]).toContain((claim as PromiseRejectedResult).reason.code);
        expect(final.status).toBe("expired");
        expect((await repo.listClaims({ reportId: r.id })).filter((c) => c.active)).toHaveLength(0);
      }
    }
    expect(claimedWins + expiredWins).toBe(40);
  }, 120_000);

  it("a claim strictly after expiry always fails", async () => {
    const { repo, ctx } = racingRepo(T0);
    const r = await createReport(ctx, A, { ...gps(OLAYA_SPOT, 8), departInMinutes: 0 });
    const late: DomainContext = { ...ctx, now: () => new Date(new Date(r.expiresAt).getTime() + 1) };
    await expect(claimReport(late, B, r.id, none)).rejects.toMatchObject({ code: "report_expired" });
    expect((await repo.getReport(r.id))!.status).toBe("expired");
  });
});

describe("Scenario F — RAKNA HOME: drivers race for the same single bay (buffered capacity)", () => {
  const E = "00000000-0000-4000-a000-000000000103"; // seeded driver (Reem)
  const slot = { spaceId: HOME_SPACES.condo, startAt: "2026-11-17T08:00:00.000Z", endAt: "2026-11-17T10:00:00.000Z" };

  it("exactly one booking wins and exactly one access credential exists (repeated 25×)", async () => {
    for (let run = 0; run < 25; run++) {
      const { repo, ctx } = racingRepo(T0);
      const results = await Promise.allSettled([A, C, D, E].map((u) => createHomeBooking(ctx, u, slot)));
      const ok = results.filter((x) => x.status === "fulfilled") as PromiseFulfilledResult<{ id: string }>[];
      expect(ok).toHaveLength(1);
      for (const f of results.filter((x) => x.status === "rejected")) expect(["capacity_full", "buffer_conflict"]).toContain((f as PromiseRejectedResult).reason.code);
      const live = (await repo.listBookings({ spaceId: HOME_SPACES.condo })).filter((b) => b.status === "confirmed");
      expect(live).toHaveLength(1);
      expect(await repo.getCredential(ok[0].value.id)).not.toBeNull();
    }
  }, 120_000);

  it("adjacent windows inside the 15-minute buffer never both succeed", async () => {
    for (let run = 0; run < 25; run++) {
      const { repo, ctx } = racingRepo(T0);
      const second = { ...slot, startAt: "2026-11-17T10:05:00.000Z", endAt: "2026-11-17T11:00:00.000Z" };
      const results = await Promise.allSettled([createHomeBooking(ctx, A, slot), createHomeBooking(ctx, C, second)]);
      expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
      expect((await repo.listBookings({ spaceId: HOME_SPACES.condo })).filter((b) => b.status === "confirmed")).toHaveLength(1);
    }
  }, 120_000);

  it("Keys spent on a losing booking are refunded (balance unchanged for losers)", async () => {
    const { repo, ctx } = racingRepo(T0);
    const reward = "00000000-0000-4000-9000-000000000001"; // 20% parking discount, 15 keys
    await awardPoints(ctx, { userId: C, amount: 20, type: "mission_reward", reason: "test", idempotencyKey: "f:c" });
    const before = { a: await getBalance(ctx, A), c: await getBalance(ctx, C) };
    const results = await Promise.allSettled([createHomeBooking(ctx, A, { ...slot, rewardId: reward }), createHomeBooking(ctx, C, { ...slot, rewardId: reward })]);
    const winner = results[0].status === "fulfilled" ? "a" : "c";
    const after = { a: await getBalance(ctx, A), c: await getBalance(ctx, C) };
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(after[winner]).toBe(before[winner] - 15);
    expect(after[winner === "a" ? "c" : "a"]).toBe(before[winner === "a" ? "c" : "a"]);
    expect((await repo.listBookings({ spaceId: HOME_SPACES.condo })).filter((b) => b.status === "confirmed")).toHaveLength(1);
  }, 60_000);
});
