"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Footprints, TrainFront, Trophy, Users } from "lucide-react";
import { useApp } from "@/components/providers";
import { BadgeGrid } from "@/components/badges";
import { Button, Card, Empty, Field, Notice, PageHeader, Pill, SectionTitle, Skeleton, cn, inputCls } from "@/components/ui";
import { api } from "@/lib/client/api";
import { fmtDateTime } from "@/lib/client/format";
import { NEIGHBORHOOD_LABEL } from "@/lib/i18n";
import type { Badge, ChallengeView, LeaderboardRow } from "@/lib/domain/community";
import type { MobilityMission } from "@/lib/types";

interface CommunityData {
  leaderboard: LeaderboardRow[];
  neighborhoods: Record<string, { reports: number; handoffs: number }>;
  challenges: ChallengeView[];
  badges: Badge[];
  contributionScore: number | null;
  missions: MobilityMission[];
}

/** Neighborhood challenges, leaderboard and Park & Connect (simulated). */
export default function CommunityPage() {
  const { L, B, lang, session, toast, errorText } = useApp();
  const [d, setD] = useState<CommunityData | null>(null);
  const [kind, setKind] = useState<MobilityMission["kind"]>("park_and_metro");
  const [desc, setDesc] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => api<CommunityData>("/api/community").then(setD).catch(() => {}), []);
  useEffect(() => void load(), [load, session?.user?.id]);

  if (!d) return <Skeleton className="h-96" />;
  const isDriver = session?.user?.role === "driver";

  return (
    <div>
      <PageHeader eyebrow={L("Neighborhood challenges", "تحديات الأحياء")} title={L("Community", "المجتمع")} subtitle={L("Progress counts only verified handoffs and approved missions — never taps, views or extra driving.", "التقدّم ينحسب للتسليمات الموثقة والمهام المعتمدة بس — مو للنقرات ولا المشاهدات ولا اللفّ بالسيارة.")} />

      <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <section>
          <SectionTitle title={L("Challenges", "التحديات")} subtitle={isDriver ? undefined : L("Switch to a driver account to track your progress.", "حوّل لحساب سائق عشان تتابع تقدّمك.")} />
          <div className="grid gap-3 sm:grid-cols-2">
            {d.challenges.map((c) => (
              <Card key={c.id} className={cn("p-4", c.completed && "border-private/30 bg-private-soft/50")}>
                <div className="flex items-start justify-between gap-2">
                  <p className="font-bold">{lang === "ar" ? c.titleAr : c.title}</p>
                  {c.completed && <CheckCircle2 className="h-5 w-5 shrink-0 text-private" aria-label={L("Completed", "مكتمل")} />}
                </div>
                <p className="mt-1 text-xs text-mute">{lang === "ar" ? c.descriptionAr : c.description}</p>
                <div className="mt-3 h-2 overflow-hidden rounded-full bg-sage-soft"><div className="h-full rounded-full bg-forest" style={{ width: `${Math.round((c.progress / c.target) * 100)}%` }} /></div>
                <div className="mt-1 flex justify-between text-[11px] text-mute">
                  <span className="num">{c.progress}/{c.target}</span>
                  {c.neighborhood && <span>{B(NEIGHBORHOOD_LABEL[c.neighborhood])}</span>}
                  {c.metric === "missions_approved" && <Pill tone="warn">{L("Simulated", "محاكاة")}</Pill>}
                </div>
              </Card>
            ))}
          </div>

          {d.badges.length > 0 && (
            <div className="mt-8">
              <SectionTitle title={L("Your badges", "شاراتك")} />
              <BadgeGrid badges={d.badges} />
            </div>
          )}

          <div className="mt-8">
            <SectionTitle title={L("Park & Connect — future missions", "اركن واتصل — مهام جاية")} subtitle={L("Simulated: no real transit integration exists yet.", "محاكاة: ما فيه ربط فعلي مع النقل العام للحين.")} />
            <div className="grid gap-3 sm:grid-cols-3">
              {[
                { icon: TrainFront, en: "Park near an authorized transit connection and finish by metro", ar: "اركن قرب محطة نقل معتمدة وكمّل بالمترو" },
                { icon: Footprints, en: "Use a walking connection when practical", ar: "امشِ إذا كان المشي أسهل" },
                { icon: Users, en: "Join an approved carpooling mission", ar: "انضم لمهمة مشاركة سيارات معتمدة" },
              ].map((m, i) => (
                <Card key={i} className="p-4">
                  <m.icon className="h-6 w-6 text-forest" aria-hidden />
                  <p className="mt-2 text-sm">{lang === "ar" ? m.ar : m.en}</p>
                </Card>
              ))}
            </div>
            {isDriver && (
              <Card className="mt-3">
                <Notice>{L("Demo: submit a simulated mission. An admin approves it, then the mission reward is credited through the ledger. One submission per day.", "تجريبي: أرسل مهمة محاكاة. المشرف يعتمدها وبعدها تنضاف مكافأة المهمة في السجل. إرسال واحد في اليوم.")}</Notice>
                <div className="mt-3 grid gap-3 sm:grid-cols-[200px_1fr]">
                  <Field label={L("Mission type", "نوع المهمة")}>
                    <select className={inputCls} value={kind} onChange={(e) => setKind(e.target.value as MobilityMission["kind"])}>
                      <option value="park_and_metro">{L("Park & metro", "اركن والمترو")}</option>
                      <option value="walk_connection">{L("Walking connection", "مشي للمحطة")}</option>
                      <option value="carpool">{L("Carpool", "مشاركة السيارة")}</option>
                    </select>
                  </Field>
                  <Field label={L("What did you do?", "وش سوّيت؟")}><input className={inputCls} value={desc} onChange={(e) => setDesc(e.target.value)} placeholder={L("e.g. Parked near a station and rode to KAFD", "مثلًا: ركنت قرب محطة ورحت للمركز المالي")} /></Field>
                </div>
                <Button className="mt-3" loading={busy} onClick={async () => { setBusy(true); try { await api("/api/community", { body: { kind, description: desc } }); setDesc(""); toast(L("Mission submitted for approval.", "أرسلنا المهمة للاعتماد."), "ok"); await load(); } catch (e) { toast(errorText(e), "error"); } finally { setBusy(false); } }}>{L("Submit mission (simulated)", "أرسل المهمة (محاكاة)")}</Button>
                {d.missions.length > 0 && (
                  <ul className="mt-4 space-y-2 text-sm">
                    {d.missions.map((m) => (
                      <li key={m.id} className="flex justify-between gap-2 rounded-xl bg-sage-mist p-3">
                        <span>{m.description} <span className="text-xs text-mute">· {fmtDateTime(m.createdAt, lang)}</span></span>
                        <Pill tone={m.status === "approved" ? "private" : m.status === "rejected" ? "danger" : "warn"}>{m.status}</Pill>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            )}
          </div>
        </section>

        <aside className="space-y-6">
          <section>
            <SectionTitle title={L("Weekly leaderboard", "لوحة الصدارة الأسبوعية")} subtitle={L("Ranked by verified contributions, not Keys.", "الترتيب حسب المساهمات الموثقة، مو المفاتيح.")} action={<Trophy className="h-5 w-5 text-gold" aria-hidden />} />
            <Card className="p-0">
              {d.leaderboard.length === 0 ? <div className="p-5"><Empty>{L("No contributions this week.", "ما فيه مساهمات هالأسبوع.")}</Empty></div> : (
                <ol className="divide-y divide-line">
                  {d.leaderboard.map((r, i) => (
                    <li key={r.userId} className={cn("flex items-center gap-3 p-3.5", r.userId === session?.user?.id && "bg-sage-mist")}>
                      <span className={cn("num grid h-8 w-8 place-items-center rounded-full text-sm font-bold", i === 0 ? "bg-gold text-white" : i < 3 ? "bg-sage-soft text-forest" : "text-mute")}>{i + 1}</span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold">{lang === "ar" ? r.displayNameAr : r.displayName}</p>
                        <p className="text-xs text-mute">{B(NEIGHBORHOOD_LABEL[r.neighborhood] ?? { en: r.neighborhood, ar: r.neighborhood })}</p>
                      </div>
                      <span className="num text-sm font-bold text-forest">{r.contributions}</span>
                    </li>
                  ))}
                </ol>
              )}
            </Card>
          </section>
          <section>
            <SectionTitle title={L("Neighborhood participation (7 days)", "مشاركة الأحياء (آخر 7 أيام)")} />
            <div className="space-y-2">
              {Object.entries(NEIGHBORHOOD_LABEL).map(([id, label]) => {
                const s = d.neighborhoods[id] ?? { reports: 0, handoffs: 0 };
                return (
                  <Card key={id} className="flex items-center justify-between p-4">
                    <span className="font-semibold">{B(label)}</span>
                    <span className="text-xs text-mute"><span className="num font-bold text-ink">{s.handoffs}</span> {L("handoffs", "تسليمات")} · <span className="num">{s.reports}</span> {L("reports", "بلاغات")}</span>
                  </Card>
                );
              })}
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}
