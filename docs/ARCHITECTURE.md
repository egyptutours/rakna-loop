# Architecture

## Overview

```
Browser (Next.js App Router, React 19, Tailwind v4, MapLibre)
   │  fetch /api/*  (JSON; demo cookie or Supabase Bearer token)
   ▼
API routes (src/app/api/**)            ← auth, role checks, zod validation, rate limits
   │
   ▼
Domain layer (src/lib/domain/**)       ← ALL business rules, pure TypeScript, unit-tested
   │  Repo interface (src/lib/data/repo.ts)
   ├──────────────► DemoRepo      (in-memory; optional .data/demo-db.json persistence)
   └──────────────► SupabaseRepo  (service-role client → Postgres with RLS + atomic SQL functions)

Optional: src/lib/ai/assistant.ts → Anthropic API (server-only) for request parsing
```

Key decisions:

- **One rules engine, two storage adapters.** Domain functions take a `DomainContext { repo, now, allowSimulatedEvidence }`. Moving from demo data to Supabase swaps the adapter and leaves the rules untouched. `now` is injectable, so tests control time precisely.
- **The server is the only writer of value.** No route accepts a points amount. Keys are created only by `awardPoints()` after verification inside `confirmReport()`, `decideMission()` or `resolveFlaggedReport()`.
- **Defence in depth.** Roles are checked in the route (`requireRole`) and again inside domain functions. Ledger invariants (unique idempotency key, non-negative balance, daily cap) are enforced in the domain, in `DemoRepo.insertLedger`, and in Postgres (`UNIQUE` plus `insert_ledger_entry()` holding a per-user advisory lock inside its own transaction).
- **Atomicity without app-level locks (Phase 2 audit).** `withLock` only serializes inside one process (demo). Across cloud instances, correctness comes from the database: every report state change is a compare-and-set UPDATE (`Repo.transitionReport`: `… WHERE status IN (…) AND claimed_by = … AND expires_at > now()`); stock uses `reward_stock_adjust()`; bookings use `insert_booking_checked()` (per-space advisory lock); partial unique indexes are the final backstop. See `docs/AUDIT_REPORT.md` §4.
- **Lazy state machine.** Report status is derived from timestamps on every read (`deriveStatus`), so expiry needs no cron in the MVP.

## Source map

| Path | Responsibility |
|---|---|
| `src/lib/types.ts` | Domain types (mirror of the SQL schema) |
| `src/lib/config.ts` | Data mode, AI flags, default reward rules, neighborhoods |
| `src/lib/domain/handoff.ts` | Verified parking handoff, confidence score, reliability, admin release of held handoffs |
| `src/lib/domain/ledger.ts` | RAKNA KEYS ledger: award, spend, refund, reversal, wallet summary, daily limits |
| `src/lib/domain/rewards.ts` | Redemptions (simulated), admin decisions, discount eligibility |
| `src/lib/domain/marketplace.ts` | Partner registration, space submission authorization, schedules, capacity, bookings, partner dashboard |
| `src/lib/domain/home-schedule.ts` | **Pure** RAKNA HOME rules: weekly masks, Riyadh-day segmentation, coverage, integer-halalas pricing (daily caps, multi-day discount), fare split + Keys firewall, buffers, overstay, geofence, Saudi entitlement allow-list |
| `src/lib/domain/home.ts` | Listing gates, verification/waitlist visibility, privacy point, schedule bookings, credential generation, access reveal, lifecycle events, PSP payment transitions, host dashboard |
| `src/lib/domain/community.ts` | Challenges, badges, contribution score, leaderboard, Park & Connect missions |
| `src/lib/domain/fraud.ts` | Fraud flag creation (de-duplicated) |
| `src/lib/domain/admin.ts` | Rule edits (bounded and audited), approvals, fraud decisions, overview |
| `src/lib/domain/recommend.ts` | Deterministic AR/EN request parser and ranking engine with explanations |
| `src/lib/ai/assistant.ts` | Optional Claude structured-output parsing with fallback to rules |
| `src/lib/data/*` | Repo port, demo adapter, Supabase adapter, seed, factory |
| `src/lib/auth/session.ts` | Demo cookie / Supabase JWT → profile; `requireRole` |
| `src/lib/auth/jwt.ts` | Optional local JWKS verification (ES256/RS256, WebCrypto) |
| `src/lib/security/*` | zod request schemas, shared rate limiter, PSP webhook signatures, PII stripping |
| `src/lib/api/*` | Route wrapper (error mapping), public DTOs with coordinate coarsening |
| `src/app/**/page.tsx` | The 10 screens plus assistant, community and privacy |
| `supabase/migrations/*` | Schema, RLS, functions |

## Phase 3 — RAKNA HOME, PARTNERS schedules, PARK & CONNECT

```
Driver: Explore & Park ─► /book/:id (quote) ─► POST /api/home/bookings ─► My Bookings & Passes
                                                     │                        │  GET /api/bookings/:id/access (paid, ≥ start−30 min)
                                                     ▼                        │  POST /api/bookings/:id/events (arrived ≤50 m · +1 h · departed · bay blocked)
                       insert_booking_checked(jsonb)  ◄── one transaction: per-space advisory lock, re-check bookable,
                                                          count confirmed bookings overlapping [start−buffer, end+buffer),
                                                          insert booking (integer halalas) + access credential
Host:   List My Parking wizard ─► POST /api/home ─► admin verification ─► Host dashboard (/api/home, /api/spaces/:id/schedule|exceptions)
PSP:    POST /api/webhooks/psp (HMAC) ─► applyPaymentEvent (pending → paid/failed, paid → refunded)
```

