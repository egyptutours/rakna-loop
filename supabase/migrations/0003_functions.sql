-- ════════════════════════════════════════════════════════════════════
-- RAKNA LOOP — atomic server-side functions (called by the API with the
-- service role; EXECUTE revoked from client roles).
-- ════════════════════════════════════════════════════════════════════

-- Atomic, idempotent ledger insert with a non-negative balance guarantee.
--  * Serializes per user with a transaction-scoped advisory lock.
--  * Returns the existing row (inserted = false) if the idempotency key exists.
--  * Raises if a debit would make the balance negative.
create or replace function public.insert_ledger_entry(
  p_id uuid, p_user_id uuid, p_amount integer, p_type ledger_type, p_reason text,
  p_idempotency_key text, p_ref_type text, p_ref_id uuid
) returns table (
  inserted boolean, id uuid, user_id uuid, amount integer, type ledger_type, reason text,
  idempotency_key text, ref_type text, ref_id uuid, created_at timestamptz
)
language plpgsql security definer set search_path = public as $$
declare
  v_balance integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('ledger:' || p_user_id::text, 0));

  return query select false, l.id, l.user_id, l.amount, l.type, l.reason, l.idempotency_key, l.ref_type, l.ref_id, l.created_at
    from points_ledger l where l.idempotency_key = p_idempotency_key;
  if found then return; end if;

  if p_amount < 0 then
    select coalesce(sum(l.amount), 0) into v_balance from points_ledger l where l.user_id = p_user_id;
    if v_balance + p_amount < 0 then
      raise exception 'insufficient_balance' using errcode = 'P0001';
    end if;
  end if;

  return query insert into points_ledger as l (id, user_id, amount, type, reason, idempotency_key, ref_type, ref_id)
    values (p_id, p_user_id, p_amount, p_type, p_reason, p_idempotency_key, p_ref_type, p_ref_id)
    returning true, l.id, l.user_id, l.amount, l.type, l.reason, l.idempotency_key, l.ref_type, l.ref_id, l.created_at;
end $$;

-- Derived balance (for reporting / admin views).
create or replace function public.keys_balance(p_user_id uuid) returns integer
language sql stable security definer set search_path = public as $$
  select coalesce(sum(amount), 0)::integer from points_ledger where user_id = p_user_id;
$$;

-- Best-effort named lock used by the adapter's withLock (transaction-scoped).
create or replace function public.rakna_try_lock(lock_key text) returns boolean
language sql security definer set search_path = public as $$
  select pg_try_advisory_xact_lock(hashtextextended(lock_key, 0));
$$;

-- Privacy retention: coarsen precise coordinates of closed records older than p_before.
create or replace function public.purge_precise_locations(p_before timestamptz) returns integer
language plpgsql security definer set search_path = public as $$
declare n integer := 0; m integer;
begin
  update departure_reports
     set location_lat = round(location_lat::numeric, 2), location_lng = round(location_lng::numeric, 2),
         claim_location_lat = null, claim_location_lng = null
   where created_at < p_before and status not in ('pending_departure', 'available', 'claimed')
     and (claim_location_lat is not null or location_lat <> round(location_lat::numeric, 2));
  get diagnostics m = row_count; n := n + m;
  update report_confirmations set location_lat = null, location_lng = null where created_at < p_before and location_lat is not null;
  get diagnostics m = row_count; n := n + m;
  update report_claims set claim_location_lat = null, claim_location_lng = null where created_at < p_before and claim_location_lat is not null;
  get diagnostics m = row_count; n := n + m;
  return n;
end $$;

-- Create a driver profile automatically for each new auth user (role always 'driver';
-- partner/admin roles are granted by an admin, never self-assigned).
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, display_name, display_name_ar, role)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'display_name', 'Driver'), coalesce(new.raw_user_meta_data ->> 'display_name', 'سائق'), 'driver')
  on conflict (id) do nothing;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

revoke execute on function public.insert_ledger_entry(uuid, uuid, integer, ledger_type, text, text, text, uuid) from public, anon, authenticated;
revoke execute on function public.rakna_try_lock(text) from public, anon, authenticated;
revoke execute on function public.purge_precise_locations(timestamptz) from public, anon, authenticated;
grant execute on function public.keys_balance(uuid) to authenticated;

-- Schedule retention (requires the pg_cron extension in Supabase):
-- select cron.schedule('rakna-purge-locations', '15 * * * *', $$select public.purge_precise_locations(now() - interval '24 hours')$$);
