import type { RewardRules } from "./types";

/**
 * Runtime configuration. Server-only values are read lazily so they never get
 * inlined into client bundles. Nothing here is a secret except where noted.
 */
export type DataMode = "demo" | "supabase";

export class ConfigurationError extends Error {}

/**
 * Data mode.
 *  • Development/test: defaults to "demo" so the app runs with no credentials.
 *  • Production (NODE_ENV=production): RAKNA_DATA_MODE MUST be set explicitly, and a
 *    Supabase deployment with missing variables FAILS instead of silently falling back
 *    to demo mode — demo mode has an account switcher (anyone could act as the demo
 *    administrator), so it must never be enabled by accident (audit F-SEC-2).
 */
export function getDataMode(): DataMode {
  const mode = process.env.RAKNA_DATA_MODE;
  const production = process.env.NODE_ENV === "production";
  const supabaseReady = Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY && process.env.SUPABASE_SERVICE_ROLE_KEY);
  if (mode === "supabase") {
    if (supabaseReady) return "supabase";
    if (production) throw new ConfigurationError("RAKNA_DATA_MODE=supabase but Supabase environment variables are missing");
    console.warn("[rakna] RAKNA_DATA_MODE=supabase but Supabase env vars are missing — using demo mode (development only).");
    return "demo";
  }
  if (mode === "demo") return "demo";
  if (production) throw new ConfigurationError("RAKNA_DATA_MODE must be set explicitly in production (\"supabase\", or \"demo\" for a public demo)");
  return "demo";
}

export function isDemoMode(): boolean {
  return getDataMode() === "demo";
}

export function aiConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

export function aiModel(): string {
  return process.env.ANTHROPIC_MODEL || "claude-opus-5-5";
}

/** Demonstration defaults. Administrators can edit these at runtime (Admin → Reward rules). */
export const DEFAULT_RULES: RewardRules = {
  departureReward: 8,
  confirmationReward: 2,
  streakEvery: 3,
  streakBonus: 5,
  missionReward: 10,
  dailyEarnLimit: 40,
  dailyReportLimit: 8,
  reportTtlMinutes: 20,
  claimTtlMinutes: 15,
  maxConfirmDistanceM: 120,
  maxReportAccuracyM: 100,
  minClaimToConfirmSeconds: 20,
  locationRetentionHours: 24,
};

/**
 * Phase 3 commercial settings. Rates are basis points (1 bp = 0.01%). These are product
 * defaults that REQUIRE Saudi tax (ZATCA) and legal review before any real payment flows.
 */
export const HOME_FEES = {
  driverFeeBps: 500, // 5% of base fare, paid by the driver
  hostCommissionBps: 1500, // 15% of base fare, withheld from the host
  vatBps: 1500, // 15% VAT, on the platform fee only
  keysMaxDiscountOfPlatformFeeBps: 2000, // Keys may discount ≤ 20% of the platform fee
  multiDayThresholdDays: 5,
  overstayMultiplierBps: 15000, // 1.5×
  overstayGraceMinutes: 10,
  arrivalGeofenceM: 50,
  accessRevealBeforeMinutes: 30,
  credentialValidBeforeMinutes: 10,
  credentialValidAfterMinutes: 15,
  extendMinutes: 60,
} as const;

export interface PlatformSettings {
  /** Municipal sandbox switch: villa spaces are waitlist-only until an admin enables bookings. */
  villaBookingsEnabled: boolean;
}

export const DEFAULT_PLATFORM_SETTINGS: PlatformSettings = { villaBookingsEnabled: false };

/** ILLUSTRATIVE Riyadh Metro station anchors for PARK & CONNECT demo data (approximate, not official). */
export const DEMO_METRO_STATIONS: { code: string; name: string; nameAr: string; location: { lat: number; lng: number } }[] = [
  { code: "OLY", name: "Olaya station (illustrative)", nameAr: "محطة العليا (توضيحية)", location: { lat: 24.6925, lng: 46.6855 } },
  { code: "KAFD", name: "KAFD station (illustrative)", nameAr: "محطة المركز المالي (توضيحية)", location: { lat: 24.7672, lng: 46.6436 } },
  { code: "SLM", name: "Sulaimaniyah station (illustrative)", nameAr: "محطة السليمانية (توضيحية)", location: { lat: 24.7035, lng: 46.7008 } },
];

/** Riyadh map defaults. */
export const RIYADH_CENTER = { lat: 24.7136, lng: 46.6753 };

export interface Neighborhood {
  id: string;
  name: string;
  nameAr: string;
  center: { lat: number; lng: number };
}

export const NEIGHBORHOODS: Neighborhood[] = [
  { id: "olaya", name: "Al Olaya", nameAr: "العليا", center: { lat: 24.6955, lng: 46.6855 } },
  { id: "wurud", name: "Al Wurud", nameAr: "الورود", center: { lat: 24.7255, lng: 46.6662 } },
  { id: "malqa", name: "Al Malqa", nameAr: "الملقا", center: { lat: 24.8105, lng: 46.6108 } },
  { id: "kfr", name: "King Fahd Road", nameAr: "طريق الملك فهد", center: { lat: 24.7362, lng: 46.6545 } },
];
