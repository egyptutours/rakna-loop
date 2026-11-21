-- ════════════════════════════════════════════════════════════════════
-- RAKNA LOOP — core schema (PostgreSQL / Supabase)
-- UUID PKs, FK integrity, timestamps, indexes, idempotent ledger.
-- Coordinates are stored as plain lat/lng numerics (no PostGIS needed);
-- swap to geography(Point) + GiST when spatial queries grow.
-- ════════════════════════════════════════════════════════════════════

create extension if not exists pgcrypto;

-- ─── enums ──────────────────────────────────────────────────────────
create type app_role            as enum ('driver', 'partner', 'admin');
create type report_status       as enum ('pending_departure', 'available', 'claimed', 'found', 'not_found', 'expired', 'flagged');
create type confirmation_outcome as enum ('found', 'not_found');
create type evidence_type       as enum ('gps', 'simulated', 'none');
create type ledger_type         as enum ('departure_reward', 'confirmation_reward', 'streak_bonus', 'mission_reward', 'redemption', 'redemption_refund', 'admin_reversal', 'booking_discount');
create type reward_category     as enum ('parking_discount', 'partner_benefit', 'sponsored_voucher', 'membership_perk');
create type redemption_status   as enum ('pending_approval', 'approved', 'rejected', 'used');
create type partner_status      as enum ('pending', 'approved', 'rejected', 'suspended');
create type partner_kind        as enum ('hotel', 'office', 'mall', 'operator', 'residential');
create type space_approval      as enum ('pending_review', 'approved', 'rejected', 'paused');
create type booking_status      as enum ('confirmed', 'cancelled', 'completed');
create type challenge_metric    as enum ('handoffs_today', 'handoffs_week', 'verified_reports_week', 'neighborhood_handoffs_week', 'missions_approved');
create type mission_kind        as enum ('park_and_metro', 'walk_connection', 'carpool');
create type mission_status      as enum ('submitted', 'approved', 'rejected');
create type fraud_kind          as enum ('self_confirmation_attempt', 'too_far_confirmation', 'impossible_travel', 'repeated_not_found', 'pair_collusion', 'report_spam', 'rapid_arrival');
create type fraud_severity      as enum ('low', 'medium', 'high');
create type fraud_status        as enum ('open', 'dismissed', 'actioned');

-- ─── 1. profiles (1:1 with auth.users) ──────────────────────────────
create table profiles (
  id                     uuid primary key references auth.users (id) on delete cascade,
  display_name           text not null check (char_length(display_name) between 1 and 80),
  display_name_ar        text not null default '',
  role                   app_role not null default 'driver',
  neighborhood           text not null default 'olaya',   -- coarse only; never a home location
  lang                   text not null default 'ar' check (lang in ('ar', 'en')),
  location_consent_at    timestamptz,
  deletion_requested_at  timestamptz,
  is_demo                boolean not null default false,
  created_at             timestamptz not null default now()
);
comment on table profiles is 'No vehicle registration numbers and no home location are stored (privacy by design).';

-- ─── 2. parking_partners ────────────────────────────────────────────
create table parking_partners (
  id                  uuid primary key default gen_random_uuid(),
  owner_id            uuid not null references profiles (id) on delete restrict,
  name                text not null,
  name_ar             text not null default '',
  kind                partner_kind not null,
  contact_email       text not null,
  cr_number_provided  boolean not null default false,
  status              partner_status not null default 'pending',
  is_demo             boolean not null default false,
  created_at          timestamptz not null default now(),
  reviewed_at         timestamptz
);
create index parking_partners_owner_idx on parking_partners (owner_id);
create unique index parking_partners_one_active_per_owner on parking_partners (owner_id) where status <> 'rejected';

-- ─── 3. parking_spaces (private inventory only) ─────────────────────
create table parking_spaces (
  id               uuid primary key default gen_random_uuid(),
  partner_id       uuid not null references parking_partners (id) on delete cascade,
  title            text not null,
  title_ar         text not null default '',
  location_lat     double precision not null check (location_lat between -90 and 90),
  location_lng     double precision not null check (location_lng between -180 and 180),
  neighborhood     text not null,
  address          text not null,
  address_ar       text not null default '',
  capacity         integer not null check (capacity between 1 and 2000),
  price_per_hour   numeric(8, 2) not null check (price_per_hour between 0 and 500),
  schedule         jsonb not null,  -- {"days":[0..6],"openHour":0-23,"closeHour":1-24}
  conditions       text not null default '',
  conditions_ar    text not null default '',
  reward_eligible  boolean not null default false,
  approval         space_approval not null default 'pending_review',
  is_demo          boolean not null default false,
  created_at       timestamptz not null default now()
);
create index parking_spaces_partner_idx on parking_spaces (partner_id);
create index parking_spaces_approval_idx on parking_spaces (approval);

