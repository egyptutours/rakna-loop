"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, Check, Crosshair, ShieldCheck } from "lucide-react";
import { useApp } from "@/components/providers";
import { Button, Card, Empty, Field, Notice, PageHeader, Pill, cn, inputCls } from "@/components/ui";
import { RuleEditor, DEFAULT_RULE, validRule, type RuleDraft } from "@/components/rule-editor";
import { RuleSummary } from "@/components/home-ui";
import { api } from "@/lib/client/api";
import { DEMO_METRO_STATIONS, NEIGHBORHOODS } from "@/lib/config";
import { ALLOWED_ENTITLEMENTS, illustrativeMonthlyNetHalalas } from "@/lib/domain/home-schedule";
import { ACCESS_MODE_LABEL, ENTITLEMENT_LABEL, SHADE_LABEL, SPACE_CATEGORY_LABEL, formatHalalas } from "@/lib/i18n";
import type { AccessMode, EntitlementType, LatLng, ShadeTier, SpaceCategory } from "@/lib/types";

const CATEGORIES: SpaceCategory[] = ["condo_deeded", "condo_association", "villa_shaded", "villa_open", "villa_garage"];
const SHADES: ShadeTier[] = ["underground", "enclosed", "full_carport", "partial_shade", "uncovered"];
const ACCESS: AccessMode[] = ["unobstructed", "ephemeral_pin", "dynamic_qr", "guard_pass", "host_remote"];
const STEPS = [
  { en: "Space & entitlement", ar: "الموقف والأحقية" },
  { en: "Location", ar: "الموقع" },
  { en: "Details & access", ar: "التفاصيل والدخول" },
  { en: "Schedule & price", ar: "الجدول والسعر" },
  { en: "Review", ar: "المراجعة" },
];

const cm = (v: string) => (v === "" ? null : Math.round(Number(v)));

