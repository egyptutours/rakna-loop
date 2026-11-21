"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Clock, DoorOpen, ShieldCheck } from "lucide-react";
import { useApp } from "@/components/providers";
import { LocationPicker, offset, type Evidence, type SimPreset } from "@/components/location-picker";
import { Button, ButtonLink, Card, Disclaimer, Notice, PageHeader, cn, inputCls } from "@/components/ui";
import { api } from "@/lib/client/api";
import { NEIGHBORHOODS } from "@/lib/config";
import type { ReportView } from "@/lib/api/views";

/** SCREEN 3 — Report a parking departure ("I'm Leaving"). */
export default function ReportDeparture() {
  const { L, session, toast, errorText } = useApp();
  const router = useRouter();
  const [ev, setEv] = useState<Evidence | null>(null);
  const [departIn, setDepartIn] = useState<0 | 2 | 5 | 10>(0);
  const [note, setNote] = useState("");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState<ReportView | null>(null);

  useEffect(() => {
    if (session?.user?.role !== "driver") return;
    api<{ reports: ReportView[] }>("/api/reports")
      .then((d) => setActive(d.reports.find((r) => ["available", "pending_departure", "claimed"].includes(r.status)) ?? null))
      .catch(() => {});
  }, [session?.user?.id, session?.user?.role]);

  // Demo positions near the four sample neighborhoods (slightly offset from seeded signals).
  const presets: SimPreset[] = NEIGHBORHOODS.map((n, i) => ({
    id: n.id,
    label: { en: `Parked in ${n.name} (±12 m)`, ar: `راكن في ${n.nameAr} (±12 م)` },
    location: offset(n.center, 60 + i * 25, -40 + i * 15),
    accuracyM: 12,
  })).concat([{ id: "weak", label: { en: "Weak GPS signal (±180 m)", ar: "إشارة GPS ضعيفة (±180 م)" }, location: offset(NEIGHBORHOODS[0].center, -200, 90), accuracyM: 180, tone: "warn" } as SimPreset]);

  if (!session) return null;
  if (session.user?.role !== "driver") {
    return (
      <Card className="mx-auto max-w-lg text-center">
        <p className="font-semibold">{L("Departure reports are for driver accounts.", "بلاغات الطلعة لحسابات السائقين.")}</p>
        <p className="mt-1 text-sm text-mute">{L("Switch to Demo Driver A from the top bar.", "حوّل للسائقة التجريبية أ من الشريط اللي فوق.")}</p>
      </Card>
    );
  }

  if (active) {
    return (
      <Card className="mx-auto max-w-lg">
        <CheckCircle2 className="h-10 w-10 text-private" aria-hidden />
        <h1 className="mt-3 text-xl font-bold text-forest">{L("You already have a live report", "عندك بلاغ شغّال من قبل")}</h1>
        <p className="mt-1 text-sm text-mute">{L("One active departure report at a time keeps signals trustworthy.", "بلاغ طلعة واحد في كل مرة يخلي الإشارات موثوقة.")}</p>
        <ButtonLink href={`/reports/${active.id}`} className="mt-4 w-full">{L("Open my report", "افتح بلاغي")}</ButtonLink>
      </Card>
    );
  }

  const submit = async () => {
    if (!ev?.location) return toast(L("Add your location first.", "أضف موقعك أول."), "error");
    if (!consent) return toast(L("Please confirm the location consent.", "أكّد موافقتك على استخدام الموقع."), "error");
    setBusy(true);
    try {
      const { report } = await api<{ report: ReportView }>("/api/reports", { body: { ...ev, departInMinutes: departIn, note: note.trim() || null } });
      toast(L("Report shared with nearby drivers", "وصل بلاغك للسائقين اللي حولك"), "ok");
      router.push(`/reports/${report.id}`);
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const options: { v: 0 | 2 | 5 | 10; label: string }[] = [
    { v: 0, label: L("Leaving now", "بطلع الحين") },
    { v: 2, label: L("In 2 min", "بعد دقيقتين") },
    { v: 5, label: L("In 5 min", "بعد 5 دقايق") },
    { v: 10, label: L("In 10 min", "بعد 10 دقايق") },
  ];

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader eyebrow={L("Verified parking handoff", "تسليم موقف موثّق")} title={L("I'm leaving my parking spot", "بطلع من موقفي")} subtitle={L("Share a short-lived signal so a nearby driver can find the space. You earn RAKNA KEYS only after another driver verifies it on site.", "شارك إشارة قصيرة عشان سائق قريب يلقى الموقف. تكسب مفاتيح ركنة فقط بعد ما يتحقق منه سائق ثاني في الموقع.")} />

      <div className="space-y-4">
        <Card>
          <h2 className="mb-1 flex items-center gap-2 font-bold"><ShieldCheck className="h-5 w-5 text-forest" aria-hidden />{L("Location consent", "الموافقة على الموقع")}</h2>
          <ul className="mb-4 list-disc space-y-1 ps-5 text-xs leading-relaxed text-ink-2">
            <li>{L("We read your location once, now, because you asked to report a departure. No background tracking.", "نقرأ موقعك مرة وحدة الحين لأنك طلبت بلاغ طلعة. ما فيه تتبع في الخلفية.")}</li>
            <li>{L("Other drivers see an approximate position (~100 m). The exact point is shown only to the one driver who taps “Navigate”.", "السائقين الثانيين يشوفون موقع تقريبي (~100 م). النقطة الدقيقة تطلع فقط للسائق اللي يضغط «توجّه».")}</li>
            <li>{L("Your name is never shown on the map. Precise coordinates are coarsened after 24 hours.", "اسمك ما يطلع على الخريطة أبدًا. الإحداثيات الدقيقة تتقرّب بعد 24 ساعة.")}</li>
            <li>{L("Never hold or block a public space for anyone. The signal is informational only.", "لا تحجز ولا تمسك موقف عام لأحد. الإشارة للمعلومية بس.")}</li>
          </ul>
          <LocationPicker value={ev} onChange={setEv} presets={presets} purpose={L("Stand by your car so the location is accurate.", "خلك جنب سيارتك عشان يكون الموقع دقيق.")} />
        </Card>

        <Card>
          <h2 className="mb-3 flex items-center gap-2 font-bold"><Clock className="h-5 w-5 text-forest" aria-hidden />{L("When are you leaving?", "متى بتطلع؟")}</h2>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {options.map((o) => (
              <button key={o.v} type="button" onClick={() => setDepartIn(o.v)} aria-pressed={departIn === o.v} className={cn("h-12 rounded-xl border text-sm font-semibold transition", departIn === o.v ? "border-forest bg-forest text-white" : "border-line bg-card text-ink-2 hover:border-forest-3")}>
                {o.label}
              </button>
            ))}
          </div>
          <label className="mt-4 block">
            <span className="mb-1.5 block text-sm font-medium text-ink-2">{L("Optional hint (no personal details)", "تلميح اختياري (بدون معلومات شخصية)")}</span>
            <input className={inputCls} maxLength={140} value={note} onChange={(e) => setNote(e.target.value)} placeholder={L("e.g. Near the pharmacy entrance", "مثلًا: جنب مدخل الصيدلية")} />
          </label>
        </Card>

        <Notice tone="info">{L("The signal expires automatically about 20 minutes after your departure time. Please don't report while driving — report before you start moving.", "الإشارة تنتهي تلقائيًا بعد حوالي 20 دقيقة من وقت طلعتك. لا تبلّغ وأنت تسوق — بلّغ قبل ما تتحرك.")}</Notice>
        <Disclaimer />

        <label className="flex items-start gap-3 rounded-2xl border border-line bg-card p-4 text-sm">
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-1 h-4 w-4 accent-[var(--color-forest)]" />
          <span>{L("I agree to share this location for this report, and I understand it does not reserve the space for anyone.", "أوافق على مشاركة هذا الموقع لهذا البلاغ، وفاهم إنه ما يحجز الموقف لأي أحد.")}</span>
        </label>

        <Button size="lg" className="w-full" onClick={submit} loading={busy} disabled={!ev?.location || !consent}>
          <DoorOpen className="h-5 w-5" aria-hidden />
          {L("Share departure signal", "شارك إشارة الطلعة")}
        </Button>
      </div>
    </div>
  );
}
