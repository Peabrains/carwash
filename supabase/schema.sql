-- Wash Point — core schema
-- Run this in the Supabase SQL editor (or via `supabase db push`) after creating the project.
--
-- Customers book via Telegram/WhatsApp (not this schema's concern — the bot
-- writes here directly using the service_role key, bypassing RLS). This PWA
-- is staff/owner-only: bay board, settings, crew break configuration.

create extension if not exists "uuid-ossp";

-- ── Bays ──────────────────────────────────────────────────────────────
create table bays (
  id uuid primary key default uuid_generate_v4(),
  name text not null,                 -- e.g. "Bay 1"
  is_active boolean not null default true,   -- indefinite on/off switch
  status text not null default 'open' check (status in ('open','maintenance','closed')),
  created_at timestamptz not null default now()
);

-- One-off planned/in-progress closures for a specific time window (does NOT require is_active = false)
create table bay_closures (
  id uuid primary key default uuid_generate_v4(),
  bay_id uuid not null references bays(id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  reason text,
  created_by uuid,                    -- staff user id
  created_at timestamptz not null default now()
);

-- Recurring daily crew break per bay (e.g. staggered lunch, kept outside peak
-- hours so bays don't all lose capacity at once). Applied every day — the
-- availability check synthesizes today's window from this pattern rather
-- than requiring a new bay_closures row to be entered daily.
create table crew_break_schedule (
  id uuid primary key default uuid_generate_v4(),
  bay_id uuid not null references bays(id) on delete cascade,
  start_time time not null,
  duration_minutes int not null check (duration_minutes > 0),
  created_at timestamptz not null default now()
);

-- ── Services ──────────────────────────────────────────────────────────
create table services (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  duration_minutes int not null check (duration_minutes > 0),
  price_myr numeric(10,2) not null check (price_myr >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

-- ── Appointments ─────────────────────────────────────────────────────
-- Customers are identified by their messaging chat_id, not a Supabase Auth
-- account — booking happens entirely through the Telegram/WhatsApp bot.
create table appointments (
  id uuid primary key default uuid_generate_v4(),
  customer_chat_id text not null,
  customer_name text,
  channel text not null default 'telegram' check (channel in ('telegram','whatsapp')),
  vehicle_plate text,
  bay_id uuid not null references bays(id),
  service_id uuid not null references services(id),
  scheduled_at timestamptz not null,
  duration_minutes int not null,        -- snapshot from service at booking time
  price_myr numeric(10,2) not null,     -- snapshot from service at booking time
  status text not null default 'pending'
    check (status in ('pending','confirmed','in_progress','completed','cancelled','no_show')),
  payment_status text not null default 'unpaid'
    check (payment_status in ('unpaid','paid','refunded')),
  needs_attention boolean not null default false,  -- flagged when its bay goes down unplanned
  reference text unique not null,       -- customer-facing booking ref, e.g. WP-2026-08061020
  created_at timestamptz not null default now()
);

create index idx_appointments_bay_time on appointments (bay_id, scheduled_at);
create index idx_appointments_chat on appointments (customer_chat_id, scheduled_at desc);

-- ── Booking window settings (single row, staff-editable) ───────────────
create table booking_settings (
  id int primary key default 1,
  min_lead_minutes int not null default 60,
  max_advance_days int not null default 14,
  buffer_minutes int not null default 15,   -- rest time after each wash before a bay can be rebooked
  weekday_open time not null default '08:00',
  weekday_close time not null default '19:00',
  weekend_open time not null default '08:00',
  weekend_close time not null default '21:00',
  constraint single_row check (id = 1)
);
insert into booking_settings (id) values (1);

create table blackout_dates (
  id uuid primary key default uuid_generate_v4(),
  date date not null unique,
  label text
);

-- ── Staff (owner/worker) ────────────────────────────────────────────────
create table staff (
  id uuid primary key references auth.users (id) on delete cascade,
  role text not null check (role in ('owner', 'worker')),
  name text,
  created_at timestamptz not null default now()
);

-- ── Row Level Security ───────────────────────────────────────────────
alter table bays enable row level security;
alter table bay_closures enable row level security;
alter table crew_break_schedule enable row level security;
alter table services enable row level security;
alter table appointments enable row level security;
alter table booking_settings enable row level security;
alter table blackout_dates enable row level security;
alter table staff enable row level security;

create policy "staff can read own row" on staff for select using (id = auth.uid());

-- Owner: full access to configuration tables.
create policy "owner full access to bays" on bays for all
  using (exists (select 1 from staff s where s.id = auth.uid() and s.role = 'owner'))
  with check (exists (select 1 from staff s where s.id = auth.uid() and s.role = 'owner'));
create policy "owner full access to bay_closures" on bay_closures for all
  using (exists (select 1 from staff s where s.id = auth.uid() and s.role = 'owner'))
  with check (exists (select 1 from staff s where s.id = auth.uid() and s.role = 'owner'));
create policy "owner full access to crew_break_schedule" on crew_break_schedule for all
  using (exists (select 1 from staff s where s.id = auth.uid() and s.role = 'owner'))
  with check (exists (select 1 from staff s where s.id = auth.uid() and s.role = 'owner'));
create policy "owner full access to services" on services for all
  using (exists (select 1 from staff s where s.id = auth.uid() and s.role = 'owner'))
  with check (exists (select 1 from staff s where s.id = auth.uid() and s.role = 'owner'));
create policy "owner full access to booking_settings" on booking_settings for all
  using (exists (select 1 from staff s where s.id = auth.uid() and s.role = 'owner'))
  with check (exists (select 1 from staff s where s.id = auth.uid() and s.role = 'owner'));
create policy "owner full access to blackout_dates" on blackout_dates for all
  using (exists (select 1 from staff s where s.id = auth.uid() and s.role = 'owner'))
  with check (exists (select 1 from staff s where s.id = auth.uid() and s.role = 'owner'));

-- Bays/services are read-only reference data for workers (bay board needs bay names).
create policy "worker can view bays" on bays for select
  using (exists (select 1 from staff s where s.id = auth.uid() and s.role = 'worker'));
create policy "worker can view services" on services for select
  using (exists (select 1 from staff s where s.id = auth.uid() and s.role = 'worker'));

-- Appointments: any staff can view (this is the "workers see incoming demand"
-- requirement); only owner can create/edit/cancel via the PWA. The bot writes
-- appointments separately using the service_role key, bypassing RLS.
create policy "staff can view appointments" on appointments for select
  using (exists (select 1 from staff s where s.id = auth.uid()));
create policy "owner can insert appointments" on appointments for insert
  with check (exists (select 1 from staff s where s.id = auth.uid() and s.role = 'owner'));
create policy "owner can update appointments" on appointments for update
  using (exists (select 1 from staff s where s.id = auth.uid() and s.role = 'owner'))
  with check (exists (select 1 from staff s where s.id = auth.uid() and s.role = 'owner'));
create policy "owner can delete appointments" on appointments for delete
  using (exists (select 1 from staff s where s.id = auth.uid() and s.role = 'owner'));
