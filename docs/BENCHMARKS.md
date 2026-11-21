# RAKNA HIVE — measured performance (Phase 2)

Reproduce with `npm run bench`. Raw results: `bench/results/hive-bench.json`.
**Machine:** one Windows x64 developer laptop, Node 26.13.1. Single run per size, so treat the numbers as **relative**, not as capacity claims.

## What was measured, and how

| Layer | Method |
|---|---|
| Application query path | `queryHiveMap()` on the **in-memory demo adapter** with 2.5k–250k synthetic reports spread over Riyadh (10% live, 90% recent history; 5,000 synthetic drivers). 8 warm runs per view, p50/p95. Storage calls counted per query. |
| Database | The real migrations on **PostgreSQL 18.6 + PostGIS 3.6 (PGlite, single connection, WASM)** with the same synthetic data. `EXPLAIN (ANALYZE)` execution time, p50 of 6 runs, plus plan inspection. |
| Client | `HiveViewportLoader` driven through 1,000 viewport movements with simulated network latency; debounce disabled to stress cancellation. Node heap, not a browser. |

Views: **city** (whole Riyadh bbox, zoom 10.5), **neighborhood** (~5 × 4 km, zoom 13.5), **street** (~1 km × 0.9 km, zoom 16.5).

## Application query path (in-memory adapter)

| Reports | View | Mode / res (data/overlay) | p50 ms | p95 ms | Cells returned / queried | Markers | Payload | Storage calls / query |
|---:|---|---|---:|---:|---:|---:|---:|---:|
| 2,510 | city | aggregate r6/r6 | 6.6 | 22.2 | 65 / 90 | 0 | 39.5 KB | 3 |
| 2,510 | neighborhood | aggregate r9/r9 | 10.9 | 12.7 | 7 / 281 | 0 | 4.8 KB | 3 |
| 2,510 | street | street r10/r9 | 8.2 | 10.3 | 5 / 93 | 3 | 5.4 KB | 14 |
| 10,010 | city | aggregate | 2.9 | 5.4 | 68 / 90 | 0 | 41.5 KB | 3 |
| 10,010 | neighborhood | aggregate | 9.1 | 12.5 | 18 / 281 | 0 | 11.3 KB | 3 |
| 10,010 | street | street | 7.3 | 10.4 | 5 / 93 | 3 | 5.4 KB | 14 |
| 50,010 | city | aggregate | 2.9 | 5.1 | 72 / 90 | 0 | 44.0 KB | 3 |
| 50,010 | neighborhood | aggregate | 7.6 | 9.1 | 65 / 281 | 0 | 39.2 KB | 3 |
| 50,010 | street | street | 30.6 | 32.0 | 7 / 93 | 4 | 7.6 KB | 14 |
| 100,010 | city | aggregate | 2.6 | 2.8 | 73 / 90 | 0 | 44.8 KB | 3 |
| 100,010 | neighborhood | aggregate | 6.5 | 7.9 | 66 / 281 | 0 | 40.1 KB | 3 |
| 100,010 | street | street | 62.2 | 77.7 | 7 / 93 | 5 | 8.7 KB | 14 |
| 250,010 | city | aggregate | 2.6 | 5.0 | 73 / 90 | 0 | 44.8 KB | 3 |
| 250,010 | neighborhood | aggregate | 7.5 | 12.3 | 66 / 281 | 0 | 40.2 KB | 3 |
| 250,010 | street | street | 146.1 | 149.5 | 7 / 93 | 8 | 11.8 KB | 14 |

**Cell-summary cache** (fresh neighborhood viewport, cold → warm): 15.0 → 12.2 ms (2.5k), 30.6 → 12.7 ms (100k), 69.1 → 6.8 ms (250k). Warm repeats of the views above are served mostly from the cache. The city view stays at about 3 ms because aggregate summaries are cached.

