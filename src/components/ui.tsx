"use client";

import Link from "next/link";
import { forwardRef } from "react";
import { AlertTriangle, Info, KeyRound } from "lucide-react";
import { useApp } from "./providers";
import { CONFIDENCE_LABEL, DISCLAIMER, FACTOR_LABEL, STATUS_LABEL } from "@/lib/i18n";
import type { ReportStatus } from "@/lib/types";

export function cn(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(" ");
}

export function Card({ className, children, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("rounded-[var(--radius-card)] border border-line bg-card p-5 shadow-[var(--shadow-soft)]", className)} {...rest}>
      {children}
    </div>
  );
}

type BtnVariant = "primary" | "secondary" | "ghost" | "danger" | "signal" | "private" | "gold";

const BTN: Record<BtnVariant, string> = {
  primary: "bg-forest text-white hover:bg-forest-2 disabled:bg-forest/50",
  secondary: "bg-card text-forest border border-line hover:bg-sage-mist",
  ghost: "text-forest hover:bg-sage-mist",
  danger: "bg-danger text-white hover:brightness-110",
  signal: "bg-signal text-white hover:brightness-110",
  private: "bg-private text-white hover:brightness-110",
  gold: "bg-gold text-white hover:brightness-110",
};

export const Button = forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; size?: "sm" | "md" | "lg"; loading?: boolean }>(
  function Button({ variant = "primary", size = "md", loading, className, children, disabled, ...rest }, ref) {
    const sz = size === "sm" ? "h-9 px-3 text-sm" : size === "lg" ? "h-14 px-6 text-base" : "h-11 px-4 text-sm";
    return (
      <button
        ref={ref}
        disabled={disabled || loading}
        className={cn("inline-flex items-center justify-center gap-2 rounded-xl font-semibold transition disabled:cursor-not-allowed disabled:opacity-60", sz, BTN[variant], className)}
        {...rest}
      >
        {loading && <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden />}
        {children}
      </button>
    );
  },
);

export function ButtonLink({ href, variant = "primary", className, children }: { href: string; variant?: BtnVariant; className?: string; children: React.ReactNode }) {
  return (
    <Link href={href} className={cn("inline-flex h-11 items-center justify-center gap-2 rounded-xl px-4 text-sm font-semibold transition", BTN[variant], className)}>
      {children}
    </Link>
  );
}

export function Pill({ tone = "neutral", children, className }: { tone?: "neutral" | "signal" | "private" | "gold" | "danger" | "warn" | "forest" | "inactive"; children: React.ReactNode; className?: string }) {
  const tones = {
    neutral: "bg-sage-mist text-ink-2",
    signal: "bg-signal-soft text-signal",
    private: "bg-private-soft text-private",
    gold: "bg-gold-soft text-gold",
    danger: "bg-danger-soft text-danger",
    warn: "bg-warn-soft text-warn",
    forest: "bg-forest text-white",
    inactive: "bg-inactive-soft text-mute",
  };
  return <span className={cn("inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold", tones[tone], className)}>{children}</span>;
}

export function DemoTag() {
  const { L } = useApp();
  return <Pill tone="warn">{L("DEMO DATA", "بيانات تجريبية")}</Pill>;
}

export function StatusPill({ status }: { status: ReportStatus }) {
  const { B } = useApp();
  const tone = status === "available" || status === "pending_departure" ? "signal" : status === "found" ? "private" : status === "flagged" ? "warn" : status === "not_found" ? "danger" : "inactive";
  return <Pill tone={tone}>{B(STATUS_LABEL[status])}</Pill>;
}

export function Disclaimer({ compact }: { compact?: boolean }) {
  const { B } = useApp();
  return (
    <div className={cn("flex gap-2 rounded-2xl border border-signal/20 bg-signal-soft/70 text-signal", compact ? "p-2.5 text-[11px] leading-snug" : "p-3.5 text-xs leading-relaxed")}>
      <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <p>{B(DISCLAIMER)}</p>
    </div>
  );
}

export function Notice({ tone = "warn", children }: { tone?: "warn" | "danger" | "info"; children: React.ReactNode }) {
  const cls = tone === "danger" ? "bg-danger-soft text-danger border-danger/20" : tone === "info" ? "bg-sage-mist text-ink-2 border-line" : "bg-warn-soft text-warn border-warn/20";
  return (
    <div className={cn("flex gap-2 rounded-2xl border p-3.5 text-xs leading-relaxed", cls)}>
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div>{children}</div>
    </div>
  );
}

