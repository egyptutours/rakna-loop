-- ════════════════════════════════════════════════════════════════════
-- RAKNA HIVE INTELLIGENCE — incremental, additive migration.
-- Nothing existing is dropped. Exact coordinates stay in location_lat/lng;
-- H3 ids are denormalized per resolution purely for indexed grouping/queries.
-- ════════════════════════════════════════════════════════════════════

create extension if not exists postgis;

-- ─── H3 indexes on spatial records ──────────────────────────────────
alter table departure_reports
  add column if not exists h3_r7  text,
  add column if not exists h3_r8  text,
  add column if not exists h3_r9  text,
  add column if not exists h3_r10 text,
  add column if not exists aggregated_at timestamptz,
  add column if not exists geog geography(Point, 4326)
    generated always as (st_setsrid(st_makepoint(location_lng, location_lat), 4326)::geography) stored;

-- Viewport queries filter on (cell, status); partial indexes keep the hot set tiny.
create index if not exists departure_reports_h3_r7_idx  on departure_reports (h3_r7, status);
create index if not exists departure_reports_h3_r8_idx  on departure_reports (h3_r8, status);
create index if not exists departure_reports_h3_r9_idx  on departure_reports (h3_r9, status);
create index if not exists departure_reports_h3_r10_idx on departure_reports (h3_r10, status);
create index if not exists departure_reports_live_r9_idx on departure_reports (h3_r9) where status in ('pending_departure', 'available', 'claimed');
create index if not exists departure_reports_geog_idx on departure_reports using gist (geog);
create index if not exists departure_reports_unaggregated_idx on departure_reports (created_at) where aggregated_at is null and status in ('found', 'not_found', 'expired');

alter table parking_spaces
  add column if not exists h3_r7  text,
  add column if not exists h3_r8  text,
  add column if not exists h3_r9  text,
  add column if not exists h3_r10 text,
  add column if not exists accessible_bays integer not null default 0 check (accessible_bays >= 0),
  add column if not exists geog geography(Point, 4326)
    generated always as (st_setsrid(st_makepoint(location_lng, location_lat), 4326)::geography) stored;
create index if not exists parking_spaces_h3_r9_idx  on parking_spaces (h3_r9);
create index if not exists parking_spaces_h3_r10_idx on parking_spaces (h3_r10);
create index if not exists parking_spaces_geog_idx on parking_spaces using gist (geog);

-- Back-fill note: H3 ids are computed by the application (h3-js). Existing rows can be
-- back-filled with a one-off script, or in SQL with the h3-pg extension if available:
--   update departure_reports set h3_r10 = h3_lat_lng_to_cell(point(location_lng, location_lat), 10)::text, ...

-- ─── Aggregated, anonymized hive data (no user ids, no exact points) ─
create table if not exists hive_cell_stats (
  h3_r10        text not null,
  h3_r9         text not null,
  h3_r8         text not null,
  h3_r7         text not null,
  bucket_start  timestamptz not null,          -- hourly bucket
  reports       integer not null default 0 check (reports >= 0),
  found         integer not null default 0 check (found >= 0),
  not_found     integer not null default 0 check (not_found >= 0),
  expired       integer not null default 0 check (expired >= 0),
  is_demo       boolean not null default false,
  updated_at    timestamptz not null default now(),
  primary key (h3_r10, bucket_start)
);
create index if not exists hive_cell_stats_r7_idx on hive_cell_stats (h3_r7, bucket_start);
create index if not exists hive_cell_stats_r8_idx on hive_cell_stats (h3_r8, bucket_start);
create index if not exists hive_cell_stats_r9_idx on hive_cell_stats (h3_r9, bucket_start);
comment on table hive_cell_stats is 'Hive trails: anonymized verified-outcome counters per H3 cell and hour. Retained statsRetentionDays.';

create table if not exists hive_demand_buckets (
  h3_r9         text not null,
  h3_r8         text not null,
  h3_r7         text not null,
  bucket_start  timestamptz not null,
  searches      integer not null default 0 check (searches >= 0),
  is_demo       boolean not null default false,
  primary key (h3_r9, bucket_start)
);
create index if not exists hive_demand_r8_idx on hive_demand_buckets (h3_r8, bucket_start);
create index if not exists hive_demand_r7_idx on hive_demand_buckets (h3_r7, bucket_start);
comment on table hive_demand_buckets is 'Anonymous forager demand counters (no user id, no exact location).';

alter table hive_cell_stats     enable row level security;
alter table hive_demand_buckets enable row level security;
-- Aggregates are non-personal and safe to read; writes only through the functions below (service role).
create policy hive_stats_read  on hive_cell_stats     for select using (true);
create policy hive_demand_read on hive_demand_buckets for select using (true);

