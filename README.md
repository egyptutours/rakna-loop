# RAKNA LOOP — ركنة لوب

**Leave a Spot. Earn Rewards. Help Your City Move.**
**اترك موقفًا، اكسب نقاطًا، وساعد غيرك.**

An AI-assisted community parking-sharing and rewards platform MVP for Riyadh, Saudi Arabia. Drivers tell nearby drivers when they are leaving a public spot. When another driver **verifies on site** that they found it, the original driver earns **RAKNA KEYS (مفاتيح ركنة)**, virtual loyalty points they can redeem for eligible partner parking discounts and perks. The app also includes a marketplace of **authorized** private parking, neighborhood challenges, and an AI parking assistant that understands Arabic and English.

> **Phase 2 status:** independently audited (see `docs/AUDIT_REPORT.md`). Database logic, RLS and concurrency are verified locally on real PostgreSQL + PostGIS. **Cloud staging is prepared but has not been executed**, and the app is **not production-ready**: see the remaining blockers.
>
> **This is a working demonstration MVP.** It runs fully in **DEMO MODE** with simulated Riyadh data and needs no credentials. Every demo record is marked **DEMO DATA**. Rewards, redemptions and payments are **simulated**. The rewards program needs Saudi regulatory and legal review before commercial launch (see [docs/PRODUCTION_READINESS.md](docs/PRODUCTION_READINESS.md)).

---

## Quick start

Requirements: **Node.js ≥ 20.9** (tested on Node 26.13.1 LTS).

```bash
npm install          # also copies the MapLibre web worker into public/
npm run dev          # http://localhost:3000
```

Open the app, follow the onboarding, and pick a demo account.

### The 2-minute demo: a verified parking handoff in one browser

1. Use the **demo account switcher** in the top bar and choose **Sara (Demo Driver A)**.
2. Tap **I'm Leaving / أنا مغادر**, choose **Demo: Parked in Al Olaya**, tick the consent box, and tap **Share departure signal**.
3. Switch to **Faisal (Demo Driver B)**. Open the same report (from the map or the link on the report page).
4. Choose a simulated position, then tap **Navigate to this spot**. The exact location is now revealed to B only.
5. Choose **Demo: At the spot**, then tap **I Found the Parking Space**.
6. B earns **2 Keys** and A earns **8 Keys** (both in the ledger). Check **Wallet** as Sara.

Try the failure paths as well:
- Confirm as Sara: this is a **self-confirmation** and is rejected.
- Confirm from **600 m away**: rejected as **too far**.
- Confirm from **8 km away** right after claiming from far: the handoff is **held for admin review** as **impossible travel**.
- Use **Demo: expire this report now**: claims and confirmations are rejected as **expired**.

Other accounts: **Olaya Business Tower (Demo Partner)** for the partner dashboard, **Demo Administrator** for approvals, fraud review and reward rules, and **Malqa Hotel (Demo applicant)**, a partner that is not yet approved and so cannot list spaces.

**Reset demo data** is on the **Profile** page.

---

## What's included

| Area | What works |
|---|---|
| Verified parking handoff | Report → claim → on-site confirm, with GPS-tolerant proximity checks, freshness and expiry, one active claim per signal, no self-confirmation, no duplicate rewards, and a status machine (`pending_departure → available → claimed → found / not_found / expired / flagged`) |
| Confidence score | A transparent 0–100 score (freshness, GPS accuracy, distance, reporter reliability, spot history) shown as High / Medium / Low with a breakdown of each factor. Never labelled as guaranteed. |
| RAKNA KEYS engine | An append-only ledger where balance = Σ(entries). Every award has a unique idempotency key. Includes daily earning limits, a non-negative balance guarantee (domain layer and storage layer), refunds, admin reversals capped at the balance, and reward rules admins can edit (all changes audited). |
| Rewards | Wallet, earned and redeemed history, a catalog with terms, simulated redemptions that need admin approval (rejection refunds automatically), and parking discounts applied at booking |
| Private marketplace | Partner application → admin approval → space submission → admin approval → bookable. Weekly schedules, capacity, Riyadh-time checks, simulated payment. |
| Partner dashboard | Listed spaces, schedules, bookings, 7-day occupancy, estimated revenue (simulated), Keys-discount eligibility, pause/resume |
| Admin dashboard | KPIs, review queues (partners, spaces, redemptions, missions, held handoffs), fraud flags with dismiss or reverse, reward-rules editor, catalog, ledger, community activity, audit log, location-retention purge |
| Fraud signals | Self-confirmation attempts, repeated far-away confirmations, impossible travel, rapid arrival, pair collusion, repeated "not found", report spam |
| Community | Neighborhood challenges (progress counts only verified outcomes), 5 badges, a weekly leaderboard ranked by contributions rather than Keys, neighborhood participation, simulated Park & Connect missions |
| AI assistant | Arabic and English natural-language requests. A deterministic parser and ranker work with no API key. Optionally, Claude (server-side only) parses the request into structured preferences; ranking always uses stored records only, so availability is never invented. |
| Privacy | Location is requested only when you tap an action. No background tracking. Other drivers see coarsened (~110 m) positions; precise positions go only to the claimer and admins. No vehicle plates are collected. Precise coordinates are coarsened after a retention window. Includes a privacy notice and an account-deletion request flow. |
| i18n | Arabic by default with full RTL; English as the alternative. The `<html dir/lang>` is server-rendered from a cookie. |
| Map | MapLibre GL with OpenStreetMap raster tiles and attribution. Blue = community signal, green = approved private parking, gray = inactive. |
| **RAKNA HIVE INTELLIGENCE** | An H3 hexagonal hive map (r7→r10 by zoom) with QUIET / ACTIVE / RESOURCE RICH / HIGH DEMAND / OVERLOADED states computed from stored data. Ant-inspired trails (verified outcomes reinforce, failures weaken, time evaporates). Bee-inspired resource signals with explanations. Local ring-by-ring recruitment with a fairness cap. Demand balancing that points to neighboring hives, private parking and transit. Dynamic Scout / Forager / Verifier / Steward roles. A data lifecycle (temporary → aggregated → deleted). Viewport-only, paginated, cached queries. See [docs/HIVE.md](docs/HIVE.md). |

