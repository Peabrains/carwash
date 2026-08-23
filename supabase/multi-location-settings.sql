-- Allow each Docket location to have its own booking settings row.
-- The original single-location schema enforced id = 1.

alter table booking_settings drop constraint if exists single_row;
alter table booking_settings alter column id type bigint using id::bigint;
create unique index if not exists booking_settings_provider_location_unique on booking_settings(provider_id, location_id);
