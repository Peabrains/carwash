-- Docket platform administration foundation.
-- Run after tenant-migration.sql, tenant-rls.sql and fix-staff-rls-recursion.sql.
-- Billing providers can be connected later; these tables are the source of truth
-- for onboarding and subscription state inside Docket.

create table if not exists public.subscription_plans (
  id text primary key,
  name text not null,
  description text not null default '',
  monthly_price_myr numeric(10,2) not null default 0 check (monthly_price_myr >= 0),
  max_locations integer check (max_locations is null or max_locations > 0),
  max_staff integer check (max_staff is null or max_staff > 0),
  max_monthly_bookings integer check (max_monthly_bookings is null or max_monthly_bookings > 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.provider_subscriptions (
  id uuid primary key default gen_random_uuid(),
  provider_id text not null unique references public.providers(id) on delete cascade,
  plan_id text references public.subscription_plans(id) on delete set null,
  status text not null default 'trialing' check (status in ('trialing', 'active', 'past_due', 'paused', 'cancelled', 'suspended')),
  trial_ends_at timestamptz,
  current_period_start timestamptz,
  current_period_end timestamptz,
  stripe_customer_id text,
  stripe_subscription_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.provider_onboarding (
  provider_id text primary key references public.providers(id) on delete cascade,
  status text not null default 'invited' check (status in ('invited', 'in_progress', 'ready', 'active', 'blocked')),
  owner_email text,
  invited_at timestamptz,
  profile_completed_at timestamptz,
  first_location_completed_at timestamptz,
  activated_at timestamptz,
  notes text not null default '',
  updated_at timestamptz not null default now()
);

create table if not exists public.platform_audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid,
  provider_id text references public.providers(id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists provider_subscriptions_status_idx on public.provider_subscriptions(status, current_period_end);
create index if not exists platform_audit_provider_idx on public.platform_audit_log(provider_id, created_at desc);

alter table public.subscription_plans enable row level security;
alter table public.provider_subscriptions enable row level security;
alter table public.provider_onboarding enable row level security;
alter table public.platform_audit_log enable row level security;

drop policy if exists subscription_plans_platform_owner on public.subscription_plans;
create policy subscription_plans_platform_owner on public.subscription_plans for all to authenticated
  using (exists (select 1 from public.staff me where me.id = (select auth.uid()) and me.is_active and me.role = 'platform_owner'))
  with check (exists (select 1 from public.staff me where me.id = (select auth.uid()) and me.is_active and me.role = 'platform_owner'));

drop policy if exists provider_subscriptions_platform_owner on public.provider_subscriptions;
create policy provider_subscriptions_platform_owner on public.provider_subscriptions for all to authenticated
  using (exists (select 1 from public.staff me where me.id = (select auth.uid()) and me.is_active and me.role = 'platform_owner'))
  with check (exists (select 1 from public.staff me where me.id = (select auth.uid()) and me.is_active and me.role = 'platform_owner'));

drop policy if exists provider_onboarding_platform_owner on public.provider_onboarding;
create policy provider_onboarding_platform_owner on public.provider_onboarding for all to authenticated
  using (exists (select 1 from public.staff me where me.id = (select auth.uid()) and me.is_active and me.role = 'platform_owner'))
  with check (exists (select 1 from public.staff me where me.id = (select auth.uid()) and me.is_active and me.role = 'platform_owner'));

drop policy if exists platform_audit_platform_owner on public.platform_audit_log;
create policy platform_audit_platform_owner on public.platform_audit_log for select to authenticated
  using (exists (select 1 from public.staff me where me.id = (select auth.uid()) and me.is_active and me.role = 'platform_owner'));

insert into public.subscription_plans (id, name, description, monthly_price_myr, max_locations, max_staff, max_monthly_bookings)
values
  ('trial', 'Trial', 'Try Docket with the core booking tools.', 0, 1, 3, 100),
  ('starter', 'Starter', 'For a single growing outlet.', 49, 1, 10, 500),
  ('growth', 'Growth', 'For providers operating multiple outlets.', 129, 5, 30, 2500)
on conflict (id) do nothing;