## Configuration

Every variable is optional; see [.env.example](.env.example).

| Variable | Purpose | Without it |
|---|---|---|
| `RAKNA_DATA_MODE` | `demo` or `supabase`. **Required in production builds**: the API returns 503 rather than silently running demo mode (whose account switcher would expose the demo admin) | Demo mode in development only |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | Supabase Postgres and Auth | Demo mode (it falls back to demo even if `supabase` is requested) |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | Claude-assisted request understanding (server-only; default model `claude-opus-5-5`) | Deterministic rule-based parser |
| `NEXT_PUBLIC_MAP_STYLE_URL` | Custom MapLibre style or tile provider | Built-in OSM raster style |
| `RAKNA_DEMO_PERSIST` | Persist demo state to `.data/demo-db.json` in local dev | On locally; always off on Vercel |

Secrets are read only in server code. A production build was scanned and contains no secret names or keys in `.next/static`.

## Scripts

```bash
npm run dev         # development server
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm test            # vitest: 124 tests (app, concurrency, audit, and SQL on PostgreSQL 18 + PostGIS via PGlite)
npm run test:db     # only the database suite (migrations, RLS, atomic functions, lifecycle)
npm run bench       # Hive benchmarks 2.5k → 250k reports (slow; writes bench/results/)
npm run build       # production build
npm run check       # typecheck + lint + tests + build
npm run staging:verify   # read-only checks of a STAGING Supabase project (.env.staging.local)
npm run staging:seed     # idempotent staging demo seed (+ --make-admin <email>)
npm run db:backfill-h3 -- --dry-run   # staging-only H3 back-fill (see docs/STAGING.md)
```

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): architecture, data model, verification and reward flows, adapters
- [docs/HIVE.md](docs/HIVE.md): RAKNA HIVE INTELLIGENCE (biomimicry mapping, H3 hive map, swarm engine, data lifecycle, scalability, tuning)
- [docs/AUDIT_REPORT.md](docs/AUDIT_REPORT.md): Phase 2 independent audit (severity-ranked findings, security, DB validation, concurrency, blockers)
- [docs/BENCHMARKS.md](docs/BENCHMARKS.md): measured Hive performance 2.5k → 250k reports, and what remains untested
- [docs/STAGING.md](docs/STAGING.md): Supabase + Vercel staging runbook (env, migrations, seed, pg_cron monitoring, rollback, backups, checklist)
- [docs/TESTING.md](docs/TESTING.md): test matrix mapped to requirements, and manual QA steps
- [docs/PRODUCTION_READINESS.md](docs/PRODUCTION_READINESS.md): what needs credentials, the go-live checklist, and Saudi legal and operational questions
- [supabase/migrations](supabase/migrations): schema, RLS policies, atomic functions; [supabase/seed.sql](supabase/seed.sql): demo seed

## Assumptions

- Service area is the Riyadh metro bounding box. The four demo neighborhoods are Al Olaya, Al Wurud, Al Malqa and King Fahd Road.
- Reports live 20 minutes after the stated departure time. A claim holds the **signal** (never the public space) for 15 minutes, and the report's validity extends to cover an active claim.
- "Not available" without on-site evidence only releases the claim. It neither penalizes the reporter nor pays the confirmer, so it can't be used to grief other drivers.
- A verified on-site confirmation earns the confirmer the same 2 Keys whether the spot was found or not, so there is no incentive to lie about the outcome.
- Challenges grant recognition and badges only. Keys come exclusively from the configured verified actions, so no activity is ever paid twice.
- Demo auth is a cookie-based account switcher limited to seeded demo profiles. Production auth is Supabase Auth with Bearer tokens.
