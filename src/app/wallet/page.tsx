"use client";

import { useEffect, useState } from "react";
import { ArrowDownLeft, ArrowUpRight, Award, Gift } from "lucide-react";
import { useApp } from "@/components/providers";
import { BadgeGrid } from "@/components/badges";
import { ButtonLink, Card, Empty, Keys, PageHeader, Pill, SectionTitle, Skeleton } from "@/components/ui";
import { api } from "@/lib/client/api";
import { fmtDateTime } from "@/lib/client/format";
import type { Badge } from "@/lib/domain/community";
import type { LedgerEntry, RewardItem, RewardRedemption } from "@/lib/types";

interface Wallet {
  balance: number;
  earned: number;
  redeemed: number;
  earnedToday: number;
  dailyLimit: number;
  entries: LedgerEntry[];
  redemptions: (RewardRedemption & { reward: RewardItem | null })[];
  badges: Badge[];
  contributionScore: number;
}

const TYPE_LABEL: Record<LedgerEntry["type"], { en: string; ar: string }> = {
  departure_reward: { en: "Verified departure report", ar: "بلاغ طلعة موثّق" },
  confirmation_reward: { en: "On-site confirmation", ar: "تأكيد من الموقع" },
  streak_bonus: { en: "Handoff bonus", ar: "مكافأة التسليمات" },
  mission_reward: { en: "Mobility mission", ar: "مهمة تنقل" },
  redemption: { en: "Reward redemption", ar: "استبدال مكافأة" },
  redemption_refund: { en: "Redemption refund", ar: "استرداد مكافأة" },
  admin_reversal: { en: "Fraud-review reversal", ar: "انعكس بعد مراجعة احتيال" },
  booking_discount: { en: "Booking discount", ar: "خصم حجز" },
};

