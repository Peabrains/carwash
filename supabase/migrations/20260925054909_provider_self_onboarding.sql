-- Provider self-onboarding, private marketplace verification, and pilot plans.

create table if not exists public.provider_profiles (
  provider_id text primary key references public.providers(id) on delete cascade,
  legal_name text not null,
  ssm_number text not null unique,
  business_phone text not null,
  marketplace_status text not null default 'not_submitted'
    check (marketplace_status in ('not_submitted','pending_review','changes_requested','approved','rejected','suspended')),
  operations_suspended boolean not null default false,
  profile_version integer not null default 1 check (profile_version > 0),
  reviewed_version integer,
  updated_at timestamptz not null default now()
);

alter table public.provider_onboarding
  add column if not exists current_step text not null default 'business',
  add column if not exists completed_steps text[] not null default '{}',
  add column if not exists completed_at timestamptz;

alter table public.subscription_plans
  add column if not exists pilot_free boolean not null default true,
  add column if not exists display_rank integer not null default 0;

alter table public.provider_subscriptions
  add column if not exists pending_plan_id text references public.subscription_plans(id),
  add column if not exists pending_effective_at timestamptz;

alter table public.provider_subscriptions
  add column if not exists payment_provider text not null default 'pilot_free';

create table if not exists public.provider_verifications (
  id uuid primary key default gen_random_uuid(),
  provider_id text not null references public.providers(id) on delete cascade,
  submission_version integer not null check (submission_version > 0),
  ssm_document_path text not null,
  storefront_photo_path text not null,
  submitted_snapshot jsonb not null,
  status text not null default 'pending_review'
    check (status in ('pending_review','changes_requested','approved','rejected','suspended')),
  decision_reason text not null default '',
  submitted_by uuid not null references auth.users(id) on delete restrict,
  reviewed_by uuid references auth.users(id) on delete restrict,
  submitted_at timestamptz not null default now(),
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(provider_id, submission_version)
);

