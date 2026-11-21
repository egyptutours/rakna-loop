"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Lock, Ruler, ShieldCheck, TrainFront } from "lucide-react";
import { useApp } from "@/components/providers";
import { Button, ButtonLink, Card, DemoTag, Empty, Field, Notice, PageHeader, Pill, Skeleton, inputCls } from "@/components/ui";
import { FareTable, RuleSummary } from "@/components/home-ui";
import { api } from "@/lib/client/api";
import { fromRiyadhInput, riyadhInputValue } from "@/lib/client/format";
import { ACCESS_MODE_LABEL, SHADE_LABEL, SPACE_CATEGORY_LABEL } from "@/lib/i18n";
import type { SpaceView } from "@/lib/api/views";
import type { FareBreakdown, RewardItem } from "@/lib/types";

interface Quote {
  fare: FareBreakdown;
  bufferMinutes: number;
}

function roundUp15(d: Date): Date {
  const ms = 15 * 60_000;
  return new Date(Math.ceil(d.getTime() / ms) * ms);
}

/** Book a schedule space (RAKNA HOME / PARTNERS / PARK & CONNECT) for an exact window. */
export default function BookSpacePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { L, B, lang, session, toast, errorText } = useApp();
  const [space, setSpace] = useState<SpaceView | null | undefined>(undefined);
  const [rewards, setRewards] = useState<RewardItem[]>([]);
  const [start, setStart] = useState(() => riyadhInputValue(roundUp15(new Date(Date.now() + 30 * 60_000))));
  const [end, setEnd] = useState(() => riyadhInputValue(roundUp15(new Date(Date.now() + 150 * 60_000))));
  const [rewardId, setRewardId] = useState<string>("");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteErr, setQuoteErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isDriver = session?.user?.role === "driver";

  useEffect(() => {
    api<{ spaces: SpaceView[]; discountRewards: RewardItem[] }>("/api/spaces")
      .then((d) => {
        setSpace(d.spaces.find((s) => s.id === id) ?? null);
        setRewards(d.discountRewards);
      })
      .catch(() => setSpace(null));
  }, [id, session?.user?.id]);

  const slot = useMemo(() => {
    try {
      return { startAt: fromRiyadhInput(start).toISOString(), endAt: fromRiyadhInput(end).toISOString() };
    } catch {
      return null;
    }
  }, [start, end]);

  useEffect(() => {
    if (!space || space.waitlist || !slot) return;
    const t = setTimeout(() => {
      api<{ quote: Quote }>("/api/home/quote", { body: { spaceId: space.id, ...slot, rewardId: rewardId || null } })
        .then((d) => {
          setQuote(d.quote);
          setQuoteErr(null);
        })
        .catch((e) => {
          setQuote(null);
          setQuoteErr(errorText(e));
        });
    }, 300);
    return () => clearTimeout(t);
  }, [space, slot, rewardId, errorText]);

  const book = async () => {
    if (!space || !slot) return;
    setBusy(true);
    try {
      const r = await api<{ booking: { id: string } }>("/api/home/bookings", { body: { spaceId: space.id, ...slot, rewardId: rewardId || null } });
      toast(L("Booked! Your pass unlocks 30 minutes before the start.", "تم الحجز! يظهر تصريحك قبل ٣٠ دقيقة من البداية."), "ok");
      router.push(`/bookings?new=${r.booking.id}`);
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(false);
    }
  };

  if (space === undefined) return <Skeleton className="h-96" />;
  if (space === null) return <Empty>{L("This space isn't available.", "هذا الموقف غير متاح.")} <ButtonLink href="/" variant="ghost">{L("Back to the map", "العودة للخريطة")}</ButtonLink></Empty>;

  const eligible = space.rewardEligible ? rewards : [];

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
      <div className="space-y-5">
        <PageHeader eyebrow={B(SPACE_CATEGORY_LABEL[space.spaceCategory ?? "commercial"])} title={lang === "ar" ? space.titleAr : space.title}>
          <div className="flex flex-wrap gap-2">
            <Pill tone="forest"><ShieldCheck className="h-3 w-3" aria-hidden />{L("Verified entitlement", "أحقية موثّقة")}</Pill>
            {space.isDemo && <DemoTag />}
          </div>
        </PageHeader>

        {space.approximate && (
          <Notice tone="info">
            {L("To protect the host's privacy the map shows a ~150 m area. The exact bay, address and your gate pass are revealed in My Bookings & Passes after payment, from 30 minutes before your start time.", "لحماية خصوصية المضيف تعرض الخريطة منطقة ~150 م. يظهر الموقف الدقيق والعنوان وتصريح الدخول في «حجوزاتي وتصاريحي» بعد الدفع، قبل ٣٠ دقيقة من موعدك.")}
          </Notice>
        )}

        <Card className="space-y-3">
          <h2 className="font-bold">{L("Availability & prices", "التوفر والأسعار")}</h2>
          <ul className="space-y-2">{(space.rules ?? []).map((r, i) => <RuleSummary key={i} rule={r} />)}</ul>
          <div className="flex flex-wrap gap-2 text-xs">
            {space.shadeTier && <Pill>{B(SHADE_LABEL[space.shadeTier])}</Pill>}
            {space.accessMode && <Pill><Lock className="h-3 w-3" aria-hidden />{B(ACCESS_MODE_LABEL[space.accessMode])}</Pill>}
            {space.maxHeightCm && <Pill><Ruler className="h-3 w-3" aria-hidden />{L(`Max height ${space.maxHeightCm / 100} m`, `أقصى ارتفاع ${space.maxHeightCm / 100} م`)}</Pill>}
            {(space.bufferMinutes ?? 0) > 0 && <Pill>{L(`${space.bufferMinutes} min turnaround between bookings`, `${space.bufferMinutes} د بين الحجوزات`)}</Pill>}
            {space.metro && <Pill tone="signal"><TrainFront className="h-3 w-3" aria-hidden />{L(`Park & Connect: ${space.metro.walkMinutes} min walk to ${space.metro.name}`, `اركن واتصل: ${space.metro.walkMinutes} د مشيًا إلى ${space.metro.nameAr}`)}</Pill>}
          </div>
          {(lang === "ar" ? space.conditionsAr : space.conditions) && <p className="text-xs leading-relaxed text-ink-2">{lang === "ar" ? space.conditionsAr : space.conditions}</p>}
        </Card>
      </div>

      <Card className="h-fit space-y-4 lg:sticky lg:top-24">
        {space.waitlist ? (
          <Notice>{L("Villa bookings open after the municipal pilot approval. This space is on the waitlist.", "تُفتح حجوزات الفلل بعد اعتماد التجربة البلدية. هذا الموقف في قائمة الانتظار.")}</Notice>
        ) : (
          <>
            <h2 className="font-bold">{L("Your booking", "حجزك")}</h2>
            <Field label={L("Start (Riyadh time)", "البداية (بتوقيت الرياض)")}>
              <input type="datetime-local" step={900} value={start} onChange={(e) => setStart(e.target.value)} className={inputCls} dir="ltr" />
            </Field>
            <Field label={L("End (Riyadh time)", "النهاية (بتوقيت الرياض)")} hint={L("30 minutes to 30 days.", "من ٣٠ دقيقة إلى ٣٠ يومًا.")}>
              <input type="datetime-local" step={900} value={end} onChange={(e) => setEnd(e.target.value)} className={inputCls} dir="ltr" />
            </Field>
            {eligible.length > 0 && (
              <Field label={L("RAKNA KEYS discount", "خصم مفاتيح ركنة")} hint={L("Keys reduce the platform fee only (max 20% of it). The host's payout is never reduced and Keys have no cash value.", "تخفض المفاتيح رسوم المنصة فقط (حتى 20% منها). لا ينقص مستحق المضيف أبدًا ولا قيمة نقدية للمفاتيح.")}>
                <select value={rewardId} onChange={(e) => setRewardId(e.target.value)} className={inputCls}>
                  <option value="">{L("No discount", "بدون خصم")}</option>
                  {eligible.map((r) => (
                    <option key={r.id} value={r.id}>{lang === "ar" ? r.titleAr : r.title} — {r.keysRequired} {L("keys", "مفتاح")}</option>
                  ))}
                </select>
              </Field>
            )}
            {quote ? <FareTable fare={quote.fare} showHost /> : quoteErr ? <Notice tone="danger">{quoteErr}</Notice> : <Skeleton className="h-32" />}
            <Button variant="private" size="lg" className="w-full" onClick={book} loading={busy} disabled={!isDriver || !quote}>
              {isDriver ? L("Pay & book (simulated)", "ادفع واحجز (محاكاة)") : L("Sign in as a driver to book", "سجّل الدخول كسائق للحجز")}
            </Button>
            <p className="text-[11px] leading-snug text-mute">{L("Overstay beyond a 10-minute grace period is charged at 1.5× the hourly rate. You can extend from your pass.", "يُحتسب التجاوز بعد مهلة ١٠ دقائق بـ 1.5× سعر الساعة. يمكنك التمديد من التصريح.")}</p>
          </>
        )}
      </Card>
    </div>
  );
}
