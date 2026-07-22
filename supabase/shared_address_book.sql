create table if not exists public.shared_addressbook_contacts (
  id text primary key,
  source_book text not null,
  source_card text not null,
  display_name text not null,
  primary_email text not null,
  nickname text,
  first_name text,
  last_name text,
  vcard text,
  properties jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  unique(source_book, source_card)
);

create table if not exists public.shared_addressbook_groups (
  id text primary key,
  source_book text not null,
  source_uid text not null,
  name text not null,
  nickname text,
  description text,
  member_count integer not null default 0,
  updated_at timestamptz not null default now(),
  unique(source_book, source_uid)
);

create table if not exists public.shared_addressbook_group_members (
  group_id text not null references public.shared_addressbook_groups(id) on delete cascade,
  contact_id text not null references public.shared_addressbook_contacts(id) on delete cascade,
  source_book text not null,
  updated_at timestamptz not null default now(),
  primary key(group_id, contact_id)
);

create index if not exists shared_addressbook_contacts_email_idx
on public.shared_addressbook_contacts(primary_email);

create index if not exists shared_addressbook_groups_name_idx
on public.shared_addressbook_groups(name);

alter table public.shared_addressbook_contacts enable row level security;
alter table public.shared_addressbook_groups enable row level security;
alter table public.shared_addressbook_group_members enable row level security;

drop policy if exists "shared_addressbook_contacts_read" on public.shared_addressbook_contacts;
drop policy if exists "shared_addressbook_groups_read" on public.shared_addressbook_groups;
drop policy if exists "shared_addressbook_group_members_read" on public.shared_addressbook_group_members;
drop policy if exists "shared_addressbook_contacts_write" on public.shared_addressbook_contacts;
drop policy if exists "shared_addressbook_groups_write" on public.shared_addressbook_groups;
drop policy if exists "shared_addressbook_group_members_write" on public.shared_addressbook_group_members;

create policy "shared_addressbook_contacts_read"
  on public.shared_addressbook_contacts for select
  using (true);

create policy "shared_addressbook_groups_read"
  on public.shared_addressbook_groups for select
  using (true);

create policy "shared_addressbook_group_members_read"
  on public.shared_addressbook_group_members for select
  using (true);

revoke insert, update, delete on public.shared_addressbook_contacts from anon, authenticated;
revoke insert, update, delete on public.shared_addressbook_groups from anon, authenticated;
revoke insert, update, delete on public.shared_addressbook_group_members from anon, authenticated;

-- Transactional Exchange outbox and derived member-count triggers are installed
-- by migration 20260722040617_exchange_sync_transactional_outbox.sql.