create table if not exists public.provider_plan_changes (
  id uuid primary key default gen_random_uuid(),
  provider_id text not null references public.providers(id) on delete cascade,
  old_plan_id text references public.subscription_plans(id) on delete set null,
  new_plan_id text not null references public.subscription_plans(id) on delete restrict,
  effective_timing text not null check (effective_timing in ('immediate','renewal')),
  status text not null check (status in ('pending','applied','cancelled','failed')),
  actor_id uuid not null references auth.users(id) on delete restrict,
  amount_myr numeric(10,2) not null default 0 check (amount_myr >= 0),
  effective_at timestamptz,
  applied_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists provider_verifications_queue_idx
  on public.provider_verifications(status, submitted_at);
create index if not exists provider_plan_changes_provider_idx
  on public.provider_plan_changes(provider_id, created_at desc);

alter table public.provider_profiles enable row level security;
alter table public.provider_verifications enable row level security;
alter table public.provider_plan_changes enable row level security;

drop policy if exists provider_profiles_owner_select on public.provider_profiles;
create policy provider_profiles_owner_select on public.provider_profiles for select to authenticated
using (exists (
  select 1 from public.staff me where me.id = (select auth.uid()) and me.is_active
    and (me.role = 'platform_owner' or me.provider_id = provider_profiles.provider_id)
));

drop policy if exists provider_profiles_owner_update on public.provider_profiles;
create policy provider_profiles_owner_update on public.provider_profiles for update to authenticated
using (exists (
  select 1 from public.staff me where me.id = (select auth.uid()) and me.is_active
    and (me.role = 'platform_owner' or (me.role = 'owner' and me.provider_id = provider_profiles.provider_id))
))
with check (exists (
  select 1 from public.staff me where me.id = (select auth.uid()) and me.is_active
    and (me.role = 'platform_owner' or (me.role = 'owner' and me.provider_id = provider_profiles.provider_id))
));

drop policy if exists provider_verifications_owner_select on public.provider_verifications;
create policy provider_verifications_owner_select on public.provider_verifications for select to authenticated
using (exists (
  select 1 from public.staff me where me.id = (select auth.uid()) and me.is_active
    and (me.role = 'platform_owner' or (me.role = 'owner' and me.provider_id = provider_verifications.provider_id))
));

drop policy if exists provider_verifications_owner_insert on public.provider_verifications;
create policy provider_verifications_owner_insert on public.provider_verifications for insert to authenticated
with check (
  submitted_by = (select auth.uid()) and exists (
    select 1 from public.staff me where me.id = (select auth.uid()) and me.is_active
      and me.role = 'owner' and me.provider_id = provider_verifications.provider_id
  )
);

drop policy if exists provider_verifications_platform_update on public.provider_verifications;
create policy provider_verifications_platform_update on public.provider_verifications for update to authenticated
using (exists (
  select 1 from public.staff me where me.id = (select auth.uid()) and me.is_active and me.role = 'platform_owner'
))
with check (exists (
  select 1 from public.staff me where me.id = (select auth.uid()) and me.is_active and me.role = 'platform_owner'
));

drop policy if exists provider_plan_changes_scoped_select on public.provider_plan_changes;
create policy provider_plan_changes_scoped_select on public.provider_plan_changes for select to authenticated
using (exists (
  select 1 from public.staff me where me.id = (select auth.uid()) and me.is_active
    and (me.role = 'platform_owner' or (me.role = 'owner' and me.provider_id = provider_plan_changes.provider_id))
));

create or replace function public.create_provider_workspace(
  p_trading_name text,
  p_legal_name text,
  p_ssm_number text,
  p_business_phone text
)
returns table(provider_id text, location_id text, onboarding_status text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  current_email text;
  confirmed_at timestamptz;
  existing_staff public.staff;
  normalized_name text := trim(p_trading_name);
  normalized_ssm text := upper(regexp_replace(trim(p_ssm_number), '[^A-Za-z0-9]', '', 'g'));
  new_provider_id text;
  new_location_id text;
begin
  if current_user_id is null then raise exception 'Sign in before creating a provider'; end if;
  select lower(email), email_confirmed_at into current_email, confirmed_at
  from auth.users where id = current_user_id;
  if confirmed_at is null then raise exception 'Verify your email before creating a provider'; end if;

  select * into existing_staff from public.staff where id = current_user_id;
  if existing_staff.id is not null then
    if existing_staff.role = 'owner' and existing_staff.provider_id is not null then
      return query select existing_staff.provider_id,
        (select l.id from public.locations l where l.provider_id = existing_staff.provider_id order by l.created_at limit 1),
        coalesce((select o.status from public.provider_onboarding o where o.provider_id = existing_staff.provider_id), 'in_progress');
      return;
    end if;
    raise exception 'This account already has staff access';
  end if;

  if normalized_name = '' or trim(p_legal_name) = '' or normalized_ssm = '' or trim(p_business_phone) = '' then
    raise exception 'Complete every required business field';
  end if;
  if exists (select 1 from public.provider_profiles p where p.ssm_number = normalized_ssm) then
    raise exception 'That SSM registration number is already registered';
  end if;

  new_provider_id := trim(both '-' from regexp_replace(lower(normalized_name), '[^a-z0-9]+', '-', 'g'))
    || '-' || substr(md5(current_user_id::text), 1, 6);
  new_location_id := new_provider_id || '-main';

  insert into public.providers(id, name, description, status)
  values (new_provider_id, normalized_name, '', 'active');
  insert into public.locations(id, provider_id, name, address, timezone, is_active)
  values (new_location_id, new_provider_id, 'Main outlet', '', 'Asia/Kuala_Lumpur', true);
  insert into public.staff(id, email, role, provider_id, location_id, is_active)
  values (current_user_id, current_email, 'owner', new_provider_id, null, true);
  insert into public.provider_profiles(provider_id, legal_name, ssm_number, business_phone)
  values (new_provider_id, trim(p_legal_name), normalized_ssm, trim(p_business_phone));
  insert into public.provider_onboarding(provider_id, status, owner_email, current_step, completed_steps, invited_at)
  values (new_provider_id, 'in_progress', current_email, 'outlet', array['business'], now());
  insert into public.booking_settings(id, provider_id, location_id)
  values (hashtextextended(new_location_id, 0), new_provider_id, new_location_id);

  return query select new_provider_id, new_location_id, 'in_progress'::text;
end;
$$;

-- Intentional authenticated SECURITY DEFINER boundary: this function creates
-- the first tenant membership, so RLS cannot authorize the inserts beforehand.
-- It derives identity from auth.uid(), requires a verified email, accepts no
-- provider identifier, and performs the whole bootstrap atomically.
create or replace function public.get_provider_onboarding()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor public.staff;
  result jsonb;
begin
  select * into actor from public.staff where id = auth.uid() and is_active;
  if actor.id is null or actor.provider_id is null then return null; end if;
  select jsonb_build_object(
    'provider', to_jsonb(p),
    'profile', to_jsonb(pp),
    'outlet', to_jsonb(l),
    'onboarding', to_jsonb(o),
    'subscription', to_jsonb(ps),
    'verification', to_jsonb(v)
  ) into result
  from public.providers p
  left join public.provider_profiles pp on pp.provider_id = p.id
  left join lateral (select * from public.locations where provider_id = p.id order by created_at limit 1) l on true
  left join public.provider_onboarding o on o.provider_id = p.id
  left join public.provider_subscriptions ps on ps.provider_id = p.id
  left join lateral (select * from public.provider_verifications where provider_id = p.id order by submission_version desc limit 1) v on true
  where p.id = actor.provider_id;
  return result;
end;
$$;

-- This authenticated SECURITY DEFINER reader accepts no tenant identifier and
-- derives its provider exclusively from the active staff row for auth.uid().

revoke all on function public.create_provider_workspace(text,text,text,text) from public, anon, authenticated;
grant execute on function public.create_provider_workspace(text,text,text,text) to authenticated;
revoke all on function public.get_provider_onboarding() from public, anon, authenticated;
grant execute on function public.get_provider_onboarding() to authenticated;

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('provider-verification', 'provider-verification', false, 10485760, array['application/pdf','image/jpeg','image/png'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists provider_verification_owner_read on storage.objects;
create policy provider_verification_owner_read on storage.objects for select to authenticated
using (bucket_id = 'provider-verification' and exists (
  select 1 from public.staff me where me.id = (select auth.uid()) and me.is_active
    and (me.role = 'platform_owner' or (me.role = 'owner' and me.provider_id = (storage.foldername(name))[1]))
));

drop policy if exists provider_verification_owner_insert on storage.objects;
create policy provider_verification_owner_insert on storage.objects for insert to authenticated
with check (bucket_id = 'provider-verification' and exists (
  select 1 from public.staff me where me.id = (select auth.uid()) and me.is_active
    and me.role = 'owner' and me.provider_id = (storage.foldername(name))[1]
));

drop policy if exists provider_verification_owner_update on storage.objects;
create policy provider_verification_owner_update on storage.objects for update to authenticated
using (bucket_id = 'provider-verification' and exists (
  select 1 from public.staff me where me.id = (select auth.uid()) and me.is_active
    and me.role = 'owner' and me.provider_id = (storage.foldername(name))[1]
))
with check (bucket_id = 'provider-verification' and exists (
  select 1 from public.staff me where me.id = (select auth.uid()) and me.is_active
    and me.role = 'owner' and me.provider_id = (storage.foldername(name))[1]
));

insert into public.provider_profiles(provider_id, legal_name, ssm_number, business_phone, marketplace_status, reviewed_version)
select p.id, p.name, 'LEGACY' || upper(regexp_replace(p.id, '[^A-Za-z0-9]', '', 'g')), '',
  case when p.id = 'washpoint' then 'approved' else 'not_submitted' end,
  case when p.id = 'washpoint' then 1 else null end
from public.providers p
on conflict (provider_id) do nothing;

insert into public.provider_onboarding(provider_id, status, owner_email, current_step, completed_steps, completed_at)
select p.id, 'active', min(s.email), 'review', array['business','outlet','hours','bays','services','plan','review'], now()
from public.providers p left join public.staff s on s.provider_id = p.id and s.role = 'owner'
group by p.id
on conflict (provider_id) do nothing;

update public.subscription_plans set pilot_free = true, monthly_price_myr = 0;
update public.subscription_plans set display_rank = case id when 'trial' then 0 when 'starter' then 1 when 'growth' then 2 else display_rank end;

insert into public.provider_subscriptions(provider_id, plan_id, status, payment_provider, current_period_start, current_period_end)
select p.id, coalesce((select id from public.subscription_plans where id = 'starter'), (select id from public.subscription_plans order by display_rank limit 1)),
  'active', 'pilot_free', now(), now() + interval '1 month'
from public.providers p
where exists (select 1 from public.subscription_plans)
on conflict (provider_id) do nothing;
