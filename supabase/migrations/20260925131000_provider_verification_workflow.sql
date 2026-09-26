-- Atomic provider verification submission and platform review workflow.

create or replace function private.bump_provider_profile_version()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_provider_id text := coalesce(new.provider_id, old.provider_id);
begin
  update public.provider_profiles
  set profile_version = profile_version + 1, updated_at = now()
  where provider_id = target_provider_id;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create or replace function private.version_provider_profile_fields()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if row(new.legal_name, new.ssm_number, new.business_phone)
     is distinct from row(old.legal_name, old.ssm_number, old.business_phone) then
    new.profile_version := old.profile_version + 1;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists provider_profile_field_version on public.provider_profiles;
create trigger provider_profile_field_version
before update on public.provider_profiles
for each row execute function private.version_provider_profile_fields();

drop trigger if exists locations_provider_profile_version on public.locations;
create trigger locations_provider_profile_version
after insert or update or delete on public.locations
for each row execute function private.bump_provider_profile_version();

drop trigger if exists booking_settings_provider_profile_version on public.booking_settings;
create trigger booking_settings_provider_profile_version
after insert or update or delete on public.booking_settings
for each row execute function private.bump_provider_profile_version();

drop trigger if exists bays_provider_profile_version on public.bays;
create trigger bays_provider_profile_version
after insert or update or delete on public.bays
for each row execute function private.bump_provider_profile_version();

drop trigger if exists services_provider_profile_version on public.services;
create trigger services_provider_profile_version
after insert or update or delete on public.services
for each row execute function private.bump_provider_profile_version();

-- Review records are immutable to ordinary table updates. Platform decisions
-- pass through the guarded RPC below.
drop policy if exists provider_verifications_platform_update on public.provider_verifications;

