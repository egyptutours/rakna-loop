"use client";

import Link from "next/link";
import { useState } from "react";
import { Accessibility, Building2, Hexagon, Search, TrainFront } from "lucide-react";
import { useApp } from "./providers";
import { Button, Pill, cn } from "./ui";
import { api } from "@/lib/client/api";
import { HIVE_STATE_STYLE, HIVE_STATES } from "@/lib/hive/hive-map";
import type { CellSummary } from "@/lib/hive/aggregation";
import type { RecruitmentResult, ActivityRole } from "@/lib/hive/swarm";
import type { HiveState, LatLng } from "@/lib/types";
import { fmtSar } from "@/lib/client/format";

const ROLE: Record<ActivityRole, { en: string; ar: string; descEn: string; descAr: string }> = {
  scout: { en: "Scout", ar: "كشّاف", descEn: "You shared a parking opportunity.", descAr: "شاركت فرصة موقف." },
  forager: { en: "Forager", ar: "باحث", descEn: "You're looking for parking.", descAr: "أنت تبحث عن موقف." },
  verifier: { en: "Verifier", ar: "مُتحقق", descEn: "Confirm the outcome when you arrive.", descAr: "أكّد النتيجة عند وصولك." },
  steward: { en: "Hive steward", ar: "راعي الخلية", descEn: "You maintain local parking resources.", descAr: "أنت ترعى موارد المواقف المحلية." },
};

export function HiveStateChip({ state }: { state: HiveState }) {
  const { lang } = useApp();
  const s = HIVE_STATE_STYLE[state];
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold" style={{ borderColor: s.line, color: s.line, background: `${s.fill}22` }}>
      <Hexagon className="h-3 w-3" style={{ fill: s.fill, stroke: s.line }} aria-hidden />
      {lang === "ar" ? s.ar : s.en}
    </span>
  );
}

export function HiveLegend({ compact }: { compact?: boolean }) {
  const { lang } = useApp();
  return (
    <ul className={cn("space-y-1", compact && "text-[11px]")}>
      {HIVE_STATES.map((k) => {
        const s = HIVE_STATE_STYLE[k];
        return (
          <li key={k} className="flex items-center gap-2">
            <Hexagon className="h-3.5 w-3.5 shrink-0" style={{ fill: s.fill, stroke: s.line }} aria-hidden />
            <span>{lang === "ar" ? `${s.ar} — ${s.descAr}` : `${s.en} — ${s.descEn}`}</span>
          </li>
        );
      })}
    </ul>
  );
}

