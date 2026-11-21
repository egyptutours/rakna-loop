import type { AccessMode, BookingEventType, EntitlementType, Lang, PaymentStatus, ReportStatus, ShadeTier, SpaceCategory, VerificationStatus } from "./types";

/** Bilingual helpers. Arabic is the default language; layout direction follows the language. */

export function dirFor(lang: Lang): "rtl" | "ltr" {
  return lang === "ar" ? "rtl" : "ltr";
}

export type Bi = { en: string; ar: string };

export const STATUS_LABEL: Record<ReportStatus, Bi> = {
  pending_departure: { en: "Pending departure", ar: "طالع قريب" },
  available: { en: "Available signal", ar: "إشارة متاحة" },
  claimed: { en: "Claimed", ar: "أحد رايح له" },
  found: { en: "Successfully found", ar: "انلقى" },
  not_found: { en: "Not found", ar: "ما انلقى" },
  expired: { en: "Expired", ar: "منتهي" },
  flagged: { en: "Under review", ar: "قيد المراجعة" },
};

export const CONFIDENCE_LABEL: Record<"high" | "medium" | "low", Bi> = {
  high: { en: "High confidence", ar: "ثقة عالية" },
  medium: { en: "Medium confidence", ar: "ثقة متوسطة" },
  low: { en: "Low confidence", ar: "ثقة منخفضة" },
};

export const FACTOR_LABEL: Record<string, Bi> = {
  freshness: { en: "Freshness", ar: "حداثة البلاغ" },
  accuracy: { en: "GPS accuracy", ar: "دقة الموقع" },
  distance: { en: "Distance from you", ar: "بعدك عنه" },
  reliability: { en: "Reporter reliability", ar: "موثوقية المبلّغ" },
  history: { en: "Spot history", ar: "سجل الموقع" },
};

export const NEIGHBORHOOD_LABEL: Record<string, Bi> = {
  olaya: { en: "Al Olaya", ar: "العليا" },
  wurud: { en: "Al Wurud", ar: "الورود" },
  malqa: { en: "Al Malqa", ar: "الملقا" },
  kfr: { en: "King Fahd Road", ar: "طريق الملك فهد" },
};

export const ROLE_LABEL: Record<string, Bi> = {
  driver: { en: "Driver", ar: "سائق" },
  partner: { en: "Parking partner", ar: "شريك مواقف" },
  admin: { en: "Administrator", ar: "مشرف" },
};

export const SPACE_CATEGORY_LABEL: Record<SpaceCategory, Bi> = {
  villa_shaded: { en: "Villa carport (shaded)", ar: "مظلة فيلا" },
  villa_open: { en: "Villa driveway (open)", ar: "ممر فيلا مكشوف" },
  villa_garage: { en: "Villa garage", ar: "كراج فيلا" },
  condo_deeded: { en: "Building bay (deeded)", ar: "موقف عمارة (بصك)" },
  condo_association: { en: "Building bay (owners' association)", ar: "موقف عمارة (اتحاد ملاك)" },
  commercial: { en: "Commercial parking", ar: "مواقف تجارية" },
};

export const ENTITLEMENT_LABEL: Record<EntitlementType, Bi> = {
  deed_owner: { en: "Title-deed owner", ar: "مالك بصك" },
  owner_wakalah: { en: "Owner's power of attorney (wakalah)", ar: "وكالة من المالك" },
  ejar_authorized: { en: "Tenant (Ejar) with landlord consent", ar: "مستأجر (إيجار) بموافقة المالك" },
  owners_association: { en: "Owners' association authorization", ar: "تفويض اتحاد الملاك" },
  commercial_cr: { en: "Commercial registration", ar: "سجل تجاري" },
};

export const VERIFICATION_LABEL: Record<VerificationStatus, Bi> = {
  pending: { en: "Verification pending", ar: "تحت التحقق" },
  verified: { en: "Verified", ar: "موثّق" },
  rejected: { en: "Verification rejected", ar: "انرفض التحقق" },
  suspended: { en: "Suspended", ar: "موقوف" },
};

export const SHADE_LABEL: Record<ShadeTier, Bi> = {
  underground: { en: "Underground", ar: "قبو" },
  enclosed: { en: "Enclosed", ar: "مقفل" },
  full_carport: { en: "Full carport shade", ar: "مظلة كاملة" },
  partial_shade: { en: "Partial shade", ar: "ظل جزئي" },
  uncovered: { en: "Uncovered", ar: "مكشوف" },
};

export const ACCESS_MODE_LABEL: Record<AccessMode, Bi> = {
  unobstructed: { en: "Open access", ar: "دخول مباشر" },
  ephemeral_pin: { en: "One-time gate PIN", ar: "رمز بوابة مؤقت" },
  dynamic_qr: { en: "Dynamic QR pass", ar: "تصريح QR متغيّر" },
  guard_pass: { en: "Guard pass", ar: "تصريح الحارس" },
  host_remote: { en: "Host opens remotely", ar: "المضيف يفتح عن بعد" },
};

export const PAYMENT_STATUS_LABEL: Record<PaymentStatus, Bi> = {
  simulated: { en: "Simulated payment", ar: "دفع تجريبي" },
  pending: { en: "Payment pending", ar: "الدفع معلّق" },
  paid: { en: "Paid", ar: "مدفوع" },
  failed: { en: "Payment failed", ar: "الدفع ما مشى" },
  refunded: { en: "Refunded", ar: "رجع المبلغ" },
};

export const BOOKING_EVENT_LABEL: Record<BookingEventType, Bi> = {
  arrived: { en: "Arrived", ar: "وصل" },
  extended: { en: "Extended", ar: "تمدّد" },
  departed: { en: "Departed", ar: "طلع" },
  overstay_flagged: { en: "Overstay", ar: "تأخّر عن الوقت" },
  bay_blocked_reported: { en: "Bay blocked reported", ar: "بلاغ موقف مشغول" },
};

