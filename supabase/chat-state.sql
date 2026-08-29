create table if not exists public.chat_state (
  key text primary key,
  kind text not null,
  value jsonb not null,
  expires_at bigint,
  updated_at timestamptz not null default now()
);
create index if not exists chat_state_expiry_idx on public.chat_state(expires_at);
alter table public.chat_state enable row level security;