/** "List My Parking" wizard (RAKNA HOME). Every rule is re-checked on the server and in SQL. */
export default function ListMyParkingPage() {
  const { L, B, lang, session, toast, errorText } = useApp();
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [category, setCategory] = useState<SpaceCategory>("condo_deeded");
  const [entitlement, setEntitlement] = useState<EntitlementType>("deed_owner");
  const [consent, setConsent] = useState(false);
  const [noSublet, setNoSublet] = useState(false);
  const [location, setLocation] = useState<LatLng | null>(null);
  const [address, setAddress] = useState("");
  const [addressAr, setAddressAr] = useState("");
  const [title, setTitle] = useState("");
  const [titleAr, setTitleAr] = useState("");
  const [shade, setShade] = useState<ShadeTier>("underground");
  const [dims, setDims] = useState({ h: "210", w: "250", l: "520" });
  const [access, setAccess] = useState<AccessMode>("ephemeral_pin");
  const [buffer, setBuffer] = useState(15);
  const [instant, setInstant] = useState(true);
  const [metro, setMetro] = useState<string>("");
  const [conditions, setConditions] = useState("");
  const [rules, setRules] = useState<RuleDraft[]>([DEFAULT_RULE]);
  const [attest, setAttest] = useState(false);

  const isDriver = session?.user?.role === "driver";
  const allowed = ALLOWED_ENTITLEMENTS[category];
  const villa = category.startsWith("villa_");
  const ejar = entitlement === "ejar_authorized";
  const estimate = useMemo(() => illustrativeMonthlyNetHalalas(rules.map((r, i) => ({ ...r, id: String(i), spaceId: "", isActive: true, createdAt: "" }))), [rules]);

  const pickCategory = (c: SpaceCategory) => {
    setCategory(c);
    if (!ALLOWED_ENTITLEMENTS[c].includes(entitlement)) setEntitlement(ALLOWED_ENTITLEMENTS[c][0]);
  };

  const stepValid = [
    allowed.includes(entitlement) && (!ejar || (consent && noSublet)),
    location !== null && address.trim().length >= 3,
    title.trim().length >= 3 && buffer >= 0 && buffer <= 120,
    rules.length > 0 && rules.every(validRule),
    attest,
  ];

  const useMyLocation = () => {
    if (!("geolocation" in navigator)) return toast(L("Location isn't available in this browser.", "الموقع مو متاح في هذا المتصفح."), "error");
    navigator.geolocation.getCurrentPosition(
      (p) => setLocation({ lat: Number(p.coords.latitude.toFixed(6)), lng: Number(p.coords.longitude.toFixed(6)) }),
      () => toast(L("Location permission denied.", "رفضت إذن الموقع."), "error"),
      { enableHighAccuracy: true, timeout: 15_000 },
    );
  };

  const submit = async () => {
    if (!location) return;
    setBusy(true);
    try {
      await api("/api/home", {
        body: {
          spaceCategory: category,
          entitlementType: entitlement,
          ...(ejar ? { landlordConsentConfirmed: consent, noSubletClauseConfirmed: noSublet } : {}),
          title: title.trim(),
          titleAr: titleAr.trim(),
          location,
          address: address.trim(),
          addressAr: addressAr.trim(),
          shadeTier: shade,
          maxHeightCm: cm(dims.h),
          maxWidthCm: cm(dims.w),
          maxLengthCm: cm(dims.l),
          bufferMinutes: buffer,
          instantBook: instant,
          accessMode: access,
          metroStationCode: metro || null,
          conditions,
          conditionsAr: conditions,
          rules,
        },
      });
      toast(L("Submitted! An administrator will verify your entitlement.", "وصلنا طلبك! المشرف بيتحقق من أحقيتك."), "ok");
      router.push("/host");
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(false);
    }
  };

  if (!isDriver) return <Empty>{L("Pick a driver account (or sign in) to list your parking.", "اختر حساب سائق (أو سجّل دخولك) عشان تعرض موقفك.")}</Empty>;

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <PageHeader eyebrow="RAKNA HOME" title={L("List my parking", "اعرض موقفي")} subtitle={L("Rent out your idle villa carport or building bay — legally and privately.", "أجّر مظلة فلتك أو موقف عمارتك اللي ما تستخدمه — نظامي وبخصوصية.")} />

      <ol className="flex flex-wrap gap-2" aria-label={L("Steps", "الخطوات")}>
        {STEPS.map((s, i) => (
          <li key={i}>
            <button type="button" onClick={() => i <= step && setStep(i)} aria-current={i === step ? "step" : undefined} className={cn("flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold", i === step ? "border-forest bg-forest text-white" : i < step ? "border-private bg-private-soft text-private" : "border-line text-mute")}>
              {i < step ? <Check className="h-3 w-3" aria-hidden /> : <span className="num">{i + 1}</span>}
              {B(s)}
            </button>
          </li>
        ))}
      </ol>

      <Card className="space-y-4">
        {step === 0 && (
          <>
            <Field label={L("What are you listing?", "وش بتعرض؟")}>
              <div className="grid gap-2 sm:grid-cols-2">
                {CATEGORIES.map((c) => (
                  <button key={c} type="button" aria-pressed={category === c} onClick={() => pickCategory(c)} className={cn("rounded-xl border p-3 text-start text-sm font-semibold", category === c ? "border-forest bg-sage-soft text-forest" : "border-line")}>
                    {B(SPACE_CATEGORY_LABEL[c])}
                  </button>
                ))}
              </div>
            </Field>
            {villa && <Notice tone="info">{L("Villa spaces join a waitlist until the municipal pilot opens villa bookings. You can still set everything up now.", "مواقف الفلل تنضم لقائمة انتظار لين تفتح التجربة البلدية حجوزات الفلل. تقدر تجهّز كل شي من الحين.")}</Notice>}
            {category === "condo_association" && <Notice tone="info">{L("Common-property building bays belong to all owners: only the owners' association (with a resolution) can list them.", "مواقف الأجزاء المشتركة ملك لكل الملاك: ما يعرضها إلا اتحاد الملاك (بقرار منه).")}</Notice>}
            <Field label={L("Your right to rent it out", "أحقيتك في التأجير")} hint={L("Documents are reviewed by an administrator; RAKNA never stores your deed or contract.", "المشرف يراجع المستندات؛ ركنة ما تحتفظ بصكك ولا عقدك.")}>
              <div className="grid gap-2">
                {allowed.map((e) => (
                  <label key={e} className={cn("flex items-center gap-2 rounded-xl border p-3 text-sm", entitlement === e ? "border-forest bg-sage-mist" : "border-line")}>
                    <input type="radio" name="entitlement" checked={entitlement === e} onChange={() => setEntitlement(e)} />
                    {B(ENTITLEMENT_LABEL[e])}
                  </label>
                ))}
              </div>
            </Field>
            {ejar && (
              <div className="space-y-2 rounded-xl border border-warn/30 bg-warn-soft p-3 text-sm">
                <label className="flex gap-2"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />{L("I have my landlord's written consent to sub-let this parking space.", "عندي موافقة مكتوبة من المالك على تأجير هذا الموقف من الباطن.")}</label>
                <label className="flex gap-2"><input type="checkbox" checked={noSublet} onChange={(e) => setNoSublet(e.target.checked)} />{L("My Ejar contract does not prohibit sub-letting.", "عقد إيجار حقي ما يمنع التأجير من الباطن.")}</label>
              </div>
            )}
          </>
        )}

        {step === 1 && (
          <>
            <Notice tone="info">
              <span className="flex gap-1.5"><ShieldCheck className="h-4 w-4 shrink-0" aria-hidden />{L("Drivers see only a ~150 m area until they've paid. Your exact address is revealed only to a confirmed, paid driver from 30 minutes before their booking.", "السائقين يشوفون منطقة تقريبية ~150 م بس لين يدفعون. عنوانك الدقيق يطلع فقط لسائق حجزه مؤكد ومدفوع، قبل حجزه بـ ٣٠ دقيقة.")}</span>
            </Notice>
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="secondary" onClick={useMyLocation}><Crosshair className="h-4 w-4" aria-hidden />{L("Use my current location", "استخدم موقعي الحالي")}</Button>
              {session?.demoMode && NEIGHBORHOODS.map((n) => (
                <Button key={n.id} type="button" size="sm" variant="ghost" onClick={() => setLocation({ lat: Number((n.center.lat + 0.0012).toFixed(6)), lng: Number((n.center.lng - 0.0009).toFixed(6)) })}>{lang === "ar" ? n.nameAr : n.name} ({L("demo", "تجريبي")})</Button>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Field label={L("Latitude", "خط العرض")}><input type="number" step="0.000001" dir="ltr" className={inputCls} value={location?.lat ?? ""} onChange={(e) => setLocation({ lat: Number(e.target.value), lng: location?.lng ?? 46.67 })} /></Field>
              <Field label={L("Longitude", "خط الطول")}><input type="number" step="0.000001" dir="ltr" className={inputCls} value={location?.lng ?? ""} onChange={(e) => setLocation({ lat: location?.lat ?? 24.71, lng: Number(e.target.value) })} /></Field>
            </div>
            <Field label={L("Address (English)", "العنوان (بالإنجليزي)")}><input className={inputCls} value={address} onChange={(e) => setAddress(e.target.value)} maxLength={200} /></Field>
            <Field label={L("Address (Arabic)", "العنوان (بالعربي)")}><input className={inputCls} dir="rtl" value={addressAr} onChange={(e) => setAddressAr(e.target.value)} maxLength={200} /></Field>
          </>
        )}

        {step === 2 && (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={L("Title (English)", "اسم الموقف (بالإنجليزي)")}><input className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} placeholder="Basement bay B-14" /></Field>
              <Field label={L("Title (Arabic)", "اسم الموقف (بالعربي)")}><input className={inputCls} dir="rtl" value={titleAr} onChange={(e) => setTitleAr(e.target.value)} maxLength={120} placeholder="موقف القبو B-14" /></Field>
            </div>
            <Field label={L("Shade", "التظليل")}>
              <div className="flex flex-wrap gap-2">{SHADES.map((s) => <button key={s} type="button" aria-pressed={shade === s} onClick={() => setShade(s)} className={cn("rounded-lg border px-3 py-1.5 text-xs font-semibold", shade === s ? "border-forest bg-forest text-white" : "border-line")}>{B(SHADE_LABEL[s])}</button>)}</div>
            </Field>
            <div className="grid grid-cols-3 gap-2">
              <Field label={L("Max height (cm)", "أقصى ارتفاع (سم)")}><input type="number" dir="ltr" className={inputCls} value={dims.h} onChange={(e) => setDims({ ...dims, h: e.target.value })} /></Field>
              <Field label={L("Width (cm)", "العرض (سم)")}><input type="number" dir="ltr" className={inputCls} value={dims.w} onChange={(e) => setDims({ ...dims, w: e.target.value })} /></Field>
              <Field label={L("Length (cm)", "الطول (سم)")}><input type="number" dir="ltr" className={inputCls} value={dims.l} onChange={(e) => setDims({ ...dims, l: e.target.value })} /></Field>
            </div>
            <Field label={L("How does the driver get in?", "كيف يدخل السائق؟")} hint={L("PIN / QR / guard codes are generated per booking and expire automatically.", "رموز البوابة/QR/الحارس تنسوّى لكل حجز وتنتهي تلقائيًا.")}>
              <select className={inputCls} value={access} onChange={(e) => setAccess(e.target.value as AccessMode)}>{ACCESS.map((a) => <option key={a} value={a}>{B(ACCESS_MODE_LABEL[a])}</option>)}</select>
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={L("Turnaround buffer (minutes)", "وقت التجهيز بين الحجوزات (دقايق)")}><input type="number" min={0} max={120} dir="ltr" className={inputCls} value={buffer} onChange={(e) => setBuffer(Math.round(Number(e.target.value)))} /></Field>
              <Field label={L("Nearby Metro station (Park & Connect)", "محطة مترو قريبة (اركن واتصل)")}>
                <select className={inputCls} value={metro} onChange={(e) => setMetro(e.target.value)}>
                  <option value="">{L("None", "ما فيه")}</option>
                  {DEMO_METRO_STATIONS.map((m) => <option key={m.code} value={m.code}>{lang === "ar" ? m.nameAr : m.name}</option>)}
                </select>
              </Field>
            </div>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={instant} onChange={(e) => setInstant(e.target.checked)} />{L("Instant booking (no manual approval)", "حجز فوري (بدون موافقة يدوية)")}</label>
            <Field label={L("Rules for drivers (optional)", "تعليمات للسائقين (اختياري)")}><textarea className={cn(inputCls, "h-20 py-2")} maxLength={500} value={conditions} onChange={(e) => setConditions(e.target.value)} /></Field>
          </>
        )}

        {step === 3 && (
          <>
            <RuleEditor rules={rules} onChange={setRules} />
            <div className="rounded-xl bg-gold-soft p-3 text-sm text-gold">
              {L("Illustrative monthly net at 30% occupancy", "صافي شهري تقريبي إذا كان الإشغال 30%")}: <span className="num font-bold">{formatHalalas(estimate, lang)}</span>
              <p className="mt-1 text-[11px] text-ink-2">{L("You keep 85% of the base fare (15% commission). Drivers pay a separate 5% service fee + VAT on platform fees. Estimates are not guarantees.", "لك 85% من الأجرة الأساسية (العمولة 15%). السائق يدفع رسوم خدمة 5% لحالها + ضريبة على رسوم المنصة. هذي تقديرات وليست ضمان.")}</p>
            </div>
          </>
        )}

        {step === 4 && (
          <>
            <div className="flex flex-wrap gap-2">
              <Pill>{B(SPACE_CATEGORY_LABEL[category])}</Pill>
              <Pill>{B(ENTITLEMENT_LABEL[entitlement])}</Pill>
              <Pill>{B(SHADE_LABEL[shade])}</Pill>
              <Pill>{B(ACCESS_MODE_LABEL[access])}</Pill>
              {villa && <Pill tone="warn">{L("Waitlist", "قائمة انتظار")}</Pill>}
            </div>
            <p className="font-semibold">{lang === "ar" ? titleAr || title : title}</p>
            <p className="text-sm text-ink-2">{lang === "ar" ? addressAr || address : address}</p>
            <ul className="space-y-2">{rules.map((r, i) => <RuleSummary key={i} rule={r} />)}</ul>
            <label className="flex gap-2 rounded-xl border border-line p-3 text-sm">
              <input type="checkbox" checked={attest} onChange={(e) => setAttest(e.target.checked)} />
              {L("I confirm the information is accurate and that I'm entitled to rent out this space. I'll provide my deed, wakalah, Ejar consent or association resolution to the RAKNA administrator on request.", "أقرّ إن المعلومات صحيحة وإن لي الحق في تأجير هذا الموقف، وأتعهد أقدّم الصك أو الوكالة أو موافقة المالك في إيجار أو قرار الاتحاد لمشرف ركنة إذا طلبها.")}
            </label>
          </>
        )}

        <div className="flex justify-between gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0}>
            <ArrowLeft className="h-4 w-4 rtl:rotate-180" aria-hidden />{L("Back", "رجوع")}
          </Button>
          {step < STEPS.length - 1 ? (
            <Button type="button" onClick={() => setStep((s) => s + 1)} disabled={!stepValid[step]}>
              {L("Next", "التالي")}<ArrowRight className="h-4 w-4 rtl:rotate-180" aria-hidden />
            </Button>
          ) : (
            <Button type="button" variant="private" onClick={submit} loading={busy} disabled={!stepValid.every(Boolean)}>{L("Submit for verification", "أرسل للتحقق")}</Button>
          )}
        </div>
      </Card>
    </div>
  );
}
