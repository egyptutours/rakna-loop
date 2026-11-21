-- ════════════════════════════════════════════════════════════════════
-- RAKNA LOOP — Phase 3: RAKNA HOME (villa carports, condo bays), RAKNA PARTNERS
-- weekly schedules, PARK & CONNECT, integer-halalas fares, access credentials,
-- booking lifecycle events, shared rate limiting and the single-trip hive_viewport().
--
-- Defence in depth: the Next.js domain layer (src/lib/domain/home.ts) enforces every
-- rule first; this migration re-enforces the ones that protect money, privacy and the
-- Saudi entitlement rules at the storage layer, so a bug or a direct client cannot
-- bypass them.
--
-- Rollback: supabase/rollback/0007_down.sql
-- ════════════════════════════════════════════════════════════════════

-- ─── 1. parking_spaces: categories, entitlement, verification, privacy point ───
alter table parking_spaces
  add column if not exists space_category        text not null default 'commercial'
    check (space_category in ('villa_shaded', 'villa_open', 'villa_garage', 'condo_deeded', 'condo_association', 'commercial')),
  add column if not exists entitlement_type      text not null default 'commercial_cr'
    check (entitlement_type in ('deed_owner', 'owner_wakalah', 'ejar_authorized', 'owners_association', 'commercial_cr')),
  add column if not exists verification_status   text not null default 'pending'
    check (verification_status in ('pending', 'verified', 'rejected', 'suspended')),
  -- ~150 m privacy point shown before a confirmed booking (center of the r9 hexagon,
  -- computed by the app; the trigger below coarsens to a ~150 m grid if it is missing).
  add column if not exists public_lat            double precision check (public_lat between -90 and 90),
  add column if not exists public_lng            double precision check (public_lng between -180 and 180),
  add column if not exists shade_tier            text
    check (shade_tier in ('underground', 'enclosed', 'full_carport', 'partial_shade', 'uncovered')),
  add column if not exists max_height_cm         integer check (max_height_cm between 100 and 1500),
  add column if not exists max_width_cm          integer check (max_width_cm between 100 and 1500),
  add column if not exists max_length_cm         integer check (max_length_cm between 100 and 1500),
  add column if not exists buffer_minutes        integer not null default 0 check (buffer_minutes between 0 and 120),
  add column if not exists instant_book          boolean not null default true,
  add column if not exists access_mode           text not null default 'unobstructed'
    check (access_mode in ('unobstructed', 'ephemeral_pin', 'dynamic_qr', 'guard_pass', 'host_remote')),
  add column if not exists metro_station_code    text check (metro_station_code ~ '^[A-Z0-9]{2,8}$'),
  add column if not exists waitlist_only         boolean not null default false,
  add column if not exists host_id               uuid references profiles (id) on delete restrict,
  -- Tenants (Ejar) must attest written landlord consent; only the timestamp is stored, never the contract.
  add column if not exists landlord_consent_at   timestamptz;

-- Legacy rows: every pre-Phase-3 space is a commercial partner space. Approved ones were
-- reviewed by an administrator (CR checked out-of-band) → verified.
update parking_spaces
   set verification_status = case when approval = 'approved' then 'verified' else 'pending' end,
       public_lat = coalesce(public_lat, location_lat),
       public_lng = coalesce(public_lng, location_lng)
 where space_category = 'commercial';

-- Saudi entitlement rules (mirror of ALLOWED_ENTITLEMENTS in src/lib/domain/home.ts):
--  • common-property building bays belong to the building → owners' association only;
--  • commercial parking → commercial registration;
--  • villa / deeded condo bays → title-deed owner, owner's wakalah, or an Ejar tenant
--    who attests landlord consent.
alter table parking_spaces drop constraint if exists parking_spaces_entitlement_chk;
alter table parking_spaces add constraint parking_spaces_entitlement_chk check (
  case space_category
    when 'condo_association' then entitlement_type = 'owners_association'
    when 'commercial'        then entitlement_type = 'commercial_cr'
    else entitlement_type in ('deed_owner', 'owner_wakalah', 'ejar_authorized')
  end
);
alter table parking_spaces drop constraint if exists parking_spaces_ejar_consent_chk;
alter table parking_spaces add constraint parking_spaces_ejar_consent_chk check (
  entitlement_type <> 'ejar_authorized' or landlord_consent_at is not null
);
-- A residential space is a single bay owned by one host account.
alter table parking_spaces drop constraint if exists parking_spaces_residential_host_chk;
alter table parking_spaces add constraint parking_spaces_residential_host_chk check (
  space_category = 'commercial' or (host_id is not null and capacity = 1)
);
-- Nothing unverified can be approved for the map.
alter table parking_spaces drop constraint if exists parking_spaces_verified_approval_chk;
alter table parking_spaces add constraint parking_spaces_verified_approval_chk check (
  approval <> 'approved' or verification_status = 'verified'
);

