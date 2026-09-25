-- Signed-in provider owners may compare active plan definitions, while the
-- platform owner retains access to inactive plans without overlapping SELECT
-- policies.
drop policy if exists subscription_plans_platform_owner on public.subscription_plans;
drop policy if exists subscription_plans_authenticated_read on public.subscription_plans;
drop policy if exists subscription_plans_platform_insert on public.subscription_plans;
drop policy if exists subscription_plans_platform_update on public.subscription_plans;
drop policy if exists subscription_plans_platform_delete on public.subscription_plans;
create policy subscription_plans_authenticated_read on public.subscription_plans for select to authenticated
using (
  is_active = true or exists (
    select 1 from public.staff me
    where me.id = (select auth.uid()) and me.is_active and me.role = 'platform_owner'
  )
);
create policy subscription_plans_platform_insert on public.subscription_plans for insert to authenticated
with check (exists (select 1 from public.staff me where me.id = (select auth.uid()) and me.is_active and me.role = 'platform_owner'));
create policy subscription_plans_platform_update on public.subscription_plans for update to authenticated
using (exists (select 1 from public.staff me where me.id = (select auth.uid()) and me.is_active and me.role = 'platform_owner'))
with check (exists (select 1 from public.staff me where me.id = (select auth.uid()) and me.is_active and me.role = 'platform_owner'));
create policy subscription_plans_platform_delete on public.subscription_plans for delete to authenticated
using (exists (select 1 from public.staff me where me.id = (select auth.uid()) and me.is_active and me.role = 'platform_owner'));
