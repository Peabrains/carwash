begin;

do $$
declare
  verification_policies text[];
  workspace_definition text;
  onboarding_definition text;
begin
  if to_regclass('public.provider_profiles') is null then
    raise exception 'provider_profiles table is missing';
  end if;
  if to_regclass('public.provider_verifications') is null then
    raise exception 'provider_verifications table is missing';
  end if;
  if to_regclass('public.provider_plan_changes') is null then
    raise exception 'provider_plan_changes table is missing';
  end if;
  if to_regprocedure('public.create_provider_workspace(text,text,text,text)') is null then
    raise exception 'create_provider_workspace RPC is missing';
  end if;
  if to_regprocedure('public.get_provider_onboarding()') is null then
    raise exception 'get_provider_onboarding RPC is missing';
  end if;
  if to_regprocedure('public.save_provider_onboarding_progress(text,text[])') is null
    or to_regprocedure('public.select_provider_pilot_plan(text)') is null
    or to_regprocedure('public.complete_provider_onboarding()') is null
  then
    raise exception 'provider onboarding mutation RPCs are missing';
  end if;
  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and tablename = 'provider_profiles'
      and indexdef ilike '%unique%ssm_number%'
  ) then
    raise exception 'provider_profiles.ssm_number unique index is missing';
  end if;

  select array_agg(policyname order by policyname) into verification_policies
  from pg_policies
  where schemaname = 'public' and tablename = 'provider_verifications';

  if verification_policies is distinct from array[
    'provider_verifications_owner_insert',
    'provider_verifications_owner_select',
    'provider_verifications_platform_update'
  ]::text[] then
    raise exception 'provider verification policies are incorrect: %', verification_policies;
  end if;

  if exists (
    select 1 from information_schema.routine_privileges
    where routine_schema = 'public'
      and routine_name in ('create_provider_workspace', 'get_provider_onboarding')
      and grantee in ('PUBLIC', 'anon')
  ) then
    raise exception 'onboarding RPC is executable by PUBLIC or anon';
  end if;

  if not exists (
    select 1 from information_schema.routine_privileges
    where routine_schema = 'public'
      and routine_name = 'create_provider_workspace'
      and grantee = 'authenticated'
      and privilege_type = 'EXECUTE'
  ) then
    raise exception 'authenticated users cannot execute create_provider_workspace';
  end if;

  select pg_get_functiondef('public.create_provider_workspace(text,text,text,text)'::regprocedure)
    into workspace_definition;
  if workspace_definition not ilike '%security definer%'
    or workspace_definition not ilike '%auth.uid()%'
    or workspace_definition not ilike '%email_confirmed_at%'
    or workspace_definition ~* '\mp_provider_id\M'
  then
    raise exception 'workspace RPC is missing its verified-user or tenant-isolation guard';
  end if;

  select pg_get_functiondef('public.get_provider_onboarding()'::regprocedure)
    into onboarding_definition;
  if onboarding_definition not ilike '%auth.uid()%'
    or onboarding_definition ~* '\mp_provider_id\M'
  then
    raise exception 'onboarding summary RPC is not scoped exclusively to the signed-in user';
  end if;

  if not exists (
    select 1 from storage.buckets
    where id = 'provider-verification' and public = false
  ) then
    raise exception 'private provider verification bucket is missing';
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'provider_verification_owner_insert'
      and with_check ilike '%auth.uid()%'
      and with_check ilike '%foldername%'
  ) then
    raise exception 'provider verification uploads are not owner/folder scoped';
  end if;
end
$$;

rollback;
