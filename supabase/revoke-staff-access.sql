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
    if target.id is null then raise exception 'Staff member not found'; end if;
    if target.id = auth.uid() then raise exception 'You cannot remove your own access'; end if;
    if actor.role <> 'platform_owner' and target.provider_id is distinct from actor.provider_id then
      raise exception 'You can only remove staff for your own provider';
    end if;
    target_email := lower(target.email);
    update public.staff set is_active = false, updated_at = now() where id = target.id;
  end if;
  if p_invitation_id is not null then
    select * into invite from public.staff_invitations where id = p_invitation_id and accepted_at is null;
    if invite.id is null then raise exception 'Pending invitation not found'; end if;
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
  return jsonb_build_object('status', 'revoked', 'staff_id', target.id, 'invitation_id', p_invitation_id);
end;
$$;

revoke all on function public.revoke_staff_access(uuid, uuid) from public, anon;
grant execute on function public.revoke_staff_access(uuid, uuid) to authenticated;