-- ─── Atomic counter functions ───────────────────────────────────────
create or replace function public.hive_increment_cell_stat(
  p_cell text, p_r7 text, p_r8 text, p_r9 text, p_bucket timestamptz,
  p_reports int, p_found int, p_not_found int, p_expired int, p_is_demo boolean
) returns void language sql security definer set search_path = public as $$
  insert into hive_cell_stats (h3_r10, h3_r9, h3_r8, h3_r7, bucket_start, reports, found, not_found, expired, is_demo)
  values (p_cell, p_r9, p_r8, p_r7, p_bucket, p_reports, p_found, p_not_found, p_expired, p_is_demo)
  on conflict (h3_r10, bucket_start) do update set
    reports = hive_cell_stats.reports + excluded.reports,
    found = hive_cell_stats.found + excluded.found,
    not_found = hive_cell_stats.not_found + excluded.not_found,
    expired = hive_cell_stats.expired + excluded.expired,
    updated_at = now();
$$;

-- Demand parents are derived by the caller (h3-js) for the r9 cell; r8/r7 supplied via
-- an overload so the table can be queried at coarse zoom without h3-pg.
create or replace function public.hive_increment_demand(
  p_cell_r9 text, p_bucket timestamptz, p_searches int, p_is_demo boolean, p_r8 text default null, p_r7 text default null
) returns void language sql security definer set search_path = public as $$
  insert into hive_demand_buckets (h3_r9, h3_r8, h3_r7, bucket_start, searches, is_demo)
  values (p_cell_r9, coalesce(p_r8, ''), coalesce(p_r7, ''), p_bucket, p_searches, p_is_demo)
  on conflict (h3_r9, bucket_start) do update set searches = hive_demand_buckets.searches + excluded.searches;
$$;

create or replace function public.hive_add_feedback(p_helpful boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v jsonb;
begin
  insert into app_config (key, value) values ('hive_feedback', '{"helpful":0,"notHelpful":0}')
  on conflict (key) do nothing;
  update app_config
     set value = jsonb_set(value, case when p_helpful then '{helpful}' else '{notHelpful}' end,
                           to_jsonb(coalesce((value ->> case when p_helpful then 'helpful' else 'notHelpful' end)::int, 0) + 1)),
         updated_at = now()
   where key = 'hive_feedback'
  returning value into v;
  return v;
end $$;

-- ─── Data lifecycle (temporary → aggregated → deleted) ──────────────
-- Folds expired/resolved temporary reports into hive_cell_stats, deletes them after
-- retention, and prunes aggregates. NEVER touches ledger, bookings, redemptions,
-- profiles, partners, spaces or audit logs.
create or replace function public.rakna_hive_lifecycle(
  p_aggregate_after interval default interval '60 minutes',
  p_report_retention interval default interval '30 days',
  p_claim_retention interval default interval '24 hours',
  p_stats_retention interval default interval '60 days'
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_expired int; v_folded int; v_deleted int; v_claims int; v_stats int; v_demand int;
begin
  update departure_reports set status = 'expired', resolved_at = now()
   where status in ('pending_departure', 'available', 'claimed') and expires_at <= now();
  get diagnostics v_expired = row_count;

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

  delete from departure_reports where aggregated_at is not null and created_at < now() - p_report_retention
     and status in ('found', 'not_found', 'expired');
  get diagnostics v_deleted = row_count;
  delete from report_claims where not active and created_at < now() - p_claim_retention;
  get diagnostics v_claims = row_count;
  delete from hive_cell_stats where bucket_start < now() - p_stats_retention;
  get diagnostics v_stats = row_count;
  delete from hive_demand_buckets where bucket_start < now() - p_stats_retention;
  get diagnostics v_demand = row_count;

  perform public.purge_precise_locations(now() - interval '24 hours');
  return jsonb_build_object('expired', v_expired, 'folded_cells', v_folded, 'reports_deleted', v_deleted,
                            'claims_deleted', v_claims, 'stats_deleted', v_stats, 'demand_deleted', v_demand);
end $$;

revoke execute on function public.hive_increment_cell_stat(text, text, text, text, timestamptz, int, int, int, int, boolean) from public, anon, authenticated;
revoke execute on function public.hive_increment_demand(text, timestamptz, int, boolean, text, text) from public, anon, authenticated;
revoke execute on function public.hive_add_feedback(boolean) from public, anon, authenticated;
revoke execute on function public.rakna_hive_lifecycle(interval, interval, interval, interval) from public, anon, authenticated;

-- Schedule with pg_cron (Supabase → Database → Extensions → pg_cron):
-- select cron.schedule('rakna-hive-lifecycle', '*/5 * * * *', $$select public.rakna_hive_lifecycle()$$);

-- Default hive configuration (editable from Admin → Hive).
insert into app_config (key, value) values ('hive_feedback', '{"helpful":0,"notHelpful":0}') on conflict (key) do nothing;
