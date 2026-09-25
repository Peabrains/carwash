alter table public.appointments
  add column if not exists booking_source text
  check (booking_source is null or booking_source in ('walk_in','phone','whatsapp','other'));
