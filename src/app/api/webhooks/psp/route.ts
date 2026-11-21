import { headers } from "next/headers";
import { route } from "@/lib/api/handler";
import { ConfigurationError } from "@/lib/config";
import { getContext } from "@/lib/data";
import { DomainError } from "@/lib/domain/errors";
import { applyPaymentEvent } from "@/lib/domain/home";
import { rateLimit } from "@/lib/security/rate-limit";
import { pspWebhookSchema } from "@/lib/security/schemas";
import { verifyWebhookSignature } from "@/lib/security/webhook";

export const dynamic = "force-dynamic";

/**
 * Payment service provider → RAKNA. Server-to-server only: authenticated by an HMAC
 * signature over the raw body (no user session). Idempotent: replays of the same event
 * are no-ops; illegal transitions (e.g. failed → paid) are rejected with 409.
 * Access credentials unlock only once a booking is `paid` (or `simulated` in demo mode).
 */
export const POST = route(async (req: Request) => {
  const secret = process.env.RAKNA_PSP_WEBHOOK_SECRET;
  if (!secret) throw new ConfigurationError("RAKNA_PSP_WEBHOOK_SECRET is not set");
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  await rateLimit("webhook", `ip:${ip}`);
  const raw = await req.text();
  if (raw.length > 16_384) throw new DomainError("validation", "Payload too large");
  if (!verifyWebhookSignature(secret, raw, h.get("x-rakna-signature"))) throw new DomainError("unauthenticated", "Invalid webhook signature");
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new DomainError("validation", "Body must be JSON");
  }
  const event = pspWebhookSchema.parse(json);
  const ctx = getContext();
  const { booking, changed } = await applyPaymentEvent(ctx, { bookingId: event.bookingId, status: event.status, pspReference: event.pspReference });
  if (changed) {
    await ctx.repo.insertAudit({ id: crypto.randomUUID(), actorId: booking.userId, action: `payment.${event.status}`, target: `parking_booking:${booking.id}`, details: `psp event ${event.eventId}`, createdAt: ctx.now().toISOString() });
  }
  return { received: true, changed, paymentStatus: booking.paymentStatus };
});
