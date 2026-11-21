-- ════════════════════════════════════════════════════════════════════
-- RAKNA LOOP — Row Level Security
-- Principle: clients (anon / authenticated keys) can READ only what they
-- are entitled to and can WRITE almost nothing directly. All business
-- mutations (reports, claims, confirmations, rewards, bookings) go through
-- the Next.js API routes, which use the service role after authenticating
-- the user and enforcing the domain rules. The service role bypasses RLS.
-- ════════════════════════════════════════════════════════════════════

-- Helpers (SECURITY DEFINER so they can read profiles regardless of caller RLS).
create or replace function public.current_role_is(r app_role) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and role = r);
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select public.current_role_is('admin');
$$;

alter table profiles               enable row level security;
alter table parking_partners       enable row level security;
alter table parking_spaces         enable row level security;
alter table departure_reports      enable row level security;
alter table report_claims          enable row level security;
alter table report_confirmations   enable row level security;
alter table points_ledger          enable row level security;
alter table rewards_catalog        enable row level security;
alter table reward_redemptions     enable row level security;
alter table parking_bookings       enable row level security;
alter table neighborhood_challenges enable row level security;
alter table challenge_progress     enable row level security;
alter table mobility_missions      enable row level security;
alter table fraud_flags            enable row level security;
alter table admin_audit_logs       enable row level security;
alter table app_config             enable row level security;

-- profiles: see/edit yourself (role and demo flag are NOT client-editable); admins see all.
create policy profiles_select_self on profiles for select using (id = auth.uid() or public.is_admin());
create policy profiles_update_self on profiles for update using (id = auth.uid())
  with check (id = auth.uid() and role = (select p.role from profiles p where p.id = auth.uid()) and is_demo = (select p.is_demo from profiles p where p.id = auth.uid()));

-- partners: owners see their own application; admins see all. Approved partner names are public via spaces.
create policy partners_select on parking_partners for select using (owner_id = auth.uid() or public.is_admin() or status = 'approved');

-- spaces: anyone signed in sees approved spaces; owners see their own (any state); admins see all.
create policy spaces_select on parking_spaces for select using (
  approval = 'approved'
  or public.is_admin()
  or exists (select 1 from parking_partners p where p.id = partner_id and p.owner_id = auth.uid())
);

-- departure_reports: PRECISE coordinates restricted to the reporter, the active claimer and admins.
-- Everyone else reads the coarsened departure_reports_public view (security_invoker → needs a policy):
create policy reports_select_participants on departure_reports for select using (
  reporter_id = auth.uid() or claimed_by = auth.uid() or public.is_admin()
);
-- The coarse public view (owner-rights, see 0001) is the only path for non-participants.
revoke all on departure_reports from anon, authenticated;
grant select on departure_reports to authenticated;          -- rows filtered by reports_select_participants
grant select on departure_reports_public to anon, authenticated;

-- claims / confirmations: participants and admins.
create policy claims_select on report_claims for select using (
  claimer_id = auth.uid() or public.is_admin()
  or exists (select 1 from departure_reports r where r.id = report_id and r.reporter_id = auth.uid())
);
create policy confirmations_select on report_confirmations for select using (
  confirmer_id = auth.uid() or public.is_admin()
  or exists (select 1 from departure_reports r where r.id = report_id and r.reporter_id = auth.uid())
);

-- points_ledger: read your own entries; NO client inserts/updates/deletes (no policy = denied).
create policy ledger_select_own on points_ledger for select using (user_id = auth.uid() or public.is_admin());
revoke insert, update, delete on points_ledger from anon, authenticated;

-- rewards catalog: active items readable by everyone.
create policy rewards_select on rewards_catalog for select using (active or public.is_admin());

-- redemptions / bookings / missions / progress: own rows; admins all; partners see bookings on their spaces.
create policy redemptions_select on reward_redemptions for select using (user_id = auth.uid() or public.is_admin());
create policy bookings_select on parking_bookings for select using (
  user_id = auth.uid() or public.is_admin()
  or exists (select 1 from parking_spaces s join parking_partners p on p.id = s.partner_id where s.id = space_id and p.owner_id = auth.uid())
);
create policy missions_select on mobility_missions for select using (user_id = auth.uid() or public.is_admin());
create policy progress_select on challenge_progress for select using (user_id = auth.uid() or public.is_admin());
create policy challenges_select on neighborhood_challenges for select using (active or public.is_admin());

-- trust & safety / audit / config: admins only (read). Writes only via service role.
create policy fraud_admin on fraud_flags for select using (public.is_admin());
create policy audit_admin on admin_audit_logs for select using (public.is_admin());
create policy config_read on app_config for select using (true);

-- Append-only guarantees, even for the service role (defence in depth).
create or replace function public.forbid_mutation() returns trigger language plpgsql as $$
begin
  raise exception '% is append-only', tg_table_name;
end $$;
create trigger points_ledger_append_only before update or delete on points_ledger for each row execute function public.forbid_mutation();
create trigger audit_append_only before update or delete on admin_audit_logs for each row execute function public.forbid_mutation();
