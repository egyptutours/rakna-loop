"use client";

import { useCallback, useEffect, useState } from "react";
import { BadgePercent, Crown, Gift, Ticket, X } from "lucide-react";
import { useApp } from "@/components/providers";
import { Button, ButtonLink, Card, DemoTag, Keys, Notice, PageHeader, Pill, Skeleton } from "@/components/ui";
import { api } from "@/lib/client/api";
import type { RewardItem } from "@/lib/types";

const CAT: Record<RewardItem["category"], { icon: typeof Gift; en: string; ar: string }> = {
  parking_discount: { icon: BadgePercent, en: "Parking discount", ar: "خصم مواقف" },
  partner_benefit: { icon: Crown, en: "Partner benefit", ar: "ميزة شريك" },
  sponsored_voucher: { icon: Ticket, en: "Sponsored voucher", ar: "قسيمة برعاية" },
  membership_perk: { icon: Gift, en: "Membership perk", ar: "ميزة عضوية" },
};

/** SCREEN 6 — Rewards marketplace. */
export default function RewardsPage() {
  const { L, lang, session, toast, errorText } = useApp();
  const [data, setData] = useState<{ rewards: RewardItem[]; balance: number | null } | null>(null);
  const [confirm, setConfirm] = useState<RewardItem | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => api<{ rewards: RewardItem[]; balance: number | null }>("/api/rewards").then(setData).catch(() => {}), []);
  useEffect(() => void load(), [load, session?.user?.id]);

  const redeem = async () => {
    if (!confirm) return;
    setBusy(true);
    try {
      await api("/api/rewards", { body: { rewardId: confirm.id } });
      toast(L("Redemption submitted for approval (simulated).", "تم إرسال الاستبدال للموافقة (محاكاة)."), "ok");
      setConfirm(null);
      await load();
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const isDriver = session?.user?.role === "driver";
  const tr = (en: string, ar: string) => (lang === "ar" ? ar : en);

  return (
    <div>
      <PageHeader eyebrow="RAKNA KEYS" title={L("Rewards marketplace", "سوق المكافآت")} subtitle={L("Redeem Keys for eligible partner benefits. All redemptions are simulated until real partners and compliance arrangements exist.", "استبدل المفاتيح بمزايا الشركاء المؤهلة. جميع الاستبدالات محاكاة حتى توجد شراكات فعلية وترتيبات امتثال.")}>
        {isDriver && data?.balance !== null && data && (
          <div className="rounded-2xl border border-gold/30 bg-gold-soft px-4 py-2.5 text-sm">
            {L("Your balance", "رصيدك")}: <Keys n={data.balance ?? 0} />
          </div>
        )}
      </PageHeader>

      <Notice>{L("RAKNA KEYS are virtual loyalty points. No cash conversion, withdrawal, purchase or transfer. No fixed Riyal value. Program terms are subject to Saudi regulatory and legal review before commercial launch.", "مفاتيح ركنة نقاط ولاء افتراضية. لا تحويل نقدي ولا سحب ولا شراء ولا نقل. لا قيمة ثابتة بالريال. تخضع شروط البرنامج لمراجعة تنظيمية وقانونية سعودية قبل الإطلاق التجاري.")}</Notice>

      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {!data && [1, 2, 3].map((i) => <Skeleton key={i} className="h-64" />)}
        {data?.rewards.map((r) => {
          const C = CAT[r.category];
          const affordable = (data.balance ?? 0) >= r.keysRequired;
          return (
            <Card key={r.id} className="flex flex-col">
              <div className="flex items-start justify-between gap-2">
                <span className="grid h-11 w-11 place-items-center rounded-2xl bg-sage-soft text-forest"><C.icon className="h-5 w-5" aria-hidden /></span>
                <div className="flex flex-col items-end gap-1">
                  <Pill>{tr(C.en, C.ar)}</Pill>
                  {r.isDemo && <DemoTag />}
                </div>
              </div>
              <h3 className="mt-4 font-bold">{tr(r.title, r.titleAr)}</h3>
              <p className="mt-1 text-sm text-mute">{tr(r.description, r.descriptionAr)}</p>
              <dl className="mt-4 space-y-1.5 text-xs">
                <div className="flex justify-between gap-2"><dt className="text-mute">{L("Eligibility", "الأهلية")}</dt><dd className="text-end font-medium">{tr(r.eligibility, r.eligibilityAr)}</dd></div>
                {r.stock !== null && <div className="flex justify-between"><dt className="text-mute">{L("Remaining", "المتبقي")}</dt><dd className="num font-medium">{r.stock}</dd></div>}
              </dl>
              <details className="mt-3 text-xs text-mute">
                <summary className="cursor-pointer font-medium text-forest-3">{L("Terms & conditions", "الشروط والأحكام")}</summary>
                <p className="mt-1 leading-relaxed">{tr(r.terms, r.termsAr)}</p>
              </details>
              <div className="mt-auto flex items-center justify-between gap-2 pt-5">
                <Keys n={r.keysRequired} size="lg" />
                {r.category === "parking_discount" ? (
                  <ButtonLink href="/parking" variant="secondary" className="h-10">{L("Use when booking", "استخدمه عند الحجز")}</ButtonLink>
                ) : (
                  <Button size="sm" variant={affordable ? "gold" : "secondary"} disabled={!isDriver || !affordable || r.stock === 0} onClick={() => setConfirm(r)}>
                    {!isDriver ? L("Drivers only", "للسائقين فقط") : affordable ? L("Redeem", "استبدل") : L("Not enough Keys", "مفاتيح غير كافية")}
                  </Button>
                )}
              </div>
            </Card>
          );
        })}
      </div>

      {confirm && (
        <div className="fixed inset-0 z-[80] grid place-items-center bg-ink/40 p-4" role="dialog" aria-modal="true">
          <Card className="w-full max-w-md">
            <div className="flex items-start justify-between">
              <h2 className="text-lg font-bold">{L("Confirm redemption", "تأكيد الاستبدال")}</h2>
              <button onClick={() => setConfirm(null)} className="text-mute" aria-label={L("Close", "إغلاق")}><X className="h-5 w-5" /></button>
            </div>
            <p className="mt-2 text-sm">{tr(confirm.title, confirm.titleAr)}</p>
            <p className="mt-2 text-sm">{L("Cost", "التكلفة")}: <Keys n={confirm.keysRequired} /></p>
            <p className="mt-3 rounded-xl bg-sage-mist p-3 text-xs leading-relaxed text-ink-2">{tr(confirm.terms, confirm.termsAr)}</p>
            <p className="mt-2 text-xs text-mute">{L("Keys are deducted now and refunded automatically if an administrator does not approve.", "تُخصم المفاتيح الآن وتُسترد تلقائيًا إذا لم يوافق المشرف.")}</p>
            <div className="mt-4 flex gap-2">
              <Button variant="secondary" className="flex-1" onClick={() => setConfirm(null)}>{L("Cancel", "إلغاء")}</Button>
              <Button variant="gold" className="flex-1" onClick={redeem} loading={busy}>{L("Redeem (simulated)", "استبدل (محاكاة)")}</Button>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
