-- Replace forgeable admin cookies with revocable server-side sessions, force a
-- safe one-time credential rotation, and contain sensitive audit history.

create extension if not exists "pgcrypto";

alter table public.admin_users
  add column if not exists is_active boolean not null default true,
  add column if not exists password_reset_required boolean not null default true;

update public.admin_users
set password_reset_required = true;

create index if not exists admin_users_active_idx
  on public.admin_users(is_active)
  where is_active;

create table if not exists public.admin_sessions (
  id uuid primary key default gen_random_uuid(),
  admin_user_id uuid not null
    references public.admin_users(id) on delete cascade,
  token_hash text not null,
  created_at timestamptz not null default clock_timestamp(),
  last_seen_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  constraint admin_sessions_token_hash_format
    check (token_hash ~ '^[0-9a-f]{64}$'),
  constraint admin_sessions_expiry
    check (expires_at > created_at),
  constraint admin_sessions_last_seen
    check (last_seen_at >= created_at),
  constraint admin_sessions_revocation
    check (revoked_at is null or revoked_at >= created_at)
);

create unique index if not exists admin_sessions_token_hash_idx
  on public.admin_sessions(token_hash);

create index if not exists admin_sessions_user_active_idx
  on public.admin_sessions(admin_user_id, expires_at)
  where revoked_at is null;

create index if not exists admin_sessions_expiry_idx
  on public.admin_sessions(expires_at);

alter table public.admin_sessions enable row level security;

update public.admin_sessions
set revoked_at = clock_timestamp()
where revoked_at is null;

do $$
declare
  policy_record record;
begin
  for policy_record in
    select policyname
    from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'admin_sessions'
  loop
    execute format(
      'drop policy %I on public.admin_sessions',
      policy_record.policyname
    );
  end loop;
end;
$$;

revoke all privileges on table public.admin_sessions
  from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.admin_sessions
  to service_role;