export function Keys({ n, className, size = "md" }: { n: number; className?: string; size?: "sm" | "md" | "lg" | "xl" }) {
  const s = { sm: "text-sm", md: "text-base", lg: "text-2xl", xl: "text-5xl" }[size];
  const icon = { sm: "h-3.5 w-3.5", md: "h-4 w-4", lg: "h-6 w-6", xl: "h-10 w-10" }[size];
  return (
    <span className={cn("inline-flex items-center gap-1.5 font-bold text-gold", s, className)}>
      <KeyRound className={icon} aria-hidden />
      <span className="num">{n}</span>
    </span>
  );
}

export function ConfidenceMeter({ level, score, factors, showFactors }: { level: "high" | "medium" | "low"; score: number; factors?: { key: string; value: number; weight: number }[]; showFactors?: boolean }) {
  const { B } = useApp();
  const color = level === "high" ? "bg-private" : level === "medium" ? "bg-gold" : "bg-danger";
  const bars = level === "high" ? 3 : level === "medium" ? 2 : 1;
  return (
    <div>
      <div className="flex items-center gap-2">
        <div className="flex items-end gap-0.5" aria-hidden>
          {[1, 2, 3].map((i) => (
            <span key={i} className={cn("w-1.5 rounded-sm", i <= bars ? color : "bg-line")} style={{ height: 6 + i * 4 }} />
          ))}
        </div>
        <span className="text-sm font-semibold">{B(CONFIDENCE_LABEL[level])}</span>
        <span className="num text-xs text-mute">{score}/100</span>
      </div>
      {showFactors && factors && (
        <ul className="mt-3 space-y-2">
          {factors.map((f) => (
            <li key={f.key} className="grid grid-cols-[1fr_auto] items-center gap-x-3 text-xs">
              <span className="text-ink-2">{B(FACTOR_LABEL[f.key] ?? { en: f.key, ar: f.key })}</span>
              <span className="num text-mute">{Math.round(f.value * 100)}% × {f.weight}</span>
              <span className="col-span-2 mt-1 h-1.5 overflow-hidden rounded-full bg-sage-soft">
                <span className="block h-full rounded-full bg-forest-3" style={{ width: `${Math.round(f.value * 100)}%` }} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function SectionTitle({ title, subtitle, action }: { title: string; subtitle?: string; action?: React.ReactNode }) {
  return (
    <div className="mb-4 flex items-end justify-between gap-3">
      <div>
        <h2 className="text-lg font-bold text-ink">{title}</h2>
        {/* short Al Sadu accent under section titles */}
        <span className="najdi-sadu mt-1.5 block h-1 w-12 rounded-full" aria-hidden />
        {subtitle && <p className="mt-1.5 text-sm text-mute">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

export function PageHeader({ eyebrow, title, subtitle, children }: { eyebrow?: string; title: string; subtitle?: string; children?: React.ReactNode }) {
  return (
    <header className="mb-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          {eyebrow && <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-forest-3">{eyebrow}</p>}
          <h1 className="text-2xl font-bold text-forest md:text-3xl">{title}</h1>
          {subtitle && <p className="mt-1 max-w-2xl text-sm text-mute">{subtitle}</p>}
        </div>
        {children}
      </div>
      {/* Najdi stepped crenellations as the page hero's bottom edge (decorative). */}
      <div className="najdi-crenel mt-4 h-2.5 w-full" aria-hidden />
    </header>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="najdi-door rounded-2xl border border-dashed border-line p-6 text-center text-sm text-mute">{children}</div>;
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-2xl bg-sage-soft/70", className)} />;
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-ink-2">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-mute">{hint}</span>}
    </label>
  );
}

export const inputCls = "h-11 w-full rounded-xl border border-line bg-white px-3 text-sm text-ink outline-none transition focus:border-forest-3 focus:ring-2 focus:ring-sage-soft";

export function Stat({ label, value, tone }: { label: string; value: React.ReactNode; tone?: "gold" | "signal" | "private" | "danger" }) {
  const c = tone === "gold" ? "text-gold" : tone === "signal" ? "text-signal" : tone === "private" ? "text-private" : tone === "danger" ? "text-danger" : "text-forest";
  return (
    <div className="rounded-2xl border border-line bg-card p-4">
      <p className="text-xs text-mute">{label}</p>
      <p className={cn("num mt-1 text-2xl font-bold", c)}>{value}</p>
    </div>
  );
}
