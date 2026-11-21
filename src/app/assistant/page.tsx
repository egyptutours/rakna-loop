"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Bot, Building2, Radio, Send, Sparkles } from "lucide-react";
import { useApp } from "@/components/providers";
import { Button, Card, Disclaimer, Notice, PageHeader, Pill, Skeleton, cn } from "@/components/ui";
import { api } from "@/lib/client/api";
import { fmtDateTime, fmtSar } from "@/lib/client/format";
import { CONFIDENCE_LABEL, NEIGHBORHOOD_LABEL } from "@/lib/i18n";
import type { ParsedRequest, Reason, Recommendation } from "@/lib/domain/recommend";

interface AssistantResult {
  parsed: ParsedRequest;
  results: Recommendation[];
  notes: Reason[];
  engine: "ai" | "rules";
  aiConfigured: boolean;
  aiError: string | null;
}

const EXAMPLES = [
  { en: "I need parking near Al Olaya at 9 AM for two hours, within a reasonable walking distance and a budget of 20 SAR.", ar: "أحتاج موقفًا قرب العليا الساعة 9 صباحًا لمدة ساعتين، ضمن مسافة مشي معقولة وميزانية 20 ريال." },
  { en: "Parking on King Fahd Road now for 1 hour, very close", ar: "موقف على طريق الملك فهد الآن لمدة ساعة، قريب جدًا" },
  { en: "Somewhere in Al Wurud tomorrow at 10:30 am for 3 hours under 25 SAR", ar: "مكان في الورود بكرة الساعة 10:30 صباحًا لمدة 3 ساعات بأقل من 25 ريال" },
];

/** AI Parking Assistant — natural language in Arabic or English. */
export default function AssistantPage() {
  return (
    <Suspense fallback={<Skeleton className="h-96" />}>
      <Assistant />
    </Suspense>
  );
}