export function HivePanel({ focus, role, searchAt, isDriver }: { focus: (CellSummary & { center: LatLng }) | null; role: ActivityRole | null; searchAt: LatLng; isDriver: boolean }) {
  const { L, B, lang, toast, errorText } = useApp();
  const [busy, setBusy] = useState(false);
  const [accessible, setAccessible] = useState(false);
  const [res, setRes] = useState<(RecruitmentResult & { role: ActivityRole }) | null>(null);

  const forage = async () => {
    setBusy(true);
    try {
      setRes(await api<RecruitmentResult & { role: ActivityRole }>("/api/hive/demand", { body: { location: searchAt, accessibleOnly: accessible } }));
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const r = role ? ROLE[role] : null;
  return (
    <div className="rounded-[var(--radius-card)] border border-gold/30 bg-gradient-to-b from-gold-soft/60 to-card p-4 shadow-[var(--shadow-soft)]">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-sm font-bold text-forest"><Hexagon className="h-4 w-4 fill-gold/30 text-gold" aria-hidden />{L("Local hive", "الخلية المحلية")}</p>
        {focus && <HiveStateChip state={focus.state} />}
      </div>
      {r && <p className="mt-1 text-[11px] text-mute">{L("Your role now", "دورك الآن")}: <strong className="text-ink">{lang === "ar" ? r.ar : r.en}</strong> — {lang === "ar" ? r.descAr : r.descEn}</p>}
      {focus && (
        <dl className="mt-3 grid grid-cols-3 gap-2 text-center">
          <div className="rounded-xl bg-card p-2"><dt className="text-[10px] text-mute">{L("Live signals", "إشارات حية")}</dt><dd className="num text-base font-bold text-signal">{focus.supply.signals}</dd></div>
          <div className="rounded-xl bg-card p-2"><dt className="text-[10px] text-mute">{L("Searches/h", "بحث/ساعة")}</dt><dd className="num text-base font-bold text-warn">{focus.demand.searches}</dd></div>
          <div className="rounded-xl bg-card p-2"><dt className="text-[10px] text-mute">{L("Found rate", "نسبة النجاح")}</dt><dd className="num text-base font-bold text-private">{focus.trail.samples >= 1 ? `${Math.round(focus.trail.score * 100)}%` : "—"}</dd></div>
        </dl>
      )}
      {focus && focus.supply.privateFree > 0 && <p className="mt-2 text-[11px] text-mute">{L(`${focus.supply.privateFree} private bays free in approved spaces nearby.`, `${focus.supply.privateFree} موقفًا خاصًا متاحًا في مواقف معتمدة قريبة.`)}</p>}

      {isDriver && (
        <div className="mt-3 space-y-2">
          <label className="flex items-center gap-2 text-xs text-ink-2">
            <input type="checkbox" checked={accessible} onChange={(e) => setAccessible(e.target.checked)} className="h-4 w-4" />
            <Accessibility className="h-3.5 w-3.5" aria-hidden />{L("I need an accessible bay", "أحتاج موقفًا لذوي الإعاقة")}
          </label>
          <Button variant="secondary" size="sm" className="w-full" onClick={forage} loading={busy}>
            <Search className="h-4 w-4" aria-hidden />{L("I'm looking for parking here", "أبحث عن موقف هنا")}
          </Button>
          <p className="text-[10px] leading-snug text-mute">{L("Adds one anonymous search to this hive's demand (no name or exact location stored).", "يضيف طلب بحث واحدًا مجهول الهوية لطلب هذه الخلية (دون اسم أو موقع دقيق).")}</p>
        </div>
      )}

      {res && (
        <div className="mt-3 space-y-2 border-t border-line pt-3">
          {res.advice.map((a, i) => <p key={i} className="text-[11px] leading-snug text-ink-2">{B(a)}</p>)}
          {res.opportunities.length > 0 && <p className="text-xs font-semibold">{L("Nearby community signals", "إشارات مجتمعية قريبة")}</p>}
          {res.opportunities.map((o) => (
            <Link key={o.signal.id} href={`/reports/${o.signal.id}`} className="block rounded-xl border border-signal/20 bg-card p-2.5 text-xs hover:border-signal/50">
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-signal">{o.distanceM} {L("m", "م")} · {L(`ring ${o.ring}`, `حلقة ${o.ring}`)}</span>
                <Pill tone="signal"><span className="num">{Math.round(o.signal.strength * 100)}%</span> {L("strength", "قوة")}</Pill>
              </div>
              <p className="mt-1 leading-snug text-ink-2">{B(o.signal.explanation)}</p>
            </Link>
          ))}
          {res.neighborAlternatives.length > 0 && (
            <div className="rounded-xl bg-sage-mist p-2.5 text-[11px]">
              <p className="mb-1 font-semibold">{L("Neighboring hives with spare supply", "خلايا مجاورة فيها فائض")}</p>
              <div className="flex flex-wrap gap-1">{res.neighborAlternatives.map((n) => <HiveStateChip key={n.cell} state={n.state} />)}</div>
            </div>
          )}
          {res.privateAlternatives.map((p) => (
            <Link key={p.id} href={`/parking?space=${p.id}`} className="flex items-start gap-2 rounded-xl border border-private/20 bg-card p-2.5 text-xs hover:border-private/50">
              <Building2 className="mt-0.5 h-4 w-4 shrink-0 text-private" aria-hidden />
              <span><strong>{lang === "ar" ? p.titleAr : p.title}</strong> · {fmtSar(p.pricePerHour, lang)}/{L("h", "س")}<br /><span className="text-mute">{B(p.reason)}</span></span>
            </Link>
          ))}
          {res.transitAlternatives.map((t) => (
            <div key={t.name} className="flex items-start gap-2 rounded-xl border border-line bg-card p-2.5 text-xs">
              <TrainFront className="mt-0.5 h-4 w-4 shrink-0 text-forest" aria-hidden />
              <span>{lang === "ar" ? t.nameAr : t.name} · <span className="num">{t.distanceM} m</span><br /><span className="text-mute">{L("Illustrative demo point — no live transit data.", "نقطة توضيحية تجريبية — لا بيانات نقل حية.")}</span></span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
