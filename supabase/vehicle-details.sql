-- Vehicle details required for new bookings and customer self-service lookup.
alter table public.appointments add column if not exists vehicle_plate text;
alter table public.appointments add column if not exists vehicle_make_model text;

create index if not exists idx_appointments_vehicle_plate
  on public.appointments (vehicle_plate);
