"use client";

import { useCallback, useEffect, useState } from "react";
import { useApp } from "@/components/providers";
import { HiveAdmin } from "@/components/hive-admin";
import { Button, Card, Empty, Keys, Notice, PageHeader, Pill, Skeleton, Stat, StatusPill, cn, inputCls } from "@/components/ui";
import { api } from "@/lib/client/api";
import { fmtDateTime } from "@/lib/client/format";
import { ENTITLEMENT_LABEL, NEIGHBORHOOD_LABEL, SPACE_CATEGORY_LABEL } from "@/lib/i18n";
import type { AuditLog, DepartureReport, FraudFlag, LedgerEntry, MobilityMission, ParkingPartner, ParkingSpace, Profile, RewardItem, RewardRedemption, RewardRules } from "@/lib/types";

interface Overview {
  stats: Record<string, number>;
  rules: RewardRules;
  profiles: Profile[];
  reports: DepartureReport[];
  flags: FraudFlag[];
  partners: ParkingPartner[];
  spaces: ParkingSpace[];
  redemptions: RewardRedemption[];
  missions: MobilityMission[];
  ledger: LedgerEntry[];
  audit: AuditLog[];
  rewards: RewardItem[];
  platformSettings?: { villaBookingsEnabled: boolean };
}

type Tab = "reviews" | "hive" | "fraud" | "rules" | "rewards" | "ledger" | "activity" | "audit";

const RULE_LABELS: Record<keyof RewardRules, { en: string; ar: string; unit?: string }> = {
  departureReward: { en: "Successful verified departure report", ar: "بلاغ طلعة موثّق وناجح", unit: "Keys" },
  confirmationReward: { en: "Valid availability confirmation", ar: "تأكيد توفر صحيح", unit: "Keys" },
  streakEvery: { en: "Bonus every N verified handoffs", ar: "مكافأة كل N تسليمات موثقة" },
  streakBonus: { en: "Handoff bonus", ar: "مكافأة التسليمات", unit: "Keys" },
  missionReward: { en: "Approved sustainable mobility mission", ar: "مهمة تنقل مستدام معتمدة", unit: "Keys" },
  dailyEarnLimit: { en: "Daily earning limit per user", ar: "حد الكسب اليومي لكل مستخدم", unit: "Keys" },
  dailyReportLimit: { en: "Daily report limit per user", ar: "حد البلاغات اليومي لكل مستخدم" },
  reportTtlMinutes: { en: "Report lifetime after departure", ar: "مدة صلاحية البلاغ بعد الطلعة", unit: "min" },
  claimTtlMinutes: { en: "Claim window", ar: "مهلة التوجّه", unit: "min" },
  maxConfirmDistanceM: { en: "Max confirmation distance", ar: "أقصى مسافة للتأكيد", unit: "m" },
  maxReportAccuracyM: { en: "Min GPS accuracy to report", ar: "أدنى دقة GPS للإبلاغ", unit: "m" },
  minClaimToConfirmSeconds: { en: "Min seconds claim → confirm (far claims)", ar: "أقل عدد ثواني من التوجّه للتأكيد (للتوجّه البعيد)", unit: "s" },
  locationRetentionHours: { en: "Precise location retention", ar: "مدة الاحتفاظ بالموقع الدقيق", unit: "h" },
};