/** SCREEN 5 — RAKNA KEYS wallet. */
export default function WalletPage() {
  const { L, B, lang, session, errorText, toast } = useApp();
  const [w, setW] = useState<Wallet | null>(null);

  useEffect(() => {
    if (session?.user?.role !== "driver") return;
    api<Wallet>("/api/wallet").then(setW).catch((e) => toast(errorText(e), "error"));
  }, [session?.user?.id, session?.user?.role, errorText, toast]);

  if (session && session.user?.role !== "driver") return <Card className="mx-auto max-w-lg text-center text-sm">{L("The Keys wallet is available to driver accounts.", "محفظة المفاتيح لحسابات السائقين.")}</Card>;
  if (!w) return <div className="space-y-4"><Skeleton className="h-48" /><Skeleton className="h-64" /></div>;

  return (
    <div>
      <PageHeader eyebrow="RAKNA KEYS — مفاتيح ركنة" title={L("Rewards wallet", "محفظة المكافآت")} subtitle={L("Your balance is calculated from an audited points ledger. Keys are loyalty points: no cash value, no withdrawal, no transfers.", "رصيدك ينحسب من سجل نقاط مدقّق. المفاتيح نقاط ولاء: ما لها قيمة نقدية، وما تنسحب، وما تتحوّل.")}>
        <ButtonLink href="/rewards" variant="gold"><Gift className="h-4 w-4" aria-hidden />{L("Browse rewards", "تصفّح المكافآت")}</ButtonLink>
      </PageHeader>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="relative overflow-hidden rounded-[1.5rem] bg-forest p-6 text-white shadow-[var(--shadow-lift)] lg:col-span-2">
          <div className="absolute -end-10 -top-10 h-48 w-48 rounded-full bg-forest-3/40" aria-hidden />
          <div className="absolute -bottom-16 end-24 h-40 w-40 rounded-full bg-gold/20" aria-hidden />
          <p className="relative text-sm text-sage">{L("Current balance", "الرصيد الحالي")}</p>
          <div className="relative mt-2"><Keys n={w.balance} size="xl" className="text-keys" /></div>
          <div className="relative mt-6 grid grid-cols-3 gap-3 text-sm">
            <div><p className="text-sage">{L("Earned", "المكتسب")}</p><p className="num text-lg font-bold">{w.earned}</p></div>
            <div><p className="text-sage">{L("Redeemed", "المستبدل")}</p><p className="num text-lg font-bold">{w.redeemed}</p></div>
            <div><p className="text-sage">{L("Today", "اليوم")}</p><p className="num text-lg font-bold">{w.earnedToday}<span className="text-xs text-sage">/{w.dailyLimit}</span></p></div>
          </div>
          {session?.demoMode && <p className="relative mt-4 text-[11px] text-sage">{L("Demo balances and redemptions are simulated.", "الأرصدة والاستبدالات التجريبية محاكاة.")}</p>}
        </div>
        <Card>
          <p className="text-sm text-mute">{L("Contribution score", "درجة المساهمة")}</p>
          <p className="num mt-1 text-4xl font-bold text-forest">{w.contributionScore}<span className="text-base text-mute">/100</span></p>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-sage-soft"><div className="h-full rounded-full bg-forest" style={{ width: `${w.contributionScore}%` }} /></div>
          <p className="mt-3 text-xs text-mute">{L("Based on verified handoffs and how reliable your reports are — not on how many Keys you hold.", "يعتمد على التسليمات الموثقة وموثوقية بلاغاتك — مو على عدد المفاتيح.")}</p>
        </Card>
      </div>

      <section className="mt-8">
        <SectionTitle title={L("Achievement progress", "تقدّم الإنجازات")} action={<Award className="h-5 w-5 text-gold" aria-hidden />} />
        <BadgeGrid badges={w.badges} />
      </section>

      <div className="mt-8 grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <section>
          <SectionTitle title={L("Transaction history", "سجل المعاملات")} subtitle={L("Every entry has a reason and a unique reference.", "كل قيد له سبب ومرجع خاص فيه.")} />
          <Card className="p-0">
            {w.entries.length === 0 ? <div className="p-5"><Empty>{L("No transactions yet.", "ما فيه معاملات للحين.")}</Empty></div> : (
              <ul className="divide-y divide-line">
                {w.entries.map((e) => (
                  <li key={e.id} className="flex items-start gap-3 p-4">
                    <span className={`mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full ${e.amount > 0 ? "bg-private-soft text-private" : "bg-danger-soft text-danger"}`}>
                      {e.amount > 0 ? <ArrowDownLeft className="h-4 w-4" aria-hidden /> : <ArrowUpRight className="h-4 w-4" aria-hidden />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold">{B(TYPE_LABEL[e.type])}</p>
                      <p className="text-xs text-mute">{e.reason}</p>
                      <p className="mt-0.5 text-[11px] text-mute">{fmtDateTime(e.createdAt, lang)}</p>
                    </div>
                    <span className={`num text-sm font-bold ${e.amount > 0 ? "text-private" : "text-danger"}`}>{e.amount > 0 ? "+" : ""}{e.amount}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </section>
        <section>
          <SectionTitle title={L("Redeemed rewards", "المكافآت المستبدلة")} />
          <div className="space-y-3">
            {w.redemptions.length === 0 && <Empty>{L("Nothing redeemed yet.", "ما استبدلت شي للحين.")}</Empty>}
            {w.redemptions.map((r) => (
              <Card key={r.id} className="p-4">
                <div className="flex items-start justify-between gap-2">
                  <p className="text-sm font-semibold">{r.reward ? (lang === "ar" ? r.reward.titleAr : r.reward.title) : "—"}</p>
                  <Pill tone={r.status === "approved" || r.status === "used" ? "private" : r.status === "rejected" ? "danger" : "warn"}>
                    {B({ pending_approval: { en: "Pending approval", ar: "ينتظر الموافقة" }, approved: { en: "Approved", ar: "مقبول" }, rejected: { en: "Rejected (refunded)", ar: "مرفوض (رجع لك)" }, used: { en: "Used on booking", ar: "انستخدم في حجز" } }[r.status])}
                  </Pill>
                </div>
                <div className="mt-2 flex items-center justify-between text-xs text-mute">
                  <Keys n={r.keysSpent} size="sm" />
                  <span>{fmtDateTime(r.createdAt, lang)}</span>
                </div>
                {r.code && <p className="num mt-2 rounded-lg bg-gold-soft px-3 py-1.5 text-center font-mono text-sm font-bold text-gold">{r.code}</p>}
                {r.simulated && <p className="mt-2 text-[11px] text-mute">{L("Simulated redemption — no real partner fulfilment.", "استبدال محاكى — ما فيه تنفيذ فعلي من شريك.")}</p>}
              </Card>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
