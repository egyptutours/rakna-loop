"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Languages, LocateFixed, RotateCcw, ShieldCheck, Trash2 } from "lucide-react";
import { useApp } from "@/components/providers";
import { BadgeGrid } from "@/components/badges";
import { Button, Card, Empty, Notice, PageHeader, Pill, SectionTitle, Skeleton, StatusPill } from "@/components/ui";
import { api } from "@/lib/client/api";
import { fmtDateTime } from "@/lib/client/format";
import { NEIGHBORHOOD_LABEL, ROLE_LABEL } from "@/lib/i18n";
import type { Badge } from "@/lib/domain/community";
import type { Profile, ReportStatus, UserReliability } from "@/lib/types";

interface ProfileData {
  profile: Profile;
  contributionScore: number | null;
  reliability: UserReliability | null;
  badges: Badge[];
  activity: { kind: "report" | "confirmation"; id: string; status: string; neighborhood: string; at: string }[];
}

/** SCREEN 10 — Profile and community settings. */
export default function ProfilePage() {
  const { L, B, lang, setLang, session, toast, errorText, refreshSession } = useApp();
  const [d, setD] = useState<ProfileData | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const load = useCallback(() => api<ProfileData>("/api/profile").then(setD).catch(() => setD(null)), []);
  useEffect(() => {
    if (session?.user) void load();
  }, [load, session?.user]);

  const patch = async (body: Record<string, unknown>, ok: string) => {
    try {
      await api("/api/profile", { method: "PATCH", body });
      toast(ok, "ok");
      await load();
      await refreshSession();
    } catch (e) {
      toast(errorText(e), "error");
    }
  };

  if (!session) return <Skeleton className="h-96" />;
  if (!session.user) {
    return (
      <Card className="mx-auto max-w-lg text-center">
        <p className="font-semibold">{L("No account selected", "لم يتم اختيار حساب")}</p>
        <p className="mt-1 text-sm text-mute">{L("Use the demo account switcher in the top bar.", "استخدم مبدّل الحسابات التجريبية في الشريط العلوي.")}</p>
        <Link href="/privacy" className="mt-4 inline-block text-sm text-forest-3 underline">{L("Privacy notice", "إشعار الخصوصية")}</Link>
      </Card>
    );
  }
  if (!d) return <Skeleton className="h-96" />;
  const p = d.profile;

  return (
    <div>
      <PageHeader eyebrow={B(ROLE_LABEL[p.role])} title={lang === "ar" ? p.displayNameAr : p.displayName} subtitle={L(`Neighborhood: ${B(NEIGHBORHOOD_LABEL[p.neighborhood])} (coarse — we never store a home location)`, `الحي: ${B(NEIGHBORHOOD_LABEL[p.neighborhood])} (تقريبي — لا نخزن موقع المنزل أبدًا)`)}>
        {p.isDemo && <Pill tone="warn">{L("Demo account", "حساب تجريبي")}</Pill>}
      </PageHeader>

      <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <div className="space-y-6">
          {d.contributionScore !== null && d.reliability && (
            <div className="grid grid-cols-3 gap-3">
              <Card className="p-4"><p className="text-xs text-mute">{L("Contribution score", "درجة المساهمة")}</p><p className="num mt-1 text-3xl font-bold text-forest">{d.contributionScore}</p></Card>
              <Card className="p-4"><p className="text-xs text-mute">{L("Verified handoffs", "تسليمات موثقة")}</p><p className="num mt-1 text-3xl font-bold text-private">{d.reliability.successful}</p></Card>
              <Card className="p-4"><p className="text-xs text-mute">{L("Reliability", "الموثوقية")}</p><p className="num mt-1 text-3xl font-bold text-gold">{Math.round(d.reliability.score * 100)}%</p></Card>
            </div>
          )}
          {d.badges.length > 0 && (
            <section>
              <SectionTitle title={L("Achievement badges", "شارات الإنجاز")} />
              <BadgeGrid badges={d.badges} />
            </section>
          )}
          {p.role === "driver" && (
            <section>
              <SectionTitle title={L("Activity history", "سجل النشاط")} />
              <Card className="p-0">
                {d.activity.length === 0 ? <div className="p-5"><Empty>{L("No activity yet.", "لا يوجد نشاط بعد.")}</Empty></div> : (
                  <ul className="divide-y divide-line">
                    {d.activity.map((a, i) => (
                      <li key={i}>
                        <Link href={`/reports/${a.id}`} className="flex items-center justify-between gap-3 p-4 hover:bg-sage-mist">
                          <div>
                            <p className="text-sm font-semibold">{a.kind === "report" ? L("Departure report", "بلاغ مغادرة") : L("Confirmation", "تأكيد")}{a.neighborhood && <> · {B(NEIGHBORHOOD_LABEL[a.neighborhood] ?? { en: a.neighborhood, ar: a.neighborhood })}</>}</p>
                            <p className="text-xs text-mute">{fmtDateTime(a.at, lang)}</p>
                          </div>
                          {a.kind === "report" ? <StatusPill status={a.status as ReportStatus} /> : <Pill>{a.status}</Pill>}
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </section>
          )}
        </div>

        <div className="space-y-4">
          <Card>
            <h2 className="mb-3 flex items-center gap-2 font-bold"><Languages className="h-5 w-5" aria-hidden />{L("Language", "اللغة")}</h2>
            <div className="grid grid-cols-2 gap-2">
              <Button variant={lang === "ar" ? "primary" : "secondary"} onClick={() => { setLang("ar"); void patch({ lang: "ar" }, "تم اختيار العربية"); }}>العربية</Button>
              <Button variant={lang === "en" ? "primary" : "secondary"} onClick={() => { setLang("en"); void patch({ lang: "en" }, "English selected"); }}>English</Button>
            </div>
          </Card>

          <Card>
            <h2 className="mb-2 flex items-center gap-2 font-bold"><LocateFixed className="h-5 w-5" aria-hidden />{L("Location consent", "الموافقة على الموقع")}</h2>
            <p className="text-xs leading-relaxed text-mute">{L("RAKNA LOOP asks for your location only when you tap an action that needs it (report, navigate, confirm). It never tracks you in the background. Revoking consent here also stops the app from asking until you re-enable it in your browser.", "يطلب ركنة لوب موقعك فقط عند الضغط على إجراء يحتاجه (إبلاغ، توجّه، تأكيد). لا يتتبعك في الخلفية أبدًا. سحب الموافقة هنا يمنع التطبيق من السؤال حتى تعيد تفعيلها في المتصفح.")}</p>
            <div className="mt-3 flex items-center justify-between gap-2 rounded-xl bg-sage-mist p-3 text-sm">
              <span>{p.locationConsentAt ? L(`Granted ${fmtDateTime(p.locationConsentAt, "en")}`, `ممنوحة ${fmtDateTime(p.locationConsentAt, "ar")}`) : L("Not granted", "غير ممنوحة")}</span>
              <Button size="sm" variant="secondary" onClick={() => patch({ locationConsent: !p.locationConsentAt }, p.locationConsentAt ? L("Location consent withdrawn.", "تم سحب الموافقة على الموقع.") : L("Location consent recorded.", "تم تسجيل الموافقة على الموقع."))}>
                {p.locationConsentAt ? L("Withdraw", "سحب") : L("Grant", "منح")}
              </Button>
            </div>
          </Card>

          <Card>
            <h2 className="mb-2 flex items-center gap-2 font-bold"><ShieldCheck className="h-5 w-5" aria-hidden />{L("Privacy settings", "إعدادات الخصوصية")}</h2>
            <ul className="list-disc space-y-1 ps-5 text-xs leading-relaxed text-mute">
              <li>{L("Your name is never shown on the map.", "اسمك لا يظهر على الخريطة أبدًا.")}</li>
              <li>{L("Precise coordinates are visible only to the driver you hand off to, then coarsened after the retention period.", "الإحداثيات الدقيقة تظهر فقط للسائق الذي تسلّمه الموقف، ثم تُقرَّب بعد مدة الاحتفاظ.")}</li>
              <li>{L("We do not collect vehicle registration numbers.", "لا نجمع أرقام لوحات المركبات.")}</li>
            </ul>
            <Link href="/privacy" className="mt-3 inline-block text-sm font-semibold text-forest-3 hover:underline">{L("Read the privacy notice", "اقرأ إشعار الخصوصية")}</Link>
          </Card>

          <Card className="border-danger/20">
            <h2 className="mb-2 flex items-center gap-2 font-bold text-danger"><Trash2 className="h-5 w-5" aria-hidden />{L("Account deletion", "حذف الحساب")}</h2>
            {p.deletionRequestedAt ? (
              <>
                <Notice tone="danger">{L(`Deletion requested on ${fmtDateTime(p.deletionRequestedAt, "en")}. Your account is restricted while the request is processed (target: within 30 days). Ledger entries are retained in anonymized form where required for audit.`, `تم طلب الحذف في ${fmtDateTime(p.deletionRequestedAt, "ar")}. حسابك مقيد أثناء معالجة الطلب (الهدف: خلال 30 يومًا). يُحتفظ بقيود السجل بصيغة مجهولة حيث يلزم للتدقيق.`)}</Notice>
                <Button variant="secondary" className="mt-3 w-full" onClick={() => patch({ requestDeletion: false }, L("Deletion request cancelled.", "تم إلغاء طلب الحذف."))}>{L("Cancel deletion request", "إلغاء طلب الحذف")}</Button>
              </>
            ) : confirmDelete ? (
              <div className="space-y-2">
                <p className="text-sm">{L("Request deletion of your account and personal data? Your Keys balance will be forfeited.", "هل تطلب حذف حسابك وبياناتك الشخصية؟ سيُفقد رصيد المفاتيح.")}</p>
                <div className="flex gap-2">
                  <Button variant="secondary" className="flex-1" onClick={() => setConfirmDelete(false)}>{L("Keep account", "الإبقاء على الحساب")}</Button>
                  <Button variant="danger" className="flex-1" onClick={() => { setConfirmDelete(false); void patch({ requestDeletion: true }, L("Deletion request submitted.", "تم إرسال طلب الحذف.")); }}>{L("Request deletion", "طلب الحذف")}</Button>
                </div>
              </div>
            ) : (
              <Button variant="secondary" className="w-full" onClick={() => setConfirmDelete(true)}>{L("Request account deletion", "طلب حذف الحساب")}</Button>
            )}
          </Card>

          {!session.demoMode && (
            <Button variant="secondary" className="w-full" onClick={async () => { const { supabaseBrowser } = await import("@/lib/client/supabase-browser"); await supabaseBrowser()?.auth.signOut(); await refreshSession(); }}>{L("Sign out", "تسجيل الخروج")}</Button>
          )}
          {session.demoMode && (
            <Card className="border-dashed border-gold/50">
              <h2 className="mb-2 flex items-center gap-2 font-bold text-gold"><RotateCcw className="h-5 w-5" aria-hidden />{L("Demo data", "البيانات التجريبية")}</h2>
              <p className="text-xs text-mute">{L("Restore all demo records (users, reports, ledger, rewards) to their initial state.", "أعد جميع السجلات التجريبية (المستخدمون، البلاغات، السجل، المكافآت) إلى حالتها الأولى.")}</p>
              <Button variant="gold" className="mt-3 w-full" onClick={async () => { try { await api("/api/demo", { body: { action: "reset" } }); toast(L("Demo data reset.", "تمت إعادة ضبط البيانات التجريبية."), "ok"); await load(); await refreshSession(); } catch (e) { toast(errorText(e), "error"); } }}>{L("Reset demo data", "إعادة ضبط البيانات التجريبية")}</Button>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