**Reading this honestly**
- **Payload and markers are bounded by the viewport, not by the dataset.** At 250k reports the city view still returns ≤ 90 hexagons (about 45 KB) and **no markers**; the street view returns 8 markers and 12 KB. The frontend never receives the city dataset.
- **Storage calls per map movement are constant (14 street, 3 aggregate).** Before this audit the street view grew to 36 calls at 100k (an N+1 per signal; finding F-PERF-4).
- **Street latency grows linearly here (8 → 146 ms) because the demo adapter scans in-memory arrays.** The production adapter issues the same filters as indexed SQL (next table), so this growth reflects the demo store, not the design. The demo store is not meant for large datasets.
- The 14 street calls include per-visible-space lookups (partner status, bookings): an N+1 bounded by the private spaces in view. On Supabase each call is an HTTP round trip (roughly 14 × 20–40 ms in-region, partly parallel). **Recommended next step:** a single `hive_viewport()` SQL RPC (see §5).

## Database (PostgreSQL 18 + PostGIS, PGlite)

| Rows | Street live signals (`h3_r10 = ANY(…) AND status IN live`) | Neighborhood counts (`h3_r9 = ANY(200 cells) GROUP BY`) | 300 m radius (`ST_DWithin` on `geog`) | `status = 'available'` (comparison) |
|---:|---:|---:|---:|---:|
| 2,750 | 0.1 ms · index | 1.0 ms · index | 0.2 ms · GiST | 0.7 ms |
| 11,000 | 0.1 ms · index | 1.8 ms · index | 0.2 ms · GiST | 3.8 ms |
| 52,000 | 0.1 ms · index | 7.0 ms · index | 0.6 ms · GiST | 7.0 ms |
| 102,000 | 0.1 ms · index | 5.5 ms · index | 0.3 ms · GiST | 1.7 ms |
| 252,000 | 0.1 ms · index | 13.2 ms · index | 1.7 ms · GiST | 5.6 ms |

Every viewport query plan uses the H3 B-tree, partial-live or GiST indexes, with **no sequential scans** at any size. Street-level lookups stay flat (0.1 ms) from 2.7k to 252k rows, because the partial "live" index keeps the hot set small.

## Client

| Metric | Result |
|---|---|
| Viewport movements | 1,000 |
| Requests started | 915 (85 served from the LRU cache) |
| Superseded requests aborted | 914 (only the latest viewport is applied) |
| Cache entries after 1,000 moves | 24 (bound 24) |
| Node heap delta after GC | ~3 KB |
| Debounce (production setting) | 300 ms: a continuous pan issues about 1 request per pause, not per frame |

Also verified structurally in unit tests: marker reconciliation keeps the DOM marker set equal to the latest response, and the TTL plus LRU eviction work.

## What remains untested

- **Real Supabase:** PostgREST/HTTP overhead, connection pooling (Supavisor), concurrent connections, and lock contention under load. PGlite is one connection.
- **Throughput:** no multi-user load test (requests per second, p99 under concurrency).
- **Browsers:** no heap profiling on low-end Android/iOS devices, and no long-session (hours) memory trace with real MapLibre rendering.
- **Tiles:** OpenStreetMap's public tile servers are not for production load; tile CDN capacity is untested.
- **Data distribution:** synthetic data is uniform over Riyadh; real data clusters (malls, events) and will create hot cells.

**These results do not establish million-user readiness.** They show that the per-request work and the payload are bounded by the viewport and that the database access paths are indexed. Capacity must be measured on staging with real infrastructure (STAGING.md §9, AUDIT_REPORT B1–B4, B9).

## 5. Recommended next performance steps

1. `hive_viewport(cells, res, statuses, limit)` SQL RPC returning signals, spaces with free capacity, and summaries in **one** round trip.
2. Precompute scout reliability (counters on resolution) instead of reading a reporter's recent reports.
3. Materialize per-r9 live summaries every minute for very busy hives.
4. Load test on staging (k6 or Artillery) with realistic clustered data and record p95/p99.