create or replace function public.parking_spaces_privacy_point() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.space_category = 'commercial' then
    new.public_lat := new.location_lat;
    new.public_lng := new.location_lng;
    -- Legacy commercial path: admin approval IS the CR verification (see decideSpace).
    if new.approval = 'approved' and new.verification_status = 'pending' then
      new.verification_status := 'verified';
    end if;
  elsif new.public_lat is null or new.public_lng is null
        or abs(new.public_lat - new.location_lat) > 0.01 or abs(new.public_lng - new.location_lng) > 0.01 then
    -- ~150 m grid (0.00135° lat ≈ 150 m). Never the exact point for residential spaces.
    new.public_lat := round((new.location_lat / 0.00135)::numeric) * 0.00135;
    new.public_lng := round((new.location_lng / 0.00135)::numeric) * 0.00135;
  end if;
  if new.public_lat = new.location_lat and new.public_lng = new.location_lng and new.space_category <> 'commercial' then
    new.public_lat := new.public_lat + 0.0007; -- the grid hit the exact point: shift half a cell
  end if;
  return new;
end $$;
drop trigger if exists parking_spaces_privacy_point on parking_spaces;
create trigger parking_spaces_privacy_point before insert or update of location_lat, location_lng, public_lat, public_lng, space_category, approval
  on parking_spaces for each row execute function public.parking_spaces_privacy_point();

create index if not exists parking_spaces_host_idx on parking_spaces (host_id) where host_id is not null;
create index if not exists parking_spaces_metro_idx on parking_spaces (metro_station_code) where metro_station_code is not null;

-- ─── 2. parking_bookings: integer-halalas split, buffers, payments, lifecycle ───
alter table parking_bookings drop constraint if exists parking_bookings_hours_check;
alter table parking_bookings add constraint parking_bookings_hours_check check (hours between 1 and 720); -- 30 days

alter table parking_bookings
  add column if not exists base_fare_halalas            integer check (base_fare_halalas >= 0),
  add column if not exists driver_fee_halalas           integer check (driver_fee_halalas >= 0),
  add column if not exists host_commission_halalas      integer check (host_commission_halalas >= 0),
  add column if not exists vat_on_platform_fee_halalas  integer check (vat_on_platform_fee_halalas >= 0),
  add column if not exists keys_discount_halalas        integer check (keys_discount_halalas >= 0),
  add column if not exists host_net_payout_halalas      integer check (host_net_payout_halalas >= 0),
  add column if not exists driver_total_halalas         integer check (driver_total_halalas >= 0),
  add column if not exists buffer_minutes               integer not null default 0 check (buffer_minutes between 0 and 120),
  add column if not exists payment_status               text not null default 'simulated'
    check (payment_status in ('simulated', 'pending', 'paid', 'failed', 'refunded')),
  add column if not exists psp_reference                text,
  add column if not exists arrived_at                   timestamptz,
  add column if not exists departed_at                  timestamptz,
  add column if not exists overstay_surcharge_halalas   integer not null default 0 check (overstay_surcharge_halalas >= 0);

create unique index if not exists parking_bookings_psp_ref_uq on parking_bookings (psp_reference) where psp_reference is not null;

