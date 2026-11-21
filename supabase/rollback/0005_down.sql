-- Rollback for 0005_audit_fixes.sql — USE ONLY IF 0005 BREAKS STAGING. Prefer roll-forward.
-- WARNING: rolling back re-introduces audited defects (balance disclosure via keys_balance,
-- broken hive_add_feedback, unprocessable account deletion, check-then-act races).
-- Data is preserved: hive_job_runs and profiles.deleted_at are kept.

-- Restore the 0004 lifecycle entry point name (the 0005 wrapper is dropped).
drop function if exists public.rakna_hive_lifecycle(interval, interval, interval, interval);
alter function public.rakna_hive_lifecycle_work(interval, interval, interval, interval) rename to rakna_hive_lifecycle;
revoke execute on function public.rakna_hive_lifecycle(interval, interval, interval, interval) from public, anon, authenticated;

drop function if exists public.ledger_totals();
drop function if exists public.insert_booking_checked(uuid, uuid, uuid, timestamptz, timestamptz, integer, numeric, numeric, uuid, integer);
drop function if exists public.reward_stock_adjust(uuid, integer);
drop function if exists public.anonymize_profile(uuid);

-- Re-create the 0003 ledger signature (the app at the 0004 code level calls it).
drop function if exists public.insert_ledger_entry(uuid, uuid, integer, ledger_type, text, text, text, uuid, integer, timestamptz);
-- → re-run the insert_ledger_entry definition from 0003_functions.sql here.

-- FKs back to cascade (not recommended: makes account deletion fail on the append-only ledger).
-- Intentionally NOT reverted: restrict is strictly safer for durable records.
