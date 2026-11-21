import type { AccessMode, BookingEventType, EntitlementType, Lang, PaymentStatus, ReportStatus, ShadeTier, SpaceCategory, VerificationStatus } from "./types";

/** Bilingual helpers. Arabic is the default language; layout direction follows the language. */

export function dirFor(lang: Lang): "rtl" | "ltr" {
  return lang === "ar" ? "rtl" : "ltr";
}

export type Bi = { en: string; ar: string };

export const STATUS_LABEL: Record<ReportStatus, Bi> = {
  pending_departure: { en: "Pending departure", ar: "مغادرة قريبة" },
  available: { en: "Available signal", ar: "إشارة متاحة" },
  claimed: { en: "Claimed", ar: "قيد التوجه" },
  found: { en: "Successfully found", ar: "تم العثور عليه" },
  not_found: { en: "Not found", ar: "لم يُعثر عليه" },
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
  distance: { en: "Distance from you", ar: "المسافة منك" },
  reliability: { en: "Reporter reliability", ar: "موثوقية المُبلّغ" },
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
  pending: { en: "Verification pending", ar: "قيد التحقق" },
  verified: { en: "Verified", ar: "موثّق" },
  rejected: { en: "Verification rejected", ar: "رُفض التحقق" },
  suspended: { en: "Suspended", ar: "موقوف" },
};

export const SHADE_LABEL: Record<ShadeTier, Bi> = {
  underground: { en: "Underground", ar: "قبو" },
  enclosed: { en: "Enclosed", ar: "مغلق" },
  full_carport: { en: "Full carport shade", ar: "مظلة كاملة" },
  partial_shade: { en: "Partial shade", ar: "ظل جزئي" },
  uncovered: { en: "Uncovered", ar: "مكشوف" },
};

export const ACCESS_MODE_LABEL: Record<AccessMode, Bi> = {
  unobstructed: { en: "Open access", ar: "دخول مباشر" },
  ephemeral_pin: { en: "One-time gate PIN", ar: "رمز بوابة مؤقت" },
  dynamic_qr: { en: "Dynamic QR pass", ar: "تصريح QR متغير" },
  guard_pass: { en: "Guard pass", ar: "تصريح الحارس" },
  host_remote: { en: "Host opens remotely", ar: "يفتح المضيف عن بُعد" },
};

export const PAYMENT_STATUS_LABEL: Record<PaymentStatus, Bi> = {
  simulated: { en: "Simulated payment", ar: "دفع تجريبي" },
  pending: { en: "Payment pending", ar: "الدفع معلق" },
  paid: { en: "Paid", ar: "مدفوع" },
  failed: { en: "Payment failed", ar: "فشل الدفع" },
  refunded: { en: "Refunded", ar: "مسترد" },
};

export const BOOKING_EVENT_LABEL: Record<BookingEventType, Bi> = {
  arrived: { en: "Arrived", ar: "وصل" },
  extended: { en: "Extended", ar: "تم التمديد" },
  departed: { en: "Departed", ar: "غادر" },
  overstay_flagged: { en: "Overstay", ar: "تجاوز المدة" },
  bay_blocked_reported: { en: "Bay blocked reported", ar: "بلاغ موقف مشغول" },
};

/** Integer halalas → localized "SAR 12.50" string. */
export function formatHalalas(h: number, lang: Lang): string {
  const v = (h / 100).toFixed(2);
  return lang === "ar" ? `${v} ر.س` : `SAR ${v}`;
}

export const DISCLAIMER: Bi = {
  en: "Community parking signals are informational only. Availability is not guaranteed. Always follow local parking regulations.",
  ar: "إشارات المواقف المجتمعية لأغراض المعلومات فقط. التوفر غير مضمون. التزم دائمًا بأنظمة المواقف المحلية.",
};

export const TAGLINE: Bi = {
  en: "Leave a Spot. Earn Rewards. Help Your City Move.",
  ar: "اترك موقفًا، اكسب نقاطًا، وساعد غيرك.",
};

export const DAY_SHORT: Bi[] = [
  { en: "Sun", ar: "أحد" },
  { en: "Mon", ar: "إثنين" },
  { en: "Tue", ar: "ثلاثاء" },
  { en: "Wed", ar: "أربعاء" },
  { en: "Thu", ar: "خميس" },
  { en: "Fri", ar: "جمعة" },
  { en: "Sat", ar: "سبت" },
];

