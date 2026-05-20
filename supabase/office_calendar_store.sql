create table if not exists public.office_calendar_store (
  key text primary key,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.office_calendar_store enable row level security;

drop policy if exists "office_calendar_store_read" on public.office_calendar_store;
drop policy if exists "office_calendar_store_write" on public.office_calendar_store;

create policy "office_calendar_store_read"
  on public.office_calendar_store
  for select
  using (true);

create policy "office_calendar_store_write"
  on public.office_calendar_store
  for all
  using (true)
  with check (true);
