import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * PSP webhook signature: header `x-rakna-signature: t=<unix seconds>,v1=<hex HMAC-SHA256>`,
 * where the HMAC (key = RAKNA_PSP_WEBHOOK_SECRET) covers `${t}.${rawBody}`. Requests older
 * than the tolerance are rejected (replay protection); comparison is constant-time.
 * Most Saudi PSPs (Moyasar, HyperPay, Tap…) sign similarly — adapt the header parser
 * to the chosen provider before going live.
 */
export const WEBHOOK_TOLERANCE_S = 300;

export function signWebhook(secret: string, rawBody: string, t: number): string {
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex")}`;
}

export function verifyWebhookSignature(secret: string, rawBody: string, header: string | null, nowS = Math.floor(Date.now() / 1000)): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map((kv) => kv.trim().split("=", 2) as [string, string]));
  const t = Number(parts.t);
  const sig = parts.v1;
  if (!Number.isInteger(t) || !sig || !/^[0-9a-f]{64}$/i.test(sig)) return false;
  if (Math.abs(nowS - t) > WEBHOOK_TOLERANCE_S) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest();
  const given = Buffer.from(sig, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}
