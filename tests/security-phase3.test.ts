import { describe, expect, it } from "vitest";
import { clearJwksCache, JwtError, verifyJwt, verifyJwtWithKeys } from "@/lib/auth/jwt";
import { stripPii } from "@/lib/security/pii";
import { rateLimit, resetRateLimits } from "@/lib/security/rate-limit";
import { signWebhook, verifyWebhookSignature } from "@/lib/security/webhook";
import type { Repo } from "@/lib/data/repo";

/** Phase 3 production hardening: local JWKS verification, PII stripping, PSP signatures, shared limiter. */

const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

async function es256() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "k1", alg: "ES256" };
  const sign = async (claims: Record<string, unknown>, header: Record<string, unknown> = { alg: "ES256", kid: "k1", typ: "JWT" }) => {
    const input = `${enc(header)}.${enc(claims)}`;
    const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, new TextEncoder().encode(input));
    return `${input}.${Buffer.from(sig).toString("base64url")}`;
  };
  return { jwk, sign };
}

const now = Math.floor(Date.now() / 1000);
const base = { sub: "00000000-0000-4000-a000-00000000000a", exp: now + 600, iss: "https://x.supabase.co/auth/v1", aud: "authenticated", role: "authenticated" };
const opts = { issuer: base.iss, audience: "authenticated" };

describe("local JWKS JWT verification (SUPABASE_JWKS_URL)", () => {
  it("accepts a valid ES256 token and returns its claims", async () => {
    const { jwk, sign } = await es256();
    const claims = await verifyJwtWithKeys(await sign(base), [jwk], opts);
    expect(claims.sub).toBe(base.sub);
  });

  it("rejects tampering, expiry, wrong audience/issuer, unknown kid and alg=none/HS256", async () => {
    const { jwk, sign } = await es256();
    const good = await sign(base);
    const [h, , s] = good.split(".");
    const tampered = `${h}.${enc({ ...base, sub: "00000000-0000-4000-a000-0000000000ad" })}.${s}`;
    const fail = (t: string, o = opts) => verifyJwtWithKeys(t, [jwk], o).then(() => "ok", (e) => (e instanceof JwtError ? e.message : `other:${e}`));
    expect(await fail(tampered)).toBe("bad signature");
    expect(await fail(await sign({ ...base, exp: now - 3600 }))).toBe("expired");
    expect(await fail(await sign({ ...base, aud: "anon" }))).toBe("wrong audience");
    expect(await fail(await sign({ ...base, iss: "https://evil.example/auth/v1" }))).toBe("wrong issuer");
    expect(await fail(await sign(base, { alg: "ES256", kid: "other" }))).toBe("unknown signing key");
    expect(await fail(`${enc({ alg: "none" })}.${enc(base)}.`)).toMatch(/unsupported alg/);
    expect(await fail(`${enc({ alg: "HS256" })}.${enc(base)}.c2ln`)).toMatch(/unsupported alg/);
    expect(await fail("not-a-jwt")).toBe("malformed token");
  });

  it("fetches and caches the JWKS, refreshing once on key rotation", async () => {
    clearJwksCache();
    const first = await es256();
    const second = await es256();
    let calls = 0;
    let keys = [first.jwk];
    const fetcher = (async () => {
      calls++;
      return new Response(JSON.stringify({ keys }), { status: 200 });
    }) as unknown as typeof fetch;
    await verifyJwt(await first.sign(base), "https://x/jwks", { ...opts, fetcher });
    await verifyJwt(await first.sign(base), "https://x/jwks", { ...opts, fetcher });
    expect(calls).toBe(1);
    keys = [{ ...second.jwk, kid: "k2" }];
    await verifyJwt(await second.sign(base, { alg: "ES256", kid: "k2" }), "https://x/jwks", { ...opts, fetcher });
    expect(calls).toBe(2);
  });
});

