# Testing

```bash
npm test            # 78 unit/integration tests (Vitest, no credentials needed)
npm run typecheck
npm run lint
npm run build
```

Tests run the real domain code against the in-memory `DemoRepo` with an injected clock, so every rule (expiry, limits, fraud timing) is checked deterministically.

## Requirement coverage

| # | Requirement | Where |
|---|---|---|
| 1 | Reporting a valid departure | `tests/handoff.test.ts` › *1. Reporting a valid departure* (also: outside Riyadh, low accuracy, non-driver, one active report, simulated evidence blocked outside demo) |
| 2 | Rejecting expired reports | `handoff.test.ts` › *2. Rejecting expired reports* |
| 3 | Rejecting self-confirmation | `handoff.test.ts` › *3. Rejecting self-confirmation* (claim and confirm, plus fraud flag; non-claimer rejected) |
| 4 | Rejecting duplicate reward claims | `handoff.test.ts` › *4*; `ledger.test.ts` › idempotency key test |
| 5 | Successful handoff verification | `handoff.test.ts` › *5* (found, GPS tolerance, too far, verified not-found, released not-found) |
| 6 | Correct point calculation | `ledger.test.ts` › *6* (8 + 2, 3-handoff bonus, edited rules, daily cap) |
| 7 | Correct ledger balance | `ledger.test.ts` › *7* |
| 8 | Preventing negative balances | `ledger.test.ts` › *8* (domain plus storage layer, reversal cap, 5 concurrent spends) |
| 9 | Redeeming eligible rewards | `ledger.test.ts` › *9* (deduct, stock, reject → refund, DEMO code, ineligible paths); `marketplace-access.test.ts` (discount at booking) |
| 10 | Preventing unauthorized private listings | `marketplace-access.test.ts` › *10* (driver, unapproved partner, pending review, ownership) |
| 11 | Role-based access | `marketplace-access.test.ts` › *11* (`assertRole` plus domain-level role enforcement) |
| 12 | Arabic RTL display | `tests/i18n-rtl.test.tsx` (jsdom: Arabic by default, `dir="rtl"` on `<html>`, switch to LTR, complete Arabic strings) |
| 13 | Mobile responsiveness | **Manual / browser-verified** (see below). Not covered by an automated test. |
| 14 | Demo mode without credentials | `recommend-demo.test.ts` › *14* (default mode, Supabase fallback, AI fallback, seed marked DEMO) |
| – | Fraud and suspicious location | `handoff.test.ts` › *Fraud and suspicious location activity* (impossible travel → hold → admin release, rapid arrival, pair collusion, repeated far confirmations, report spam) |
| – | AI parsing and ranking | `recommend-demo.test.ts` (the English and Arabic example prompts, Arabic-Indic digits, budget and schedule filtering, community signals only for "now") |
| – | Input validation | `tests/validation.test.ts` (seeded IDs accepted, unknown keys rejected, no client-supplied Keys) |

## Hive Intelligence coverage (`tests/hive.test.ts`)

| # | Requirement | Test |
|---|---|---|
| 1 | Only visible and relevant cells are queried | Spies on `listReportsInCells`: every queried cell lies inside the padded viewport, ≤ `maxCellsPerQuery`, and there is no unfiltered `listReports()` |
| 2 | The entire city is never loaded | 2,500 synthetic reports: a street viewport returns < 150 local signals; the city view returns only capped aggregate cells and no signals; payload < 400 KB; automatic resolution coarsening |
| 3 | H3 parent/child handling | Index consistency r7–r10; `parentOf`/`childrenOf`; r9 children roll up exactly into the r8 parent; coordinates are not replaced |
| 4 | Neighbor cells return relevant info | k=1 ring has 7 cells, all summarized; a forager in a neighboring hive is recruited to the signal (ring ≥ 1) |
| 5 | Expired signals disappear | A live signal is present, decays to 50% at the half-life, and leaves the active results after expiry (it appears in `inactive`) |
| 6–7 | Reliability rises with valid and falls with failed confirmations | Trail score, signal reliability and confidence compared against an empty-hive baseline |
| 8 | No duplicate rewards | Double confirmation, outcome replay and lifecycle: 1 trail count and 2 ledger entries |
| 9 | A high-demand hive discovers alternatives | Strained home hive → ring ≥ 1 opportunities, private and neighbor alternatives, illustrative transit, no "earn points" advice; fairness cap keeps quiet-hive options |
| 10 | Zoom changes detail | z11 aggregate (no markers) → z14 finer resolution → z16.5 street r10 with signals and spaces |
| 11 | Frontend memory stays bounded | 600 viewport moves keep the LRU cache ≤ 24; cache hits make no new request; marker reconciliation keeps the DOM set equal to the latest response; LRU and TTL eviction |
| 12 | Public reports stay informational | `guaranteed:false`, `bookable:false`, coarsened position; a report id can't be booked; a lapsed claim returns the signal to everyone |
| 13 | Private bookings use authorized inventory only | A pending space is hidden from the map and recruitment and can't be booked |
| – | Data lifecycle | Expired → folded into stats → deleted after retention; aggregates survive; ledger and bookings untouched |
| – | State rules | All five states from transparent inputs; demo hive states derived from seeded data |

## Manual QA performed (in-app browser, demo mode)

- Desktop 1280×800, Arabic: onboarding, home map (markers, legend, filters, sidebar list), report flow, report details with confidence breakdown, wallet, admin.
- Full handoff in one browser: Driver A reported → Driver B claimed (precise location revealed) → confirmed at 14 m → B +2, A 38 → 46 Keys, ledger keys verified.
- English LTR: the AI assistant with the reference prompt parsed destination, time, duration, budget and walking distance, and ranked approved spaces with explanations.
- Mobile 375×812, Arabic: map, bottom navigation, collapsible legend, private parking list; `scrollWidth == clientWidth` (no horizontal scroll).
- API smoke tests: driver blocked from listing spaces and from admin (403); partner submission enters `pending_review`; admin approval issues a DEMO code; booking with a 20% Keys discount; a booking outside the schedule is rejected.

Bugs found during this QA and fixed: MapLibre worker loading under webpack; map container height (MapLibre CSS overrides positioning); marker positioning (class overwrite); RTL alignment of numeric values; strict-UUID validation rejecting seeded IDs (a regression test was added); partner re-application picking a rejected record (covered by a test).

## Not yet tested

- **The Supabase adapter and SQL migrations against a live project** (no credentials were provided). See the verification steps in PRODUCTION_READINESS.md.
- **Live Claude calls** (no API key was provided). The no-key fallback is tested; the AI path type-checks against SDK 1.5.0.
- Real-device GPS accuracy and browser-permission UX on iOS/Android.
- Load and concurrency across multiple server instances (the rate limiter and demo store are single-instance).
