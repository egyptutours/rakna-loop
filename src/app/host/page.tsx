"use client";

import { useCallback, useEffect, useState } from "react";
import { CalendarX, Home, Pencil, Plus } from "lucide-react";
import { useApp } from "@/components/providers";
import { Button, ButtonLink, Card, DemoTag, Empty, Field, Notice, PageHeader, Pill, Skeleton, Stat, inputCls } from "@/components/ui";
import { RuleSummary } from "@/components/home-ui";
import { RuleEditor, toDraft, validRule, type RuleDraft } from "@/components/rule-editor";
import { api } from "@/lib/client/api";
import { fmtDateTime } from "@/lib/client/format";
import { ENTITLEMENT_LABEL, PAYMENT_STATUS_LABEL, SPACE_CATEGORY_LABEL, VERIFICATION_LABEL, formatHalalas } from "@/lib/i18n";
import type { AvailabilityException, AvailabilityRule, ParkingSpace, PaymentStatus } from "@/lib/types";

interface HostSpace extends ParkingSpace {
  waitlisted: boolean;
  rules: AvailabilityRule[];
  exceptions: AvailabilityException[];
  estimatedMonthlyNetHalalas: number;
}

interface Dashboard {
  settings: { villaBookingsEnabled: boolean };
  spaces: HostSpace[];
  bookings: { id: string; spaceId: string; startAt: string; endAt: string; status: string; paymentStatus: PaymentStatus; hostNetPayoutHalalas: number; overstaySurchargeHalalas: number; arrivedAt: string | null; departedAt: string | null }[];
  stats: { totalBookings: number; hostNetEarnedHalalas: number };
}

