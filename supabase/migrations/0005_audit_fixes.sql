-- ════════════════════════════════════════════════════════════════════
-- RAKNA LOOP — Phase 2 audit fixes (additive; nothing existing is dropped
-- except functions that are re-created with a compatible signature).
-- Validated with tests/db/supabase-sql.test.ts (PostgreSQL 18 + PostGIS via PGlite).
-- ════════════════════════════════════════════════════════════════════

-- ─── F-SEC-1: keys_balance() leaked any user's balance to any signed-in user ──
create or replace function public.keys_balance(p_user_id uuid) returns integer
language sql stable security definer set search_path = public as $$
  select case when p_user_id = auth.uid() or public.is_admin()
              then coalesce((select sum(amount) from points_ledger where user_id = p_user_id), 0)::integer
              else null end;
$$;

-- ─── F-DB-1: hive_add_feedback() failed (jsonb_set needs text[] path) ────────
create or replace function public.hive_add_feedback(p_helpful boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v jsonb; k text := case when p_helpful then 'helpful' else 'notHelpful' end;
begin
  insert into app_config (key, value) values ('hive_feedback', '{"helpful":0,"notHelpful":0}') on conflict (key) do nothing;
  update app_config
     set value = jsonb_set(value, array[k], to_jsonb(coalesce((value ->> k)::int, 0) + 1)), updated_at = now()
   where key = 'hive_feedback'
  returning value into v;
  return v;
end $$;
revoke execute on function public.hive_add_feedback(boolean) from public, anon, authenticated;

-- ─── F-PRIV-1: account deletion could never succeed ──────────────────────────
-- Deleting an auth user cascaded into the append-only points ledger and failed.
-- Durable records (ledger, bookings, redemptions) now RESTRICT deletion; accounts are
-- anonymized instead (anonymize_profile) and the auth identity is soft-deleted through
-- the Supabase Admin API (auth.admin.deleteUser(id, true)).
alter table profiles add column if not exists deleted_at timestamptz;

alter table points_ledger drop constraint if exists points_ledger_user_id_fkey;
alter table points_ledger add constraint points_ledger_user_id_fkey foreign key (user_id) references profiles (id) on delete restrict;
alter table reward_redemptions drop constraint if exists reward_redemptions_user_id_fkey;
alter table reward_redemptions add constraint reward_redemptions_user_id_fkey foreign key (user_id) references profiles (id) on delete restrict;
alter table parking_bookings drop constraint if exists parking_bookings_user_id_fkey;
alter table parking_bookings add constraint parking_bookings_user_id_fkey foreign key (user_id) references profiles (id) on delete restrict;
-- The auth → profile link must not cascade into durable records either.
alter table profiles drop constraint if exists profiles_id_fkey;
alter table profiles add constraint profiles_id_fkey foreign key (id) references auth.users (id) on delete restrict;

create or replace function public.anonymize_profile(p_user_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_reports int; v_claims int; v_conf int;
begin
  -- Temporary, location-bearing records are deleted outright.
  delete from report_confirmations where confirmer_id = p_user_id;
  get diagnostics v_conf = row_count;
  delete from report_claims where claimer_id = p_user_id;
  get diagnostics v_claims = row_count;
  delete from departure_reports where reporter_id = p_user_id and status not in ('flagged');
  get diagnostics v_reports = row_count;
  delete from challenge_progress where user_id = p_user_id;
  delete from mobility_missions where user_id = p_user_id;
  -- The profile row stays (durable ledger/bookings reference it) but carries no personal data.
  update profiles set display_name = 'Deleted user', display_name_ar = 'مستخدم محذوف', neighborhood = 'olaya',
         location_consent_at = null, deleted_at = now()
   where id = p_user_id;
  return jsonb_build_object('reports_deleted', v_reports, 'claims_deleted', v_claims, 'confirmations_deleted', v_conf);
end $$;
revoke execute on function public.anonymize_profile(uuid) from public, anon, authenticated;

-- ─── F-CONC-1: ledger daily-cap race + unique-violation handling ─────────────
-- Same behaviour as 0003, plus: (a) an optional daily earning cap enforced INSIDE the
-- per-user advisory lock, so concurrent awards cannot exceed it; (b) a concurrent
-- duplicate key returns the existing row instead of raising.
drop function if exists public.insert_ledger_entry(uuid, uuid, integer, ledger_type, text, text, text, uuid);
create or replace function public.insert_ledger_entry(
  p_id uuid, p_user_id uuid, p_amount integer, p_type ledger_type, p_reason text,
  p_idempotency_key text, p_ref_type text, p_ref_id uuid,
  p_cap_limit integer default null, p_cap_since timestamptz default null
) returns table (
  inserted boolean, id uuid, user_id uuid, amount integer, type ledger_type, reason text,
  idempotency_key text, ref_type text, ref_id uuid, created_at timestamptz
)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
  v_balance integer;
  v_amount integer := p_amount;
  v_earned integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('ledger:' || p_user_id::text, 0));

  return query select false, l.id, l.user_id, l.amount, l.type, l.reason, l.idempotency_key, l.ref_type, l.ref_id, l.created_at
    from points_ledger l where l.idempotency_key = p_idempotency_key;
  if found then return; end if;

  if p_amount > 0 and p_cap_limit is not null and p_type in ('departure_reward', 'confirmation_reward', 'streak_bonus', 'mission_reward') then
    select coalesce(sum(l.amount), 0) into v_earned from points_ledger l
     where l.user_id = p_user_id and l.created_at >= coalesce(p_cap_since, date_trunc('day', now()))
       and l.type in ('departure_reward', 'confirmation_reward', 'streak_bonus', 'mission_reward');
    v_amount := least(p_amount, greatest(p_cap_limit - v_earned, 0));
    if v_amount <= 0 then return; end if; -- capped: no row
  end if;

  if v_amount < 0 then
    select coalesce(sum(l.amount), 0) into v_balance from points_ledger l where l.user_id = p_user_id;
    if v_balance + v_amount < 0 then
      raise exception 'insufficient_balance' using errcode = 'P0001';
    end if;
  end if;

  begin
    return query insert into points_ledger as l (id, user_id, amount, type, reason, idempotency_key, ref_type, ref_id)
      values (p_id, p_user_id, v_amount, p_type,
              case when v_amount < p_amount then p_reason || ' (daily limit applied: ' || v_amount || '/' || p_amount || ')' else p_reason end,
              p_idempotency_key, p_ref_type, p_ref_id)
      returning true, l.id, l.user_id, l.amount, l.type, l.reason, l.idempotency_key, l.ref_type, l.ref_id, l.created_at;
  exception when unique_violation then
    return query select false, l.id, l.user_id, l.amount, l.type, l.reason, l.idempotency_key, l.ref_type, l.ref_id, l.created_at
      from points_ledger l where l.idempotency_key = p_idempotency_key;
  end;
end $$;
revoke execute on function public.insert_ledger_entry(uuid, uuid, integer, ledger_type, text, text, text, uuid, integer, timestamptz) from public, anon, authenticated;

-- ─── F-CONC-2: reward stock was read-modify-write (oversell under concurrency) ─
create or replace function public.reward_stock_adjust(p_reward_id uuid, p_delta integer) returns boolean
language sql security definer set search_path = public as $$
  with u as (
    update rewards_catalog set stock = stock + p_delta
     where id = p_reward_id and stock is not null and stock + p_delta >= 0
    returning 1
  )
  select exists (select 1 from u) or exists (select 1 from rewards_catalog where id = p_reward_id and stock is null);
$$;
revoke execute on function public.reward_stock_adjust(uuid, integer) from public, anon, authenticated;

-- ─── F-CONC-3: booking capacity was check-then-insert (overbooking) ──────────
create or replace function public.insert_booking_checked(
  p_id uuid, p_space_id uuid, p_user_id uuid, p_start timestamptz, p_end timestamptz, p_hours integer,
  p_price numeric, p_discount numeric, p_redemption_id uuid, p_capacity integer
) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_used int;
begin
  perform pg_advisory_xact_lock(hashtextextended('space:' || p_space_id::text, 0));
  select count(*) into v_used from parking_bookings
   where space_id = p_space_id and status = 'confirmed' and start_at < p_end and p_start < end_at;
  if v_used >= p_capacity then return false; end if;
  insert into parking_bookings (id, space_id, user_id, start_at, end_at, hours, price_total, discount_applied, redemption_id, status, simulated_payment)
  values (p_id, p_space_id, p_user_id, p_start, p_end, p_hours, p_price, p_discount, p_redemption_id, 'confirmed', true);
  return true;
end $$;
revoke execute on function public.insert_booking_checked(uuid, uuid, uuid, timestamptz, timestamptz, integer, numeric, numeric, uuid, integer) from public, anon, authenticated;

-- ─── F-PERF-2: admin totals without shipping the whole ledger to the app ──────
create or replace function public.ledger_totals() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'earned',      coalesce(sum(amount) filter (where amount > 0 and type <> 'redemption_refund'), 0),
    'spent',       coalesce(-sum(amount) filter (where amount < 0 and type <> 'admin_reversal'), 0),
    'refunded',    coalesce(sum(amount) filter (where type = 'redemption_refund'), 0),
    'outstanding', coalesce(sum(amount), 0))
  from points_ledger;