-- The RAKNA KEYS value firewall, enforced on every row:
--  • the fare columns are all-or-nothing;
--  • the host's payout is ALWAYS base − commission (Keys never reduce it);
--  • the Keys discount is at most 20% of the platform fee (driver fee + host commission);
--  • the driver pays base + driver fee + VAT − Keys.
alter table parking_bookings drop constraint if exists parking_bookings_fare_chk;
alter table parking_bookings add constraint parking_bookings_fare_chk check (
  (base_fare_halalas is null and driver_fee_halalas is null and host_commission_halalas is null and vat_on_platform_fee_halalas is null
     and keys_discount_halalas is null and host_net_payout_halalas is null and driver_total_halalas is null)
  or (
    base_fare_halalas is not null and driver_fee_halalas is not null and host_commission_halalas is not null and vat_on_platform_fee_halalas is not null
    and keys_discount_halalas is not null and host_net_payout_halalas is not null and driver_total_halalas is not null
    and host_net_payout_halalas = base_fare_halalas - host_commission_halalas
    and keys_discount_halalas * 5 <= driver_fee_halalas + host_commission_halalas
    and driver_total_halalas = base_fare_halalas + driver_fee_halalas + vat_on_platform_fee_halalas - keys_discount_halalas
  )
);

-- ─── 3. Weekly availability rules (compact: one row per rule, never per slot) ───
create table if not exists space_availability_rules (
  id                      uuid primary key default gen_random_uuid(),
  space_id                uuid not null references parking_spaces (id) on delete cascade,
  weekday_mask            smallint not null check (weekday_mask between 1 and 127), -- bit 0 = Sunday … bit 6 = Saturday
  start_minute            smallint not null check (start_minute between 0 and 1439), -- Riyadh local
  end_minute              smallint not null check (end_minute between 1 and 1440),
  hourly_rate_halalas     integer not null check (hourly_rate_halalas between 1 and 100000),
  daily_cap_halalas       integer check (daily_cap_halalas > 0),
  multi_day_discount_bps  integer not null default 0 check (multi_day_discount_bps between 0 and 5000),
  is_active               boolean not null default true,
  created_at              timestamptz not null default now(),
  check (end_minute > start_minute)
);
create index if not exists space_availability_rules_space_idx on space_availability_rules (space_id) where is_active;

create table if not exists space_availability_exceptions (
  id                     uuid primary key default gen_random_uuid(),
  space_id               uuid not null references parking_spaces (id) on delete cascade,
  exception_date         date not null, -- Riyadh local date
  is_blocked             boolean not null,
  override_start_minute  smallint check (override_start_minute between 0 and 1439),
  override_end_minute    smallint check (override_end_minute between 1 and 1440),
  created_at             timestamptz not null default now(),
  unique (space_id, exception_date),
  check (
    (is_blocked and override_start_minute is null and override_end_minute is null)
    or (not is_blocked and override_start_minute is not null and override_end_minute is not null and override_end_minute > override_start_minute)
  )
);

-- ─── 4. Access credentials (PIN / QR token / guard code) ───────────────
create table if not exists booking_access_credentials (
  booking_id       uuid primary key references parking_bookings (id) on delete cascade,
  credential_type  text not null check (credential_type in ('pin', 'qr_token', 'guard_code')),
  secret_payload   text not null check (char_length(secret_payload) between 4 and 128),
  valid_from       timestamptz not null,
  valid_until      timestamptz not null,
  revoked_at       timestamptz,
  created_at       timestamptz not null default now(),
  check (valid_until > valid_from)
);

-- ─── 5. Booking lifecycle events (arrival, extension, departure, incidents) ───
create table if not exists booking_events (
  id             uuid primary key default gen_random_uuid(),
  booking_id     uuid not null references parking_bookings (id) on delete cascade,
  actor_id       uuid not null references profiles (id) on delete restrict,
  event_type     text not null check (event_type in ('arrived', 'extended', 'departed', 'overstay_flagged', 'bay_blocked_reported')),
  -- Approximate (~150 m) point only — never a precise trail of the driver.
  location_lat   double precision check (location_lat between -90 and 90),
  location_lng   double precision check (location_lng between -180 and 180),
  evidence_note  text check (char_length(evidence_note) <= 500),
  created_at     timestamptz not null default now()
);
create index if not exists booking_events_booking_idx on booking_events (booking_id, created_at);

-- ─── 6. Shared rate limiter (one counter per key and fixed window) ─────
create table if not exists rate_limits (
  key           text not null check (char_length(key) <= 200),
  window_start  timestamptz not null,
  count         integer not null default 0,
  primary key (key, window_start)
);

