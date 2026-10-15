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

-- Transactional Exchange outbox and updated_at triggers are installed by
-- migration 20260722045125_exchange_sync_transactional_outbox.sql. The current
-- count function matches 20261015072659_serialize_outlook_group_membership_counts.sql.
create or replace function public.outlook_addressbook_refresh_member_count()
returns trigger
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  affected_ids text[];
  affected_group_id text;
begin
  if tg_table_schema <> 'public'
    or tg_table_name <> 'shared_addressbook_group_members'
    or tg_when <> 'AFTER' or tg_level <> 'ROW'
    or tg_op not in ('INSERT', 'UPDATE', 'DELETE')
  then
    raise exception 'Member-count function requires its canonical row trigger.';
  end if;

  select pg_catalog.array_agg(affected.group_id order by affected.group_id)
  into affected_ids
  from (
    select distinct group_id
    from (values
      (case when tg_op in ('UPDATE', 'DELETE') then old.group_id else null end),
      (case when tg_op in ('INSERT', 'UPDATE') then new.group_id else null end)
    ) as candidates(group_id)
    where group_id is not null
  ) as affected;

  -- Acquire every affected parent in one deterministic order before counting.
  -- NO KEY UPDATE is deliberately compatible with the FK's KEY SHARE locks:
  -- FOR UPDATE would create a lock-upgrade deadlock between parallel inserts.
  perform groups.id
  from public.shared_addressbook_groups as groups
  where groups.id = any(affected_ids)
  order by groups.id
  for no key update of groups;

  foreach affected_group_id in array affected_ids loop
    -- A separate command in this VOLATILE function obtains a fresh READ
    -- COMMITTED snapshot after any parent-lock wait. Computing this count in
    -- the locking statement or before it loses concurrent committed members.
    -- Always UPDATE: even a same-count identity/source-book change must advance
    -- updated_at so a stale group Save/Delete cannot acknowledge old members.
    update public.shared_addressbook_groups as groups
    set member_count = (
      select pg_catalog.count(*)::integer
      from public.shared_addressbook_group_members as members
      where members.group_id = affected_group_id
    )
    where groups.id = affected_group_id;
    -- A parent already deleted by an FK cascade is intentionally absent.
  end loop;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

-- The verified writer roles (service_role/postgres) already have parent
-- SELECT/UPDATE and bypass RLS. Do not add grants or elevate the trigger.
-- Existing triggers execute without a callable RPC/CREATE TRIGGER privilege.
revoke all on function public.outlook_addressbook_refresh_member_count()
  from public, anon, authenticated, service_role;
