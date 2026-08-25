-- Atomic Supabase booking reservation.
-- Run this once in the Docket Supabase SQL editor.
--
-- Every booking writer must use this function. The advisory transaction lock
-- serializes reservations for one provider/location/day, preventing two
-- concurrent requests from selecting the same bay from the same snapshot.

create or replace function public.reserve_appointment_atomic(
  p_provider_id text,
  p_location_id text,
  p_booking_request_id text,
  p_customer_chat_id text,
  p_customer_name text,
  p_customer_phone text,
  p_channel text,
  p_service_id uuid,
  p_scheduled_date date,
  p_time text,
  p_reference text
)
returns table (
  result_status text,
  appointment_reference text,
  result_service_id uuid,
  result_service_name text,
  result_duration_minutes integer,
  result_price_myr numeric
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_service services%rowtype;
  v_settings booking_settings%rowtype;
  v_bay bays%rowtype;
  v_existing appointments%rowtype;
  v_start timestamptz;
  v_end timestamptz;
  v_today date;
  v_open time;
  v_close time;
  v_is_weekend boolean;
begin
  if nullif(trim(p_provider_id), '') is null
     or nullif(trim(p_location_id), '') is null
     or nullif(trim(p_booking_request_id), '') is null
     or nullif(trim(p_reference), '') is null
     or p_service_id is null
     or p_scheduled_date is null
     or p_time !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
    return query select 'unavailable', p_reference, null::uuid, null::text, null::integer, null::numeric;
    return;
  end if;

  -- All writers using this function serialize against each other for the
  -- same booking day. This lock is transaction-scoped and releases on return.
  perform pg_advisory_xact_lock(
    hashtextextended(p_provider_id || ':' || p_location_id || ':' || p_scheduled_date::text, 0)
  );

  select * into v_existing
  from appointments
  where provider_id = p_provider_id
    and location_id = p_location_id
    and booking_request_id = p_booking_request_id
  limit 1;

  if found then
    select * into v_service from services where id = v_existing.service_id;
    return query select
      'existing',
      v_existing.reference,
      v_service.id,
      v_service.name,
      v_service.duration_minutes,
      v_service.price_myr;
    return;
  end if;

  select * into v_service
  from services
  where id = p_service_id
    and provider_id = p_provider_id
    and location_id = p_location_id
    and is_active = true;

  select * into v_settings
  from booking_settings
  where provider_id = p_provider_id
    and location_id = p_location_id
  limit 1;

  if not found or v_service.id is null then
    return query select 'unavailable', p_reference, null::uuid, null::text, null::integer, null::numeric;
    return;
  end if;

  v_today := (now() at time zone 'Asia/Kuala_Lumpur')::date;
  if p_scheduled_date < v_today
     or p_scheduled_date > v_today + greatest(v_settings.max_advance_days, 0) then
    return query select 'unavailable', p_reference, v_service.id, v_service.name, v_service.duration_minutes, v_service.price_myr;
    return;
  end if;

  if exists (
    select 1 from blackout_dates
    where provider_id = p_provider_id
      and location_id = p_location_id
      and date = p_scheduled_date
  ) then
    return query select 'unavailable', p_reference, v_service.id, v_service.name, v_service.duration_minutes, v_service.price_myr;
    return;
  end if;

  v_is_weekend := extract(dow from p_scheduled_date) in (0, 6);
  v_open := case when v_is_weekend then v_settings.weekend_open else v_settings.weekday_open end;
  v_close := case when v_is_weekend then v_settings.weekend_close else v_settings.weekday_close end;
  v_start := (p_scheduled_date + p_time::time) at time zone 'Asia/Kuala_Lumpur';
  v_end := v_start + make_interval(mins => v_service.duration_minutes);

  if p_time::time < v_open
     or (p_time::time + make_interval(mins => v_service.duration_minutes)) > v_close
     or v_start < now() + make_interval(mins => greatest(v_settings.min_lead_minutes, 0)) then
    return query select 'unavailable', p_reference, v_service.id, v_service.name, v_service.duration_minutes, v_service.price_myr;
    return;
  end if;

  -- Lock candidate bay rows while selecting one. The advisory lock is the
  -- cross-request guard; row locks keep this transaction's selection stable.
  for v_bay in
    select * from bays
    where provider_id = p_provider_id
      and location_id = p_location_id
      and is_active = true
      and status = 'open'
    order by id
    for update
  loop
    if not exists (
      select 1 from appointments a
      where a.provider_id = p_provider_id
        and a.location_id = p_location_id
        and a.scheduled_date = p_scheduled_date
        and a.status <> 'cancelled'
        and a.bay_id = v_bay.id
        and v_start < a.scheduled_at + make_interval(mins => a.duration_minutes + greatest(v_settings.buffer_minutes, 0))
        and a.scheduled_at < v_end + make_interval(mins => greatest(v_settings.buffer_minutes, 0))
    )
    and not exists (
      select 1 from crew_break_schedule b
      where b.provider_id = p_provider_id
        and b.location_id = p_location_id
        and b.bay_id = v_bay.id
        and v_start < ((p_scheduled_date + b.start_time) at time zone 'Asia/Kuala_Lumpur') + make_interval(mins => b.duration_minutes)
        and ((p_scheduled_date + b.start_time) at time zone 'Asia/Kuala_Lumpur') < v_end
    )
    and not exists (
      select 1 from bay_closures c
      where c.provider_id = p_provider_id
        and c.location_id = p_location_id
        and c.bay_id = v_bay.id
        and c.starts_at < v_end
        and c.ends_at > v_start
    ) then
      insert into appointments (
        provider_id, location_id, booking_request_id, customer_chat_id,
        customer_name, customer_phone, channel, bay_id, service_id,
        scheduled_at, scheduled_date, duration_minutes, price_myr, status,
        reference
      ) values (
        p_provider_id, p_location_id, p_booking_request_id, p_customer_chat_id,
        p_customer_name, p_customer_phone, p_channel, v_bay.id, v_service.id,
        v_start, p_scheduled_date, v_service.duration_minutes, v_service.price_myr,
        'confirmed', p_reference
      );

      return query select
        'created', p_reference, v_service.id, v_service.name,
        v_service.duration_minutes, v_service.price_myr;
      return;
    end if;
  end loop;

  return query select
    'unavailable', p_reference, v_service.id, v_service.name,
    v_service.duration_minutes, v_service.price_myr;
end;
$$;

revoke execute on function public.reserve_appointment_atomic(text, text, text, text, text, text, text, uuid, date, text, text) from public, anon, authenticated;
grant execute on function public.reserve_appointment_atomic(text, text, text, text, text, text, text, uuid, date, text, text) to service_role;
