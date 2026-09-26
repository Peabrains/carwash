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
  if to_regprocedure('public.prepare_provider_verification_upload(text,text,text,bigint)') is null
    or to_regprocedure('public.submit_provider_verification(text,text)') is null
    or to_regprocedure('public.decide_provider_verification(uuid,text,text,boolean,integer)') is null
  then
    raise exception 'provider verification workflow RPCs are missing';
  end if;
  if to_regprocedure('public.save_provider_onboarding_progress(text,text[])') is null
    or to_regprocedure('public.select_provider_pilot_plan(text)') is null
    or to_regprocedure('public.complete_provider_onboarding()') is null
  then
    raise exception 'provider onboarding mutation RPCs are missing';
  end if;
  if to_regprocedure('public.change_provider_plan(text)') is null
    or to_regprocedure('public.cancel_pending_provider_plan_change()') is null
    or to_regprocedure('public.create_provider_location(text,text,text)') is null
    or to_regprocedure('public.get_provider_plan_summary()') is null
    or to_regprocedure('private.enforce_provider_entitlement()') is null
  then
    raise exception 'provider plan entitlement functions are missing';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'appointments' and column_name = 'is_test'
  ) then
    raise exception 'appointments.is_test is missing';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'appointments' and column_name = 'booking_source'
  ) then
    raise exception 'appointments.booking_source is missing';
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
    'provider_verifications_owner_select'
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
    where schemaname = 'public' and tablename = 'subscription_plans'
      and policyname = 'subscription_plans_authenticated_read'
      and roles = array['authenticated']::name[]
  ) then
    raise exception 'authenticated active-plan catalogue policy is missing';
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

do $$
declare
  owner_id uuid;
  original_role text;
  verification jsonb;
  verification_id uuid;
  captured_version integer;
  plan_before text;