export const ERROR_MESSAGES: Record<string, Bi> = {
  unauthenticated: { en: "Pick a demo account (or sign in) first.", ar: "اختر حسابًا تجريبيًا (أو سجّل الدخول) أولًا." },
  forbidden: { en: "Your account can't do that.", ar: "لا يملك حسابك صلاحية هذا الإجراء." },
  not_found: { en: "Not found.", ar: "غير موجود." },
  validation: { en: "Please check the details and try again.", ar: "يرجى مراجعة البيانات والمحاولة مجددًا." },
  report_expired: { en: "This report has expired.", ar: "انتهت صلاحية هذا البلاغ." },
  report_not_available: { en: "This signal is no longer available.", ar: "هذه الإشارة لم تعد متاحة." },
  self_confirmation: { en: "You can't claim or confirm your own report.", ar: "لا يمكنك التوجه إلى بلاغك أو تأكيده بنفسك." },
  not_claimer: { en: "Tap “Navigate to this spot” before confirming.", ar: "اضغط «توجّه إلى هذا الموقف» قبل التأكيد." },
  already_confirmed: { en: "This report was already resolved.", ar: "تمت معالجة هذا البلاغ مسبقًا." },
  too_far: { en: "You need to be at the reported location to confirm.", ar: "يجب أن تكون في الموقع المُبلّغ عنه لتأكيده." },
  low_accuracy: { en: "GPS accuracy is too low. Move to open sky and retry.", ar: "دقة الموقع منخفضة. انتقل إلى مكان مكشوف وأعد المحاولة." },
  outside_service_area: { en: "The MVP covers Riyadh only.", ar: "النسخة الحالية تغطي الرياض فقط." },
  duplicate_report: { en: "You already have an active report for this.", ar: "لديك بلاغ نشط بالفعل." },
  daily_report_limit: { en: "Daily report limit reached.", ar: "بلغت الحد اليومي للبلاغات." },
  insufficient_balance: { en: "Not enough RAKNA KEYS.", ar: "رصيد مفاتيح ركنة غير كافٍ." },
  reward_unavailable: { en: "This reward is unavailable.", ar: "هذه المكافأة غير متاحة." },
  reward_ineligible: { en: "This reward can't be used here.", ar: "لا يمكن استخدام هذه المكافأة هنا." },
  partner_not_approved: { en: "Your partner account isn't approved yet.", ar: "حساب الشريك لم يُعتمد بعد." },
  space_not_bookable: { en: "This space isn't bookable.", ar: "هذا الموقف غير متاح للحجز." },
  outside_schedule: { en: "The space is closed at that time.", ar: "الموقف مغلق في ذلك الوقت." },
  capacity_full: { en: "Fully booked for that time.", ar: "محجوز بالكامل في ذلك الوقت." },
  rate_limited: { en: "Too many requests — please wait a moment.", ar: "طلبات كثيرة — يرجى الانتظار قليلًا." },
  already_claimed_other: { en: "Another driver is already heading there.", ar: "سائق آخر متجه إلى هناك بالفعل." },
  verification_required: { en: "This space is awaiting entitlement verification.", ar: "هذا الموقف بانتظار التحقق من أحقية التأجير." },
  waitlist_only: { en: "Villa bookings aren't open yet. You can join the waitlist.", ar: "حجوزات الفلل غير متاحة بعد. يمكنك الانضمام لقائمة الانتظار." },
  entitlement_invalid: { en: "That ownership/authorization type can't list this space.", ar: "نوع الملكية أو التفويض لا يسمح بإدراج هذا الموقف." },
  buffer_conflict: { en: "That time clashes with another booking (including turnaround time).", ar: "يتعارض هذا الوقت مع حجز آخر (بما في ذلك وقت التجهيز)." },
  outside_geofence: { en: "You need to be at the space to check in.", ar: "يجب أن تكون عند الموقف لتسجيل الوصول." },
  access_not_ready: { en: "Access details unlock 30 minutes before your booking.", ar: "تظهر تفاصيل الدخول قبل ٣٠ دقيقة من موعد الحجز." },
  payment_required: { en: "Payment isn't confirmed for this booking yet.", ar: "لم يتم تأكيد الدفع لهذا الحجز بعد." },
  conflict: { en: "That action conflicts with the current state.", ar: "يتعارض هذا الإجراء مع الحالة الحالية." },
  internal: { en: "Something went wrong.", ar: "حدث خطأ ما." },
  network: { en: "Network error. Check your connection.", ar: "خطأ في الشبكة. تحقق من اتصالك." },
};
