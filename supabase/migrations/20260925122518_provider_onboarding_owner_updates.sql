-- Owner-scoped onboarding progress and pilot plan selection boundaries.

create or replace function public.save_provider_onboarding_progress(
  p_step text,
  p_completed_steps text[]
)
returns public.provider_onboarding
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor public.staff;
  saved public.provider_onboarding;
  valid_steps constant text[] := array['business','outlet','hours','bays','services','plan','review'];
begin
  select * into actor from public.staff where id = auth.uid() and is_active;
  if actor.id is null or actor.role <> 'owner' or actor.provider_id is null then
    raise exception 'Provider owner access required';
  end if;
  if not (p_step = any(valid_steps)) or exists (
    select 1 from unnest(coalesce(p_completed_steps, '{}'::text[])) item where not (item = any(valid_steps))
  ) then
    raise exception 'Unknown onboarding step';
  end if;

  update public.provider_onboarding
  set current_step = p_step,
      completed_steps = array(select distinct item from unnest(coalesce(p_completed_steps, '{}'::text[])) item),
      status = case when status in ('invited','in_progress') then 'in_progress' else status end,
      updated_at = now()
  where provider_id = actor.provider_id
  returning * into saved;
  return saved;
end;
$$;

create or replace function public.select_provider_pilot_plan(p_plan_id text)
returns public.provider_subscriptions
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor public.staff;
  selected_plan public.subscription_plans;
  previous_plan text;
  saved public.provider_subscriptions;
begin
  select * into actor from public.staff where id = auth.uid() and is_active;
  if actor.id is null or actor.role <> 'owner' or actor.provider_id is null then
    raise exception 'Provider owner access required';
  end if;
  select * into selected_plan from public.subscription_plans
    where id = p_plan_id and is_active and pilot_free;
  if selected_plan.id is null then raise exception 'That pilot plan is unavailable'; end if;
  select plan_id into previous_plan from public.provider_subscriptions where provider_id = actor.provider_id;

  insert into public.provider_subscriptions(provider_id, plan_id, status, payment_provider, current_period_start, current_period_end, updated_at)
  values (actor.provider_id, selected_plan.id, 'active', 'pilot_free', now(), now() + interval '1 month', now())
  on conflict (provider_id) do update
    set plan_id = excluded.plan_id, status = 'active', payment_provider = 'pilot_free', updated_at = now()
  returning * into saved;

  if previous_plan is distinct from selected_plan.id then
    insert into public.provider_plan_changes(provider_id, old_plan_id, new_plan_id, effective_timing, status, actor_id, amount_myr, effective_at, applied_at)
    values (actor.provider_id, previous_plan, selected_plan.id, 'immediate', 'applied', actor.id, 0, now(), now());
  end if;
  return saved;
end;
$$;

create or replace function public.complete_provider_onboarding()
returns public.provider_onboarding
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor public.staff;
  saved public.provider_onboarding;
  required_steps constant text[] := array['business','outlet','hours','bays','services','plan'];
begin
  select * into actor from public.staff where id = auth.uid() and is_active;
  if actor.id is null or actor.role <> 'owner' or actor.provider_id is null then
    raise exception 'Provider owner access required';
  end if;
  if exists (
    select 1 from unnest(required_steps) step
    where not exists (
      select 1 from public.provider_onboarding o
      where o.provider_id = actor.provider_id and step = any(o.completed_steps)
    )
  ) then raise exception 'Complete every onboarding step first'; end if;

  update public.provider_onboarding
  set status = 'ready', current_step = 'review', completed_at = now(), updated_at = now()
  where provider_id = actor.provider_id
  returning * into saved;
  return saved;
end;
$$;

revoke all on function public.save_provider_onboarding_progress(text,text[]) from public, anon, authenticated;
grant execute on function public.save_provider_onboarding_progress(text,text[]) to authenticated;
revoke all on function public.select_provider_pilot_plan(text) from public, anon, authenticated;
grant execute on function public.select_provider_pilot_plan(text) to authenticated;
revoke all on function public.complete_provider_onboarding() from public, anon, authenticated;
grant execute on function public.complete_provider_onboarding() to authenticated;