-- ─── 7. Row Level Security ─────────────────────────────────────────────
alter table space_availability_rules      enable row level security;
alter table space_availability_exceptions enable row level security;
alter table booking_access_credentials    enable row level security;
alter table booking_events                enable row level security;
alter table rate_limits                   enable row level security;

-- Every mutation goes through the server (service role). Clients read only.
revoke insert, update, delete on space_availability_rules, space_availability_exceptions, booking_access_credentials, booking_events from anon, authenticated;
revoke all on rate_limits from anon, authenticated;
revoke all on booking_access_credentials from anon;

create or replace function public.can_manage_space(p_space_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from parking_spaces s left join parking_partners p on p.id = s.partner_id
     where s.id = p_space_id and (s.host_id = auth.uid() or p.owner_id = auth.uid())
  );
$$;

-- Spaces: exact coordinates/address of RESIDENTIAL spaces are visible only to the host and
-- admins. Everyone else reads parking_spaces_public (privacy point, no address).
drop policy if exists spaces_select on parking_spaces;
create policy spaces_select on parking_spaces for select using (
  (approval = 'approved' and verification_status = 'verified' and space_category = 'commercial')
  or public.is_admin()
  or host_id = auth.uid()
  or exists (select 1 from parking_partners p where p.id = partner_id and p.owner_id = auth.uid())
);

create or replace view parking_spaces_public with (security_invoker = false) as
select id, partner_id, title, title_ar, neighborhood,
       public_lat as location_lat, public_lng as location_lng,
       case when space_category = 'commercial' then address else '' end as address,
       case when space_category = 'commercial' then address_ar else '' end as address_ar,
       capacity, price_per_hour, schedule, reward_eligible, accessible_bays,
       space_category, shade_tier, max_height_cm, max_width_cm, max_length_cm, buffer_minutes,
       instant_book, access_mode, metro_station_code, waitlist_only, is_demo, created_at
  from parking_spaces
 where approval = 'approved' and verification_status = 'verified';
revoke all on parking_spaces_public from anon, authenticated;
grant select on parking_spaces_public to anon, authenticated;

-- Pricing/hours of listed spaces are public (the row itself stays private for residential).
create or replace function public.space_is_listed(p_space_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from parking_spaces s where s.id = p_space_id and s.approval = 'approved' and s.verification_status = 'verified');
$$;
create policy rules_select on space_availability_rules for select using (
  public.is_admin() or public.can_manage_space(space_id) or public.space_is_listed(space_id)
);
create policy exceptions_select on space_availability_exceptions for select using (
  public.is_admin() or public.can_manage_space(space_id) or public.space_is_listed(space_id)
);

-- A residential host's partner record carries their display name: never public.
drop policy if exists partners_select on parking_partners;
create policy partners_select on parking_partners for select using (
  owner_id = auth.uid() or public.is_admin() or (status = 'approved' and kind <> 'residential')
);