describe("PII stripping before external AI parsing", () => {
  it("removes emails, Saudi phones, national IDs/Iqama, IBANs, cards and plates", () => {
    const { text, redactions } = stripPii(
      "I'm sara@example.com, call 0551234567 or +966 55 123 4567. ID 1098765432, IBAN SA03 8000 0000 6080 1016 7519, card 4111 1111 1111 1111, plate ABC 1234 and أ ب ج 1234",
    );
    expect(text).not.toMatch(/sara@|0551234567|123 4567|1098765432|SA03|4111|ABC 1234|أ ب ج 1234/);
    expect(redactions).toBeGreaterThanOrEqual(8);
  });

  it("normalises Arabic-Indic digits before matching", () => {
    expect(stripPii("جوالي ٠٥٥١٢٣٤٥٦٧").text).toContain("[phone]");
  });

  it("keeps what the parser needs: places, times, durations and budgets", () => {
    const q = "Parking near Al Olaya at 18:30 tomorrow for 3 hours, budget SAR 50, walk 800 m";
    expect(stripPii(q)).toEqual({ text: q, redactions: 0 });
    const ar = "موقف قرب العليا الساعة 5 لمدة ساعتين بميزانية 40 ريال";
    expect(stripPii(ar).redactions).toBe(0);
  });
});

describe("PSP webhook signatures", () => {
  const secret = "whsec_test_only";
  const body = JSON.stringify({ eventId: "evt_1", bookingId: "00000000-0000-4000-7000-000000000001", status: "paid", pspReference: "psp_1" });

  it("accepts a fresh, correct signature", () => {
    const t = 1_800_000_000;
    expect(verifyWebhookSignature(secret, body, signWebhook(secret, body, t), t + 5)).toBe(true);
  });

  it("rejects a modified body, a wrong secret, a stale timestamp (replay) and garbage headers", () => {
    const t = 1_800_000_000;
    const h = signWebhook(secret, body, t);
    expect(verifyWebhookSignature(secret, body.replace("paid", "refunded"), h, t)).toBe(false);
    expect(verifyWebhookSignature("other", body, h, t)).toBe(false);
    expect(verifyWebhookSignature(secret, body, h, t + 301)).toBe(false);
    expect(verifyWebhookSignature(secret, body, null, t)).toBe(false);
    expect(verifyWebhookSignature(secret, body, "t=abc,v1=zz", t)).toBe(false);
  });
});

describe("shared rate limiter", () => {
  function fakeSupabase(fail = false) {
    const counts = new Map<string, number>();
    const repo = {
      kind: "supabase" as const,
      async checkRateLimit(key: string, limit: number, windowSeconds: number, nowIso: string) {
        if (fail) throw new Error("db down");
        const w = Math.floor(Date.parse(nowIso) / 1000 / windowSeconds);
        const k = `${key}|${w}`;
        const n = (counts.get(k) ?? 0) + 1;
        counts.set(k, n);
        return n <= limit;
      },
    } as unknown as Repo;
    return { repo, counts };
  }

  it("uses the database counter in Supabase mode (shared by every instance)", async () => {
    const { repo, counts } = fakeSupabase();
    const t = Date.parse("2026-11-20T10:00:00Z");
    for (let i = 0; i < 10; i++) await rateLimit("booking", "u1", { repo, now: t });
    await expect(rateLimit("booking", "u1", { repo, now: t })).rejects.toMatchObject({ code: "rate_limited" });
    expect([...counts.keys()][0]).toMatch(/^booking:u1\|/);
    await expect(rateLimit("booking", "u1", { repo, now: t + 10 * 60_000 })).resolves.toBeUndefined(); // next window
  });

  it("falls back to the in-process limiter when the database is unavailable (never unlimited)", async () => {
    resetRateLimits();
    const { repo } = fakeSupabase(true);
    const t = Date.now();
    for (let i = 0; i < 10; i++) await rateLimit("booking", "u2", { repo, now: t });
    await expect(rateLimit("booking", "u2", { repo, now: t })).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("uses the in-process limiter in demo mode", async () => {
    resetRateLimits();
    const repo = { kind: "demo" } as unknown as Repo;
    for (let i = 0; i < 6; i++) await rateLimit("report", "u3", { repo });
    await expect(rateLimit("report", "u3", { repo })).rejects.toMatchObject({ code: "rate_limited" });
  });
});
