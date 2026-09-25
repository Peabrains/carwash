-- Free-pilot plan changes and transaction-level entitlement enforcement.

alter table public.appointments
  add column if not exists is_test boolean not null default false,
  add column if not exists created_by uuid references auth.users(id) on delete set null;

create or replace function private.enforce_provider_entitlement()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_provider text := new.provider_id;
  subscription public.provider_subscriptions;
  plan public.subscription_plans;
  active_count integer;
  pending_count integer;
  period_start timestamptz;
  period_end timestamptz;
  actor_role text;
begin
  select * into subscription from public.provider_subscriptions
  where provider_id = target_provider and status in ('trialing','active')
  for update;
  if subscription.id is null or subscription.plan_id is null then return new; end if;
  select * into plan from public.subscription_plans where id = subscription.plan_id;
  if plan.id is null then return new; end if;

  if tg_table_name = 'locations' then
    if new.is_active and (tg_op = 'INSERT' or old.is_active is distinct from true or old.provider_id is distinct from new.provider_id) then
      perform pg_advisory_xact_lock(hashtextextended(target_provider || ':entitlement:locations', 0));
      select count(*) into active_count from public.locations
      where provider_id = target_provider and is_active;
      if plan.max_locations is not null and active_count >= plan.max_locations then
        raise exception 'Your plan allows % active outlet(s)', plan.max_locations;
      end if;
    end if;
  elsif tg_table_name = 'staff' then
    if new.is_active and (tg_op = 'INSERT' or old.is_active is distinct from true or old.provider_id is distinct from new.provider_id) then
      perform pg_advisory_xact_lock(hashtextextended(target_provider || ':entitlement:staff', 0));
      select count(*) into active_count from public.staff where provider_id = target_provider and is_active;
      select count(*) into pending_count from public.staff_invitations where provider_id = target_provider and accepted_at is null;
      if exists (
        select 1 from public.staff_invitations
        where provider_id = target_provider and accepted_at is null and lower(email) = lower(new.email)
      ) then pending_count := greatest(pending_count - 1, 0); end if;
      if plan.max_staff is not null and active_count + pending_count >= plan.max_staff then
        raise exception 'Your plan allows % active or invited staff member(s)', plan.max_staff;
      end if;
    end if;
  elsif tg_table_name = 'staff_invitations' then
    if new.accepted_at is null and (tg_op = 'INSERT' or old.accepted_at is not null or old.provider_id is distinct from new.provider_id) then
      perform pg_advisory_xact_lock(hashtextextended(target_provider || ':entitlement:staff', 0));
      select count(*) into active_count from public.staff where provider_id = target_provider and is_active;
      select count(*) into pending_count from public.staff_invitations where provider_id = target_provider and accepted_at is null;
      if plan.max_staff is not null and active_count + pending_count >= plan.max_staff then
        raise exception 'Your plan allows % active or invited staff member(s)', plan.max_staff;
      end if;
    end if;
  elsif tg_table_name = 'appointments' and tg_op = 'INSERT' then
    if new.is_test then
      select role into actor_role from public.staff where id = auth.uid() and is_active;
      if actor_role is distinct from 'platform_owner' then
        raise exception 'Only the platform owner can create excluded test bookings';
      end if;
      new.created_by := auth.uid();
      return new;
    end if;
    perform pg_advisory_xact_lock(hashtextextended(target_provider || ':entitlement:bookings', 0));
    period_start := coalesce(subscription.current_period_start, date_trunc('month', now()));
    period_end := coalesce(subscription.current_period_end, period_start + interval '1 month');
    select count(*) into active_count from public.appointments
    where provider_id = target_provider and created_at >= period_start and created_at < period_end and is_test = false;
    if plan.max_monthly_bookings is not null and active_count >= plan.max_monthly_bookings then
      raise exception 'Your plan booking limit has been reached';
    end if;
    new.created_by := auth.uid();
  end if;
  return new;
end;
$$;

revoke all on function private.enforce_provider_entitlement() from public, anon, authenticated;

