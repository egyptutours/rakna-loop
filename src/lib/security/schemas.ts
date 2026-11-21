import { z } from "zod";

/** Request validation for every mutating API route. Unknown keys are rejected. */

const latLng = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).strict();

export const evidenceSchema = z
  .object({
    location: latLng.nullable(),
    accuracyM: z.number().min(0).max(5000).nullable(),
    evidence: z.enum(["gps", "simulated", "none"]),
  })
  .strict();

export const createReportSchema = evidenceSchema.extend({
  departInMinutes: z.union([z.literal(0), z.literal(2), z.literal(5), z.literal(10)]),
  note: z.string().max(140).nullable().optional(),
}).strict();

export const confirmSchema = evidenceSchema.extend({ outcome: z.enum(["found", "not_found"]) }).strict();

export const redeemSchema = z.object({ rewardId: z.guid() }).strict();

export const bookingSchema = z
  .object({
    spaceId: z.guid(),
    startAt: z.string().datetime(),
    hours: z.number().int().min(1).max(12),
    rewardId: z.guid().nullable().optional(),
  })
  .strict();

const schedule = z.object({ days: z.array(z.number().int().min(0).max(6)).min(1).max(7), openHour: z.number().int().min(0).max(23), closeHour: z.number().int().min(1).max(24) }).strict();

export const spaceSchema = z
  .object({
    title: z.string().min(3).max(120),
    titleAr: z.string().max(120).default(""),
    location: latLng,
    address: z.string().min(3).max(200),
    addressAr: z.string().max(200).default(""),
    capacity: z.number().int().min(1).max(2000),
    pricePerHour: z.number().min(0).max(500),
    schedule,
    conditions: z.string().max(500).default(""),
    conditionsAr: z.string().max(500).default(""),
    rewardEligible: z.boolean(),
  })
  .strict();

export const partnerSchema = z
  .object({
    name: z.string().min(2).max(120),
    nameAr: z.string().max(120).default(""),
    kind: z.enum(["hotel", "office", "mall", "operator", "residential"]),
    contactEmail: z.string().email().max(200),
    crNumberProvided: z.boolean(),
  })
  .strict();

export const missionSchema = z.object({ kind: z.enum(["park_and_metro", "walk_connection", "carpool"]), description: z.string().min(5).max(280) }).strict();

export const assistantSchema = z.object({ query: z.string().min(3).max(1000), viewer: latLng.nullable().optional() }).strict();

export const rulesSchema = z
  .object({
    departureReward: z.number().int(),
    confirmationReward: z.number().int(),
    streakEvery: z.number().int(),
    streakBonus: z.number().int(),
    missionReward: z.number().int(),
    dailyEarnLimit: z.number().int(),
    dailyReportLimit: z.number().int(),
    reportTtlMinutes: z.number().int(),
    claimTtlMinutes: z.number().int(),
    maxConfirmDistanceM: z.number().int(),
    maxReportAccuracyM: z.number().int(),
    minClaimToConfirmSeconds: z.number().int(),
    locationRetentionHours: z.number().int(),
  })
  .partial()
  .strict();

export const adminActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("partner"), id: z.guid(), status: z.enum(["approved", "rejected", "suspended", "pending"]) }).strict(),
  z.object({ action: z.literal("space"), id: z.guid(), approval: z.enum(["approved", "rejected", "paused", "pending_review"]) }).strict(),
  z.object({ action: z.literal("redemption"), id: z.guid(), approve: z.boolean() }).strict(),
  z.object({ action: z.literal("mission"), id: z.guid(), approve: z.boolean() }).strict(),
  z.object({ action: z.literal("flag"), id: z.guid(), decision: z.enum(["dismiss", "reverse"]), amount: z.number().int().min(1).max(1000).optional() }).strict(),
  z.object({ action: z.literal("report"), id: z.guid(), approve: z.boolean() }).strict(),
  z.object({ action: z.literal("reward_toggle"), id: z.guid(), active: z.boolean(), keysRequired: z.number().int().min(1).max(10000).optional() }).strict(),
  z.object({ action: z.literal("purge_locations") }).strict(),
  z.object({ action: z.literal("hive_lifecycle") }).strict(),
  z.object({ action: z.literal("process_deletion"), id: z.guid() }).strict(),
  z.object({ action: z.literal("hive_config"), config: z.record(z.string(), z.unknown()) }).strict(),
  z.object({ action: z.literal("villa_bookings"), enabled: z.boolean() }).strict(),
]);

