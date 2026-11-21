/**
 * PII stripping before any text leaves for an external AI provider (blocker: data
 * minimisation, PDPL). The assistant only needs destination, time, duration, budget and
 * walking distance — never contact details, identity numbers, plates or payment data.
 *
 * Arabic-Indic digits (٠-٩) are normalised first so the patterns also catch them.
 * Replacements are typed placeholders, so the model still understands the sentence.
 */

const ARABIC_DIGITS = /[٠-٩۰-۹]/g;

function normaliseDigits(s: string): string {
  return s.replace(ARABIC_DIGITS, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d) >= 0 ? "٠١٢٣٤٥٦٧٨٩".indexOf(d) : "۰۱۲۳۴۵۶۷۸۹".indexOf(d)));
}

const RULES: [RegExp, string][] = [
  [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]"],
  // Saudi IBAN: SA + 22 digits (spaces allowed)
  [/\bSA\d{2}(?:\s?\d{4}){5}\b/gi, "[iban]"],
  // Payment cards: 13–19 digits, optional spaces/dashes
  [/\b(?:\d[ -]?){12,18}\d\b/g, "[card]"],
  // Saudi phone numbers: +966 / 00966 / 05x…
  [/(?:\+|00)966[\s-]?5\d(?:[\s-]?\d){7}\b/g, "[phone]"],
  [/\b05\d(?:[\s-]?\d){7}\b/g, "[phone]"],
  // National ID / Iqama: 10 digits starting with 1 or 2
  [/\b[12]\d{9}\b/g, "[id]"],
  // Vehicle plates: 3 uppercase Latin letters + 1–4 digits (either order; currency codes excluded),
  // or 3 space-separated Arabic letters + 1–4 digits (a plain word + number is NOT a plate).
  [/\b(?!(?:SAR|USD|AED|EUR|GBP)\b)[A-Z]{3}\s?\d{1,4}\b/g, "[plate]"],
  [/\b\d{1,4}\s?(?!(?:SAR|USD|AED|EUR|GBP)\b)[A-Z]{3}\b/g, "[plate]"],
  [/(?<![ء-ي])[ء-ي]\s[ء-ي]\s[ء-ي]\s?\d{1,4}(?!\d)/g, "[plate]"],
  [/(?<!\d)\d{1,4}\s?[ء-ي]\s[ء-ي]\s[ء-ي](?![ء-ي])/g, "[plate]"],
];

export function stripPii(text: string): { text: string; redactions: number } {
  let out = normaliseDigits(text);
  let redactions = 0;
  for (const [re, label] of RULES) {
    out = out.replace(re, () => {
      redactions++;
      return label;
    });
  }
  return { text: out, redactions };
}
