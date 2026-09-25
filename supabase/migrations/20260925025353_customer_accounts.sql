-- Optional customer accounts. Guest bookings remain unowned; only a verified
-- authenticated user id supplied by the trusted booking API is attached.

create table public.customer_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  name text,
  phone text,
  preferences jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.customer_vehicles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  plate text not null check (length(trim(plate)) between 1 and 24),
  make_model text not null check (length(trim(make_model)) between 1 and 120),
  category text check (category is null or length(trim(category)) <= 60),
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index customer_vehicles_user_plate_idx
  on public.customer_vehicles(user_id, lower(trim(plate)));

alter table public.appointments
  add column customer_user_id uuid references auth.users(id) on delete set null;

create index appointments_customer_user_time_idx
  on public.appointments(customer_user_id, scheduled_at desc)
  where customer_user_id is not null;

alter table public.customer_profiles enable row level security;
alter table public.customer_vehicles enable row level security;

revoke all on public.customer_profiles from public, anon;
revoke all on public.customer_vehicles from public, anon;
grant select, insert, update, delete on public.customer_profiles to authenticated;
grant select, insert, update, delete on public.customer_vehicles to authenticated;
grant select on public.appointments to authenticated;

create policy customer_profiles_read_own on public.customer_profiles
for select to authenticated using ((select auth.uid()) = user_id);
create policy customer_profiles_insert_own on public.customer_profiles
for insert to authenticated with check ((select auth.uid()) = user_id);
create policy customer_profiles_update_own on public.customer_profiles
for update to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);
create policy customer_profiles_delete_own on public.customer_profiles
for delete to authenticated using ((select auth.uid()) = user_id);

create policy customer_vehicles_read_own on public.customer_vehicles
for select to authenticated using ((select auth.uid()) = user_id);
create policy customer_vehicles_insert_own on public.customer_vehicles
for insert to authenticated with check ((select auth.uid()) = user_id);
create policy customer_vehicles_update_own on public.customer_vehicles
for update to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);
create policy customer_vehicles_delete_own on public.customer_vehicles
for delete to authenticated using ((select auth.uid()) = user_id);

create policy customers_read_own_appointments on public.appointments
for select to authenticated
using ((select auth.uid()) = customer_user_id);
