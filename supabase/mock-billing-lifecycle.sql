-- Future gateway migration for Docket billing.
-- The current mock checkout stores test state in the browser only.
-- Apply this migration before connecting a real TNG-compatible gateway.

alter table public.provider_subscriptions
  add column if not exists payment_provider text not null default 'mock',
  add column if not exists checkout_id text,
  add column if not exists billing_interval text not null default 'month',
  add column if not exists started_at timestamptz,
  add column if not exists cancel_at_period_end boolean not null default false,
  add column if not exists cancelled_at timestamptz,
  add column if not exists next_billing_at timestamptz,
  add column if not exists last_payment_at timestamptz,
  add column if not exists last_payment_status text,
  add column if not exists grace_ends_at timestamptz;

alter table public.provider_subscriptions drop constraint if exists provider_subscriptions_status_check;
alter table public.provider_subscriptions add constraint provider_subscriptions_status_check
  check (status in ('incomplete', 'trialing', 'active', 'past_due', 'paused', 'cancelled', 'suspended', 'unpaid'));

create unique index if not exists provider_subscriptions_checkout_idx
  on public.provider_subscriptions(checkout_id) where checkout_id is not null;

create table if not exists public.platform_billing_events (
  id uuid primary key default gen_random_uuid(),
  provider_id text not null references public.providers(id) on delete cascade,
  subscription_id uuid references public.provider_subscriptions(id) on delete set null,
  payment_provider text not null default 'mock',
  event_type text not null,
  amount_myr numeric(10,2) not null default 0 check (amount_myr >= 0),
  currency text not null default 'myr',
  status text not null,
  idempotency_key text not null unique,
  occurred_at timestamptz not null default now(),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists platform_billing_events_provider_idx
  on public.platform_billing_events(provider_id, occurred_at desc);

alter table public.platform_billing_events enable row level security;
drop policy if exists platform_billing_events_platform_owner on public.platform_billing_events;
create policy platform_billing_events_platform_owner on public.platform_billing_events
  for all to authenticated
  using (exists (select 1 from public.staff me where me.id = (select auth.uid()) and me.is_active and me.role = 'platform_owner'))
  with check (exists (select 1 from public.staff me where me.id = (select auth.uid()) and me.is_active and me.role = 'platform_owner'));

-- Providers may view their own catalogue, subscription and billing history.
drop policy if exists subscription_plans_provider_owner_select on public.subscription_plans;
create policy subscription_plans_provider_owner_select on public.subscription_plans for select to authenticated
  using (is_active and exists (
    select 1 from public.staff me
    where me.id = (select auth.uid()) and me.is_active and me.role in ('owner', 'manager')
  ));

drop policy if exists provider_subscriptions_provider_owner_select on public.provider_subscriptions;
create policy provider_subscriptions_provider_owner_select on public.provider_subscriptions for select to authenticated
  using (exists (
    select 1 from public.staff me
    where me.id = (select auth.uid()) and me.is_active and me.provider_id = provider_subscriptions.provider_id
      and me.role in ('owner', 'manager')
  ));

drop policy if exists platform_billing_events_provider_owner_select on public.platform_billing_events;
create policy platform_billing_events_provider_owner_select on public.platform_billing_events for select to authenticated
  using (exists (
    select 1 from public.staff me
    where me.id = (select auth.uid()) and me.is_active and me.provider_id = platform_billing_events.provider_id
      and me.role in ('owner', 'manager')
  ));
