"use client";

import { useCallback, useEffect, useState } from "react";
import { Hexagon, RefreshCw } from "lucide-react";
import { useApp } from "./providers";
import { Button, Card, Notice, Stat, cn, inputCls } from "./ui";
import { HiveLegend } from "./hive-panel";
import { api } from "@/lib/client/api";
import type { HiveConfig } from "@/lib/types";

interface Metrics {
  successfulHandoffs: number;
  unsuccessfulSearches: number;
  successRate: number | null;
  medianMinutesClaimToFind: number | null;
  privateUtilization7d: number;
  sustainableMissionsApproved: number;
  satisfaction: { helpful: number; notHelpful: number; percent: number | null };
  dataVolume: { reports: number; spaces: number; cellStats: number; demand: number };
  lifecycle: { lastSuccessAt: string | null; overdue: boolean; failuresInLast5: number; lastRuns: { startedAt: string; ok: boolean | null; error: string | null }[] };
}

const FIELDS: { key: keyof HiveConfig; en: string; ar: string; unit: string }[] = [
  { key: "signalHalfLifeMinutes", en: "Signal half-life", ar: "عمر النصف للإشارة", unit: "min" },
  { key: "trailHalfLifeDays", en: "Trail evaporation half-life", ar: "عمر النصف لتبخر الأثر", unit: "d" },
  { key: "demandWindowMinutes", en: "Demand window", ar: "نافذة الطلب", unit: "min" },
  { key: "aggregateAfterMinutes", en: "Aggregate temporary data after", ar: "تجميع البيانات المؤقتة بعد", unit: "min" },
  { key: "reportRetentionDays", en: "Delete aggregated reports after", ar: "حذف البلاغات المجمّعة بعد", unit: "d" },
  { key: "claimRetentionHours", en: "Delete inactive claims after", ar: "حذف التوجّهات اللي مو شغّالة بعد", unit: "h" },
  { key: "statsRetentionDays", en: "Keep aggregate stats", ar: "مدة الاحتفاظ بالإحصاءات المجمّعة", unit: "d" },
  { key: "maxCellsPerQuery", en: "Max cells per map query", ar: "أقصى عدد خلايا لكل استعلام", unit: "" },
  { key: "maxSignalsPerPage", en: "Max signals per page", ar: "أقصى عدد إشارات لكل صفحة", unit: "" },
  { key: "recruitmentMaxRings", en: "Neighbor search rings", ar: "حلقات البحث المجاورة", unit: "k" },
  { key: "perCellDiversityCap", en: "Fairness cap per hive", ar: "سقف العدالة لكل خلية", unit: "" },
  { key: "cacheTtlSeconds", en: "Cell summary cache", ar: "ذاكرة ملخص الخلايا", unit: "s" },
];