drop trigger if exists enforce_location_entitlement on public.locations;
create trigger enforce_location_entitlement before insert or update of provider_id, is_active on public.locations
for each row execute function private.enforce_provider_entitlement();
drop trigger if exists enforce_staff_entitlement on public.staff;
create trigger enforce_staff_entitlement before insert or update of provider_id, is_active on public.staff
for each row execute function private.enforce_provider_entitlement();
drop trigger if exists enforce_staff_invitation_entitlement on public.staff_invitations;
create trigger enforce_staff_invitation_entitlement before insert or update of provider_id, accepted_at on public.staff_invitations
for each row execute function private.enforce_provider_entitlement();
drop trigger if exists enforce_booking_entitlement on public.appointments;
create trigger enforce_booking_entitlement before insert on public.appointments
for each row execute function private.enforce_provider_entitlement();

create or replace function public.create_provider_location(
  p_name text,
  p_address text default '',
  p_timezone text default 'Asia/Kuala_Lumpur'
)
returns public.locations
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor public.staff;
  location_id text;
  saved public.locations;
begin
  select * into actor from public.staff where id = auth.uid() and is_active;
  if actor.id is null or actor.role <> 'owner' or actor.provider_id is null then raise exception 'Provider owner access required'; end if;
  if nullif(trim(p_name), '') is null then raise exception 'Enter an outlet name'; end if;
  location_id := trim(both '-' from regexp_replace(lower(trim(p_name)), '[^a-z0-9]+', '-', 'g'))
    || '-' || substr(md5(clock_timestamp()::text || actor.id::text), 1, 6);
  insert into public.locations(id, provider_id, name, address, timezone, is_active)
  values (actor.provider_id || '-' || location_id, actor.provider_id, trim(p_name), trim(coalesce(p_address,'')), coalesce(nullif(trim(p_timezone),''),'Asia/Kuala_Lumpur'), true)
  returning * into saved;
  insert into public.booking_settings(id, provider_id, location_id)
  values (hashtextextended(saved.id, 0), saved.provider_id, saved.id);
  return saved;
end;
$$;

