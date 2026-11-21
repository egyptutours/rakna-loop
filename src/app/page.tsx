"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Accessibility, Building2, Crosshair, DoorOpen, Hexagon, Layers, Navigation, Search, ShieldCheck, Sparkles, TrainFront, X } from "lucide-react";
import { formatHalalas, SHADE_LABEL, SPACE_CATEGORY_LABEL } from "@/lib/i18n";
import { useApp } from "@/components/providers";
import { Button, ButtonLink, ConfidenceMeter, DemoTag, Disclaimer, Pill, StatusPill, cn } from "@/components/ui";
import type { MapCircle, MapHex, MapPoint, Viewport } from "@/components/map-view";
import { HiveLegend, HivePanel, HiveStateChip } from "@/components/hive-panel";
import { api } from "@/lib/client/api";
import { countdown, fmtSar, timeAgo } from "@/lib/client/format";
import { HiveViewportLoader } from "@/lib/client/hive-viewport";
import { NEIGHBORHOODS, RIYADH_CENTER } from "@/lib/config";
import { distanceM, formatDistance } from "@/lib/geo";
import type { LatLng } from "@/lib/types";
import type { ReportView } from "@/lib/api/views";
import type { HiveMapResponse, HiveSpaceView } from "@/lib/hive/map-query";
import type { HiveResourceSignal } from "@/lib/hive/signals";
import type { ActivityRole } from "@/lib/hive/swarm";
import { Onboarding } from "@/components/onboarding";

const MapView = dynamic(() => import("@/components/map-view").then((m) => m.MapView), {
  ssr: false,
  loading: () => <div className="h-full w-full animate-pulse bg-sage-soft" />,
});

type Filter = "community" | "private" | "inactive" | "highOnly" | "hive";

