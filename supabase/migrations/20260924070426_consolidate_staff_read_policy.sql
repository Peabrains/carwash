drop policy if exists staff_read_own on public.staff;

drop policy if exists staff_read_provider on public.staff;
create policy staff_read_provider on public.staff for select to authenticated
using (
  id = (select auth.uid())
  or exists (
    select 1 from private.current_staff_context() me
    where me.is_active
      and (me.role = 'platform_owner' or me.provider_id = staff.provider_id)
  )
);