// ─── Phase 3: RAKNA HOME / PARTNERS / PARK & CONNECT ─────────────────────
const halalas = z.number().int().min(1).max(100_000);
export const availabilityRuleSchema = z
  .object({
    weekdayMask: z.number().int().min(1).max(127),
    startMinute: z.number().int().min(0).max(1439),
    endMinute: z.number().int().min(1).max(1440),
    hourlyRateHalalas: halalas,
    dailyCapHalalas: z.number().int().min(1).max(1_000_000).nullable(),
    multiDayDiscountBps: z.number().int().min(0).max(5000).default(0),
  })
  .strict()
  .refine((r) => r.endMinute > r.startMinute, { message: "endMinute must be after startMinute", path: ["endMinute"] });

export const scheduleRulesSchema = z.object({ rules: z.array(availabilityRuleSchema).min(1).max(14) }).strict();

export const exceptionSchema = z
  .object({
    exceptionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    isBlocked: z.boolean(),
    overrideStartMinute: z.number().int().min(0).max(1439).nullable().optional(),
    overrideEndMinute: z.number().int().min(1).max(1440).nullable().optional(),
  })
  .strict();

const dims = z.number().int().min(100).max(1500).nullable().optional();
export const homeListingSchema = z
  .object({
    spaceCategory: z.enum(["villa_shaded", "villa_open", "villa_garage", "condo_deeded", "condo_association"]),
    entitlementType: z.enum(["deed_owner", "owner_wakalah", "ejar_authorized", "owners_association"]),
    landlordConsentConfirmed: z.boolean().optional(),
    noSubletClauseConfirmed: z.boolean().optional(),
    title: z.string().min(3).max(120),
    titleAr: z.string().max(120).default(""),
    location: latLng,
    address: z.string().min(3).max(200),
    addressAr: z.string().max(200).default(""),
    shadeTier: z.enum(["underground", "enclosed", "full_carport", "partial_shade", "uncovered"]),
    maxHeightCm: dims,
    maxWidthCm: dims,
    maxLengthCm: dims,
    bufferMinutes: z.number().int().min(0).max(120),
    instantBook: z.boolean(),
    accessMode: z.enum(["unobstructed", "ephemeral_pin", "dynamic_qr", "guard_pass", "host_remote"]),
    metroStationCode: z.string().regex(/^[A-Z0-9]{2,8}$/).nullable().optional(),
    conditions: z.string().max(500).default(""),
    conditionsAr: z.string().max(500).default(""),
    rules: z.array(availabilityRuleSchema).min(1).max(14),
  })
  .strict();

export const homeBookingSchema = z
  .object({ spaceId: z.guid(), startAt: z.string().datetime(), endAt: z.string().datetime(), rewardId: z.guid().nullable().optional() })
  .strict();

export const bookingEventSchema = z
  .object({
    eventType: z.enum(["arrived", "extended", "departed", "bay_blocked_reported"]),
    location: latLng.nullable().optional(),
    evidenceNote: z.string().max(500).nullable().optional(),
    simulateAtSpace: z.boolean().optional(),
  })
  .strict();

/** Signed PSP webhook payload (see /api/webhooks/psp for the signature scheme). */
export const pspWebhookSchema = z
  .object({
    eventId: z.string().min(1).max(200),
    bookingId: z.guid(),
    status: z.enum(["paid", "failed", "refunded"]),
    pspReference: z.string().min(1).max(200),
  })
  .strict();

export const pageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(200).nullable().optional(),
});

export const profileSchema = z
  .object({
    lang: z.enum(["ar", "en"]).optional(),
    locationConsent: z.boolean().optional(),
    requestDeletion: z.boolean().optional(),
  })
  .strict();
