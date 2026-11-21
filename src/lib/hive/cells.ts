import { cellToBoundary, cellToLatLng, cellToParent, cellToChildren, getHexagonAreaAvg, getResolution, gridDisk, isValidCell, latLngToCell, polygonToCells, UNITS } from "h3-js";
import type { HiveIndex, LatLng } from "../types";
import { FINEST_RES, type HiveResolution } from "./config";

/**
 * HiveCellService — H3 hierarchy helpers.
 * Every spatial record stores its cell at each hive resolution (r7…r10). Cells are
 * used for indexing, grouping and queries only; exact coordinates are kept as-is.
 */

export function hiveIndexFor(p: LatLng): HiveIndex {
  const r10 = latLngToCell(p.lat, p.lng, 10);
  return { r10, r9: cellToParent(r10, 9), r8: cellToParent(r10, 8), r7: cellToParent(r10, 7) };
}

export function cellAt(index: HiveIndex, res: number): string {
  switch (res) {
    case 7: return index.r7;
    case 8: return index.r8;
    case 9: return index.r9;
    case 10: return index.r10;
    default: return res < 10 ? cellToParent(index.r10, res) : index.r10;
  }
}

export function parentOf(cell: string, res: number): string {
  return getResolution(cell) <= res ? cell : cellToParent(cell, res);
}

export function childrenOf(cell: string, res: number): string[] {
  return cellToChildren(cell, res);
}

export function resolutionOf(cell: string): number {
  return getResolution(cell);
}

export function isCell(cell: string): boolean {
  return typeof cell === "string" && isValidCell(cell);
}

/** The cell itself plus k rings of neighbors. */
export function neighborhood(cell: string, k = 1): string[] {
  return gridDisk(cell, k);
}

export function cellCenter(cell: string): LatLng {
  const [lat, lng] = cellToLatLng(cell);
  return { lat, lng };
}

/** GeoJSON-ordered [lng, lat] closed ring for rendering. */
export function cellRing(cell: string): [number, number][] {
  const ring = cellToBoundary(cell, true) as [number, number][];
  return [...ring, ring[0]];
}

export interface BBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

export function bboxAreaKm2(b: BBox): number {
  const midLat = ((b.north + b.south) / 2) * (Math.PI / 180);
  const h = (b.north - b.south) * 111.32;
  const w = (b.east - b.west) * 111.32 * Math.cos(midLat);
  return Math.max(0, h) * Math.max(0, w);
}

/**
 * Cells covering a viewport at `res`. If the viewport would need more than `maxCells`
 * cells, the resolution is coarsened step by step so a query can never explode.
 */
export function cellsForViewport(b: BBox, res: number, maxCells: number): { resolution: number; cells: string[]; coarsened: boolean } {
  let r = res;
  // Fast estimate first (avoids generating a huge array just to discard it).
  while (r > 5 && bboxAreaKm2(b) / getHexagonAreaAvg(r, UNITS.km2) > maxCells * 0.9) r--;
  // polygonToCells uses centroids; pad by one ring so edge cells are included.
  const poly = [[b.south, b.west], [b.south, b.east], [b.north, b.east], [b.north, b.west], [b.south, b.west]];
  let cells = polygonToCells(poly, r);
  if (cells.length === 0) cells = [latLngToCell((b.south + b.north) / 2, (b.west + b.east) / 2, r)];
  const padded = new Set<string>();
  for (const c of cells) for (const n of gridDisk(c, 1)) padded.add(n);
  let out = [...padded];
  if (out.length > maxCells) out = out.slice(0, maxCells);
  return { resolution: r, cells: out, coarsened: r !== res };
}

export function clampBBox(b: BBox): BBox {
  return {
    west: Math.max(-180, Math.min(180, b.west)),
    east: Math.max(-180, Math.min(180, b.east)),
    south: Math.max(-85, Math.min(85, b.south)),
    north: Math.max(-85, Math.min(85, b.north)),
  };
}

export function inBBox(p: LatLng, b: BBox): boolean {
  return p.lat >= b.south && p.lat <= b.north && p.lng >= b.west && p.lng <= b.east;
}

export { FINEST_RES };
export type { HiveResolution };
