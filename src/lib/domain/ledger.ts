import type { LedgerEntry, LedgerType } from "../types";
import { DomainError } from "./errors";
import { iso, newId, riyadhDayStart, type DomainContext } from "./context";

/**
 * RAKNA KEYS ledger. The balance is ALWAYS derived from the append-only ledger;
 * there is no editable balance column anywhere. Only server-side domain code
 * calls these functions — there is no API route that lets a client create an entry.
 */

export function balanceOf(entries: LedgerEntry[]): number {
  return entries.reduce((sum, e) => sum + e.amount, 0);
}

export async function getBalance(ctx: DomainContext, userId: string): Promise<number> {
  return balanceOf(await ctx.repo.listLedger({ userId }));
}

const EARNING_TYPES: LedgerType[] = ["departure_reward", "confirmation_reward", "streak_bonus", "mission_reward"];

export async function earnedToday(ctx: DomainContext, userId: string): Promise<number> {
  const since = iso(riyadhDayStart(ctx.now()));
  const entries = await ctx.repo.listLedger({ userId, sinceIso: since });
  return entries.filter((e) => EARNING_TYPES.includes(e.type)).reduce((s, e) => s + e.amount, 0);
}

export interface AwardInput {
  userId: string;
  amount: number;
  type: Extract<LedgerType, "departure_reward" | "confirmation_reward" | "streak_bonus" | "mission_reward">;
  reason: string;
  idempotencyKey: string;
  refType?: string;
  refId?: string;
}

export interface AwardResult {
  awarded: number;
  duplicate: boolean;
  capped: boolean;
  entry: LedgerEntry | null;
}

/** Award Keys after server-side verification. Idempotent and subject to the daily earning limit. */
export async function awardPoints(ctx: DomainContext, input: AwardInput): Promise<AwardResult> {
  if (!Number.isInteger(input.amount) || input.amount <= 0) {
    throw new DomainError("validation", "Award amount must be a positive integer");
  }
  return ctx.repo.withLock(`ledger:${input.userId}`, async () => {
    const existing = await ctx.repo.findLedgerByKey(input.idempotencyKey);
    if (existing) return { awarded: 0, duplicate: true, capped: false, entry: existing };

    const rules = await ctx.repo.getRules();
    const entry: LedgerEntry = {
      id: newId(),
      userId: input.userId,
      amount: input.amount,
      type: input.type,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
      refType: input.refType ?? null,
      refId: input.refId ?? null,
      createdAt: iso(ctx.now()),
    };
    // The daily cap is applied by the storage layer INSIDE its per-user lock (SQL advisory
    // lock in Supabase), so concurrent awards on other server instances cannot exceed it.
    const res = await ctx.repo.insertLedger(entry, { limit: rules.dailyEarnLimit, sinceIso: iso(riyadhDayStart(ctx.now())) });
    if (!res.entry) return { awarded: 0, duplicate: false, capped: true, entry: null };
    if (!res.inserted) return { awarded: 0, duplicate: true, capped: false, entry: res.entry };
    return { awarded: res.entry.amount, duplicate: false, capped: res.entry.amount < input.amount, entry: res.entry };
  });
}

export interface SpendInput {
  userId: string;
  amount: number;
  type: Extract<LedgerType, "redemption" | "booking_discount">;
  reason: string;
  idempotencyKey: string;
  refType?: string;
  refId?: string;
}

/** Spend Keys. Never allows a negative balance. */
export async function spendPoints(ctx: DomainContext, input: SpendInput): Promise<LedgerEntry> {
  if (!Number.isInteger(input.amount) || input.amount <= 0) {
    throw new DomainError("validation", "Spend amount must be a positive integer");
  }
  return ctx.repo.withLock(`ledger:${input.userId}`, async () => {
    const existing = await ctx.repo.findLedgerByKey(input.idempotencyKey);
    if (existing) return existing;
    const balance = await getBalance(ctx, input.userId);
    if (balance < input.amount) {
      throw new DomainError("insufficient_balance", "Not enough RAKNA KEYS", { balance, required: input.amount });
    }
    const entry: LedgerEntry = {
      id: newId(),
      userId: input.userId,
      amount: -input.amount,
      type: input.type,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
      refType: input.refType ?? null,
      refId: input.refId ?? null,
      createdAt: iso(ctx.now()),
    };
    // Storage re-checks the balance atomically (insert_ledger_entry raises on negative).
    return (await ctx.repo.insertLedger(entry)).entry!;
  });
}

/** Refund a previous spend (e.g. a rejected redemption). Idempotent. */
export async function refundPoints(
  ctx: DomainContext,
  input: { userId: string; amount: number; reason: string; idempotencyKey: string; refType?: string; refId?: string },
): Promise<LedgerEntry | null> {
  if (input.amount <= 0) return null;
  return ctx.repo.withLock(`ledger:${input.userId}`, async () => {
    const entry: LedgerEntry = {
      id: newId(),
      userId: input.userId,
      amount: input.amount,
      type: "redemption_refund",
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
      refType: input.refType ?? null,
      refId: input.refId ?? null,
      createdAt: iso(ctx.now()),
    };
    return (await ctx.repo.insertLedger(entry)).entry;
  });
}

/**
 * Admin reversal of fraudulently earned Keys. Capped at the current balance so a
 * balance can never go negative; the shortfall is reported back for the audit log.
 */
export async function reversePoints(
  ctx: DomainContext,
  input: { userId: string; amount: number; reason: string; idempotencyKey: string; refId?: string },
): Promise<{ reversed: number; shortfall: number }> {
  return ctx.repo.withLock(`ledger:${input.userId}`, async () => {
    const existing = await ctx.repo.findLedgerByKey(input.idempotencyKey);
    if (existing) return { reversed: -existing.amount, shortfall: 0 };
    const balance = await getBalance(ctx, input.userId);
    const reversed = Math.min(balance, input.amount);
    if (reversed > 0) {
      await ctx.repo.insertLedger({
        id: newId(),
        userId: input.userId,
        amount: -reversed,
        type: "admin_reversal",
        reason: input.reason,
        idempotencyKey: input.idempotencyKey,
        refType: "fraud_review",
        refId: input.refId ?? null,
        createdAt: iso(ctx.now()),
      });
    }
    return { reversed, shortfall: input.amount - reversed };
  });
}

export interface WalletSummary {
  balance: number;
  earned: number;
  redeemed: number;
  earnedToday: number;
  dailyLimit: number;
  entries: LedgerEntry[];
}

export async function walletSummary(ctx: DomainContext, userId: string): Promise<WalletSummary> {
  const entries = (await ctx.repo.listLedger({ userId })).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const rules = await ctx.repo.getRules();
  const earned = entries.filter((e) => EARNING_TYPES.includes(e.type)).reduce((s, e) => s + e.amount, 0);
  const redeemed = -entries.filter((e) => e.amount < 0).reduce((s, e) => s + e.amount, 0)
    - entries.filter((e) => e.type === "redemption_refund").reduce((s, e) => s + e.amount, 0);
  return {
    balance: balanceOf(entries),
    earned,
    redeemed: Math.max(0, redeemed),
    earnedToday: await earnedToday(ctx, userId),
    dailyLimit: rules.dailyEarnLimit,
    entries,
  };
}
