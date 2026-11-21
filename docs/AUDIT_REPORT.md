# RAKNA LOOP — Phase 2 Independent Engineering Audit

**Scope:** the complete repository after the Hive Intelligence phase: `src/lib/hive`, both data adapters, migrations 0001–0004, every API route, MapView, the client viewport loader, the handoff engine, the RAKNA KEYS ledger, the admin Hive dashboard and the lifecycle jobs.
**Method:** code review against the documentation; executable verification of every migration on real **PostgreSQL 18.6 + PostGIS 3.6** (PGlite) with a Supabase role and grant shim; RLS tests run as the `authenticated` and `anon` roles; race tests that simulate several server instances; mutation testing of the race guards; benchmarks from 2.5k to 250k reports.
**Not available:** a live Supabase project, Vercel, PostgREST/GoTrue, pg_cron, real devices. Anything depending on those is marked **unverified**.

---

## 1. Severity-ranked findings

| ID | Severity | Area | Finding | Status |
|---|---|---|---|---|
| F-CONC-4 | **Critical** | Concurrency | `SupabaseRepo.withLock` called `pg_try_advisory_xact_lock` in its own RPC transaction, so the lock was released immediately and **serialized nothing**. In the cloud, claims, confirmations, bookings and reward stock were check-then-act races across instances. | **Fixed:** compare-and-set transitions (`transitionReport`), atomic SQL functions, partial-unique-index backstops. Verified (§4). |
| F-SEC-2 | **Critical** | Deployment | Production silently **fell back to demo mode** when `RAKNA_DATA_MODE` was unset or Supabase variables were missing. Demo mode exposes the account switcher, so anyone could act as the demo **administrator**. | **Fixed:** explicit mode required in production; misconfiguration returns 503. Tested. |
| F-PRIV-1 | High | Privacy / DB | Account deletion was **impossible**: deleting an auth user cascaded into the append-only ledger and raised. Deletion requests were also never processed. | **Fixed:** `ON DELETE RESTRICT` on durable records, `anonymize_profile()`, an admin "Anonymize account" queue, and deleted accounts are locked out. Tested in SQL and in the app. |
| F-SEC-1 | High | Database | `keys_balance(uuid)` let **any** signed-in user read **any** user's Keys balance. | **Fixed** in 0005 (own balance or admin only). Tested as `authenticated`. |
| F-PRIV-2 | High | Privacy | Non-participants received the signal's **r10 cell id** (~65 m), more precise than the ~110 m coarsened position. Street zoom drew r10 hexes with live counts, which pinpoint single signals. `/api/hive/cells/{r10}` was public. | **Fixed:** r9 for non-participants, an r9 overlay at street zoom, r10 detail admin-only. Tested. |
| F-DB-2 | High | Lifecycle (SQL) | `rakna_hive_lifecycle` stamped expired signals with `resolved_at = now()`, which delayed aggregation by an hour and skewed metrics. The TypeScript engine had the same bug and was fixed last phase; the SQL copy was missed. | **Fixed** in 0005. Found by the SQL lifecycle test. |
| F-INT-1 | High | Integration | Supabase mode had **no sign-in UI**, so a staging deployment would have been unusable. | **Fixed:** `/signin` (email one-time code) plus bearer-token sync. **Unverified live.** |
| F-PERF-4 | High | Performance | **N+1 queries**: each visible signal issued about 4 storage queries. At 100k reports the street view took 148 ms and 36 storage calls in-process; on Supabase that is 36 HTTP round trips per map movement. | **Fixed:** batched `buildHiveSignals` with a constant query count. Re-benchmarked (§5). |
| F-DB-1 | Medium | Database | `hive_add_feedback()` failed at runtime (`jsonb_set(jsonb, text, jsonb)` does not exist). | **Fixed** in 0005. Tested. |
| F-CONC-1 | Medium | Rewards | The daily earning cap was checked in the app before an unlocked insert, so concurrent awards on different instances could exceed it. | **Fixed:** cap enforced inside `insert_ledger_entry`'s per-user lock (and in the demo store). Tested under concurrency. |
| F-CONC-2/3 | Medium | Rewards / bookings | Reward stock was read-modify-write (oversell); booking capacity was check-then-insert (overbooking). | **Fixed:** `reward_stock_adjust`, `insert_booking_checked` (advisory lock per space), and refund of discount Keys when a slot is lost. Tested. |
| F-SEC-3 | Medium | Abuse | Anyone, anonymously, could write demand (making hives "overloaded") and trigger paid AI calls. | **Fixed:** demand needs a signed-in user (storage stays anonymous); the AI path needs a user when a key is configured. |
| F-PERF-1 | Medium | Performance | The app-level lifecycle ran on user read paths in Supabase mode and scanned 60 days of reports. | **Fixed:** in production the job runs only in the database via pg_cron; the read-path trigger is demo-only. |
| F-PERF-2 | Medium | Performance | The admin overview loaded the **entire ledger** to compute totals. | **Fixed:** `ledger_totals()` aggregate plus a 60-row recent list. Tested for exact totals. |
| F-PERF-3 | Medium | Performance | Up to 400 H3 ids in one PostgREST `in.(…)` URL (~7 KB) risk gateway URL limits. | **Fixed:** chunks of 100 ids. **Unverified live.** |
| F-BIZ-1 | Medium | Business rule | The handoff-bonus counter used temporary reports, which the lifecycle deletes after 30 days, so the counter reset and later bonuses could be silently skipped (keys already used). | **Fixed:** counted from the durable ledger. |
| F-OPS-1 | Medium | Operations | Scheduling existed **only as a comment**; runs could overlap, failures were invisible, and there was no health signal. | **Fixed:** migration 0006 schedules pg_cron; `hive_job_runs` log; non-overlap lock; failures recorded and rolled back; `hive_job_health` view and an admin health panel. pg_cron itself is **unverified** (not in PGlite). |
| F-SEC-5 | Medium | Web security | No Content-Security-Policy or HSTS. | **Fixed:** CSP (self + tile host + Supabase), HSTS in production, existing headers kept. Browser-verified in dev. |
| F-ERR-1 | Low | Errors | Postgres unique violations from races surfaced as HTTP 500. | **Fixed:** mapped to 409 conflict; raw DB messages are logged server-side only. |
| F-DEMO-1 | Low | Demo separation | Illustrative transit points could appear in production recommendations. | **Fixed:** demo mode only. Tested. |
| F-DOC-1 | Low | Docs | ARCHITECTURE claimed advisory-lock serialization; HIVE claimed pg_cron was configured. Both were untrue. | **Fixed:** docs corrected. |
| F-PERF-5 | Low | Performance | The street view still does per-visible-space lookups (partner status, bookings), an N+1 bounded by the private spaces in view. | Open: recommend one `hive_viewport()` SQL RPC (BENCHMARKS §5). |
| F-ABUSE-2 | Low | Abuse | A signed-in user can submit "helpful" feedback repeatedly (rate-limited, aggregate only). | Open (low impact). |

