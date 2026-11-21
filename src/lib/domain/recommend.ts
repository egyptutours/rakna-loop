import type { DepartureReport, LatLng, ParkingSpace } from "../types";
import { NEIGHBORHOODS } from "../config";
import { distanceM } from "../geo";
import type { ConfidenceBreakdown } from "./handoff";
import { riyadhParts } from "./context";

/**
 * Deterministic parking recommendation engine (always available, no API key needed).
 * Ranks ONLY records that exist in the data store. It never invents availability,
 * traffic, or prices. The optional AI layer (src/lib/ai/assistant.ts) only improves
 * how the request is understood; ranking always happens here.
 */

export interface ParsedRequest {
  destination: string | null; // neighborhood id
  arrival: string; // ISO
  arrivalIsNow: boolean;
  durationHours: number;
  budgetSar: number | null;
  maxWalkM: number;
  understood: string[]; // which fields were explicitly recognized
  source: "rules" | "ai";
}

const ALIASES: Record<string, string[]> = {
  olaya: ["olaya", "olaia", "al olaya", "kingdom centre", "kingdom center", "faisaliah", "العليا", "عليا", "برج المملكة", "الفيصلية"],
  wurud: ["wurud", "worood", "al wurud", "الورود", "ورود"],
  malqa: ["malqa", "al malqa", "الملقا", "ملقا"],
  kfr: ["king fahd", "king fahad", "kfr", "طريق الملك فهد", "الملك فهد"],
};

const WORD_NUM: Record<string, number> = {
  one: 1, an: 1, a: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  "ساعة": 1, "ساعتين": 2, "ساعتان": 2, "ثلاث": 3, "ثلاثة": 3, "اربع": 4, "أربع": 4, "خمس": 5,
};

export function normalizeDigits(s: string): string {
  return s.replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d))).replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)));
}

/** Build a UTC instant for a Riyadh local hh:mm today (or tomorrow if already past). */
export function riyadhLocalToUtc(now: Date, hour: number, minute: number, dayOffset = 0): Date {
  const local = new Date(now.getTime() + 3 * 3_600_000);
  local.setUTCHours(hour, minute, 0, 0);
  let utc = new Date(local.getTime() - 3 * 3_600_000 + dayOffset * 86_400_000);
  if (dayOffset === 0 && utc.getTime() < now.getTime() - 15 * 60_000) utc = new Date(utc.getTime() + 86_400_000);
  return utc;
}

