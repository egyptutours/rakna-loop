"use client";

import { Plus, Trash2 } from "lucide-react";
import { useApp } from "./providers";
import { Button, cn, inputCls } from "./ui";
import { minutesLabel } from "./home-ui";
import { DAY_SHORT } from "@/lib/i18n";

/** Editable weekly availability rule. Money is entered in SAR and stored as integer halalas. */
export interface RuleDraft {
  weekdayMask: number;
  startMinute: number;
  endMinute: number;
  hourlyRateHalalas: number;
  dailyCapHalalas: number | null;
  multiDayDiscountBps: number;
}

/** Only the editable fields (stored rules also carry id/spaceId/isActive/createdAt, which the API rejects). */
export function toDraft(r: RuleDraft): RuleDraft {
  return { weekdayMask: r.weekdayMask, startMinute: r.startMinute, endMinute: r.endMinute, hourlyRateHalalas: r.hourlyRateHalalas, dailyCapHalalas: r.dailyCapHalalas, multiDayDiscountBps: r.multiDayDiscountBps };
}

export const DEFAULT_RULE: RuleDraft = { weekdayMask: 31, startMinute: 7 * 60, endMinute: 18 * 60, hourlyRateHalalas: 600, dailyCapHalalas: 4000, multiDayDiscountBps: 1000 };

const toMinutes = (v: string) => {
  const [h, m] = v.split(":").map(Number);
  return h * 60 + m;
};
const sarToHalalas = (v: string) => Math.round(Number(v) * 100);

export function validRule(r: RuleDraft): boolean {
  return r.weekdayMask >= 1 && r.weekdayMask <= 127 && r.endMinute > r.startMinute && r.hourlyRateHalalas > 0 && r.hourlyRateHalalas <= 100_000 && (r.dailyCapHalalas === null || r.dailyCapHalalas > 0);
}

export function RuleEditor({ rules, onChange }: { rules: RuleDraft[]; onChange: (r: RuleDraft[]) => void }) {
  const { L, B } = useApp();
  const set = (i: number, patch: Partial<RuleDraft>) => onChange(rules.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="space-y-3">
      {rules.map((r, i) => (
        <fieldset key={i} className={cn("space-y-3 rounded-2xl border p-3", validRule(r) ? "border-line" : "border-danger/40")}>
          <legend className="px-1 text-xs font-semibold text-mute">{L(`Rule ${i + 1}`, `القاعدة ${i + 1}`)}</legend>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label={L("Days", "الأيام")}>
            {DAY_SHORT.map((d, day) => {
              const on = (r.weekdayMask & (1 << day)) !== 0;
              return (
                <button
                  key={day}
                  type="button"
                  aria-pressed={on}
                  onClick={() => set(i, { weekdayMask: r.weekdayMask ^ (1 << day) })}
                  className={cn("h-8 rounded-lg border px-2.5 text-xs font-semibold", on ? "border-forest bg-forest text-white" : "border-line bg-card text-ink-2")}
                >
                  {B(d)}
                </button>
              );
            })}
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            <label className="text-xs text-mute">
              {L("From", "من")}
              <input type="time" step={900} dir="ltr" className={inputCls} value={minutesLabel(r.startMinute)} onChange={(e) => set(i, { startMinute: toMinutes(e.target.value) })} />
            </label>
            <label className="text-xs text-mute">
              {L("To", "إلى")}
              <input type="time" step={900} dir="ltr" className={inputCls} value={r.endMinute === 1440 ? "23:59" : minutesLabel(r.endMinute)} onChange={(e) => set(i, { endMinute: e.target.value === "23:59" ? 1440 : toMinutes(e.target.value) })} />
            </label>
            <label className="text-xs text-mute">
              {L("SAR / hour", "ريال / ساعة")}
              <input type="number" min={0.5} step={0.5} dir="ltr" className={inputCls} value={r.hourlyRateHalalas / 100} onChange={(e) => set(i, { hourlyRateHalalas: sarToHalalas(e.target.value) })} />
            </label>
            <label className="text-xs text-mute">
              {L("Daily cap (SAR)", "حد يومي (ريال)")}
              <input type="number" min={0} step={1} dir="ltr" className={inputCls} value={r.dailyCapHalalas === null ? "" : r.dailyCapHalalas / 100} onChange={(e) => set(i, { dailyCapHalalas: e.target.value === "" ? null : sarToHalalas(e.target.value) })} />
            </label>
            <label className="text-xs text-mute">
              {L("5+ day discount %", "خصم ٥ أيام+ %")}
              <input type="number" min={0} max={50} step={1} dir="ltr" className={inputCls} value={r.multiDayDiscountBps / 100} onChange={(e) => set(i, { multiDayDiscountBps: Math.round(Number(e.target.value) * 100) })} />
            </label>
          </div>
          {rules.length > 1 && (
            <Button type="button" size="sm" variant="ghost" onClick={() => onChange(rules.filter((_, j) => j !== i))}>
              <Trash2 className="h-4 w-4" aria-hidden />
              {L("Remove rule", "احذف القاعدة")}
            </Button>
          )}
        </fieldset>
      ))}
      {rules.length < 14 && (
        <Button type="button" size="sm" variant="secondary" onClick={() => onChange([...rules, { ...DEFAULT_RULE, weekdayMask: 96, startMinute: 0, endMinute: 1440 }])}>
          <Plus className="h-4 w-4" aria-hidden />
          {L("Add rule (e.g. weekends)", "أضف قاعدة (مثل الويكند)")}
        </Button>
      )}
    </div>
  );
}
