"use client";

import { useEffect, useRef } from "react";
import * as maplibregl from "maplibre-gl";
import type { GeoJSONSource, StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { HiveState, LatLng } from "@/lib/types";
import { reconcileIds } from "@/lib/hive/cache";
import { fillOpacityForZoom, HIVE_STATE_STYLE } from "@/lib/hive/hive-map";

// Worker served from /public (copied from node_modules by scripts/copy-maplibre-worker.mjs).
maplibregl.setWorkerUrl("/maplibre-gl-worker.mjs");

export interface MapPoint {
  id: string;
  kind: "signal" | "pending" | "claimed" | "inactive" | "private" | "cluster";
  location: LatLng;
  label?: string;
  title: string;
}

export interface MapHex {
  id: string;
  state: HiveState;
  ring: [number, number][];
}

export interface Viewport {
  west: number;
  south: number;
  east: number;
  north: number;
  zoom: number;
}

/** Built-in OpenStreetMap raster style; override with NEXT_PUBLIC_MAP_STYLE_URL. */
const OSM_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      maxzoom: 19,
      attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors',
    },
  },
  layers: [{ id: "osm", type: "raster", source: "osm", paint: { "raster-saturation": -0.55, "raster-contrast": -0.05, "raster-brightness-max": 0.98 } }],
};

const STATE_FILL = ["match", ["get", "state"], ...Object.entries(HIVE_STATE_STYLE).flatMap(([k, v]) => [k, v.fill]), "#d9a75a"] as unknown as maplibregl.ExpressionSpecification;
const STATE_LINE = ["match", ["get", "state"], ...Object.entries(HIVE_STATE_STYLE).flatMap(([k, v]) => [k, v.line]), "#a9742e"] as unknown as maplibregl.ExpressionSpecification;

/** ~150 m pre-booking privacy circle around a residential space's approximate point. */
export interface MapCircle {
  id: string;
  center: LatLng;
  radiusM: number;
}

function circleCollection(circles: MapCircle[]): GeoJSON.FeatureCollection {
  const STEPS = 48;
  return {
    type: "FeatureCollection",
    features: circles.map((c) => {
      const dLat = c.radiusM / 111_320;
      const dLng = c.radiusM / (111_320 * Math.cos((c.center.lat * Math.PI) / 180));
      const ring: [number, number][] = [];
      for (let i = 0; i <= STEPS; i++) {
        const a = (i / STEPS) * 2 * Math.PI;
        ring.push([c.center.lng + dLng * Math.cos(a), c.center.lat + dLat * Math.sin(a)]);
      }
      return { type: "Feature", id: c.id, properties: { id: c.id }, geometry: { type: "Polygon", coordinates: [ring] } };
    }),
  };
}

function hexCollection(hexes: MapHex[]): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: hexes.map((h) => ({ type: "Feature", id: h.id, properties: { id: h.id, state: h.state }, geometry: { type: "Polygon", coordinates: [h.ring] } })),
  };
}