-- ─── 4. departure_reports (community signals about PUBLIC parking) ──
create table departure_reports (
  id                     uuid primary key default gen_random_uuid(),
  reporter_id            uuid not null references profiles (id) on delete cascade,
  location_lat           double precision not null,
  location_lng           double precision not null,
  accuracy_m             integer not null check (accuracy_m >= 0),
  neighborhood           text not null,
  note                   text check (char_length(note) <= 140),
  created_at             timestamptz not null default now(),
  expected_departure_at  timestamptz not null,
  expires_at             timestamptz not null,
  status                 report_status not null,
  claimed_by             uuid references profiles (id) on delete set null,
  claimed_at             timestamptz,
  claim_expires_at       timestamptz,
  claim_location_lat     double precision,
  claim_location_lng     double precision,
  resolved_at            timestamptz,
  is_demo                boolean not null default false,
  check (claimed_by is null or claimed_by <> reporter_id),        -- no self-claim
  check (expires_at > created_at)
);
create index departure_reports_status_idx on departure_reports (status, expires_at);
create index departure_reports_reporter_idx on departure_reports (reporter_id, created_at desc);
create index departure_reports_geo_idx on departure_reports (location_lat, location_lng);
-- One live report per driver.
create unique index departure_reports_one_active on departure_reports (reporter_id) where status in ('pending_departure', 'available', 'claimed');

-- Public, coarsened view (≈110 m grid, no reporter identity) for map rendering via PostgREST.
-- Intentionally runs with the view owner's rights (security_invoker = false) so it can expose
-- ONLY these coarse columns while the base table stays locked down by RLS.
create view departure_reports_public with (security_invoker = false) as
  select id, status, round(location_lat::numeric, 3) as location_lat, round(location_lng::numeric, 3) as location_lng,
         accuracy_m, neighborhood, created_at, expected_departure_at, expires_at, is_demo
  from departure_reports
  where status in ('pending_departure', 'available', 'claimed');

-- ─── 5. report_claims ───────────────────────────────────────────────
create table report_claims (
  id                  uuid primary key default gen_random_uuid(),
  report_id           uuid not null references departure_reports (id) on delete cascade,
  claimer_id          uuid not null references profiles (id) on delete cascade,
  claim_location_lat  double precision,
  claim_location_lng  double precision,
  claim_accuracy_m    integer,
  created_at          timestamptz not null default now(),
  expires_at          timestamptz not null,
  active              boolean not null default true
);
create index report_claims_report_idx on report_claims (report_id);
create index report_claims_claimer_idx on report_claims (claimer_id, created_at desc);
create unique index report_claims_one_active_per_report on report_claims (report_id) where active;
create unique index report_claims_one_active_per_driver on report_claims (claimer_id) where active;

-- ─── 6. report_confirmations ────────────────────────────────────────
create table report_confirmations (
  id                uuid primary key default gen_random_uuid(),
  report_id         uuid not null references departure_reports (id) on delete cascade,
  confirmer_id      uuid not null references profiles (id) on delete cascade,
  outcome           confirmation_outcome not null,
  location_lat      double precision,
  location_lng      double precision,
  accuracy_m        integer,
  distance_m        integer,
  evidence          evidence_type not null,
  accepted          boolean not null,
  rejection_reason  text,
  created_at        timestamptz not null default now()
);
create index report_confirmations_report_idx on report_confirmations (report_id);
create index report_confirmations_confirmer_idx on report_confirmations (confirmer_id, created_at desc);
-- At most one ACCEPTED confirmation per report → no duplicate handoff rewards.
create unique index report_confirmations_one_accepted on report_confirmations (report_id) where accepted;

-- ─── 7. points_ledger (append-only; balance = SUM(amount)) ──────────
create table points_ledger (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references profiles (id) on delete cascade,
  amount           integer not null check (amount <> 0),
  type             ledger_type not null,
  reason           text not null,
  idempotency_key  text not null unique,    -- e.g. report:<id>:reporter
  ref_type         text,
  ref_id           uuid,
  created_at       timestamptz not null default now()
);
create index points_ledger_user_idx on points_ledger (user_id, created_at desc);
comment on table points_ledger is 'Authoritative RAKNA KEYS ledger. No balance column exists; balances are derived. Writes only via insert_ledger_entry().';

