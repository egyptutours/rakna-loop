import { BoundedCache } from "./cache";

/**
 * Cell-summary caches (key: `${res}:${cell}`), one per repository instance so separate
 * data stores never share entries. Bounded (LRU) and short-lived (TTL).
 */
const g = globalThis as unknown as { __raknaHiveCaches?: WeakMap<object, BoundedCache<unknown>>; __raknaHiveCacheSet?: Set<BoundedCache<unknown>> };
const caches = (g.__raknaHiveCaches ??= new WeakMap());
const all = (g.__raknaHiveCacheSet ??= new Set());

export function hiveCacheFor(repo: object): BoundedCache<unknown> {
  let c = caches.get(repo);
  if (!c) {
    c = new BoundedCache<unknown>(5000, 15_000);
    caches.set(repo, c);
    all.add(c);
  }
  return c;
}

export function invalidateHiveCells(cells: string[]): void {
  const frags = cells.filter(Boolean);
  for (const c of all) c.invalidateMatching(frags);
}

export function clearHiveCache(): void {
  for (const c of all) c.clear();
}