create or replace function public.change_provider_plan(p_plan_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor public.staff;
  current_subscription public.provider_subscriptions;
  current_plan public.subscription_plans;
  target_plan public.subscription_plans;
  usage_locations integer;
  usage_staff integer;
  usage_invites integer;
  usage_bookings integer;
  effective text;
begin
  select * into actor from public.staff where id = auth.uid() and is_active;
  if actor.id is null or actor.role <> 'owner' or actor.provider_id is null then raise exception 'Provider owner access required'; end if;
  select * into target_plan from public.subscription_plans where id = p_plan_id and is_active and pilot_free;
  if target_plan.id is null then raise exception 'That pilot plan is unavailable'; end if;
  perform pg_advisory_xact_lock(hashtextextended(actor.provider_id || ':plan-change', 0));
  select * into current_subscription from public.provider_subscriptions where provider_id = actor.provider_id for update;
  select * into current_plan from public.subscription_plans where id = current_subscription.plan_id;
  select count(*) into usage_locations from public.locations where provider_id = actor.provider_id and is_active;
  select count(*) into usage_staff from public.staff where provider_id = actor.provider_id and is_active;
  select count(*) into usage_invites from public.staff_invitations where provider_id = actor.provider_id and accepted_at is null;
  select count(*) into usage_bookings from public.appointments
    where provider_id = actor.provider_id and is_test = false
      and created_at >= coalesce(current_subscription.current_period_start, date_trunc('month', now()))
      and created_at < coalesce(current_subscription.current_period_end, date_trunc('month', now()) + interval '1 month');
  if target_plan.max_locations is not null and usage_locations > target_plan.max_locations then raise exception 'This plan has fewer outlets than you currently use'; end if;
  if target_plan.max_staff is not null and usage_staff + usage_invites > target_plan.max_staff then raise exception 'This plan has fewer staff seats than you currently use or have invited'; end if;
  if target_plan.max_monthly_bookings is not null and usage_bookings > target_plan.max_monthly_bookings then raise exception 'This plan has fewer bookings than you have used this period'; end if;

  effective := case when current_plan.id is null or target_plan.display_rank >= current_plan.display_rank then 'immediate' else 'renewal' end;
  if current_subscription.id is null then
    insert into public.provider_subscriptions(provider_id, plan_id, status, payment_provider, current_period_start, current_period_end)
    values (actor.provider_id, target_plan.id, 'active', 'pilot_free', now(), now() + interval '1 month') returning * into current_subscription;
    effective := 'immediate';
  elsif effective = 'immediate' then
    update public.provider_subscriptions set plan_id = target_plan.id, pending_plan_id = null, pending_effective_at = null,
      status = 'active', payment_provider = 'pilot_free', current_period_start = now(), current_period_end = now() + interval '1 month', updated_at = now()
    where id = current_subscription.id returning * into current_subscription;
  else
    update public.provider_subscriptions set pending_plan_id = target_plan.id,
      pending_effective_at = coalesce(current_period_end, now() + interval '1 month'), updated_at = now()
    where id = current_subscription.id returning * into current_subscription;
  end if;
  insert into public.provider_plan_changes(provider_id, old_plan_id, new_plan_id, effective_timing, status, actor_id, amount_myr, effective_at, applied_at)
  values (actor.provider_id, current_plan.id, target_plan.id, effective,
    case when effective = 'immediate' then 'applied' else 'pending' end, actor.id, 0,
    case when effective = 'immediate' then now() else current_subscription.pending_effective_at end,
    case when effective = 'immediate' then now() else null end);
  return jsonb_build_object('subscription', to_jsonb(current_subscription), 'current_plan', to_jsonb(case when effective = 'immediate' then target_plan else current_plan end),
    'pending_plan', case when effective = 'renewal' then to_jsonb(target_plan) else null end, 'effective', effective,
    'usage', jsonb_build_object('locations',usage_locations,'staff',usage_staff,'pending_invites',usage_invites,'bookings',usage_bookings));
end;
$$;

create or replace function public.cancel_pending_provider_plan_change()
returns public.provider_subscriptions
language plpgsql
security definer
set search_path = ''
as $$
declare actor public.staff; saved public.provider_subscriptions;
begin
  select * into actor from public.staff where id = auth.uid() and is_active;
  if actor.id is null or actor.role <> 'owner' or actor.provider_id is null then raise exception 'Provider owner access required'; end if;
  update public.provider_plan_changes set status = 'cancelled'
  where provider_id = actor.provider_id and status = 'pending';
  update public.provider_subscriptions set pending_plan_id = null, pending_effective_at = null, updated_at = now()
  where provider_id = actor.provider_id returning * into saved;
  return saved;
end;
$$;

create or replace function public.get_provider_plan_summary()
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  actor public.staff;
  subscription public.provider_subscriptions;
  current_plan public.subscription_plans;
  pending_plan public.subscription_plans;
  usage_locations integer;
  usage_staff integer;
  usage_invites integer;
  usage_bookings integer;
begin
  select * into actor from public.staff where id = auth.uid() and is_active;
  if actor.id is null or actor.role not in ('owner','platform_owner') or actor.provider_id is null then raise exception 'Provider owner access required'; end if;
  select * into subscription from public.provider_subscriptions where provider_id = actor.provider_id;
  select * into current_plan from public.subscription_plans where id = subscription.plan_id;
  select * into pending_plan from public.subscription_plans where id = subscription.pending_plan_id;
  select count(*) into usage_locations from public.locations where provider_id = actor.provider_id and is_active;
  select count(*) into usage_staff from public.staff where provider_id = actor.provider_id and is_active;
  select count(*) into usage_invites from public.staff_invitations where provider_id = actor.provider_id and accepted_at is null;
  select count(*) into usage_bookings from public.appointments
    where provider_id = actor.provider_id and is_test = false
      and created_at >= coalesce(subscription.current_period_start, date_trunc('month', now()))
      and created_at < coalesce(subscription.current_period_end, date_trunc('month', now()) + interval '1 month');
  return jsonb_build_object('subscription',to_jsonb(subscription),'current_plan',to_jsonb(current_plan),'pending_plan',to_jsonb(pending_plan),
    'usage',jsonb_build_object('locations',usage_locations,'staff',usage_staff,'pending_invites',usage_invites,'bookings',usage_bookings));
end;
$$;

revoke all on function public.create_provider_location(text,text,text) from public, anon, authenticated;
grant execute on function public.create_provider_location(text,text,text) to authenticated;
revoke all on function public.change_provider_plan(text) from public, anon, authenticated;
grant execute on function public.change_provider_plan(text) to authenticated;
revoke all on function public.cancel_pending_provider_plan_change() from public, anon, authenticated;
grant execute on function public.cancel_pending_provider_plan_change() to authenticated;
revoke all on function public.get_provider_plan_summary() from public, anon, authenticated;
grant execute on function public.get_provider_plan_summary() to authenticated;