/** SCREEN 9 — Admin dashboard. */
export default function AdminPage() {
  const { L, B, lang, session, toast, errorText } = useApp();
  const [o, setO] = useState<Overview | null>(null);
  const [tab, setTab] = useState<Tab>("reviews");
  const [rules, setRules] = useState<RewardRules | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api<Overview>("/api/admin");
      setO(data);
      setRules(data.rules);
    } catch (e) {
      toast(errorText(e), "error");
    }
  }, [toast, errorText]);
  useEffect(() => {
    if (session?.user?.role === "admin") void load();
  }, [load, session?.user?.id, session?.user?.role]);

  if (session && session.user?.role !== "admin") return <Card className="mx-auto max-w-lg text-center text-sm">{L("Switch to the demo administrator account.", "حوّل لحساب المشرف التجريبي.")}</Card>;
  if (!o || !rules) return <Skeleton className="h-96" />;

  const act = async (key: string, body: unknown) => {
    setBusy(key);
    try {
      await api("/api/admin", { body });
      toast(L("Saved and logged to the audit trail.", "انحفظ وتسجّل في سجل التدقيق."), "ok");
      await load();
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(null);
    }
  };
  const name = (id: string | null) => {
    const p = o.profiles.find((x) => x.id === id);
    return p ? (lang === "ar" ? p.displayNameAr : p.displayName) : id ? id.slice(0, 8) : "—";
  };
  const s = o.stats;
  const pendingPartners = o.partners.filter((p) => p.status === "pending");
  const pendingSpaces = o.spaces.filter((x) => x.approval === "pending_review");
  const pendingRedemptions = o.redemptions.filter((r) => r.status === "pending_approval");
  const pendingMissions = o.missions.filter((m) => m.status === "submitted");
  const held = o.reports.filter((r) => r.status === "flagged");
  const deletions = o.profiles.filter((p) => p.deletionRequestedAt && !p.deletedAt);
  const openFlags = o.flags.filter((f) => f.status === "open");

  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: "reviews", label: L("Reviews", "المراجعات"), count: pendingPartners.length + pendingSpaces.length + pendingRedemptions.length + pendingMissions.length + held.length + deletions.length },
    { id: "hive", label: L("Hive intelligence", "ذكاء الخلايا") },
    { id: "fraud", label: L("Fraud flags", "مؤشرات الاحتيال"), count: openFlags.length },
    { id: "rules", label: L("Reward rules", "قواعد المكافآت") },
    { id: "rewards", label: L("Rewards catalog", "كتالوج المكافآت") },
    { id: "ledger", label: L("Points ledger", "سجل النقاط") },
    { id: "activity", label: L("Community activity", "نشاط المجتمع") },
    { id: "audit", label: L("Audit log", "سجل التدقيق") },
  ];

  const Row = ({ children }: { children: React.ReactNode }) => <div className="flex flex-col gap-3 rounded-2xl border border-line bg-card p-4 sm:flex-row sm:items-center sm:justify-between">{children}</div>;
  const Decide = ({ k, onYes, onNo, yes, no }: { k: string; onYes: () => void; onNo: () => void; yes?: string; no?: string }) => (
    <div className="flex shrink-0 gap-2">
      <Button size="sm" variant="private" loading={busy === `${k}:y`} onClick={onYes}>{yes ?? L("Approve", "اعتماد")}</Button>
      <Button size="sm" variant="secondary" loading={busy === `${k}:n`} onClick={onNo}>{no ?? L("Reject", "رفض")}</Button>
    </div>
  );

  return (
    <div>
      <PageHeader eyebrow={L("Administration", "الإدارة")} title={L("Admin dashboard", "لوحة الإدارة")} subtitle={L("Approve partners and rewards, review suspicious activity, tune the reward engine. Every change is audited.", "اعتمد الشركاء والمكافآت، راجع أي نشاط مشبوه، واضبط نظام المكافآت. كل تغيير ينسجّل.")} />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
        <Stat label={L("Registered demo users", "المستخدمين التجريبيين")} value={s.users} />
        <Stat label={L("Active reports", "البلاغات الشغّالة")} value={s.activeReports} tone="signal" />
        <Stat label={L("Successful handoffs", "التسليمات اللي نجحت")} value={s.successfulHandoffs} tone="private" />
        <Stat label={L("Expired reports", "البلاغات اللي انتهت")} value={s.expiredReports} />
        <Stat label={L("Open fraud flags", "مؤشرات احتيال مفتوحة")} value={s.openFraudFlags} tone="danger" />
        <Stat label={L("Total earned Keys", "مجموع المفاتيح المكتسبة")} value={s.totalEarnedKeys} tone="gold" />
        <Stat label={L("Total redeemed Keys", "مجموع المفاتيح المستبدلة")} value={s.totalRedeemedKeys} tone="gold" />
        <Stat label={L("Partner applications", "طلبات الشركاء")} value={s.pendingPartners} />
      </div>

      <div className="no-scrollbar mt-6 flex gap-1 overflow-x-auto border-b border-line">
        {tabs.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)} className={cn("flex shrink-0 items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-semibold", tab === t.id ? "border-forest text-forest" : "border-transparent text-mute hover:text-ink")}>
            {t.label}
            {!!t.count && <span className="num rounded-full bg-danger px-1.5 text-[11px] text-white">{t.count}</span>}
          </button>
        ))}
      </div>

      <div className="mt-5 space-y-6">
        {tab === "reviews" && (
          <>
            <Group title={L("Partner applications", "طلبات الشركاء")} empty={pendingPartners.length === 0}>
              {pendingPartners.map((p) => (
                <Row key={p.id}>
                  <div><p className="font-semibold">{lang === "ar" ? p.nameAr : p.name}</p><p className="text-xs text-mute">{p.kind} · {p.contactEmail} · {p.crNumberProvided ? L("CR provided", "مقدّم سجل تجاري") : L("No CR", "بدون سجل")}</p></div>
                  <Decide k={p.id} onYes={() => act(`${p.id}:y`, { action: "partner", id: p.id, status: "approved" })} onNo={() => act(`${p.id}:n`, { action: "partner", id: p.id, status: "rejected" })} />
                </Row>
              ))}
            </Group>
            <Group title={L("Private spaces awaiting review", "مواقف خاصة تنتظر المراجعة")} empty={pendingSpaces.length === 0}>
              {pendingSpaces.map((x) => (
                <Row key={x.id}>
                  <div>
                    <p className="font-semibold">{lang === "ar" ? x.titleAr : x.title}</p>
                    <p className="text-xs text-mute">{o.partners.find((p) => p.id === x.partnerId)?.name} · {x.capacity} · {x.pricePerHour} SAR/h</p>
                    {/* What the admin must verify out-of-band before approving (approval = entitlement verification). */}
                    <p className="mt-1 flex flex-wrap gap-1.5">
                      <Pill>{B(SPACE_CATEGORY_LABEL[x.spaceCategory ?? "commercial"])}</Pill>
                      <Pill tone="warn">{L("Verify", "تحقق من")}: {B(ENTITLEMENT_LABEL[x.entitlementType ?? "commercial_cr"])}</Pill>
                      {x.landlordConsentAt && <Pill tone="gold">{L("Tenant attested landlord consent", "المستأجر أقرّ بموافقة المالك")}</Pill>}
                    </p>
                  </div>
                  <Decide k={x.id} onYes={() => act(`${x.id}:y`, { action: "space", id: x.id, approval: "approved" })} onNo={() => act(`${x.id}:n`, { action: "space", id: x.id, approval: "rejected" })} />
                </Row>
              ))}
            </Group>
            <Group title={L("Reward redemptions", "طلبات استبدال المكافآت")} empty={pendingRedemptions.length === 0}>
              {pendingRedemptions.map((r) => (
                <Row key={r.id}>
                  <div><p className="font-semibold">{(() => { const rw = o.rewards.find((x) => x.id === r.rewardId); return rw ? (lang === "ar" ? rw.titleAr : rw.title) : "—"; })()}</p><p className="text-xs text-mute">{name(r.userId)} · <Keys n={r.keysSpent} size="sm" /> · {fmtDateTime(r.createdAt, lang)}</p></div>
                  <Decide k={r.id} onYes={() => act(`${r.id}:y`, { action: "redemption", id: r.id, approve: true })} onNo={() => act(`${r.id}:n`, { action: "redemption", id: r.id, approve: false })} no={L("Reject & refund", "رفض مع استرداد")} />
                </Row>
              ))}
            </Group>
            <Group title={L("Park & Connect missions (simulated)", "مهام اركن واتصل (محاكاة)")} empty={pendingMissions.length === 0}>
              {pendingMissions.map((m) => (
                <Row key={m.id}>
                  <div><p className="font-semibold">{m.kind}</p><p className="text-xs text-mute">{name(m.userId)} · {m.description}</p></div>
                  <Decide k={m.id} onYes={() => act(`${m.id}:y`, { action: "mission", id: m.id, approve: true })} onNo={() => act(`${m.id}:n`, { action: "mission", id: m.id, approve: false })} />
                </Row>
              ))}
            </Group>
            <Group title={L("Account deletion requests", "طلبات حذف الحسابات")} empty={deletions.length === 0}>
              {deletions.map((p) => (
                <Row key={p.id}>
                  <div><p className="font-semibold">{lang === "ar" ? p.displayNameAr : p.displayName}</p><p className="text-xs text-mute">{L("Requested", "انطلب في")} {fmtDateTime(p.deletionRequestedAt!, lang)} · {L("Location records are deleted, the profile is anonymized; ledger and bookings are kept for audit.", "تنحذف سجلات المواقع ويتجهّل الملف؛ ونحتفظ بالسجل والحجوزات للتدقيق.")}</p></div>
                  <Button size="sm" variant="danger" loading={busy === `${p.id}:del`} onClick={() => act(`${p.id}:del`, { action: "process_deletion", id: p.id })}>{L("Anonymize account", "تجهيل الحساب")}</Button>
                </Row>
              ))}
            </Group>
            <Group title={L("Handoffs held for review", "تسليمات موقوفة للمراجعة")} empty={held.length === 0}>
              {held.map((r) => (
                <Row key={r.id}>
                  <div><p className="font-semibold">{name(r.reporterId)} → {name(r.claimedBy)}</p><p className="text-xs text-mute">{B(NEIGHBORHOOD_LABEL[r.neighborhood])} · {fmtDateTime(r.createdAt, lang)}</p></div>
                  <Decide k={r.id} yes={L("Release rewards", "اصرف المكافآت")} onYes={() => act(`${r.id}:y`, { action: "report", id: r.id, approve: true })} onNo={() => act(`${r.id}:n`, { action: "report", id: r.id, approve: false })} />
                </Row>
              ))}
            </Group>
          </>
        )}

        {tab === "hive" && <HiveAdmin />}

        {tab === "fraud" && (
          <div className="space-y-3">
            {o.flags.length === 0 && <Empty>{L("No fraud signals.", "ما فيه مؤشرات احتيال.")}</Empty>}
            {o.flags.map((f) => <FlagRow key={f.id} f={f} name={name} onAct={act} busy={busy} />)}
          </div>
        )}

        {tab === "rules" && (
          <Card>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line p-3">
              <div>
                <p className="text-sm font-semibold">{L("RAKNA HOME — villa bookings (municipal pilot)", "ركنة هوم — حجوزات الفلل (التجربة البلدية)")}</p>
                <p className="text-xs text-mute">{o.platformSettings?.villaBookingsEnabled ? L("Villa spaces are bookable.", "مواقف الفلل متاحة للحجز.") : L("Villa spaces are waitlist-only. Building bays and commercial spaces are unaffected.", "مواقف الفلل في قائمة الانتظار بس. مواقف العمائر والمواقف التجارية ما تتأثر.")}</p>
              </div>
              <Button size="sm" variant={o.platformSettings?.villaBookingsEnabled ? "secondary" : "private"} loading={busy === "villa"} onClick={() => act("villa", { action: "villa_bookings", enabled: !o.platformSettings?.villaBookingsEnabled })}>
                {o.platformSettings?.villaBookingsEnabled ? L("Return villas to waitlist", "رجّع الفلل لقائمة الانتظار") : L("Enable villa bookings", "فعّل حجوزات الفلل")}
              </Button>
            </div>
            <Notice tone="info">{L("Demonstration defaults. Changes apply immediately to new awards and are recorded in the audit log.", "قيم تجريبية افتراضية. التغييرات تنطبق على طول على المكافآت الجديدة وتنسجّل في سجل التدقيق.")}</Notice>
            <div className="mt-4 grid gap-4 md:grid-cols-2">
              {(Object.keys(RULE_LABELS) as (keyof RewardRules)[]).map((k) => (
                <label key={k} className="flex items-center justify-between gap-3 rounded-xl border border-line p-3">
                  <span className="text-sm">{B(RULE_LABELS[k])}</span>
                  <span className="flex items-center gap-1.5">
                    <input type="number" className={cn(inputCls, "h-9 w-24 text-center")} value={rules[k]} onChange={(e) => setRules({ ...rules, [k]: Number(e.target.value) })} />
                    <span className="w-8 text-xs text-mute">{RULE_LABELS[k].unit ?? ""}</span>
                  </span>
                </label>
              ))}
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button loading={busy === "rules"} onClick={async () => { setBusy("rules"); try { await api("/api/admin", { method: "PUT", body: rules }); toast(L("Reward rules updated.", "تحدّثت قواعد المكافآت."), "ok"); await load(); } catch (e) { toast(errorText(e), "error"); } finally { setBusy(null); } }}>{L("Save rules", "احفظ القواعد")}</Button>
              <Button variant="secondary" onClick={() => setRules(o.rules)}>{L("Discard changes", "تجاهل التغييرات")}</Button>
              <Button variant="secondary" loading={busy === "purge"} onClick={() => act("purge", { action: "purge_locations" })}>{L("Run location-retention purge", "شغّل حذف المواقع القديمة")}</Button>
            </div>
          </Card>
        )}

        {tab === "rewards" && (
          <div className="grid gap-3 md:grid-cols-2">
            {o.rewards.map((r) => <RewardRow key={r.id} r={r} onAct={act} busy={busy} />)}
          </div>
        )}

        {tab === "ledger" && (
          <Card className="overflow-x-auto p-0">
            <div className="flex flex-wrap gap-4 border-b border-line p-4 text-sm">
              <span>{L("Outstanding Keys", "المفاتيح اللي باقية")}: <Keys n={s.outstandingKeys} /></span>
              <span className="text-mute">{L("Balances are always derived from this append-only ledger.", "الأرصدة دايم تنحسب من هذا السجل اللي ما ينعدّل.")}</span>
            </div>
            <table className="w-full min-w-[720px] text-sm">
              <thead className="bg-sage-mist text-xs text-mute"><tr><th className="p-3 text-start font-medium">{L("User", "المستخدم")}</th><th className="p-3 text-start font-medium">{L("Type", "النوع")}</th><th className="p-3 text-start font-medium">{L("Amount", "القيمة")}</th><th className="p-3 text-start font-medium">{L("Idempotency key", "مفتاح منع التكرار")}</th><th className="p-3 text-start font-medium">{L("Time", "الوقت")}</th></tr></thead>
              <tbody className="divide-y divide-line">
                {o.ledger.map((e) => (
                  <tr key={e.id}>
                    <td className="p-3">{name(e.userId)}</td>
                    <td className="p-3 text-xs">{e.type}</td>
                    <td className={cn("num p-3 font-bold", e.amount > 0 ? "text-private" : "text-danger")}>{e.amount > 0 ? "+" : ""}{e.amount}</td>
                    <td className="p-3 font-mono text-[11px] text-mute" dir="ltr">{e.idempotencyKey.length > 46 ? `${e.idempotencyKey.slice(0, 46)}…` : e.idempotencyKey}</td>
                    <td className="p-3 text-xs text-mute">{fmtDateTime(e.createdAt, lang)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}

        {tab === "activity" && (
          <Card className="overflow-x-auto p-0">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="bg-sage-mist text-xs text-mute"><tr><th className="p-3 text-start font-medium">{L("Reporter", "المُبلّغ")}</th><th className="p-3 text-start font-medium">{L("Area", "المنطقة")}</th><th className="p-3 text-start font-medium">{L("Status", "الحالة")}</th><th className="p-3 text-start font-medium">{L("Claimed by", "اللي متوجّه")}</th><th className="p-3 text-start font-medium">{L("Created", "الإنشاء")}</th></tr></thead>
              <tbody className="divide-y divide-line">
                {o.reports.map((r) => (
                  <tr key={r.id}>
                    <td className="p-3">{name(r.reporterId)}</td>
                    <td className="p-3">{B(NEIGHBORHOOD_LABEL[r.neighborhood] ?? { en: r.neighborhood, ar: r.neighborhood })}</td>
                    <td className="p-3"><StatusPill status={r.status} /></td>
                    <td className="p-3">{name(r.claimedBy)}</td>
                    <td className="p-3 text-xs text-mute">{fmtDateTime(r.createdAt, lang)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}

        {tab === "audit" && (
          <Card className="p-0">
            {o.audit.length === 0 ? <div className="p-5"><Empty>{L("No administrative changes yet.", "ما فيه تغييرات إدارية للحين.")}</Empty></div> : (
              <ul className="divide-y divide-line">
                {o.audit.map((a) => (
                  <li key={a.id} className="p-4 text-sm">
                    <div className="flex flex-wrap justify-between gap-2"><span className="font-semibold">{a.action}</span><span className="text-xs text-mute">{fmtDateTime(a.createdAt, lang)}</span></div>
                    <p className="text-xs text-mute">{name(a.actorId)} · <span dir="ltr">{a.target}</span> · {a.details}</p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}
      </div>
    </div>
  );
}

function Group({ title, empty, children }: { title: string; empty: boolean; children: React.ReactNode }) {
  const { L } = useApp();
  return (
    <section>
      <h2 className="mb-3 text-sm font-bold text-ink">{title}</h2>
      <div className="space-y-2">{empty ? <Empty>{L("Nothing pending.", "ما فيه شي معلّق.")}</Empty> : children}</div>
    </section>
  );
}

function FlagRow({ f, name, onAct, busy }: { f: FraudFlag; name: (id: string | null) => string; onAct: (k: string, b: unknown) => Promise<void>; busy: string | null }) {
  const { L, lang } = useApp();
  const [amount, setAmount] = useState(8);
  return (
    <div className="rounded-2xl border border-line bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone={f.severity === "high" ? "danger" : f.severity === "medium" ? "warn" : "neutral"}>{f.severity}</Pill>
        <span className="font-mono text-xs" dir="ltr">{f.kind}</span>
        <Pill tone={f.status === "open" ? "warn" : "inactive"}>{f.status}</Pill>
        <span className="ms-auto text-xs text-mute">{fmtDateTime(f.createdAt, lang)}</span>
      </div>
      <p className="mt-2 text-sm">{name(f.userId)}{f.relatedUserId && <> ↔ {name(f.relatedUserId)}</>}</p>
      <p className="text-xs text-mute">{f.details}</p>
      {f.status === "open" && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button size="sm" variant="secondary" loading={busy === `${f.id}:d`} onClick={() => onAct(`${f.id}:d`, { action: "flag", id: f.id, decision: "dismiss" })}>{L("Dismiss", "تجاهل")}</Button>
          <input type="number" min={1} max={1000} value={amount} onChange={(e) => setAmount(Number(e.target.value))} className={cn(inputCls, "h-9 w-20 text-center")} aria-label={L("Keys to reverse", "المفاتيح اللي بتنعكس")} />
          <Button size="sm" variant="danger" loading={busy === `${f.id}:r`} onClick={() => onAct(`${f.id}:r`, { action: "flag", id: f.id, decision: "reverse", amount })}>{L("Reverse Keys (capped at balance)", "اعكس المفاتيح (بحدود الرصيد)")}</Button>
        </div>
      )}
    </div>
  );
}

function RewardRow({ r, onAct, busy }: { r: RewardItem; onAct: (k: string, b: unknown) => Promise<void>; busy: string | null }) {
  const { L, lang } = useApp();
  const [cost, setCost] = useState(r.keysRequired);
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-2">
        <div><p className="font-semibold">{lang === "ar" ? r.titleAr : r.title}</p><p className="text-xs text-mute">{r.category}{r.stock !== null && ` · stock ${r.stock}`}</p></div>
        <Pill tone={r.active ? "private" : "inactive"}>{r.active ? L("Active", "شغّال") : L("Inactive", "موقّف")}</Pill>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input type="number" min={1} value={cost} onChange={(e) => setCost(Number(e.target.value))} className={cn(inputCls, "h-9 w-24 text-center")} aria-label={L("Keys required", "المفاتيح المطلوبة")} />
        <Button size="sm" variant="secondary" loading={busy === `${r.id}:c`} onClick={() => onAct(`${r.id}:c`, { action: "reward_toggle", id: r.id, active: r.active, keysRequired: cost })}>{L("Save cost", "احفظ التكلفة")}</Button>
        <Button size="sm" variant={r.active ? "secondary" : "private"} loading={busy === `${r.id}:t`} onClick={() => onAct(`${r.id}:t`, { action: "reward_toggle", id: r.id, active: !r.active })}>{r.active ? L("Deactivate", "وقّف") : L("Activate", "فعّل")}</Button>
      </div>
    </Card>
  );
}
