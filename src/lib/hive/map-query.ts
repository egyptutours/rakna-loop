import type { HiveState, LatLng, Profile, ShadeTier, SpaceCategory } from "../types";
import type { DomainContext } from "../domain/context";
import { refreshReport } from "../domain/handoff";
import { availableCapacity, withinSchedule } from "../domain/marketplace";
import { getPlatformSettings, isResidential, metroWalk, spaceAvailability, toPublicSpace } from "../domain/home";
import { checkCoverage, collidesWithBuffer } from "../domain/home-schedule";
import { coarsen } from "../geo";
import { cellCenter, cellRing, cellsForViewport, clampBBox, hiveIndexFor, inBBox, type BBox } from "./cells";
import { hasData, summarizeCells, type CellSummary } from "./aggregation";
import { buildHiveSignals, type HiveResourceSignal } from "./signals";

/**
 * MapQueryService — viewport-scoped, zoom-dependent, size-limited.
 *  • Only cells covering the visible viewport (+1 ring) are queried, through indexed
 *    H3 equality filters. The full city is never loaded or shipped.
 *  • Low/medium zoom → aggregated hexagons only (no individual markers).
 *  • Street zoom     → individual signals and approved private spaces, paginated and
 *    clustered per r10 cell when crowded, plus light r10 activity cells.
 */

export interface HiveCellView {
  cell: string;
  state: HiveState;
  ring: [number, number][];
  center: LatLng;
  supply: CellSummary["supply"];
  demand: CellSummary["demand"];
  trail: CellSummary["trail"];
  activity: number;
}

export interface HiveSpaceView {
  id: string;
  title: string;
  titleAr: string;
  /** Exact for commercial spaces; the ~150 m r9 privacy point for residential ones. */
  location: LatLng;
  pricePerHour: number;
  openNow: boolean;
  freeNow: number;
  accessibleBays: number;
  rewardEligible: boolean;
  isDemo: boolean;
  // Phase 3
  category: SpaceCategory;
  approximate: boolean;
  waitlist: boolean;
  guaranteed: boolean;
  shadeTier: ShadeTier | null;
  metro: { code: string; name: string; nameAr: string; walkMinutes: number } | null;
  hourlyRateHalalas: number | null;
  /** True when the space takes start/end bookings (RAKNA HOME / schedule rules). */
  scheduleBooking: boolean;
}

export interface HiveCluster {
  cell: string;
  center: LatLng;
  count: number;
}

export interface HiveMapResponse {
  mode: "aggregate" | "street";
  resolution: number; // data resolution used for queries
  overlayResolution: number; // resolution of the returned hexagons (r9 at street zoom)
  requestedResolution: number;
  cells: HiveCellView[];
  signals: HiveResourceSignal[];
  inactive: { id: string; location: LatLng }[];
  clusters: HiveCluster[];
  spaces: HiveSpaceView[];
  focus: (CellSummary & { center: LatLng }) | null;
  meta: { queriedCells: number; returnedCells: number; truncated: boolean; coarsened: boolean; nextCursor: number | null; limit: number };
}

export function bandFor(zoom: number, bands: { maxZoom: number; resolution: number; mode: "aggregate" | "street" }[]) {
  return bands.find((b) => zoom <= b.maxZoom) ?? bands[bands.length - 1];
}

