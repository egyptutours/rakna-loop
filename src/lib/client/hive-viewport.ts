import { BoundedCache } from "../hive/cache";

export interface ViewportInput {
  west: number;
  south: number;
  east: number;
  north: number;
  zoom: number;
}

/** Round the viewport so tiny pans reuse the same request/cache entry. */
export function viewportKey(v: ViewportInput): string {
  const z = Math.round(v.zoom * 2) / 2;
  const step = z >= 15 ? 0.002 : z >= 13 ? 0.005 : 0.02;
  const r = (x: number) => (Math.round(x / step) * step).toFixed(4);
  return `${z}|${r(v.west)}|${r(v.south)}|${r(v.east)}|${r(v.north)}`;
}

export function viewportQuery(v: ViewportInput, viewer?: { lat: number; lng: number } | null): string {
  // Slightly pad so markers just off-screen are ready when panning.
  const padX = (v.east - v.west) * 0.1;
  const padY = (v.north - v.south) * 0.1;
  const p = new URLSearchParams({
    w: (v.west - padX).toFixed(5), s: (v.south - padY).toFixed(5), e: (v.east + padX).toFixed(5), n: (v.north + padY).toFixed(5), z: v.zoom.toFixed(2),
  });
  if (viewer) {
    p.set("lat", viewer.lat.toFixed(5));
    p.set("lng", viewer.lng.toFixed(5));
  }
  return p.toString();
}

/**
 * Debounced, cancellable, cached viewport loader. Only the latest viewport is ever
 * applied; superseded requests are aborted; the cache is LRU-bounded so repeated map
 * movement cannot grow memory without limit.
 */
export class HiveViewportLoader<T> {
  readonly cache: BoundedCache<T>;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inflight: AbortController | null = null;
  private seq = 0;
  requests = 0;

  constructor(
    private readonly fetcher: (query: string, signal: AbortSignal) => Promise<T>,
    private readonly onData: (data: T, key: string) => void,
    opts: { debounceMs?: number; maxEntries?: number; ttlMs?: number } = {},
  ) {
    this.debounceMs = opts.debounceMs ?? 300;
    this.cache = new BoundedCache<T>(opts.maxEntries ?? 24, opts.ttlMs ?? 15_000);
  }

  private debounceMs: number;

  request(v: ViewportInput, viewer?: { lat: number; lng: number } | null, force = false) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.load(v, viewer, force), this.debounceMs);
  }

  async load(v: ViewportInput, viewer?: { lat: number; lng: number } | null, force = false) {
    const key = viewportKey(v);
    const cached = force ? undefined : this.cache.get(key);
    if (cached) {
      this.onData(cached, key);
      return;
    }
    this.inflight?.abort();
    const ctl = new AbortController();
    this.inflight = ctl;
    const mySeq = ++this.seq;
    this.requests++;
    try {
      const data = await this.fetcher(viewportQuery(v, viewer), ctl.signal);
      if (mySeq !== this.seq) return; // a newer viewport superseded this one
      this.cache.set(key, data);
      this.onData(data, key);
    } catch (e) {
      if ((e as Error)?.name !== "AbortError") throw e;
    }
  }

  dispose() {
    if (this.timer) clearTimeout(this.timer);
    this.inflight?.abort();
    this.cache.clear();
  }
}
