-- Provider-scoped RLS for Docket's multi-tenant Supabase database.

alter table providers enable row level security;
alter table locations enable row level security;
alter table booking_day_locks enable row level security;

drop policy if exists "staff can read own row" on staff;
drop policy if exists "owner full access to bays" on bays;
drop policy if exists "worker can view bays" on bays;
drop policy if exists "owner full access to bay_closures" on bay_closures;
drop policy if exists "owner full access to crew_break_schedule" on crew_break_schedule;
drop policy if exists "owner full access to services" on services;
drop policy if exists "worker can view services" on services;
drop policy if exists "owner full access to booking_settings" on booking_settings;
drop policy if exists "owner full access to blackout_dates" on blackout_dates;
drop policy if exists "staff can view appointments" on appointments;
drop policy if exists "owner can insert appointments" on appointments;
drop policy if exists "owner can update appointments" on appointments;
drop policy if exists "owner can delete appointments" on appointments;

create policy staff_read_own on staff for select to authenticated
  using (id = (select auth.uid()));

create policy providers_read on providers for select to authenticated
  using (exists (select 1 from staff me where me.id = (select auth.uid()) and me.is_active and (me.role = 'platform_owner' or me.provider_id = providers.id)));
create policy providers_manage on providers for all to authenticated
  using (exists (select 1 from staff me where me.id = (select auth.uid()) and me.is_active and me.role = 'platform_owner'))
  with check (exists (select 1 from staff me where me.id = (select auth.uid()) and me.is_active and me.role = 'platform_owner'));

create policy locations_read on locations for select to authenticated
  using (exists (select 1 from staff me where me.id = (select auth.uid()) and me.is_active and (me.role = 'platform_owner' or me.provider_id = locations.provider_id)));
create policy locations_manage on locations for all to authenticated
  using (exists (select 1 from staff me where me.id = (select auth.uid()) and me.is_active and me.role in ('platform_owner', 'owner', 'manager') and me.provider_id = locations.provider_id))
  with check (exists (select 1 from staff me where me.id = (select auth.uid()) and me.is_active and me.role in ('platform_owner', 'owner', 'manager') and me.provider_id = locations.provider_id));

create policy bays_read_scoped on bays for select to authenticated
  using (exists (select 1 from staff me where me.id = (select auth.uid()) and me.is_active and (me.role = 'platform_owner' or me.provider_id = bays.provider_id)));
create policy bays_manage_scoped on bays for all to authenticated
  using (exists (select 1 from staff me where me.id = (select auth.uid()) and me.is_active and me.role in ('platform_owner', 'owner', 'manager') and me.provider_id = bays.provider_id))
  with check (exists (select 1 from staff me where me.id = (select auth.uid()) and me.is_active and me.role in ('platform_owner', 'owner', 'manager') and me.provider_id = bays.provider_id));

create policy closures_read_scoped on bay_closures for select to authenticated
  using (exists (select 1 from staff me where me.id = (select auth.uid()) and me.is_active and (me.role = 'platform_owner' or me.provider_id = bay_closures.provider_id)));
create policy closures_manage_scoped on bay_closures for all to authenticated
  using (exists (select 1 from staff me where me.id = (select auth.uid()) and me.is_active and me.role in ('platform_owner', 'owner', 'manager') and me.provider_id = bay_closures.provider_id))
  with check (exists (select 1 from staff me where me.id = (select auth.uid()) and me.is_active and me.role in ('platform_owner', 'owner', 'manager') and me.provider_id = bay_closures.provider_id));

create policy breaks_read_scoped on crew_break_schedule for select to authenticated
  using (exists (select 1 from staff me where me.id = (select auth.uid()) and me.is_active and (me.role = 'platform_owner' or me.provider_id = crew_break_schedule.provider_id)));
create policy breaks_manage_scoped on crew_break_schedule for all to authenticated
  using (exists (select 1 from staff me where me.id = (select auth.uid()) and me.is_active and me.role in ('platform_owner', 'owner', 'manager') and me.provider_id = crew_break_schedule.provider_id))
  with check (exists (select 1 from staff me where me.id = (select auth.uid()) and me.is_active and me.role in ('platform_owner', 'owner', 'manager') and me.provider_id = crew_break_schedule.provider_id));

create policy services_read_scoped on services for select to authenticated
  using (exists (select 1 from staff me where me.id = (select auth.uid()) and me.is_active and (me.role = 'platform_owner' or me.provider_id = services.provider_id)));
create policy services_manage_scoped on services for all to authenticated
  using (exists (select 1 from staff me where me.id = (select auth.uid()) and me.is_active and me.role in ('platform_owner', 'owner', 'manager') and me.provider_id = services.provider_id))
  with check (exists (select 1 from staff me where me.id = (select auth.uid()) and me.is_active and me.role in ('platform_owner', 'owner', 'manager') and me.provider_id = services.provider_id));

create policy settings_read_scoped on booking_settings for select to authenticated
  using (exists (select 1 from staff me where me.id = (select auth.uid()) and me.is_active and (me.role = 'platform_owner' or me.provider_id = booking_settings.provider_id)));
create policy settings_manage_scoped on booking_settings for all to authenticated
  using (exists (select 1 from staff me where me.id = (select auth.uid()) and me.is_active and me.role in ('platform_owner', 'owner', 'manager') and me.provider_id = booking_settings.provider_id))
  with check (exists (select 1 from staff me where me.id = (select auth.uid()) and me.is_active and me.role in ('platform_owner', 'owner', 'manager') and me.provider_id = booking_settings.provider_id));

create policy blackouts_read_scoped on blackout_dates for select to authenticated
  using (exists (select 1 from staff me where me.id = (select auth.uid()) and me.is_active and (me.role = 'platform_owner' or me.provider_id = blackout_dates.provider_id)));
create policy blackouts_manage_scoped on blackout_dates for all to authenticated
  using (exists (select 1 from staff me where me.id = (select auth.uid()) and me.is_active and me.role in ('platform_owner', 'owner', 'manager') and me.provider_id = blackout_dates.provider_id))
  with check (exists (select 1 from staff me where me.id = (select auth.uid()) and me.is_active and me.role in ('platform_owner', 'owner', 'manager') and me.provider_id = blackout_dates.provider_id));

create policy appointments_read_scoped on appointments for select to authenticated
  using (exists (select 1 from staff me where me.id = (select auth.uid()) and me.is_active and (me.role = 'platform_owner' or me.provider_id = appointments.provider_id)));
create policy appointments_manage_scoped on appointments for all to authenticated
  using (exists (select 1 from staff me where me.id = (select auth.uid()) and me.is_active and me.role in ('platform_owner', 'owner', 'manager') and me.provider_id = appointments.provider_id))
  with check (exists (select 1 from staff me where me.id = (select auth.uid()) and me.is_active and me.role in ('platform_owner', 'owner', 'manager') and me.provider_id = appointments.provider_id));

-- Locks are written by the trusted booking service, not directly by browser users.
-- With RLS enabled and no public policies, anon/authenticated cannot access them.
