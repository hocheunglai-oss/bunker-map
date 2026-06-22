create extension if not exists "pgcrypto";

create table if not exists public.whatsapp_conversations (
  id uuid primary key default gen_random_uuid(),
  phone_e164 text not null,
  display_name text,
  company text,
  assigned_to text,
  status text not null default 'open',
  tags text[] not null default '{}',
  last_message_preview text,
  last_message_at timestamptz,
  unread_count integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint whatsapp_conversations_phone_key unique (phone_e164),
  constraint whatsapp_conversations_status_check check (status in ('open', 'pending', 'closed'))
);

create table if not exists public.whatsapp_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.whatsapp_conversations(id) on delete cascade,
  whatsapp_message_id text,
  direction text not null,
  message_type text not null default 'text',
  body text,
  media_url text,
  status text not null default 'received',
  from_phone text,
  to_phone text,
  payload jsonb not null default '{}'::jsonb,
  sent_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint whatsapp_messages_direction_check check (direction in ('inbound', 'outbound', 'status'))
);

drop index if exists public.whatsapp_messages_whatsapp_message_id_key;

create unique index if not exists whatsapp_messages_whatsapp_message_id_key
on public.whatsapp_messages(whatsapp_message_id);

create index if not exists whatsapp_conversations_last_message_idx
on public.whatsapp_conversations(last_message_at desc nulls last);

create index if not exists whatsapp_messages_conversation_sent_idx
on public.whatsapp_messages(conversation_id, sent_at);

alter table public.whatsapp_conversations enable row level security;
alter table public.whatsapp_messages enable row level security;

drop policy if exists "whatsapp_conversations_read" on public.whatsapp_conversations;
drop policy if exists "whatsapp_conversations_write" on public.whatsapp_conversations;
drop policy if exists "whatsapp_messages_read" on public.whatsapp_messages;
drop policy if exists "whatsapp_messages_write" on public.whatsapp_messages;

create policy "whatsapp_conversations_read"
  on public.whatsapp_conversations
  for select
  using (true);

create policy "whatsapp_conversations_write"
  on public.whatsapp_conversations
  for all
  using (true)
  with check (true);

create policy "whatsapp_messages_read"
  on public.whatsapp_messages
  for select
  using (true);

create policy "whatsapp_messages_write"
  on public.whatsapp_messages
  for all
  using (true)
  with check (true);
