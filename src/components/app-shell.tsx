"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Building2, Car, ChevronDown, Compass, Home, KeyRound, Languages, LayoutDashboard, Map, PlusSquare, ShieldCheck, Sparkles, Ticket, User, Users, Gift } from "lucide-react";
import { useApp } from "./providers";
import { useMode, type AppMode } from "./mode";
import { cn } from "./ui";
import { ROLE_LABEL } from "@/lib/i18n";

export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 40 40" className={className} aria-hidden>
      <rect width="40" height="40" rx="12" fill="#163828" />
      <path d="M13 28V12h8.5a5.5 5.5 0 0 1 0 11H13" fill="none" stroke="#f7f5ef" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M20 23l7 5" stroke="#b08d4f" strokeWidth="3" strokeLinecap="round" />
      <circle cx="29" cy="12.5" r="2.5" fill="#a7bea3" />
    </svg>
  );
}

function DemoSwitcher() {
  const { session, switchUser, L, B, lang, toast, errorText } = useApp();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);
  if (!session?.demoMode) return null;
  const user = session.user;
  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex h-10 items-center gap-2 rounded-xl border border-gold/40 bg-gold-soft px-3 text-xs font-semibold text-gold"
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <Users className="h-4 w-4" aria-hidden />
        <span className="max-w-[7.5rem] truncate sm:max-w-[10rem]">{user ? (lang === "ar" ? user.displayNameAr : user.displayName) : L("Demo accounts", "الحسابات التجريبية")}</span>
        <ChevronDown className="h-3.5 w-3.5" aria-hidden />
      </button>
      {open && (
        <div role="menu" className="absolute end-0 z-[60] mt-2 w-72 rounded-2xl border border-line bg-card p-2 shadow-[var(--shadow-lift)]">
          <p className="px-3 py-2 text-[11px] leading-snug text-mute">
            {L("Demo mode: switch accounts to test User A and User B in one browser.", "الوضع التجريبي: بدّل الحسابات لتجربة المستخدم أ والمستخدم ب في متصفح واحد.")}
          </p>
          {session.demoUsers.map((u) => (
            <button
              key={u.id}
              role="menuitem"
              onClick={async () => {
                try {
                  await switchUser(u.id);
                  setOpen(false);
                  toast(L(`Now using ${u.displayName}`, `تم التبديل إلى ${u.displayNameAr}`), "ok");
                } catch (e) {
                  toast(errorText(e), "error");
                }
              }}
              className={cn("flex w-full items-center justify-between gap-2 rounded-xl px-3 py-2.5 text-start text-sm hover:bg-sage-mist", user?.id === u.id && "bg-sage-soft")}
            >
              <span className="truncate">{lang === "ar" ? u.displayNameAr : u.displayName}</span>
              <span className="shrink-0 rounded-full bg-sage-mist px-2 py-0.5 text-[10px] font-semibold text-forest-3">{B(ROLE_LABEL[u.role])}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Driver / Host segmented switch (driver accounts only: a RAKNA HOME host is a driver who lists a bay). */
function ModeSwitcher({ mode, setMode }: { mode: AppMode; setMode: (m: AppMode) => void }) {
  const { L } = useApp();
  const router = useRouter();
  const opt = (m: AppMode, label: string, Icon: typeof Car, href: string) => (
    <button
      type="button"
      role="radio"
      aria-checked={mode === m}
      onClick={() => {
        setMode(m);
        router.push(href);
      }}
      className={cn("flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-semibold transition", mode === m ? "bg-forest text-white" : "text-forest hover:bg-sage-mist")}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden />
      <span className="hidden min-[420px]:inline">{label}</span>
    </button>
  );
  return (
    <div role="radiogroup" aria-label={L("App mode", "وضع التطبيق")} className="flex items-center gap-0.5 rounded-xl border border-line bg-card p-0.5">
      {opt("driver", L("Driver", "سائق"), Car, "/")}
      {opt("host", L("Host", "مضيف"), Home, "/host")}
    </div>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const { L, lang, setLang, session } = useApp();
  const path = usePathname();
  const role = session?.user?.role;
  const [storedMode, setMode] = useMode();
  const canHost = role === "driver";
  const mode: AppMode = canHost && (storedMode === "host" || path.startsWith("/host")) ? "host" : "driver";

  // The three consumer tabs (driver) or the host workspace (host mode).
  const primary =
    mode === "host"
      ? [
          { href: "/host", label: L("Host dashboard", "لوحة المضيف"), short: L("Dashboard", "اللوحة"), icon: LayoutDashboard, exact: true },
          { href: "/host/list", label: L("List my parking", "أدرج موقفي"), short: L("List", "إدراج"), icon: PlusSquare },
          { href: "/wallet", label: L("Wallet & Impact", "المحفظة والأثر"), short: L("Wallet", "المحفظة"), icon: KeyRound },
        ]
      : [
          { href: "/", label: L("Explore & Park", "استكشف واركن"), short: L("Explore", "استكشف"), icon: Map, exact: true },
          { href: "/bookings", label: L("My Bookings & Passes", "حجوزاتي وتصاريحي"), short: L("Bookings", "حجوزاتي"), icon: Ticket },
          { href: "/wallet", label: L("Wallet & Impact", "المحفظة والأثر"), short: L("Wallet", "المحفظة"), icon: KeyRound },
        ];

  const secondary = [
    { href: "/parking", label: L("Partner parking", "مواقف الشركاء"), icon: Building2, show: true },
    { href: "/assistant", label: L("AI assistant", "المساعد الذكي"), icon: Sparkles, show: true },
    { href: "/rewards", label: L("Rewards", "المكافآت"), icon: Gift, show: true },
    { href: "/community", label: L("Community", "المجتمع"), icon: Compass, show: true },
    { href: "/partner", label: L("Partner", "لوحة الشريك"), icon: LayoutDashboard, show: role === "partner" },
    { href: "/admin", label: L("Admin", "الإدارة"), icon: ShieldCheck, show: role === "admin" },
    { href: "/profile", label: L("Profile", "الملف"), icon: User, show: true },
  ].filter((n) => n.show);
  const nav = [...primary, ...secondary];

  const roleTab = role === "partner" ? { href: "/partner", short: L("Partner", "الشريك"), icon: LayoutDashboard } : role === "admin" ? { href: "/admin", short: L("Admin", "الإدارة"), icon: ShieldCheck } : null;
  const mobile = [...primary.slice(0, roleTab ? 2 : 3), ...(roleTab ? [roleTab] : []), { href: "/profile", short: L("More", "المزيد"), icon: User }];

  const isActive = (href: string, exact?: boolean) => (href === "/" || exact ? path === href : path.startsWith(href));
  const fullBleed = path === "/";

  return (
    <div className={cn("flex flex-col", fullBleed ? "h-dvh" : "min-h-dvh")}>
      {session?.demoMode && (
        <div className="bg-forest px-4 py-1.5 text-center text-[11px] font-medium text-sage-soft">
          {L("DEMO MODE — simulated Riyadh data. Rewards and payments are simulated.", "الوضع التجريبي — بيانات محاكاة للرياض. المكافآت والمدفوعات محاكاة.")}
        </div>
      )}
      <header className="sticky top-0 z-50 border-b border-line bg-paper/90 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-7xl items-center gap-3 px-4">
          <Link href="/" className="flex items-center gap-2.5">
            <Logo className="h-9 w-9" />
            <span className="hidden leading-tight min-[400px]:block">
              <span className="block whitespace-nowrap text-[15px] font-bold tracking-wide text-forest">RAKNA LOOP</span>
              <span className="block text-[11px] text-mute">ركنة لوب</span>
            </span>
          </Link>
          <nav className="ms-4 hidden items-center gap-1 xl:flex" aria-label={L("Main", "الرئيسية")}>
            {primary.map((n) => (
              <Link key={n.href} href={n.href} aria-current={isActive(n.href, n.exact) ? "page" : undefined} className={cn("rounded-lg px-3 py-2 text-sm font-semibold transition", isActive(n.href, n.exact) ? "bg-sage-soft text-forest" : "text-ink-2 hover:bg-sage-mist")}>
                {n.label}
              </Link>
            ))}
            <span className="mx-1 h-5 w-px bg-line" aria-hidden />
            {secondary.map((n) => (
              <Link key={n.href} href={n.href} className={cn("rounded-lg px-2.5 py-2 text-sm font-medium transition", isActive(n.href) ? "bg-sage-soft text-forest" : "text-mute hover:bg-sage-mist")}>
                {n.label}
              </Link>
            ))}
          </nav>
          <div className="ms-auto flex items-center gap-2">
            {canHost && <ModeSwitcher mode={mode} setMode={setMode} />}
            <DemoSwitcher />
            {session && !session.demoMode && !session.user && (
              <Link href="/signin" className="flex h-10 items-center rounded-xl bg-forest px-3 text-xs font-semibold text-white">{L("Sign in", "تسجيل الدخول")}</Link>
            )}
            <button
              onClick={() => setLang(lang === "ar" ? "en" : "ar")}
              className="flex h-10 items-center gap-1.5 rounded-xl border border-line bg-card px-3 text-xs font-semibold text-forest hover:bg-sage-mist"
              aria-label={L("Switch language to Arabic", "تغيير اللغة إلى الإنجليزية")}
            >
              <Languages className="h-4 w-4" aria-hidden />
              {lang === "ar" ? "EN" : "عربي"}
            </button>
          </div>
        </div>
        <nav className="no-scrollbar hidden gap-1 overflow-x-auto px-4 pb-2 md:flex xl:hidden" aria-label={L("Sections", "الأقسام")}>
          {nav.map((n) => (
            <Link key={n.href} href={n.href} className={cn("shrink-0 rounded-lg px-3 py-1.5 text-sm font-medium", isActive(n.href, "exact" in n ? Boolean(n.exact) : false) ? "bg-sage-soft text-forest" : "text-ink-2 hover:bg-sage-mist")}>
              {n.label}
            </Link>
          ))}
        </nav>
      </header>

      <main className={cn("flex-1", fullBleed ? "min-h-0 pb-16 md:pb-0" : "mx-auto w-full max-w-7xl px-4 pb-28 pt-6 md:pb-12")}>{children}</main>

      <nav className="fixed inset-x-0 bottom-0 z-50 grid grid-cols-4 border-t border-line bg-card/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden" aria-label={L("Main", "الرئيسية")}>
        {mobile.map((n) => {
          const active = isActive(n.href, "exact" in n ? Boolean(n.exact) : false);
          return (
            <Link key={n.href} href={n.href} aria-current={active ? "page" : undefined} className={cn("flex flex-col items-center gap-0.5 py-2.5 text-[11px] font-medium", active ? "text-forest" : "text-mute")}>
              <n.icon className={cn("h-5 w-5", active && "stroke-[2.4]")} aria-hidden />
              {n.short}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
