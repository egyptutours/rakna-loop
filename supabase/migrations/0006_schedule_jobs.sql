-- ════════════════════════════════════════════════════════════════════
-- RAKNA LOOP — scheduled jobs (pg_cron).
-- This migration CONFIGURES the schedule; it is not just documentation.
-- On Supabase, pg_cron is available (Dashboard → Database → Extensions) and this
-- migration enables it. Where pg_cron is not installable (local test harness), the
-- migration logs a NOTICE and skips — the schedule must then be verified manually
-- (see docs/STAGING.md §6).
-- Monitoring: public.hive_job_runs (one row per run, ok/error) and cron.job_run_details.
-- ════════════════════════════════════════════════════════════════════

do $do$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    -- Idempotent: remove a previous definition with the same name, then (re)schedule.
    perform cron.unschedule(jobid) from cron.job where jobname = 'rakna-hive-lifecycle';
    perform cron.schedule('rakna-hive-lifecycle', '*/5 * * * *', 'select public.rakna_hive_lifecycle()');
    raise notice 'pg_cron: rakna-hive-lifecycle scheduled every 5 minutes';
  else
    raise notice 'pg_cron not available on this server — lifecycle NOT scheduled (verify manually)';
  end if;
end
$do$;

-- Health view for dashboards/alerts: the last run and whether it is overdue.
create or replace view public.hive_job_health with (security_invoker = true) as
select job,
       max(started_at) as last_started_at,
       max(finished_at) filter (where ok) as last_success_at,
       count(*) filter (where ok = false and started_at > now() - interval '1 day') as failures_24h,
       (max(finished_at) filter (where ok) < now() - interval '15 minutes') as overdue
  from public.hive_job_runs
 group by job;
revoke all on public.hive_job_health from anon;