## 2. Security and privacy audit

| Topic | Result |
|---|---|
| Precise location | Exact coordinates are returned only to the reporter, the active claimer and admins (API DTOs and RLS). Others get ~110 m coordinates and r9 cells. The public SQL view exposes rounded coordinates and no identities. Retention purge coarsens closed records after 24 h (scheduled). |
| API authorization | Every mutating route validates with strict zod, authenticates server-side, and checks role and ownership in both route and domain (defence in depth). The client never sends Keys amounts. |
| Session handling | Demo: httpOnly SameSite=Lax cookie, honored only for seeded demo profiles and only in demo mode. Supabase: bearer access token verified with Supabase Auth on each request; the role is read from the database. **Gap:** one Auth API call per request (latency); consider local JWT verification via JWKS. |
| Admin access | Admin routes require role `admin`; every admin action is audited (append-only). |
| Background tracking | **None.** No `watchPosition` anywhere; `getCurrentPosition` only in user-initiated handlers. Enforced by a static test. |
| Account deletion | Request (user) → anonymize (admin) → location records deleted, ledger, bookings and audit kept, account locked. Auth identity soft-deletion via the Supabase Admin API is a **manual step** (blocker B6). |
| Demo isolation | Demo mode is explicit in production; demo controls return 403 in Supabase mode; demo records carry `is_demo`; transit points are demo-only. |
| Error messages | Domain errors are user-safe; unknown and DB errors return generic text (details stay in server logs). |
| Secrets | Read only in server-only modules (static test); none in `.next/static` (scanned); `.env*` git-ignored; staging template provided. |

## 3. Database migration validation (`npm run test:db`, 25 tests)

