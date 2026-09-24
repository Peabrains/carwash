-- Booking security, customer lifecycle, and notifications.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create or replace function private.current_staff_context()
returns table (staff_id uuid, provider_id text, location_id text, role text, is_active boolean)
language sql
security definer
stable
set search_path = ''
as $$
  select s.id, s.provider_id, s.location_id, s.role, s.is_active
  from public.staff s
  where s.id = (select auth.uid())
  limit 1
$$;

revoke all on function private.current_staff_context() from public, anon;
grant usage on schema private to authenticated;
grant execute on function private.current_staff_context() to authenticated;

drop policy if exists staff_read_provider on public.staff;
create policy staff_read_provider on public.staff for select to authenticated
using (exists (
  select 1 from private.current_staff_context() me
  where me.is_active and (me.role = 'platform_owner' or me.provider_id = staff.provider_id)
));

drop policy if exists staff_invitations_read_scoped on public.staff_invitations;
create policy staff_invitations_read_scoped on public.staff_invitations for select to authenticated
using (exists (
  select 1 from private.current_staff_context() me
  where me.is_active and (me.role = 'platform_owner' or me.provider_id = staff_invitations.provider_id)
));

revoke all on function public.current_staff_context() from public, anon, authenticated;
drop function if exists public.current_staff_context();

-- Replace broad FOR ALL policies with operation-specific write policies so
-- SELECT evaluates only the dedicated read policy.
drop policy if exists locations_manage on public.locations;
drop policy if exists bays_manage_scoped on public.bays;
drop policy if exists closures_manage_scoped on public.bay_closures;
drop policy if exists breaks_manage_scoped on public.crew_break_schedule;
drop policy if exists services_manage_scoped on public.services;
drop policy if exists settings_manage_scoped on public.booking_settings;
drop policy if exists blackouts_manage_scoped on public.blackout_dates;
drop policy if exists appointments_manage_scoped on public.appointments;

do $$
declare
  item record;
  predicate text;
begin
  for item in select * from (values
    ('locations', 'provider_id', 'id'),
    ('bays', 'provider_id', 'location_id'),
    ('bay_closures', 'provider_id', 'location_id'),
    ('crew_break_schedule', 'provider_id', 'location_id'),
    ('services', 'provider_id', 'location_id'),
    ('booking_settings', 'provider_id', 'location_id'),
    ('blackout_dates', 'provider_id', 'location_id'),
    ('appointments', 'provider_id', 'location_id')
  ) as t(table_name, provider_column, location_column)
  loop
    predicate := format(
      'exists (select 1 from private.current_staff_context() me where me.is_active and me.role in (''platform_owner'', ''owner'', ''manager'') and (me.role = ''platform_owner'' or me.provider_id = %I.provider_id)%s)',
      item.table_name,
      case when item.table_name = 'locations'
        then ''
        else format(' and (me.location_id is null or me.location_id = %I.location_id)', item.table_name)
      end
    );
    execute format('drop policy if exists %I_insert_scoped on public.%I', item.table_name, item.table_name);
    execute format('drop policy if exists %I_update_scoped on public.%I', item.table_name, item.table_name);
    execute format('drop policy if exists %I_delete_scoped on public.%I', item.table_name, item.table_name);
    execute format('create policy %I_insert_scoped on public.%I for insert to authenticated with check (%s)', item.table_name, item.table_name, predicate);
    execute format('create policy %I_update_scoped on public.%I for update to authenticated using (%s) with check (%s)', item.table_name, item.table_name, predicate, predicate);
    execute format('create policy %I_delete_scoped on public.%I for delete to authenticated using (%s)', item.table_name, item.table_name, predicate);
  end loop;
end
$$;

-- Public SECURITY DEFINER wrappers retain explicit actor checks. Remove all
-- inherited/default execution first, then grant only the intended role.
alter function public.invite_staff_member(text, text, text, text, text, boolean) set search_path = '';
alter function public.accept_staff_invitation() set search_path = '';
alter function public.revoke_staff_access(uuid, uuid) set search_path = '';

revoke all on function public.invite_staff_member(text, text, text, text, text, boolean) from public, anon, authenticated;
revoke all on function public.accept_staff_invitation() from public, anon, authenticated;
revoke all on function public.revoke_staff_access(uuid, uuid) from public, anon, authenticated;
grant execute on function public.invite_staff_member(text, text, text, text, text, boolean) to authenticated;
grant execute on function public.accept_staff_invitation() to authenticated;
grant execute on function public.revoke_staff_access(uuid, uuid) to authenticated;

revoke all on function public.reserve_appointment_atomic(text, text, text, text, text, text, text, text, text, uuid, date, text, text) from public, anon, authenticated;
grant execute on function public.reserve_appointment_atomic(text, text, text, text, text, text, text, text, text, uuid, date, text, text) to service_role;

revoke all on function public.reschedule_appointment_atomic(uuid, date, text, uuid) from public, anon;
grant execute on function public.reschedule_appointment_atomic(uuid, date, text, uuid) to authenticated, service_role;

revoke all on function public.upsert_staff_member_by_email(text, text, text, text, text, boolean) from public, anon, authenticated;
drop function if exists public.upsert_staff_member_by_email(text, text, text, text, text, boolean);