begin
  select id, role into owner_id, original_role from public.staff
  where provider_id = 'washpoint' and role in ('owner','platform_owner') and is_active
  order by case role when 'owner' then 0 else 1 end limit 1;
  if owner_id is null then raise exception 'WashPoint owner is required for verification tests'; end if;
  update public.staff set role = 'owner' where id = owner_id;
  perform set_config('request.jwt.claim.sub', owner_id::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  update public.provider_profiles set legal_name = 'WashPoint Test Sdn Bhd', ssm_number = 'VERIFICATIONTEST001', business_phone = '0123456789', marketplace_status = 'not_submitted', operations_suspended = false where provider_id = 'washpoint';
  select plan_id into plan_before from public.provider_subscriptions where provider_id = 'washpoint';

  insert into storage.objects(bucket_id, name)
  select 'provider-verification', path from unnest(array[
    'washpoint/ssm/sql-test-1.pdf','washpoint/storefront/sql-test-1.png',
    'washpoint/ssm/sql-test-2.pdf','washpoint/storefront/sql-test-2.png',
    'washpoint/ssm/sql-test-3.pdf','washpoint/storefront/sql-test-3.png',
    'washpoint/ssm/sql-test-4.pdf','washpoint/storefront/sql-test-4.png'
  ]) path;

  begin
    perform public.submit_provider_verification('washpoint/ssm/sql-test-1.pdf', 'washpoint/storefront/missing.png');
    raise exception 'incomplete verification submission was accepted';
  exception when others then
    if sqlerrm not like 'Upload both verification documents%' then raise; end if;
  end;

  verification := public.submit_provider_verification('washpoint/ssm/sql-test-1.pdf', 'washpoint/storefront/sql-test-1.png');
  verification_id := (verification->>'id')::uuid;
  captured_version := (select (submitted_snapshot->>'profile_version')::integer from public.provider_verifications where id = verification_id);
  if verification ? 'ssm_document_path' or verification ? 'storefront_photo_path' then raise exception 'submission response exposed raw storage paths'; end if;

  update public.provider_profiles set business_phone = '0199999999' where provider_id = 'washpoint';
  update public.staff set role = 'platform_owner' where id = owner_id;
  begin
    perform public.decide_provider_verification(verification_id, 'approved', '', false, captured_version);
    raise exception 'stale verification approval was accepted';
  exception when others then
    if sqlerrm not like 'Provider details changed after submission%' then raise; end if;
  end;
  begin
    perform public.decide_provider_verification(verification_id, 'changes_requested', '', false, captured_version);
    raise exception 'review decision without a reason was accepted';
  exception when others then
    if sqlerrm not like 'A reason is required%' then raise; end if;
  end;
  perform public.decide_provider_verification(verification_id, 'changes_requested', 'Upload the updated registration document.', false, captured_version);

  update public.staff set role = 'owner' where id = owner_id;
  verification := public.submit_provider_verification('washpoint/ssm/sql-test-2.pdf', 'washpoint/storefront/sql-test-2.png');
  verification_id := (verification->>'id')::uuid;
  captured_version := (select (submitted_snapshot->>'profile_version')::integer from public.provider_verifications where id = verification_id);
  update public.staff set role = 'platform_owner' where id = owner_id;
  perform public.decide_provider_verification(verification_id, 'approved', '', false, captured_version);
  if not exists (select 1 from public.provider_profiles where provider_id = 'washpoint' and marketplace_status = 'approved' and reviewed_version = captured_version and not operations_suspended) then
    raise exception 'approval did not publish the reviewed provider version';
  end if;

  update public.staff set role = 'owner' where id = owner_id;
  verification := public.submit_provider_verification('washpoint/ssm/sql-test-3.pdf', 'washpoint/storefront/sql-test-3.png');
  verification_id := (verification->>'id')::uuid;
  captured_version := (select (submitted_snapshot->>'profile_version')::integer from public.provider_verifications where id = verification_id);
  update public.staff set role = 'platform_owner' where id = owner_id;
  perform public.decide_provider_verification(verification_id, 'suspended', 'Marketplace listing paused for review.', false, captured_version);
  if not exists (select 1 from public.provider_profiles where provider_id = 'washpoint' and marketplace_status = 'suspended' and not operations_suspended) then
    raise exception 'marketplace-only suspension incorrectly stopped private operations';
  end if;
  if (select plan_id from public.provider_subscriptions where provider_id = 'washpoint') is distinct from plan_before then
    raise exception 'verification decision altered the provider subscription';
  end if;
  update public.staff set role = 'owner' where id = owner_id;
  verification := public.submit_provider_verification('washpoint/ssm/sql-test-4.pdf', 'washpoint/storefront/sql-test-4.png');
  verification_id := (verification->>'id')::uuid;
  captured_version := (select (submitted_snapshot->>'profile_version')::integer from public.provider_verifications where id = verification_id);
  update public.staff set role = 'platform_owner' where id = owner_id;
  perform public.decide_provider_verification(verification_id, 'suspended', 'All booking operations paused for investigation.', true, captured_version);
  if not exists (select 1 from public.provider_profiles where provider_id = 'washpoint' and operations_suspended) then
    raise exception 'full operational suspension was not preserved';
  end if;
  update public.staff set role = original_role where id = owner_id;
end
$$;

do $$
declare
  owner_id uuid;
  low_plan public.subscription_plans;
  high_plan public.subscription_plans;
  result jsonb;
  current_staff_count integer;
  current_booking_count integer;
  sample_booking public.appointments;
  actor_original_role text;
begin
  select id, role into owner_id, actor_original_role from public.staff
  where provider_id = 'washpoint' and role in ('owner','platform_owner') and is_active
  order by case role when 'owner' then 0 else 1 end limit 1;
  select * into low_plan from public.subscription_plans where is_active order by display_rank asc limit 1;
  select * into high_plan from public.subscription_plans where is_active order by display_rank desc limit 1;
  if owner_id is null or low_plan.id is null or high_plan.id is null or low_plan.id = high_plan.id then
    raise exception 'WashPoint owner and at least two plans are required for entitlement regression tests';
  end if;
  if actor_original_role = 'platform_owner' then update public.staff set role = 'owner' where id = owner_id; end if;
  perform set_config('request.jwt.claim.sub', owner_id::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);

  update public.subscription_plans set max_locations = null, max_staff = null, max_monthly_bookings = null
  where id in (low_plan.id, high_plan.id);

  update public.provider_subscriptions set plan_id = low_plan.id, pending_plan_id = null,
    pending_effective_at = null, status = 'active', current_period_start = date_trunc('month', now()),
    current_period_end = date_trunc('month', now()) + interval '1 month'
  where provider_id = 'washpoint';
  result := public.change_provider_plan(high_plan.id);
  if result->>'effective' <> 'immediate' then raise exception 'plan upgrade was not immediate: %', result; end if;
  result := public.change_provider_plan(low_plan.id);
  if result->>'effective' <> 'renewal' or result->'subscription'->>'pending_plan_id' <> low_plan.id then
    raise exception 'plan downgrade was not scheduled: %', result;
  end if;
  perform public.cancel_pending_provider_plan_change();
  if exists (select 1 from public.provider_subscriptions where provider_id = 'washpoint' and pending_plan_id is not null) then
    raise exception 'pending plan cancellation failed';
  end if;

  update public.provider_subscriptions set plan_id = low_plan.id,
    current_period_start = date_trunc('month', now()),
    current_period_end = date_trunc('month', now()) + interval '1 month'
  where provider_id = 'washpoint';
  update public.subscription_plans set max_locations = 1 where id = low_plan.id;
  begin
    perform public.create_provider_location('Entitlement overflow test', '', 'Asia/Kuala_Lumpur');
    raise exception 'outlet limit did not reject an extra outlet';
  exception when others then
    if sqlerrm not like 'Your plan allows %active outlet%' then raise; end if;
  end;

  select count(*) into current_staff_count from public.staff where provider_id = 'washpoint' and is_active;
  current_staff_count := current_staff_count + (select count(*) from public.staff_invitations where provider_id = 'washpoint' and accepted_at is null);
  update public.subscription_plans set max_staff = greatest(current_staff_count, 1) where id = low_plan.id;
  begin
    insert into public.staff_invitations(email, name, role, provider_id, invited_by)
    values ('entitlement-overflow@example.invalid', 'Limit test', 'worker', 'washpoint', owner_id);
    raise exception 'staff limit did not reject an extra invitation';
  exception when others then
    if sqlerrm not like 'Your plan allows %staff member%' then raise; end if;
  end;

  select count(*) into current_booking_count from public.appointments
  where provider_id = 'washpoint' and is_test = false
    and created_at >= date_trunc('month', now()) and created_at < date_trunc('month', now()) + interval '1 month';
  select * into sample_booking from public.appointments where provider_id = 'washpoint' limit 1;
  if sample_booking.id is not null and current_booking_count > 0 then
    update public.subscription_plans set max_monthly_bookings = current_booking_count where id = low_plan.id;
    begin
      insert into public.appointments(customer_chat_id, customer_name, customer_phone, channel, vehicle_plate,
        vehicle_make_model, bay_id, service_id, scheduled_at, duration_minutes, price_myr, status,
        payment_status, reference, provider_id, location_id, booking_request_id, scheduled_date)
      values ('entitlement-test', 'Limit test', '000', 'staff', 'TEST', 'TEST', sample_booking.bay_id,
        sample_booking.service_id, now() + interval '2 days', sample_booking.duration_minutes,
        sample_booking.price_myr, 'confirmed', 'unpaid', 'ENT-LIMIT-' || extract(epoch from clock_timestamp())::bigint,
        'washpoint', sample_booking.location_id, 'ent-limit-' || gen_random_uuid(), (now() + interval '2 days')::date);
      raise exception 'monthly booking limit did not reject the next booking';
    exception when others then
      if sqlerrm <> 'Your plan booking limit has been reached' then raise; end if;
    end;
  end if;
end
$$;

rollback;