| Check | Result |
|---|---|
| 1. SQL syntax | 0001–0006 apply cleanly on PostgreSQL 18.6 + PostGIS 3.6 |
| 2. Foreign keys | Enforced (23503); durable records now RESTRICT deletion (23001) |
| 3. H3 columns | `h3_r7…h3_r10` on reports and spaces; exact coordinates preserved |
| 4. H3 indexes | B-tree per resolution, partial index on live statuses, aggregate-table indexes; `EXPLAIN` at 50k rows uses indexes, with no sequential scan |
| 5. PostGIS indexes | GiST on generated `geog`; `ST_DWithin` uses it |
| 6. RLS | An `authenticated` user cannot: insert, update or delete ledger rows; call `insert_ledger_entry`; read another user's balance; approve or insert listings; escalate their role; read others' precise reports; run lifecycle, purge, anonymize, stock or booking functions; modify others' bookings or reports. `anon` cannot read the reports table at all. |
| 7–10. Permissions | `service_role` (BYPASSRLS) runs the atomic functions; all privileged functions have EXECUTE revoked from `public`, `anon` and `authenticated` |
| Lifecycle | Aggregates before deleting; idempotent; failed run recorded and rolled back; retry succeeds without double counting; durable records untouched |

**Shim caveats:** PGlite is a single connection, so true parallel-transaction behavior (advisory-lock contention) is reasoned about, not executed. PostgREST, GoTrue and pg_cron are not present.

## 4. Concurrency results (`tests/concurrency.test.ts`, 9 tests)

The tests run with no in-process locks plus random storage latency (simulating several server instances); each race is repeated 25–40×.

| Scenario | Result |
|---|---|
| A. Two drivers claim the same report | Exactly 1 claim succeeds every run; the others get `already_claimed_other`; 1 active claim row |
| B. Simultaneous confirmations | Processed exactly once; 1 accepted confirmation; 1 departure reward; balance +8 |
| C. Repeated reward request | 20 concurrent awards with one key give 1 ledger row; daily cap 40 holds under 12 concurrent awards of 8 |
| D. Over-balance redemption | Rejected server-side; 6 concurrent redemptions with balance 38 give exactly 1 success; stock is never oversold (reserved units released); 10 concurrent spends never go negative; 6 concurrent bookings on capacity 2 give exactly 2 |
| E. Expiry while claiming | Every run resolves to *claimed (expiry extended)* or *expired*, never both; a claim after expiry always fails |
| Mutation check | With the compare-and-set check disabled, Scenario B fails, which confirms the tests detect the race |

The SQL primitives behind these (CAS UPDATE, unique partial indexes, locked ledger and booking functions) are verified separately in `tests/db`.

## 5. Performance

See [BENCHMARKS.md](BENCHMARKS.md) for the full tables, method and limitations. Summary:
- **Payload and markers are bounded by the viewport.** At 250k reports the city view returns ≤ 90 hexagons (about 45 KB) and 0 markers; the street view returns 8 markers and 12 KB.
- **Storage calls per map movement are constant** (3 aggregate, 14 street) after fixing the N+1 (it was 36 and growing).
- **PostgreSQL:** every viewport query uses an index (H3 B-tree, partial live index, PostGIS GiST); the street query takes 0.1 ms at 252k rows (PGlite, one connection).
- **Client:** 1,000 movements → 914 superseded requests aborted, cache held at its 24-entry bound, about 3 KB heap delta (Node).
- **Not measured:** real Supabase over HTTP, concurrency and throughput, browser memory on phones. **No million-user claim.**

## 6. Cloud staging readiness

Prepared, **not executed** (no credentials): see [STAGING.md](STAGING.md) for env vars, migrate and seed steps, the H3 back-fill script, deployment, pg_cron monitoring, rollback scripts, backups and a 10-point verification checklist.

## 7. Remaining production blockers

| # | Blocker |
|---|---|
| B1 | **Live staging never executed.** The Supabase adapter (PostgREST queries, RPC parameter binding), GoTrue OTP sign-in, pg_cron and Vercel are unverified. |
| B2 | **Rate limiting is per instance** (in-memory). It needs a shared store (Postgres or Redis/Upstash) before multi-instance production. |
| B3 | **No load test against a real Postgres with concurrent connections.** The benchmarks here are single-machine and single-connection. |
| B4 | **No browser memory profile on low-end phones.** Client memory bounds are verified structurally (LRU, reconciliation) and with Node heap only. |
| B5 | Auth verification costs one Supabase Auth call per request; local JWT verification (JWKS) is recommended. |
| B6 | Account deletion: the auth identity must be soft-deleted with the Admin API (`auth.admin.deleteUser(id, true)`); this is not automated. |
| B7 | Unbounded admin and partner lists (profiles, partners, spaces, bookings) need pagination as volume grows. |
| B8 | Payments, partner KYC (commercial registration), real reward fulfilment, PDPL data residency, and the Saudi legal review of the loyalty program (see PRODUCTION_READINESS). |
| B9 | No million-user claim can be made: nothing here measured multi-node throughput, connection pooling (Supavisor), or tile-server capacity. |
