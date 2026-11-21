"use client";

import { useApp } from "@/components/providers";
import { Card, Disclaimer, PageHeader } from "@/components/ui";

/** Privacy notice, reward terms and legal disclosures (MVP draft — requires legal review). */
export default function PrivacyPage() {
  const { L } = useApp();
  const sections: { title: [string, string]; items: [string, string][] }[] = [
    {
      title: ["What we collect", "ما الذي نجمعه"],
      items: [
        ["Your location, only at the moment you tap an action that needs it (report a departure, navigate to a signal, confirm an outcome).", "موقعك، فقط لحظة الضغط على إجراء يحتاجه (الإبلاغ عن مغادرة، التوجه إلى إشارة، تأكيد نتيجة)."],
        ["Report and confirmation records: time, GPS accuracy, outcome.", "سجلات البلاغات والتأكيدات: الوقت، دقة الموقع، النتيجة."],
        ["A coarse neighborhood for challenges. Never a home address.", "حي تقريبي للتحديات. لا عنوان منزل أبدًا."],
        ["We do not collect vehicle registration numbers, and we do not track you in the background.", "لا نجمع أرقام لوحات المركبات، ولا نتتبعك في الخلفية."],
      ],
    },
    {
      title: ["Who can see your location", "من يرى موقعك"],
      items: [
        ["Other drivers see an approximate position (~100 m grid) and never your name.", "يرى السائقون الآخرون موقعًا تقريبيًا (~100 م) ولا يرون اسمك أبدًا."],
        ["The exact point is visible only to the single driver who claims your signal, and to administrators for fraud review.", "النقطة الدقيقة تظهر فقط للسائق الذي يتوجه إلى إشارتك، وللمشرفين لمراجعة الاحتيال."],
      ],
    },
    {
      title: ["Retention", "الاحتفاظ"],
      items: [
        ["Precise coordinates are coarsened after the retention window (24 hours by default). Aggregated, non-identifying statistics may be kept longer.", "تُقرَّب الإحداثيات الدقيقة بعد مدة الاحتفاظ (24 ساعة افتراضيًا). قد يُحتفظ بإحصاءات مجمعة غير معرِّفة لمدة أطول."],
        ["Points ledger entries are retained for audit integrity; on account deletion they are anonymized.", "يُحتفظ بقيود سجل النقاط لسلامة التدقيق؛ وعند حذف الحساب تُجهَّل."],
      ],
    },
    {
      title: ["Your choices", "خياراتك"],
      items: [
        ["Grant or withdraw location consent, and request account deletion, from your Profile.", "امنح أو اسحب الموافقة على الموقع، واطلب حذف الحساب، من ملفك الشخصي."],
        ["Deletion requests are processed within 30 days (target).", "تُعالج طلبات الحذف خلال 30 يومًا (هدف)."],
      ],
    },
    {
      title: ["RAKNA KEYS terms (summary)", "شروط مفاتيح ركنة (ملخص)"],
      items: [
        ["Keys are virtual loyalty points, not money, e-money, securities or cryptocurrency.", "المفاتيح نقاط ولاء افتراضية، وليست نقودًا ولا نقودًا إلكترونية ولا أوراقًا مالية ولا عملة رقمية."],
        ["No cash conversion, withdrawal, purchase, or transfer between users. No fixed Saudi Riyal value.", "لا تحويل نقدي ولا سحب ولا شراء ولا نقل بين المستخدمين. لا قيمة ثابتة بالريال السعودي."],
        ["Keys are awarded only after server-side verification and may be reversed after a fraud review.", "تُمنح المفاتيح فقط بعد التحقق من الخادم وقد تُعكس بعد مراجعة احتيال."],
        ["All redemptions are simulated in the demo. The program requires Saudi regulatory and legal review before commercial launch.", "جميع الاستبدالات محاكاة في النسخة التجريبية. يتطلب البرنامج مراجعة تنظيمية وقانونية سعودية قبل الإطلاق التجاري."],
      ],
    },
    {
      title: ["Public street parking", "المواقف العامة في الشوارع"],
      items: [
        ["RAKNA LOOP never claims ownership of public parking. Users cannot reserve, sell, hold, or transfer rights to public spaces.", "لا يدّعي ركنة لوب ملكية المواقف العامة. لا يمكن للمستخدمين حجز المواقف العامة أو بيعها أو الاحتفاظ بها أو نقل حقوقها."],
        ["Never physically block or hold a public space. Municipal regulations, signs and fees always apply.", "لا تمنع أو تحجز موقفًا عامًا فعليًا. تنطبق دائمًا أنظمة البلدية واللوحات والرسوم."],
      ],
    },
  ];
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader eyebrow={L("Draft for legal review", "مسودة للمراجعة القانونية")} title={L("Privacy notice & terms", "إشعار الخصوصية والشروط")} subtitle={L("This MVP notice is a product draft aligned with the intent of Saudi Arabia's Personal Data Protection Law (PDPL). It must be reviewed by qualified counsel before launch.", "هذا الإشعار مسودة منتج تتوافق مع روح نظام حماية البيانات الشخصية في المملكة. يجب أن يراجعه مستشار مؤهل قبل الإطلاق.")} />
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