export function HiveAdmin() {
  const { L, B, session, toast, errorText } = useApp();
  const [m, setM] = useState<Metrics | null>(null);
  const [cfg, setCfg] = useState<HiveConfig | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState<Record<string, number | string> | null>(null);

  const load = useCallback(async () => {
    const d = await api<{ metrics: Metrics; config: HiveConfig }>("/api/hive/metrics");
    setM(d.metrics);
    setCfg(d.config);
  }, []);
  useEffect(() => {
    load().catch((e) => toast(errorText(e), "error"));
  }, [load, toast, errorText]);

  if (!m || !cfg) return null;
  const act = async (k: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(k);
    try {
      const r = await fn();
      if (k === "life") setLastRun(r as Record<string, number | string>);
      toast(ok, "ok");
      await load();
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-6">
      <section>
        <h2 className="mb-3 text-sm font-bold">{L("Mobility outcomes (measured, last 7 days)", "نتائج التنقل (مقاسة، آخر 7 أيام)")}</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <Stat label={L("Successful handoffs", "تسليمات ناجحة")} value={m.successfulHandoffs} tone="private" />
          <Stat label={L("Unsuccessful searches", "محاولات بحث ما نجحت")} value={m.unsuccessfulSearches} tone="danger" />
          <Stat label={L("Success rate", "نسبة النجاح")} value={m.successRate === null ? "—" : `${m.successRate}%`} />
          <Stat label={L("Median claim → find", "الوسيط من التوجه للعثور")} value={m.medianMinutesClaimToFind === null ? "—" : `${m.medianMinutesClaimToFind} min`} />
          <Stat label={L("Private utilization", "استخدام المواقف الخاصة")} value={`${m.privateUtilization7d}%`} tone="gold" />
          <Stat label={L("Helpful feedback", "تقييم مفيد")} value={m.satisfaction.percent === null ? "—" : `${m.satisfaction.percent}%`} tone="signal" />
        </div>
        <p className="mt-2 text-[11px] text-mute">{L("Search time saved needs a measured baseline (survey or control group), so it is not estimated here. No citywide traffic claims are made.", "حساب الوقت اللي توفّر يحتاج خط أساس مقاس (استبيان أو مجموعة مقارنة)، فما نقدّره هنا. وما ندّعي إننا خففنا الزحمة على مستوى المدينة.")} · {L("Sustainable missions approved", "مهام تنقل مستدام معتمدة")}: <span className="num">{m.sustainableMissionsApproved}</span></p>
      </section>

      <section className="grid gap-4 lg:grid-cols-[1fr_1.4fr]">
        <Card>
          <h2 className="mb-3 flex items-center gap-2 font-bold"><Hexagon className="h-5 w-5 fill-gold/30 text-gold" aria-hidden />{L("Data lifecycle", "دورة حياة البيانات")}</h2>
          <dl className="grid grid-cols-2 gap-2 text-sm">
            <div className="rounded-xl bg-sage-mist p-3"><dt className="text-xs text-mute">{L("Temporary reports", "بلاغات مؤقتة")}</dt><dd className="num text-xl font-bold">{m.dataVolume.reports}</dd></div>
            <div className="rounded-xl bg-sage-mist p-3"><dt className="text-xs text-mute">{L("Aggregate cell buckets", "حاويات الخلايا المجمعة")}</dt><dd className="num text-xl font-bold">{m.dataVolume.cellStats}</dd></div>
            <div className="rounded-xl bg-sage-mist p-3"><dt className="text-xs text-mute">{L("Demand buckets", "حاويات الطلب")}</dt><dd className="num text-xl font-bold">{m.dataVolume.demand}</dd></div>
            <div className="rounded-xl bg-sage-mist p-3"><dt className="text-xs text-mute">{L("Private spaces (durable)", "مواقف خاصة (دائمة)")}</dt><dd className="num text-xl font-bold">{m.dataVolume.spaces}</dd></div>
          </dl>
          <div className={cn("mt-3 rounded-xl p-3 text-xs", m.lifecycle.overdue || m.lifecycle.failuresInLast5 > 0 ? "bg-danger-soft text-danger" : "bg-private-soft text-private")}>
            <p className="font-semibold">
              {m.lifecycle.overdue ? L("Lifecycle job overdue — check the schedule", "مهمة دورة الحياة متأخرة — تأكد من الجدولة") : L("Lifecycle job healthy", "مهمة دورة الحياة سليمة")}
            </p>
            <p className="mt-0.5">
              {L("Last success", "آخر نجاح")}: <span className="num">{m.lifecycle.lastSuccessAt ? new Date(m.lifecycle.lastSuccessAt).toLocaleString() : "—"}</span> · {L("failures in last 5 runs", "إخفاقات في آخر 5 تشغيلات")}: <span className="num">{m.lifecycle.failuresInLast5}</span>
            </p>
          </div>
          <p className="mt-3 text-[11px] leading-relaxed text-mute">{L("Production: scheduled by pg_cron every 5 minutes inside the database (migration 0006) and logged in hive_job_runs. Demo: runs opportunistically on map reads. Ledger, bookings, redemptions and audit logs are never touched.", "الإنتاج: مجدولة عبر pg_cron كل 5 دقايق داخل قاعدة البيانات (الترحيل 0006) ومسجلة في hive_job_runs. التجريبي: تشتغل لما تنقرأ الخريطة. ما تلمس السجل ولا الحجوزات ولا الاستبدالات ولا سجلات التدقيق.")}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" loading={busy === "life"} onClick={() => act("life", () => api("/api/admin", { body: { action: "hive_lifecycle" } }), L("Lifecycle completed.", "خلصت دورة الحياة."))}><RefreshCw className="h-4 w-4" aria-hidden />{L("Run lifecycle now", "شغّلها الحين")}</Button>
            {session?.demoMode && (
              <Button size="sm" variant="gold" loading={busy === "demand"} onClick={() => act("demand", () => api("/api/demo", { body: { action: "simulate_demand" } }), L("Demo demand added.", "انضاف طلب تجريبي."))}>{L("Demo: simulate search demand", "تجريبي: سوّ طلب بحث محاكى")}</Button>
            )}
          </div>
          {lastRun && <pre className="mt-3 overflow-x-auto rounded-xl bg-ink p-3 text-[11px] text-sage-soft" dir="ltr">{JSON.stringify(lastRun, null, 1)}</pre>}
        </Card>

        <Card>
          <h2 className="mb-3 font-bold">{L("Hive configuration", "إعدادات الخلايا")}</h2>
          <Notice tone="info">{L("Starting points, not fixed assumptions. Tune with real usage; every change is audited.", "قيم مبدئية وليست ثابتة. اضبطها حسب الاستخدام الفعلي؛ كل تغيير ينسجّل.")}</Notice>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {FIELDS.map((f) => (
              <label key={f.key} className="flex items-center justify-between gap-2 rounded-xl border border-line p-2.5 text-xs">
                <span>{L(f.en, f.ar)}</span>
                <span className="flex items-center gap-1">
                  <input type="number" step="any" className={cn(inputCls, "h-8 w-20 text-center")} value={cfg[f.key] as number} onChange={(e) => setCfg({ ...cfg, [f.key]: Number(e.target.value) })} />
                  <span className="w-6 text-mute">{f.unit}</span>
                </span>
              </label>
            ))}
            {(["highDemandRatio", "overloadedRatio", "resourceRichRatio", "quietMaxActivity"] as const).map((k) => (
              <label key={k} className="flex items-center justify-between gap-2 rounded-xl border border-gold/30 p-2.5 text-xs">
                <span>{B({ highDemandRatio: { en: "High-demand ratio ≥", ar: "نسبة الطلب المرتفع ≥" }, overloadedRatio: { en: "Overloaded ratio ≥", ar: "نسبة الازدحام ≥" }, resourceRichRatio: { en: "Resource-rich ratio ≤", ar: "نسبة الوفرة ≤" }, quietMaxActivity: { en: "Quiet if activity ≤", ar: "هادئة إذا النشاط ≤" } }[k])}</span>
                <input type="number" step="any" className={cn(inputCls, "h-8 w-20 text-center")} value={cfg.states[k]} onChange={(e) => setCfg({ ...cfg, states: { ...cfg.states, [k]: Number(e.target.value) } })} />
              </label>
            ))}
          </div>
          <Button className="mt-3" size="sm" loading={busy === "cfg"} onClick={() => act("cfg", () => api("/api/admin", { body: { action: "hive_config", config: { ...Object.fromEntries(FIELDS.map((f) => [f.key, cfg[f.key]])), states: cfg.states } } }), L("Hive configuration saved.", "انحفظت إعدادات الخلايا."))}>{L("Save hive configuration", "احفظ الإعدادات")}</Button>
          <div className="mt-4 border-t border-line pt-3 text-xs"><HiveLegend compact /></div>
        </Card>
      </section>
    </div>
  );
}
