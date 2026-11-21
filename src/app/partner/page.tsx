"use client";

import { useCallback, useEffect, useState } from "react";
import { Building2, Clock3, Plus } from "lucide-react";
import { useApp } from "@/components/providers";
import { Button, Card, DemoTag, Empty, Field, Keys, Notice, PageHeader, Pill, SectionTitle, Skeleton, Stat, cn, inputCls } from "@/components/ui";
import { api } from "@/lib/client/api";
import { fmtDateTime, fmtSar } from "@/lib/client/format";
import { NEIGHBORHOODS } from "@/lib/config";
import { DAY_SHORT, NEIGHBORHOOD_LABEL } from "@/lib/i18n";
import type { ParkingBooking, ParkingPartner, ParkingSpace, RewardItem } from "@/lib/types";

interface Dash {
  partner: ParkingPartner | null;
  spaces: ParkingSpace[];
  bookings: ParkingBooking[];
  stats: { totalBookings: number; occupancy7d: number; estimatedRevenue: number; discountsFunded: number } | null;
  eligibleRewards: RewardItem[];
}

const APPROVAL: Record<ParkingSpace["approval"], { en: string; ar: string; tone: "private" | "warn" | "danger" | "inactive" }> = {
  approved: { en: "Approved", ar: "معتمد", tone: "private" },
  pending_review: { en: "Pending review", ar: "قيد المراجعة", tone: "warn" },
  rejected: { en: "Rejected", ar: "مرفوض", tone: "danger" },
  paused: { en: "Paused", ar: "موقّف مؤقتًا", tone: "inactive" },
};

