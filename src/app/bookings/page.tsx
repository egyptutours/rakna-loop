"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { AlertOctagon, Clock, Eye, KeyRound, LogIn, LogOut, MapPin, Plus, QrCode, ShieldCheck, TrainFront } from "lucide-react";
import { useApp } from "@/components/providers";
import { Button, ButtonLink, Card, DemoTag, Empty, Notice, PageHeader, Pill, Skeleton, cn } from "@/components/ui";
import { FareTable } from "@/components/home-ui";
import { api, ApiError } from "@/lib/client/api";
import { fmtDateTime, fmtSar } from "@/lib/client/format";
import { ACCESS_MODE_LABEL, PAYMENT_STATUS_LABEL, SPACE_CATEGORY_LABEL, formatHalalas } from "@/lib/i18n";
import type { AccessMode, CredentialType, FareBreakdown, LatLng, ParkingBooking, PaymentStatus, SpaceCategory } from "@/lib/types";

interface MyBooking extends ParkingBooking {
  space: { id: string; title: string; titleAr: string; location: LatLng; spaceCategory: SpaceCategory; accessMode: AccessMode; metroStationCode: string | null } | null;
  accessUnlocksAt: string;
  accessOpen: boolean;
}

interface Access {
  bookingId: string;
  location: LatLng;
  address: string;
  addressAr: string;
  conditions: string;
  conditionsAr: string;
  accessMode: AccessMode;
  credential: { type: CredentialType; secret: string; validFrom: string; validUntil: string } | null;
}

/** Large, legible credential. QR tokens are shown as grouped hex (scanner integration is per site). */
function Credential({ c }: { c: NonNullable<Access["credential"]> }) {
  const { L, lang } = useApp();
  const groups = c.type === "qr_token" ? c.secret.match(/.{1,4}/g)!.join(" ") : c.type === "guard_code" ? c.secret.match(/.{1,4}/g)!.join("-") : c.secret.split("").join(" ");
  return (
    <div className="rounded-2xl border-2 border-dashed border-forest/40 bg-sage-mist p-4 text-center">
      <p className="mb-2 flex items-center justify-center gap-1.5 text-xs font-semibold text-forest-3">
        {c.type === "qr_token" ? <QrCode className="h-4 w-4" aria-hidden /> : <KeyRound className="h-4 w-4" aria-hidden />}
        {c.type === "pin" ? L("One-time gate PIN", "رمز البوابة (مرة وحدة)") : c.type === "qr_token" ? L("Dynamic pass token", "رمز التصريح المتغيّر") : L("Guard pass code", "رمز تصريح الحارس")}
      </p>
      <p dir="ltr" className={cn("num select-all font-bold tracking-widest text-forest", c.type === "pin" ? "text-4xl" : "text-lg break-all")}>{groups}</p>
      <p className="mt-2 text-[11px] text-mute">
        {L("Valid", "صالح")} <span dir="ltr" className="num">{fmtDateTime(c.validFrom, lang)} → {fmtDateTime(c.validUntil, lang)}</span>
      </p>
      <p className="mt-1 text-[11px] text-mute">{L("Don't share this code. It stops working when you check out or the booking ends.", "لا تعطي هذا الرمز لأحد. يوقف إذا طلعت أو خلص الحجز.")}</p>
    </div>
  );
}

