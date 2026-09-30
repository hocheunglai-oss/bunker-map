-- The database is the authoritative Phonebook. Persist every source mutation
-- in the same transaction, so closing a browser cannot lose remote work.
-- There is deliberately no contact FK: a deleted contact must remain queued.
create table public.phonebook_carddav_queue (
  contact_id uuid primary key,
  version uuid not null default gen_random_uuid(),
  queued_at timestamptz not null default now(),
  next_attempt_at timestamptz not null default now(),
  attempts integer not null default 0 check (attempts >= 0),
  last_error text check (octet_length(last_error) <= 4096)
);

create index phonebook_carddav_queue_due_idx
  on public.phonebook_carddav_queue (next_attempt_at, queued_at, contact_id);

create index if not exists phonebook_contacts_company_carddav_idx
  on public.phonebook_contacts (upper(btrim(company)));

-- Quarantine is recovery evidence, not a second authoritative address book.
-- The service may insert an original and mark its deletion, never replace or
-- delete that original. No automatic retention/deletion policy is installed.
create table public.phonebook_carddav_quarantine (
  id uuid primary key default gen_random_uuid(),
  address_book_hash text not null check (address_book_hash ~ '^[0-9a-f]{64}$'),
  resource_path text not null check (
    octet_length(resource_path) between 1 and 2048
    and left(resource_path, 1) = '/'
    and resource_path !~ '[\r\n]'
  ),
  etag text not null check (octet_length(etag) between 1 and 1024),
  vcard text not null check (octet_length(vcard) between 1 and 1048576),
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  reason text not null check (reason in ('unmanaged', 'orphan')),
  source_ids_sha256 text not null check (source_ids_sha256 ~ '^[0-9a-f]{64}$'),
  backed_up_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (address_book_hash, resource_path, content_sha256)
);

alter table public.phonebook_carddav_queue enable row level security;
alter table public.phonebook_carddav_quarantine enable row level security;
revoke all on public.phonebook_carddav_queue
  from public, anon, authenticated, service_role;
revoke all on public.phonebook_carddav_quarantine
  from public, anon, authenticated, service_role;
grant select, insert, update, delete on public.phonebook_carddav_queue to service_role;
grant select, insert on public.phonebook_carddav_quarantine to service_role;
grant update (deleted_at) on public.phonebook_carddav_quarantine to service_role;

create or replace function public.enqueue_phonebook_carddav(p_contact_ids uuid[])
returns void
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
begin
  if p_contact_ids is null or cardinality(p_contact_ids) > 5000 then
    raise exception using errcode = '22023',
      message = 'A non-null array of at most 5000 contact IDs is required.';
  end if;

  if array_position(p_contact_ids, null) is not null then
    raise exception using errcode = '22023',
      message = 'Contact IDs must not contain null.';
  end if;

  -- Order conflicts consistently, including calls that enqueue both old/new IDs.
  insert into public.phonebook_carddav_queue (contact_id)
  select distinct candidate.id
  from unnest(p_contact_ids) as candidate(id)
  order by candidate.id
  on conflict (contact_id) do update set
    version = gen_random_uuid(),
    queued_at = now(),
    next_attempt_at = now(),
    attempts = 0,
    last_error = null;
end;
$$;

revoke all on function public.enqueue_phonebook_carddav(uuid[])
  from public, anon, authenticated;
grant execute on function public.enqueue_phonebook_carddav(uuid[]) to service_role;

-- These private SECURITY DEFINER functions are trigger-only. Privilege is
-- needed to enqueue after a permitted source write without exposing the queue
-- to browser roles. The source table's authorization still applies first.
create or replace function private.enqueue_phonebook_contact_carddav()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    perform public.enqueue_phonebook_carddav(array[old.id]);
  elsif tg_op = 'UPDATE' and old.id is distinct from new.id then
    perform public.enqueue_phonebook_carddav(array[old.id, new.id]);
  else
    perform public.enqueue_phonebook_carddav(array[new.id]);
  end if;
  return null;
end;
$$;

create or replace function private.enqueue_phonebook_company_carddav()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  old_name text;
  new_name text;
begin
  if tg_op in ('UPDATE', 'DELETE') then old_name := old.name; end if;
  if tg_op in ('INSERT', 'UPDATE') then new_name := new.name; end if;

  -- Cards inherit company telephone/name details. Queue both sides of a
  -- rename, as well as insert/delete, even if the browser never sends sync.
  insert into public.phonebook_carddav_queue (contact_id)
  select contacts.id
  from public.phonebook_contacts as contacts
  where upper(btrim(contacts.company)) = upper(btrim(old_name))
     or upper(btrim(contacts.company)) = upper(btrim(new_name))
  order by contacts.id
  on conflict (contact_id) do update set
    version = gen_random_uuid(),
    queued_at = now(),
    next_attempt_at = now(),
    attempts = 0,
    last_error = null;
  return null;
end;
$$;

revoke all on function private.enqueue_phonebook_contact_carddav()
  from public, anon, authenticated, service_role;
revoke all on function private.enqueue_phonebook_company_carddav()
  from public, anon, authenticated, service_role;

create trigger phonebook_contacts_carddav_queue
  after insert or update or delete on public.phonebook_contacts
  for each row execute function private.enqueue_phonebook_contact_carddav();
create trigger phonebook_companies_carddav_queue
  after insert or update or delete on public.phonebook_companies
  for each row execute function private.enqueue_phonebook_company_carddav();

-- Both durable tables belong in verified backups. The existing global epoch
-- makes paginated exports fail closed if either table changes mid-export.
create trigger bunker_map_backup_epoch_fence
  after insert or update or delete or truncate on public.phonebook_carddav_queue
  for each statement execute function private.record_bunker_map_backup_mutation();
create trigger bunker_map_backup_epoch_fence
  after insert or update or delete or truncate on public.phonebook_carddav_quarantine
  for each statement execute function private.record_bunker_map_backup_mutation();

-- No initial full-book enqueue: the worker independently compares the remote
-- inventory and repairs missing IDs without rewriting thousands of good cards.
