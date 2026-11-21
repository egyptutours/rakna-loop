import { cellCenter, hiveIndexFor } from "../hive/cells";
import { hourBucket } from "../hive/decay";
import { DEFAULT_HIVE_CONFIG } from "../hive/config";
import type {
  AvailabilityRule,
  HiveCellStat,
  HiveDemandBucket,
  DepartureReport,
  LedgerEntry,
  NeighborhoodChallenge,
  ParkingBooking,
  ParkingPartner,
  ParkingSpace,
  Profile,
  ReportConfirmation,
  RewardItem,
} from "../types";
import { DEFAULT_PLATFORM_SETTINGS, DEFAULT_RULES } from "../config";
import type { DemoState } from "./demo-repo";

/**
 * DEMO DATA — every record is simulated and marked isDemo = true.
 * Locations are illustrative points near Al Olaya, Al Wurud, Al Malqa and King Fahd
 * Road. They do NOT represent real, currently available parking.
 */

export const DEMO_USERS = {
  driverA: "00000000-0000-4000-a000-00000000000a",
  driverB: "00000000-0000-4000-a000-00000000000b",
  partner: "00000000-0000-4000-a000-0000000000c1",
  admin: "00000000-0000-4000-a000-0000000000ad",
} as const;

export const DEMO_PENDING_PARTNER = "00000000-0000-4000-a000-0000000000c2";

const PARTNER_ID = "00000000-0000-4000-b000-000000000001";
const PENDING_PARTNER_ID = "00000000-0000-4000-b000-000000000002";
const HOME_PARTNER_ID = "00000000-0000-4000-b000-000000000003";

/** Phase 3 demo spaces (RAKNA HOME condo bay, villa carport on the waitlist, KAFD Park & Connect). */
export const HOME_SPACES = {
  condo: "00000000-0000-4000-f000-000000000006",
  villa: "00000000-0000-4000-f000-000000000007",
  kafd: "00000000-0000-4000-f000-000000000008",
} as const;

function minutesFrom(now: Date, m: number) {
  return new Date(now.getTime() + m * 60_000).toISOString();
}

const allWeek = { days: [0, 1, 2, 3, 4, 5, 6], openHour: 6, closeHour: 24 };
const workWeek = { days: [0, 1, 2, 3, 4], openHour: 7, closeHour: 20 };