function SpaceCard({ s, onSaved }: { s: HostSpace; onSaved: () => void }) {
  const { L, B, lang, toast, errorText } = useApp();
  const [editing, setEditing] = useState(false);
  const [rules, setRules] = useState<RuleDraft[]>(s.rules.filter((r) => r.isActive).map(toDraft));
  const [blockDate, setBlockDate] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const tone = s.verificationStatus === "verified" ? "forest" : s.verificationStatus === "pending" || !s.verificationStatus ? "warn" : "danger";

  const save = async () => {
    setBusy("save");
    try {
      await api(`/api/spaces/${s.id}/schedule`, { body: { rules } });
      toast(L("Schedule saved.", "انحفظ الجدول."), "ok");
      setEditing(false);
      onSaved();
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(null);
    }
  };

  const block = async () => {
    if (!blockDate) return;
    setBusy("block");
    try {
      await api(`/api/spaces/${s.id}/exceptions`, { body: { exceptionDate: blockDate, isBlocked: true } });
      toast(L("Date blocked.", "انحجب التاريخ."), "ok");
      setBlockDate("");
      onSaved();
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-semibold">{lang === "ar" ? s.titleAr : s.title}</p>
          <p className="text-xs text-mute">{lang === "ar" ? s.addressAr : s.address}</p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Pill>{B(SPACE_CATEGORY_LABEL[s.spaceCategory ?? "commercial"])}</Pill>
          <Pill tone={tone}>{B(VERIFICATION_LABEL[s.verificationStatus ?? "verified"])}</Pill>
          {s.waitlisted && <Pill tone="warn">{L("Waitlist (villa pilot)", "قائمة انتظار (تجربة الفلل)")}</Pill>}
          {s.isDemo && <DemoTag />}
        </div>
      </div>
      {s.entitlementType && <p className="text-xs text-ink-2">{L("Entitlement", "الأحقية")}: {B(ENTITLEMENT_LABEL[s.entitlementType])}</p>}
      {s.verificationStatus === "pending" && <Notice tone="info">{L("An administrator is reviewing your title deed / authorization. Your space stays hidden from drivers until it is verified.", "المشرف يراجع صك الملكية أو التفويض. موقفك يظل مخفي عن السائقين لين يتم التحقق.")}</Notice>}

      {editing ? (
        <>
          <RuleEditor rules={rules} onChange={setRules} />
          <div className="flex gap-2">
            <Button onClick={save} loading={busy === "save"} disabled={!rules.every(validRule)}>{L("Save schedule", "احفظ الجدول")}</Button>
            <Button variant="ghost" onClick={() => setEditing(false)}>{L("Cancel", "إلغاء")}</Button>
          </div>
        </>
      ) : (
        <>
          <ul className="space-y-2">{s.rules.filter((r) => r.isActive).map((r) => <RuleSummary key={r.id} rule={r} />)}</ul>
          <div className="flex flex-wrap items-end gap-2">
            <Button size="sm" variant="secondary" onClick={() => setEditing(true)}><Pencil className="h-4 w-4" aria-hidden />{L("Edit schedule", "عدّل الجدول")}</Button>
            <div className="flex items-end gap-2">
              <Field label={L("Block a date", "احجب تاريخ")}>
                <input type="date" dir="ltr" className={inputCls} value={blockDate} onChange={(e) => setBlockDate(e.target.value)} />
              </Field>
              <Button size="sm" variant="ghost" onClick={block} loading={busy === "block"} disabled={!blockDate}><CalendarX className="h-4 w-4" aria-hidden />{L("Block", "احجب")}</Button>
            </div>
          </div>
          {s.exceptions.length > 0 && (
            <p className="text-xs text-mute">
              {L("Blocked / changed dates", "تواريخ محجوبة أو متعدّلة")}: <span dir="ltr" className="num">{s.exceptions.map((e) => e.exceptionDate).join(", ")}</span>
            </p>
          )}
        </>
      )}
      <p className="text-xs text-mute">
        {L("Illustrative monthly net at 30% occupancy", "صافي شهري تقريبي إذا كان الإشغال 30%")}: <span className="num font-semibold text-forest">{formatHalalas(s.estimatedMonthlyNetHalalas, lang)}</span> · {L("an estimate, not a guarantee", "تقدير وليس ضمان")}
      </p>
    </Card>
  );
}

/** Host Dashboard (RAKNA HOME). */
export default function HostDashboardPage() {
  const { L, B, lang, session } = useApp();
  const [d, setD] = useState<Dashboard | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const isDriver = session?.user?.role === "driver";

  const load = useCallback(() => {
    if (!isDriver) return;
    api<Dashboard>("/api/home").then(setD).catch((e) => setErr(String(e?.message ?? e)));
  }, [isDriver]);
  useEffect(load, [load, session?.user?.id]);

  if (!isDriver) return <Empty>{L("Hosting is available to driver accounts. Pick a driver account (or sign in).", "الاستضافة لحسابات السائقين. اختر حساب سائق (أو سجّل دخولك).")}</Empty>;
  if (err) return <Notice tone="danger">{err}</Notice>;
  if (!d) return <Skeleton className="h-96" />;
  const titleOf = (id: string) => {
    const s = d.spaces.find((x) => x.id === id);
    return s ? (lang === "ar" ? s.titleAr : s.title) : "";
  };

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="RAKNA HOME" title={L("Host dashboard", "لوحة المضيف")} subtitle={L("Earn from your idle bay. You keep 85% of every booking; RAKNA KEYS discounts never reduce your payout.", "اكسب من موقفك اللي ما تستخدمه. لك 85% من كل حجز، وخصومات مفاتيح ركنة ما تنقص من مستحقاتك أبدًا.")}>
        <ButtonLink href="/host/list" variant="private"><Plus className="h-4 w-4" aria-hidden />{L("List my parking", "اعرض موقفي")}</ButtonLink>
      </PageHeader>

      {!d.settings.villaBookingsEnabled && <Notice tone="info">{L("Villa carports are onboarding to a waitlist while the municipal pilot is pending. Building bays (deeded or owners' association) and commercial spaces are bookable once verified.", "مظلات الفلل تنضم لقائمة انتظار لين تنعتمد التجربة البلدية. مواقف العمائر (بصك أو باتحاد ملاك) والمواقف التجارية تنحجز بعد التحقق.")}</Notice>}

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label={L("Spaces", "المواقف")} value={d.spaces.length} />
        <Stat label={L("Bookings", "الحجوزات")} value={d.stats.totalBookings} tone="private" />
        <Stat label={L("Net earned (incl. overstay)", "الصافي اللي كسبته (مع التأخير)")} value={formatHalalas(d.stats.hostNetEarnedHalalas, lang)} tone="gold" />
      </div>

      <section className="space-y-3">
        <h2 className="text-lg font-bold">{L("My spaces", "مواقفي")}</h2>
        {d.spaces.length === 0 ? (
          <Empty>
            <Home className="mx-auto mb-2 h-6 w-6" aria-hidden />
            {L("You haven't listed a space yet.", "ما عرضت أي موقف للحين.")} <ButtonLink href="/host/list" variant="ghost">{L("List my parking", "اعرض موقفي")}</ButtonLink>
          </Empty>
        ) : (
          d.spaces.map((s) => <SpaceCard key={s.id} s={s} onSaved={load} />)
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-bold">{L("Bookings on my spaces", "الحجوزات على مواقفي")}</h2>
        <p className="text-xs text-mute">{L("Drivers' identities are not shared with hosts.", "هوية السائقين ما تنعرض للمضيفين.")}</p>
        {d.bookings.length === 0 ? (
          <Empty>{L("No bookings yet.", "ما فيه حجوزات للحين.")}</Empty>
        ) : (
          <div className="overflow-x-auto rounded-2xl border border-line bg-card">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="bg-sage-mist text-start text-xs text-mute">
                <tr>
                  <th className="p-3 text-start">{L("Space", "الموقف")}</th>
                  <th className="p-3 text-start">{L("When", "الوقت")}</th>
                  <th className="p-3 text-start">{L("Status", "الحالة")}</th>
                  <th className="p-3 text-start">{L("Payment", "الدفع")}</th>
                  <th className="p-3 text-end">{L("Your payout", "مستحقك")}</th>
                </tr>
              </thead>
              <tbody>
                {d.bookings.map((b) => (
                  <tr key={b.id} className="border-t border-line">
                    <td className="p-3">{titleOf(b.spaceId)}</td>
                    <td className="num p-3 text-xs" dir="ltr">{fmtDateTime(b.startAt, lang)} → {fmtDateTime(b.endAt, lang)}</td>
                    <td className="p-3"><Pill tone={b.status === "cancelled" ? "inactive" : "private"}>{B({ confirmed: { en: "Confirmed", ar: "مؤكد" }, cancelled: { en: "Cancelled", ar: "ملغي" }, completed: { en: "Completed", ar: "مكتمل" } }[b.status as "confirmed"] ?? { en: b.status, ar: b.status })}</Pill></td>
                    <td className="p-3 text-xs">{B(PAYMENT_STATUS_LABEL[b.paymentStatus])}</td>
                    <td className="num p-3 text-end font-semibold" dir="ltr">
                      {formatHalalas(b.hostNetPayoutHalalas + b.overstaySurchargeHalalas, lang)}
                      {b.overstaySurchargeHalalas > 0 && <span className="block text-[11px] font-normal text-mute">{L("incl. overstay", "شامل رسوم التأخير")}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
