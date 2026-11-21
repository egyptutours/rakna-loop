"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Building2, CalendarClock, CheckCircle2, MapPin } from "lucide-react";
import { useApp } from "@/components/providers";
import { Button, Card, DemoTag, Empty, Field, Keys, Notice, PageHeader, Pill, SectionTitle, Skeleton, cn, inputCls } from "@/components/ui";
import { api } from "@/lib/client/api";
import { fmtDateTime, fmtSar, fromRiyadhInput, riyadhInputValue } from "@/lib/client/format";
import { DAY_SHORT, NEIGHBORHOOD_LABEL } from "@/lib/i18n";
import type { ParkingBooking, RewardItem } from "@/lib/types";
import type { SpaceView } from "@/lib/api/views";

interface SpacesData {
  spaces: SpaceView[];
  discountRewards: RewardItem[];
}
type MyBooking = ParkingBooking & { spaceTitle: string; spaceTitleAr: string };

/** SCREEN 7 — Private parking marketplace. */
export default function ParkingPage() {
  return (
    <Suspense fallback={<Skeleton className="h-96" />}>
      <Marketplace />
    </Suspense>
  );
}

function Marketplace() {
  const { L, B, lang, session, toast, errorText } = useApp();
  const params = useSearchParams();
  const [data, setData] = useState<SpacesData | null>(null);
  const [bookings, setBookings] = useState<MyBooking[]>([]);
  const [balance, setBalance] = useState<number | null>(null);
  const [selected, setSelected] = useState<string | null>(params.get("space"));
  const [hood, setHood] = useState<string>("all");
  const isDriver = session?.user?.role === "driver";

  const load = useCallback(async () => {
    setData(await api<SpacesData>("/api/spaces"));
    if (isDriver) {
      const [b, r] = await Promise.all([api<{ bookings: MyBooking[] }>("/api/bookings"), api<{ balance: number | null }>("/api/rewards")]);
      setBookings(b.bookings);
      setBalance(r.balance);
    }
  }, [isDriver]);
  useEffect(() => {
    load().catch((e) => toast(errorText(e), "error"));
  }, [load, session?.user?.id, toast, errorText]);

  const spaces = useMemo(() => (data?.spaces ?? []).filter((s) => hood === "all" || s.neighborhood === hood), [data, hood]);
  const sel = data?.spaces.find((s) => s.id === selected) ?? null;

  return (
    <div>
      <PageHeader eyebrow={L("Authorized inventory only", "مواقف معتمدة بس")} title={L("Private parking marketplace", "سوق المواقف الخاصة")} subtitle={L("Spaces listed by approved partners (hotels, offices, malls, operators). Bookable subject to availability. Payments are simulated in this MVP.", "مواقف يعرضها شركاء معتمدين (فنادق، مكاتب، مولات، مشغّلين). تنحجز حسب التوفر. الدفع في هذي النسخة محاكاة.")} />

      <div className="no-scrollbar mb-5 flex gap-2 overflow-x-auto">
        {["all", "olaya", "wurud", "malqa", "kfr"].map((h) => (
          <button key={h} onClick={() => setHood(h)} aria-pressed={hood === h} className={cn("shrink-0 rounded-full border px-4 py-1.5 text-sm font-medium", hood === h ? "border-forest bg-forest text-white" : "border-line bg-card text-ink-2")}>
            {h === "all" ? L("All Riyadh", "الرياض كلها") : B(NEIGHBORHOOD_LABEL[h])}
          </button>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-[1.3fr_1fr]">
        <div className="space-y-3">
          {!data && [1, 2, 3].map((i) => <Skeleton key={i} className="h-40" />)}
          {data && spaces.length === 0 && <Empty>{L("No approved spaces in this area yet.", "ما فيه مواقف معتمدة في هالمنطقة للحين.")}</Empty>}
          {spaces.map((s) => (
            <button key={s.id} onClick={() => { setSelected(s.id); if (window.innerWidth < 1024) setTimeout(() => document.getElementById("booking-panel")?.scrollIntoView({ behavior: "smooth", block: "start" }), 50); }} className={cn("block w-full rounded-[var(--radius-card)] border bg-card p-5 text-start shadow-[var(--shadow-soft)] transition", selected === s.id ? "border-private ring-2 ring-private/20" : "border-line hover:border-private/40")}>
              <div className="flex flex-wrap items-center gap-2">
                <Pill tone="private"><Building2 className="h-3 w-3" aria-hidden />{L("Approved partner", "شريك معتمد")}</Pill>
                {s.rewardEligible && <Pill tone="gold">{L("Keys discount eligible", "يقبل خصم المفاتيح")}</Pill>}
                {s.isDemo && <DemoTag />}
              </div>
              <div className="mt-3 flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <h3 className="font-bold">{lang === "ar" ? s.titleAr : s.title}</h3>
                  <p className="text-sm text-mute">{lang === "ar" ? s.partnerNameAr : s.partnerName}</p>
                  <p className="mt-1 flex items-center gap-1 text-xs text-mute"><MapPin className="h-3 w-3" aria-hidden />{lang === "ar" ? s.addressAr : s.address}</p>
                </div>
                <div className="text-end">
                  <p className="text-lg font-bold text-forest">{fmtSar(s.pricePerHour, lang)}</p>
                  <p className="text-xs text-mute">{L("per hour", "للساعة")}</p>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                <Pill tone={s.openNow ? "private" : "inactive"}>{s.openNow ? L(`Open · ${s.freeNow}/${s.capacity} unbooked`, `مفتوح · ${s.freeNow}/${s.capacity} فاضي`) : L("Closed now", "مقفل الحين")}</Pill>
                <span className="text-mute">
                  {s.schedule.days.map((d) => B(DAY_SHORT[d])).join(lang === "ar" ? "، " : ", ")} · <span className="num">{String(s.schedule.openHour).padStart(2, "0")}:00–{String(s.schedule.closeHour).padStart(2, "0")}:00</span>
                </span>
              </div>
            </button>
          ))}
        </div>

        <div id="booking-panel" className="scroll-mt-24 space-y-4 lg:sticky lg:top-24 lg:self-start">
          {sel ? <BookingForm space={sel} rewards={data?.discountRewards ?? []} balance={balance} onBooked={load} /> : <Card className="text-center text-sm text-mute">{L("Select a space to book.", "اختر موقف عشان تحجز.")}</Card>}
          {isDriver && (
            <div>
              <SectionTitle title={L("My bookings", "حجوزاتي")} />
              <div className="space-y-2">
                {bookings.length === 0 && <Empty>{L("No bookings yet.", "ما فيه حجوزات للحين.")}</Empty>}
                {bookings.map((b) => (
                  <Card key={b.id} className="p-4">
                    <div className="flex justify-between gap-2">
                      <p className="text-sm font-semibold">{lang === "ar" ? b.spaceTitleAr : b.spaceTitle}</p>
                      <Pill tone={b.status === "confirmed" ? "private" : "inactive"}>{B({ confirmed: { en: "Confirmed", ar: "مؤكد" }, cancelled: { en: "Cancelled", ar: "ملغي" }, completed: { en: "Completed", ar: "مكتمل" } }[b.status])}</Pill>
                    </div>
                    <p className="mt-1 text-xs text-mute">{fmtDateTime(b.startAt, lang)} · <span className="num">{b.hours}</span> {L("h", "س")}</p>
                    <p className="mt-1 text-xs">{fmtSar(b.priceTotal - b.discountApplied, lang)} {b.discountApplied > 0 && <span className="text-private">({L("discount", "خصم")} {fmtSar(b.discountApplied, lang)})</span>} · <span className="text-mute">{L("simulated payment", "دفع محاكى")}</span></p>
                    {b.status === "confirmed" && new Date(b.startAt) > new Date() && (
                      <button className="mt-2 text-xs font-semibold text-danger hover:underline" onClick={async () => { try { await api(`/api/bookings/${b.id}`, { method: "DELETE" }); toast(L("Booking cancelled.", "انلغى الحجز."), "ok"); await load(); } catch (e) { toast(errorText(e), "error"); } }}>
                        {L("Cancel booking", "ألغِ الحجز")}
                      </button>
                    )}
                  </Card>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function BookingForm({ space, rewards, balance, onBooked }: { space: SpaceView; rewards: RewardItem[]; balance: number | null; onBooked: () => Promise<void> }) {
  const { L, lang, session, toast, errorText } = useApp();
  const defaultStart = () => {
    const d = new Date(Date.now() + 60 * 60_000);
    d.setMinutes(0, 0, 0);
    return riyadhInputValue(d);
  };
  const [start, setStart] = useState(defaultStart);
  const [hours, setHours] = useState(2);
  const [rewardId, setRewardId] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<ParkingBooking | null>(null);
  useEffect(() => { setDone(null); setRewardId(""); }, [space.id]);

  const eligible = rewards.filter((r) => space.rewardEligible && (r.partnerId === null || r.partnerId === space.partnerId));
  const reward = eligible.find((r) => r.id === rewardId) ?? null;
  const price = Math.round(space.pricePerHour * hours * 100) / 100;
  const discount = reward?.discountPercent ? Math.round(price * (reward.discountPercent / 100) * 100) / 100 : 0;
  const isDriver = session?.user?.role === "driver";

  const book = async () => {
    setBusy(true);
    try {
      const { booking } = await api<{ booking: ParkingBooking }>("/api/bookings", { body: { spaceId: space.id, startAt: fromRiyadhInput(start).toISOString(), hours, rewardId: rewardId || null } });
      setDone(booking);
      toast(L("Booking confirmed (simulated payment).", "تأكد الحجز (دفع محاكى)."), "ok");
      await onBooked();
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <Card className="border-private/30 bg-private-soft">
        <CheckCircle2 className="h-9 w-9 text-private" aria-hidden />
        <h3 className="mt-2 text-lg font-bold">{L("Booking confirmed", "تأكد الحجز")}</h3>
        <p className="mt-1 text-sm">{lang === "ar" ? space.titleAr : space.title}</p>
        <p className="text-sm text-ink-2">{fmtDateTime(done.startAt, lang)} · <span className="num">{done.hours}</span> {L("hours", "ساعات")}</p>
        <p className="mt-2 text-sm font-semibold">{fmtSar(done.priceTotal - done.discountApplied, lang)}</p>
        <p className="mt-3 text-xs text-mute">{L("Demo: no payment was taken. Present this booking reference to on-site staff:", "تجريبي: ما انسحب أي مبلغ. وري موظفين الموقف رقم الحجز:")} <span className="num font-mono">{done.id.slice(0, 8).toUpperCase()}</span></p>
        <Button variant="secondary" className="mt-4 w-full" onClick={() => setDone(null)}>{L("Book another time", "احجز وقت ثاني")}</Button>
      </Card>
    );
  }

  return (
    <Card>
      <h3 className="flex items-center gap-2 font-bold"><CalendarClock className="h-5 w-5 text-private" aria-hidden />{L("Book", "احجز")} · {lang === "ar" ? space.titleAr : space.title}</h3>
      <p className="mt-2 rounded-xl bg-sage-mist p-3 text-xs leading-relaxed text-ink-2">{lang === "ar" ? space.conditionsAr : space.conditions}</p>
      <div className="mt-4 grid grid-cols-2 gap-3">
        <Field label={L("Arrival (Riyadh time)", "الوصول (بتوقيت الرياض)")}>
          <input type="datetime-local" className={inputCls} value={start} onChange={(e) => setStart(e.target.value)} step={900} />
        </Field>
        <Field label={L("Hours", "الساعات")}>
          <select className={inputCls} value={hours} onChange={(e) => setHours(Number(e.target.value))}>
            {Array.from({ length: 12 }, (_, i) => i + 1).map((h) => <option key={h} value={h}>{h}</option>)}
          </select>
        </Field>
      </div>
      {eligible.length > 0 && (
        <Field label={L("Apply a RAKNA KEYS discount (optional)", "طبّق خصم مفاتيح ركنة (اختياري)")} hint={balance !== null ? L(`Balance: ${balance} Keys`, `الرصيد: ${balance} مفتاح`) : undefined}>
          <select className={cn(inputCls, "mt-0")} value={rewardId} onChange={(e) => setRewardId(e.target.value)}>
            <option value="">{L("No discount", "بدون خصم")}</option>
            {eligible.map((r) => (
              <option key={r.id} value={r.id} disabled={balance !== null && balance < r.keysRequired}>
                {(lang === "ar" ? r.titleAr : r.title) + ` — ${r.keysRequired} ${L("Keys", "مفتاح")}`}
              </option>
            ))}
          </select>
        </Field>
      )}
      <div className="mt-4 space-y-1 rounded-xl border border-line p-3 text-sm">
        <div className="flex justify-between"><span className="text-mute">{L("Price", "السعر")}</span><span>{fmtSar(price, lang)}</span></div>
        {reward && <div className="flex justify-between text-private"><span>{L("Keys discount", "خصم المفاتيح")} ({reward.discountPercent}%)</span><span>−{fmtSar(discount, lang)} · <Keys n={reward.keysRequired} size="sm" /></span></div>}
        <div className="flex justify-between border-t border-line pt-1 font-bold"><span>{L("Total", "الإجمالي")}</span><span>{fmtSar(price - discount, lang)}</span></div>
      </div>
      <Notice tone="info">{L("Simulated booking — no card is charged. Bookable subject to availability and the partner's conditions.", "حجز محاكى — ما ينسحب شي من أي بطاقة. الحجز حسب التوفر وشروط الشريك.")}</Notice>
      <Button variant="private" size="lg" className="mt-3 w-full" onClick={book} loading={busy} disabled={!isDriver}>
        {isDriver ? L("Confirm booking", "أكّد الحجز") : L("Switch to a driver account to book", "حوّل لحساب سائق عشان تحجز")}
      </Button>
    </Card>
  );
}
