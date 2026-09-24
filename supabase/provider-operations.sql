-- Provider operations: owner profile editing and safe staff assignment.
-- Run after tenant-migration.sql and tenant-rls.sql.

drop policy if exists providers_manage on providers;
drop policy if exists providers_owner_update on providers;
drop policy if exists providers_platform_insert on providers;
drop policy if exists providers_platform_delete on providers;

create policy providers_owner_update on providers for update to authenticated
  using (exists (
    select 1 from staff me
    where me.id = (select auth.uid()) and me.is_active
      and (me.role = 'platform_owner' or (me.role = 'owner' and me.provider_id = providers.id))
  ))
  with check (exists (
    select 1 from staff me
    where me.id = (select auth.uid()) and me.is_active
      and (me.role = 'platform_owner' or (me.role = 'owner' and me.provider_id = providers.id))
  ));

create policy providers_platform_insert on providers for insert to authenticated
  with check (exists (
    select 1 from staff me
    where me.id = (select auth.uid()) and me.is_active and me.role = 'platform_owner'
  ));

create policy providers_platform_delete on providers for delete to authenticated
  using (exists (
    select 1 from staff me
    where me.id = (select auth.uid()) and me.is_active and me.role = 'platform_owner'
  ));

drop policy if exists staff_read_provider on staff;
create policy staff_read_provider on staff for select to authenticated
  using (exists (
    select 1 from staff me
    where me.id = (select auth.uid()) and me.is_active
      and (me.role = 'platform_owner' or me.provider_id = staff.provider_id)
  ));

-- Staff creation now uses invite_staff_member(), which supports both existing
-- Auth users and pending invitations. The obsolete upsert RPC is removed by
-- the booking_security_notifications migration.
