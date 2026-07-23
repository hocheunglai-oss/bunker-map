-- FCUNO is the authoritative desired address-book state. This migration adds
-- an immutable, hash-chained history and content-addressed source snapshots so
-- Exchange remains a rebuildable and independently verifiable projection.

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
do $$
begin
  if to_regprocedure('extensions.digest(bytea,text)') is null then
    raise exception
      'pgcrypto digest(bytea,text) must be installed in the extensions schema.';
  end if;
end;
$$;

-- Freeze the live source/audit/outbox write path before any trigger DDL. FCUNO has
-- valid mutation paths with different source-table lock orders (for example,
-- membership writes update their parent group), so NOWAIT is deliberate: any
-- concurrent writer aborts this entire transactional migration immediately
-- and the deployer retries it, instead of either side waiting into a deadlock.
lock table
  public.shared_addressbook_contacts,
  public.shared_addressbook_groups,
  public.shared_addressbook_group_members
in share row exclusive mode nowait;
lock table public.outlook_exchange_sync_queue
  in share row exclusive mode nowait;
lock table public.audit_logs
  in share row exclusive mode nowait;

create table if not exists public.outlook_exchange_truth_snapshots (
  snapshot_sha256 text primary key,
  snapshot_kind text not null,
  schema_version integer not null default 1,
  canonical_json text not null,
  byte_length bigint not null,
  item_counts jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default clock_timestamp(),
  constraint outlook_exchange_truth_snapshots_sha256
    check (snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  constraint outlook_exchange_truth_snapshots_kind
    check (snapshot_kind in ('fcuno_raw', 'fcuno_exchange_projection')),
  constraint outlook_exchange_truth_snapshots_schema_version
    check (schema_version = 1),
  constraint outlook_exchange_truth_snapshots_json
    check (canonical_json is json),
  constraint outlook_exchange_truth_snapshots_length
    check (byte_length = octet_length(canonical_json)),
  constraint outlook_exchange_truth_snapshots_counts
    check (jsonb_typeof(item_counts) = 'object')
);

comment on table public.outlook_exchange_truth_snapshots is
  'Immutable content-addressed FCUNO source snapshots used to reconstruct and verify the Exchange projection.';

create sequence if not exists public.outlook_exchange_truth_ledger_sequence;

create table if not exists public.outlook_exchange_truth_ledger (
  ledger_sequence bigint primary key
    default nextval('public.outlook_exchange_truth_ledger_sequence'::regclass),
  entry_id uuid not null unique default gen_random_uuid(),
  event_key text not null unique,
  event_type text not null,
  occurred_at timestamptz not null,
  occurred_at_canonical text not null,
  run_id uuid,
  audit_log_id uuid,
  queue_row_id uuid,
  snapshot_sha256 text references public.outlook_exchange_truth_snapshots(snapshot_sha256)
    on update restrict on delete restrict,
  payload_canonical_json text not null,
  payload_sha256 text not null,
  previous_entry_sha256 text,
  hash_material text not null,
  entry_sha256 text not null unique,
  created_at timestamptz not null default clock_timestamp(),
  constraint outlook_exchange_truth_ledger_event_key
    check (event_key <> '' and position(E'\n' in event_key) = 0),
  constraint outlook_exchange_truth_ledger_event_type
    check (event_type <> '' and position(E'\n' in event_type) = 0),
  constraint outlook_exchange_truth_ledger_payload_json
    check (payload_canonical_json is json),
  constraint outlook_exchange_truth_ledger_payload_sha256
    check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  constraint outlook_exchange_truth_ledger_previous_sha256
    check (previous_entry_sha256 is null or previous_entry_sha256 ~ '^[0-9a-f]{64}$'),
  constraint outlook_exchange_truth_ledger_entry_sha256
    check (entry_sha256 ~ '^[0-9a-f]{64}$')
);

comment on table public.outlook_exchange_truth_ledger is
  'Append-only SHA-256 chain covering FCUNO user changes, Exchange delivery state, run status, full certifications, and source evidence.';

create index if not exists outlook_exchange_truth_ledger_type_idx
  on public.outlook_exchange_truth_ledger(event_type, ledger_sequence desc);

create index if not exists outlook_exchange_truth_ledger_run_idx
  on public.outlook_exchange_truth_ledger(run_id, ledger_sequence desc)
  where run_id is not null;

create index if not exists outlook_exchange_truth_ledger_audit_idx
  on public.outlook_exchange_truth_ledger(audit_log_id)
  where audit_log_id is not null;

create index if not exists outlook_exchange_truth_ledger_queue_idx
  on public.outlook_exchange_truth_ledger(queue_row_id, ledger_sequence desc)
  where queue_row_id is not null;

alter table public.outlook_exchange_truth_snapshots enable row level security;
alter table public.outlook_exchange_truth_ledger enable row level security;

revoke all on public.outlook_exchange_truth_snapshots
  from public, anon, authenticated;
revoke all on public.outlook_exchange_truth_ledger
  from public, anon, authenticated;
revoke all on sequence public.outlook_exchange_truth_ledger_sequence
  from public, anon, authenticated, service_role;

-- The hosted backup may read the immutable evidence, but service-role code
-- cannot create, rewrite, truncate, or delete it directly.
revoke insert, update, delete, truncate, references, trigger
  on public.outlook_exchange_truth_snapshots from service_role;
revoke insert, update, delete, truncate, references, trigger
  on public.outlook_exchange_truth_ledger from service_role;
grant select on public.outlook_exchange_truth_snapshots to service_role;
grant select on public.outlook_exchange_truth_ledger to service_role;

create or replace function public.outlook_exchange_truth_sha256(p_text text)
returns text
language sql
immutable
set search_path = ''
as $$
  select encode(
    extensions.digest(
      convert_to(coalesce(p_text, ''), 'UTF8'),
      'sha256'
    ),
    'hex'
  );
$$;

create or replace function public.outlook_exchange_truth_timestamp(p_value timestamptz)
returns text
language sql
immutable
set search_path = ''
as $$
  select to_char(
    p_value at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
  );
$$;

create or replace function public.outlook_exchange_truth_snapshot_is_valid(
  p_snapshot_sha256 text,
  p_snapshot_kind text,
  p_schema_version integer,
  p_canonical_json text,
  p_byte_length bigint,
  p_item_counts jsonb
)
returns boolean
language plpgsql
immutable
set search_path = pg_catalog, pg_temp
as $$
declare
  snapshot_value jsonb;
  expected_counts jsonb;
begin
  if p_snapshot_sha256 !~ '^[0-9a-f]{64}$'
    or p_schema_version <> 1
    or p_snapshot_sha256
      <> public.outlook_exchange_truth_sha256(p_canonical_json)
    or p_byte_length <> octet_length(p_canonical_json)
    or jsonb_typeof(p_item_counts) <> 'object'
  then
    return false;
  end if;

  snapshot_value := p_canonical_json::jsonb;
  if p_snapshot_kind = 'fcuno_raw' then
    if snapshot_value ->> 'schema' is distinct from 'fcuno.addressbook.raw/v1'
      or jsonb_typeof(snapshot_value -> 'contacts') is distinct from 'array'
      or jsonb_typeof(snapshot_value -> 'groups') is distinct from 'array'
      or jsonb_typeof(snapshot_value -> 'members') is distinct from 'array'
      or snapshot_value - array[
        'schema', 'contacts', 'groups', 'members'
      ] <> '{}'::jsonb
    then
      return false;
    end if;
    expected_counts := jsonb_build_object(
      'contacts', jsonb_array_length(snapshot_value -> 'contacts'),
      'groups', jsonb_array_length(snapshot_value -> 'groups'),
      'members', jsonb_array_length(snapshot_value -> 'members')
    );
  elsif p_snapshot_kind = 'fcuno_exchange_projection' then
    if jsonb_typeof(snapshot_value -> 'contacts') is distinct from 'array'
      or jsonb_typeof(snapshot_value -> 'groups') is distinct from 'array'
      or jsonb_typeof(snapshot_value -> 'members') is distinct from 'array'
      or jsonb_typeof(snapshot_value -> 'invalidContacts')
        is distinct from 'array'
      or jsonb_typeof(snapshot_value -> 'skippedInvalidContacts')
        is distinct from 'array'
      or jsonb_typeof(snapshot_value -> 'duplicateContacts')
        is distinct from 'array'
      or snapshot_value - array[
        'contacts',
        'groups',
        'members',
        'invalidContacts',
        'skippedInvalidContacts',
        'duplicateContacts'
      ] <> '{}'::jsonb
    then
      return false;
    end if;
    expected_counts := jsonb_build_object(
      'contacts', jsonb_array_length(snapshot_value -> 'contacts'),
      'groups', jsonb_array_length(snapshot_value -> 'groups'),
      'members', jsonb_array_length(snapshot_value -> 'members'),
      'invalidContacts', jsonb_array_length(snapshot_value -> 'invalidContacts'),
      'skippedInvalidContacts', jsonb_array_length(
        snapshot_value -> 'skippedInvalidContacts'
      ),
      'duplicateContacts', jsonb_array_length(
        snapshot_value -> 'duplicateContacts'
      )
    );
  else
    return false;
  end if;

  return p_item_counts is not distinct from expected_counts;
exception
  when others then
    return false;
end;
$$;

create or replace function public.outlook_exchange_truth_hash_material(
  p_ledger_sequence bigint,
  p_entry_id uuid,
  p_event_key text,
  p_event_type text,
  p_occurred_at_canonical text,
  p_run_id uuid,
  p_audit_log_id uuid,
  p_queue_row_id uuid,
  p_snapshot_sha256 text,
  p_previous_entry_sha256 text,
  p_payload_sha256 text
)
returns text
language sql
immutable
set search_path = ''
as $$
  select array_to_string(
    array[
      'fcuno-exchange-truth/v1',
      'ledgerSequence=' || p_ledger_sequence::text,
      'entryId=' || p_entry_id::text,
      'eventKey=' || p_event_key,
      'eventType=' || p_event_type,
      'occurredAt=' || p_occurred_at_canonical,
      'runId=' || coalesce(p_run_id::text, ''),
      'auditLogId=' || coalesce(p_audit_log_id::text, ''),
      'queueRowId=' || coalesce(p_queue_row_id::text, ''),
      'snapshotSha256=' || coalesce(p_snapshot_sha256, ''),
      'previousEntrySha256=' || coalesce(p_previous_entry_sha256, ''),
      'payloadSha256=' || p_payload_sha256
    ],
    E'\n'
  );
$$;

create or replace function public.append_outlook_exchange_truth_event(
  p_event_key text,
  p_event_type text,
  p_occurred_at timestamptz,
  p_run_id uuid,
  p_audit_log_id uuid,
  p_queue_row_id uuid,
  p_snapshot_sha256 text,
  p_payload_canonical_json text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  existing_entry public.outlook_exchange_truth_ledger%rowtype;
  previous_entry_sha256_value text;
  ledger_sequence_value bigint;
  entry_id_value uuid := gen_random_uuid();
  occurred_at_value timestamptz := coalesce(p_occurred_at, clock_timestamp());
  occurred_at_canonical_value text;
  payload_sha256_value text;
  hash_material_value text;
  entry_sha256_value text;
begin
  if nullif(btrim(p_event_key), '') is null
    or nullif(btrim(p_event_type), '') is null
    or position(E'\n' in p_event_key) > 0
    or position(E'\n' in p_event_type) > 0
    or nullif(p_payload_canonical_json, '') is null
  then
    raise exception 'Truth-ledger event key, type, and canonical JSON payload are required.';
  end if;

  perform p_payload_canonical_json::jsonb;

  if p_snapshot_sha256 is not null
    and not exists (
      select 1
      from public.outlook_exchange_truth_snapshots as snapshot
      where snapshot.snapshot_sha256 = p_snapshot_sha256
    )
  then
    raise exception 'Truth snapshot % does not exist.', p_snapshot_sha256;
  end if;

  payload_sha256_value := public.outlook_exchange_truth_sha256(p_payload_canonical_json);
  occurred_at_canonical_value :=
    public.outlook_exchange_truth_timestamp(occurred_at_value);

  select ledger.* into existing_entry
  from public.outlook_exchange_truth_ledger as ledger
  where ledger.event_key = p_event_key;

  if found then
    if existing_entry.event_type = p_event_type
      and existing_entry.run_id is not distinct from p_run_id
      and existing_entry.audit_log_id is not distinct from p_audit_log_id
      and existing_entry.queue_row_id is not distinct from p_queue_row_id
      and existing_entry.snapshot_sha256 is not distinct from p_snapshot_sha256
      and existing_entry.occurred_at_canonical = occurred_at_canonical_value
      and existing_entry.payload_sha256 = payload_sha256_value
    then
      return jsonb_build_object(
        'recorded', true,
        'idempotent', true,
        'ledgerSequence', existing_entry.ledger_sequence,
        'entryId', existing_entry.entry_id,
        'entrySha256', existing_entry.entry_sha256,
        'payloadSha256', existing_entry.payload_sha256,
        'snapshotSha256', existing_entry.snapshot_sha256,
        'recordedAt', existing_entry.created_at
      );
    end if;
    raise exception 'Truth-ledger event key % was already used for different evidence.', p_event_key;
  end if;

  -- Every writer uses this transaction-scoped lock. Source/outbox paths acquire
  -- any queue-row lock before reaching this function, so lock order is stable.
  perform pg_advisory_xact_lock(913047563612485921::bigint);

  select ledger.* into existing_entry
  from public.outlook_exchange_truth_ledger as ledger
  where ledger.event_key = p_event_key;

  if found then
    if existing_entry.event_type = p_event_type
      and existing_entry.run_id is not distinct from p_run_id
      and existing_entry.audit_log_id is not distinct from p_audit_log_id
      and existing_entry.queue_row_id is not distinct from p_queue_row_id
      and existing_entry.snapshot_sha256 is not distinct from p_snapshot_sha256
      and existing_entry.occurred_at_canonical = occurred_at_canonical_value
      and existing_entry.payload_sha256 = payload_sha256_value
    then
      return jsonb_build_object(
        'recorded', true,
        'idempotent', true,
        'ledgerSequence', existing_entry.ledger_sequence,
        'entryId', existing_entry.entry_id,
        'entrySha256', existing_entry.entry_sha256,
        'payloadSha256', existing_entry.payload_sha256,
        'snapshotSha256', existing_entry.snapshot_sha256,
        'recordedAt', existing_entry.created_at
      );
    end if;
    raise exception 'Truth-ledger event key % was already used for different evidence.', p_event_key;
  end if;

  select ledger.entry_sha256
  into previous_entry_sha256_value
  from public.outlook_exchange_truth_ledger as ledger
  order by ledger.ledger_sequence desc
  limit 1;

  ledger_sequence_value := nextval(
    'public.outlook_exchange_truth_ledger_sequence'::regclass
  );
  hash_material_value := public.outlook_exchange_truth_hash_material(
    ledger_sequence_value,
    entry_id_value,
    p_event_key,
    p_event_type,
    occurred_at_canonical_value,
    p_run_id,
    p_audit_log_id,
    p_queue_row_id,
    p_snapshot_sha256,
    previous_entry_sha256_value,
    payload_sha256_value
  );
  entry_sha256_value :=
    public.outlook_exchange_truth_sha256(hash_material_value);

  insert into public.outlook_exchange_truth_ledger (
    ledger_sequence,
    entry_id,
    event_key,
    event_type,
    occurred_at,
    occurred_at_canonical,
    run_id,
    audit_log_id,
    queue_row_id,
    snapshot_sha256,
    payload_canonical_json,
    payload_sha256,
    previous_entry_sha256,
    hash_material,
    entry_sha256
  ) values (
    ledger_sequence_value,
    entry_id_value,
    p_event_key,
    p_event_type,
    occurred_at_value,
    occurred_at_canonical_value,
    p_run_id,
    p_audit_log_id,
    p_queue_row_id,
    p_snapshot_sha256,
    p_payload_canonical_json,
    payload_sha256_value,
    previous_entry_sha256_value,
    hash_material_value,
    entry_sha256_value
  );

  return jsonb_build_object(
    'recorded', true,
    'idempotent', false,
    'ledgerSequence', ledger_sequence_value,
    'entryId', entry_id_value,
    'entrySha256', entry_sha256_value,
    'payloadSha256', payload_sha256_value,
    'snapshotSha256', p_snapshot_sha256,
    'recordedAt', clock_timestamp()
  );
end;
$$;

create or replace function public.reject_outlook_exchange_truth_mutation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if session_user in ('postgres', 'supabase_admin') then
    if tg_op = 'DELETE' then return old; end if;
    if tg_op = 'TRUNCATE' then return null; end if;
    return new;
  end if;
  raise exception '% is immutable; append a new truth event instead.', tg_table_name;
end;
$$;

drop trigger if exists reject_outlook_exchange_truth_snapshot_update_delete
  on public.outlook_exchange_truth_snapshots;
create trigger reject_outlook_exchange_truth_snapshot_update_delete
  before update or delete on public.outlook_exchange_truth_snapshots
  for each row execute function public.reject_outlook_exchange_truth_mutation();

drop trigger if exists reject_outlook_exchange_truth_snapshot_truncate
  on public.outlook_exchange_truth_snapshots;
create trigger reject_outlook_exchange_truth_snapshot_truncate
  before truncate on public.outlook_exchange_truth_snapshots
  for each statement execute function public.reject_outlook_exchange_truth_mutation();

drop trigger if exists reject_outlook_exchange_truth_ledger_update_delete
  on public.outlook_exchange_truth_ledger;
create trigger reject_outlook_exchange_truth_ledger_update_delete
  before update or delete on public.outlook_exchange_truth_ledger
  for each row execute function public.reject_outlook_exchange_truth_mutation();

drop trigger if exists reject_outlook_exchange_truth_ledger_truncate
  on public.outlook_exchange_truth_ledger;
create trigger reject_outlook_exchange_truth_ledger_truncate
  before truncate on public.outlook_exchange_truth_ledger
  for each statement execute function public.reject_outlook_exchange_truth_mutation();

create or replace function public.reject_outlook_exchange_destructive_mutation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if session_user in ('postgres', 'supabase_admin') then
    if tg_op = 'DELETE' then return old; end if;
    if tg_op = 'TRUNCATE' then return null; end if;
    return new;
  end if;
  raise exception
    'Direct % on %.% is disabled because it would destroy FCUNO Exchange recovery evidence.',
    tg_op,
    tg_table_schema,
    tg_table_name;
end;
$$;

drop trigger if exists reject_outlook_exchange_queue_delete
  on public.outlook_exchange_sync_queue;
create trigger reject_outlook_exchange_queue_delete
  before delete on public.outlook_exchange_sync_queue
  for each row execute function public.reject_outlook_exchange_destructive_mutation();

drop trigger if exists reject_outlook_exchange_queue_truncate
  on public.outlook_exchange_sync_queue;
create trigger reject_outlook_exchange_queue_truncate
  before truncate on public.outlook_exchange_sync_queue
  for each statement execute function public.reject_outlook_exchange_destructive_mutation();

drop trigger if exists reject_outlook_exchange_contacts_truncate
  on public.shared_addressbook_contacts;
create trigger reject_outlook_exchange_contacts_truncate
  before truncate on public.shared_addressbook_contacts
  for each statement execute function public.reject_outlook_exchange_destructive_mutation();

drop trigger if exists reject_outlook_exchange_groups_truncate
  on public.shared_addressbook_groups;
create trigger reject_outlook_exchange_groups_truncate
  before truncate on public.shared_addressbook_groups
  for each statement execute function public.reject_outlook_exchange_destructive_mutation();

drop trigger if exists reject_outlook_exchange_members_truncate
  on public.shared_addressbook_group_members;
create trigger reject_outlook_exchange_members_truncate
  before truncate on public.shared_addressbook_group_members
  for each statement execute function public.reject_outlook_exchange_destructive_mutation();

create or replace function public.protect_outlook_exchange_audit_truth()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  addressbook_audit boolean;
begin
  if session_user in ('postgres', 'supabase_admin') then
    if tg_op = 'DELETE' then return old; end if;
    if tg_op = 'TRUNCATE' then return null; end if;
    return new;
  end if;

  if tg_op = 'TRUNCATE' then
    raise exception
      'audit_logs cannot be truncated because it contains FCUNO Exchange recovery evidence.';
  end if;

  addressbook_audit :=
    coalesce(new.table_schema, old.table_schema) = 'public'
    and coalesce(new.table_name, old.table_name) in (
      'shared_addressbook_contacts',
      'shared_addressbook_groups',
      'shared_addressbook_group_members'
    );

  if tg_op = 'DELETE' then
    if exists (
      select 1
      from public.outlook_exchange_truth_ledger as ledger
      where ledger.audit_log_id = old.id
    ) then
      raise exception
        'Audit log % is immutable because the FCUNO Exchange truth ledger references it.',
        old.id;
    end if;
    return old;
  end if;

  if addressbook_audit
    and (
      to_jsonb(new) - array['undone_at', 'undone_by_log_id']
    ) is distinct from (
      to_jsonb(old) - array['undone_at', 'undone_by_log_id']
    )
  then
    raise exception
      'Address-book audit log % is immutable except for controlled undo metadata.',
      old.id;
  end if;

  return new;
end;
$$;

drop trigger if exists protect_outlook_exchange_audit_update_delete
  on public.audit_logs;
create trigger protect_outlook_exchange_audit_update_delete
  before update or delete on public.audit_logs
  for each row execute function public.protect_outlook_exchange_audit_truth();

drop trigger if exists protect_outlook_exchange_audit_truncate
  on public.audit_logs;
create trigger protect_outlook_exchange_audit_truncate
  before truncate on public.audit_logs
  for each statement execute function public.protect_outlook_exchange_audit_truth();

create or replace function public.record_outlook_exchange_audit_truth()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  event_key_value text;
  event_type_value text;
  payload_value text;
begin
  if new.table_schema <> 'public'
    or new.table_name not in (
      'shared_addressbook_contacts',
      'shared_addressbook_groups',
      'shared_addressbook_group_members'
    )
  then
    return new;
  end if;

  if tg_op = 'INSERT' then
    event_key_value := 'audit:' || new.id::text;
    event_type_value := 'source_change';
    payload_value := (
      to_jsonb(new) - 'undone_at' - 'undone_by_log_id'
    )::text;
  else
    if new.undone_at is not distinct from old.undone_at
      and new.undone_by_log_id is not distinct from old.undone_by_log_id
    then
      return new;
    end if;
    event_key_value := concat(
      'audit-undo:',
      new.id::text,
      ':',
      coalesce(new.undone_by_log_id::text, 'unlinked'),
      ':',
      coalesce(public.outlook_exchange_truth_timestamp(new.undone_at), 'unknown')
    );
    event_type_value := 'source_undo_annotation';
    payload_value := jsonb_build_object(
      'auditLogId', new.id,
      'beforeUndoneAt', old.undone_at,
      'afterUndoneAt', new.undone_at,
      'beforeUndoneByLogId', old.undone_by_log_id,
      'afterUndoneByLogId', new.undone_by_log_id
    )::text;
  end if;

  perform public.append_outlook_exchange_truth_event(
    event_key_value,
    event_type_value,
    case
      when tg_op = 'UPDATE' then coalesce(new.undone_at, clock_timestamp())
      else coalesce(new.occurred_at, clock_timestamp())
    end,
    null,
    new.id,
    null,
    null,
    payload_value
  );
  return new;
end;
$$;

drop trigger if exists outlook_exchange_truth_audit_insert on public.audit_logs;
-- Source audit events are appended from the queue trigger after the outbox row
-- has been inserted or locked. This preserves queue -> ledger lock ordering.

drop trigger if exists outlook_exchange_truth_audit_undo on public.audit_logs;
create trigger outlook_exchange_truth_audit_undo
  after update of undone_at, undone_by_log_id on public.audit_logs
  for each row execute function public.record_outlook_exchange_audit_truth();

create or replace function public.record_outlook_exchange_queue_truth()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  changed_fields_value text[];
  event_type_value text;
  payload_value text;
  audit_log_id_value uuid;
  audit_row public.audit_logs%rowtype;
begin
  if tg_op = 'UPDATE' then
    changed_fields_value := array_remove(
      public.audit_changed_fields(to_jsonb(old), to_jsonb(new)),
      'updated_at'
    );
    if coalesce(array_length(changed_fields_value, 1), 0) = 0 then
      return new;
    end if;
  else
    changed_fields_value := array[]::text[];
  end if;

  event_type_value := case
    when tg_op = 'INSERT' then 'queue_enqueued'
    when old.status is distinct from new.status and new.status = 'processing' then 'queue_claimed'
    when old.status is distinct from new.status and new.status = 'completed' then 'queue_completed'
    when old.status is distinct from new.status and new.status = 'failed' then 'queue_failed'
    when old.status is distinct from new.status and new.status = 'skipped' then 'queue_skipped'
    else 'queue_updated'
  end;

  payload_value := jsonb_build_object(
    'beforeQueue', case when tg_op = 'UPDATE' then to_jsonb(old) else null end,
    'afterQueue', to_jsonb(new),
    'changedFields', to_jsonb(changed_fields_value)
  )::text;

  foreach audit_log_id_value in array coalesce(
    nullif(new.audit_log_ids, array[]::uuid[]),
    case
      when new.audit_log_id is null then array[]::uuid[]
      else array[new.audit_log_id]
    end
  )
  loop
    select logs.* into audit_row
    from public.audit_logs as logs
    where logs.id = audit_log_id_value;

    if found
      and audit_row.table_schema = 'public'
      and audit_row.table_name in (
        'shared_addressbook_contacts',
        'shared_addressbook_groups',
        'shared_addressbook_group_members'
      )
    then
      perform public.append_outlook_exchange_truth_event(
        'audit:' || audit_row.id::text,
        'source_change',
        coalesce(audit_row.occurred_at, clock_timestamp()),
        null,
        audit_row.id,
        null,
        null,
        (
          to_jsonb(audit_row) - 'undone_at' - 'undone_by_log_id'
        )::text
      );
    end if;
  end loop;

  perform public.append_outlook_exchange_truth_event(
    'queue:' || new.id::text || ':' || gen_random_uuid()::text,
    event_type_value,
    coalesce(new.updated_at, new.created_at, clock_timestamp()),
    new.run_id,
    new.audit_log_id,
    new.id,
    null,
    payload_value
  );
  return new;
end;
$$;

drop trigger if exists outlook_exchange_truth_queue on public.outlook_exchange_sync_queue;
create trigger outlook_exchange_truth_queue
  after insert or update on public.outlook_exchange_sync_queue
  for each row execute function public.record_outlook_exchange_queue_truth();

create or replace function public.outlook_exchange_raw_source_snapshot()
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  select jsonb_build_object(
    'schema', 'fcuno.addressbook.raw/v1',
    'contacts', coalesce(
      (
        select jsonb_agg(to_jsonb(contact_row) order by contact_row.id)
        from public.shared_addressbook_contacts as contact_row
      ),
      '[]'::jsonb
    ),
    'groups', coalesce(
      (
        select jsonb_agg(to_jsonb(group_row) order by group_row.id)
        from public.shared_addressbook_groups as group_row
      ),
      '[]'::jsonb
    ),
    'members', coalesce(
      (
        select jsonb_agg(
          to_jsonb(member_row)
          order by member_row.group_id, member_row.contact_id
        )
        from public.shared_addressbook_group_members as member_row
      ),
      '[]'::jsonb
    )
  );
$$;

create or replace function public.record_outlook_exchange_certification_truth()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  snapshot_value jsonb;
  snapshot_canonical_value text;
  snapshot_sha256_value text;
  counts_value jsonb;
  existing_snapshot public.outlook_exchange_truth_snapshots%rowtype;
  payload_value text;
begin
  snapshot_value := public.outlook_exchange_raw_source_snapshot();
  snapshot_canonical_value := snapshot_value::text;
  snapshot_sha256_value :=
    public.outlook_exchange_truth_sha256(snapshot_canonical_value);
  counts_value := jsonb_build_object(
    'contacts', jsonb_array_length(snapshot_value -> 'contacts'),
    'groups', jsonb_array_length(snapshot_value -> 'groups'),
    'members', jsonb_array_length(snapshot_value -> 'members')
  );

  insert into public.outlook_exchange_truth_snapshots (
    snapshot_sha256,
    snapshot_kind,
    canonical_json,
    byte_length,
    item_counts
  ) values (
    snapshot_sha256_value,
    'fcuno_raw',
    snapshot_canonical_value,
    octet_length(snapshot_canonical_value),
    counts_value
  )
  on conflict (snapshot_sha256) do nothing;

  select snapshot.* into existing_snapshot
  from public.outlook_exchange_truth_snapshots as snapshot
  where snapshot.snapshot_sha256 = snapshot_sha256_value;

  if existing_snapshot.canonical_json is distinct from snapshot_canonical_value
    or existing_snapshot.snapshot_kind <> 'fcuno_raw'
    or existing_snapshot.schema_version <> 1
    or existing_snapshot.byte_length <> octet_length(snapshot_canonical_value)
    or existing_snapshot.item_counts is distinct from counts_value
  then
    raise exception 'A conflicting truth snapshot already uses SHA-256 %.', snapshot_sha256_value;
  end if;

  payload_value := jsonb_build_object(
    'schema', 'fcuno.exchange.full-certification/v1',
    'certification', to_jsonb(new),
    'rawSourceSnapshotSha256', snapshot_sha256_value,
    'rawSourceCounts', counts_value
  )::text;

  perform public.append_outlook_exchange_truth_event(
    'certification:' || new.run_id::text,
    'full_certification',
    new.certified_at,
    new.run_id,
    null,
    null,
    snapshot_sha256_value,
    payload_value
  );
  return new;
end;
$$;

drop trigger if exists outlook_exchange_truth_certification
  on public.outlook_exchange_sync_certifications;
create trigger outlook_exchange_truth_certification
  after insert on public.outlook_exchange_sync_certifications
  for each row execute function public.record_outlook_exchange_certification_truth();

create or replace function public.record_outlook_exchange_status_truth()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  payload_value text;
  status_run_id uuid;
begin
  if new.key <> 'outlook-addressbook-exchange-sync' then
    return new;
  end if;

  payload_value := jsonb_build_object(
    'beforeStatus', case when tg_op = 'UPDATE' then to_jsonb(old) else null end,
    'afterStatus', to_jsonb(new)
  )::text;
  if coalesce(new.payload ->> 'runId', '') ~*
    '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  then
    status_run_id := (new.payload ->> 'runId')::uuid;
  end if;

  perform public.append_outlook_exchange_truth_event(
    'status:' || new.key || ':' || gen_random_uuid()::text,
    'run_status',
    coalesce(new.updated_at, clock_timestamp()),
    status_run_id,
    null,
    null,
    null,
    payload_value
  );
  return new;
end;
$$;

drop trigger if exists outlook_exchange_truth_status on public.office_calendar_store;
create trigger outlook_exchange_truth_status
  after insert or update on public.office_calendar_store
  for each row execute function public.record_outlook_exchange_status_truth();

create or replace function public.certify_full_outlook_exchange_truth(
  p_run_id uuid,
  p_queue_high_water_sequence bigint,
  p_queue_high_water_updated_at timestamptz,
  p_source_fingerprint text,
  p_projection_canonical_json text,
  p_projection_counts jsonb,
  p_verification_summary jsonb,
  p_worker_version text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  projection_value jsonb;
  expected_projection_counts jsonb;
  projection_sha256_value text;
  certification_result jsonb;
  certification_entry public.outlook_exchange_truth_ledger%rowtype;
  projection_entry_result jsonb;
  existing_snapshot public.outlook_exchange_truth_snapshots%rowtype;
  payload_value text;
begin
  if nullif(p_projection_canonical_json, '') is null
    or nullif(btrim(p_source_fingerprint), '') is null
    or nullif(btrim(p_worker_version), '') is null
    or p_projection_counts is null
    or p_verification_summary is null
    or jsonb_typeof(p_projection_counts) <> 'object'
    or jsonb_typeof(p_verification_summary) <> 'object'
  then
    raise exception 'Canonical projection, source fingerprint, worker version, counts, and verification summary are required.';
  end if;

  if p_source_fingerprint !~ '^[0-9a-f]{64}$'
    or p_worker_version !~ '^fcuno-exchange-runbook/[0-9]{4}-[0-9]{2}-[0-9]{2}\.[0-9]+$'
  then
    raise exception 'Source fingerprint or worker version format is invalid.';
  end if;

  projection_value := p_projection_canonical_json::jsonb;
  if jsonb_typeof(projection_value) <> 'object'
    or jsonb_typeof(projection_value -> 'contacts') <> 'array'
    or jsonb_typeof(projection_value -> 'groups') <> 'array'
    or jsonb_typeof(projection_value -> 'members') <> 'array'
    or jsonb_typeof(projection_value -> 'invalidContacts') <> 'array'
    or jsonb_typeof(projection_value -> 'skippedInvalidContacts') <> 'array'
    or jsonb_typeof(projection_value -> 'duplicateContacts') <> 'array'
    or projection_value - array[
      'contacts',
      'groups',
      'members',
      'invalidContacts',
      'skippedInvalidContacts',
      'duplicateContacts'
    ] <> '{}'::jsonb
  then
    raise exception 'Canonical projection must contain exactly the six expected arrays.';
  end if;

  expected_projection_counts := jsonb_build_object(
    'contacts', jsonb_array_length(projection_value -> 'contacts'),
    'groups', jsonb_array_length(projection_value -> 'groups'),
    'members', jsonb_array_length(projection_value -> 'members'),
    'invalidContacts', jsonb_array_length(projection_value -> 'invalidContacts'),
    'skippedInvalidContacts', jsonb_array_length(projection_value -> 'skippedInvalidContacts'),
    'duplicateContacts', jsonb_array_length(projection_value -> 'duplicateContacts')
  );
  if p_projection_counts <> expected_projection_counts then
    raise exception
      'Projection counts % do not match canonical projection counts %.',
      p_projection_counts,
      expected_projection_counts;
  end if;

  if p_verification_summary ->> 'status' <> 'match'
    or coalesce((p_verification_summary ->> 'mismatchCount')::integer, -1) <> 0
    or coalesce((p_verification_summary ->> 'sourceFenceStable')::boolean, false) is not true
    or p_verification_summary ->> 'sourceFingerprint' <> p_source_fingerprint
    or coalesce((p_verification_summary ->> 'verifiedManagedContacts')::integer, -1)
      <> (expected_projection_counts ->> 'contacts')::integer
    or coalesce((p_verification_summary ->> 'verifiedManagedGroups')::integer, -1)
      <> (expected_projection_counts ->> 'groups')::integer
    or coalesce((p_verification_summary ->> 'verifiedMembershipGroups')::integer, -1)
      <> (expected_projection_counts ->> 'groups')::integer
    or coalesce((p_verification_summary ->> 'verifiedMemberships')::integer, -1)
      <> (expected_projection_counts ->> 'members')::integer
  then
    raise exception 'Verification summary does not certify an exact, stable projection match.';
  end if;

  projection_sha256_value :=
    public.outlook_exchange_truth_sha256(p_projection_canonical_json);
  if projection_sha256_value <> lower(p_source_fingerprint) then
    raise exception
      'Canonical projection SHA-256 % does not match source fingerprint %.',
      projection_sha256_value,
      p_source_fingerprint;
  end if;

  certification_result := public.certify_full_outlook_exchange_sync_queue(
    p_run_id,
    p_queue_high_water_sequence,
    p_queue_high_water_updated_at,
    p_source_fingerprint
  );

  if not coalesce((certification_result ->> 'certified')::boolean, false) then
    return certification_result || jsonb_build_object(
      'evidenceRecorded', false,
      'truthLedgerSequence', null,
      'truthLedgerHash', null,
      'sourceSnapshotHash', null
    );
  end if;

  insert into public.outlook_exchange_truth_snapshots (
    snapshot_sha256,
    snapshot_kind,
    canonical_json,
    byte_length,
    item_counts
  ) values (
    projection_sha256_value,
    'fcuno_exchange_projection',
    p_projection_canonical_json,
    octet_length(p_projection_canonical_json),
    expected_projection_counts
  )
  on conflict (snapshot_sha256) do nothing;

  select snapshot.* into existing_snapshot
  from public.outlook_exchange_truth_snapshots as snapshot
  where snapshot.snapshot_sha256 = projection_sha256_value;

  if existing_snapshot.canonical_json is distinct from p_projection_canonical_json
    or existing_snapshot.snapshot_kind <> 'fcuno_exchange_projection'
    or existing_snapshot.schema_version <> 1
    or existing_snapshot.byte_length <> octet_length(p_projection_canonical_json)
    or existing_snapshot.item_counts is distinct from expected_projection_counts
  then
    raise exception 'A conflicting projection snapshot already uses SHA-256 %.', projection_sha256_value;
  end if;

  select ledger.* into certification_entry
  from public.outlook_exchange_truth_ledger as ledger
  where ledger.event_key = 'certification:' || p_run_id::text;

  if not found then
    raise exception 'Full certification % committed without its truth-ledger receipt.', p_run_id;
  end if;

  payload_value := jsonb_build_object(
    'schema', 'fcuno.exchange.projection-evidence/v1',
    'runId', p_run_id,
    'sourceFingerprint', p_source_fingerprint,
    'projectionSnapshotSha256', projection_sha256_value,
    'rawSourceSnapshotSha256', certification_entry.snapshot_sha256,
    'certificationLedgerSequence', certification_entry.ledger_sequence,
    'certificationLedgerSha256', certification_entry.entry_sha256,
    'projectionCounts', expected_projection_counts,
    'verificationSummary', p_verification_summary,
    'workerVersion', p_worker_version
  )::text;

  projection_entry_result := public.append_outlook_exchange_truth_event(
    'projection:' || p_run_id::text,
    'full_projection_evidence',
    (certification_result ->> 'certifiedAt')::timestamptz,
    p_run_id,
    null,
    null,
    projection_sha256_value,
    payload_value
  );

  return certification_result || jsonb_build_object(
    'runId', p_run_id,
    'evidenceRecorded', true,
    'truthLedgerSequence', projection_entry_result -> 'ledgerSequence',
    'truthLedgerHash', projection_entry_result -> 'entrySha256',
    'sourceSnapshotHash', projection_sha256_value,
    'rawSourceSnapshotHash', certification_entry.snapshot_sha256,
    'workerVersion', p_worker_version
  );
end;
$$;

create or replace function public.get_outlook_exchange_truth_checkpoint()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  ledger_head public.outlook_exchange_truth_ledger%rowtype;
  previous_head_sha256 text;
  head_snapshot public.outlook_exchange_truth_snapshots%rowtype;
  latest_certification public.outlook_exchange_sync_certifications%rowtype;
  latest_projection_evidence public.outlook_exchange_truth_ledger%rowtype;
  expected_hash_material text;
  checkpoint_valid boolean := false;
  snapshot_valid boolean := true;
  reference_valid boolean := true;
begin
  select ledger.* into ledger_head
  from public.outlook_exchange_truth_ledger as ledger
  order by ledger.ledger_sequence desc
  limit 1;

  if found then
    select ledger.entry_sha256 into previous_head_sha256
    from public.outlook_exchange_truth_ledger as ledger
    where ledger.ledger_sequence < ledger_head.ledger_sequence
    order by ledger.ledger_sequence desc
    limit 1;

    expected_hash_material := public.outlook_exchange_truth_hash_material(
      ledger_head.ledger_sequence,
      ledger_head.entry_id,
      ledger_head.event_key,
      ledger_head.event_type,
      ledger_head.occurred_at_canonical,
      ledger_head.run_id,
      ledger_head.audit_log_id,
      ledger_head.queue_row_id,
      ledger_head.snapshot_sha256,
      ledger_head.previous_entry_sha256,
      ledger_head.payload_sha256
    );

    if ledger_head.snapshot_sha256 is not null then
      select snapshot.* into head_snapshot
      from public.outlook_exchange_truth_snapshots as snapshot
      where snapshot.snapshot_sha256 = ledger_head.snapshot_sha256;
      snapshot_valid := found
        and public.outlook_exchange_truth_snapshot_is_valid(
          head_snapshot.snapshot_sha256,
          head_snapshot.snapshot_kind,
          head_snapshot.schema_version,
          head_snapshot.canonical_json,
          head_snapshot.byte_length,
          head_snapshot.item_counts
        );
    end if;

    reference_valid :=
      (
        ledger_head.audit_log_id is null
        or exists (
          select 1
          from public.audit_logs as logs
          where logs.id = ledger_head.audit_log_id
        )
      )
      and (
        ledger_head.queue_row_id is null
        or exists (
          select 1
          from public.outlook_exchange_sync_queue as queue
          where queue.id = ledger_head.queue_row_id
        )
      )
      and (
        ledger_head.event_type not in (
          'full_certification',
          'legacy_full_certification'
        )
        or exists (
          select 1
          from public.outlook_exchange_sync_certifications as certification
          where certification.run_id = ledger_head.run_id
        )
      );

    checkpoint_valid :=
      ledger_head.previous_entry_sha256 is not distinct from previous_head_sha256
      and ledger_head.occurred_at_canonical
        = public.outlook_exchange_truth_timestamp(ledger_head.occurred_at)
      and ledger_head.payload_sha256
        = public.outlook_exchange_truth_sha256(ledger_head.payload_canonical_json)
      and ledger_head.hash_material = expected_hash_material
      and ledger_head.entry_sha256
        = public.outlook_exchange_truth_sha256(expected_hash_material)
      and snapshot_valid
      and reference_valid;
  end if;

  select certification.* into latest_certification
  from public.outlook_exchange_sync_certifications as certification
  order by certification.certified_at desc
  limit 1;

  if found then
    select ledger.* into latest_projection_evidence
    from public.outlook_exchange_truth_ledger as ledger
    where ledger.event_key =
      'projection:' || latest_certification.run_id::text
      and ledger.event_type = 'full_projection_evidence'
      and ledger.snapshot_sha256 = latest_certification.source_fingerprint
    limit 1;
  end if;

  return jsonb_build_object(
    'checkpointValid', checkpoint_valid,
    'headSequence', ledger_head.ledger_sequence,
    'headSha256', ledger_head.entry_sha256,
    'headPreviousSha256', ledger_head.previous_entry_sha256,
    'headEventType', ledger_head.event_type,
    'headRunId', ledger_head.run_id,
    'headOccurredAt', ledger_head.occurred_at,
    'ledgerEntries', (
      select count(*) from public.outlook_exchange_truth_ledger
    ),
    'snapshots', (
      select count(*) from public.outlook_exchange_truth_snapshots
    ),
    'latestCertificationRunId', latest_certification.run_id,
    'latestCertificationAt', latest_certification.certified_at,
    'latestSourceFingerprint', latest_certification.source_fingerprint,
    'latestCertificationHasProjectionEvidence',
      latest_projection_evidence.entry_id is not null,
    'latestProjectionSnapshotSha256',
      latest_projection_evidence.snapshot_sha256,
    'queue', jsonb_build_object(
      'pending', (
        select count(*) from public.outlook_exchange_sync_queue
        where status = 'pending'
      ),
      'processing', (
        select count(*) from public.outlook_exchange_sync_queue
        where status = 'processing'
      ),
      'failed', (
        select count(*) from public.outlook_exchange_sync_queue
        where status = 'failed'
      ),
      'terminalFailed', (
        select count(*) from public.outlook_exchange_sync_queue
        where status = 'failed' and next_attempt_at is null
      )
    )
  );
end;
$$;

create or replace function public.verify_outlook_exchange_truth_ledger()
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  with ledger_check as (
    select
      ledger.*,
      lag(ledger.entry_sha256) over (
        order by ledger.ledger_sequence
      ) as expected_previous_entry_sha256,
      public.outlook_exchange_truth_sha256(
        ledger.payload_canonical_json
      ) as expected_payload_sha256,
      public.outlook_exchange_truth_timestamp(
        ledger.occurred_at
      ) as expected_occurred_at_canonical,
      public.outlook_exchange_truth_hash_material(
        ledger.ledger_sequence,
        ledger.entry_id,
        ledger.event_key,
        ledger.event_type,
        ledger.occurred_at_canonical,
        ledger.run_id,
        ledger.audit_log_id,
        ledger.queue_row_id,
        ledger.snapshot_sha256,
        ledger.previous_entry_sha256,
        ledger.payload_sha256
      ) as expected_hash_material
    from public.outlook_exchange_truth_ledger as ledger
  ),
  invalid_ledger as (
    select ledger_check.ledger_sequence
    from ledger_check
    where ledger_check.previous_entry_sha256
        is distinct from ledger_check.expected_previous_entry_sha256
      or ledger_check.payload_sha256
        is distinct from ledger_check.expected_payload_sha256
      or ledger_check.occurred_at_canonical
        is distinct from ledger_check.expected_occurred_at_canonical
      or ledger_check.hash_material
        is distinct from ledger_check.expected_hash_material
      or ledger_check.entry_sha256
        is distinct from public.outlook_exchange_truth_sha256(
          ledger_check.expected_hash_material
        )
    order by ledger_check.ledger_sequence
    limit 1
  ),
  invalid_snapshot as (
    select snapshot.snapshot_sha256
    from public.outlook_exchange_truth_snapshots as snapshot
    where not public.outlook_exchange_truth_snapshot_is_valid(
      snapshot.snapshot_sha256,
      snapshot.snapshot_kind,
      snapshot.schema_version,
      snapshot.canonical_json,
      snapshot.byte_length,
      snapshot.item_counts
    )
    order by snapshot.created_at, snapshot.snapshot_sha256
    limit 1
  ),
  invalid_reference as (
    select
      ledger.ledger_sequence,
      case
        when ledger.audit_log_id is not null and logs.id is null
          then 'audit_log'
        when ledger.queue_row_id is not null and queue.id is null
          then 'queue_row'
        when ledger.event_type in (
          'full_certification',
          'legacy_full_certification'
        ) and certification.run_id is null
          then 'certification'
      end as reference_kind
    from public.outlook_exchange_truth_ledger as ledger
    left join public.audit_logs as logs
      on logs.id = ledger.audit_log_id
    left join public.outlook_exchange_sync_queue as queue
      on queue.id = ledger.queue_row_id
    left join public.outlook_exchange_sync_certifications as certification
      on certification.run_id = ledger.run_id
    where (ledger.audit_log_id is not null and logs.id is null)
      or (ledger.queue_row_id is not null and queue.id is null)
      or (
        ledger.event_type in (
          'full_certification',
          'legacy_full_certification'
        )
        and certification.run_id is null
      )
    order by ledger.ledger_sequence
    limit 1
  ),
  orphan_certification as (
    select certification.run_id
    from public.outlook_exchange_sync_certifications as certification
    where not exists (
      select 1
      from public.outlook_exchange_truth_ledger as ledger
      where ledger.run_id = certification.run_id
        and ledger.event_type in (
          'full_certification',
          'legacy_full_certification'
        )
    )
    order by certification.certified_at, certification.run_id
    limit 1
  ),
  ledger_head as (
    select ledger.ledger_sequence, ledger.entry_sha256, ledger.event_type, ledger.occurred_at
    from public.outlook_exchange_truth_ledger as ledger
    order by ledger.ledger_sequence desc
    limit 1
  ),
  latest_certification as (
    select certification.*
    from public.outlook_exchange_sync_certifications as certification
    order by certification.certified_at desc
    limit 1
  ),
  latest_evidence as (
    select ledger.*
    from public.outlook_exchange_truth_ledger as ledger
    join latest_certification
      on ledger.event_key = 'projection:' || latest_certification.run_id::text
      and ledger.event_type = 'full_projection_evidence'
      and ledger.snapshot_sha256 = latest_certification.source_fingerprint
    limit 1
  ),
  queue_counts as (
    select
      count(*) filter (where queue.status = 'pending') as pending,
      count(*) filter (where queue.status = 'processing') as processing,
      count(*) filter (where queue.status = 'failed') as failed,
      count(*) filter (
        where queue.status = 'failed' and queue.next_attempt_at is null
      ) as terminal_failed
    from public.outlook_exchange_sync_queue as queue
  )
  select jsonb_build_object(
    'integrityValid',
      not exists (select 1 from invalid_ledger)
      and not exists (select 1 from invalid_snapshot)
      and not exists (select 1 from invalid_reference)
      and not exists (select 1 from orphan_certification),
    'valid',
      not exists (select 1 from invalid_ledger)
      and not exists (select 1 from invalid_snapshot)
      and not exists (select 1 from invalid_reference)
      and not exists (select 1 from orphan_certification),
    'ledgerValid', not exists (select 1 from invalid_ledger),
    'snapshotsValid', not exists (select 1 from invalid_snapshot),
    'referencesValid',
      not exists (select 1 from invalid_reference)
      and not exists (select 1 from orphan_certification),
    'firstInvalidLedgerSequence', (select ledger_sequence from invalid_ledger),
    'firstInvalidSnapshotSha256', (select snapshot_sha256 from invalid_snapshot),
    'firstInvalidReferenceLedgerSequence',
      (select ledger_sequence from invalid_reference),
    'firstInvalidReferenceKind', (select reference_kind from invalid_reference),
    'firstOrphanCertificationRunId', (select run_id from orphan_certification),
    'ledgerEntries', (select count(*) from public.outlook_exchange_truth_ledger),
    'snapshots', (select count(*) from public.outlook_exchange_truth_snapshots),
    'headSequence', (select ledger_sequence from ledger_head),
    'headSha256', (select entry_sha256 from ledger_head),
    'headEventType', (select event_type from ledger_head),
    'headOccurredAt', (select occurred_at from ledger_head),
    'latestCertificationRunId', (select run_id from latest_certification),
    'latestCertificationAt', (select certified_at from latest_certification),
    'latestSourceFingerprint', (select source_fingerprint from latest_certification),
    'latestCertificationHasProjectionEvidence',
      exists (select 1 from latest_evidence),
    'latestProjectionSnapshotSha256',
      (select snapshot_sha256 from latest_evidence),
    'operationallyConsistent',
      exists (select 1 from latest_evidence)
      and (select pending + processing + failed from queue_counts) = 0,
    'queue', (
      select jsonb_build_object(
        'pending', pending,
        'processing', processing,
        'failed', failed,
        'terminalFailed', terminal_failed
      )
      from queue_counts
    )
  );
$$;

-- Anchor all recoverable pre-migration evidence before the live triggers begin
-- adding new events. These entries are explicitly labelled as legacy imports;
-- the current-state baseline below is the first complete source snapshot.
do $$
declare
  audit_row public.audit_logs%rowtype;
  queue_row public.outlook_exchange_sync_queue%rowtype;
  certification_row public.outlook_exchange_sync_certifications%rowtype;
  snapshot_value jsonb;
  snapshot_canonical_value text;
  snapshot_sha256_value text;
  counts_value jsonb;
begin
  for audit_row in
    select logs.*
    from public.audit_logs as logs
    where logs.table_schema = 'public'
      and logs.table_name in (
        'shared_addressbook_contacts',
        'shared_addressbook_groups',
        'shared_addressbook_group_members'
      )
    order by logs.occurred_at, logs.id
  loop
    perform public.append_outlook_exchange_truth_event(
      'legacy-audit:' || audit_row.id::text,
      'legacy_source_change',
      audit_row.occurred_at,
      null,
      audit_row.id,
      null,
      null,
      to_jsonb(audit_row)::text
    );
  end loop;

  for queue_row in
    select queue.*
    from public.outlook_exchange_sync_queue as queue
    order by queue.queue_sequence, queue.id
  loop
    perform public.append_outlook_exchange_truth_event(
      'legacy-queue:' || queue_row.id::text,
      'legacy_queue_snapshot',
      coalesce(queue_row.updated_at, queue_row.created_at),
      queue_row.run_id,
      queue_row.audit_log_id,
      queue_row.id,
      null,
      to_jsonb(queue_row)::text
    );
  end loop;

  for certification_row in
    select certification.*
    from public.outlook_exchange_sync_certifications as certification
    order by certification.certified_at, certification.run_id
  loop
    perform public.append_outlook_exchange_truth_event(
      'legacy-certification:' || certification_row.run_id::text,
      'legacy_full_certification',
      certification_row.certified_at,
      certification_row.run_id,
      null,
      null,
      null,
      to_jsonb(certification_row)::text
    );
  end loop;

  snapshot_value := public.outlook_exchange_raw_source_snapshot();
  snapshot_canonical_value := snapshot_value::text;
  snapshot_sha256_value :=
    public.outlook_exchange_truth_sha256(snapshot_canonical_value);
  counts_value := jsonb_build_object(
    'contacts', jsonb_array_length(snapshot_value -> 'contacts'),
    'groups', jsonb_array_length(snapshot_value -> 'groups'),
    'members', jsonb_array_length(snapshot_value -> 'members')
  );

  insert into public.outlook_exchange_truth_snapshots (
    snapshot_sha256,
    snapshot_kind,
    canonical_json,
    byte_length,
    item_counts
  ) values (
    snapshot_sha256_value,
    'fcuno_raw',
    snapshot_canonical_value,
    octet_length(snapshot_canonical_value),
    counts_value
  )
  on conflict (snapshot_sha256) do nothing;

  perform public.append_outlook_exchange_truth_event(
    'baseline:' || snapshot_sha256_value,
    'source_baseline',
    clock_timestamp(),
    null,
    null,
    null,
    snapshot_sha256_value,
    jsonb_build_object(
      'schema', 'fcuno.exchange.truth-baseline/v1',
      'rawSourceSnapshotSha256', snapshot_sha256_value,
      'rawSourceCounts', counts_value,
      'reason', 'Initial immutable baseline created when the truth ledger was installed.'
    )::text
  );
end;
$$;

-- Certification receipts are immutable after the ledger is installed. The
-- existing RPC continues to insert through its SECURITY DEFINER owner.
drop trigger if exists reject_outlook_exchange_certification_update_delete
  on public.outlook_exchange_sync_certifications;
create trigger reject_outlook_exchange_certification_update_delete
  before update or delete on public.outlook_exchange_sync_certifications
  for each row execute function public.reject_outlook_exchange_truth_mutation();

drop trigger if exists reject_outlook_exchange_certification_truncate
  on public.outlook_exchange_sync_certifications;
create trigger reject_outlook_exchange_certification_truncate
  before truncate on public.outlook_exchange_sync_certifications
  for each statement execute function public.reject_outlook_exchange_truth_mutation();

revoke all on public.outlook_exchange_sync_certifications
  from public, anon, authenticated, service_role;
grant select on public.outlook_exchange_sync_certifications to service_role;

revoke insert, delete, truncate
  on public.outlook_exchange_sync_queue
  from anon, authenticated, service_role;
revoke update, delete, truncate, trigger
  on public.audit_logs
  from anon, authenticated, service_role;
revoke truncate
  on public.shared_addressbook_contacts,
     public.shared_addressbook_groups,
     public.shared_addressbook_group_members
  from anon, authenticated, service_role;

revoke execute on function public.certify_full_outlook_exchange_sync_queue(
  uuid, bigint, timestamptz, text
) from public, anon, authenticated, service_role;

revoke all on function public.outlook_exchange_truth_sha256(text)
  from public, anon, authenticated;
revoke all on function public.outlook_exchange_truth_timestamp(timestamptz)
  from public, anon, authenticated;
revoke all on function public.outlook_exchange_truth_snapshot_is_valid(
  text, text, integer, text, bigint, jsonb
) from public, anon, authenticated;
revoke all on function public.outlook_exchange_truth_hash_material(
  bigint, uuid, text, text, text, uuid, uuid, uuid, text, text, text
) from public, anon, authenticated;
revoke all on function public.append_outlook_exchange_truth_event(
  text, text, timestamptz, uuid, uuid, uuid, text, text
) from public, anon, authenticated, service_role;
revoke all on function public.reject_outlook_exchange_truth_mutation()
  from public, anon, authenticated, service_role;
revoke all on function public.reject_outlook_exchange_destructive_mutation()
  from public, anon, authenticated, service_role;
revoke all on function public.protect_outlook_exchange_audit_truth()
  from public, anon, authenticated, service_role;
revoke all on function public.record_outlook_exchange_audit_truth()
  from public, anon, authenticated, service_role;
revoke all on function public.record_outlook_exchange_queue_truth()
  from public, anon, authenticated, service_role;
revoke all on function public.outlook_exchange_raw_source_snapshot()
  from public, anon, authenticated, service_role;
revoke all on function public.record_outlook_exchange_certification_truth()
  from public, anon, authenticated, service_role;
revoke all on function public.record_outlook_exchange_status_truth()
  from public, anon, authenticated, service_role;
revoke all on function public.certify_full_outlook_exchange_truth(
  uuid, bigint, timestamptz, text, text, jsonb, jsonb, text
) from public, anon, authenticated;
revoke all on function public.get_outlook_exchange_truth_checkpoint()
  from public, anon, authenticated;
revoke all on function public.verify_outlook_exchange_truth_ledger()
  from public, anon, authenticated;

grant execute on function public.certify_full_outlook_exchange_truth(
  uuid, bigint, timestamptz, text, text, jsonb, jsonb, text
) to service_role;
grant execute on function public.get_outlook_exchange_truth_checkpoint()
  to service_role;
grant execute on function public.verify_outlook_exchange_truth_ledger()
  to service_role;
