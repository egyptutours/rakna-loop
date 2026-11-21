# Cloud staging deployment (Supabase + Vercel)

> **Status: prepared, NOT yet executed.** No Supabase or Vercel credentials were available
> during the audit, so live connectivity, the PostgREST/GoTrue integration and pg_cron
> scheduling on a real project remain **unverified**. Everything below was validated only
> locally: all migrations against real PostgreSQL 18 + PostGIS 3.6 (PGlite) with a
> Supabase role/grant shim (`npm run test:db`). Never point any of these steps at production.

## 0. Quick start (operator path, about 30–45 minutes)

| Step | Who | What |
|---|---|---|
| A | You | Create the Supabase project `rakna-staging`; enable `postgis` and `pg_cron`; enable Email OTP (§1) |
| B | You | Create `.env.staging.local` from `.env.staging.example` and paste the **staging** URL, anon key and service-role key into it. Keep `RAKNA_TARGET=staging`. Never paste keys into chat or commit them. |
| C | You | Apply migrations 0001 → 0006 in the SQL Editor, in order (§3) |
| D | Either | `npm run staging:verify`: read-only checks of schema, RLS and job health |
| E | Either | `npm run staging:seed`: demo users, partner, spaces with H3, rewards, challenges |
| F | Either | Local smoke test against staging: copy `.env.staging.local` to `.env.local`, then `npm run dev`; sign in at `/signin` with your email |
| G | Either | `npm run staging:seed -- --make-admin <your email>`, then test Admin → Hive |
| H | You | Vercel: import the repo, set the same variables for Preview (§5), deploy; then add `APP_URL` and re-run `npm run staging:verify` |
| I | Both | Work through the manual checklist (§9) |

## 1. Create the staging project

1. Supabase dashboard → **New project** → name `rakna-staging`, region closest to users (Saudi
   data-residency questions in `PRODUCTION_READINESS.md` apply to production, so pick deliberately).
2. **Database → Extensions**: enable `postgis` and `pg_cron` (`pgcrypto` is enabled by default).
3. **Authentication → Providers**: enable **Email** with "Email OTP" (the app's `/signin` uses
   6-digit one-time codes). Disable sign-ups you don't need. Set the Site URL to the staging URL.
4. **Authentication → Rate limits**: keep the defaults or tighten them.

## 2. Environment variables

Copy `.env.staging.example`. In Vercel, set them for the **Preview** (or a dedicated staging)
environment only:

| Variable | Where it is used | Secret? |
|---|---|---|
| `RAKNA_DATA_MODE=supabase` | server | no. **Required in production builds**: the app refuses to start in an implicit mode |
| `NEXT_PUBLIC_SUPABASE_URL` | browser + server | no |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | browser (auth only) | no (protected by RLS) |
| `SUPABASE_SERVICE_ROLE_KEY` | server API routes only | **yes**. Never `NEXT_PUBLIC_`; rotate if exposed |
| `ANTHROPIC_API_KEY` | server only | **yes** (optional) |
| `NEXT_PUBLIC_MAP_STYLE_URL` | browser | no (optional) |

The production build was scanned: no secret names or key material appear in `.next/static`.

## 3. Back up, then migrate

```bash
# 0) Backup (even on staging; it rehearses the production runbook)
pg_dump "$STAGING_DB_URL" --format=custom --file=rakna-staging-$(date +%F).dump

# 1) Link and push migrations with the Supabase CLI
supabase link --project-ref <staging-project-ref>
supabase db push                     # applies supabase/migrations/0001 … 0006 in order
```

Without the CLI: paste each file from `supabase/migrations/` into **SQL Editor** in order
(0001 → 0006) and run it. 0006 prints a NOTICE saying whether pg_cron scheduling succeeded.

Then back-fill H3 indexes for any rows that predate 0004. The script is idempotent; it reads `.env.staging.local` and refuses to run unless `RAKNA_TARGET=staging`, or if the project ref is listed in `RAKNA_PRODUCTION_REFS`:

```bash
npm run db:backfill-h3 -- --dry-run
npm run db:backfill-h3
```

On a fresh staging project there is nothing to back-fill: `staging:seed` writes H3 indexes directly.

## 4. Seed data (staging only, all rows `is_demo = true`)

1. Preferred: `npm run staging:seed` (idempotent). It creates the four demo auth users with fixed ids
   (`@example.com` addresses, which cannot receive email; they only own demo data), upgrades their
   profiles, and upserts one approved partner, four spaces **with H3 indexes and accessible bays**,
   rewards, challenges and the reward rules. Every row has `is_demo = true`.
