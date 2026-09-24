-- Fix the staff policy recursion introduced by provider-operations.sql.
-- The policy must not query staff through its own RLS policy.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create or replace function private.current_staff_context()
returns table (staff_id uuid, provider_id text, location_id text, role text, is_active boolean)
language sql
security definer
set search_path = ''
stable
as $$
  select s.id, s.provider_id, s.location_id, s.role, s.is_active
  from public.staff s
  where s.id = auth.uid()
  limit 1
$$;

revoke all on function private.current_staff_context() from public, anon;
grant usage on schema private to authenticated;
grant execute on function private.current_staff_context() to authenticated;

drop policy if exists staff_read_provider on staff;
drop policy if exists staff_read_own on staff;
create policy staff_read_provider on staff for select to authenticated
  using (
    id = (select auth.uid())
    or exists (
      select 1 from private.current_staff_context() me
      where me.is_active
        and (me.role = 'platform_owner' or me.provider_id = staff.provider_id)
    )
  );