export function MapView({
  center,
  zoom = 12.5,
  points,
  hexes = [],
  showHexes = true,
  circles = [],
  me,
  selectedId,
  onSelect,
  onHexSelect,
  onViewportChange,
  flyTo,
  className,
}: {
  center: LatLng;
  zoom?: number;
  points: MapPoint[];
  hexes?: MapHex[];
  showHexes?: boolean;
  circles?: MapCircle[];
  me?: LatLng | null;
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  onHexSelect?: (cell: string) => void;
  onViewportChange?: (v: Viewport) => void;
  flyTo?: { center: LatLng; zoom?: number; key: number } | null;
  className?: string;
}) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const loaded = useRef(false);
  const markers = useRef<Map<string, maplibregl.Marker>>(new Map());
  const meMarker = useRef<maplibregl.Marker | null>(null);
  const onSelectRef = useRef(onSelect);
  const onHexRef = useRef(onHexSelect);
  const onViewportRef = useRef(onViewportChange);
  const hexRef = useRef<MapHex[]>(hexes);
  const circleRef = useRef<MapCircle[]>(circles);
  onSelectRef.current = onSelect;
  onHexRef.current = onHexSelect;
  onViewportRef.current = onViewportChange;
  hexRef.current = hexes;
  circleRef.current = circles;

  useEffect(() => {
    if (!el.current || map.current) return;
    const styleUrl = process.env.NEXT_PUBLIC_MAP_STYLE_URL;
    const m = new maplibregl.Map({
      container: el.current,
      style: styleUrl || OSM_STYLE,
      center: [center.lng, center.lat],
      zoom,
      attributionControl: { compact: true },
      dragRotate: false,
    });
    map.current = m;
    // Zoom buttons on larger screens only; phones use pinch-zoom (keeps the search bar clear).
    if (window.matchMedia("(min-width: 768px)").matches) m.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");

    const emit = () => {
      const b = m.getBounds();
      onViewportRef.current?.({ west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth(), zoom: m.getZoom() });
    };
    m.on("load", () => {
      // Honeycomb overlay sits under the HTML markers; low opacity keeps roads and labels readable.
      m.addSource("hive", { type: "geojson", data: hexCollection(hexRef.current) });
      m.addLayer({ id: "hive-fill", type: "fill", source: "hive", paint: { "fill-color": STATE_FILL, "fill-opacity": fillOpacityForZoom(m.getZoom()) } });
      m.addLayer({ id: "hive-line", type: "line", source: "hive", paint: { "line-color": STATE_LINE, "line-width": ["interpolate", ["linear"], ["zoom"], 10, 0.6, 16, 1.4], "line-opacity": 0.75 } });
      // Residential privacy circles: the exact bay is revealed only after a paid booking.
      m.addSource("privacy", { type: "geojson", data: circleCollection(circleRef.current) });
      m.addLayer({ id: "privacy-fill", type: "fill", source: "privacy", paint: { "fill-color": "#1c7a4c", "fill-opacity": 0.12 } });
      m.addLayer({ id: "privacy-line", type: "line", source: "privacy", paint: { "line-color": "#1c7a4c", "line-width": 1.5, "line-dasharray": [2, 2], "line-opacity": 0.8 } });
      m.on("click", "hive-fill", (e) => {
        const id = e.features?.[0]?.properties?.id as string | undefined;
        if (id) onHexRef.current?.(id);
      });
      m.on("mouseenter", "hive-fill", () => (m.getCanvas().style.cursor = "pointer"));
      m.on("mouseleave", "hive-fill", () => (m.getCanvas().style.cursor = ""));
      loaded.current = true;
      emit();
    });
    m.on("moveend", emit);
    m.on("zoomend", () => {
      if (loaded.current && m.getLayer("hive-fill")) m.setPaintProperty("hive-fill", "fill-opacity", fillOpacityForZoom(m.getZoom()));
    });

    const current = markers.current;
    return () => {
      current.forEach((mk) => mk.remove());
      current.clear();
      m.remove();
      map.current = null;
      loaded.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Hexagon data
  useEffect(() => {
    const m = map.current;
    if (!m || !loaded.current) return;
    (m.getSource("hive") as GeoJSONSource | undefined)?.setData(hexCollection(showHexes ? hexes : []));
  }, [hexes, showHexes]);

  useEffect(() => {
    const m = map.current;
    if (!m || !loaded.current) return;
    (m.getSource("privacy") as GeoJSONSource | undefined)?.setData(circleCollection(circles));
  }, [circles]);

  // Markers: reconcile against the latest viewport response — obsolete markers are removed,
  // so the DOM never grows beyond what is currently visible.
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const byId = new Map(points.map((p) => [p.id, p]));
    const { remove } = reconcileIds(markers.current.keys(), byId.keys());
    for (const id of remove) {
      markers.current.get(id)!.remove();
      markers.current.delete(id);
    }
    for (const p of points) {
      let marker = markers.current.get(p.id);
      const cls = `rk-marker rk-marker--${p.kind}${p.kind === "signal" ? " rk-pulse" : ""}${p.id === selectedId ? " rk-marker--selected" : ""}`;
      if (!marker) {
        const node = document.createElement("button");
        node.type = "button";
        node.addEventListener("click", (e) => {
          e.stopPropagation();
          onSelectRef.current?.(p.id);
        });
        marker = new maplibregl.Marker({ element: node }).setLngLat([p.location.lng, p.location.lat]).addTo(m);
        markers.current.set(p.id, marker);
      }
      const node = marker.getElement();
      // Keep MapLibre's own classes (they carry absolute positioning) and swap ours.
      const keep = [...node.classList].filter((c) => c.startsWith("maplibregl-"));
      node.className = [...keep, cls].join(" ");
      node.textContent = p.label ?? "";
      node.setAttribute("aria-label", p.title);
      node.title = p.title;
      marker.setLngLat([p.location.lng, p.location.lat]);
    }
  }, [points, selectedId]);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    if (!me) {
      meMarker.current?.remove();
      meMarker.current = null;
      return;
    }
    if (!meMarker.current) {
      const node = document.createElement("div");
      node.className = "rk-marker rk-marker--me";
      meMarker.current = new maplibregl.Marker({ element: node }).setLngLat([me.lng, me.lat]).addTo(m);
    } else meMarker.current.setLngLat([me.lng, me.lat]);
  }, [me]);

  useEffect(() => {
    if (flyTo && map.current) map.current.flyTo({ center: [flyTo.center.lng, flyTo.center.lat], zoom: flyTo.zoom ?? 14.5, speed: 1.4 });
  }, [flyTo]);

  // MapLibre's CSS forces `.maplibregl-map { position: relative }`, so positioning
  // classes go on a wrapper and the map fills it.
  return (
    <div className={className} dir="ltr">
      <div ref={el} className="h-full w-full" role="application" aria-label="Riyadh parking map" />
    </div>
  );
}