export async function queryHiveMap(
  ctx: DomainContext,
  input: { bbox: BBox; zoom: number; viewer: Profile | null; viewerLoc?: LatLng | null; cursor?: number },
): Promise<HiveMapResponse> {
  const cfg = await ctx.repo.getHiveConfig();
  const bbox = clampBBox(input.bbox);
  const band = bandFor(input.zoom, cfg.zoomBands);
  const { resolution, cells, coarsened } = cellsForViewport(bbox, band.resolution, cfg.maxCellsPerQuery);
  // Privacy (audit F-PRIV-2): at street zoom the honeycomb overlay is drawn at r9, never
  // r10 — an r10 hex with one live signal would pinpoint it to ~65 m for every viewer.
  // r10 remains the DATA resolution for querying signals and spaces.
  const overlay = band.mode === "street" && !coarsened ? cellsForViewport(bbox, Math.min(9, resolution), cfg.maxCellsPerQuery) : { resolution, cells };
  const summaries = await summarizeCells(ctx, overlay.resolution, overlay.cells);

  const visibleCells: HiveCellView[] = [];
  for (const s of summaries.values()) {
    if (!hasData(s)) continue; // only cells with something to say — keeps payloads small
    visibleCells.push({ cell: s.cell, state: s.state, ring: cellRing(s.cell), center: cellCenter(s.cell), supply: s.supply, demand: s.demand, trail: s.trail, activity: s.activity });
  }

  const centerPt = { lat: (bbox.north + bbox.south) / 2, lng: (bbox.east + bbox.west) / 2 };
  const focusCell = hiveIndexFor(centerPt).r9;
  const focusSummary = (await summarizeCells(ctx, 9, [focusCell])).get(focusCell)!;
  const focus = { ...focusSummary, center: cellCenter(focusCell) };

  const base: HiveMapResponse = {
    mode: band.mode,
    resolution,
    overlayResolution: overlay.resolution,
    requestedResolution: band.resolution,
    cells: visibleCells,
    signals: [],
    inactive: [],
    clusters: [],
    spaces: [],
    focus,
    meta: { queriedCells: cells.length, returnedCells: visibleCells.length, truncated: false, coarsened, nextCursor: null, limit: cfg.maxSignalsPerPage },
  };
  if (band.mode === "aggregate" || coarsened) return base;

  // ── Street mode ──────────────────────────────────────────────────
  const now = ctx.now().getTime();
  // hive_viewport(): live/recent reports AND private spaces of the viewport in ONE round trip.
  const bundle = await ctx.repo.viewportBundle({
    reportRes: resolution,
    reportCells: cells,
    reportStatuses: ["pending_departure", "available", "claimed", "expired", "found", "not_found"],
    reportLimit: 5000,
    spaceRes: resolution,
    spaceCells: cells,
    statRes: resolution,
    statCells: [],
    sinceIso: new Date(now - 86_400_000).toISOString(),
  });
  const raw = bundle.reports;
  const live = [];
  const inactive: { id: string; location: LatLng }[] = [];
  for (const r0 of raw) {
    const r = await refreshReport(ctx, r0);
    const isActive = ["pending_departure", "available", "claimed"].includes(r.status);
    const pos = r.reporterId === input.viewer?.id || r.claimedBy === input.viewer?.id || input.viewer?.role === "admin" ? r.location : coarsen(r.location);
    if (!inBBox(pos, bbox)) continue;
    if (isActive) live.push(r);
    else if (now - new Date(r.resolvedAt ?? r.expiresAt).getTime() < 45 * 60_000 && inactive.length < 50) inactive.push({ id: r.id, location: coarsen(r.location) });
  }
  const signals = await buildHiveSignals(ctx, live, input.viewer, input.viewerLoc ?? null);
  signals.sort((a, b) => b.strength - a.strength || a.id.localeCompare(b.id));

  const cursor = Math.max(0, input.cursor ?? 0);
  const page = signals.slice(cursor, cursor + cfg.maxSignalsPerPage);
  const truncated = signals.length > cursor + cfg.maxSignalsPerPage;

  // Cluster crowded r10 cells below zoom 16 (the user's own / claimed signals are never clustered).
  let clusters: HiveCluster[] = [];
  let shown = page;
  if (input.zoom < 16) {
    const byCell = new Map<string, HiveResourceSignal[]>();
    for (const s of page) {
      if (s.claim === "claimed_by_you" || s.precise) continue;
      if (!byCell.has(s.cell)) byCell.set(s.cell, []);
      byCell.get(s.cell)!.push(s);
    }
    const clustered = new Set<string>();
    clusters = [...byCell.entries()].filter(([, list]) => list.length >= 3).map(([cell, list]) => {
      list.forEach((s) => clustered.add(s.id));
      return { cell, center: cellCenter(cell), count: list.length };
    });
    shown = page.filter((s) => !clustered.has(s.id));
  }

  const spaces: HiveSpaceView[] = [];
  const nowD = ctx.now();
  const settings = await getPlatformSettings(ctx);
  const candidates = [];
  for (const s of bundle.spaces) {
    const availability = await spaceAvailability(ctx, s, settings);
    if (availability === "hidden") continue; // verification required before a space is ever shown
    const pub = toPublicSpace(s, input.viewer);
    if (!inBBox(pub.location, bbox)) continue;
    candidates.push({ s, pub, availability });
  }
  const ruleSpaces = candidates.map((c) => c.s.id);
  const [rules, exceptions] = ruleSpaces.length
    ? await Promise.all([ctx.repo.listAvailabilityRules(ruleSpaces), ctx.repo.listAvailabilityExceptions(ruleSpaces, nowD.toISOString().slice(0, 10))])
    : [[], []];
  const hourEnd = now + 3_600_000;
  for (const { s, pub, availability } of candidates) {
    const myRules = rules.filter((r) => r.spaceId === s.id);
    const scheduleBooking = myRules.length > 0;
    let openNow: boolean;
    let freeNow: number;
    if (scheduleBooking) {
      openNow = availability === "bookable" && checkCoverage(myRules, exceptions.filter((e) => e.spaceId === s.id), now, hourEnd).ok;
      const busy = openNow ? (await ctx.repo.listBookings({ spaceId: s.id })).filter((b) => b.status === "confirmed" && collidesWithBuffer(now, hourEnd, Date.parse(b.startAt), Date.parse(b.endAt), s.bufferMinutes ?? 0)).length : 0;
      freeNow = openNow ? Math.max(0, s.capacity - busy) : 0;
    } else {
      openNow = availability === "bookable" && withinSchedule(s.schedule, nowD, 1);
      freeNow = openNow ? await availableCapacity(ctx, s, nowD, new Date(hourEnd)) : 0;
    }
    spaces.push({
      id: s.id, title: s.title, titleAr: s.titleAr, location: pub.location, pricePerHour: s.pricePerHour, openNow, freeNow,
      accessibleBays: s.accessibleBays ?? 0, rewardEligible: s.rewardEligible, isDemo: s.isDemo,
      category: s.spaceCategory ?? "commercial",
      approximate: isResidential(s) && pub.location !== s.location,
      waitlist: availability === "waitlist",
      guaranteed: availability === "bookable",
      shadeTier: s.shadeTier ?? null,
      metro: metroWalk(pub),
      hourlyRateHalalas: myRules.find((r) => r.isActive)?.hourlyRateHalalas ?? null,
      scheduleBooking,
    });
  }

  return { ...base, signals: shown, inactive, clusters, spaces, meta: { ...base.meta, truncated, nextCursor: truncated ? cursor + cfg.maxSignalsPerPage : null } };
}