function BookingCard({ b, highlight, onChanged }: { b: MyBooking; highlight: boolean; onChanged: () => void }) {
  const { L, B, lang, session, toast, errorText } = useApp();
  const [access, setAccess] = useState<Access | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const schedule = Boolean(b.fare);
  const active = b.status === "confirmed";
  const ended = Date.parse(b.endAt) < Date.now();

  const run = async (key: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(key);
    try {
      await fn();
      if (ok) toast(ok, "ok");
      onChanged();
    } catch (e) {
      if (e instanceof ApiError && e.code === "access_not_ready") {
        const unlockAt = (e.details as { unlockAt?: string } | null)?.unlockAt;
        toast(L(`Your pass unlocks ${unlockAt ? fmtDateTime(unlockAt, "en") : "30 minutes before the start"}.`, `تصريحك يطلع ${unlockAt ? fmtDateTime(unlockAt, "ar") : "قبل البداية بـ ٣٠ دقيقة"}.`), "info");
      } else toast(errorText(e), "error");
    } finally {
      setBusy(null);
    }
  };

  const reveal = () => run("reveal", async () => setAccess((await api<{ access: Access }>(`/api/bookings/${b.id}/access`)).access));

  const event = (eventType: "arrived" | "extended" | "departed" | "bay_blocked_reported", extra: Record<string, unknown> = {}, ok?: string) =>
    run(
      eventType,
      async () => {
        await api(`/api/bookings/${b.id}/events`, { body: { eventType, ...extra } });
        // An extension moves the credential's validity; a check-out revokes it — never show a stale pass.
        if (eventType === "departed") setAccess(null);
        else if (access) setAccess((await api<{ access: Access }>(`/api/bookings/${b.id}/access`)).access);
      },
      ok,
    );

  const checkIn = () => {
    if (session?.demoMode) return event("arrived", { simulateAtSpace: true }, L("Checked in (demo: simulated at the space).", "تم تسجيل وصولك (تجريبي: موقع محاكى)."));
    if (!("geolocation" in navigator)) return toast(L("Location isn't available in this browser.", "الموقع مو متاح في هذا المتصفح."), "error");
    navigator.geolocation.getCurrentPosition(
      (p) => void event("arrived", { location: { lat: p.coords.latitude, lng: p.coords.longitude } }, L("Checked in. Enjoy your parking!", "تم تسجيل وصولك. الله يوفقك!")),
      () => toast(L("Location permission is needed to check in (within 50 m of the bay).", "نحتاج إذن الموقع عشان نسجّل وصولك (لازم تكون ضمن ٥٠ م من الموقف)."), "error"),
      { enableHighAccuracy: true, timeout: 15_000 },
    );
  };

  const reportBlocked = () => {
    const note = window.prompt(L("What happened? (optional)", "وش صار؟ (اختياري)")) ?? "";
    void event("bay_blocked_reported", { evidenceNote: note.slice(0, 500) || null }, L("Reported. Support will contact the host and help you find an alternative.", "وصلنا بلاغك. الدعم بيتواصل مع المضيف ويساعدك تلقى بديل."));
  };

  return (
    <Card className={cn("space-y-3", highlight && "ring-2 ring-private")}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-semibold">{b.space ? (lang === "ar" ? b.space.titleAr : b.space.title) : L("Parking space", "موقف")}</p>
          <p className="num mt-0.5 text-xs text-mute" dir="ltr">{fmtDateTime(b.startAt, lang)} → {fmtDateTime(b.endAt, lang)}</p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Pill tone={b.status === "confirmed" ? "private" : b.status === "completed" ? "neutral" : "inactive"}>{B({ confirmed: { en: "Confirmed", ar: "مؤكد" }, cancelled: { en: "Cancelled", ar: "ملغي" }, completed: { en: "Completed", ar: "مكتمل" } }[b.status])}</Pill>
          {schedule && <Pill tone={b.paymentStatus === "paid" || b.paymentStatus === "simulated" ? "forest" : "warn"}>{B(PAYMENT_STATUS_LABEL[(b.paymentStatus ?? "simulated") as PaymentStatus])}</Pill>}
          {b.space && <Pill>{B(SPACE_CATEGORY_LABEL[b.space.spaceCategory])}</Pill>}
          {b.space?.metroStationCode && <Pill tone="signal"><TrainFront className="h-3 w-3" aria-hidden />Park & Connect</Pill>}
        </div>
      </div>

      {schedule && b.fare ? (
        <details className="rounded-xl bg-sage-mist/60 px-3 py-2 text-sm">
          <summary className="cursor-pointer font-semibold">{L("Total", "الإجمالي")} <span className="num" dir="ltr">{formatHalalas((b.fare as FareBreakdown).driverTotalHalalas, lang)}</span></summary>
          <FareTable fare={b.fare} />
          {(b.overstaySurchargeHalalas ?? 0) > 0 && <p className="mt-2 text-xs text-danger">{L("Overstay surcharge", "رسوم التجاوز")}: <span className="num">{formatHalalas(b.overstaySurchargeHalalas!, lang)}</span></p>}
        </details>
      ) : (
        <p className="text-sm">{L("Total", "الإجمالي")} <span className="num font-semibold">{fmtSar(b.priceTotal - b.discountApplied, lang)}</span></p>
      )}

      {schedule && active && !ended && (
        <>
          {access ? (
            <div className="space-y-3">
              <div className="flex items-start gap-2 text-sm">
                <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-private" aria-hidden />
                <div>
                  <p className="font-semibold">{lang === "ar" ? access.addressAr : access.address}</p>
                  <a className="text-xs text-forest-3 underline" href={`https://www.google.com/maps/dir/?api=1&destination=${access.location.lat},${access.location.lng}`} target="_blank" rel="noreferrer">
                    {L("Directions to the exact bay", "الاتجاهات للموقف الدقيق")}
                  </a>
                </div>
              </div>
              {access.credential ? <Credential c={access.credential} /> : <Notice tone="info">{B(ACCESS_MODE_LABEL[access.accessMode])}</Notice>}
              {(lang === "ar" ? access.conditionsAr : access.conditions) && <p className="text-xs text-ink-2">{lang === "ar" ? access.conditionsAr : access.conditions}</p>}
            </div>
          ) : (
            <div className="flex items-center gap-2 rounded-xl border border-line p-3 text-xs text-ink-2">
              <ShieldCheck className="h-4 w-4 shrink-0 text-forest-3" aria-hidden />
              {b.accessOpen
                ? L("Your exact location and gate pass are ready.", "موقعك الدقيق وتصريح الدخول جاهزين.")
                : L(`Exact location and pass unlock ${fmtDateTime(b.accessUnlocksAt, "en")}.`, `الموقع الدقيق والتصريح يطلعون ${fmtDateTime(b.accessUnlocksAt, "ar")}.`)}
            </div>
          )}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {!access && <Button size="sm" variant="private" onClick={reveal} loading={busy === "reveal"}><Eye className="h-4 w-4" aria-hidden />{L("Show pass", "اعرض التصريح")}</Button>}
            {!b.arrivedAt && <Button size="sm" variant="secondary" onClick={checkIn} loading={busy === "arrived"}><LogIn className="h-4 w-4" aria-hidden />{L("I've arrived", "وصلت")}</Button>}
            <Button size="sm" variant="secondary" onClick={() => event("extended", {}, L("Extended by 1 hour.", "مدّدنا لك ساعة."))} loading={busy === "extended"}><Plus className="h-4 w-4" aria-hidden />{L("+1 hour", "+ساعة")}</Button>
            {b.arrivedAt && <Button size="sm" variant="primary" onClick={() => event("departed", {}, L("Checked out. Thanks!", "تم تسجيل طلعتك. يعطيك العافية!"))} loading={busy === "departed"}><LogOut className="h-4 w-4" aria-hidden />{L("Check out", "طلعت")}</Button>}
            <Button size="sm" variant="ghost" onClick={reportBlocked} loading={busy === "bay_blocked_reported"}><AlertOctagon className="h-4 w-4" aria-hidden />{L("Bay blocked", "الموقف مشغول")}</Button>
            {!b.arrivedAt && <Button size="sm" variant="ghost" onClick={() => run("cancel", () => api(`/api/bookings/${b.id}`, { method: "DELETE" }), L("Booking cancelled.", "انلغى الحجز."))} loading={busy === "cancel"}>{L("Cancel", "إلغاء")}</Button>}
          </div>
          {b.arrivedAt && <p className="flex items-center gap-1.5 text-[11px] text-mute"><Clock className="h-3.5 w-3.5" aria-hidden />{L("10-minute grace after the end; overstay is 1.5× the hourly rate.", "مهلة ١٠ دقايق بعد النهاية؛ التأخير بـ 1.5× سعر الساعة.")}</p>}
        </>
      )}
    </Card>
  );
}

