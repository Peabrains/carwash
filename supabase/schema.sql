-- Wash Point — core schema
-- Run this in the Supabase SQL editor (or via `supabase db push`) after creating the project.

create extension if not exists "uuid-ossp";

-- ── Bays ──────────────────────────────────────────────────────────────
create table bays (
  id uuid primary key default uuid_generate_v4(),
  name text not null,                 -- e.g. "Bay 1"
  is_active boolean not null default true,   -- indefinite on/off switch
  status text not null default 'open' check (status in ('open','maintenance','closed')),
  created_at timestamptz not null default now()
);

-- Planned or in-progress closures for a specific time window (does NOT require is_active = false)
create table bay_closures (
  id uuid primary key default uuid_generate_v4(),
  bay_id uuid not null references bays(id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  reason text,
  created_by uuid,                    -- staff user id
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

-- ── Customers (mirrors auth.users; Supabase Auth handles phone OTP) ────
create table customers (
  id uuid primary key references auth.users(id) on delete cascade,
  phone text unique not null,
  full_name text,
  email text,
  created_at timestamptz not null default now()
);

create table vehicles (
  id uuid primary key default uuid_generate_v4(),
  customer_id uuid not null references customers(id) on delete cascade,
  plate_no text not null,
  make_model text,
  notes text,
  created_at timestamptz not null default now()
);

-- ── Appointments ─────────────────────────────────────────────────────
create table appointments (
  id uuid primary key default uuid_generate_v4(),
  customer_id uuid not null references customers(id),
  vehicle_id uuid references vehicles(id),
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
create index idx_appointments_customer on appointments (customer_id, scheduled_at desc);

-- ── Booking window settings (single row, staff-editable) ───────────────
create table booking_settings (
  id int primary key default 1,
  min_lead_minutes int not null default 60,
  max_advance_days int not null default 14,
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

-- ── Row Level Security ───────────────────────────────────────────────
alter table customers enable row level security;
alter table vehicles enable row level security;
alter table appointments enable row level security;

-- customers can only see/edit their own row
create policy "customers read own" on customers for select using (auth.uid() = id);
create policy "customers update own" on customers for update using (auth.uid() = id);

-- vehicles/appointments scoped to owning customer
create policy "vehicles read own" on vehicles for select using (
  auth.uid() = (select customer_id from vehicles v where v.id = vehicles.id)
);
create policy "vehicles crud own" on vehicles for all using (auth.uid() = customer_id);

create policy "appointments read own" on appointments for select using (auth.uid() = customer_id);
create policy "appointments insert own" on appointments for insert with check (auth.uid() = customer_id);

-- Staff role: bays, services, booking_settings, blackout_dates, bay_closures, and ALL appointments
-- are managed via a `staff` custom claim/role checked through a Supabase Auth policy or service-role key
-- from a protected staff-only route — not exposed to the anon/customer client. See README for setup.
