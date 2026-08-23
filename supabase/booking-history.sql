-- Docket booking lifecycle history and calendar archival.
-- Run against the Docket production project (frfmbulazzvmxfclrjxj).

alter table appointments add column if not exists archived_at timestamptz;

create table if not exists booking_events (
  id uuid primary key default uuid_generate_v4(),
  provider_id text not null references providers(id) on delete cascade,
  location_id text not null references locations(id) on delete cascade,
  appointment_id uuid not null references appointments(id) on delete cascade,
  reference text not null,
  event_type text not null check (event_type in ('created','rescheduled','status_changed','outage_flagged','resolved','archived','note_added')),
  description text not null default '',
  old_value jsonb,
  new_value jsonb,
  actor_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists booking_events_appointment on booking_events(appointment_id, created_at desc);
create index if not exists booking_events_reference on booking_events(provider_id, location_id, reference, created_at desc);

alter table booking_events enable row level security;

drop policy if exists booking_events_read_scoped on booking_events;
drop policy if exists booking_events_insert_scoped on booking_events;

create policy booking_events_read_scoped on booking_events for select to authenticated
  using (exists (select 1 from staff me where me.id = (select auth.uid()) and me.is_active and (me.role = 'platform_owner' or me.provider_id = booking_events.provider_id)));

create policy booking_events_insert_scoped on booking_events for insert to authenticated
  with check (exists (select 1 from staff me where me.id = (select auth.uid()) and me.is_active and me.role in ('platform_owner', 'owner', 'manager') and me.provider_id = booking_events.provider_id));
