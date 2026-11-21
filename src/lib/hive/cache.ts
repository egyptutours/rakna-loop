/**
 * Small bounded TTL + LRU cache. Used server-side for cell summaries and client-side
 * for viewport responses, so memory stays bounded however much the map is moved.
 */
export class BoundedCache<V> {
  private map = new Map<string, { value: V; expires: number }>();

  constructor(
    private readonly maxEntries: number,
    private ttlMs: number,
  ) {}

  get(key: string, now = Date.now()): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.expires <= now) {
      this.map.delete(key);
      return undefined;
    }
    // refresh LRU position
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.value;
  }

  set(key: string, value: V, now = Date.now()): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, expires: now + this.ttlMs });
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value as string;
      this.map.delete(oldest);
    }
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  /** Delete every key containing one of the given fragments (e.g. affected cell ids). */
  invalidateMatching(fragments: string[]): number {
    let n = 0;
    for (const key of [...this.map.keys()]) {
      if (fragments.some((f) => key.includes(f))) {
        this.map.delete(key);
        n++;
      }
    }
    return n;
  }

  setTtl(ms: number) {
    this.ttlMs = ms;
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}

/** Marker reconciliation: which ids to add and which obsolete ids to remove. */
export function reconcileIds(current: Iterable<string>, next: Iterable<string>): { add: string[]; remove: string[]; keep: string[] } {
  const cur = new Set(current);
  const nxt = new Set(next);
  const add: string[] = [];
  const keep: string[] = [];
  for (const id of nxt) (cur.has(id) ? keep : add).push(id);
  const remove = [...cur].filter((id) => !nxt.has(id));
  return { add, remove, keep };
}
