-- Staff invitation flow for Docket's Supabase project.
-- Apply after tenant-migration.sql, tenant-rls.sql and provider-operations.sql.

create table if not exists public.staff_invitations (
  id uuid primary key default uuid_generate_v4(),
  email text not null,
  name text,
  role text not null check (role in ('owner', 'manager', 'worker')),
  provider_id text not null references public.providers(id) on delete cascade,
  location_id text references public.locations(id) on delete cascade,
  invited_by uuid not null references auth.users(id) on delete restrict,
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists staff_invitations_pending_unique
  on public.staff_invitations (lower(email), provider_id, coalesce(location_id, ''))
  where accepted_at is null;
create index if not exists staff_invitations_provider_idx
  on public.staff_invitations(provider_id, location_id, created_at desc);

alter table public.staff_invitations enable row level security;

drop policy if exists staff_invitations_read_scoped on public.staff_invitations;
create policy staff_invitations_read_scoped on public.staff_invitations
  for select to authenticated
  using (exists (
    select 1 from public.current_staff_context() me
    where me.is_active
      and (me.role = 'platform_owner' or me.provider_id = staff_invitations.provider_id)
  ));

create or replace function public.invite_staff_member(
  p_email text,
  p_name text,
  p_role text,
  p_provider_id text,
  p_location_id text,
  p_is_active boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  actor public.staff;
  normalized_email text := lower(trim(p_email));
  target_id uuid;
  result public.staff;
  invite public.staff_invitations;
begin
  select * into actor from public.staff where id = auth.uid() and is_active;
  if actor.id is null or actor.role not in ('platform_owner', 'owner') then
    raise exception 'Only a platform owner or provider owner can manage staff';
  end if;
  if actor.role <> 'platform_owner' and actor.provider_id is distinct from p_provider_id then
    raise exception 'You can only manage staff for your own provider';
  end if;
  if normalized_email = '' or normalized_email not like '%@%' then
    raise exception 'Enter a valid staff email';
  end if;
  if p_role not in ('owner', 'manager', 'worker') then
    raise exception 'Invalid staff role';
  end if;

  select id into target_id from auth.users
  where lower(email) = normalized_email limit 1;

  if target_id is not null then
    insert into public.staff (id, email, name, role, provider_id, location_id, is_active, updated_at)
    values (target_id, normalized_email, nullif(trim(p_name), ''), p_role, p_provider_id, p_location_id, p_is_active, now())
    on conflict (id) do update set
      email = excluded.email, name = excluded.name, role = excluded.role,
      provider_id = excluded.provider_id, location_id = excluded.location_id,
      is_active = excluded.is_active, updated_at = now()
    returning * into result;
    return jsonb_build_object('status', 'active', 'staff', to_jsonb(result));
  end if;

  select * into invite from public.staff_invitations
  where lower(email) = normalized_email and provider_id = p_provider_id
    and location_id is not distinct from p_location_id and accepted_at is null
  order by created_at desc limit 1;

  if invite.id is not null then
    update public.staff_invitations set
      name = nullif(trim(p_name), ''), role = p_role, updated_at = now()
    where id = invite.id returning * into invite;
  else
    insert into public.staff_invitations(email, name, role, provider_id, location_id, invited_by)
    values (normalized_email, nullif(trim(p_name), ''), p_role, p_provider_id, p_location_id, auth.uid())
    returning * into invite;
  end if;

  return jsonb_build_object('status', 'invited', 'invitation', to_jsonb(invite));
end;
$$;

create or replace function public.accept_staff_invitation()
returns public.staff
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  current_user_id uuid := auth.uid();
  current_email text;
  invite public.staff_invitations;
  result public.staff;
begin
  if current_user_id is null then return null; end if;
  select lower(email) into current_email from auth.users where id = current_user_id;
  select * into result from public.staff where id = current_user_id limit 1;
  if result.id is not null then return result; end if;

  select * into invite from public.staff_invitations
  where lower(email) = current_email and accepted_at is null
  order by created_at asc limit 1;
  if invite.id is null then return null; end if;

  insert into public.staff (id, email, name, role, provider_id, location_id, is_active, updated_at)
  values (current_user_id, current_email, invite.name, invite.role, invite.provider_id, invite.location_id, true, now())
  returning * into result;
  update public.staff_invitations set accepted_at = now(), updated_at = now() where id = invite.id;
  return result;
end;
$$;

-- Revoke Docket access without deleting the person's Supabase Auth account.
-- Active staff are deactivated; pending invitations are cancelled. Historical
-- bookings and booking history remain intact.
create or replace function public.revoke_staff_access(
  p_staff_id uuid default null,
  p_invitation_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  actor public.staff;
  target public.staff;
  invite public.staff_invitations;
  target_email text;
begin
  select * into actor from public.staff where id = auth.uid() and is_active;
  if actor.id is null or actor.role not in ('platform_owner', 'owner') then
    raise exception 'Only a platform owner or provider owner can remove staff access';
  end if;
  if p_staff_id is null and p_invitation_id is null then
    raise exception 'Select a staff member or invitation to remove';
  end if;
  if p_staff_id is not null then
    select * into target from public.staff where id = p_staff_id;
    if target.id is null then
      raise exception 'Staff member not found';
    end if;
    if target.id = auth.uid() then
      raise exception 'You cannot remove your own access';
    end if;
    if actor.role <> 'platform_owner' and target.provider_id is distinct from actor.provider_id then
      raise exception 'You can only remove staff for your own provider';
    end if;
    target_email := lower(target.email);
    update public.staff set is_active = false, updated_at = now() where id = target.id;
  end if;
  if p_invitation_id is not null then
    select * into invite from public.staff_invitations where id = p_invitation_id and accepted_at is null;
    if invite.id is null then
      raise exception 'Pending invitation not found';
    end if;
    if actor.role <> 'platform_owner' and invite.provider_id is distinct from actor.provider_id then
      raise exception 'You can only remove invitations for your own provider';
    end if;
    if target_email is null then target_email := lower(invite.email); end if;
  end if;
  if target_email is not null then
    delete from public.staff_invitations
    where lower(email) = target_email
      and provider_id = coalesce(target.provider_id, invite.provider_id)
      and accepted_at is null;
  end if;
  return jsonb_build_object(
    'status', 'revoked',
    'staff_id', target.id,
    'invitation_id', p_invitation_id
  );
end;
$$;

revoke all on function public.invite_staff_member(text, text, text, text, text, boolean) from public, anon;
grant execute on function public.invite_staff_member(text, text, text, text, text, boolean) to authenticated;
revoke all on function public.accept_staff_invitation() from public, anon;
grant execute on function public.accept_staff_invitation() to authenticated;
revoke all on function public.revoke_staff_access(uuid, uuid) from public, anon;
grant execute on function public.revoke_staff_access(uuid, uuid) to authenticated;
