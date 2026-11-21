import type { NextConfig } from "next";

const dev = process.env.NODE_ENV !== "production";
const origin = (u?: string) => {
  try {
    return u ? new URL(u).origin : "";
  } catch {
    return "";
  }
};
const supabase = origin(process.env.NEXT_PUBLIC_SUPABASE_URL);
const mapStyle = origin(process.env.NEXT_PUBLIC_MAP_STYLE_URL);
const TILES = "https://tile.openstreetmap.org";

/**
 * Content-Security-Policy (audit F-SEC-5). 'unsafe-inline' for scripts is required by
 * Next.js App Router without nonces; everything else is restricted to this origin plus the
 * map tile host and the configured Supabase project.
 */
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob: ${TILES} ${mapStyle}`.trim(),
  "font-src 'self' data:",
  `connect-src 'self' ${TILES} ${supabase} ${supabase.replace(/^https/, "wss")} ${mapStyle}${dev ? " ws: wss:" : ""}`.replace(/\s+/g, " ").trim(),
  "worker-src 'self' blob:",
  "child-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Geolocation is allowed for this origin only; it is requested only on explicit user action.
  { key: "Permissions-Policy", value: "geolocation=(self), camera=(), microphone=()" },
  ...(dev ? [] : [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" }]),
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