function Assistant() {
  const { L, B, lang, session, toast, errorText } = useApp();
  const params = useSearchParams();
  const [q, setQ] = useState(params.get("q") ?? "");
  const [res, setRes] = useState<AssistantResult | null>(null);
  const [busy, setBusy] = useState(false);

  const ask = async (text = q) => {
    if (text.trim().length < 3) return;
    setBusy(true);
    try {
      setRes(await api<AssistantResult>("/api/assistant", { body: { query: text.trim() } }));
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (params.get("q")) void ask(params.get("q")!);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const chip = (label: string, value: string, recognized: boolean) => (
    <span className={cn("rounded-full px-3 py-1 text-xs", recognized ? "bg-forest text-white" : "bg-sage-mist text-mute")}>
      {label}: <strong className="font-semibold">{value}</strong>
    </span>
  );

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader eyebrow={L("AI parking assistant", "مساعد المواقف الذكي")} title={L("Where do you need to park?", "أين تحتاج أن تركن؟")} subtitle={L("Ask in Arabic or English. Results come only from approved listings and live community signals — never invented availability.", "اسأل بالعربية أو الإنجليزية. النتائج من المواقف المعتمدة والإشارات المجتمعية الحية فقط — دون اختلاق التوفر.")}>
        {session && <Pill tone={session.aiEnabled ? "forest" : "neutral"}>{session.aiEnabled ? <><Sparkles className="h-3 w-3" aria-hidden />{L("Claude-assisted understanding", "فهم مدعوم بـ Claude")}</> : <><Bot className="h-3 w-3" aria-hidden />{L("Rule-based engine (no AI key)", "محرك قواعد (بدون مفتاح ذكاء اصطناعي)")}</>}</Pill>}
      </PageHeader>

      <Card className="p-3">
        <form onSubmit={(e) => { e.preventDefault(); void ask(); }} className="flex flex-col gap-2 sm:flex-row">
          <textarea value={q} onChange={(e) => setQ(e.target.value)} rows={2} maxLength={1000} placeholder={L("e.g. Parking near Al Olaya at 9 AM for 2 hours, budget 20 SAR", "مثال: موقف قرب العليا الساعة 9 صباحًا لمدة ساعتين، ميزانية 20 ريال")} className="min-h-[3.5rem] flex-1 resize-none rounded-xl bg-sage-mist px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-sage" aria-label={L("Your parking request", "طلبك")} />
          <Button type="submit" size="lg" loading={busy} className="sm:w-36"><Send className="h-4 w-4" aria-hidden />{L("Ask", "اسأل")}</Button>
        </form>
        <div className="mt-3 flex flex-wrap gap-2">
          {EXAMPLES.map((ex, i) => (
            <button key={i} onClick={() => { const t = lang === "ar" ? ex.ar : ex.en; setQ(t); void ask(t); }} className="rounded-full border border-line bg-card px-3 py-1.5 text-start text-xs text-ink-2 hover:border-forest-3">
              {lang === "ar" ? ex.ar : ex.en}
            </button>
          ))}
        </div>
      </Card>

      {res && (
        <div className="mt-6 space-y-4">
          <div className="flex flex-wrap gap-2">
            {chip(L("Destination", "الوجهة"), res.parsed.destination ? B(NEIGHBORHOOD_LABEL[res.parsed.destination]) : L("Any", "أي مكان"), res.parsed.understood.includes("destination"))}
            {chip(L("Arrival", "الوصول"), res.parsed.arrivalIsNow ? L("Now", "الآن") : fmtDateTime(res.parsed.arrival, lang), res.parsed.understood.includes("arrival"))}
            {chip(L("Duration", "المدة"), `${res.parsed.durationHours} ${L("h", "س")}`, res.parsed.understood.includes("duration"))}
            {chip(L("Budget", "الميزانية"), res.parsed.budgetSar !== null ? fmtSar(res.parsed.budgetSar, lang) : L("Not set", "غير محددة"), res.parsed.understood.includes("budget"))}
            {chip(L("Walking", "المشي"), `≤ ${res.parsed.maxWalkM} m`, res.parsed.understood.includes("walk"))}
            <Pill tone={res.engine === "ai" ? "forest" : "neutral"}>{res.engine === "ai" ? L("Understood by Claude", "فهمه Claude") : L("Understood by rules", "فهمته القواعد")}</Pill>
          </div>
          {res.aiConfigured && res.engine === "rules" && <Notice tone="info">{L("The AI service was unavailable, so the deterministic engine handled this request.", "خدمة الذكاء الاصطناعي غير متاحة، لذا عالج المحرك القائم على القواعد هذا الطلب.")}</Notice>}
          {res.notes.map((n, i) => <Notice key={i} tone="info">{B(n)}</Notice>)}

          {res.results.map((r, i) => (
            <Card key={r.id} className={cn(r.kind === "private" ? "border-private/20" : "border-signal/20")}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex items-start gap-3">
                  <span className={cn("num grid h-9 w-9 shrink-0 place-items-center rounded-full text-sm font-bold text-white", r.kind === "private" ? "bg-private" : "bg-signal")}>{i + 1}</span>
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      {r.kind === "private" ? <Pill tone="private"><Building2 className="h-3 w-3" aria-hidden />{L("Bookable private space", "موقف خاص قابل للحجز")}</Pill> : <Pill tone="signal"><Radio className="h-3 w-3" aria-hidden />{L("Community signal — not guaranteed", "إشارة مجتمعية — غير مضمونة")}</Pill>}
                      {r.confidence && <Pill>{B(CONFIDENCE_LABEL[r.confidence])}</Pill>}
                    </div>
                    <h3 className="mt-2 font-bold">{lang === "ar" ? r.titleAr : r.title}</h3>
                  </div>
                </div>
                <div className="text-end">
                  {r.priceTotal !== null && <p className="text-lg font-bold text-forest">{fmtSar(r.priceTotal, lang)}</p>}
                  <p className="num text-xs text-mute">{L("match", "التطابق")} {r.score}</p>
                </div>
              </div>
              <ul className="mt-3 space-y-1.5 text-sm text-ink-2">
                {r.reasons.map((x, j) => <li key={j} className="flex gap-2"><span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-forest-3" aria-hidden />{B(x)}</li>)}
              </ul>
              <div className="mt-4">
                {r.kind === "private" ? (
                  <Link href={`/parking?space=${r.id}`} className="inline-flex h-10 items-center rounded-xl bg-private px-4 text-sm font-semibold text-white">{L("Book (subject to availability)", "احجز (حسب التوفر)")}</Link>
                ) : (
                  <Link href={`/reports/${r.id}`} className="inline-flex h-10 items-center rounded-xl bg-signal px-4 text-sm font-semibold text-white">{L("View signal", "عرض الإشارة")}</Link>
                )}
              </div>
            </Card>
          ))}
          <Disclaimer />
        </div>
      )}
    </div>
  );
}