/** SCREEN 2 — RAKNA HIVE MAP (viewport-scoped, zoom-dependent). */
export default function HomeMap() {
  const { L, lang, session, toast } = useApp();
  const [data, setData] = useState<HiveMapResponse | null>(null);
  const [viewport, setViewport] = useState<Viewport | null>(null);
  const [me, setMe] = useState<LatLng | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [filters, setFilters] = useState<Record<Filter, boolean>>({ community: true, private: true, inactive: true, highOnly: false, hive: true });
  const [fly, setFly] = useState<{ center: LatLng; zoom?: number; key: number } | null>(null);
  const [query, setQuery] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [legendOpen, setLegendOpen] = useState(false);
  const [mine, setMine] = useState<{ active: ReportView | null; claimed: ReportView | null }>({ active: null, claimed: null });
  const [role, setRole] = useState<ActivityRole | null>(null);
  const isDriver = session?.user?.role === "driver";

  // Debounced, cancellable, LRU-cached viewport loader (bounded memory).
  const loaderRef = useRef<HiveViewportLoader<HiveMapResponse> | null>(null);
  if (!loaderRef.current) {
    loaderRef.current = new HiveViewportLoader<HiveMapResponse>(
      async (q, signal) => {
        const res = await fetch(`/api/hive/map?${q}`, { signal, cache: "no-store" });
        const json = await res.json();
        if (!json.ok) throw new Error(json.error?.message ?? "map error");
        return json.data as HiveMapResponse;
      },
      (d) => setData(d),
      { debounceMs: 300, maxEntries: 24, ttlMs: 15_000 },
    );
  }
  useEffect(() => () => loaderRef.current?.dispose(), []);

  const onViewport = useCallback((v: Viewport) => {
    setViewport(v);
    loaderRef.current!.request(v, me);
  }, [me]);

  // Periodic refresh of the CURRENT viewport only (never the city).
  useEffect(() => {
    if (!viewport) return;
    const t = setInterval(() => void loaderRef.current!.load(viewport, me, true).catch(() => {}), 20_000);
    return () => clearInterval(t);
  }, [viewport, me]);

  useEffect(() => {
    if (viewport) void loaderRef.current!.load(viewport, me, true).catch(() => {});
    // reload when the account changes (precision of own/claimed signals differs)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.user?.id]);

  useEffect(() => {
    if (!isDriver) {
      setMine({ active: null, claimed: null });
      return;
    }
    api<{ reports: ReportView[]; claimed: ReportView | null }>("/api/reports")
      .then((d) => setMine({ active: d.reports.find((r) => ["available", "pending_departure", "claimed"].includes(r.status)) ?? null, claimed: d.claimed }))
      .catch(() => {});
  }, [isDriver, session?.user?.id, data]);

  useEffect(() => {
    const c = viewport ? { lat: (viewport.north + viewport.south) / 2, lng: (viewport.east + viewport.west) / 2 } : RIYADH_CENTER;
    api<{ role: ActivityRole }>(`/api/hive/local?lat=${c.lat}&lng=${c.lng}`).then((d) => setRole(d.role)).catch(() => {});
  }, [session?.user?.id, mine.active?.id, mine.claimed?.id, viewport]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    try {
      if (!localStorage.getItem("rakna_onboarded")) setShowOnboarding(true);
    } catch {
      /* storage unavailable */
    }
  }, []);

  const locate = () => {
    if (!("geolocation" in navigator)) return toast(L("Location isn't available in this browser.", "الموقع مو متاح في هذا المتصفح."), "error");
    navigator.geolocation.getCurrentPosition(
      (p) => {
        const loc = { lat: p.coords.latitude, lng: p.coords.longitude };
        setMe(loc);
        setFly({ center: loc, zoom: 15.5, key: Date.now() });
      },
      () => toast(L("Location permission denied.", "رفضت إذن الموقع."), "error"),
      { enableHighAccuracy: true, timeout: 15_000 },
    );
  };

  const search = (e: React.FormEvent) => {
    e.preventDefault();
    const q = query.trim().toLowerCase();
    if (!q) return;
    const hood = NEIGHBORHOODS.find((n) => n.name.toLowerCase().includes(q) || n.nameAr.includes(query.trim()) || q.includes(n.id) || q.includes(n.name.toLowerCase().replace("al ", "")));
    if (hood) setFly({ center: hood.center, zoom: 15.5, key: Date.now() });
    else window.location.href = `/assistant?q=${encodeURIComponent(query)}`;
  };

  const hexes: MapHex[] = useMemo(() => (data?.cells ?? []).map((c) => ({ id: c.cell, state: c.state, ring: c.ring })), [data]);
  // ~150 m privacy circles: residential spaces show an area, never the exact bay, before booking.
  const circles: MapCircle[] = useMemo(
    () => (filters.private ? (data?.spaces ?? []).filter((s) => s.approximate).map((s) => ({ id: s.id, center: s.location, radiusM: 150 })) : []),
    [data, filters.private],
  );

  const points: MapPoint[] = useMemo(() => {
    if (!data) return [];
    const out: MapPoint[] = [];
    if (filters.community) {
      for (const s of data.signals) {
        if (filters.highOnly && s.confidence.level !== "high") continue;
        const kind: MapPoint["kind"] = s.status === "pending_departure" ? "pending" : s.status === "claimed" ? "claimed" : "signal";
        out.push({ id: `r:${s.id}`, kind, location: s.location, title: L("Community parking signal", "إشارة موقف مجتمعية") });
      }
      for (const c of data.clusters) out.push({ id: `c:${c.cell}`, kind: "cluster", location: c.center, label: String(c.count), title: L(`${c.count} signals — zoom in`, `${c.count} إشارات — قرّب أكثر`) });
    }
    if (filters.inactive) for (const r of data.inactive) out.push({ id: `x:${r.id}`, kind: "inactive", location: r.location, title: L("Expired or inactive", "منتهية أو مو شغّالة") });
    if (filters.private) for (const s of data.spaces) out.push({ id: `s:${s.id}`, kind: "private", location: s.location, label: "P", title: lang === "ar" ? s.titleAr : s.title });
    return out;
  }, [data, filters, L, lang]);

  const onSelect = (id: string) => {
    if (id.startsWith("c:")) {
      const c = data?.clusters.find((x) => `c:${x.cell}` === id);
      if (c) setFly({ center: c.center, zoom: 16.5, key: Date.now() });
      return;
    }
    setSelected(id);
  };
  const onHex = (cell: string) => {
    const c = data?.cells.find((x) => x.cell === cell);
    if (c && data?.mode === "aggregate") setFly({ center: c.center, zoom: Math.min(16, (viewport?.zoom ?? 12) + 2), key: Date.now() });
  };

  const selSignal = selected?.startsWith("r:") ? data?.signals.find((s) => `r:${s.id}` === selected) ?? null : null;
  const selSpace = selected?.startsWith("s:") ? data?.spaces.find((s) => `s:${s.id}` === selected) ?? null : null;
  const live = (data?.signals ?? []).filter((s) => s.status !== "claimed");
  const searchAt = me ?? (viewport ? { lat: (viewport.north + viewport.south) / 2, lng: (viewport.east + viewport.west) / 2 } : RIYADH_CENTER);
  const aggregate = data?.mode === "aggregate";

  const chip = (k: Filter, label: string, color?: React.ReactNode) => (
    <button
      key={k}
      onClick={() => setFilters((f) => ({ ...f, [k]: !f[k] }))}
      aria-pressed={filters[k]}
      className={cn("flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold shadow-sm transition", filters[k] ? "border-forest bg-forest text-white" : "border-line bg-card text-ink-2")}
    >
      {color}
      {label}
    </button>
  );

  return (
    <div className="relative grid h-full md:grid-cols-[1fr_400px]">
      {showOnboarding && (
        <Onboarding
          onDone={() => {
            try {
              localStorage.setItem("rakna_onboarded", "1");
            } catch {
              /* ignore */
            }
            setShowOnboarding(false);
          }}
        />
      )}

      <section className="relative min-h-0">
        <MapView
          center={RIYADH_CENTER}
          zoom={12}
          points={points}
          hexes={hexes}
          showHexes={filters.hive}
          circles={circles}
          me={me}
          selectedId={selected}
          onSelect={onSelect}
          onHexSelect={onHex}
          onViewportChange={onViewport}
          flyTo={fly}
          className="absolute inset-0"
        />

        <div className="pointer-events-none absolute inset-x-0 top-0 space-y-2 p-3">
          <form onSubmit={search} className="pointer-events-auto mx-auto flex max-w-xl items-center gap-2 rounded-2xl border border-line bg-card/95 p-1.5 shadow-[var(--shadow-lift)] backdrop-blur">
            <Search className="ms-2 h-4 w-4 shrink-0 text-mute" aria-hidden />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={L("Search destination — e.g. Al Olaya", "دوّر على وجهة — مثل العليا")} className="h-10 min-w-0 flex-1 bg-transparent text-sm outline-none" aria-label={L("Search destination", "دوّر على وجهة")} />
            <button type="button" onClick={locate} className="grid h-10 w-10 place-items-center rounded-xl text-forest hover:bg-sage-mist" aria-label={L("Show my location", "وين أنا؟")}>
              <Crosshair className="h-5 w-5" aria-hidden />
            </button>
          </form>
          <div className="no-scrollbar pointer-events-auto mx-auto flex max-w-xl gap-2 overflow-x-auto pb-1">
            {chip("hive", L("Hive", "الخلايا"), <Hexagon className="h-3 w-3 fill-gold/60 text-gold" aria-hidden />)}
            {chip("community", L("Community", "مجتمعية"), <span className="h-2.5 w-2.5 rounded-full bg-signal" aria-hidden />)}
            {chip("private", L("Private", "خاصة"), <span className="h-2.5 w-2.5 rounded-full bg-private" aria-hidden />)}
            {chip("inactive", L("Inactive", "مو شغّالة"), <span className="h-2.5 w-2.5 rounded-full bg-inactive" aria-hidden />)}
            {chip("highOnly", L("High confidence only", "ثقة عالية فقط"))}
          </div>
          {aggregate && (
            <p className="pointer-events-auto mx-auto w-fit rounded-full bg-card/95 px-3 py-1 text-[11px] text-ink-2 shadow-sm">
              {L("Hive overview — zoom in to see individual signals and private spaces", "نظرة على الخلايا — قرّب عشان تشوف الإشارات والمواقف الخاصة")}
            </p>
          )}
          {data?.focus && (
            <div className="pointer-events-auto mx-auto flex w-fit items-center gap-2 rounded-full bg-card/95 px-3 py-1 text-[11px] shadow-sm md:hidden">
              {L("This hive", "هذه الخلية")}: <HiveStateChip state={data.focus.state} />
            </div>
          )}
        </div>

        <div className="pointer-events-none absolute bottom-9 start-3 end-3 flex items-end justify-between gap-3 md:bottom-3 md:end-auto">
          <div className="pointer-events-auto max-w-[19rem] rounded-2xl border border-line bg-card/95 p-3 text-[11px] shadow-[var(--shadow-soft)] backdrop-blur">
            <button type="button" onClick={() => setLegendOpen((o) => !o)} aria-expanded={legendOpen} className="flex items-center gap-1 font-semibold text-ink md:pointer-events-none">
              <Layers className="h-3.5 w-3.5" aria-hidden />{L("Legend", "دليل الألوان")}
            </button>
            <div className={cn("mt-1.5 space-y-2", !legendOpen && "hidden md:block")}>
              <ul className="space-y-1">
                <li className="flex items-center gap-2"><span className="h-3 w-3 rounded-full bg-signal" />{L("Community signal — not guaranteed", "إشارة مجتمعية — مو مضمونة")}</li>
                <li className="flex items-center gap-2"><span className="h-3 w-3 rounded-full border-2 border-dashed border-signal bg-white" />{L("Upcoming departure", "طالع قريب")}</li>
                <li className="flex items-center gap-2"><span className="h-3 w-3 rounded bg-private" />{L("Approved private — bookable", "خاص معتمد — تقدر تحجزه")}</li>
                <li className="flex items-center gap-2"><span className="h-3 w-3 rounded-full bg-inactive" />{L("Expired / inactive", "منتهي / مو شغّال")}</li>
              </ul>
              {filters.hive && <div className="border-t border-line pt-2"><HiveLegend compact /></div>}
              {session?.demoMode && <DemoTag />}
            </div>
          </div>
          {isDriver && !mine.active && (
            <ButtonLink href="/report" className="pointer-events-auto h-14 rounded-2xl px-5 text-base shadow-[var(--shadow-lift)] md:hidden">
              <DoorOpen className="h-5 w-5" aria-hidden />
              {L("I'm Leaving", "بطلع الحين")}
            </ButtonLink>
          )}
        </div>

        {(selSignal || selSpace) && (
          <div className="absolute inset-x-3 bottom-3 z-10 md:hidden">
            <SelectionCard signal={selSignal} space={selSpace} me={me} now={now} onClose={() => setSelected(null)} />
          </div>
        )}
      </section>

      <aside className="hidden min-h-0 flex-col gap-4 overflow-y-auto border-s border-line bg-paper p-4 md:flex">
        {!session?.user && (
          <div className="rounded-[var(--radius-card)] bg-forest p-5 text-white">
            <p className="text-lg font-bold">{L("Welcome to RAKNA LOOP", "يا هلا فيك في ركنة لوب")}</p>
            <p className="mt-1 text-sm text-sage-soft">{L("Pick a demo account from the top bar to start.", "اختر حساب تجريبي من الشريط اللي فوق عشان تبدأ.")}</p>
            <Button variant="gold" size="sm" className="mt-3" onClick={() => setShowOnboarding(true)}>{L("How it works", "كيف تشتغل")}</Button>
          </div>
        )}
        {isDriver && (
          <div className="rounded-[var(--radius-card)] bg-forest p-5 text-white shadow-[var(--shadow-lift)]">
            {mine.active ? (
              <>
                <p className="text-xs text-sage">{L("Your departure report", "بلاغ طلعتك")}</p>
                <p className="mt-1 text-lg font-bold">{mine.active.status === "claimed" ? L("A driver is on the way", "فيه سائق جايك") : L("Live — helping drivers nearby", "شغّال — يساعد السائقين اللي حولك")}</p>
                <p className="mt-1 text-sm text-sage-soft">{L("Expires in", "ينتهي بعد")} <span className="num font-semibold text-white">{countdown(mine.active.expiresAt, now)}</span></p>
                <ButtonLink href={`/reports/${mine.active.id}`} variant="gold" className="mt-3 w-full">{L("View report", "شوف البلاغ")}</ButtonLink>
              </>
            ) : (
              <>
                <p className="text-lg font-bold">{L("Leaving a public spot?", "بتطلع من موقف عام؟")}</p>
                <p className="mt-1 text-sm text-sage-soft">{L("Tell nearby drivers. Earn RAKNA KEYS when someone verifies they found it.", "علّم السائقين اللي حولك. تكسب مفاتيح ركنة إذا أكّد واحد منهم إنه لقاه.")}</p>
                <ButtonLink href="/report" variant="gold" className="mt-3 h-12 w-full text-base"><DoorOpen className="h-5 w-5" aria-hidden />{L("I'm Leaving", "بطلع الحين")}</ButtonLink>
              </>
            )}
          </div>
        )}
        {mine.claimed && (
          <Link href={`/reports/${mine.claimed.id}`} className="rounded-2xl border border-signal/30 bg-signal-soft p-4 text-sm text-signal">
            <p className="font-semibold">{L("You're heading to a signal", "أنت رايح لإشارة")}</p>
            <p className="mt-0.5">{L("Confirm the outcome when you arrive →", "أكّد النتيجة إذا وصلت ←")}</p>
          </Link>
        )}

        <HivePanel focus={data?.focus ?? null} role={role} searchAt={searchAt} isDriver={isDriver} />

        {(selSignal || selSpace) && <SelectionCard signal={selSignal} space={selSpace} me={me} now={now} onClose={() => setSelected(null)} />}

        <div>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-bold text-ink">{aggregate ? L("Zoom in to list signals", "قرّب عشان تشوف الإشارات") : L("Signals in view", "إشارات في حدود الخريطة")}</h2>
            {!aggregate && <Pill tone="signal"><span className="num">{live.length}</span></Pill>}
          </div>
          <div className="space-y-2">
            {!aggregate && live.length === 0 && <p className="rounded-2xl border border-dashed border-line p-4 text-center text-xs text-mute">{L("No live signals in this area right now.", "ما فيه إشارات شغّالة في هالمنطقة الحين.")}</p>}
            {live.slice(0, 12).map((s) => (
              <button key={s.id} onClick={() => { setSelected(`r:${s.id}`); setFly({ center: s.location, zoom: 16.5, key: Date.now() }); }} className="flex w-full items-center justify-between gap-3 rounded-2xl border border-line bg-card p-3 text-start hover:border-signal/40">
                <div className="min-w-0">
                  <p className="text-sm font-semibold">{L("Community signal", "إشارة مجتمعية")}</p>
                  <p className="text-xs text-mute">{timeAgo(s.reportedAt, lang, now)}{me && <> · {formatDistance(distanceM(me, s.location), lang)}</>}</p>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <StatusPill status={s.status} />
                  <span className="num text-[11px] text-mute">{Math.round(s.strength * 100)}% {L("strength", "قوة")}</span>
                </div>
              </button>
            ))}
            {data?.meta.truncated && <p className="text-center text-[11px] text-mute">{L("More signals in this area — zoom in.", "فيه إشارات ثانية في هالمنطقة — قرّب.")}</p>}
          </div>
        </div>

        <ButtonLink href="/assistant" variant="secondary"><Sparkles className="h-4 w-4" aria-hidden />{L("Ask the AI parking assistant", "اسأل مساعد المواقف الذكي")}</ButtonLink>
        <Disclaimer />
        {data && (
          <p className="text-center text-[10px] text-mute">
            {L("Hive resolution", "دقة الخلايا")} r{data.resolution} · <span className="num">{data.meta.returnedCells}/{data.meta.queriedCells}</span> {L("cells", "خلية")}
          </p>
        )}
      </aside>
    </div>
  );
}

function SelectionCard({ signal, space, me, now, onClose }: { signal: HiveResourceSignal | null; space: HiveSpaceView | null; me: LatLng | null; now: number; onClose: () => void }) {
  const { L, B, lang } = useApp();
  return (
    <div className="relative rounded-[var(--radius-card)] border border-line bg-card p-4 shadow-[var(--shadow-lift)]">
      <button onClick={onClose} className="absolute end-3 top-3 grid h-8 w-8 place-items-center rounded-lg text-mute hover:bg-sage-mist" aria-label={L("Close", "سكّر")}>
        <X className="h-4 w-4" aria-hidden />
      </button>
      {signal && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 pe-8">
            <StatusPill status={signal.status} />
            {signal.isDemo && <DemoTag />}
          </div>
          <p className="text-sm font-semibold">{L("Hive resource signal", "إشارة مورد الخلية")}</p>
          <p className="text-xs text-mute">
            {timeAgo(signal.reportedAt, lang, now)}
            {me && <> · {formatDistance(distanceM(me, signal.location), lang)}</>}
            {["available", "pending_departure", "claimed"].includes(signal.status) && <> · {L("expires in", "ينتهي بعد")} <span className="num">{countdown(signal.expiresAt, now)}</span></>}
          </p>
          <ConfidenceMeter level={signal.confidence.level} score={signal.confidence.score} />
          <p className="text-xs leading-relaxed text-ink-2">{B(signal.explanation)}</p>
          <ButtonLink href={`/reports/${signal.id}`} variant="signal" className="w-full">
            <Navigation className="h-4 w-4" aria-hidden />
            {L("View details", "شوف التفاصيل")}
          </ButtonLink>
        </div>
      )}
      {space && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 pe-8">
            <Pill tone="private"><Building2 className="h-3 w-3" aria-hidden />{B(SPACE_CATEGORY_LABEL[space.category])}</Pill>
            <Pill tone="forest">{L("Verified", "موثّق")}</Pill>
            {space.isDemo && <DemoTag />}
          </div>
          <p className="text-sm font-semibold">{lang === "ar" ? space.titleAr : space.title}</p>
          <div className="flex flex-wrap gap-2 text-xs">
            <Pill>{space.hourlyRateHalalas !== null ? formatHalalas(space.hourlyRateHalalas, lang) : fmtSar(space.pricePerHour, lang)} / {L("hour", "ساعة")}</Pill>
            {space.waitlist ? (
              <Pill tone="warn">{L("Waitlist — villa bookings open soon", "قائمة انتظار — حجوزات الفلل قريب")}</Pill>
            ) : (
              <Pill tone={space.openNow ? "private" : "inactive"}>{space.openNow ? L(`${space.freeNow} free now`, `${space.freeNow} متاح الحين`) : L("Closed now", "مقفل الحين")}</Pill>
            )}
            {space.shadeTier && <Pill>{B(SHADE_LABEL[space.shadeTier])}</Pill>}
            {space.metro && <Pill tone="signal"><TrainFront className="h-3 w-3" aria-hidden />{L(`${space.metro.walkMinutes} min walk to ${space.metro.name}`, `${space.metro.walkMinutes} د مشي لـ${space.metro.nameAr}`)}</Pill>}
            {space.accessibleBays > 0 && <Pill><Accessibility className="h-3 w-3" aria-hidden />{space.accessibleBays}</Pill>}
            {space.rewardEligible && <Pill tone="gold">{L("Keys discount eligible", "يقبل خصم المفاتيح")}</Pill>}
          </div>
          {space.approximate && (
            <p className="flex gap-1.5 text-[11px] leading-snug text-mute">
              <ShieldCheck className="h-3.5 w-3.5 shrink-0" aria-hidden />
              {L("Approximate area (~150 m) to protect the host's privacy. The exact bay and your gate pass appear after payment, 30 minutes before your booking.", "منطقة تقريبية (~150 م) عشان نحمي خصوصية المضيف. الموقف الدقيق وتصريح الدخول يطلعون بعد الدفع، قبل الحجز بـ ٣٠ دقيقة.")}
            </p>
          )}
          {!space.waitlist && <p className="text-[11px] text-mute">{L("Bookable subject to availability.", "تقدر تحجزه حسب التوفر.")}</p>}
          {!space.waitlist && (
            <ButtonLink href={space.scheduleBooking ? `/book/${space.id}` : `/parking?space=${space.id}`} variant="private" className="w-full">{L("Book this space", "احجز هذا الموقف")}</ButtonLink>
          )}
        </div>
      )}
    </div>
  );
}