export function parseRequest(text: string, now: Date): ParsedRequest {
  const raw = normalizeDigits(text);
  const t = raw.toLowerCase();
  const understood: string[] = [];

  let destination: string | null = null;
  for (const [id, words] of Object.entries(ALIASES)) {
    if (words.some((w) => t.includes(w))) {
      destination = id;
      understood.push("destination");
      break;
    }
  }

  // Arrival time
  let arrival = now;
  let arrivalIsNow = true;
  const en = t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)/);
  const ar = raw.match(/(?:الساعة|ساعة)\s*(\d{1,2})(?::(\d{2}))?\s*(صباح[اً]?|ص|مساء[اً]?|م|الصبح|العصر|الظهر|الليل)?/);
  const at24 = t.match(/\bat\s+(\d{1,2}):(\d{2})\b/);
  const tomorrow = /tomorrow|بكرة|بكره|غدا|غداً/.test(t);
  let hour: number | null = null;
  let minute = 0;
  if (en) {
    hour = Number(en[1]) % 12 + (en[3].startsWith("p") ? 12 : 0);
    minute = en[2] ? Number(en[2]) : 0;
  } else if (ar) {
    hour = Number(ar[1]);
    minute = ar[2] ? Number(ar[2]) : 0;
    const period = ar[3] ?? "";
    if (/مساء|م$|العصر|الليل/.test(period) && hour < 12) hour += 12;
    if (/الظهر/.test(period) && hour < 11) hour += 12;
  } else if (at24) {
    hour = Number(at24[1]);
    minute = Number(at24[2]);
  }
  if (hour !== null && hour >= 0 && hour <= 23 && minute >= 0 && minute < 60) {
    arrival = riyadhLocalToUtc(now, hour, minute, tomorrow ? 1 : 0);
    arrivalIsNow = Math.abs(arrival.getTime() - now.getTime()) < 20 * 60_000;
    understood.push("arrival");
  }

  // Duration
  let durationHours = 2;
  const dNum = t.match(/(\d+(?:\.\d+)?)\s*(hours?|hrs?|h\b)/) ?? raw.match(/(\d+)\s*ساع(?:ة|ات)/);
  const dWord = t.match(/\b(one|an|a|two|three|four|five|six)\s+hours?\b/) ?? raw.match(/(ساعتين|ساعتان|(?:ثلاث|ثلاثة|اربع|أربع|خمس)\s+ساعات)/);
  if (dNum) {
    durationHours = Number(dNum[1]);
    understood.push("duration");
  } else if (dWord) {
    const w = dWord[1].split(/\s+/)[0];
    durationHours = WORD_NUM[w] ?? 2;
    understood.push("duration");
  } else if (/half an hour|نصف ساعة|نص ساعة/.test(t)) {
    durationHours = 1;
    understood.push("duration");
  } else if (/\bfor an hour\b|لمدة ساعة|ساعة واحدة/.test(t)) {
    durationHours = 1;
    understood.push("duration");
  }
  durationHours = Math.max(1, Math.min(12, Math.ceil(durationHours)));

  // Budget
  let budgetSar: number | null = null;
  const b = t.match(/(\d+(?:\.\d+)?)\s*(sar|riyals?|rial|sr\b)/) ?? raw.match(/(\d+(?:\.\d+)?)\s*(ريال|ر\.?\s?س)/) ?? t.match(/budget\s+(?:of\s+)?(\d+(?:\.\d+)?)/) ?? raw.match(/ميزاني(?:[ةه]|تي)\s*(\d+(?:\.\d+)?)/);
  if (b) {
    budgetSar = Number(b[1]);
    understood.push("budget");
  }

  // Walking preference
  let maxWalkM = 800;
  const w = t.match(/(\d{2,4})\s*(m|meters|metres)\b/) ?? raw.match(/(\d{2,4})\s*متر/);
  if (w) {
    maxWalkM = Number(w[1]);
    understood.push("walk");
  } else if (/short walk|very close|close by|قريب جدا|قريب جداً|مشي قليل|قريب مره|قريب مرة|قريب حيل|مشي شوي/.test(t)) {
    maxWalkM = 400;
    understood.push("walk");
  } else if (/walking distance|reasonable walk|مسافة مشي|مسافة معقولة|مشي معقول/.test(t)) {
    maxWalkM = 800;
    understood.push("walk");
  }

  return { destination, arrival: arrival.toISOString(), arrivalIsNow, durationHours, budgetSar, maxWalkM, understood, source: "rules" };
}

export interface Reason {
  en: string;
  ar: string;
}

export interface Recommendation {
  kind: "private" | "community";
  id: string;
  title: string;
  titleAr: string;
  location: LatLng;
  distanceM: number | null;
  priceTotal: number | null;
  score: number;
  bookable: boolean;
  guaranteed: false | "subject_to_availability";
  confidence?: ConfidenceBreakdown["level"];
  reasons: Reason[];
}

export interface RankInput {
  parsed: ParsedRequest;
  spaces: { space: ParkingSpace; bookable: boolean; freeCapacity: number; withinSchedule: boolean }[];
  signals: { report: DepartureReport; confidence: ConfidenceBreakdown }[];
  now: Date;
}

export interface RankOutput {
  results: Recommendation[];
  notes: Reason[];
}