export function buildSeed(now: Date = new Date()): DemoState {
  const created = minutesFrom(now, -60 * 24 * 20);

  const profiles: Profile[] = [
    { id: DEMO_USERS.driverA, displayName: "Sara (Demo Driver A)", displayNameAr: "سارة (سائقة تجريبية أ)", role: "driver", neighborhood: "olaya", lang: "ar", locationConsentAt: null, deletionRequestedAt: null, createdAt: created, isDemo: true },
    { id: DEMO_USERS.driverB, displayName: "Faisal (Demo Driver B)", displayNameAr: "فيصل (سائق تجريبي ب)", role: "driver", neighborhood: "wurud", lang: "ar", locationConsentAt: null, deletionRequestedAt: null, createdAt: created, isDemo: true },
    { id: DEMO_USERS.partner, displayName: "Olaya Business Tower (Demo Partner)", displayNameAr: "برج العليا للأعمال (شريك تجريبي)", role: "partner", neighborhood: "olaya", lang: "ar", locationConsentAt: null, deletionRequestedAt: null, createdAt: created, isDemo: true },
    { id: DEMO_USERS.admin, displayName: "Demo Administrator", displayNameAr: "مشرف تجريبي", role: "admin", neighborhood: "olaya", lang: "ar", locationConsentAt: null, deletionRequestedAt: null, createdAt: created, isDemo: true },
    // Extra simulated community members so the map and leaderboard are not empty.
    { id: "00000000-0000-4000-a000-000000000101", displayName: "Noura (demo)", displayNameAr: "نورة (تجريبي)", role: "driver", neighborhood: "malqa", lang: "ar", locationConsentAt: created, deletionRequestedAt: null, createdAt: created, isDemo: true },
    { id: "00000000-0000-4000-a000-000000000102", displayName: "Abdullah (demo)", displayNameAr: "عبدالله (تجريبي)", role: "driver", neighborhood: "kfr", lang: "ar", locationConsentAt: created, deletionRequestedAt: null, createdAt: created, isDemo: true },
    { id: "00000000-0000-4000-a000-000000000103", displayName: "Reem (demo)", displayNameAr: "ريم (تجريبي)", role: "driver", neighborhood: "olaya", lang: "ar", locationConsentAt: created, deletionRequestedAt: null, createdAt: created, isDemo: true },
  ];
  const [noura, abdullah, reem] = ["00000000-0000-4000-a000-000000000101", "00000000-0000-4000-a000-000000000102", "00000000-0000-4000-a000-000000000103"];

  const report = (id: string, reporterId: string, lat: number, lng: number, hood: string, ageMin: number, departIn: number, status: DepartureReport["status"], accuracyM: number, extra: Partial<DepartureReport> = {}): DepartureReport => {
    const createdAt = minutesFrom(now, -ageMin);
    const expected = minutesFrom(now, -ageMin + departIn);
    return {
      id, reporterId, location: { lat, lng }, accuracyM, neighborhood: hood, note: null,
      createdAt, expectedDepartureAt: expected, expiresAt: minutesFrom(new Date(expected), DEFAULT_RULES.reportTtlMinutes),
      status, claimedBy: null, claimedAt: null, claimExpiresAt: null, claimLocation: null,
      resolvedAt: ["found", "not_found", "expired"].includes(status) ? minutesFrom(now, -ageMin + departIn + 8) : null,
      isDemo: true, ...extra,
    };
  };

  const reports: DepartureReport[] = [
    // Live signals (recent, still within the TTL)
    report("00000000-0000-4000-c000-000000000001", noura, 24.69412, 46.68531, "olaya", 3, 0, "available", 8),
    report("00000000-0000-4000-c000-000000000002", abdullah, 24.72671, 46.66497, "wurud", 1, 5, "pending_departure", 14),
    report("00000000-0000-4000-c000-000000000003", reem, 24.73702, 46.65318, "kfr", 9, 0, "available", 35),
    report("00000000-0000-4000-c000-000000000004", noura, 24.80921, 46.61244, "malqa", 2, 0, "available", 22),
    // Expired / resolved history (drives reliability, confidence and the leaderboard)
    report("00000000-0000-4000-c000-000000000010", reem, 24.69580, 46.68320, "olaya", 60 * 26, 0, "found", 9, { claimedBy: noura }),
    report("00000000-0000-4000-c000-000000000011", reem, 24.69501, 46.68410, "olaya", 60 * 50, 0, "found", 12, { claimedBy: abdullah }),
    report("00000000-0000-4000-c000-000000000012", noura, 24.72590, 46.66710, "wurud", 60 * 30, 0, "found", 10, { claimedBy: reem }),
    report("00000000-0000-4000-c000-000000000013", abdullah, 24.73810, 46.65120, "kfr", 60 * 72, 0, "not_found", 40, { claimedBy: reem }),
    report("00000000-0000-4000-c000-000000000014", abdullah, 24.69320, 46.68710, "olaya", 95, 0, "expired", 18),
    report("00000000-0000-4000-c000-000000000015", DEMO_USERS.driverA, 24.69455, 46.68600, "olaya", 60 * 40, 0, "found", 7, { claimedBy: DEMO_USERS.driverB }),
  ];

  const confirmations: ReportConfirmation[] = reports
    .filter((r) => r.status === "found" || r.status === "not_found")
    .map((r, i) => ({
      id: `00000000-0000-4000-d000-${String(i + 1).padStart(12, "0")}`,
      reportId: r.id, confirmerId: r.claimedBy!, outcome: r.status as "found" | "not_found",
      location: { lat: r.location.lat + 0.0002, lng: r.location.lng }, accuracyM: 12, distanceM: 22,
      evidence: "simulated", accepted: true, rejectionReason: null, createdAt: r.resolvedAt!,
    }));

  const ledger: LedgerEntry[] = [];
  let n = 1;
  const entry = (userId: string, amount: number, type: LedgerEntry["type"], reason: string, key: string, refId: string | null, createdAt: string) => {
    ledger.push({ id: `00000000-0000-4000-e000-${String(n++).padStart(12, "0")}`, userId, amount, type, reason, idempotencyKey: key, refType: refId ? "departure_report" : null, refId, createdAt });
  };
  for (const r of reports.filter((r) => r.status === "found")) {
    entry(r.reporterId, DEFAULT_RULES.departureReward, "departure_reward", "Verified parking handoff (demo history)", `report:${r.id}:reporter`, r.id, r.resolvedAt!);
    entry(r.claimedBy!, DEFAULT_RULES.confirmationReward, "confirmation_reward", "Confirmed a community parking signal on site (demo history)", `report:${r.id}:confirmer`, r.id, r.resolvedAt!);
  }
  entry(reem, DEFAULT_RULES.confirmationReward, "confirmation_reward", "Reported on site that a signal was no longer available (demo history)", "report:00000000-0000-4000-c000-000000000013:confirmer", "00000000-0000-4000-c000-000000000013", minutesFrom(now, -60 * 72 + 8));
  // Starting demo balances so redemption can be tried immediately.
  entry(DEMO_USERS.driverA, 30, "mission_reward", "Approved Park & Connect mission (demo history, simulated)", "seed:mission:driverA", null, minutesFrom(now, -60 * 24 * 5));
  entry(DEMO_USERS.driverB, 10, "mission_reward", "Approved Park & Connect mission (demo history, simulated)", "seed:mission:driverB", null, minutesFrom(now, -60 * 24 * 6));

  const partners: ParkingPartner[] = [
    { id: PARTNER_ID, ownerId: DEMO_USERS.partner, name: "Olaya Business Tower (Demo)", nameAr: "برج العليا للأعمال (تجريبي)", kind: "office", contactEmail: "partner@demo.rakna.invalid", crNumberProvided: true, status: "approved", createdAt: created, reviewedAt: created, isDemo: true },
    { id: PENDING_PARTNER_ID, ownerId: "00000000-0000-4000-a000-0000000000c2", name: "Malqa Boutique Hotel (Demo application)", nameAr: "فندق الملقا (طلب تجريبي)", kind: "hotel", contactEmail: "hotel@demo.rakna.invalid", crNumberProvided: true, status: "pending", createdAt: minutesFrom(now, -300), reviewedAt: null, isDemo: true },
  ];
  profiles.push({ id: "00000000-0000-4000-a000-0000000000c2", displayName: "Malqa Hotel (Demo applicant)", displayNameAr: "فندق الملقا (متقدم تجريبي)", role: "partner", neighborhood: "malqa", lang: "ar", locationConsentAt: null, deletionRequestedAt: null, createdAt: created, isDemo: true });

  const space = (id: string, partnerId: string, title: string, titleAr: string, lat: number, lng: number, hood: string, address: string, addressAr: string, capacity: number, price: number, schedule: typeof allWeek, rewardEligible: boolean, approval: ParkingSpace["approval"]): ParkingSpace => ({
    id, partnerId, title, titleAr, location: { lat, lng }, neighborhood: hood, address, addressAr, capacity, pricePerHour: price, schedule,
    conditions: "Demo listing. Max vehicle height 2.1 m. Follow on-site staff instructions. No overnight parking.",
    conditionsAr: "إعلان تجريبي. أقصى ارتفاع للمركبة 2.1 م. اتبع تعليمات الموظفين. لا يُسمح بالمبيت.",
    rewardEligible, approval, createdAt: created, isDemo: true,
  });

  const spaces: ParkingSpace[] = [
    space("00000000-0000-4000-f000-000000000001", PARTNER_ID, "Olaya Tower — Basement P2 (Demo)", "برج العليا — القبو P2 (تجريبي)", 24.69610, 46.68420, "olaya", "Olaya St, Al Olaya (illustrative)", "شارع العليا، حي العليا (توضيحي)", 12, 8, allWeek, true, "approved"),
    space("00000000-0000-4000-f000-000000000002", PARTNER_ID, "Olaya Tower — Visitor Deck (Demo)", "برج العليا — مواقف الزوار (تجريبي)", 24.69350, 46.68650, "olaya", "Off Olaya St, Al Olaya (illustrative)", "متفرع من شارع العليا (توضيحي)", 6, 12, workWeek, true, "approved"),
    space("00000000-0000-4000-f000-000000000003", PARTNER_ID, "Wurud Office Annex (Demo)", "ملحق مكاتب الورود (تجريبي)", 24.72480, 46.66810, "wurud", "Al Wurud (illustrative)", "حي الورود (توضيحي)", 8, 6, workWeek, false, "approved"),
    space("00000000-0000-4000-f000-000000000004", PARTNER_ID, "King Fahd Rd Plaza (Demo)", "ساحة طريق الملك فهد (تجريبي)", 24.73560, 46.65580, "kfr", "King Fahd Rd service lane (illustrative)", "طريق الملك فهد — الطريق الخدمي (توضيحي)", 20, 10, allWeek, true, "approved"),
    space("00000000-0000-4000-f000-000000000005", PARTNER_ID, "Malqa Courtyard (Demo, awaiting review)", "فناء الملقا (تجريبي، قيد المراجعة)", 24.81180, 46.60950, "malqa", "Al Malqa (illustrative)", "حي الملقا (توضيحي)", 10, 7, allWeek, true, "pending_review"),
  ];

  const rewards: RewardItem[] = [
    { id: "00000000-0000-4000-9000-000000000001", title: "20% off a partner parking booking", titleAr: "خصم 20% على حجز موقف شريك", description: "Apply when booking an eligible private space.", descriptionAr: "يُطبق عند حجز موقف خاص مؤهل.", category: "parking_discount", keysRequired: 15, partnerId: null, discountPercent: 20, eligibility: "Eligible partner spaces only", eligibilityAr: "مواقف الشركاء المؤهلة فقط", terms: "Simulated in demo mode. One discount per booking. No cash value. Not transferable.", termsAr: "محاكاة في الوضع التجريبي. خصم واحد لكل حجز. لا قيمة نقدية. غير قابل للتحويل.", active: true, stock: null, isDemo: true },
    { id: "00000000-0000-4000-9000-000000000002", title: "50% off at Olaya Business Tower", titleAr: "خصم 50% في برج العليا للأعمال", description: "Half-price parking at the demo partner's spaces.", descriptionAr: "نصف السعر في مواقف الشريك التجريبي.", category: "parking_discount", keysRequired: 35, partnerId: PARTNER_ID, discountPercent: 50, eligibility: "Olaya Business Tower spaces", eligibilityAr: "مواقف برج العليا للأعمال", terms: "Simulated in demo mode. No cash value.", termsAr: "محاكاة في الوضع التجريبي. لا قيمة نقدية.", active: true, stock: null, isDemo: true },
    { id: "00000000-0000-4000-9000-000000000003", title: "Free car-wash voucher (sponsored)", titleAr: "قسيمة غسيل سيارة مجانية (برعاية)", description: "Sponsored voucher from a demo partner.", descriptionAr: "قسيمة برعاية شريك تجريبي.", category: "sponsored_voucher", keysRequired: 25, partnerId: null, discountPercent: null, eligibility: "Driver accounts in good standing", eligibilityAr: "حسابات السائقين ذات السجل الجيد", terms: "Simulated in demo mode. Requires admin approval. No cash value.", termsAr: "محاكاة في الوضع التجريبي. تتطلب موافقة المشرف. لا قيمة نقدية.", active: true, stock: 20, isDemo: true },
    { id: "00000000-0000-4000-9000-000000000004", title: "Priority valet at partner hotels", titleAr: "أولوية خدمة صف السيارات في الفنادق الشريكة", description: "Partner benefit for active community members.", descriptionAr: "ميزة شريك لأعضاء المجتمع النشطين.", category: "partner_benefit", keysRequired: 40, partnerId: null, discountPercent: null, eligibility: "Contribution score 50+", eligibilityAr: "درجة مساهمة 50 فأكثر", terms: "Simulated in demo mode. Requires admin approval.", termsAr: "محاكاة في الوضع التجريبي. تتطلب موافقة المشرف.", active: true, stock: 10, isDemo: true },
    { id: "00000000-0000-4000-9000-000000000005", title: "RAKNA Circle membership — 1 month", titleAr: "عضوية دائرة ركنة — شهر", description: "Early access to new features and partner perks.", descriptionAr: "وصول مبكر للميزات الجديدة ومزايا الشركاء.", category: "membership_perk", keysRequired: 60, partnerId: null, discountPercent: null, eligibility: "All drivers", eligibilityAr: "جميع السائقين", terms: "Simulated in demo mode.", termsAr: "محاكاة في الوضع التجريبي.", active: true, stock: null, isDemo: true },
  ];

  const challenges: NeighborhoodChallenge[] = [
    { id: "00000000-0000-4000-8000-000000000001", title: "Help one driver today", titleAr: "ساعد سائقًا واحدًا اليوم", description: "One verified handoff — as the leaver or the finder.", descriptionAr: "تسليم موثق واحد — كمغادر أو كباحث.", metric: "handoffs_today", target: 1, neighborhood: null, active: true, isDemo: true },
    { id: "00000000-0000-4000-8000-000000000002", title: "Three successful handoffs", titleAr: "ثلاثة تسليمات ناجحة", description: "Three of your departure reports verified this week.", descriptionAr: "ثلاثة من بلاغات مغادرتك موثقة هذا الأسبوع.", metric: "handoffs_week", target: 3, neighborhood: null, active: true, isDemo: true },
    { id: "00000000-0000-4000-8000-000000000003", title: "Five verified reports this week", titleAr: "خمسة بلاغات موثقة هذا الأسبوع", description: "Reports confirmed on site by another driver (found or not).", descriptionAr: "بلاغات أكدها سائق آخر في الموقع.", metric: "verified_reports_week", target: 5, neighborhood: null, active: true, isDemo: true },
    { id: "00000000-0000-4000-8000-000000000004", title: "Al Olaya community week", titleAr: "أسبوع مجتمع العليا", description: "Together, 10 verified handoffs in Al Olaya this week.", descriptionAr: "معًا، 10 تسليمات موثقة في العليا هذا الأسبوع.", metric: "neighborhood_handoffs_week", target: 10, neighborhood: "olaya", active: true, isDemo: true },
    { id: "00000000-0000-4000-8000-000000000005", title: "Complete a Park & Connect mission", titleAr: "أكمل مهمة اركن واتصل", description: "Simulated: park near a transit connection and finish by metro.", descriptionAr: "محاكاة: اركن قرب محطة نقل وأكمل بالمترو.", metric: "missions_approved", target: 1, neighborhood: null, active: true, isDemo: true },
  ];

  const bookings: ParkingBooking[] = [
    { id: "00000000-0000-4000-7000-000000000001", spaceId: spaces[0].id, userId: noura, startAt: minutesFrom(now, 60 * 20), endAt: minutesFrom(now, 60 * 22), hours: 2, priceTotal: 16, discountApplied: 0, redemptionId: null, status: "confirmed", simulatedPayment: true, createdAt: minutesFrom(now, -120) },
    { id: "00000000-0000-4000-7000-000000000002", spaceId: spaces[3].id, userId: abdullah, startAt: minutesFrom(now, -60 * 26), endAt: minutesFrom(now, -60 * 23), hours: 3, priceTotal: 30, discountApplied: 6, redemptionId: null, status: "completed", simulatedPayment: true, createdAt: minutesFrom(now, -60 * 30) },
  ];

  // ── Phase 3: RAKNA PARTNERS tags + RAKNA HOME / PARK & CONNECT demo inventory ──
  for (const s of spaces) {
    Object.assign(s, {
      spaceCategory: "commercial", entitlementType: "commercial_cr", verificationStatus: s.approval === "approved" ? "verified" : "pending",
      publicLocation: s.location, bufferMinutes: 0, instantBook: true, accessMode: "unobstructed", waitlistOnly: false, hostId: null,
    } satisfies Partial<ParkingSpace>);
  }
  // Demo host: Faisal (driver B) lists his deeded condo bay and his villa carport.
  partners.push({ id: HOME_PARTNER_ID, ownerId: DEMO_USERS.driverB, name: "Faisal (RAKNA HOME host, demo)", nameAr: "فيصل (مضيف ركنة هوم، تجريبي)", kind: "residential", contactEmail: "", crNumberProvided: false, status: "approved", createdAt: created, reviewedAt: created, isDemo: true });
  const home = (id: string, partnerId: string, hostId: string | null, o: Partial<ParkingSpace> & Pick<ParkingSpace, "title" | "titleAr" | "location" | "neighborhood" | "address" | "addressAr">): ParkingSpace => ({
    id, partnerId, hostId, capacity: 1, pricePerHour: 8, schedule: allWeek, conditions: "Demo listing. Please park inside the marked bay only.", conditionsAr: "إعلان تجريبي. يرجى الوقوف داخل الموقف المحدد فقط.",
    rewardEligible: true, approval: "approved", createdAt: created, isDemo: true, accessibleBays: 0, verificationStatus: "verified", bufferMinutes: 15, instantBook: true,
    waitlistOnly: false, spaceCategory: "condo_deeded", entitlementType: "deed_owner", accessMode: "ephemeral_pin", shadeTier: "underground", maxHeightCm: 210, maxWidthCm: 250, maxLengthCm: 520,
    metroStationCode: null, landlordConsentAt: null, ...o,
  });
  spaces.push(
    home(HOME_SPACES.condo, HOME_PARTNER_ID, DEMO_USERS.driverB, {
      title: "Wurud Residence — basement bay B-14 (Demo)", titleAr: "سكن الورود — موقف القبو B-14 (تجريبي)", location: { lat: 24.72452, lng: 46.66804 }, neighborhood: "wurud",
      address: "Bldg 7, Al Wurud (illustrative)", addressAr: "مبنى 7، حي الورود (توضيحي)", pricePerHour: 6, accessMode: "ephemeral_pin",
    }),
    home(HOME_SPACES.villa, HOME_PARTNER_ID, DEMO_USERS.driverB, {
      title: "Malqa villa carport (Demo)", titleAr: "مظلة فيلا الملقا (تجريبي)", location: { lat: 24.80884, lng: 46.61262 }, neighborhood: "malqa",
      address: "Villa 22, Al Malqa (illustrative)", addressAr: "فيلا 22، حي الملقا (توضيحي)", spaceCategory: "villa_shaded", shadeTier: "full_carport", accessMode: "unobstructed",
      waitlistOnly: true, // municipal sandbox: villas are waitlist-only until an admin enables villa bookings
    }),
    home(HOME_SPACES.kafd, PARTNER_ID, null, {
      title: "KAFD Park & Connect — level P3 (Demo)", titleAr: "اركن واتصل المركز المالي — الطابق P3 (تجريبي)", location: { lat: 24.76655, lng: 46.64422 }, neighborhood: "kfr",
      address: "KAFD, King Fahd Rd (illustrative)", addressAr: "المركز المالي، طريق الملك فهد (توضيحي)", capacity: 40, pricePerHour: 5, spaceCategory: "commercial", entitlementType: "commercial_cr",
      accessMode: "dynamic_qr", shadeTier: "underground", metroStationCode: "KAFD", bufferMinutes: 0, maxWidthCm: null, maxLengthCm: null,
    }),
  );
  const rule = (n: number, spaceId: string, weekdayMask: number, startMinute: number, endMinute: number, hourlyRateHalalas: number, dailyCapHalalas: number | null, multiDayDiscountBps = 0): AvailabilityRule => ({
    id: `00000000-0000-4000-6000-${String(n).padStart(12, "0")}`, spaceId, weekdayMask, startMinute, endMinute, hourlyRateHalalas, dailyCapHalalas, multiDayDiscountBps, isActive: true, createdAt: created,
  });
  const availabilityRules: AvailabilityRule[] = [
    // Condo bay: free while the owner is at work (Sun–Thu 07:00–18:00) + all weekend.
    rule(1, HOME_SPACES.condo, 0b0011111, 7 * 60, 18 * 60, 600, 4000, 1000),
    rule(2, HOME_SPACES.condo, 0b1100000, 0, 1440, 500, 3500, 1000),
    rule(3, HOME_SPACES.villa, 0b1111111, 0, 1440, 800, 5000, 1500),
    rule(4, HOME_SPACES.kafd, 0b1111111, 0, 1440, 500, 2500, 2000),
  ];
  for (const s of spaces) s.publicLocation = s.spaceCategory === "commercial" ? s.location : cellCenter(hiveIndexFor(s.location).r9);

  // ── RAKNA HIVE demo data ─────────────────────────────────────────
  for (const r of reports) r.hive = hiveIndexFor(r.location);
  const bays: Record<string, number> = { [spaces[0].id]: 2, [spaces[3].id]: 3, [spaces[2].id]: 1 };
  for (const s of spaces) {
    s.hive = hiveIndexFor(s.location);
    s.accessibleBays = bays[s.id] ?? 0;
  }

  // Outcome trails: the seeded resolved handoffs are folded into anonymized cell stats…
  const cellStats: HiveCellStat[] = [];
  for (const r of reports.filter((x) => x.status === "found" || x.status === "not_found")) {
    cellStats.push({ cell: r.hive!.r10, bucketStart: hourBucket(new Date(r.resolvedAt!)), reports: 1, found: r.status === "found" ? 1 : 0, notFound: r.status === "not_found" ? 1 : 0, expired: 0, isDemo: true });
    r.aggregatedAt = r.resolvedAt;
  }
  // …plus a short simulated history per area (DEMO DATA) so trails differ between hives.
  const history: [number, number, number, number, number][] = [
    // lat, lng, found, notFound, daysAgo
    [24.6950, 46.6840, 3, 0, 2], [24.6943, 46.6858, 2, 1, 5], [24.6961, 46.6842, 2, 0, 8],
    [24.7262, 46.6655, 2, 1, 3], [24.7370, 46.6530, 1, 2, 4], [24.7352, 46.6560, 0, 2, 6],
    [24.8095, 46.6120, 1, 0, 9],
  ];
  for (const [lat, lng, f, nf, d] of history) {
    cellStats.push({ cell: hiveIndexFor({ lat, lng }).r10, bucketStart: hourBucket(new Date(now.getTime() - d * 86_400_000)), reports: f + nf, found: f, notFound: nf, expired: 0, isDemo: true });
  }

  // Anonymous demand counters for the current and previous hour (DEMO DATA, r9 cells).
  const demandAt: [number, number, number][] = [
    [24.69412, 46.68531, 9], // Al Olaya signal hive — busy
    [24.6890, 46.6905, 6], // neighbouring Olaya hive with no verified supply → overloaded
    [24.73702, 46.65318, 4], // King Fahd Rd
    [24.72671, 46.66497, 1], // Al Wurud
  ];
  const demand: HiveDemandBucket[] = [];
  for (const [lat, lng, n] of demandAt) {
    const cell = hiveIndexFor({ lat, lng }).r9;
    demand.push({ cell, bucketStart: hourBucket(now), searches: Math.ceil(n * 0.6), isDemo: true });
    demand.push({ cell, bucketStart: hourBucket(new Date(now.getTime() - 3_600_000)), searches: Math.floor(n * 0.4), isDemo: true });
  }

  return {
    profiles, reports, claims: [], confirmations, ledger, rewards, redemptions: [], partners, spaces, bookings,
    challenges, challengeProgress: [], missions: [], fraudFlags: [], audit: [], rules: { ...DEFAULT_RULES },
    seededAt: now.toISOString(),
    cellStats, demand, hiveConfig: { ...DEFAULT_HIVE_CONFIG }, feedback: { helpful: 0, notHelpful: 0 }, jobRuns: [],
    availabilityRules, availabilityExceptions: [], credentials: [], bookingEvents: [], rateLimits: {}, platformSettings: { ...DEFAULT_PLATFORM_SETTINGS },
  };
}

/** DEMO ONLY: add a burst of anonymous search demand to the busiest demo hives. */
export function demoDemandBurst(): { lat: number; lng: number; n: number }[] {
  return [
    { lat: 24.69412, lng: 46.68531, n: 6 },
    { lat: 24.6890, lng: 46.6905, n: 4 },
    { lat: 24.73702, lng: 46.65318, n: 3 },
  ];
}
