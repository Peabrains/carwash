-- Fix the staff policy recursion introduced by provider-operations.sql.
-- The policy must not query staff through its own RLS policy.

create or replace function public.current_staff_context()
returns table (provider_id text, role text, is_active boolean)
language sql
security definer
set search_path = public
stable
as $$
  select s.provider_id, s.role, s.is_active
  from public.staff s
  where s.id = auth.uid()
  limit 1
$$;

revoke all on function public.current_staff_context() from public;
grant execute on function public.current_staff_context() to authenticated;

drop policy if exists staff_read_provider on staff;
create policy staff_read_provider on staff for select to authenticated
  using (exists (
    select 1 from public.current_staff_context() me
    where me.is_active
      and (me.role = 'platform_owner' or me.provider_id = staff.provider_id)
  ));
