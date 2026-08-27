-- Fields already used by the Firebase booking API and migration snapshot.
alter table appointments add column if not exists booking_request_id text;
alter table appointments add column if not exists customer_id text;
alter table appointments add column if not exists vehicle_id text;
alter table appointments add column if not exists vehicle_plate text;
alter table appointments add column if not exists vehicle_make_model text;
create unique index if not exists appointments_request_unique on appointments(provider_id, location_id, booking_request_id)
  where booking_request_id is not null;