2. To test as yourself: sign in once at `/signin` with your real email, then
   `npm run staging:seed -- --make-admin <your email>`.
3. Alternative: create the users manually and run `supabase/seed.sql` (it does not set H3; run
   `db:backfill-h3` afterwards).
4. **Never run seed scripts on production.** Production roles are granted by an administrator with
   an audited SQL update (`update profiles set role = 'partner' where id = …`).

## 5. Deploy

- Vercel: import the repo, Framework = Next.js, Node ≥ 20.9, Build = `npm run build`
  (`prebuild` copies the MapLibre worker into `public/`). Attach the staging env vars to Preview.
- Each region and each instance share nothing in memory. Correctness relies on the database
  (compare-and-set updates, advisory-locked functions, unique indexes). **Rate limiting is still
  per instance** (see production blockers).

## 6. Scheduled jobs and monitoring

The lifecycle runs **inside the database**, scheduled by migration `0006_schedule_jobs.sql`:

```sql
select jobname, schedule, command, active from cron.job;                       -- expect rakna-hive-lifecycle, */5 * * * *
select * from cron.job_run_details order by start_time desc limit 10;           -- pg_cron's own log
select * from public.hive_job_runs order by started_at desc limit 10;           -- RAKNA's run log (ok/error/details)
select * from public.hive_job_health;                                           -- last success, failures in 24 h, overdue flag
```

- Runs never overlap (advisory lock; a concurrent run returns `{"skipped": …}`).
- A failed run is rolled back as a sub-transaction, recorded with `ok = false` and the error,
  and retried automatically 5 minutes later. Retries are idempotent (`aggregated_at` gating).
- **Alerting:** create a Supabase/Logflare (or external) check on `hive_job_health.overdue = true`
  or `failures_24h > 0`. The admin dashboard (**Admin → Hive intelligence**) shows the same
  health state via `/api/hive/metrics`.
- If `pg_cron` was unavailable when 0006 ran, enable it and re-run 0006 (it is idempotent).

## 7. Rollback

1. **App:** redeploy the previous Vercel deployment (Deployments → ⋯ → Promote).
2. **Database:** prefer roll-forward fixes. If a migration must be undone on staging, run
   `supabase/rollback/0006_down.sql`, then (only if necessary) `0005_down.sql`, which documents the
   security regressions it re-introduces. Rollback scripts keep data.
3. **Full restore:** `pg_restore --clean --if-exists -d "$STAGING_DB_URL" rakna-staging-<date>.dump`,
   or Supabase PITR (Pro plan and above).

## 8. Backups (recommendation)

- Staging: daily automated backups (Supabase default), plus `pg_dump` before every migration.
- Production: enable **Point-in-Time Recovery**, keep 7–30 days, test a restore into a scratch
  project quarterly, and store the `pg_dump` from before each migration for at least 30 days.
  The ledger, bookings and audit logs are the critical durable tables.

## 9. Staging verification checklist

| # | Check | How |
|---|---|---|
| 1 | Migrations 0001–0006 applied; pg_cron job present | `cron.job` query above |
| 2 | RLS: a normal user cannot insert or modify ledger rows, read others' reports or balances, approve spaces, or run lifecycle functions | Run the SQL in `tests/db/supabase-sql.test.ts` §6–8 as an `authenticated` user (SQL editor: `set role authenticated; select set_config('request.jwt.claim.sub', '<uid>', false);`) |
| 3 | Sign-in with email OTP works; `/api/session` returns the profile | Browser |
| 4 | Handoff end to end with two real accounts on two devices | Report → claim → confirm; Keys appear in the ledger once |
| 5 | Concurrency: two devices claim the same signal | Exactly one succeeds |
| 6 | Lifecycle: after 5 minutes `hive_job_runs` has `ok = true` rows; expired signals are folded and disappear from `/api/hive/map` | SQL + browser |
| 7 | Account deletion: request in Profile → Admin → Reviews → "Anonymize account" | The profile is anonymized; ledger and bookings are intact |
| 8 | Security headers (CSP, HSTS) present; no secrets in client JS | `curl -I`, view-source |
| 9 | Demo controls disabled: `/api/demo` and `POST /api/session` return 403 | curl |
| 10 | Backup and restore rehearsal | `pg_dump`, then restore into a scratch project |
