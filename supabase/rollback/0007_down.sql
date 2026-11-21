-- Rollback for 0007_rakna_home_phase3.sql — USE ONLY IF 0007 BREAKS STAGING. Prefer roll-forward.
-- WARNING: this DELETES Phase 3 data (availability rules/exceptions, access credentials,
-- booking events, rate-limit counters) and every RAKNA HOME (residential) space and its
-- bookings. Take a backup first:  pg_dump --data-only -t 'space_*' -t 'booking_*' -t parking_spaces -t parking_bookings
-- Commercial spaces and legacy SAR bookings are preserved.

begin;

-- Functions (Phase 3 overloads / new RPCs)
drop function if exists public.hive_viewport(integer, text[], text[], integer, integer, text[], integer, text[], timestamptz, text[]);
drop function if exists public.check_rate_limit(text, integer, integer, timestamptz);
drop function if exists public.extend_booking_checked(uuid, timestamptz, jsonb, integer, integer, timestamptz);
drop function if exists public.insert_booking_checked(jsonb, integer, integer, jsonb);
drop function if exists public.replace_availability_rules(uuid, jsonb);
drop function if exists public.set_platform_settings(jsonb);
drop function if exists public.rakna_generate_secret(text);

-- Restore the 0005 legacy booking function (no buffer).
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
drop function if exists public.rakna_padded_overlaps(uuid, timestamptz, timestamptz, integer, uuid);

-- Restore the 0005 anonymize_profile (without credential revocation).
create or replace function public.anonymize_profile(p_user_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_reports int; v_claims int; v_conf int;
begin
  delete from report_confirmations where confirmer_id = p_user_id;
  get diagnostics v_conf = row_count;
  delete from report_claims where claimer_id = p_user_id;
  get diagnostics v_claims = row_count;
  delete from departure_reports where reporter_id = p_user_id and status not in ('flagged');
  get diagnostics v_reports = row_count;
  delete from challenge_progress where user_id = p_user_id;
  delete from mobility_missions where user_id = p_user_id;
  update profiles set display_name = 'Deleted user', display_name_ar = 'مستخدم محذوف', neighborhood = 'olaya',
         location_consent_at = null, deleted_at = now()
   where id = p_user_id;
  return jsonb_build_object('reports_deleted', v_reports, 'claims_deleted', v_claims, 'confirmations_deleted', v_conf);
end $$;
revoke execute on function public.anonymize_profile(uuid) from public, anon, authenticated;

-- Policies and views
drop view if exists parking_spaces_public;
drop policy if exists bookings_select_host on parking_bookings;
drop policy if exists spaces_select on parking_spaces;
create policy spaces_select on parking_spaces for select using (
  approval = 'approved'
  or public.is_admin()
  or exists (select 1 from parking_partners p where p.id = partner_id and p.owner_id = auth.uid())
);
drop policy if exists partners_select on parking_partners;
create policy partners_select on parking_partners for select using (owner_id = auth.uid() or public.is_admin() or status = 'approved');

-- Tables
drop table if exists booking_events;
drop table if exists booking_access_credentials;
drop table if exists space_availability_exceptions;
drop table if exists space_availability_rules;
drop table if exists rate_limits;
drop function if exists public.space_is_listed(uuid);
drop function if exists public.can_manage_space(uuid);

-- Residential spaces cannot exist without the Phase 3 columns.
delete from reward_redemptions where booking_id in (select b.id from parking_bookings b join parking_spaces s on s.id = b.space_id where s.space_category <> 'commercial');
delete from parking_bookings where space_id in (select id from parking_spaces where space_category <> 'commercial');
delete from parking_spaces where space_category <> 'commercial';
delete from parking_bookings where hours > 12;

-- Triggers and columns
drop trigger if exists parking_spaces_villa_waitlist on parking_spaces;
drop trigger if exists parking_spaces_privacy_point on parking_spaces;
drop function if exists public.parking_spaces_villa_waitlist();
drop function if exists public.parking_spaces_privacy_point();

alter table parking_bookings drop constraint if exists parking_bookings_fare_chk;
drop index if exists parking_bookings_psp_ref_uq;
alter table parking_bookings
  drop column if exists base_fare_halalas, drop column if exists driver_fee_halalas, drop column if exists host_commission_halalas,
  drop column if exists vat_on_platform_fee_halalas, drop column if exists keys_discount_halalas, drop column if exists host_net_payout_halalas,
  drop column if exists driver_total_halalas, drop column if exists buffer_minutes, drop column if exists payment_status,
  drop column if exists psp_reference, drop column if exists arrived_at, drop column if exists departed_at, drop column if exists overstay_surcharge_halalas;
alter table parking_bookings drop constraint if exists parking_bookings_hours_check;
alter table parking_bookings add constraint parking_bookings_hours_check check (hours between 1 and 12);

alter table parking_spaces
  drop constraint if exists parking_spaces_entitlement_chk, drop constraint if exists parking_spaces_ejar_consent_chk,
  drop constraint if exists parking_spaces_residential_host_chk, drop constraint if exists parking_spaces_verified_approval_chk;
drop index if exists parking_spaces_host_idx;
drop index if exists parking_spaces_metro_idx;
alter table parking_spaces
  drop column if exists space_category, drop column if exists entitlement_type, drop column if exists verification_status,
  drop column if exists public_lat, drop column if exists public_lng, drop column if exists shade_tier,
  drop column if exists max_height_cm, drop column if exists max_width_cm, drop column if exists max_length_cm,
  drop column if exists buffer_minutes, drop column if exists instant_book, drop column if exists access_mode,
  drop column if exists metro_station_code, drop column if exists waitlist_only, drop column if exists host_id,
  drop column if exists landlord_consent_at;

delete from app_config where key = 'platform_settings';

commit;