$$;
revoke execute on function public.ledger_totals() from public, anon, authenticated;

-- ─── F-OPS-1: lifecycle runs are logged, never overlap, and failures are recorded ─
create table if not exists hive_job_runs (
  id           bigint generated always as identity primary key,
  job          text not null,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  ok           boolean,
  details      jsonb,
  error        text
);
create index if not exists hive_job_runs_job_idx on hive_job_runs (job, started_at desc);
alter table hive_job_runs enable row level security;
create policy hive_job_runs_admin on hive_job_runs for select using (public.is_admin());

-- Keep the 0004 implementation as the worker; wrap it with locking + logging.
alter function public.rakna_hive_lifecycle(interval, interval, interval, interval) rename to rakna_hive_lifecycle_work;

-- F-DB-2: the 0004 worker stamped expired signals with resolved_at = now() (the moment the
-- job noticed them), which postponed their aggregation by p_aggregate_after and skewed
-- time metrics. A signal ends at its expiry time.
create or replace function public.rakna_hive_lifecycle_work(
  p_aggregate_after interval default interval '60 minutes',
  p_report_retention interval default interval '30 days',
  p_claim_retention interval default interval '24 hours',
  p_stats_retention interval default interval '60 days'
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_expired int; v_folded int; v_deleted int; v_claims int; v_stats int; v_demand int; v_purged int;
begin
  update departure_reports set status = 'expired', resolved_at = expires_at
   where status in ('pending_departure', 'available', 'claimed') and expires_at <= now();
  get diagnostics v_expired = row_count;
  update report_claims set active = false where active and expires_at <= now();

  with fold as (
    update departure_reports set aggregated_at = now()
     where aggregated_at is null and status in ('found', 'not_found', 'expired')
       and coalesce(resolved_at, expires_at) <= now() - p_aggregate_after and h3_r10 is not null
    returning h3_r10, h3_r9, h3_r8, h3_r7, date_trunc('hour', coalesce(resolved_at, expires_at)) as b, status, is_demo
  )
  insert into hive_cell_stats (h3_r10, h3_r9, h3_r8, h3_r7, bucket_start, reports, found, not_found, expired, is_demo)
  select h3_r10, h3_r9, h3_r8, h3_r7, b, count(*),
         count(*) filter (where status = 'found'), count(*) filter (where status = 'not_found'), count(*) filter (where status = 'expired'),
         bool_and(is_demo)
    from fold group by h3_r10, h3_r9, h3_r8, h3_r7, b
  on conflict (h3_r10, bucket_start) do update set
    reports = hive_cell_stats.reports + excluded.reports, found = hive_cell_stats.found + excluded.found,
    not_found = hive_cell_stats.not_found + excluded.not_found, expired = hive_cell_stats.expired + excluded.expired, updated_at = now();
  get diagnostics v_folded = row_count;

  -- Delete temporary rows only after they were aggregated (never flagged ones under review).
  delete from departure_reports where aggregated_at is not null and created_at < now() - p_report_retention
     and status in ('found', 'not_found', 'expired');
  get diagnostics v_deleted = row_count;
  delete from report_claims where not active and created_at < now() - p_claim_retention;
  get diagnostics v_claims = row_count;
  delete from hive_cell_stats where bucket_start < now() - p_stats_retention;
  get diagnostics v_stats = row_count;
  delete from hive_demand_buckets where bucket_start < now() - p_stats_retention;
  get diagnostics v_demand = row_count;
  v_purged := public.purge_precise_locations(now() - interval '24 hours');

  return jsonb_build_object('expired', v_expired, 'folded_cells', v_folded, 'reports_deleted', v_deleted,
                            'claims_deleted', v_claims, 'stats_deleted', v_stats, 'demand_deleted', v_demand, 'locations_coarsened', v_purged);
end $$;
revoke execute on function public.rakna_hive_lifecycle_work(interval, interval, interval, interval) from public, anon, authenticated;

create or replace function public.rakna_hive_lifecycle(
  p_aggregate_after interval default interval '60 minutes',
  p_report_retention interval default interval '30 days',
  p_claim_retention interval default interval '24 hours',
  p_stats_retention interval default interval '60 days'
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_run bigint; v_result jsonb;
begin
  -- Never overlap: a concurrent run simply skips (and says so).
  if not pg_try_advisory_xact_lock(hashtextextended('rakna_hive_lifecycle', 0)) then
    return jsonb_build_object('skipped', 'another run is in progress');
  end if;
  insert into hive_job_runs (job) values ('hive_lifecycle') returning id into v_run;
  begin
    v_result := public.rakna_hive_lifecycle_work(p_aggregate_after, p_report_retention, p_claim_retention, p_stats_retention);
    update hive_job_runs set finished_at = now(), ok = true, details = v_result where id = v_run;
  exception when others then
    -- The work above is rolled back (sub-transaction); the failure is recorded and a retry is safe.
    update hive_job_runs set finished_at = now(), ok = false, error = sqlerrm where id = v_run;
    v_result := jsonb_build_object('error', sqlerrm);
  end;
  delete from hive_job_runs where started_at < now() - interval '30 days';
  return v_result;
end $$;
revoke execute on function public.rakna_hive_lifecycle(interval, interval, interval, interval) from public, anon, authenticated;