-- Hosts see bookings on their spaces (times and status; driver identity is not in the row
-- beyond user_id, and profiles RLS hides the driver's profile).
drop policy if exists bookings_select_host on parking_bookings;
create policy bookings_select_host on parking_bookings for select using (
  exists (select 1 from parking_spaces s where s.id = space_id and s.host_id = auth.uid())
);

-- Credentials (strict): the guest of a CONFIRMED, PAID (or simulated) booking, only inside
-- the credential's active window and while not revoked; the space's host; admins.
create policy credentials_select on booking_access_credentials for select using (
  public.is_admin()
  or exists (
    select 1 from parking_bookings b
     where b.id = booking_id and b.user_id = auth.uid() and b.status = 'confirmed'
       and b.payment_status in ('simulated', 'paid')
       and revoked_at is null and now() >= valid_from and now() <= valid_until
  )
  or exists (
    select 1 from parking_bookings b join parking_spaces s on s.id = b.space_id
     where b.id = booking_id and s.host_id = auth.uid()
  )
);

create policy booking_events_select on booking_events for select using (
  public.is_admin()
  or exists (select 1 from parking_bookings b where b.id = booking_id and (b.user_id = auth.uid() or public.can_manage_space(b.space_id)))
);

-- ─── 8. Platform settings (municipal sandbox switch for villa bookings) ───
insert into app_config (key, value) values ('platform_settings', '{"villaBookingsEnabled": false}')
  on conflict (key) do nothing;

create or replace function public.set_platform_settings(p_value jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_villa boolean := coalesce((p_value ->> 'villaBookingsEnabled')::boolean, false);
begin
  insert into app_config (key, value) values ('platform_settings', p_value)
    on conflict (key) do update set value = excluded.value;
  -- Same transaction: villa spaces become bookable / return to the waitlist together.
  update parking_spaces set waitlist_only = not v_villa where space_category like 'villa\_%' and waitlist_only = v_villa;
  return p_value;
end $$;
revoke execute on function public.set_platform_settings(jsonb) from public, anon, authenticated;

-- Villa spaces onboard as waitlist-only while the switch is off (also for direct inserts).
create or replace function public.parking_spaces_villa_waitlist() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.space_category like 'villa\_%' then
    new.waitlist_only := not coalesce((select (value ->> 'villaBookingsEnabled')::boolean from app_config where key = 'platform_settings'), false);
  end if;
  return new;
end $$;
drop trigger if exists parking_spaces_villa_waitlist on parking_spaces;
create trigger parking_spaces_villa_waitlist before insert on parking_spaces
  for each row execute function public.parking_spaces_villa_waitlist();

-- ─── 9. Availability rules: replace the whole weekly set in one transaction ───
create or replace function public.replace_availability_rules(p_space_id uuid, p_rules jsonb)
returns setof space_availability_rules
language plpgsql security definer set search_path = public as $$
begin
  if jsonb_typeof(p_rules) <> 'array' or jsonb_array_length(p_rules) not between 1 and 14 then
    raise exception 'rules must be an array of 1–14 items' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('space:' || p_space_id::text, 0));
  delete from space_availability_rules where space_id = p_space_id;
  return query
    insert into space_availability_rules (id, space_id, weekday_mask, start_minute, end_minute, hourly_rate_halalas, daily_cap_halalas, multi_day_discount_bps, is_active, created_at)
    select coalesce(r.id, gen_random_uuid()), p_space_id, r.weekday_mask, r.start_minute, r.end_minute, r.hourly_rate_halalas,
           r.daily_cap_halalas, coalesce(r.multi_day_discount_bps, 0), coalesce(r.is_active, true), coalesce(r.created_at, now())
      from jsonb_populate_recordset(null::space_availability_rules, p_rules) r
    returning *;
end $$;
revoke execute on function public.replace_availability_rules(uuid, jsonb) from public, anon, authenticated;

-- ─── 10. Credential generation (fallback when the app did not supply one) ───
create or replace function public.rakna_generate_secret(p_type text) returns text
language plpgsql volatile set search_path = public as $$
declare v text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
begin
  if p_type = 'pin' then
    return lpad(((('x' || substr(v, 1, 8))::bit(32)::bigint) % 1000000)::text, 6, '0');
  elsif p_type = 'guard_code' then
    return upper(translate(substr(v, 1, 8), '01', 'XY'));
  end if;
  return substr(v, 1, 32); -- qr_token: 128 random bits as hex
end $$;
revoke execute on function public.rakna_generate_secret(text) from public, anon, authenticated;

-- ─── 11. insert_booking_checked(): buffers, integer halalas, credentials ───
-- Count of confirmed bookings on the space that overlap [start − buffer, end + buffer).
create or replace function public.rakna_padded_overlaps(p_space_id uuid, p_start timestamptz, p_end timestamptz, p_buffer_minutes integer, p_exclude uuid)
returns integer language sql stable security definer set search_path = public as $$
  select count(*)::int from parking_bookings
   where space_id = p_space_id and status = 'confirmed' and (p_exclude is null or id <> p_exclude)
     and start_at < p_end + make_interval(mins => p_buffer_minutes)
     and p_start - make_interval(mins => p_buffer_minutes) < end_at;
$$;
revoke execute on function public.rakna_padded_overlaps(uuid, timestamptz, timestamptz, integer, uuid) from public, anon, authenticated;

-- Legacy (commercial SAR) path: same signature as 0005, now also honours the space's buffer.
create or replace function public.insert_booking_checked(
  p_id uuid, p_space_id uuid, p_user_id uuid, p_start timestamptz, p_end timestamptz, p_hours integer,
  p_price numeric, p_discount numeric, p_redemption_id uuid, p_capacity integer
) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_buffer int;
begin
  perform pg_advisory_xact_lock(hashtextextended('space:' || p_space_id::text, 0));
  select buffer_minutes into v_buffer from parking_spaces where id = p_space_id;
  if public.rakna_padded_overlaps(p_space_id, p_start, p_end, coalesce(v_buffer, 0), null) >= p_capacity then return false; end if;
  insert into parking_bookings (id, space_id, user_id, start_at, end_at, hours, price_total, discount_applied, redemption_id, status, simulated_payment, buffer_minutes)
  values (p_id, p_space_id, p_user_id, p_start, p_end, p_hours, p_price, p_discount, p_redemption_id, 'confirmed', true, coalesce(v_buffer, 0));
  return true;
end $$;
revoke execute on function public.insert_booking_checked(uuid, uuid, uuid, timestamptz, timestamptz, integer, numeric, numeric, uuid, integer) from public, anon, authenticated;

-- Schedule (RAKNA HOME / PARTNERS) path: ONE atomic step under the per-space advisory lock —
-- bookability re-check, padded capacity check, booking insert, credential insert.
-- Returns 'ok' or 'capacity_full'; raises for a space that is not bookable.
create or replace function public.insert_booking_checked(
  p_booking jsonb, p_capacity integer, p_buffer_minutes integer default 0, p_credential jsonb default null
) returns text
language plpgsql security definer set search_path = public as $$
declare
  b parking_bookings;
  s parking_spaces;
  v_buffer int;
  v_capacity int;
  v_type text;
begin
  b := jsonb_populate_record(null::parking_bookings, p_booking);
  if b.id is null or b.space_id is null or b.user_id is null or b.start_at is null or b.end_at is null then
    raise exception 'booking id, space, user and window are required' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('space:' || b.space_id::text, 0));
  select * into s from parking_spaces where id = b.space_id;
  if not found then raise exception 'space_not_found' using errcode = 'P0002'; end if;
  if s.approval <> 'approved' or s.verification_status <> 'verified' or s.waitlist_only then
    raise exception 'space_not_bookable' using errcode = 'P0001';
  end if;
  if s.host_id is not null and s.host_id = b.user_id then
    raise exception 'cannot_book_own_space' using errcode = 'P0001';
  end if;
  -- The database is authoritative: the larger buffer and the smaller capacity win.
  v_buffer := greatest(coalesce(p_buffer_minutes, 0), s.buffer_minutes);
  v_capacity := least(coalesce(p_capacity, s.capacity), s.capacity);
  if public.rakna_padded_overlaps(b.space_id, b.start_at, b.end_at, v_buffer, null) >= v_capacity then
    return 'capacity_full';
  end if;

  insert into parking_bookings (
    id, space_id, user_id, start_at, end_at, hours, price_total, discount_applied, redemption_id, status, simulated_payment, created_at,
    base_fare_halalas, driver_fee_halalas, host_commission_halalas, vat_on_platform_fee_halalas, keys_discount_halalas,
    host_net_payout_halalas, driver_total_halalas, buffer_minutes, payment_status, psp_reference, overstay_surcharge_halalas
  ) values (
    b.id, b.space_id, b.user_id, b.start_at, b.end_at, b.hours, b.price_total, coalesce(b.discount_applied, 0), b.redemption_id,
    'confirmed', true, coalesce(b.created_at, now()),
    b.base_fare_halalas, b.driver_fee_halalas, b.host_commission_halalas, b.vat_on_platform_fee_halalas, b.keys_discount_halalas,
    b.host_net_payout_halalas, b.driver_total_halalas, v_buffer, coalesce(b.payment_status, 'simulated'), b.psp_reference, 0
  );

  -- Ephemeral access credential: the app's (cryptographically random) one, or auto-provisioned.
  v_type := case s.access_mode when 'ephemeral_pin' then 'pin' when 'dynamic_qr' then 'qr_token' when 'guard_pass' then 'guard_code' else null end;
  if p_credential is not null then
    insert into booking_access_credentials (booking_id, credential_type, secret_payload, valid_from, valid_until)
    values (b.id, p_credential ->> 'credential_type', p_credential ->> 'secret_payload',
            (p_credential ->> 'valid_from')::timestamptz, (p_credential ->> 'valid_until')::timestamptz);
  elsif v_type is not null then
    insert into booking_access_credentials (booking_id, credential_type, secret_payload, valid_from, valid_until)
    values (b.id, v_type, public.rakna_generate_secret(v_type), b.start_at - interval '10 minutes', b.end_at + interval '15 minutes');
  end if;
  return 'ok';
