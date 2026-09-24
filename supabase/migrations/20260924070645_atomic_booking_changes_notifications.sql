-- Atomic customer booking changes and durable Telegram notifications.

alter table public.booking_settings
  add column if not exists customer_change_notice_minutes integer not null default 60
  check (customer_change_notice_minutes >= 0 and customer_change_notice_minutes <= 10080);

create table if not exists public.booking_notifications (
  id uuid primary key default gen_random_uuid(),
  provider_id text not null references public.providers(id) on delete cascade,
  location_id text not null references public.locations(id) on delete cascade,
  appointment_id uuid not null references public.appointments(id) on delete cascade,
  notification_type text not null check (notification_type in ('confirmed','reminder_24h','reminder_2h','cancelled','rescheduled')),
  channel text not null default 'telegram' check (channel = 'telegram'),
  recipient_chat_id text,
  scheduled_for timestamptz not null,
  status text not null default 'pending' check (status in ('pending','processing','sent','failed','cancelled')),
  attempts integer not null default 0,
  idempotency_key text not null unique,
  last_error text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists booking_notifications_due_idx
  on public.booking_notifications(status, scheduled_for)
  where status in ('pending','failed');

alter table public.booking_notifications enable row level security;
revoke all on public.booking_notifications from public, anon, authenticated;
grant select on public.booking_notifications to authenticated;

drop policy if exists booking_notifications_read_scoped on public.booking_notifications;
create policy booking_notifications_read_scoped on public.booking_notifications
for select to authenticated
using (exists (
  select 1 from private.current_staff_context() me
  where me.is_active
    and (me.role = 'platform_owner' or me.provider_id = booking_notifications.provider_id)
    and (me.location_id is null or me.location_id = booking_notifications.location_id)
));

create or replace function private.queue_booking_notifications(
  p_appointment public.appointments,
  p_event text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_schedule_key text := extract(epoch from p_appointment.scheduled_at)::bigint::text;
begin
  if nullif(trim(p_appointment.customer_chat_id), '') is null
     or p_appointment.channel <> 'telegram' then
    return;
  end if;

  if p_event in ('cancelled', 'rescheduled') then
    update public.booking_notifications
    set status = 'cancelled', updated_at = now()
    where appointment_id = p_appointment.id
      and notification_type in ('reminder_24h', 'reminder_2h')
      and status in ('pending', 'failed');
  end if;

  if p_event in ('confirmed', 'cancelled', 'rescheduled') then
    insert into public.booking_notifications(
      provider_id, location_id, appointment_id, notification_type,
      recipient_chat_id, scheduled_for, idempotency_key
    ) values (
      p_appointment.provider_id, p_appointment.location_id, p_appointment.id,
      p_event, p_appointment.customer_chat_id, now(),
      p_appointment.id::text || ':' || p_event || ':' || v_schedule_key
    ) on conflict (idempotency_key) do nothing;
  end if;

  if p_event in ('confirmed', 'rescheduled') and p_appointment.status = 'confirmed' then
    if p_appointment.scheduled_at - interval '24 hours' > now() then
      insert into public.booking_notifications(
        provider_id, location_id, appointment_id, notification_type,
        recipient_chat_id, scheduled_for, idempotency_key
      ) values (
        p_appointment.provider_id, p_appointment.location_id, p_appointment.id,
        'reminder_24h', p_appointment.customer_chat_id,
        p_appointment.scheduled_at - interval '24 hours',
        p_appointment.id::text || ':reminder_24h:' || v_schedule_key
      ) on conflict (idempotency_key) do nothing;
    end if;

    if p_appointment.scheduled_at - interval '2 hours' > now() then
      insert into public.booking_notifications(
        provider_id, location_id, appointment_id, notification_type,
        recipient_chat_id, scheduled_for, idempotency_key
      ) values (
        p_appointment.provider_id, p_appointment.location_id, p_appointment.id,
        'reminder_2h', p_appointment.customer_chat_id,
        p_appointment.scheduled_at - interval '2 hours',
        p_appointment.id::text || ':reminder_2h:' || v_schedule_key
      ) on conflict (idempotency_key) do nothing;
    end if;
  end if;
end;
$$;

revoke all on function private.queue_booking_notifications(public.appointments, text) from public, anon, authenticated;

create or replace function private.appointment_notification_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform private.queue_booking_notifications(new, 'confirmed');
  elsif new.status = 'cancelled' and old.status is distinct from 'cancelled' then
    perform private.queue_booking_notifications(new, 'cancelled');
  elsif new.scheduled_at is distinct from old.scheduled_at then
    perform private.queue_booking_notifications(new, 'rescheduled');
  end if;
  return new;
end;
$$;

drop trigger if exists appointment_notification_queue on public.appointments;
create trigger appointment_notification_queue
after insert or update of status, scheduled_at on public.appointments
for each row execute function private.appointment_notification_trigger();

create or replace function public.cancel_public_appointment_atomic(p_appointment_id uuid)
returns table (appointment_id uuid, result_status text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_appointment public.appointments%rowtype;
  v_notice integer;
begin
  select * into v_appointment
  from public.appointments
  where id = p_appointment_id
  for update;

  if not found then raise exception 'Booking not found'; end if;
  if v_appointment.status in ('cancelled', 'completed', 'no_show') then
    raise exception 'This booking can no longer be changed';
  end if;

  select customer_change_notice_minutes into v_notice
  from public.booking_settings
  where provider_id = v_appointment.provider_id and location_id = v_appointment.location_id
  limit 1;

  if v_appointment.scheduled_at <= now() + make_interval(mins => greatest(coalesce(v_notice, 60), 0)) then
    raise exception 'This booking is too close to its appointment time to change online';
  end if;

  update public.appointments
  set status = 'cancelled', updated_at = now()
  where id = v_appointment.id;

  insert into public.booking_events(
    provider_id, location_id, appointment_id, reference, event_type,
    description, old_value, new_value
  ) values (
    v_appointment.provider_id, v_appointment.location_id, v_appointment.id,
    v_appointment.reference, 'status_changed', 'Customer cancelled the booking online',
    jsonb_build_object('status', v_appointment.status), jsonb_build_object('status', 'cancelled')
  );

  return query select v_appointment.id, 'cancelled'::text;
end;
$$;

revoke all on function public.cancel_public_appointment_atomic(uuid) from public, anon, authenticated;
grant execute on function public.cancel_public_appointment_atomic(uuid) to service_role;

create or replace function public.reschedule_public_appointment_atomic(
  p_appointment_id uuid,
  p_scheduled_date date,
  p_time text
)
returns table (
  appointment_id uuid,
  result_bay_id uuid,
  result_scheduled_date date,
  result_scheduled_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_appointment public.appointments%rowtype;
  v_result record;
  v_notice integer;
begin
  select * into v_appointment from public.appointments where id = p_appointment_id for update;
  if not found then raise exception 'Booking not found'; end if;
  if v_appointment.status in ('cancelled', 'completed', 'no_show') then
    raise exception 'This booking can no longer be changed';
  end if;
  select customer_change_notice_minutes into v_notice from public.booking_settings
  where provider_id = v_appointment.provider_id and location_id = v_appointment.location_id limit 1;
  if v_appointment.scheduled_at <= now() + make_interval(mins => greatest(coalesce(v_notice, 60), 0)) then
    raise exception 'This booking is too close to its appointment time to change online';
  end if;

  select * into v_result
  from public.reschedule_appointment_atomic(p_appointment_id, p_scheduled_date, p_time, null);

  insert into public.booking_events(
    provider_id, location_id, appointment_id, reference, event_type,
    description, old_value, new_value
  ) values (
    v_appointment.provider_id, v_appointment.location_id, v_appointment.id,
    v_appointment.reference, 'rescheduled', 'Customer rescheduled the booking online',
    jsonb_build_object('scheduled_date', v_appointment.scheduled_date, 'scheduled_at', v_appointment.scheduled_at),
    jsonb_build_object('scheduled_date', v_result.result_scheduled_date, 'scheduled_at', v_result.result_scheduled_at)
  );

  return query select v_result.appointment_id, v_result.result_bay_id,
    v_result.result_scheduled_date, v_result.result_scheduled_at;
end;
$$;

revoke all on function public.reschedule_public_appointment_atomic(uuid, date, text) from public, anon, authenticated;
grant execute on function public.reschedule_public_appointment_atomic(uuid, date, text) to service_role;
