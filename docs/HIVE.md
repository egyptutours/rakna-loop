# RAKNA HIVE INTELLIGENCE

> "Many independent users. Local intelligence. Shared knowledge. Collective efficiency."

This document covers the biomimicry layer that was added on top of the existing RAKNA LOOP MVP: what each biological principle became in software, how the H3 hive map works, the data lifecycle, scalability safeguards, the tuning knobs, and the known risks. Nothing from the original product was removed: the handoff, ledger, rewards, marketplace, partner and admin features all keep working (all 58 original tests still pass, alongside 20 new hive tests).

## 1. From biology to algorithms

| Principle | Biology | RAKNA implementation | Code |
|---|---|---|---|
| Decentralized coordination | No central controller in a colony | Every decision uses only the forager's own H3 hive and its neighbors. There is no global optimizer. | `hive/swarm.ts` |
| Pheromone signal | An ant marks a food source | A departure report becomes a **signal** in its r10 cell | `domain/handoff.ts` (`createReport` sets `hive`) |
| Trail reinforcement | More ants → a stronger trail | A verified **found** increments the cell's trail (`hive_cell_stats.found`) immediately | `hive/verification.ts` `recordSignalOutcome` |
| Negative feedback | Unrewarding trails fade | A verified **not found** increments `not_found`, lowering the trail's Beta-posterior score | same |
| Evaporation | Pheromones evaporate | Signal strength halves every `signalHalfLifeMinutes` and is 0 at expiry; cell trails decay with `trailHalfLifeDays` | `hive/decay.ts` |
| Waggle dance | A bee shares direction, distance and quality | The **HIVE RESOURCE SIGNAL**: cell, location (privacy-scoped), timestamps, status, freshness, confidence, verification history, claim status, expiry, plus a plain-language explanation | `hive/signals.ts` |
| Local recruitment | Foragers recruit nestmates to the nearest rich patch | Search the forager's r9 hive, then expand ring by ring (k ≤ `recruitmentMaxRings`) and stop once enough options exist | `recruit()` |
| Division of labor | Scouts, foragers, guards | Dynamic **activity roles**: Scout (has a live report), Forager (searching), Verifier (holds a claim), Hive Steward (partner or admin). These are not account types. | `activityRoleFor()` |
| Adaptive response | A colony shifts effort to where it's needed | HIGH DEMAND / OVERLOADED hives surface neighboring hives with spare supply, approved private parking, and illustrative transit alternatives | `recruit()` |

**Fairness.** Cell popularity is never a scoring input. Quiet cells start from a neutral Beta(1,1) prior (score 0.5), so they are never penalized. Recommendation lists apply a per-hive diversity cap (`perCellDiversityCap`), so a busy hive cannot crowd out valid opportunities in quieter ones. **No fabrication:** every opportunity is a stored report or an approved space. Transit points are labelled illustrative demo data.

**Safety and ethics.** No task asks anyone to drive somewhere to earn points. Advice always includes a "don't use while driving" line. Strained hives get "rather than circling, consider…" alternatives. Challenges reward verified outcomes, never engagement.

## 2. RAKNA HIVE MAP (H3)

