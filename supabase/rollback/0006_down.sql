-- Rollback for 0006_schedule_jobs.sql (staging first). Non-destructive: no data is removed.
do $do$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'rakna-hive-lifecycle';
  end if;
end
$do$;
drop view if exists public.hive_job_health;