**Rules, each enforced twice (domain + SQL):**

| Rule | Domain | Postgres (0007) |
|---|---|---|
| Entitlement per category (tenants = Ejar + landlord consent; common building bays = owners' association) | `checkListingGates` | `parking_spaces_entitlement_chk`, `parking_spaces_ejar_consent_chk` |
| Hidden until verified | `spaceAvailability` → `hidden` | `parking_spaces_verified_approval_chk`, RLS + `parking_spaces_public` view |
| Villas waitlist-only while `villaBookingsEnabled=false` | `isWaitlisted` | `parking_spaces_villa_waitlist` trigger, `set_platform_settings()` |
| ~150 m pre-booking privacy | `toPublicSpace` (r9 center) | `public_lat/lng` trigger (~150 m grid fallback); residential rows hidden from non-hosts by RLS |
| Turnaround buffer | `collidesWithBuffer` pre-check | `rakna_padded_overlaps()` under the advisory lock |
| Fare split + Keys firewall (host payout = base − 15%, Keys ≤ 20% of platform fee) | `computeFare` | `parking_bookings_fare_chk` |
| Credential only for the confirmed, paid guest inside its window | `getBookingAccess` | `credentials_select` RLS |

**Money** is integer halalas end to end (`FareBreakdown`; flat `*_halalas` columns). Time charges round up, percentage splits round half-up, the Keys cap rounds down. Legacy commercial hourly bookings (SAR) are unchanged and also honour the space buffer in SQL.

**Mode switcher.** A RAKNA HOME host is a driver account that also lists a bay; the UI's Driver/Host switch is presentation only — every action is authorized server-side (`canManageSpace`, role checks).

## Verified Parking Handoff

```
 Driver A                         Server                                   Driver B
 ───────                          ──────                                   ───────
 "I'm Leaving" ──(loc, acc)──►  createReport
                                 • driver role, Riyadh bbox, accuracy ≤ 100 m
                                 • 1 active report/driver, daily cap, spam check
                                 • status pending_departure | available, expiresAt = depart + 20 min
                                                    ◄── "Navigate" (optional loc) ──
                                 claimReport
                                 • not own report, not expired, not claimed by another
                                 • releases B's other claims; claim TTL 15 min
                                 • precise coords now visible to B only
                                                    ◄── "Found" / "Not available" (loc) ──
                                 confirmReport
                                 1 self-confirm?  → reject + flag
                                 2 expired?       → reject
                                 3 resolved?      → reject (already_confirmed)
                                 4 claimer?       → else reject
                                 5 proximity ≤ 120 m + min(50, acc/2)   (found requires it)
                                 6 impossible travel / rapid arrival / pair collusion → HOLD (flagged)
                                 → found: +8 to A (report:<id>:reporter), +2 to B (report:<id>:confirmer),
                                          +5 bonus every 3rd success (streak:<A>:<n>)
                                 → not_found (on-site): +2 to B; repeated → low-severity flag on A
                                 → not_found (no evidence): claim released, no rewards
```

The **confidence score** is a weighted sum shown with its factor breakdown:
freshness 0.30, GPS accuracy 0.20, distance from viewer 0.15, reporter reliability 0.25 (Laplace-smoothed success rate), and spot history 0.10. High is ≥ 70, Medium ≥ 45, and Low is anything below that.

## Data model

Fourteen required tables plus `mobility_missions` and `app_config`. All primary keys are UUIDs, with foreign keys, timestamps and indexes throughout.

```
profiles 1─* departure_reports 1─* report_claims
   │            │                  1─* report_confirmations (≤1 accepted, partial UNIQUE)
   │            └─ fraud_flags *─1
   ├─* points_ledger (UNIQUE idempotency_key, append-only trigger)
   ├─* reward_redemptions *─1 rewards_catalog
   ├─* parking_bookings *─1 parking_spaces *─1 parking_partners *─1 profiles(owner)
   ├─* challenge_progress *─1 neighborhood_challenges
   ├─* mobility_missions
   └─* admin_audit_logs (append-only trigger)
app_config (reward_rules JSON)
```

Notable constraints: one active report per driver (partial unique index); one active claim per report and per driver; `claimed_by <> reporter_id`; one accepted confirmation per report; `simulated_payment` is forced true; ledger amounts are non-zero; and the coarse `departure_reports_public` view is the only path for non-participants to read live signals.

## Security model

| Concern | Implementation |
|---|---|
| Authentication | Demo: httpOnly cookie restricted to seeded demo profiles. Supabase: `auth.getUser(token)` on every request; the role is read from `profiles`, never from the client. |
| Authorization | `requireRole()` in routes, plus role and ownership checks in the domain; RLS for any direct DB access |
| Validation | Strict zod schemas (unknown keys rejected) on every mutating route |
| Rate limiting | Per-user fixed window on report, claim, confirm, redeem, booking, assistant, admin and partner actions (in-memory: single instance) |
| Idempotency | Deterministic ledger keys plus a UNIQUE constraint |
| Audit | Admin decisions, rule changes, privacy purges and deletion requests are written to `admin_audit_logs` (append-only) |
| Secrets | Read only in server modules (`server-only` import guard); production build scanned |
| Headers | `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy` (geolocation self only) |
| Privacy | Coarsened coordinates in DTOs, no reporter identity on the map, retention purge, consent stored per user |