create or replace function public.complete_admin_password_reset(
  p_session_id uuid,
  p_new_password_hash text
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  user_id_value uuid;
  username_value text;
  display_name_value text;
  changed_at_value constant timestamptz := clock_timestamp();
begin
  if p_session_id is null
    or p_new_password_hash is null
    or p_new_password_hash !~ '^scrypt:[0-9a-f]{32}:[0-9a-f]{128}$'
  then
    raise exception 'A valid session and scrypt password hash are required.';
  end if;

  select
    users.id,
    users.username,
    coalesce(users.display_name, users.username)
  into
    user_id_value,
    username_value,
    display_name_value
  from public.admin_sessions as sessions
  join public.admin_users as users
    on users.id = sessions.admin_user_id
  where sessions.id = p_session_id
    and sessions.revoked_at is null
    and sessions.expires_at > changed_at_value
    and users.is_active
    and users.password_reset_required
  for update of sessions, users;

  if not found then
    raise exception
      'The password-reset session is invalid, expired, or already completed.';
  end if;

  perform set_config('app.audit_actor_id', username_value, true);
  perform set_config('app.audit_actor_name', display_name_value, true);
  perform set_config(
    'app.audit_context',
    jsonb_build_object(
      'action', 'password-reset',
      'pageId', 'admin-password-reset'
    )::text,
    true
  );

  update public.admin_users
  set
    password_hash = p_new_password_hash,
    password_reset_required = false
  where id = user_id_value;

  update public.admin_sessions
  set revoked_at = changed_at_value
  where admin_user_id = user_id_value
    and id <> p_session_id
    and revoked_at is null;

  return true;
end;
$$;

revoke all on function public.complete_admin_password_reset(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.complete_admin_password_reset(uuid, text)
  to service_role;

-- Audit logs are an internal service-role surface. RLS remains enabled as
-- defense in depth, and every Data API policy/grant is removed.
alter table public.audit_logs enable row level security;

do $$
declare
  policy_record record;
begin
  for policy_record in
    select policyname
    from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'audit_logs'
  loop
    execute format(
      'drop policy %I on public.audit_logs',
      policy_record.policyname
    );
  end loop;
end;
$$;

revoke all privileges on table public.audit_logs
  from public, anon, authenticated;
grant select, insert, update on table public.audit_logs
  to service_role;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create or replace function private.redact_admin_user_audit_snapshot()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if new.table_schema = 'public' and new.table_name = 'admin_users' then
    new.changed_fields := array_remove(
      coalesce(new.changed_fields, array[]::text[]),
      'password_hash'
    );
    new.before_row := new.before_row - 'password_hash';
    new.after_row := new.after_row - 'password_hash';
  end if;
  return new;
end;
$$;

revoke all on function private.redact_admin_user_audit_snapshot()
  from public, anon, authenticated;

drop trigger if exists redact_admin_user_audit_snapshot
  on public.audit_logs;
create trigger redact_admin_user_audit_snapshot
before insert or update of
  table_schema,
  table_name,
  changed_fields,
  before_row,
  after_row
on public.audit_logs
for each row
execute function private.redact_admin_user_audit_snapshot();

update public.audit_logs
set
  changed_fields = array_remove(changed_fields, 'password_hash'),
  before_row = before_row - 'password_hash',
  after_row = after_row - 'password_hash'
where table_schema = 'public'
  and table_name = 'admin_users'
  and (
    changed_fields @> array['password_hash']::text[]
    or coalesce(before_row, '{}'::jsonb) ? 'password_hash'
    or coalesce(after_row, '{}'::jsonb) ? 'password_hash'
  );

-- Undo is optimistic-concurrency protected: only the exact audited state may
-- be reversed. This prevents an old audit record overwriting later changes.
create or replace function public.undo_audit_log(
  p_log_id uuid,
  p_actor_id text default null,
  p_actor_name text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  audit_record public.audit_logs%rowtype;
  where_sql text;
  column_sql text;
  undo_log_id uuid;
  affected_rows integer;
  current_row jsonb;
begin
  select *
  into audit_record
  from public.audit_logs
  where id = p_log_id
  for update;

  if not found then
    raise exception 'Audit log % was not found.', p_log_id;
  end if;

  if audit_record.undone_at is not null then
    raise exception 'Audit log % has already been undone.', p_log_id;
  end if;

  if audit_record.undo_of_log_id is not null then
    raise exception 'Undo audit records cannot be undone directly.';
  end if;

  if audit_record.table_schema = 'public'
    and audit_record.table_name = 'admin_users'
  then
    raise exception
      'Admin-user audit records cannot be undone because credentials are redacted.';
  end if;

  where_sql := public.audit_pk_where(audit_record.record_pk);

  execute format(
    'select to_jsonb(target) from %I.%I as target where %s',
    audit_record.table_schema,
    audit_record.table_name,
    where_sql
  )
  into current_row;

  if audit_record.operation in ('INSERT', 'UPDATE') then
    if current_row is null then
      raise exception
        'Undo conflict: the current row no longer exists for audit log %.',
        p_log_id;
    end if;
    if current_row is distinct from audit_record.after_row then
      raise exception
        'Undo conflict: the row changed after audit log %. Refresh and review the latest change.',
        p_log_id;
    end if;
  elsif audit_record.operation = 'DELETE' then
    if current_row is not null then
      raise exception
        'Undo conflict: the deleted row was recreated after audit log %. Refresh and review the latest change.',
        p_log_id;
    end if;
  else
    raise exception 'Unsupported audit operation %.', audit_record.operation;
  end if;

  perform set_config('app.audit_actor_id', coalesce(p_actor_id, 'system'), true);
  perform set_config(
    'app.audit_actor_name',
    coalesce(p_actor_name, p_actor_id, 'System'),
    true
  );
  perform set_config('app.audit_undo_of_log_id', p_log_id::text, true);
  perform set_config(
    'app.audit_context',
    jsonb_build_object(
      'action', 'undo',
      'targetAuditLogId', p_log_id
    )::text,
    true
  );

  if audit_record.operation = 'INSERT' then
    execute format(
      'delete from %I.%I where %s',
      audit_record.table_schema,
      audit_record.table_name,
      where_sql
    );
  elsif audit_record.operation = 'DELETE' then
    execute format(
      'insert into %I.%I select * from jsonb_populate_record(null::%I.%I, $1)',
      audit_record.table_schema,
      audit_record.table_name,
      audit_record.table_schema,
      audit_record.table_name
    )
    using audit_record.before_row;
  else
    select string_agg(format('%I', key), ', ' order by key)
    into column_sql
    from jsonb_object_keys(audit_record.before_row) as keys(key);

    execute format(
      'update %I.%I set (%s) = (select %s from jsonb_populate_record(null::%I.%I, $1)) where %s',
      audit_record.table_schema,
      audit_record.table_name,
      column_sql,
      column_sql,
      audit_record.table_schema,
      audit_record.table_name,
      where_sql
    )
    using audit_record.before_row;
  end if;

  get diagnostics affected_rows = row_count;
  if affected_rows <> 1 then
    raise exception
      'Undo expected to affect 1 row, affected % rows.',
      affected_rows;
  end if;

  select id
  into undo_log_id
  from public.audit_logs
  where undo_of_log_id = p_log_id
  order by occurred_at desc
  limit 1;

  update public.audit_logs
  set
    undone_at = now(),
    undone_by_log_id = undo_log_id
  where id = p_log_id;

  return undo_log_id;
end;
$$;

revoke execute on function public.undo_audit_log(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.undo_audit_log(uuid, text, text)
  to service_role;

-- Admin sessions are intentionally ephemeral and must not advance the backup
-- mutation epoch on every authenticated request.
create or replace function public.get_bunker_map_backup_inventory()
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  select pg_catalog.jsonb_build_object(
    'schema', 'bunker-map.backup-inventory/v1',
    'migrationHead', (
      select max(migration.version)
      from supabase_migrations.schema_migrations as migration
    ),
    'tables', coalesce(
      (
        select pg_catalog.jsonb_agg(tables.relname order by tables.relname)
        from pg_catalog.pg_class as tables
        join pg_catalog.pg_namespace as schemas
          on schemas.oid = tables.relnamespace
        where schemas.nspname = 'public'
          and tables.relkind in ('r', 'p')
          and tables.relpersistence = 'p'
      ),
      '[]'::jsonb
    ),
    'unfencedTables', coalesce(
      (
        select pg_catalog.jsonb_agg(tables.relname order by tables.relname)
        from pg_catalog.pg_class as tables
        join pg_catalog.pg_namespace as schemas
          on schemas.oid = tables.relnamespace
        where schemas.nspname = 'public'
          and tables.relkind in ('r', 'p')
          and tables.relpersistence = 'p'
          and tables.relname not in (
            'admin_sessions',
            'bunker_map_backup_lock',
            'outlook_exchange_sync_lock'
          )
          and not exists (
            select 1
            from pg_catalog.pg_trigger as triggers
            where triggers.tgrelid = tables.oid
              and triggers.tgname = 'bunker_map_backup_epoch_fence'
              and not triggers.tgisinternal
              and triggers.tgenabled in ('O', 'A')
              and triggers.tgfoid =
                'private.record_bunker_map_backup_mutation()'::regprocedure
              and (triggers.tgtype::integer & 1) = 0
              and (triggers.tgtype::integer & 2) = 0
              and (triggers.tgtype::integer & 64) = 0
              and (triggers.tgtype::integer & 60) = 60
          )
      ),
      '[]'::jsonb
    ),
    'catalogSha256', (
      select pg_catalog.encode(
        extensions.digest(
          pg_catalog.convert_to(
            coalesce(
              pg_catalog.string_agg(
                pg_catalog.jsonb_build_array(
                  tables.relname,
                  tables.relkind,
                  columns.attnum,
                  columns.attname,
                  pg_catalog.format_type(
                    columns.atttypid,
                    columns.atttypmod
                  ),
                  columns.attnotnull,
                  columns.attidentity,
                  columns.attgenerated,
                  columns.attcollation,
                  coalesce(
                    pg_catalog.pg_get_expr(
                      defaults.adbin,
                      defaults.adrelid
                    ),
                    ''
                  )
                )::text,
                E'\n'
                order by tables.relname, columns.attnum
              ),
              ''
            ),
            'UTF8'
          ),
          'sha256'
        ),
        'hex'
      )
      from pg_catalog.pg_class as tables
      join pg_catalog.pg_namespace as schemas
        on schemas.oid = tables.relnamespace
      join pg_catalog.pg_attribute as columns
        on columns.attrelid = tables.oid
      left join pg_catalog.pg_attrdef as defaults
        on defaults.adrelid = tables.oid
        and defaults.adnum = columns.attnum
      where schemas.nspname = 'public'
        and tables.relkind in ('r', 'p')
        and tables.relpersistence = 'p'
        and columns.attnum > 0
        and not columns.attisdropped
    )
  );
$$;

revoke all on function public.get_bunker_map_backup_inventory()
  from public, anon, authenticated;
grant execute on function public.get_bunker_map_backup_inventory()
  to service_role;