/** Integer halalas → localized "SAR 12.50" string. */
export function formatHalalas(h: number, lang: Lang): string {
  const v = (h / 100).toFixed(2);
  return lang === "ar" ? `${v} ر.س` : `SAR ${v}`;
}

export const DISCLAIMER: Bi = {
  en: "Community parking signals are informational only. Availability is not guaranteed. Always follow local parking regulations.",
  ar: "إشارات المواقف المجتمعية للمعلومية بس. التوفر مو مضمون. التزم دايم بأنظمة المواقف المحلية.",
};

export const TAGLINE: Bi = {
  en: "Leave a Spot. Earn Rewards. Help Your City Move.",
  ar: "اترك موقفك، اكسب نقاط، وساعد غيرك.",
};

export const DAY_SHORT: Bi[] = [
  { en: "Sun", ar: "أحد" },
  { en: "Mon", ar: "اثنين" },
  { en: "Tue", ar: "ثلاثاء" },
  { en: "Wed", ar: "أربعاء" },
  { en: "Thu", ar: "خميس" },
  { en: "Fri", ar: "جمعة" },
  { en: "Sat", ar: "سبت" },
];

export const ERROR_MESSAGES: Record<string, Bi> = {
  unauthenticated: { en: "Pick a demo account (or sign in) first.", ar: "اختر حساب تجريبي (أو سجّل دخولك) أول." },
  forbidden: { en: "Your account can't do that.", ar: "حسابك ما عنده صلاحية لهذا الإجراء." },
  not_found: { en: "Not found.", ar: "مو موجود." },
  validation: { en: "Please check the details and try again.", ar: "راجع البيانات وجرّب مرة ثانية." },
  report_expired: { en: "This report has expired.", ar: "هذا البلاغ انتهت صلاحيته." },
  report_not_available: { en: "This signal is no longer available.", ar: "هذي الإشارة ما عادت متاحة." },
  self_confirmation: { en: "You can't claim or confirm your own report.", ar: "ما تقدر تتوجّه لبلاغك أو تأكده بنفسك." },
  not_claimer: { en: "Tap “Navigate to this spot” before confirming.", ar: "اضغط «توجّه لهذا الموقف» قبل ما تأكد." },
  already_confirmed: { en: "This report was already resolved.", ar: "هذا البلاغ انتهى أمره من قبل." },
  too_far: { en: "You need to be at the reported location to confirm.", ar: "لازم تكون في الموقع المبلّغ عنه عشان تأكده." },
  low_accuracy: { en: "GPS accuracy is too low. Move to open sky and retry.", ar: "دقة الموقع ضعيفة. روح لمكان مكشوف وجرّب مرة ثانية." },
  outside_service_area: { en: "The MVP covers Riyadh only.", ar: "النسخة الحالية تغطي الرياض بس." },
  duplicate_report: { en: "You already have an active report for this.", ar: "عندك بلاغ شغّال من قبل." },
  daily_report_limit: { en: "Daily report limit reached.", ar: "وصلت للحد اليومي للبلاغات." },
  insufficient_balance: { en: "Not enough RAKNA KEYS.", ar: "رصيد مفاتيح ركنة ما يكفي." },
  reward_unavailable: { en: "This reward is unavailable.", ar: "هذي المكافأة مو متاحة." },
  reward_ineligible: { en: "This reward can't be used here.", ar: "ما تقدر تستخدم هذي المكافأة هنا." },
  partner_not_approved: { en: "Your partner account isn't approved yet.", ar: "حساب الشريك ما انعتمد للحين." },
  space_not_bookable: { en: "This space isn't bookable.", ar: "هذا الموقف ما ينحجز." },
  outside_schedule: { en: "The space is closed at that time.", ar: "الموقف مقفل في هذاك الوقت." },
  capacity_full: { en: "Fully booked for that time.", ar: "محجوز بالكامل في هذاك الوقت." },
  rate_limited: { en: "Too many requests — please wait a moment.", ar: "طلبات كثير — انتظر شوي لو سمحت." },
  already_claimed_other: { en: "Another driver is already heading there.", ar: "فيه سائق ثاني رايح هناك." },
  verification_required: { en: "This space is awaiting entitlement verification.", ar: "هذا الموقف ينتظر التحقق من أحقية التأجير." },
  waitlist_only: { en: "Villa bookings aren't open yet. You can join the waitlist.", ar: "حجوزات الفلل ما فتحت للحين. تقدر تنضم لقائمة الانتظار." },
  entitlement_invalid: { en: "That ownership/authorization type can't list this space.", ar: "نوع الملكية أو التفويض ما يسمح بعرض هذا الموقف." },
  buffer_conflict: { en: "That time clashes with another booking (including turnaround time).", ar: "هذا الوقت يتعارض مع حجز ثاني (مع وقت التجهيز)." },
  outside_geofence: { en: "You need to be at the space to check in.", ar: "لازم تكون عند الموقف عشان تسجّل وصولك." },
  access_not_ready: { en: "Access details unlock 30 minutes before your booking.", ar: "تفاصيل الدخول تطلع قبل موعد الحجز بـ ٣٠ دقيقة." },
  payment_required: { en: "Payment isn't confirmed for this booking yet.", ar: "الدفع لهذا الحجز ما تأكد للحين." },
  conflict: { en: "That action conflicts with the current state.", ar: "هذا الإجراء يتعارض مع الحالة الحالية." },
  internal: { en: "Something went wrong.", ar: "صار خطأ." },
  network: { en: "Network error. Check your connection.", ar: "فيه مشكلة في الشبكة. تأكد من اتصالك." },
};