create or replace function public.prepare_provider_verification_upload(
  p_kind text,
  p_filename text,
  p_content_type text,
  p_size_bytes bigint
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor public.staff;
  extension text;
begin
  select * into actor from public.staff where id = auth.uid() and is_active;
  if actor.id is null or actor.role <> 'owner' or actor.provider_id is null then
    raise exception 'Provider owner access required';
  end if;
  if p_kind not in ('ssm', 'storefront') then raise exception 'Invalid verification document kind'; end if;
  if p_content_type not in ('application/pdf', 'image/jpeg', 'image/png') then
    raise exception 'Upload a PDF, JPEG or PNG file';
  end if;
  if p_size_bytes is null or p_size_bytes <= 0 or p_size_bytes > 10485760 then
    raise exception 'Verification files must be 10 MB or smaller';
  end if;
  extension := case p_content_type when 'application/pdf' then 'pdf' when 'image/jpeg' then 'jpg' else 'png' end;
  return actor.provider_id || '/' || p_kind || '/' || gen_random_uuid()::text || '.' || extension;
end;
$$;

create or replace function public.submit_provider_verification(
  p_ssm_document_path text,
  p_storefront_photo_path text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor public.staff;
  profile public.provider_profiles;
  submission_version integer;
  created public.provider_verifications;
  snapshot jsonb;
begin
  select * into actor from public.staff where id = auth.uid() and is_active;
  if actor.id is null or actor.role <> 'owner' or actor.provider_id is null then
    raise exception 'Provider owner access required';
  end if;
  select * into profile from public.provider_profiles where provider_id = actor.provider_id for update;
  if profile.provider_id is null then raise exception 'Complete your provider profile first'; end if;
  if trim(profile.legal_name) = '' or trim(profile.ssm_number) = '' or trim(profile.business_phone) = '' then
    raise exception 'Complete your business profile before submitting';
  end if;
  if p_ssm_document_path not like actor.provider_id || '/ssm/%'
     or p_storefront_photo_path not like actor.provider_id || '/storefront/%' then
    raise exception 'Both verification documents must belong to your provider workspace';
  end if;
  if not exists (select 1 from storage.objects where bucket_id = 'provider-verification' and name = p_ssm_document_path)
     or not exists (select 1 from storage.objects where bucket_id = 'provider-verification' and name = p_storefront_photo_path) then
    raise exception 'Upload both verification documents before submitting';
  end if;
  if exists (select 1 from public.provider_verifications where provider_id = actor.provider_id and status = 'pending_review') then
    raise exception 'A verification submission is already under review';
  end if;

  select coalesce(max(v.submission_version), 0) + 1 into submission_version
  from public.provider_verifications v where v.provider_id = actor.provider_id;
  select jsonb_build_object(
    'profile_version', profile.profile_version,
    'provider', to_jsonb(p),
    'profile', to_jsonb(profile) - 'updated_at',
    'locations', coalesce((select jsonb_agg(to_jsonb(l) order by l.created_at) from public.locations l where l.provider_id = actor.provider_id), '[]'::jsonb),
    'booking_settings', coalesce((select jsonb_agg(to_jsonb(bs) order by bs.location_id) from public.booking_settings bs where bs.provider_id = actor.provider_id), '[]'::jsonb),
    'bays', coalesce((select jsonb_agg(to_jsonb(b) order by b.location_id, b.name) from public.bays b where b.provider_id = actor.provider_id), '[]'::jsonb),
    'services', coalesce((select jsonb_agg(to_jsonb(s) order by s.location_id, s.name) from public.services s where s.provider_id = actor.provider_id), '[]'::jsonb),
    'subscription', (select to_jsonb(ps) from public.provider_subscriptions ps where ps.provider_id = actor.provider_id)
  ) into snapshot from public.providers p where p.id = actor.provider_id;

  insert into public.provider_verifications(
    provider_id, submission_version, ssm_document_path, storefront_photo_path,
    submitted_snapshot, status, submitted_by
  ) values (
    actor.provider_id, submission_version, p_ssm_document_path, p_storefront_photo_path,
    snapshot, 'pending_review', actor.id
  ) returning * into created;
  update public.provider_profiles set marketplace_status = 'pending_review' where provider_id = actor.provider_id;
  return to_jsonb(created) - 'ssm_document_path' - 'storefront_photo_path';
end;
$$;

create or replace function public.decide_provider_verification(
  p_verification_id uuid,
  p_decision text,
  p_reason text,
  p_suspend_operations boolean,
  p_expected_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor public.staff;
  verification public.provider_verifications;
  profile public.provider_profiles;
  captured_version integer;
begin
  select * into actor from public.staff where id = auth.uid() and is_active;
  if actor.id is null or actor.role <> 'platform_owner' then raise exception 'Platform owner access required'; end if;
  if p_decision not in ('approved', 'changes_requested', 'rejected', 'suspended') then raise exception 'Invalid verification decision'; end if;
  if p_decision <> 'approved' and trim(coalesce(p_reason, '')) = '' then raise exception 'A reason is required for this decision'; end if;

  select * into verification from public.provider_verifications where id = p_verification_id for update;
  if verification.id is null then raise exception 'Verification submission not found'; end if;
  if verification.status <> 'pending_review' then raise exception 'This submission has already been reviewed'; end if;
  select * into profile from public.provider_profiles where provider_id = verification.provider_id for update;
  captured_version := (verification.submitted_snapshot->>'profile_version')::integer;
  if p_expected_version is distinct from captured_version then raise exception 'The review version is stale'; end if;
  if p_decision = 'approved' and profile.profile_version is distinct from captured_version then
    raise exception 'Provider details changed after submission; request a new submission';
  end if;

  update public.provider_verifications set status = p_decision, decision_reason = trim(coalesce(p_reason, '')),
    reviewed_by = actor.id, reviewed_at = now(), updated_at = now()
  where id = verification.id returning * into verification;
  update public.provider_profiles set marketplace_status = p_decision,
    reviewed_version = case when p_decision = 'approved' then captured_version else reviewed_version end,
    operations_suspended = case
      when p_decision = 'approved' then false
      when p_decision = 'suspended' then coalesce(p_suspend_operations, false)
      else operations_suspended
    end
  where provider_id = verification.provider_id;
  return to_jsonb(verification) - 'ssm_document_path' - 'storefront_photo_path';
end;
$$;

revoke all on function public.prepare_provider_verification_upload(text,text,text,bigint) from public, anon, authenticated;
grant execute on function public.prepare_provider_verification_upload(text,text,text,bigint) to authenticated;
revoke all on function public.submit_provider_verification(text,text) from public, anon, authenticated;
grant execute on function public.submit_provider_verification(text,text) to authenticated;
revoke all on function public.decide_provider_verification(uuid,text,text,boolean,integer) from public, anon, authenticated;
grant execute on function public.decide_provider_verification(uuid,text,text,boolean,integer) to authenticated;
