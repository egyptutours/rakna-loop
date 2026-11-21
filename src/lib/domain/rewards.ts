import type { RewardItem, RewardRedemption } from "../types";
import { DomainError } from "./errors";
import { iso, newId, type DomainContext } from "./context";
import { refundPoints, spendPoints } from "./ledger";

/**
 * Reward redemptions. In the MVP every redemption is SIMULATED: no partner
 * fulfils it and no money changes hands. Codes are prefixed DEMO-.
 */

function demoCode(): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let s = "";
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(6));
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return `DEMO-${s}`;
}

export async function redeemReward(ctx: DomainContext, userId: string, rewardId: string): Promise<RewardRedemption> {
  const profile = await ctx.repo.getProfile(userId);
  if (!profile) throw new DomainError("unauthenticated");
  if (profile.role !== "driver") throw new DomainError("reward_ineligible", "Only driver accounts can redeem rewards");
  if (profile.deletionRequestedAt) throw new DomainError("forbidden", "Account deletion pending");

  return ctx.repo.withLock(`reward:${rewardId}`, async () => {
    const reward = await ctx.repo.getReward(rewardId);
    if (!reward || !reward.active) throw new DomainError("reward_unavailable");
    if (reward.category === "parking_discount") {
      throw new DomainError("reward_ineligible", "Parking discounts are applied when you book an eligible private space");
    }
    if (reward.stock !== null && reward.stock <= 0) throw new DomainError("reward_unavailable", "Out of stock");

    const id = newId();
    // Reserve stock atomically first (no overselling across instances), then spend Keys;
    // if the spend fails, release the reserved unit again.
    if (!(await ctx.repo.adjustRewardStock(rewardId, -1))) throw new DomainError("reward_unavailable", "Out of stock");
    try {
      await spendPoints(ctx, {
        userId,
        amount: reward.keysRequired,
        type: "redemption",
        reason: `Redeemed: ${reward.title} (simulated)`,
        idempotencyKey: `redeem:${id}`,
        refType: "reward_redemption",
        refId: id,
      });
    } catch (e) {
      await ctx.repo.adjustRewardStock(rewardId, +1);
      throw e;
    }
    return ctx.repo.insertRedemption({
      id,
      userId,
      rewardId,
      keysSpent: reward.keysRequired,
      status: "pending_approval",
      code: null,
      simulated: true,
      createdAt: iso(ctx.now()),
      decidedAt: null,
      decidedBy: null,
      bookingId: null,
    });
  });
}

export async function decideRedemption(ctx: DomainContext, adminId: string, redemptionId: string, approve: boolean): Promise<RewardRedemption> {
  return ctx.repo.withLock(`redemption:${redemptionId}`, async () => {
    const r = await ctx.repo.getRedemption(redemptionId);
    if (!r) throw new DomainError("not_found");
    if (r.status !== "pending_approval") throw new DomainError("conflict", "Redemption already decided");
    const now = iso(ctx.now());
    if (!approve) {
      await refundPoints(ctx, {
        userId: r.userId,
        amount: r.keysSpent,
        reason: "Refund: redemption was not approved",
        idempotencyKey: `refund:${r.id}`,
        refType: "reward_redemption",
        refId: r.id,
      });
      await ctx.repo.adjustRewardStock(r.rewardId, +1);
    }
    const updated = await ctx.repo.updateRedemption(r.id, {
      status: approve ? "approved" : "rejected",
      code: approve ? demoCode() : null,
      decidedAt: now,
      decidedBy: adminId,
    });
    await ctx.repo.insertAudit({
      id: newId(),
      actorId: adminId,
      action: approve ? "redemption.approve" : "redemption.reject",
      target: `reward_redemption:${r.id}`,
      details: `${r.keysSpent} keys`,
      createdAt: now,
    });
    return updated;
  });
}

export function isRewardEligibleForSpace(reward: RewardItem, space: { partnerId: string; rewardEligible: boolean }): boolean {
  return (
    reward.active &&
    reward.category === "parking_discount" &&
    space.rewardEligible &&
    (reward.partnerId === null || reward.partnerId === space.partnerId) &&
    reward.discountPercent !== null &&
    reward.discountPercent > 0 &&
    reward.discountPercent <= 100
  );
}
