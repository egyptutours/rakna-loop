"use client";

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { CheckCircle2, CircleSlash, Clock, ExternalLink, FlaskConical, MapPin, Navigation, Timer, XCircle } from "lucide-react";
import { useApp } from "@/components/providers";
import { LocationPicker, offset, type Evidence, type SimPreset } from "@/components/location-picker";
import { Button, Card, ConfidenceMeter, DemoTag, Disclaimer, Keys, Notice, Pill, StatusPill } from "@/components/ui";
import { api } from "@/lib/client/api";
import { countdown, timeAgo } from "@/lib/client/format";
import { distanceM, formatDistance } from "@/lib/geo";
import { NEIGHBORHOOD_LABEL } from "@/lib/i18n";
import type { ReportView } from "@/lib/api/views";
import type { HiveResourceSignal } from "@/lib/hive/signals";
import { Hexagon, ThumbsDown, ThumbsUp } from "lucide-react";

interface Detail {
  report: ReportView;
  signal: HiveResourceSignal;
  confirmations: { outcome: string; accepted: boolean; rejectionReason: string | null; distanceM: number | null; createdAt: string; byMe: boolean }[];
}

/** SCREEN 4 — Parking report details: claim, navigate, confirm. */
export default function ReportDetails({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { L, B, lang, session, toast, errorText, refreshSession } = useApp();
  const [d, setD] = useState<Detail | null>(null);
  const [missing, setMissing] = useState(false);
  const [ev, setEv] = useState<Evidence | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [result, setResult] = useState<{ tone: "ok" | "warn" | "info"; text: string; keys?: number } | null>(null);
  const [feedbackSent, setFeedbackSent] = useState(false);
  const sendFeedback = async (helpful: boolean) => {
    setFeedbackSent(true);
    await api("/api/hive/feedback", { body: { helpful, reportId: id } }).catch(() => {});
  };

  const load = useCallback(async () => {
    try {
      const q = ev?.location ? `?lat=${ev.location.lat}&lng=${ev.location.lng}` : "";
      setD(await api<Detail>(`/api/reports/${id}${q}`));
    } catch {
      setMissing(true);
    }
  }, [id, ev?.location]);

  useEffect(() => {
    void load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [load, session?.user?.id]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => setResult(null), [session?.user?.id]);

  if (missing) return <Card className="mx-auto max-w-lg text-center">{L("Report not found.", "البلاغ غير موجود.")}</Card>;
  if (!d || !session) return <div className="mx-auto h-64 max-w-2xl animate-pulse rounded-3xl bg-sage-soft" />;

  const r = d.report;
  const user = session.user;
  const isDriver = user?.role === "driver";
  const active = ["available", "pending_departure", "claimed"].includes(r.status);
  const canClaim = isDriver && !r.isMine && (r.status === "available" || r.status === "pending_departure");
  const canConfirm = r.claimedByMe && r.status === "claimed";

  const presets: SimPreset[] = [
    { id: "at", label: { en: "At the spot (±10 m)", ar: "عند الموقف (±10 م)" }, location: offset(r.location, 12, -8), accuracyM: 10, tone: "ok" },
    { id: "near", label: { en: "Across the street (~70 m)", ar: "في الجهة المقابلة (~70 م)" }, location: offset(r.location, 55, 40), accuracyM: 20, tone: "ok" },
    { id: "far", label: { en: "600 m away", ar: "على بُعد 600 م" }, location: offset(r.location, 450, 400), accuracyM: 15, tone: "warn" },
    { id: "vfar", label: { en: "8 km away (suspicious)", ar: "على بُعد 8 كم (مشبوه)" }, location: offset(r.location, 6000, 5300), accuracyM: 12, tone: "bad" },
  ];

  const act = async (kind: "claim" | "found" | "not_found" | "cancel" | "expire") => {
    setBusy(kind);
    setResult(null);
    try {
      if (kind === "claim") {
        await api(`/api/reports/${id}/claim`, { body: ev ?? { location: null, accuracyM: null, evidence: "none" } });
        toast(L("Claimed — the exact spot is now visible to you only.", "تم — الموقع الدقيق ظاهر لك وحدك الآن."), "ok");
      } else if (kind === "found" || kind === "not_found") {
        const res = await api<{ heldForReview: boolean; accepted: boolean; released: boolean; keysEarned: number; capped: boolean }>(`/api/reports/${id}/confirm`, {
          body: { ...(ev ?? { location: null, accuracyM: null, evidence: "none" }), outcome: kind },
        });
        if (res.heldForReview) setResult({ tone: "warn", text: L("Thanks. This handoff was flagged for a quick admin review before any Keys are issued.", "شكرًا. تم تحويل هذا التسليم لمراجعة سريعة من المشرف قبل منح أي مفاتيح.") });
        else if (res.released) setResult({ tone: "info", text: L("Released. Without on-site location we can't verify “not available”, so the signal returns to other drivers and nobody is penalized.", "تم الإفلات. بدون موقع ميداني لا يمكن التحقق من «غير متاح»، لذا تعود الإشارة للسائقين الآخرين دون معاقبة أحد.") });
        else if (kind === "found") setResult({ tone: "ok", keys: res.keysEarned, text: L("Verified handoff! The reporter earned Keys for helping you.", "تسليم موثّق! حصل المُبلّغ على مفاتيح لمساعدتك.") });
        else setResult({ tone: "info", keys: res.keysEarned, text: L("Thanks for confirming on site. The signal is marked not found.", "شكرًا لتأكيدك من الموقع. تم تعليم الإشارة كغير موجودة.") });
        if (res.capped) toast(L("Daily Keys limit reached — part of the reward was capped.", "بلغت الحد اليومي للمفاتيح — تم تقليص جزء من المكافأة."), "info");
        void refreshSession();
      } else if (kind === "cancel") {
        await api(`/api/reports/${id}`, { method: "DELETE" });
        toast(L("Report withdrawn.", "تم سحب البلاغ."), "ok");
      } else {
        await api("/api/demo", { body: { action: "expire_report", id } });
        toast(L("Demo: report expired.", "تجريبي: انتهت صلاحية البلاغ."), "info");
      }
      await load();
    } catch (e) {
      toast(errorText(e), "error");
      await load();
    } finally {
      setBusy(null);
    }
  };

  const dist = ev?.location ? distanceM(ev.location, r.location) : null;
  const directions = `https://www.google.com/maps/dir/?api=1&destination=${r.location.lat},${r.location.lng}&travelmode=driving`;

  return (
    <div className="mx-auto grid max-w-5xl gap-5 lg:grid-cols-[1.3fr_1fr]">
      <div className="space-y-4">
        <Link href="/" className="text-sm text-forest-3 hover:underline">{L("← Back to map", "→ العودة إلى الخريطة")}</Link>
        <Card>
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill status={r.status} />
            {r.isMine && <Pill tone="forest">{L("Your report", "بلاغك")}</Pill>}
            {r.claimedByMe && <Pill tone="signal">{L("You claimed this", "أنت متجه إليه")}</Pill>}
            {r.isDemo && <DemoTag />}
          </div>
          <h1 className="mt-3 text-2xl font-bold text-forest">{L("Community parking signal", "إشارة موقف مجتمعية")}</h1>
          <p className="text-sm text-mute">{B(NEIGHBORHOOD_LABEL[r.neighborhood] ?? { en: r.neighborhood, ar: r.neighborhood })}</p>

          <dl className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Info icon={<Clock className="h-4 w-4" />} label={L("Reported", "وقت البلاغ")} value={timeAgo(r.createdAt, lang, now)} />
            <Info icon={<Timer className="h-4 w-4" />} label={active ? L("Expires in", "ينتهي خلال") : L("Status", "الحالة")} value={active ? <span className="num">{countdown(r.expiresAt, now)}</span> : B({ en: "Closed", ar: "مغلق" })} />
            <Info icon={<MapPin className="h-4 w-4" />} label={L("Distance", "المسافة")} value={dist !== null ? formatDistance(dist, lang) : L("Add location", "أضف موقعك")} />
            <Info icon={<Navigation className="h-4 w-4" />} label={L("GPS accuracy", "دقة الموقع")} value={<span className="num">±{r.accuracyM} m</span>} />
          </dl>
          {r.status === "pending_departure" && (
            <p className="mt-3 text-sm text-signal">{L("Driver expects to leave in", "يتوقع السائق المغادرة خلال")} <span className="num font-semibold">{countdown(r.expectedDepartureAt, now)}</span></p>
          )}
          {!r.precise && active && <p className="mt-3 text-xs text-mute">{L("Position shown is approximate (~100 m). The exact point appears after you tap “Navigate to this spot”.", "الموقع المعروض تقريبي (~100 م). تظهر النقطة الدقيقة بعد الضغط على «توجّه إلى هذا الموقف».")}</p>}
        </Card>

        <Card>
          <h2 className="mb-3 font-bold">{L("How confident is this signal?", "ما مدى الثقة في هذه الإشارة؟")}</h2>
          <ConfidenceMeter level={r.confidence.level} score={r.confidence.score} factors={r.confidence.factors} showFactors />
          <p className="mt-3 text-xs text-mute">{L("A transparent estimate from freshness, GPS accuracy, your distance, the reporter's verified history and this hive's verified trail. It is never a guarantee.", "تقدير شفاف يعتمد على حداثة البلاغ ودقة الموقع ومسافتك وسجل المُبلّغ الموثّق وسجل التحقق في هذه الخلية. وليس ضمانًا أبدًا.")}</p>
        </Card>

        {d.signal && (
          <Card className="border-gold/30">
            <h2 className="mb-2 flex items-center gap-2 font-bold"><Hexagon className="h-5 w-5 fill-gold/30 text-gold" aria-hidden />{L("Hive resource signal", "إشارة مورد الخلية")}</h2>
            <p className="text-sm leading-relaxed text-ink-2">{B(d.signal.explanation)}</p>
            <div className="mt-4 grid grid-cols-3 gap-2 text-center">
              <div className="rounded-xl bg-sage-mist p-2"><p className="text-[10px] text-mute">{L("Freshness", "الحداثة")}</p><p className="num font-bold">{Math.round(d.signal.freshness * 100)}%</p></div>
              <div className="rounded-xl bg-sage-mist p-2"><p className="text-[10px] text-mute">{L("Reliability", "الموثوقية")}</p><p className="num font-bold">{Math.round(d.signal.reliability * 100)}%</p></div>
              <div className="rounded-xl bg-sage-mist p-2"><p className="text-[10px] text-mute">{L("Signal strength", "قوة الإشارة")}</p><p className="num font-bold text-gold">{Math.round(d.signal.strength * 100)}%</p></div>
            </div>
            <p className="mt-3 text-[11px] leading-relaxed text-mute">
              {L(
                `Strength fades as the signal ages and drops to zero at expiry. Local trail: ${d.signal.verification.trailSamples >= 1 ? `${Math.round(d.signal.verification.trailScore * 100)}% found (${d.signal.verification.trailSamples} recent verifications)` : "no recent verifications yet"}. Scout history: ${d.signal.verification.scoutVerified} verified, ${d.signal.verification.scoutNotFound} not found.`,
                `تضعف القوة مع تقادم الإشارة وتصبح صفرًا عند انتهائها. سجل الخلية: ${d.signal.verification.trailSamples >= 1 ? `${Math.round(d.signal.verification.trailScore * 100)}% وُجد (${d.signal.verification.trailSamples} تحققات حديثة)` : "لا تحققات حديثة بعد"}. سجل الكشّاف: ${d.signal.verification.scoutVerified} موثق، ${d.signal.verification.scoutNotFound} غير موجود.`,
              )}
            </p>
            <p className="mt-1 font-mono text-[10px] text-mute" dir="ltr">H3 r10 {d.signal.cell}</p>
          </Card>
        )}
        <Disclaimer />
      </div>

      <div className="space-y-4">
        {result && (
          <Card className={result.tone === "ok" ? "border-private/30 bg-private-soft" : result.tone === "warn" ? "border-warn/30 bg-warn-soft" : ""}>
            <p className="text-sm font-semibold">{result.text}</p>
            {result.keys !== undefined && result.keys > 0 && <p className="mt-2 text-sm">{L("You earned", "حصلت على")} <Keys n={result.keys} /> {L("for confirming on site.", "لتأكيدك من الموقع.")}</p>}
            {!feedbackSent ? (
              <div className="mt-3 flex items-center gap-2 border-t border-line pt-3 text-xs">
                <span className="text-ink-2">{L("Was RAKNA helpful this time?", "هل كان ركنة مفيدًا هذه المرة؟")}</span>
                <button onClick={() => sendFeedback(true)} className="grid h-8 w-8 place-items-center rounded-lg border border-line bg-card hover:bg-sage-mist" aria-label={L("Helpful", "مفيد")}><ThumbsUp className="h-4 w-4" /></button>
                <button onClick={() => sendFeedback(false)} className="grid h-8 w-8 place-items-center rounded-lg border border-line bg-card hover:bg-sage-mist" aria-label={L("Not helpful", "غير مفيد")}><ThumbsDown className="h-4 w-4" /></button>
              </div>
            ) : <p className="mt-3 border-t border-line pt-3 text-xs text-mute">{L("Thanks for the feedback.", "شكرًا لملاحظتك.")}</p>}
          </Card>
        )}

        {!user && <Notice tone="info">{L("Pick a demo driver account from the top bar to interact.", "اختر حساب سائق تجريبي من الشريط العلوي للتفاعل.")}</Notice>}

        {r.isMine && (
          <Card>
            <h2 className="font-bold">{L("Your departure report", "بلاغ مغادرتك")}</h2>
            <p className="mt-1 text-sm text-mute">
              {r.status === "claimed" ? L("A driver is heading to your spot. You'll earn Keys if they confirm finding it.", "سائق متجه إلى موقفك. ستكسب مفاتيح إذا أكد العثور عليه.")
                : r.status === "found" ? L("Verified! Another driver found your spot. Keys were added to your wallet.", "تم التحقق! وجد سائق آخر موقفك. أُضيفت المفاتيح إلى محفظتك.")
                : r.status === "flagged" ? L("This handoff is under a quick review before rewards are issued.", "هذا التسليم قيد مراجعة سريعة قبل منح المكافآت.")
                : active ? L("Nearby drivers can see your signal now.", "يمكن للسائقين القريبين رؤية إشارتك الآن.")
                : L("This report is closed.", "هذا البلاغ مغلق.")}
            </p>
            {active && (
              <Button variant="secondary" className="mt-4 w-full" onClick={() => act("cancel")} loading={busy === "cancel"}>
                <XCircle className="h-4 w-4" aria-hidden />
                {L("Withdraw report (plans changed)", "اسحب البلاغ (تغيرت الخطط)")}
              </Button>
            )}
            {session.demoMode && active && (
              <Notice tone="info">
                {L("Demo tip: switch to “Faisal (Demo Driver B)” in the top bar, open this report, tap Navigate, then confirm.", "تلميح تجريبي: بدّل إلى «فيصل (سائق تجريبي ب)» من الشريط العلوي، افتح هذا البلاغ، اضغط «توجّه»، ثم أكّد.")}
              </Notice>
            )}
          </Card>
        )}

        {(canClaim || canConfirm) && (
          <Card>
            <h2 className="mb-2 font-bold">{canClaim ? L("Heading there?", "متجه إلى هناك؟") : L("Arrived? Confirm the outcome", "وصلت؟ أكّد النتيجة")}</h2>
            <LocationPicker
              value={ev}
              onChange={setEv}
              presets={presets}
              purpose={canClaim
                ? L("Optional: share your location once so the confidence score and travel checks are accurate.", "اختياري: شارك موقعك مرة واحدة لتكون درجة الثقة وفحوص التنقل دقيقة.")
                : L("Required to confirm “found”: we check you are at the spot (GPS isn't perfect, so there's a tolerance).", "مطلوب لتأكيد «وجدته»: نتحقق من وجودك عند الموقف (GPS ليس دقيقًا تمامًا، لذا يوجد هامش).")}
            />
            {canClaim && (
              <Button variant="signal" size="lg" className="mt-4 w-full" onClick={() => act("claim")} loading={busy === "claim"}>
                <Navigation className="h-5 w-5" aria-hidden />
                {L("Navigate to this spot", "توجّه إلى هذا الموقف")}
              </Button>
            )}
            {canConfirm && (
              <div className="mt-4 space-y-2">
                <a href={directions} target="_blank" rel="noreferrer" className="flex h-11 w-full items-center justify-center gap-2 rounded-xl border border-line bg-card text-sm font-semibold text-forest hover:bg-sage-mist">
                  <ExternalLink className="h-4 w-4" aria-hidden />
                  {L("Open directions in Maps", "افتح الاتجاهات في الخرائط")}
                </a>
                {r.claimExpiresAt && <p className="text-center text-xs text-mute">{L("Your claim holds the signal (not the space) for", "يحتفظ توجهك بالإشارة (لا بالموقف) لمدة")} <span className="num font-semibold">{countdown(r.claimExpiresAt, now)}</span></p>}
                <Button variant="private" size="lg" className="w-full" onClick={() => act("found")} loading={busy === "found"}>
                  <CheckCircle2 className="h-5 w-5" aria-hidden />
                  {L("I Found the Parking Space", "وجدت الموقف")}
                </Button>
                <Button variant="secondary" className="w-full" onClick={() => act("not_found")} loading={busy === "not_found"}>
                  <CircleSlash className="h-4 w-4" aria-hidden />
                  {L("The Parking Space Was Not Available", "الموقف لم يكن متاحًا")}
                </Button>
              </div>
            )}
            <p className="mt-3 text-[11px] leading-relaxed text-mute">{L("Never stop in traffic or wait in a way that blocks the road. A claim does not reserve public parking.", "لا تتوقف وسط الطريق ولا تنتظر بطريقة تعيق السير. التوجه لا يحجز موقفًا عامًا.")}</p>
          </Card>
        )}

        {r.claimedByOther && !r.isMine && isDriver && (
          <Notice tone="info">{L("Another driver is heading to this signal. To avoid sending two cars to one space, it's hidden from others until their claim ends.", "سائق آخر متجه إلى هذه الإشارة. لتجنب إرسال سيارتين لموقف واحد، تُخفى عن الآخرين حتى ينتهي توجهه.")}</Notice>
        )}

        {d.confirmations.length > 0 && (
          <Card>
            <h2 className="mb-2 text-sm font-bold">{L("Verification log", "سجل التحقق")}</h2>
            <ul className="space-y-2 text-xs">
              {d.confirmations.map((c, i) => (
                <li key={i} className="flex justify-between gap-2 rounded-xl bg-sage-mist p-2.5">
                  <span>{c.outcome === "found" ? L("Found", "وُجد") : L("Not available", "غير متاح")} · {c.accepted ? L("accepted", "مقبول") : (c.rejectionReason ?? L("rejected", "مرفوض"))}</span>
                  <span className="num text-mute">{c.distanceM !== null ? `${c.distanceM} m` : "—"}</span>
                </li>
              ))}
            </ul>
          </Card>
        )}

        {session.demoMode && active && user && (
          <button onClick={() => act("expire")} className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-gold/60 py-2.5 text-xs font-semibold text-gold hover:bg-gold-soft">
            <FlaskConical className="h-3.5 w-3.5" aria-hidden />
            {L("Demo: expire this report now (test freshness rules)", "تجريبي: أنهِ صلاحية هذا البلاغ الآن (اختبار قواعد الحداثة)")}
          </button>
        )}
      </div>
    </div>
  );
}

function Info({ icon, label, value }: { icon: React.ReactNode; label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-2xl bg-sage-mist p-3">
      <dt className="flex items-center gap-1.5 text-[11px] text-mute">{icon}{label}</dt>
      <dd className="mt-1 text-sm font-semibold text-ink">{value}</dd>
    </div>
  );
}