-- ─── 8. rewards_catalog ─────────────────────────────────────────────
create table rewards_catalog (
  id                uuid primary key default gen_random_uuid(),
  title             text not null,
  title_ar          text not null default '',
  description       text not null default '',
  description_ar    text not null default '',
  category          reward_category not null,
  keys_required     integer not null check (keys_required between 1 and 10000),
  partner_id        uuid references parking_partners (id) on delete set null,
  discount_percent  integer check (discount_percent between 1 and 100),
  eligibility       text not null default '',
  eligibility_ar    text not null default '',
  terms             text not null default '',
  terms_ar          text not null default '',
  active            boolean not null default true,
  stock             integer check (stock >= 0),
  is_demo           boolean not null default false,
  check (category <> 'parking_discount' or discount_percent is not null)
);

-- ─── 9. reward_redemptions ──────────────────────────────────────────
create table reward_redemptions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references profiles (id) on delete cascade,
  reward_id    uuid not null references rewards_catalog (id) on delete restrict,
  keys_spent   integer not null check (keys_spent > 0),
  status       redemption_status not null default 'pending_approval',
  code         text,
  simulated    boolean not null default true,
  created_at   timestamptz not null default now(),
  decided_at   timestamptz,
  decided_by   uuid references profiles (id),
  booking_id   uuid
);
create index reward_redemptions_user_idx on reward_redemptions (user_id, created_at desc);
create index reward_redemptions_status_idx on reward_redemptions (status);

-- ─── 10. parking_bookings ───────────────────────────────────────────
create table parking_bookings (
  id                 uuid primary key default gen_random_uuid(),
  space_id           uuid not null references parking_spaces (id) on delete restrict,
  user_id            uuid not null references profiles (id) on delete cascade,
  start_at           timestamptz not null,
  end_at             timestamptz not null,
  hours              integer not null check (hours between 1 and 12),
  price_total        numeric(10, 2) not null check (price_total >= 0),
  discount_applied   numeric(10, 2) not null default 0 check (discount_applied >= 0),
  redemption_id      uuid references reward_redemptions (id),
  status             booking_status not null default 'confirmed',
  simulated_payment  boolean not null default true check (simulated_payment),  -- no live payments in the MVP
  created_at         timestamptz not null default now(),
  check (end_at > start_at),
  check (discount_applied <= price_total)
);
create index parking_bookings_space_time_idx on parking_bookings (space_id, start_at, end_at);
create index parking_bookings_user_idx on parking_bookings (user_id, start_at desc);
alter table reward_redemptions add constraint reward_redemptions_booking_fk foreign key (booking_id) references parking_bookings (id) deferrable initially deferred;

-- ─── 11. neighborhood_challenges ────────────────────────────────────
create table neighborhood_challenges (
  id              uuid primary key default gen_random_uuid(),
  title           text not null,
  title_ar        text not null default '',
  description     text not null default '',
  description_ar  text not null default '',
  metric          challenge_metric not null,
  target          integer not null check (target > 0),
  neighborhood    text,
  active          boolean not null default true,
  is_demo         boolean not null default false
);

-- ─── 12. challenge_progress ─────────────────────────────────────────
create table challenge_progress (
  challenge_id  uuid not null references neighborhood_challenges (id) on delete cascade,
  user_id       uuid not null references profiles (id) on delete cascade,
  progress      integer not null default 0 check (progress >= 0),
  completed_at  timestamptz,
  primary key (challenge_id, user_id)
);

-- Park & Connect missions (simulated in the MVP).
create table mobility_missions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references profiles (id) on delete cascade,
  kind         mission_kind not null,
  description  text not null check (char_length(description) <= 280),
  status       mission_status not null default 'submitted',
  created_at   timestamptz not null default now(),
  decided_at   timestamptz,
  simulated    boolean not null default true check (simulated)
);
create index mobility_missions_user_idx on mobility_missions (user_id, created_at desc);

-- ─── 13. fraud_flags ────────────────────────────────────────────────
create table fraud_flags (
  id               uuid primary key default gen_random_uuid(),
  kind             fraud_kind not null,
  user_id          uuid not null references profiles (id) on delete cascade,
  related_user_id  uuid references profiles (id) on delete set null,
  report_id        uuid references departure_reports (id) on delete set null,
  details          text not null,
  severity         fraud_severity not null,
  status           fraud_status not null default 'open',
  created_at       timestamptz not null default now(),
  reviewed_by      uuid references profiles (id)
);
create index fraud_flags_status_idx on fraud_flags (status, created_at desc);
create index fraud_flags_user_idx on fraud_flags (user_id);

-- ─── 14. admin_audit_logs (append-only) ─────────────────────────────
create table admin_audit_logs (
  id          uuid primary key default gen_random_uuid(),
  actor_id    uuid not null references profiles (id),
  action      text not null,
  target      text not null,
  details     text not null default '',
  created_at  timestamptz not null default now()
);
create index admin_audit_logs_created_idx on admin_audit_logs (created_at desc);

-- Runtime configuration (editable reward rules).
create table app_config (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now()
);