export function rankParking({ parsed, spaces, signals, now }: RankInput): RankOutput {
  const dest = parsed.destination ? NEIGHBORHOODS.find((n) => n.id === parsed.destination)!.center : null;
  const results: Recommendation[] = [];
  const notes: Reason[] = [];

  for (const { space, bookable, freeCapacity, withinSchedule } of spaces) {
    if (!bookable) continue;
    const d = dest ? distanceM(dest, space.location) : null;
    const price = Math.round(space.pricePerHour * parsed.durationHours * 100) / 100;
    const reasons: Reason[] = [];
    if (!withinSchedule) continue; // closed at the requested time — never suggest it
    if (freeCapacity <= 0) continue;
    if (d !== null && d > parsed.maxWalkM * 2.5) continue;

    const walkScore = d === null ? 0.6 : d <= parsed.maxWalkM ? 1 - (d / parsed.maxWalkM) * 0.4 : Math.max(0, 0.5 - (d - parsed.maxWalkM) / (parsed.maxWalkM * 3));
    const priceScore = parsed.budgetSar === null ? Math.max(0, 1 - price / 60) : price <= parsed.budgetSar ? 1 - (price / Math.max(parsed.budgetSar, 1)) * 0.3 : Math.max(0, 0.3 - (price - parsed.budgetSar) / Math.max(parsed.budgetSar, 1));
    const availScore = Math.min(1, freeCapacity / 5);
    const score = Math.round((walkScore * 0.4 + priceScore * 0.35 + availScore * 0.15 + 1 * 0.1) * 100);

    if (d !== null) {
      reasons.push(
        d <= parsed.maxWalkM
          ? { en: `About ${Math.round(d)} m from your destination — within your walking range.`, ar: `على بعد حوالي ${Math.round(d)} م من وجهتك — ضمن مسافة المشي اللي حددتها.` }
          : { en: `About ${Math.round(d)} m away — a longer walk than you asked for.`, ar: `على بعد حوالي ${Math.round(d)} م — أبعد شوي من اللي طلبته.` },
      );
    }
    if (parsed.budgetSar !== null) {
      reasons.push(
        price <= parsed.budgetSar
          ? { en: `${price} SAR for ${parsed.durationHours} h, within your ${parsed.budgetSar} SAR budget.`, ar: `${price} ريال لمدة ${parsed.durationHours} ساعة، داخل ميزانيتك ${parsed.budgetSar} ريال.` }
          : { en: `${price} SAR for ${parsed.durationHours} h — above your ${parsed.budgetSar} SAR budget.`, ar: `${price} ريال لمدة ${parsed.durationHours} ساعة — فوق ميزانيتك ${parsed.budgetSar} ريال.` },
      );
    } else {
      reasons.push({ en: `${price} SAR for ${parsed.durationHours} h.`, ar: `${price} ريال لمدة ${parsed.durationHours} ساعة.` });
    }
    reasons.push({ en: `Approved private space, open at your arrival time, ${freeCapacity} of ${space.capacity} spots unbooked.`, ar: `موقف خاص معتمد، مفتوح وقت وصولك، ${freeCapacity} من ${space.capacity} فاضية.` });
    if (space.rewardEligible) reasons.push({ en: "Eligible for RAKNA KEYS parking discounts.", ar: "يقبل خصومات مفاتيح ركنة." });

    results.push({ kind: "private", id: space.id, title: space.title, titleAr: space.titleAr, location: space.location, distanceM: d === null ? null : Math.round(d), priceTotal: price, score, bookable: true, guaranteed: "subject_to_availability", reasons });
  }

  if (parsed.arrivalIsNow) {
    for (const { report, confidence } of signals) {
      if (!["available", "pending_departure"].includes(report.status)) continue;
      const d = dest ? distanceM(dest, report.location) : null;
      if (d !== null && d > parsed.maxWalkM * 2) continue;
      const confScore = confidence.score / 100;
      const walkScore = d === null ? 0.6 : Math.max(0, 1 - d / (parsed.maxWalkM * 2));
      const score = Math.round((confScore * 0.55 + walkScore * 0.35 + 0.1) * 70); // capped below private results of equal fit
      const reasons: Reason[] = [
        { en: "Community signal: another driver says they are leaving. Not a booking and not guaranteed.", ar: "إشارة مجتمعية: سائق ثاني قال إنه بيطلع. مو حجز ومو مضمونة." },
        { en: `${confidence.level[0].toUpperCase()}${confidence.level.slice(1)} confidence (${confidence.score}/100).`, ar: `ثقة ${confidence.level === "high" ? "عالية" : confidence.level === "medium" ? "متوسطة" : "منخفضة"} (${confidence.score}/100).` },
      ];
      if (d !== null) reasons.push({ en: `About ${Math.round(d)} m from your destination.`, ar: `على بعد حوالي ${Math.round(d)} م من وجهتك.` });
      results.push({ kind: "community", id: report.id, title: "Community parking signal", titleAr: "إشارة موقف مجتمعية", location: report.location, distanceM: d === null ? null : Math.round(d), priceTotal: null, score, bookable: false, guaranteed: false, confidence: confidence.level, reasons });
    }
  } else {
    notes.push({
      en: "Community signals last about 20 minutes, so they can't be planned ahead. Check the map when you're close to arrival.",
      ar: "الإشارات المجتمعية تدوم حوالي 20 دقيقة بس، فما ينفع تخطط لها من بدري. شيّك الخريطة إذا قربت توصل.",
    });
  }

  if (!parsed.destination) {
    notes.push({ en: "No destination recognized — results are ranked by price and availability across Riyadh.", ar: "ما عرفنا الوجهة — رتّبنا النتايج حسب السعر والتوفر في الرياض." });
  }
  const { hour } = riyadhParts(new Date(parsed.arrival));
  if (results.length === 0) {
    notes.push({ en: `No approved space matches at ${String(hour).padStart(2, "0")}:00 with these preferences. Try a longer walk or a different time.`, ar: `ما فيه مواقف معتمدة تناسب الساعة ${hour} بهذي التفضيلات. جرّب مسافة مشي أطول أو وقت ثاني.` });
  }
  void now;
  results.sort((a, b) => b.score - a.score);
  return { results: results.slice(0, 6), notes };
}
