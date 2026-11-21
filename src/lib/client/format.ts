import type { Lang } from "../types";

export function timeAgo(iso: string, lang: Lang, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return lang === "ar" ? "الحين" : "just now";
  const m = Math.round(s / 60);
  if (m < 60) return lang === "ar" ? `قبل ${m} د` : `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return lang === "ar" ? `قبل ${h} س` : `${h} h ago`;
  const d = Math.round(h / 24);
  return lang === "ar" ? `قبل ${d} يوم` : `${d} d ago`;
}

export function countdown(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((new Date(iso).getTime() - now) / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

export function fmtDateTime(iso: string, lang: Lang): string {
  return new Intl.DateTimeFormat(lang === "ar" ? "ar-SA-u-nu-latn" : "en-GB", {
    timeZone: "Asia/Riyadh",
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

export function fmtSar(n: number, lang: Lang): string {
  const v = Number.isInteger(n) ? String(n) : n.toFixed(2);
  return lang === "ar" ? `${v} ريال` : `${v} SAR`;
}

/** Value for <input type="datetime-local"> expressed in Riyadh time. */
export function riyadhInputValue(d: Date): string {
  const local = new Date(d.getTime() + 3 * 3_600_000);
  return local.toISOString().slice(0, 16);
}

export function fromRiyadhInput(v: string): Date {
  return new Date(new Date(`${v}:00Z`).getTime() - 3 * 3_600_000);
}
