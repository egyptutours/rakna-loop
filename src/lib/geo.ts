import type { LatLng } from "./types";
import { NEIGHBORHOODS } from "./config";

const EARTH_RADIUS_M = 6_371_000;

/** Great-circle distance in metres. */
export function distanceM(a: LatLng, b: LatLng): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Coarsen a coordinate for public display (~110 m grid at 3 decimals).
 * Precise coordinates are only revealed to the reporter, the active claimer and admins.
 */
export function coarsen(p: LatLng, decimals = 3): LatLng {
  const f = 10 ** decimals;
  return { lat: Math.round(p.lat * f) / f, lng: Math.round(p.lng * f) / f };
}

export function nearestNeighborhood(p: LatLng): string {
  let best = NEIGHBORHOODS[0];
  let bestD = Infinity;
  for (const n of NEIGHBORHOODS) {
    const d = distanceM(p, n.center);
    if (d < bestD) {
      bestD = d;
      best = n;
    }
  }
  return best.id;
}

export function isValidLatLng(p: LatLng): boolean {
  return Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;
}

/** Rough Riyadh metro bounding box — reports outside it are rejected in the MVP. */
export function inRiyadh(p: LatLng): boolean {
  return p.lat > 24.4 && p.lat < 25.1 && p.lng > 46.3 && p.lng < 47.1;
}

export function formatDistance(m: number, lang: "ar" | "en"): string {
  if (m < 1000) return lang === "ar" ? `${Math.round(m)} م` : `${Math.round(m)} m`;
  const km = (m / 1000).toFixed(1);
  return lang === "ar" ? `${km} كم` : `${km} km`;
}
