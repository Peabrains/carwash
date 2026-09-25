-- Keep staff and customer booking visibility in one permissive SELECT policy.
-- This preserves authorization while avoiding two policies per appointment row.

drop policy if exists appointments_read_scoped on public.appointments;
drop policy if exists customers_read_own_appointments on public.appointments;

create policy appointments_read_scoped on public.appointments
for select to authenticated
using (
  (select auth.uid()) = customer_user_id
  or exists (
    select 1 from private.current_staff_context() me
    where me.is_active
      and (me.role = 'platform_owner' or me.provider_id = appointments.provider_id)
      and (me.location_id is null or me.location_id = appointments.location_id)
  )
);