function BookingsInner() {
  const { L, session } = useApp();
  const params = useSearchParams();
  const highlight = params.get("new");
  const [list, setList] = useState<MyBooking[] | null>(null);
  const isDriver = session?.user?.role === "driver";

  const load = useCallback(() => {
    if (!isDriver) return setList([]);
    api<{ bookings: MyBooking[] }>("/api/bookings").then((d) => setList(d.bookings)).catch(() => setList([]));
  }, [isDriver]);
  useEffect(load, [load, session?.user?.id]);

  const upcoming = (list ?? []).filter((b) => b.status === "confirmed" && Date.parse(b.endAt) >= Date.now());
  const past = (list ?? []).filter((b) => !upcoming.includes(b));

  return (
    <div className="space-y-6">
      <PageHeader eyebrow={L("Driver", "السائق")} title={L("My Bookings & Passes", "حجوزاتي وتصاريحي")} subtitle={L("Exact locations and gate passes appear here after payment, 30 minutes before each booking.", "المواقع الدقيقة وتصاريح الدخول تطلع هنا بعد الدفع، قبل كل حجز بـ ٣٠ دقيقة.")}>
        <div className="flex items-center gap-2">
          {session?.demoMode && <DemoTag />}
          <ButtonLink href="/" variant="private">{L("Find parking", "دوّر لك موقف")}</ButtonLink>
        </div>
      </PageHeader>
      {!isDriver ? (
        <Empty>{L("Pick a driver account (or sign in) to see your bookings.", "اختر حساب سائق (أو سجّل دخولك) عشان تشوف حجوزاتك.")}</Empty>
      ) : list === null ? (
        <Skeleton className="h-48" />
      ) : list.length === 0 ? (
        <Empty>{L("No bookings yet. Explore verified spaces on the map.", "ما عندك حجوزات للحين. شوف المواقف الموثقة على الخريطة.")}</Empty>
      ) : (
        <>
          <section className="space-y-3">
            <h2 className="text-lg font-bold">{L("Upcoming & active", "الجاية والشغّالة")}</h2>
            {upcoming.length ? upcoming.map((b) => <BookingCard key={b.id} b={b} highlight={b.id === highlight} onChanged={load} />) : <Empty>{L("Nothing upcoming.", "ما فيه شي جاي.")}</Empty>}
          </section>
          {past.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-lg font-bold">{L("History", "السجل")}</h2>
              {past.map((b) => <BookingCard key={b.id} b={b} highlight={false} onChanged={load} />)}
            </section>
          )}
        </>
      )}
    </div>
  );
}

export default function BookingsPage() {
  return (
    <Suspense fallback={<Skeleton className="h-48" />}>
      <BookingsInner />
    </Suspense>
  );
}
