-- Atomically claim due Telegram notifications so concurrent workers cannot
-- deliver the same message. Stale claims are recovered after 15 minutes.

create or replace function public.claim_due_booking_notifications(p_limit integer default 25)
returns setof public.booking_notifications
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.booking_notifications
  set status = 'failed',
      last_error = coalesce(last_error, 'Delivery worker did not finish'),
      updated_at = now()
  where status = 'processing'
    and attempts >= 4
    and updated_at <= now() - interval '15 minutes';

  return query
  with due as (
    select id
    from public.booking_notifications
    where channel = 'telegram'
      and attempts < 4
      and (
        (status = 'pending' and scheduled_for <= now())
        or (status = 'processing' and updated_at <= now() - interval '15 minutes')
      )
    order by scheduled_for, created_at
    limit least(greatest(coalesce(p_limit, 25), 1), 100)
    for update skip locked
  )
  update public.booking_notifications notification
  set status = 'processing',
      attempts = notification.attempts + 1,
      updated_at = now()
  from due
  where notification.id = due.id
  returning notification.*;
end;
$$;

revoke all on function public.claim_due_booking_notifications(integer) from public, anon, authenticated;
grant execute on function public.claim_due_booking_notifications(integer) to service_role;
