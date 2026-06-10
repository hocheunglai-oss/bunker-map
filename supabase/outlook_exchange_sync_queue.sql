create extension if not exists "pgcrypto";

create table if not exists public.outlook_exchange_sync_queue (
  id uuid primary key default gen_random_uuid(),
  action text not null check (
    action in (
      'create_contact',
      'update_contact',
      'delete_contact',
      'create_group',
      'update_group',
      'delete_group',
      'update_group_members',
      'full_sync'
    )
  ),
  entity_type text not null check (
    entity_type in ('contact', 'group', 'group_members', 'full_sync')
  ),
  entity_id text,
  entity_email text,
  entity_alias text,
  display_name text,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (
    status in ('pending', 'processing', 'completed', 'failed', 'skipped')
  ),
  attempts integer not null default 0,
  requested_by text,
  error_message text,
  exchange_verified_at timestamptz,
  processing_started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists outlook_exchange_sync_queue_status_idx
on public.outlook_exchange_sync_queue(status, created_at);

create index if not exists outlook_exchange_sync_queue_entity_idx
on public.outlook_exchange_sync_queue(entity_type, entity_id, created_at desc);

create index if not exists outlook_exchange_sync_queue_email_idx
on public.outlook_exchange_sync_queue(entity_email)
where entity_email is not null;

create index if not exists outlook_exchange_sync_queue_alias_idx
on public.outlook_exchange_sync_queue(entity_alias)
where entity_alias is not null;

alter table public.outlook_exchange_sync_queue enable row level security;

drop policy if exists "outlook_exchange_sync_queue_read" on public.outlook_exchange_sync_queue;
drop policy if exists "outlook_exchange_sync_queue_write" on public.outlook_exchange_sync_queue;

create policy "outlook_exchange_sync_queue_read"
  on public.outlook_exchange_sync_queue
  for select
  using (true);

create policy "outlook_exchange_sync_queue_write"
  on public.outlook_exchange_sync_queue
  for all
  using (true)
  with check (true);