end $$;
revoke execute on function public.insert_booking_checked(jsonb, integer, integer, jsonb) from public, anon, authenticated;

-- Extension: re-check the padded window [start, new_end) against OTHER bookings, then update
-- the end, the fare columns and the credential's validity in the same transaction.
create or replace function public.extend_booking_checked(
  p_id uuid, p_new_end timestamptz, p_patch jsonb, p_capacity integer, p_buffer_minutes integer, p_credential_valid_until timestamptz
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  b parking_bookings;
  s parking_spaces;
  p parking_bookings;
  v_buffer int;
begin
  select * into b from parking_bookings where id = p_id;
  if not found or b.status <> 'confirmed' or p_new_end <= b.end_at then return null; end if;
  perform pg_advisory_xact_lock(hashtextextended('space:' || b.space_id::text, 0));
  select * into b from parking_bookings where id = p_id; -- re-read under the lock
  if b.status <> 'confirmed' then return null; end if;
  select * into s from parking_spaces where id = b.space_id;
  v_buffer := greatest(coalesce(p_buffer_minutes, 0), s.buffer_minutes);
  if public.rakna_padded_overlaps(b.space_id, b.start_at, p_new_end, v_buffer, b.id) >= least(coalesce(p_capacity, s.capacity), s.capacity) then
    return null;
  end if;
  p := jsonb_populate_record(b, p_patch); -- patch fields over the current row
  update parking_bookings set
    end_at = p_new_end,
    hours = p.hours, price_total = p.price_total, discount_applied = p.discount_applied,
    base_fare_halalas = p.base_fare_halalas, driver_fee_halalas = p.driver_fee_halalas, host_commission_halalas = p.host_commission_halalas,
    vat_on_platform_fee_halalas = p.vat_on_platform_fee_halalas, keys_discount_halalas = p.keys_discount_halalas,
    host_net_payout_halalas = p.host_net_payout_halalas, driver_total_halalas = p.driver_total_halalas
   where id = p_id
   returning * into b;
  update booking_access_credentials set valid_until = p_credential_valid_until where booking_id = p_id and revoked_at is null;
  return to_jsonb(b);
end $$;
revoke execute on function public.extend_booking_checked(uuid, timestamptz, jsonb, integer, integer, timestamptz) from public, anon, authenticated;

-- ─── 12. check_rate_limit(): shared fixed-window limiter (blocker B2) ───
create or replace function public.check_rate_limit(p_key text, p_limit integer, p_window_seconds integer, p_now timestamptz default now())
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_window timestamptz := to_timestamp(floor(extract(epoch from p_now) / p_window_seconds) * p_window_seconds);
  v_count int;
begin
  if p_window_seconds < 1 or p_limit < 1 then raise exception 'invalid limiter' using errcode = '22023'; end if;
  insert into rate_limits as r (key, window_start, count) values (p_key, v_window, 1)
    on conflict (key, window_start) do update set count = r.count + 1
    returning r.count into v_count;
  -- Bounded table: occasionally drop windows older than a day.
  if random() < 0.01 then delete from rate_limits where window_start < p_now - interval '1 day'; end if;
  return v_count <= p_limit;
end $$;
revoke execute on function public.check_rate_limit(text, integer, integer, timestamptz) from public, anon, authenticated;

-- ─── 13. hive_viewport(): reports, spaces, stats and demand in ONE round trip ───
-- Server-only (exact coordinates leave the database only to the service role; the API
-- coarsens them). Cell filters use the denormalized h3_r* columns (indexed equality).
create or replace function public.hive_viewport(
  p_report_res integer, p_report_cells text[], p_statuses text[], p_report_limit integer,
  p_space_res integer, p_space_cells text[], p_stat_res integer, p_stat_cells text[], p_since timestamptz,
  p_demand_cells text[] default null
) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'reports', coalesce((
      select jsonb_agg(to_jsonb(r) - 'geog') from (
        select * from departure_reports d
         where d.status::text = any(p_statuses)
           and ((p_report_res = 7 and d.h3_r7 = any(p_report_cells)) or (p_report_res = 8 and d.h3_r8 = any(p_report_cells))
             or (p_report_res = 9 and d.h3_r9 = any(p_report_cells)) or (p_report_res = 10 and d.h3_r10 = any(p_report_cells)))
         order by d.created_at desc
         limit greatest(1, least(coalesce(p_report_limit, 500), 2000))
      ) r), '[]'::jsonb),
    'spaces', coalesce((
      select jsonb_agg(to_jsonb(s) - 'geog') from parking_spaces s
       where (p_space_res = 7 and s.h3_r7 = any(p_space_cells)) or (p_space_res = 8 and s.h3_r8 = any(p_space_cells))
          or (p_space_res = 9 and s.h3_r9 = any(p_space_cells)) or (p_space_res = 10 and s.h3_r10 = any(p_space_cells))), '[]'::jsonb),
    'cell_stats', coalesce((
      select jsonb_agg(jsonb_build_object('cell', c.h3_r10, 'bucket_start', c.bucket_start, 'reports', c.reports, 'found', c.found,
                                          'not_found', c.not_found, 'expired', c.expired, 'is_demo', c.is_demo))
        from hive_cell_stats c
       where c.bucket_start >= p_since
         and ((p_stat_res = 7 and c.h3_r7 = any(p_stat_cells)) or (p_stat_res = 8 and c.h3_r8 = any(p_stat_cells))
           or (p_stat_res = 9 and c.h3_r9 = any(p_stat_cells)) or (p_stat_res = 10 and c.h3_r10 = any(p_stat_cells)))), '[]'::jsonb),
    'demand', coalesce((
      -- Demand is stored at r9: resolutions ≥ 9 match on h3_r9 (the caller passes r9 parents).
      select jsonb_agg(jsonb_build_object('cell', m.h3_r9, 'bucket_start', m.bucket_start, 'searches', m.searches, 'is_demo', m.is_demo))
        from hive_demand_buckets m
       where m.bucket_start >= p_since
         and ((p_stat_res = 7 and m.h3_r7 = any(coalesce(p_demand_cells, p_stat_cells)))
           or (p_stat_res = 8 and m.h3_r8 = any(coalesce(p_demand_cells, p_stat_cells)))
           or (p_stat_res >= 9 and m.h3_r9 = any(coalesce(p_demand_cells, p_stat_cells))))), '[]'::jsonb)
  );
