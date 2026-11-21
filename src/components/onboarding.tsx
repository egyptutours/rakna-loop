"use client";

import { useState } from "react";
import { ArrowLeft, ArrowRight, Car, Gift, HeartHandshake, KeyRound } from "lucide-react";
import { useApp } from "./providers";
import { Logo } from "./app-shell";
import { Button, cn } from "./ui";
import { ROLE_LABEL, TAGLINE } from "@/lib/i18n";

/** SCREEN 1 — Onboarding. */
export function Onboarding({ onDone }: { onDone: () => void }) {
  const { L, B, lang, dir, session, switchUser, toast, errorText } = useApp();
  const [step, setStep] = useState(0);

  const slides = [
    { icon: HeartHandshake, title: L("Help another driver", "ساعد سائقًا آخر"), body: L("Leaving a public spot? Tap “I'm Leaving” and nearby drivers see a short-lived community signal.", "تغادر موقفًا عامًا؟ اضغط «أنا مغادر» ليرى السائقون القريبون إشارة مجتمعية قصيرة المدة.") },
    { icon: Car, title: L("Find parking faster", "اعثر على موقف أسرع"), body: L("See community signals with a transparent confidence score, plus approved private parking you can book.", "شاهد الإشارات المجتمعية مع درجة ثقة واضحة، ومواقف خاصة معتمدة يمكنك حجزها.") },
    { icon: KeyRound, title: L("Earn RAKNA KEYS", "اكسب مفاتيح ركنة"), body: L("When another driver verifies on site that they found your spot, you earn Keys. Verified, never self-claimed.", "عندما يؤكد سائق آخر في الموقع أنه وجد موقفك، تكسب مفاتيح. بالتحقق فقط، لا بالادعاء.") },
    { icon: Gift, title: L("Redeem eligible rewards", "استبدل مكافآت مؤهلة"), body: L("Use Keys for partner parking discounts and perks. Keys are loyalty points — not money, not crypto.", "استخدم المفاتيح لخصومات مواقف الشركاء ومزاياهم. المفاتيح نقاط ولاء — ليست نقودًا ولا عملة رقمية.") },
  ];
  const last = step === slides.length;
  const Next = dir === "rtl" ? ArrowLeft : ArrowRight;
  const S = slides[Math.min(step, slides.length - 1)];

  return (
    <div className="fixed inset-0 z-[80] grid place-items-center bg-forest/70 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label={L("Welcome", "مرحبًا")}>
      <div className="w-full max-w-md overflow-hidden rounded-[1.75rem] bg-paper shadow-[var(--shadow-lift)]">
        <div className="bg-forest px-6 pb-6 pt-7 text-white">
          <div className="flex items-center gap-3">
            <Logo className="h-11 w-11" />
            <div>
              <p className="text-lg font-bold tracking-wide">RAKNA LOOP</p>
              <p className="text-xs text-sage">{B(TAGLINE)}</p>
            </div>
          </div>
        </div>
        <div className="p-6">
          {!last ? (
            <div className="min-h-[190px]">
              <div className="mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-sage-soft text-forest">
                <S.icon className="h-7 w-7" aria-hidden />
              </div>
              <h2 className="text-xl font-bold text-forest">{S.title}</h2>
              <p className="mt-2 text-sm leading-relaxed text-ink-2">{S.body}</p>
            </div>
          ) : (
            <div className="min-h-[190px]">
              <h2 className="text-xl font-bold text-forest">{L("Choose a demo account", "اختر حسابًا تجريبيًا")}</h2>
              <p className="mt-1 text-sm text-mute">{L("Use Driver A to report leaving, then switch to Driver B to find and confirm the spot.", "استخدم السائقة أ للإبلاغ عن المغادرة، ثم بدّل إلى السائق ب للعثور على الموقف وتأكيده.")}</p>
              <div className="mt-4 space-y-2">
                {(session?.demoUsers ?? []).slice(0, 4).map((u) => (
                  <button
                    key={u.id}
                    onClick={async () => {
                      try {
                        await switchUser(u.id);
                        onDone();
                      } catch (e) {
                        toast(errorText(e), "error");
                      }
                    }}
                    className="flex w-full items-center justify-between rounded-xl border border-line bg-card px-4 py-3 text-start text-sm hover:border-forest-3"
                  >
                    <span>{lang === "ar" ? u.displayNameAr : u.displayName}</span>
                    <span className="text-xs text-forest-3">{B(ROLE_LABEL[u.role])}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="mt-6 flex items-center justify-between">
            <div className="flex gap-1.5" aria-hidden>
              {[...slides, null].map((_, i) => (
                <span key={i} className={cn("h-1.5 rounded-full transition-all", i === step ? "w-6 bg-forest" : "w-1.5 bg-line")} />
              ))}
            </div>
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" onClick={onDone}>{L("Skip", "تخطي")}</Button>
              {!last && (
                <Button size="sm" onClick={() => setStep((s) => s + 1)}>
                  {L("Next", "التالي")}
                  <Next className="h-4 w-4" aria-hidden />
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