- Package: [`h3-js`](https://github.com/uber/h3-js) 4.5.0, Uber's official JavaScript binding. There is no npm package named `@uber/h3-js`.
- Each report and private space stores `hive = { r7, r8, r9, r10 }`, denormalized as `h3_r7…h3_r10` columns with B-tree indexes. **Exact coordinates are never replaced** by cell centers: `location` stays as captured (and is coarsened for privacy only in API responses and after the retention window).
- Demand counters are stored at r9 and roll up to r8/r7. Outcome trails are stored at r10 and roll up to any coarser resolution with `cellToParent`.

| Zoom | Resolution | Mode | What is drawn |
|---|---|---|---|
| ≤ 11 | r7 (≈ 5.2 km²) | aggregate | district hexes only |
| ≤ 13 | r8 (≈ 0.74 km²) | aggregate | area hexes |
| ≤ 14.5 | r9 (≈ 0.105 km²) | aggregate | neighborhood hives |
| > 14.5 | r10 (≈ 0.015 km²) data / r9 overlay | street | signals, private spaces, clusters; the honeycomb is drawn at **r9** (an r10 hex with one live signal would pinpoint it; audit F-PRIV-2) |

All of these are configurable (`zoomBands`). If a viewport would need more than `maxCellsPerQuery` cells, the resolution is coarsened automatically. Viewports larger than about 0.6° per side are rejected.

### Hive states (transparent rules)

```
effSupply = Σ signal strength (fresh × decayed) + 0.2 × min(freePrivateBays, 20)
demand    = recent anonymous searches (r9, demandWindowMinutes) + active claims
ratio     = demand / max(effSupply, 0.25)

QUIET          activity ≤ quietMaxActivity and effSupply < 1
OVERLOADED     ratio ≥ overloadedRatio and effSupply < 1
HIGH DEMAND    ratio ≥ highDemandRatio
RESOURCE RICH  effSupply ≥ 1 and ratio ≤ resourceRichRatio
ACTIVE         otherwise
```

States are computed only from stored data. Demo-mode demand is seeded and labelled `isDemo`. Admins can add a demo demand burst (Admin → Hive), and in production demand comes only from real "I'm looking for parking here" taps.

## 3. APIs

| Endpoint | Purpose |
|---|---|
| `GET /api/hive/map?w&s&e&n&z[&cursor&lat&lng]` | Visible cells (aggregate) or signals, clusters and spaces (street) for ONE viewport, plus a summary of the hive under the viewport center |
| `GET /api/hive/cells/:cell?k=1&children=1` | One cell: summary, parent, k-ring neighbors, optional children |
| `GET /api/hive/local?lat&lng` | Local hive and neighbors, plus the caller's activity role (read-only) |
| `POST /api/hive/demand` | Forager intent: +1 anonymous search for the r9 hive, then local recruitment |
| `GET /api/hive/signals?w&s&e&n&cursor` | Active signals for a viewport, paginated |
| `POST /api/hive/feedback` | "Was this helpful?" (aggregate counters only) |
| `GET /api/hive/metrics` | Admin: measured outcome metrics and data volume |
| `POST /api/admin {action: hive_lifecycle / hive_config}` | Run the lifecycle; edit configuration (audited) |
| Signal create / claim / confirm / withdraw | Unchanged: `POST /api/reports`, `/api/reports/:id/claim`, `/api/reports/:id/confirm`, `DELETE /api/reports/:id` |

`GET /api/map` (the old endpoint that loaded every report in the city) is now a bounded alias of `/api/hive/map`.

**Phase 3 — single-trip viewport.** In Supabase mode one `/api/hive/map` request costs **one** database round trip: `Repo.viewportBundle()` calls `hive_viewport()` (migration 0007), which returns reports, spaces, cell stats and demand for the viewport's cells as one JSON document (demand at resolutions ≥ 9 is matched on the r9 parents the adapter passes in `p_demand_cells`). The function is service-role only, because it returns exact coordinates that the API then coarsens.

**Phase 3 — spaces on the map.** Spaces appear only when **verified** (`spaceAvailability ≠ hidden`). Residential spaces (villa carports, building bays) are placed at the center of their r9 hexagon and drawn with a dashed **~150 m privacy circle**; the address is blank and the exact bay is revealed only to a confirmed, paid driver from 30 minutes before the booking. Villas on the municipal waitlist show a "waitlist" chip instead of a booking button. Spaces tagged with a Metro station show the PARK & CONNECT walking time.

## 4. Data lifecycle

| Class | Data | Lifetime |
|---|---|---|
| Temporary | departure reports, claims, live signals | expire after `reportTtlMinutes`. Once resolved or expired for `aggregateAfterMinutes` they are folded into aggregates, then deleted after `reportRetentionDays`. Inactive claims are deleted after `claimRetentionHours`. Precise coordinates are coarsened after `locationRetentionHours`. |
| Aggregated | `hive_cell_stats` (r10 × hour), `hive_demand_buckets` (r9 × hour) | anonymized counters, kept `statsRetentionDays` |
| Durable | profiles, partners, spaces, bookings, points ledger, redemptions, audit logs | **never touched by the lifecycle** |

**Production (Supabase):** the lifecycle runs **inside the database**. `rakna_hive_lifecycle()` is scheduled every 5 minutes by migration `0006_schedule_jobs.sql` (pg_cron), never overlaps (advisory lock), logs every run in `hive_job_runs`, rolls back and records a failed run so the next run retries safely, and exposes `hive_job_health` for alerting (see `docs/STAGING.md` §6). It does **not** run on user read paths. **Demo mode:** the application-level job (`hive/lifecycle.ts`) runs opportunistically on map reads (at most once a minute) and logs to the demo store. Admin → Hive can trigger either one. Folding is idempotent: `aggregatedAt` marks a report as counted, so replays and retries never double-count.

**Tuning guidance.** Start with a 20-minute report lifetime and an 8-minute signal half-life. If a high share of "found" confirmations arrive after minute 15, lengthen `reportTtlMinutes`. If many "not found" outcomes occur on older signals, shorten `signalHalfLifeMinutes`. Use the admin metrics (success rate, median claim-to-find time) to judge each change, and change one parameter at a time.

## 5. Scalability safeguards

- **Server:** viewport size guard; a cell cap with automatic resolution coarsening; indexed `h3_r{res} = ANY(cells)` queries (plus partial indexes on live statuses); a per-page signal limit with a cursor; clustering of crowded r10 cells below zoom 16; cell summaries cached per repository (bounded LRU, `cacheTtlSeconds`) and invalidated for affected ancestors on report, outcome and demand writes; only cells that carry data are returned. Confidence now uses the local hive trail and the neighbor ring rather than a 30-day city-wide scan, and the AI assistant and admin overview were bounded the same way.
- **Client:** requests are debounced (300 ms) and cancellable (`AbortController`); only the latest viewport is applied; responses are cached in a 24-entry LRU with a 15 s TTL; markers are reconciled so obsolete ones are removed; the honeycomb is one GeoJSON source; refresh polls only the current viewport. `h3-js` is **server-only**, because the server ships cell rings, which keeps the client bundle unchanged.
- **Database:** PostGIS `geography` generated columns with GiST indexes are added for future radius queries. H3 columns are the primary access path.

## 6. Performance risks and mitigations

| Risk | Mitigation / next step |
|---|---|
| Demo adapter scans arrays in memory | Fine for demo scale (2,500 synthetic reports were tested). Production uses indexed SQL. |
| `toHiveSignal` does several lookups per signal (scout history, trail) | The page size is capped. Next step: precompute scout reliability on resolution and cache trails per r9. |
| The lifecycle scans the retention window | It runs in the background and is bounded by retention. In SQL it is set-based (`rakna_hive_lifecycle`). |
| The in-memory cell-summary cache is per instance | Move to Redis/Upstash for multi-instance deployments. (The rate limiter is shared in Postgres since 0007.) |
| H3 back-fill for existing Supabase rows | Run a one-off script with h3-js, or use the `h3-pg` extension (see migration `0004`). |
| Hot cells under heavy load | Partial indexes on live statuses. Optionally materialize per-r9 summaries every minute. |

## 7. Stage report

| Stage | What changed | Files |
|---|---|---|
| A — Hive architecture | Modular services (cells, aggregation, swarm, signals, verification, decay or lifecycle, demand, map query, map styling) | `src/lib/hive/*` |
| B — H3 indexing | `hive` index on reports and spaces; parent/child/neighbor helpers; viewport cover with coarsening | `hive/cells.ts`, `domain/handoff.ts`, `domain/marketplace.ts`, `data/*` |
| C — Dynamic map | Viewport loader; zoom bands; honeycomb GeoJSON layer; clusters; Hive panel; legend; admin Hive tab; signal card on report details | `app/page.tsx`, `components/map-view.tsx`, `components/hive-*.tsx`, `lib/client/hive-viewport.ts` |
| D — Ant engine | Trail reinforcement and evaporation, signal decay, local recruitment, fairness cap, balancing, roles | `hive/verification.ts`, `hive/decay.ts`, `hive/swarm.ts` |
| E — Bee signals | HIVE RESOURCE SIGNAL with explanation; delivery through map, recruitment and report details | `hive/signals.ts` |
| F — Lifecycle and scale | Fold → delete → prune; caches; SQL migration with H3 columns, PostGIS, aggregates, atomic counters and a lifecycle function | `hive/lifecycle.ts`, `supabase/migrations/0004_hive.sql` |
| G — Tests | 20 hive tests covering all 13 required scenarios plus lifecycle, fairness and state rules | `tests/hive.test.ts` |

**Not yet verified:** migration `0004` and the Supabase hive methods against a live project (no credentials were available). Real transit data and real demand distributions are not present; the demo values are labelled.