$$;
revoke execute on function public.hive_viewport(integer, text[], text[], integer, integer, text[], integer, text[], timestamptz, text[]) from public, anon, authenticated;

-- ─── 14. Account deletion also revokes live access credentials ─────────
create or replace function public.anonymize_profile(p_user_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_reports int; v_claims int; v_conf int; v_creds int;
begin
  delete from report_confirmations where confirmer_id = p_user_id;
  get diagnostics v_conf = row_count;
  delete from report_claims where claimer_id = p_user_id;
  get diagnostics v_claims = row_count;
  delete from departure_reports where reporter_id = p_user_id and status not in ('flagged');
  get diagnostics v_reports = row_count;
  delete from challenge_progress where user_id = p_user_id;
  delete from mobility_missions where user_id = p_user_id;
  update booking_access_credentials set revoked_at = now()
   where revoked_at is null and booking_id in (select id from parking_bookings where user_id = p_user_id);
  get diagnostics v_creds = row_count;
  update booking_events set location_lat = null, location_lng = null where actor_id = p_user_id;
  update profiles set display_name = 'Deleted user', display_name_ar = 'مستخدم محذوف', neighborhood = 'olaya',
         location_consent_at = null, deleted_at = now()
   where id = p_user_id;
  return jsonb_build_object('reports_deleted', v_reports, 'claims_deleted', v_claims, 'confirmations_deleted', v_conf, 'credentials_revoked', v_creds);
end $$;
revoke execute on function public.anonymize_profile(uuid) from public, anon, authenticated;

-- Helper functions that read RLS-protected data are server/RLS-only.
revoke execute on function public.can_manage_space(uuid) from public, anon;
grant execute on function public.can_manage_space(uuid) to authenticated;
