"use client";

import { useApp } from "./providers";
import { cn } from "./ui";
import { DAY_SHORT, formatHalalas } from "@/lib/i18n";
import type { FareBreakdown } from "@/lib/types";

/** Shared RAKNA HOME UI pieces (bilingual, RTL-safe: logical properties only). */

export function minutesLabel(m: number): string {
  const h = Math.floor(m / 60) % 24;
  const mm = m % 60;
  return m === 1440 ? "24:00" : `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

export function daysLabel(mask: number, B: (b: { en: string; ar: string }) => string): string {
  if (mask === 127) return B({ en: "Every day", ar: "كل يوم" });
  if (mask === 31) return B({ en: "Sun–Thu", ar: "الأحد–الخميس" });
  if (mask === 96) return B({ en: "Fri–Sat", ar: "الجمعة–السبت" });
  return DAY_SHORT.filter((_, i) => (mask & (1 << i)) !== 0).map(B).join("، ");
}

export function RuleSummary({ rule }: { rule: { weekdayMask: number; startMinute: number; endMinute: number; hourlyRateHalalas: number; dailyCapHalalas: number | null; multiDayDiscountBps: number } }) {
  const { L, B, lang } = useApp();
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-sage-mist px-3 py-2 text-xs">
      <span className="font-semibold text-ink">{daysLabel(rule.weekdayMask, B)}</span>
      <span className="num text-ink-2" dir="ltr">{minutesLabel(rule.startMinute)}–{minutesLabel(rule.endMinute)}</span>
      <span className="num font-semibold text-forest">{formatHalalas(rule.hourlyRateHalalas, lang)}/{L("h", "س")}</span>
      {rule.dailyCapHalalas !== null && <span className="text-mute">{L("daily cap", "حد يومي")} <span className="num">{formatHalalas(rule.dailyCapHalalas, lang)}</span></span>}
      {rule.multiDayDiscountBps > 0 && <span className="text-mute">{L(`${rule.multiDayDiscountBps / 100}% off 5+ days`, `خصم ${rule.multiDayDiscountBps / 100}% لخمسة أيام+`)}</span>}
    </li>
  );
}

/** Integer-halalas fare breakdown. The host's payout line is shown to make the Keys firewall visible. */
export function FareTable({ fare, showHost }: { fare: FareBreakdown; showHost?: boolean }) {
  const { L, lang } = useApp();
  const row = (label: string, value: number, cls?: string, sign = "") => (
    <div className={cn("flex items-center justify-between gap-3 py-1.5", cls)}>
      <dt>{label}</dt>
      <dd className="num" dir="ltr">{sign}{formatHalalas(value, lang)}</dd>
    </div>
  );
  return (
    <dl className="divide-y divide-line text-sm">
      {row(L("Parking (base fare)", "الموقف (الأجرة الأساسية)"), fare.baseFareHalalas)}
      {row(L("Service fee (5%)", "رسوم الخدمة (5%)"), fare.driverFeeHalalas)}
      {row(L("VAT 15% on platform fee", "ضريبة القيمة المضافة 15% على رسوم المنصة"), fare.vatOnPlatformFeeHalalas)}
      {fare.keysDiscountHalalas > 0 && row(L("RAKNA KEYS discount (platform fee)", "خصم مفاتيح ركنة (رسوم المنصة)"), fare.keysDiscountHalalas, "text-gold", "−")}
      {row(L("Total", "الإجمالي"), fare.driverTotalHalalas, "font-bold text-forest")}
      {showHost && row(L("Host receives (85% of base)", "يستلم المضيف (85% من الأساس)"), fare.hostNetPayoutHalalas, "text-xs text-mute")}
    </dl>
  );
}
