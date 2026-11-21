/**
 * Local verification of Supabase access tokens against the project's JWKS
 * (SUPABASE_JWKS_URL, e.g. https://<ref>.supabase.co/auth/v1/.well-known/jwks.json).
 *
 * Why: verifying locally removes one network round trip to GoTrue per API request.
 * Supported algorithms: ES256 and RS256 (Supabase asymmetric signing keys). HS256
 * (legacy shared secret) is deliberately NOT supported here — those projects keep the
 * remote auth.getUser() check.
 *
 * Pure WebCrypto (Node ≥ 20 / Edge), no dependency. Checks: signature, alg allow-list,
 * kid match, exp/nbf (60 s leeway), and — when given — issuer and audience.
 */

export interface JwtClaims {
  sub: string;
  exp: number;
  nbf?: number;
  iat?: number;
  iss?: string;
  aud?: string | string[];
  role?: string;
  [k: string]: unknown;
}

interface Jwk extends JsonWebKey {
  kid?: string;
  alg?: string;
}

const LEEWAY_S = 60;
const CACHE_MS = 10 * 60_000;
const cache = new Map<string, { at: number; keys: Jwk[] }>();

function b64urlBytes(s: string): Uint8Array<ArrayBuffer> {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlJson<T>(s: string): T {
  return JSON.parse(new TextDecoder().decode(b64urlBytes(s))) as T;
}

export class JwtError extends Error {}

async function loadKeys(url: string, fetcher: typeof fetch, force = false): Promise<Jwk[]> {
  const hit = cache.get(url);
  if (!force && hit && Date.now() - hit.at < CACHE_MS) return hit.keys;
  const res = await fetcher(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`JWKS fetch failed (${res.status})`); // infrastructure error, not a bad token
  const body = (await res.json()) as { keys?: Jwk[] };
  const keys = Array.isArray(body.keys) ? body.keys : [];
  cache.set(url, { at: Date.now(), keys });
  return keys;
}

export function clearJwksCache(): void {
  cache.clear();
}

/** Verify a compact JWS against a JWK set. Throws JwtError on any failure. */
export async function verifyJwtWithKeys(token: string, keys: Jwk[], opts: { issuer?: string; audience?: string; nowS?: number } = {}): Promise<JwtClaims> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new JwtError("malformed token");
  const [h, p, s] = parts;
  let header: { alg?: string; kid?: string; typ?: string };
  let claims: JwtClaims;
  try {
    header = b64urlJson(h);
    claims = b64urlJson(p);
  } catch {
    throw new JwtError("malformed token");
  }
  if (header.alg !== "ES256" && header.alg !== "RS256") throw new JwtError(`unsupported alg ${String(header.alg)}`);
  const jwk = keys.find((k) => (header.kid ? k.kid === header.kid : true) && (!k.alg || k.alg === header.alg));
  if (!jwk) throw new JwtError("unknown signing key");
  const algorithm = header.alg === "ES256" ? { name: "ECDSA", namedCurve: "P-256" } : { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
  const { kid: _kid, alg: _alg, ...keyData } = jwk;
  void _kid;
  void _alg;
  const key = await crypto.subtle.importKey("jwk", keyData, algorithm, false, ["verify"]);
  const verifyAlg = header.alg === "ES256" ? { name: "ECDSA", hash: "SHA-256" } : { name: "RSASSA-PKCS1-v1_5" };
  const ok = await crypto.subtle.verify(verifyAlg, key, b64urlBytes(s), new TextEncoder().encode(`${h}.${p}`));
  if (!ok) throw new JwtError("bad signature");
  const now = opts.nowS ?? Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== "number" || claims.exp + LEEWAY_S < now) throw new JwtError("expired");
  if (typeof claims.nbf === "number" && claims.nbf - LEEWAY_S > now) throw new JwtError("not yet valid");
  if (typeof claims.sub !== "string" || !claims.sub) throw new JwtError("missing subject");
  if (opts.issuer && claims.iss !== opts.issuer) throw new JwtError("wrong issuer");
  if (opts.audience) {
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(opts.audience)) throw new JwtError("wrong audience");
  }
  return claims;
}

/** Fetch (cached) JWKS and verify. A kid miss refreshes the cache once (key rotation). */
export async function verifyJwt(token: string, jwksUrl: string, opts: { issuer?: string; audience?: string; fetcher?: typeof fetch } = {}): Promise<JwtClaims> {
  const fetcher = opts.fetcher ?? fetch;
  try {
    return await verifyJwtWithKeys(token, await loadKeys(jwksUrl, fetcher), opts);
  } catch (e) {
    if (e instanceof JwtError && e.message === "unknown signing key") return verifyJwtWithKeys(token, await loadKeys(jwksUrl, fetcher, true), opts);
    throw e;
  }
}
