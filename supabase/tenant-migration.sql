-- Docket Phase 1 tenant layer for the already-created core schema.
-- Safe on the empty migration project; run after schema.sql.

create table if not exists providers (
  id text primary key,
  name text not null,
  description text not null default '',
  status text not null default 'active' check (status in ('active', 'paused', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists locations (
  id text primary key,
  provider_id text not null references providers(id) on delete cascade,
  name text not null,
  address text not null default '',
  timezone text not null default 'Asia/Kuala_Lumpur',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table bays add column if not exists provider_id text references providers(id) on delete cascade;
alter table bays add column if not exists location_id text references locations(id) on delete cascade;
alter table bay_closures add column if not exists provider_id text references providers(id) on delete cascade;
alter table bay_closures add column if not exists location_id text references locations(id) on delete cascade;
alter table bay_closures add column if not exists updated_at timestamptz not null default now();
alter table crew_break_schedule add column if not exists provider_id text references providers(id) on delete cascade;
alter table crew_break_schedule add column if not exists location_id text references locations(id) on delete cascade;
alter table services add column if not exists provider_id text references providers(id) on delete cascade;
alter table services add column if not exists location_id text references locations(id) on delete cascade;
alter table appointments add column if not exists provider_id text references providers(id) on delete restrict;
alter table appointments add column if not exists location_id text references locations(id) on delete restrict;
alter table appointments add column if not exists booking_request_id text;
alter table appointments add column if not exists scheduled_date date;
alter table appointments add column if not exists updated_at timestamptz not null default now();
alter table blackout_dates add column if not exists provider_id text references providers(id) on delete cascade;
alter table blackout_dates add column if not exists location_id text references locations(id) on delete cascade;
alter table booking_settings add column if not exists provider_id text references providers(id) on delete cascade;
alter table booking_settings add column if not exists location_id text references locations(id) on delete cascade;
alter table booking_settings add column if not exists updated_at timestamptz not null default now();

alter table staff add column if not exists email text;
alter table staff add column if not exists provider_id text references providers(id) on delete set null;
alter table staff add column if not exists location_id text references locations(id) on delete set null;
alter table staff add column if not exists is_active boolean not null default true;
alter table staff add column if not exists updated_at timestamptz not null default now();
alter table staff drop constraint if exists staff_role_check;
alter table staff add constraint staff_role_check check (role in ('platform_owner', 'owner', 'manager', 'worker'));

create unique index if not exists staff_email_unique on staff(lower(email)) where email is not null;
create unique index if not exists appointments_request_unique on appointments(provider_id, location_id, booking_request_id)
  where booking_request_id is not null;
create index if not exists appointments_location_date on appointments(location_id, scheduled_date, scheduled_at);

create table if not exists booking_day_locks (
  provider_id text not null references providers(id) on delete cascade,
  location_id text not null references locations(id) on delete cascade,
  scheduled_date date not null,
  bay_id uuid not null references bays(id) on delete cascade,
  revision integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (location_id, scheduled_date, bay_id)
);

insert into providers (id, name, status)
values ('washpoint', 'WashPoint', 'active')
on conflict (id) do nothing;

insert into locations (id, provider_id, name, timezone, is_active)
values ('washpoint-main', 'washpoint', 'Main outlet', 'Asia/Kuala_Lumpur', true)
on conflict (id) do nothing;

insert into booking_settings (id, provider_id, location_id)
values (1, 'washpoint', 'washpoint-main')
on conflict (id) do update set provider_id = excluded.provider_id, location_id = excluded.location_id;

-- Backfill is intentionally separate from this structural migration. Existing
-- Firebase documents must be exported and validated before any rows are copied.
