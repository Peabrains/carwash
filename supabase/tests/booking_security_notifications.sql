begin;

do $$
begin
  if exists (
    select 1
    from information_schema.routine_privileges
    where routine_schema = 'public'
      and grantee in ('PUBLIC', 'anon')
      and privilege_type = 'EXECUTE'
      and routine_name in (
        'current_staff_context',
        'invite_staff_member',
        'accept_staff_invitation',
        'revoke_staff_access',
        'upsert_staff_member_by_email',
        'reserve_appointment_atomic',
        'reschedule_appointment_atomic'
      )
  ) then
    raise exception 'Privileged function remains executable by PUBLIC or anon';
  end if;

  if exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and cmd = 'ALL'
      and tablename in (
        'appointments', 'bay_closures', 'bays', 'blackout_dates',
        'booking_settings', 'crew_break_schedule', 'locations', 'services'
      )
  ) then
    raise exception 'Broad ALL policy still overlaps dedicated read policy';
  end if;

  if (select count(*) from pg_policies where schemaname = 'public' and tablename = 'staff' and cmd = 'SELECT') <> 1 then
    raise exception 'Staff must have exactly one SELECT policy';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'booking_settings'
      and column_name = 'customer_change_notice_minutes'
  ) then
    raise exception 'Customer change notice setting is missing';
  end if;

  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'booking_notifications'
  ) then
    raise exception 'Booking notifications table is missing';
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgname = 'appointment_notification_queue' and not tgisinternal
  ) then
    raise exception 'Appointment notification trigger is missing';
  end if;

  if exists (
    select 1 from information_schema.routine_privileges
    where routine_schema = 'public'
      and routine_name in ('cancel_public_appointment_atomic', 'reschedule_public_appointment_atomic')
      and grantee in ('PUBLIC', 'anon', 'authenticated')
  ) then
    raise exception 'Customer change functions are exposed to browser roles';
  end if;

  if not exists (
    select 1 from information_schema.routines
    where routine_schema = 'public' and routine_name = 'claim_due_booking_notifications'
  ) then
    raise exception 'Notification claim function is missing';
  end if;

  if exists (
    select 1 from information_schema.routine_privileges
    where routine_schema = 'public'
      and routine_name = 'claim_due_booking_notifications'
      and grantee in ('PUBLIC', 'anon', 'authenticated')
  ) then
    raise exception 'Notification claim function is exposed to browser roles';
  end if;
end
$$;

rollback;
