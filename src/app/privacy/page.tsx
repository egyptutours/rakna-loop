"use client";

import { useApp } from "@/components/providers";
import { Card, Disclaimer, PageHeader } from "@/components/ui";

/** Privacy notice, reward terms and legal disclosures (MVP draft — requires legal review). */
export default function PrivacyPage() {
  const { L } = useApp();
  const sections: { title: [string, string]; items: [string, string][] }[] = [
    {
      title: ["What we collect", "وش نجمع"],
      items: [
        ["Your location, only at the moment you tap an action that needs it (report a departure, navigate to a signal, confirm an outcome).", "موقعك، بس لحظة ما تضغط على إجراء يحتاجه (بلاغ طلعة، التوجّه لإشارة، تأكيد نتيجة)."],
        ["Report and confirmation records: time, GPS accuracy, outcome.", "سجلات البلاغات والتأكيدات: الوقت، دقة الموقع، النتيجة."],
        ["A coarse neighborhood for challenges. Never a home address.", "حي تقريبي للتحديات. ما نخزّن عنوان بيتك أبدًا."],
        ["We do not collect vehicle registration numbers, and we do not track you in the background.", "ما نجمع أرقام لوحات السيارات، ولا نتتبعك في الخلفية."],
      ],
    },
    {
      title: ["Who can see your location", "مين يشوف موقعك"],
      items: [
        ["Other drivers see an approximate position (~100 m grid) and never your name.", "السائقين الثانيين يشوفون موقع تقريبي (~100 م) وما يشوفون اسمك أبدًا."],
        ["The exact point is visible only to the single driver who claims your signal, and to administrators for fraud review.", "النقطة الدقيقة تطلع فقط للسائق اللي متوجّه لإشارتك، وللمشرفين عند مراجعة الاحتيال."],
      ],
    },
    {
      title: ["Retention", "مدة الاحتفاظ"],
      items: [
        ["Precise coordinates are coarsened after the retention window (24 hours by default). Aggregated, non-identifying statistics may be kept longer.", "الإحداثيات الدقيقة تتقرّب بعد مدة الاحتفاظ (24 ساعة افتراضيًا). ممكن نحتفظ بإحصاءات مجمّعة ما تعرّف بأحد لمدة أطول."],
        ["Points ledger entries are retained for audit integrity; on account deletion they are anonymized.", "قيود سجل النقاط نحتفظ فيها لسلامة التدقيق، وإذا انحذف الحساب تتجهّل."],
      ],
    },
    {
      title: ["Your choices", "خياراتك"],
      items: [
        ["Grant or withdraw location consent, and request account deletion, from your Profile.", "من ملفك الشخصي تقدر تعطي أو تسحب الموافقة على الموقع، وتطلب حذف حسابك."],
        ["Deletion requests are processed within 30 days (target).", "طلبات الحذف تتعالج خلال 30 يوم (هدف)."],
      ],
    },
    {
      title: ["RAKNA KEYS terms (summary)", "شروط مفاتيح ركنة (ملخص)"],
      items: [
        ["Keys are virtual loyalty points, not money, e-money, securities or cryptocurrency.", "المفاتيح نقاط ولاء افتراضية، وليست فلوس ولا فلوس إلكترونية ولا أوراق مالية ولا عملة رقمية."],
        ["No cash conversion, withdrawal, purchase, or transfer between users. No fixed Saudi Riyal value.", "ما تتحول لفلوس، وما تنسحب، وما تنشرى، وما تنتقل بين المستخدمين. وما لها قيمة ثابتة بالريال السعودي."],
        ["Keys are awarded only after server-side verification and may be reversed after a fraud review.", "المفاتيح تنعطى فقط بعد ما يتحقق الخادم، وممكن تنعكس بعد مراجعة احتيال."],
        ["All redemptions are simulated in the demo. The program requires Saudi regulatory and legal review before commercial launch.", "كل الاستبدالات في النسخة التجريبية محاكاة. البرنامج يحتاج مراجعة تنظيمية وقانونية سعودية قبل الإطلاق التجاري."],
      ],
    },
    {
      title: ["Public street parking", "المواقف العامة في الشوارع"],
      items: [
        ["RAKNA LOOP never claims ownership of public parking. Users cannot reserve, sell, hold, or transfer rights to public spaces.", "ركنة لوب ما يدّعي ملكية المواقف العامة. المستخدمين ما يقدرون يحجزون المواقف العامة أو يبيعونها أو يمسكونها أو ينقلون حقها لأحد."],
        ["Never physically block or hold a public space. Municipal regulations, signs and fees always apply.", "لا تمسك ولا تحجز موقف عام فعليًا. أنظمة البلدية واللوحات والرسوم تنطبق دايم."],
      ],
    },
  ];
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader eyebrow={L("Draft for legal review", "مسودة للمراجعة القانونية")} title={L("Privacy notice & terms", "إشعار الخصوصية والشروط")} subtitle={L("This MVP notice is a product draft aligned with the intent of Saudi Arabia's Personal Data Protection Law (PDPL). It must be reviewed by qualified counsel before launch.", "هذا الإشعار مسودة منتج متوافقة مع روح نظام حماية البيانات الشخصية في المملكة. لازم يراجعه مستشار مؤهل قبل الإطلاق.")} />
      <div className="space-y-4">
        {sections.map((s) => (
          <Card key={s.title[0]}>
            <h2 className="mb-2 font-bold text-forest">{L(...s.title)}</h2>
            <ul className="list-disc space-y-1.5 ps-5 text-sm leading-relaxed text-ink-2">
              {s.items.map((it, i) => <li key={i}>{L(...it)}</li>)}
            </ul>
          </Card>
        ))}
        <Disclaimer />
      </div>
    </div>
  );
}
