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

create or replace function public.upsert_staff_member_by_email(
  p_email text,
  p_name text,
  p_role text,
  p_provider_id text,
  p_location_id text,
  p_is_active boolean default true
)
returns public.staff
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  actor public.staff;
  target_id uuid;
  result public.staff;
begin
  select * into actor from public.staff where id = auth.uid() and is_active;
  if actor.id is null or actor.role not in ('platform_owner', 'owner') then
    raise exception 'Only a platform owner or provider owner can manage staff';
  end if;
  if actor.role <> 'platform_owner' and actor.provider_id is distinct from p_provider_id then
    raise exception 'You can only manage staff for your own provider';
  end if;
  if p_role not in ('owner', 'manager', 'worker') then
    raise exception 'Invalid staff role';
  end if;

  select id into target_id
  from auth.users
  where lower(email) = lower(trim(p_email))
  limit 1;
  if target_id is null then
    raise exception 'This staff member must sign in with Google once before being added';
  end if;

  insert into public.staff (id, email, name, role, provider_id, location_id, is_active, updated_at)
  values (target_id, lower(trim(p_email)), nullif(trim(p_name), ''), p_role, p_provider_id, p_location_id, p_is_active, now())
  on conflict (id) do update set
    email = excluded.email,
    name = excluded.name,
    role = excluded.role,
    provider_id = excluded.provider_id,
    location_id = excluded.location_id,
    is_active = excluded.is_active,
    updated_at = now()
  returning * into result;
  return result;
end;
$$;

revoke all on function public.upsert_staff_member_by_email(text, text, text, text, text, boolean) from public;
grant execute on function public.upsert_staff_member_by_email(text, text, text, text, text, boolean) to authenticated;
