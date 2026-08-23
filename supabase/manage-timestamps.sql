-- Manage-page writes use updated_at for service and bay changes.
alter table services add column if not exists updated_at timestamptz not null default now();
alter table bays add column if not exists updated_at timestamptz not null default now();