/** SCREEN 8 — Parking partner dashboard. */
export default function PartnerPage() {
  const { L, B, lang, session, toast, errorText } = useApp();
  const [d, setD] = useState<Dash | null>(null);
  const [showForm, setShowForm] = useState(false);

  const load = useCallback(() => api<Dash>("/api/partner").then(setD).catch((e) => toast(errorText(e), "error")), [toast, errorText]);
  useEffect(() => {
    if (session?.user?.role === "partner") void load();
  }, [load, session?.user?.id, session?.user?.role]);

  if (session && session.user?.role !== "partner") return <Card className="mx-auto max-w-lg text-center text-sm">{L("Switch to the demo parking partner account to open this dashboard.", "حوّل لحساب الشريك التجريبي عشان تفتح هذي اللوحة.")}</Card>;
  if (!d) return <Skeleton className="h-96" />;
  if (!d.partner) return <PartnerApplication onDone={load} />;

  const p = d.partner;
  const toggle = async (s: ParkingSpace, patch: { rewardEligible?: boolean; paused?: boolean }) => {
    try {
      await api(`/api/spaces/${s.id}`, { method: "PATCH", body: patch });
      await load();
    } catch (e) {
      toast(errorText(e), "error");
    }
  };

  return (
    <div>
      <PageHeader eyebrow={L("Parking partner", "شريك مواقف")} title={lang === "ar" ? p.nameAr : p.name} subtitle={L("Manage authorized listings, schedules, bookings and reward eligibility.", "أدِر إعلاناتك المعتمدة والجداول والحجوزات وأهلية المكافآت.")}>
        <div className="flex items-center gap-2">
          <Pill tone={p.status === "approved" ? "private" : p.status === "pending" ? "warn" : "danger"}>{B({ approved: { en: "Approved partner", ar: "شريك معتمد" }, pending: { en: "Application pending", ar: "الطلب تحت المراجعة" }, rejected: { en: "Rejected", ar: "مرفوض" }, suspended: { en: "Suspended", ar: "موقوف" } }[p.status])}</Pill>
          {p.isDemo && <DemoTag />}
        </div>
      </PageHeader>

      {p.status !== "approved" && <Notice>{L("Your application is being reviewed. You can list spaces once an administrator approves your partner account.", "طلبك تحت المراجعة. تقدر تعرض مواقفك بعد ما يعتمد المشرف حساب الشريك.")}</Notice>}

      {d.stats && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label={L("Listed spaces", "المواقف المعروضة")} value={d.spaces.length} />
          <Stat label={L("Bookings", "الحجوزات")} value={d.stats.totalBookings} tone="private" />
          <Stat label={L("Occupancy (next 7 days)", "الإشغال (الـ7 أيام الجاية)")} value={`${Math.round(d.stats.occupancy7d * 100)}%`} />
          <Stat label={L("Estimated revenue (simulated)", "الدخل المتوقع (محاكاة)")} value={fmtSar(d.stats.estimatedRevenue, lang)} tone="gold" />
        </div>
      )}

      <section className="mt-8">
        <SectionTitle
          title={L("Listed spaces & availability", "المواقف والتوفر")}
          action={p.status === "approved" && <Button size="sm" onClick={() => setShowForm((s) => !s)}><Plus className="h-4 w-4" aria-hidden />{L("Submit a space", "أضف موقف")}</Button>}
        />
        {showForm && <SpaceForm onDone={() => { setShowForm(false); void load(); }} />}
        <div className="grid gap-3 md:grid-cols-2">
          {d.spaces.map((s) => (
            <Card key={s.id}>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="font-bold">{lang === "ar" ? s.titleAr : s.title}</p>
                  <p className="text-xs text-mute">{B(NEIGHBORHOOD_LABEL[s.neighborhood])} · {lang === "ar" ? s.addressAr : s.address}</p>
                </div>
                <Pill tone={APPROVAL[s.approval].tone}>{B(APPROVAL[s.approval])}</Pill>
              </div>
              <div className="mt-3 flex flex-wrap gap-2 text-xs">
                <Pill>{fmtSar(s.pricePerHour, lang)}/{L("h", "س")}</Pill>
                <Pill>{L("Capacity", "السعة")} <span className="num">{s.capacity}</span></Pill>
                <Pill><Clock3 className="h-3 w-3" aria-hidden />{s.schedule.days.map((x) => B(DAY_SHORT[x])).join(" ")} <span className="num">{s.schedule.openHour}–{s.schedule.closeHour}</span></Pill>
              </div>
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3">
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={s.rewardEligible} onChange={(e) => toggle(s, { rewardEligible: e.target.checked })} className="h-4 w-4 accent-[var(--color-gold)]" />
                  {L("Accept RAKNA KEYS discounts", "اقبل خصومات مفاتيح ركنة")}
                </label>
                {(s.approval === "approved" || s.approval === "paused") && (
                  <Button size="sm" variant="secondary" onClick={() => toggle(s, { paused: s.approval === "approved" })}>
                    {s.approval === "approved" ? L("Pause listing", "وقّف مؤقتًا") : L("Resume listing", "كمّل")}
                  </Button>
                )}
              </div>
            </Card>
          ))}
        </div>
      </section>

      <div className="mt-8 grid gap-6 lg:grid-cols-[1.5fr_1fr]">
        <section>
          <SectionTitle title={L("Reservations", "الحجوزات")} />
          <Card className="overflow-x-auto p-0">
            {d.bookings.length === 0 ? <div className="p-5"><Empty>{L("No bookings yet.", "ما فيه حجوزات للحين.")}</Empty></div> : (
              <table className="w-full min-w-[520px] text-sm">
                <thead className="bg-sage-mist text-xs text-mute">
                  <tr><th className="p-3 text-start font-medium">{L("Space", "الموقف")}</th><th className="p-3 text-start font-medium">{L("Start", "البداية")}</th><th className="p-3 text-start font-medium">{L("Hours", "الساعات")}</th><th className="p-3 text-start font-medium">{L("Net", "الصافي")}</th><th className="p-3 text-start font-medium">{L("Status", "الحالة")}</th></tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {d.bookings.map((b) => {
                    const s = d.spaces.find((x) => x.id === b.spaceId);
                    return (
                      <tr key={b.id}>
                        <td className="p-3">{s ? (lang === "ar" ? s.titleAr : s.title) : "—"}</td>
                        <td className="p-3 text-xs">{fmtDateTime(b.startAt, lang)}</td>
                        <td className="num p-3">{b.hours}</td>
                        <td className="p-3">{fmtSar(b.priceTotal - b.discountApplied, lang)}</td>
                        <td className="p-3"><Pill tone={b.status === "cancelled" ? "inactive" : "private"}>{b.status}</Pill></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </Card>
        </section>
        <section>
          <SectionTitle title={L("Partner rewards configuration", "إعداد مكافآت الشريك")} />
          <Card>
            <p className="text-xs text-mute">{L("Discounts drivers can apply at your spaces that accept RAKNA KEYS. Discounts are simulated; funding arrangements will be agreed with each partner before launch.", "الخصومات اللي يقدر السائقين يطبقونها في مواقفك اللي تقبل مفاتيح ركنة. الخصومات محاكاة، وبنتفق على التمويل مع كل شريك قبل الإطلاق.")}</p>
            <ul className="mt-3 space-y-2">
              {d.eligibleRewards.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-2 rounded-xl bg-sage-mist p-3 text-sm">
                  <span>{lang === "ar" ? r.titleAr : r.title}</span>
                  <Keys n={r.keysRequired} size="sm" />
                </li>
              ))}
            </ul>
            {d.stats && <p className="mt-3 text-xs text-mute">{L("Discounts applied so far:", "مجموع الخصومات المطبقة:")} {fmtSar(d.stats.discountsFunded, lang)}</p>}
          </Card>
        </section>
      </div>
    </div>
  );
}

function PartnerApplication({ onDone }: { onDone: () => void }) {
  const { L, toast, errorText } = useApp();
  const [f, setF] = useState({ name: "", nameAr: "", kind: "hotel", contactEmail: "", crNumberProvided: false });
  const [busy, setBusy] = useState(false);
  return (
    <div className="mx-auto max-w-xl">
      <PageHeader eyebrow={L("Become a partner", "صير شريك")} title={L("Register as a parking partner", "سجّل كشريك مواقف")} subtitle={L("Only owners or authorized operators may list private parking. An administrator verifies every application.", "يحق فقط للملاك أو المشغّلين المفوّضين يعرضون مواقف خاصة. المشرف يتحقق من كل طلب.")} />
      <Card className="space-y-4">
        <Field label={L("Business name", "اسم المنشأة")}><input className={inputCls} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label={L("Business name (Arabic)", "اسم المنشأة (بالعربي)")}><input className={inputCls} value={f.nameAr} onChange={(e) => setF({ ...f, nameAr: e.target.value })} /></Field>
        <Field label={L("Type", "النوع")}>
          <select className={inputCls} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
            {[["hotel", "Hotel", "فندق"], ["office", "Office building", "مبنى مكاتب"], ["mall", "Mall", "مول"], ["operator", "Parking operator", "مشغل مواقف"], ["residential", "Residential compound", "مجمع سكني"]].map(([v, en, ar]) => <option key={v} value={v}>{L(en, ar)}</option>)}
          </select>
        </Field>
        <Field label={L("Business contact email", "البريد الإلكتروني للمنشأة")}><input type="email" className={inputCls} value={f.contactEmail} onChange={(e) => setF({ ...f, contactEmail: e.target.value })} /></Field>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" checked={f.crNumberProvided} onChange={(e) => setF({ ...f, crNumberProvided: e.target.checked })} className="mt-1 h-4 w-4" />
          {L("I can provide a Commercial Registration and proof of authority over the parking (verified offline in the MVP).", "أقدر أقدّم السجل التجاري وإثبات الصلاحية على المواقف (التحقق منها يتم خارج النظام في هذي النسخة).")}
        </label>
        <Button className="w-full" loading={busy} onClick={async () => { setBusy(true); try { await api("/api/partner", { body: f }); toast(L("Application submitted.", "انرسل الطلب."), "ok"); onDone(); } catch (e) { toast(errorText(e), "error"); } finally { setBusy(false); } }}>
          {L("Submit application", "أرسل الطلب")}
        </Button>
      </Card>
    </div>
  );
}

function SpaceForm({ onDone }: { onDone: () => void }) {
  const { L, B, toast, errorText } = useApp();
  const [hood, setHood] = useState("olaya");
  const center = NEIGHBORHOODS.find((n) => n.id === hood)!.center;
  const [f, setF] = useState({ title: "", titleAr: "", address: "", addressAr: "", capacity: 10, pricePerHour: 8, openHour: 7, closeHour: 22, days: [0, 1, 2, 3, 4, 5, 6], conditions: "", conditionsAr: "", rewardEligible: true, lat: "", lng: "" });
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      await api("/api/spaces", {
        body: {
          title: f.title, titleAr: f.titleAr, address: f.address, addressAr: f.addressAr, capacity: Number(f.capacity), pricePerHour: Number(f.pricePerHour),
          location: { lat: f.lat ? Number(f.lat) : center.lat, lng: f.lng ? Number(f.lng) : center.lng },
          schedule: { days: f.days, openHour: Number(f.openHour), closeHour: Number(f.closeHour) },
          conditions: f.conditions, conditionsAr: f.conditionsAr, rewardEligible: f.rewardEligible,
        },
      });
      toast(L("Space submitted for admin review.", "انرسل الموقف لمراجعة المشرف."), "ok");
      onDone();
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="mb-4 border-forest/20">
      <h3 className="mb-4 flex items-center gap-2 font-bold"><Building2 className="h-5 w-5" aria-hidden />{L("New private space (enters admin review)", "موقف خاص جديد (يمر على مراجعة المشرف)")}</h3>
      <div className="grid gap-4 md:grid-cols-2">
        <Field label={L("Title", "العنوان")}><input className={inputCls} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
        <Field label={L("Title (Arabic)", "العنوان (بالعربي)")}><input className={inputCls} value={f.titleAr} onChange={(e) => setF({ ...f, titleAr: e.target.value })} /></Field>
        <Field label={L("Address", "العنوان التفصيلي")}><input className={inputCls} value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></Field>
        <Field label={L("Neighborhood", "الحي")}>
          <select className={inputCls} value={hood} onChange={(e) => setHood(e.target.value)}>{NEIGHBORHOODS.map((n) => <option key={n.id} value={n.id}>{B(NEIGHBORHOOD_LABEL[n.id])}</option>)}</select>
        </Field>
        <Field label={L("Latitude (optional)", "خط العرض (اختياري)")} hint={L("Defaults to the neighborhood center.", "الافتراضي وسط الحي.")}><input className={inputCls} inputMode="decimal" value={f.lat} onChange={(e) => setF({ ...f, lat: e.target.value })} placeholder={String(center.lat)} /></Field>
        <Field label={L("Longitude (optional)", "خط الطول (اختياري)")}><input className={inputCls} inputMode="decimal" value={f.lng} onChange={(e) => setF({ ...f, lng: e.target.value })} placeholder={String(center.lng)} /></Field>
        <Field label={L("Capacity (spaces)", "السعة (مواقف)")}><input type="number" min={1} className={inputCls} value={f.capacity} onChange={(e) => setF({ ...f, capacity: Number(e.target.value) })} /></Field>
        <Field label={L("Price per hour (SAR)", "السعر بالساعة (ريال)")}><input type="number" min={0} step={0.5} className={inputCls} value={f.pricePerHour} onChange={(e) => setF({ ...f, pricePerHour: Number(e.target.value) })} /></Field>
        <Field label={L("Opens (hour)", "يفتح (الساعة)")}><input type="number" min={0} max={23} className={inputCls} value={f.openHour} onChange={(e) => setF({ ...f, openHour: Number(e.target.value) })} /></Field>
        <Field label={L("Closes (hour)", "يقفل (الساعة)")}><input type="number" min={1} max={24} className={inputCls} value={f.closeHour} onChange={(e) => setF({ ...f, closeHour: Number(e.target.value) })} /></Field>
      </div>
      <div className="mt-4">
        <span className="mb-1.5 block text-sm font-medium text-ink-2">{L("Available days", "الأيام المتاحة")}</span>
        <div className="flex flex-wrap gap-2">
          {DAY_SHORT.map((d, i) => (
            <button key={i} type="button" aria-pressed={f.days.includes(i)} onClick={() => setF({ ...f, days: f.days.includes(i) ? f.days.filter((x) => x !== i) : [...f.days, i].sort() })} className={cn("rounded-lg border px-3 py-1.5 text-xs font-semibold", f.days.includes(i) ? "border-forest bg-forest text-white" : "border-line bg-card")}>{B(d)}</button>
          ))}
        </div>
      </div>
      <div className="mt-4"><Field label={L("Booking conditions", "شروط الحجز")}><textarea className={cn(inputCls, "h-20 py-2")} value={f.conditions} onChange={(e) => setF({ ...f, conditions: e.target.value })} /></Field></div>
      <label className="mt-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={f.rewardEligible} onChange={(e) => setF({ ...f, rewardEligible: e.target.checked })} className="h-4 w-4" />{L("Accept RAKNA KEYS discounts", "اقبل خصومات مفاتيح ركنة")}</label>
      <Button className="mt-4" onClick={submit} loading={busy}>{L("Submit for review", "أرسل للمراجعة")}</Button>
    </Card>
  );
}
