"use client";

import { Compass, Crown, HandHeart, ShieldCheck, TrainFront } from "lucide-react";
import { useApp } from "./providers";
import { cn } from "./ui";
import type { Badge, BadgeId } from "@/lib/domain/community";

const META: Record<BadgeId, { icon: typeof Crown; en: string; ar: string; descEn: string; descAr: string }> = {
  first_helper: { icon: HandHeart, en: "First Helper", ar: "أول فزعة", descEn: "Your first verified handoff", descAr: "أول تسليم موثّق لك" },
  reliable_driver: { icon: ShieldCheck, en: "Reliable Driver", ar: "السائق اللي يُعتمد عليه", descEn: "5 handoffs, 80%+ reliability", descAr: "5 تسليمات بموثوقية 80%+" },
  parking_explorer: { icon: Compass, en: "Parking Explorer", ar: "خبير المواقف", descEn: "Confirmed spots in 3 neighborhoods", descAr: "تأكيدات في 3 أحياء" },
  community_champion: { icon: Crown, en: "Community Champion", ar: "فزّاع الحي", descEn: "10 verified contributions", descAr: "10 مساهمات موثقة" },
  mobility_hero: { icon: TrainFront, en: "Riyadh Mobility Hero", ar: "بطل التنقل في الرياض", descEn: "A Park & Connect mission + 3 handoffs", descAr: "مهمة اركن واتصل + 3 تسليمات" },
};

export function BadgeGrid({ badges }: { badges: Badge[] }) {
  const { lang } = useApp();
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {badges.map((b) => {
        const m = META[b.id];
        return (
          <div key={b.id} className={cn("rounded-2xl border p-4 transition", b.earned ? "border-gold/40 bg-gradient-to-b from-gold-soft to-card" : "border-line bg-card")}>
            <span className={cn("grid h-11 w-11 place-items-center rounded-full", b.earned ? "bg-gold text-white" : "bg-sage-mist text-inactive")}>
              <m.icon className="h-5 w-5" aria-hidden />
            </span>
            <p className={cn("mt-3 text-sm font-bold", b.earned ? "text-ink" : "text-ink-2")}>{lang === "ar" ? m.ar : m.en}</p>
            <p className="mt-0.5 text-[11px] leading-snug text-mute">{lang === "ar" ? m.descAr : m.descEn}</p>
            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-sage-soft">
              <div className={cn("h-full rounded-full", b.earned ? "bg-gold" : "bg-forest-3")} style={{ width: `${Math.round((b.progress / b.target) * 100)}%` }} />
            </div>
            <p className="num mt-1 text-[11px] text-mute">{b.progress}/{b.target}</p>
          </div>
        );
      })}
    </div>
  );
}
