create extension if not exists "pgcrypto";

create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  occurred_at timestamptz not null default now(),
  actor_user_id uuid,
  actor_id text,
  actor_name text,
  actor_source text not null default 'unknown',
  table_schema text not null,
  table_name text not null,
  operation text not null check (operation in ('INSERT', 'UPDATE', 'DELETE')),
  record_pk jsonb not null default '{}'::jsonb,
  changed_fields text[] not null default '{}',
  before_row jsonb,
  after_row jsonb,
  request_context jsonb not null default '{}'::jsonb,
  undo_of_log_id uuid references public.audit_logs(id) on delete set null,
  undone_at timestamptz,
  undone_by_log_id uuid references public.audit_logs(id) on delete set null
);

alter table public.audit_logs
  add column if not exists actor_user_id uuid;

comment on column public.audit_logs.actor_user_id is
  'Stable SPC user UUID captured from the server-validated session. Deliberately not a foreign key so deleting a user cannot erase historical attribution.';

create index if not exists audit_logs_occurred_at_idx
on public.audit_logs(occurred_at desc);

create index if not exists audit_logs_actor_idx
on public.audit_logs(actor_id, occurred_at desc);

create index if not exists audit_logs_table_idx
on public.audit_logs(table_schema, table_name, occurred_at desc);

create index if not exists audit_logs_record_pk_idx
on public.audit_logs using gin(record_pk);

alter table public.audit_logs enable row level security;

drop policy if exists "audit_logs_read" on public.audit_logs;
revoke all on public.audit_logs from public, anon, authenticated;
grant select, insert, update on public.audit_logs to service_role;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to service_role;

create or replace function private.redact_admin_user_audit_snapshot()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if new.table_schema = 'public'
    and new.table_name in ('admin_users', 'spc_users')
  then
    new.changed_fields := array_remove(
      coalesce(new.changed_fields, '{}'::text[]),
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

create or replace function private.capture_spc_audit_actor_user_id()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
  trusted_actor_user_id_text text;
  trusted_actor_user_id uuid;
begin
  if coalesce(new.actor_id, '') !~ '^spc:.+' then
    return new;
  end if;

  trusted_actor_user_id_text := nullif(
    public.audit_request_header('x-bunker-audit-actor-user-id'),
    ''
  );
  if trusted_actor_user_id_text is null then
    return new;
  end if;

  trusted_actor_user_id := public.audit_uuid_text(trusted_actor_user_id_text);
  if trusted_actor_user_id is null then
    raise exception 'Trusted SPC audit actor user id is invalid.';
  end if;

  if new.actor_user_id is not null
    and new.actor_user_id is distinct from trusted_actor_user_id
  then
    raise exception 'Audit actor user id does not match the trusted SPC session.';
  end if;

  new.actor_user_id := trusted_actor_user_id;
  return new;
end;
$$;

create or replace function private.protect_audit_actor_user_id()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if old.actor_user_id is distinct from new.actor_user_id then
    raise exception 'Audit actor user id is immutable.';
  end if;
  return new;
end;
$$;

revoke all on function private.capture_spc_audit_actor_user_id()
  from public, anon, authenticated;
revoke all on function private.protect_audit_actor_user_id()
  from public, anon, authenticated;

drop trigger if exists capture_spc_audit_actor_user_id
  on public.audit_logs;
create trigger capture_spc_audit_actor_user_id
before insert on public.audit_logs
for each row
execute function private.capture_spc_audit_actor_user_id();

drop trigger if exists protect_audit_actor_user_id
  on public.audit_logs;
create trigger protect_audit_actor_user_id
before update of actor_user_id on public.audit_logs
for each row
execute function private.protect_audit_actor_user_id();

create or replace function public.audit_json_setting(setting_name text)
returns jsonb
language plpgsql
stable
as $$
declare
  raw_value text;
begin
  raw_value := current_setting(setting_name, true);
  if raw_value is null or raw_value = '' then
    return '{}'::jsonb;
  end if;

  return raw_value::jsonb;
exception
  when others then
    return '{}'::jsonb;
end;
$$;

create or replace function public.audit_text_setting(setting_name text)
returns text
language plpgsql
stable
as $$
declare
  raw_value text;
begin
  raw_value := current_setting(setting_name, true);
  if raw_value is null or raw_value = '' then
    return null;
  end if;

  return raw_value;
end;
$$;

create or replace function public.audit_uuid_setting(setting_name text)
returns uuid
language plpgsql
stable
as $$
declare
  raw_value text;
begin
  raw_value := public.audit_text_setting(setting_name);
  if raw_value is null then
    return null;
  end if;

  return raw_value::uuid;
exception
  when others then
    return null;
end;
$$;

create or replace function public.audit_uuid_text(raw_value text)
returns uuid
language plpgsql
immutable
set search_path = pg_catalog, pg_temp
as $$
begin
  if raw_value is null or raw_value = '' then
    return null;
  end if;

  return raw_value::uuid;
exception
  when others then
    return null;
end;
$$;

create or replace function public.audit_request_header(header_name text)
returns text
language plpgsql
stable
as $$
declare
  headers jsonb;
begin
  headers := public.audit_json_setting('request.headers');
  return coalesce(headers ->> header_name, headers ->> lower(header_name));
end;
$$;

create or replace function public.audit_row_pk(
  p_table_schema text,
  p_table_name text,
  p_row jsonb
)
returns jsonb
language plpgsql
stable
as $$
declare
  pk jsonb;
begin
  select coalesce(jsonb_object_agg(a.attname, p_row -> a.attname), '{}'::jsonb)
  into pk
  from pg_index i
  join pg_class c on c.oid = i.indrelid
  join pg_namespace n on n.oid = c.relnamespace
  join pg_attribute a on a.attrelid = c.oid and a.attnum = any(i.indkey)
  where i.indisprimary
    and n.nspname = p_table_schema
    and c.relname = p_table_name;

  if coalesce(pk, '{}'::jsonb) = '{}'::jsonb and p_row ? 'id' then
    pk := jsonb_build_object('id', p_row -> 'id');
  end if;

  return coalesce(pk, '{}'::jsonb);
end;
$$;

create or replace function public.audit_changed_fields(
  p_before jsonb,
  p_after jsonb
)
returns text[]
language sql
stable
as $$
  select coalesce(array_agg(key order by key), array[]::text[])
  from (
    select key
    from (
      select jsonb_object_keys(coalesce(p_before, '{}'::jsonb)) as key
      union
      select jsonb_object_keys(coalesce(p_after, '{}'::jsonb)) as key
    ) keys
    where (p_before -> key) is distinct from (p_after -> key)
  ) changed;
$$;

create or replace function public.audit_table_changes()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  before_payload jsonb;
  after_payload jsonb;
  changed text[];
  actor_id text;
  actor_name text;
  actor_source text;
  context_payload jsonb;
  undo_of uuid;
  correlation_id uuid;
begin
  if tg_table_schema = 'public' and tg_table_name = 'audit_logs' then
    if tg_op = 'DELETE' then
      return old;
    end if;

    return new;
  end if;

  before_payload := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) else null end;
  after_payload := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) else null end;

  if tg_op = 'UPDATE' then
    changed := array_remove(public.audit_changed_fields(before_payload, after_payload), 'updated_at');
    if coalesce(array_length(changed, 1), 0) = 0 then
      return new;
    end if;
    if tg_table_name = 'shared_addressbook_groups'
      and changed <@ array['member_count']::text[]
    then
      return new;
    end if;
  else
    changed := array[]::text[];
  end if;

  if tg_table_name = 'office_calendar_store'
    and coalesce(coalesce(after_payload, before_payload) ->> 'key', '')
      not in ('event-calendar', 'task-calendar', 'spc-permission-groups')
  then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

  actor_id := coalesce(
    nullif(public.audit_text_setting('app.audit_actor_id'), ''),
    nullif(public.audit_request_header('x-bunker-admin-user'), '')
  );

  if actor_id is null then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

  actor_name := coalesce(
    nullif(public.audit_text_setting('app.audit_actor_name'), ''),
    nullif(public.audit_request_header('x-bunker-admin-display-name'), ''),
    actor_id
  );

  actor_source := case
    when nullif(public.audit_text_setting('app.audit_actor_id'), '') is not null then 'app'
    else 'header'
  end;

  correlation_id := coalesce(
    public.audit_uuid_setting('app.audit_correlation_id'),
    public.audit_uuid_text(
      nullif(public.audit_request_header('x-bunker-audit-correlation-id'), '')
    )
  );
  if correlation_id is null then
    correlation_id := gen_random_uuid();
    perform set_config('app.audit_correlation_id', correlation_id::text, true);
  end if;

  context_payload := coalesce(
    public.audit_json_setting('app.audit_context'),
    '{}'::jsonb
  ) || jsonb_strip_nulls(
    jsonb_build_object(
      'pageId', nullif(public.audit_request_header('x-bunker-admin-page-id'), ''),
      'pageLabel', nullif(public.audit_request_header('x-bunker-admin-page-label'), ''),
      'pagePath', nullif(public.audit_request_header('x-bunker-admin-page-path'), ''),
      'sourceIp', nullif(public.audit_request_header('x-bunker-audit-source-ip'), ''),
      'correlationId', correlation_id,
      'requestId', coalesce(
        nullif(public.audit_request_header('x-bunker-audit-request-id'), ''),
        correlation_id::text
      ),
      'platformRequestId', nullif(
        public.audit_request_header('x-bunker-audit-platform-request-id'),
        ''
      ),
      'actorRole', coalesce(
        nullif(public.audit_request_header('x-bunker-audit-actor-role'), ''),
        nullif(public.audit_request_header('x-bunker-admin-role'), '')
      ),
      'action', nullif(public.audit_request_header('x-bunker-audit-action'), ''),
      'targetType', nullif(
        public.audit_request_header('x-bunker-audit-target-type'),
        ''
      ),
      'targetId', nullif(public.audit_request_header('x-bunker-audit-target-id'), ''),
      'targetUsername', nullif(
        public.audit_request_header('x-bunker-audit-target-username'),
        ''
      ),
      'outcome', coalesce(
        nullif(public.audit_request_header('x-bunker-audit-outcome'), ''),
        'success'
      ),
      'approvalReference', nullif(
        public.audit_request_header('x-bunker-audit-approval-reference'),
        ''
      ),
      'passwordChanged', case
        when public.audit_request_header('x-bunker-audit-password-changed') = 'true'
          then true
        else null
      end
    )
  );
  undo_of := public.audit_uuid_setting('app.audit_undo_of_log_id');

  insert into public.audit_logs (
    actor_id,
    actor_name,
    actor_source,
    table_schema,
    table_name,
    operation,
    record_pk,
    changed_fields,
    before_row,
    after_row,
    request_context,
    undo_of_log_id
  )
  values (
    actor_id,
    actor_name,
    actor_source,
    tg_table_schema,
    tg_table_name,
    tg_op,
    public.audit_row_pk(tg_table_schema, tg_table_name, coalesce(after_payload, before_payload)),
    changed,
    before_payload,
    after_payload,
    context_payload,
    undo_of
  );

  if tg_op = 'DELETE' then
    return old;
  end if;

  return new;
end;
$$;

create or replace function public.audit_pk_where(p_pk jsonb)
returns text
language plpgsql
stable
as $$
declare
  where_sql text;
begin
  if p_pk is null or p_pk = '{}'::jsonb then
    raise exception 'Cannot undo audit log without a primary key snapshot.';
  end if;

  select string_agg(format('%I = %L', key, value), ' and ' order by key)
  into where_sql
  from jsonb_each_text(p_pk);

  if where_sql is null or where_sql = '' then
    raise exception 'Cannot undo audit log without a primary key snapshot.';
  end if;

  return where_sql;
end;
$$;

create or replace function public.audit_undo_context(p_log_id uuid)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
  select pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'pageId', nullif(public.audit_request_header('x-bunker-admin-page-id'), ''),
    'pageLabel', nullif(
      public.audit_request_header('x-bunker-admin-page-label'),
      ''
    ),
    'pagePath', nullif(public.audit_request_header('x-bunker-admin-page-path'), ''),
    'sourceIp', nullif(public.audit_request_header('x-bunker-audit-source-ip'), ''),
    'correlationId', public.audit_uuid_text(nullif(
      public.audit_request_header('x-bunker-audit-correlation-id'),
      ''
    )),
    'requestId', coalesce(
      public.audit_uuid_text(nullif(
        public.audit_request_header('x-bunker-audit-request-id'),
        ''
      ))::text,
      public.audit_uuid_text(nullif(
        public.audit_request_header('x-bunker-audit-correlation-id'),
        ''
      ))::text
    ),
    'platformRequestId', nullif(
      public.audit_request_header('x-bunker-audit-platform-request-id'),
      ''
    ),
    'actorRole', coalesce(
      nullif(public.audit_request_header('x-bunker-audit-actor-role'), ''),
      nullif(public.audit_request_header('x-bunker-admin-role'), '')
    ),
    'action', coalesce(
      nullif(public.audit_request_header('x-bunker-audit-action'), ''),
      'undo'
    ),
    'targetType', nullif(
      public.audit_request_header('x-bunker-audit-target-type'),
      ''
    ),
    'targetId', nullif(public.audit_request_header('x-bunker-audit-target-id'), ''),
    'targetUsername', nullif(
      public.audit_request_header('x-bunker-audit-target-username'),
      ''
    ),
    'outcome', coalesce(
      nullif(public.audit_request_header('x-bunker-audit-outcome'), ''),
      'success'
    ),
    'approvalReference', nullif(
      public.audit_request_header('x-bunker-audit-approval-reference'),
      ''
    ),
    'passwordChanged', case
      when public.audit_request_header('x-bunker-audit-password-changed') = 'true'
        then true
      else null
    end,
    'targetAuditLogId', p_log_id
  ));
$$;

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
    and audit_record.table_name in ('admin_users', 'spc_users')
  then
    raise exception
      'Credential-bearing user audit records cannot be undone because credentials are redacted.';
  end if;

  perform set_config('app.audit_actor_id', coalesce(p_actor_id, 'system'), true);
  perform set_config('app.audit_actor_name', coalesce(p_actor_name, p_actor_id, 'System'), true);
  perform set_config('app.audit_undo_of_log_id', p_log_id::text, true);
  perform set_config(
    'app.audit_context',
    public.audit_undo_context(p_log_id)::text,
    true
  );

  where_sql := public.audit_pk_where(audit_record.record_pk);

  if audit_record.operation = 'INSERT' then
    execute format(
      'select to_jsonb(target_row) from %I.%I as target_row where %s',
      audit_record.table_schema,
      audit_record.table_name,
      where_sql
    )
    into current_row;

    if current_row is distinct from audit_record.after_row then
      raise exception
        'Undo conflict: the current row no longer matches audit log %.',
        p_log_id;
    end if;

    execute format(
      'delete from %I.%I where %s',
      audit_record.table_schema,
      audit_record.table_name,
      where_sql
    );
  elsif audit_record.operation = 'DELETE' then
    execute format(
      'select to_jsonb(target_row) from %I.%I as target_row where %s',
      audit_record.table_schema,
      audit_record.table_name,
      where_sql
    )
    into current_row;

    if current_row is not null then
      raise exception
        'Undo conflict: a current row already exists for audit log %.',
        p_log_id;
    end if;

    execute format(
      'insert into %I.%I select * from jsonb_populate_record(null::%I.%I, $1)',
      audit_record.table_schema,
      audit_record.table_name,
      audit_record.table_schema,
      audit_record.table_name
    )
    using audit_record.before_row;
  elsif audit_record.operation = 'UPDATE' then
    execute format(
      'select to_jsonb(target_row) from %I.%I as target_row where %s',
      audit_record.table_schema,
      audit_record.table_name,
      where_sql
    )
    into current_row;

    if current_row is distinct from audit_record.after_row then
      raise exception
        'Undo conflict: the current row no longer matches audit log %.',
        p_log_id;
    end if;

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
  else
    raise exception 'Unsupported audit operation %.', audit_record.operation;
  end if;

  get diagnostics affected_rows = row_count;
  if affected_rows <> 1 then
    raise exception 'Undo expected to affect 1 row, affected % rows.', affected_rows;
  end if;

  select id
  into undo_log_id
  from public.audit_logs
  where undo_of_log_id = p_log_id
  order by occurred_at desc
  limit 1;

  update public.audit_logs
  set undone_at = now(),
      undone_by_log_id = undo_log_id
  where id = p_log_id;

  return undo_log_id;
end;
$$;

create or replace function public.audit_enable_table(p_table regclass)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  execute format('drop trigger if exists bunker_audit_log on %s', p_table);
  execute format(
    'create trigger bunker_audit_log after insert or update or delete on %s for each row execute function public.audit_table_changes()',
    p_table
  );
end;
$$;

do $$
declare
  table_name text;
  table_reg regclass;
begin
  foreach table_name in array array[
    'ports',
    'price_history',
    'remarks',
    'cc_countries',
    'cc_companies',
    'cc_ports',
    'cc_documents',
    'cc_company_files',
    'cc_entry_files',
    'cc_entry_folders',
    'phonebook_contacts',
    'phonebook_companies',
    'shared_addressbook_contacts',
    'shared_addressbook_groups',
    'shared_addressbook_group_members',
    'office_calendar_store',
    'email_templates',
    'admin_users',
    'admin_role_defaults',
    'spc_users',
    'spc_enquiries',
    'spc_fixtures',
    'attendance_people',
    'attendance_team_assignments',
    'attendance_leave_entries',
    'attendance_manual_overrides',
    'attendance_work_mode_policies',
    'attendance_work_mode_overrides',
    'attendance_entitlements',
    'attendance_monthly_adjustments',
    'attendance_monthly_confirmations',
    'attendance_reminder_dispatches'
  ]
  loop
    table_reg := to_regclass('public.' || table_name);
    if table_reg is not null then
      perform public.audit_enable_table(table_reg);
    end if;
  end loop;
end $$;

revoke execute on function public.audit_enable_table(regclass) from public, anon, authenticated;
revoke execute on function public.audit_table_changes() from public, anon, authenticated;
revoke execute on function public.audit_uuid_text(text) from public, anon, authenticated;
revoke all on function public.audit_undo_context(uuid)
  from public, anon, authenticated, service_role;
revoke execute on function public.undo_audit_log(uuid, text, text) from public, anon, authenticated;

grant execute on function public.audit_enable_table(regclass) to service_role;
grant execute on function public.undo_audit_log(uuid, text, text) to service_role;

create or replace function private.block_spc_permission_store_partial_undo()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if nullif(
    pg_catalog.current_setting('app.audit_undo_of_log_id', true),
    ''
  ) is not null
    and (
      coalesce(pg_catalog.to_jsonb(new) ->> 'key', '') = 'spc-permission-groups'
      or coalesce(pg_catalog.to_jsonb(old) ->> 'key', '') = 'spc-permission-groups'
    )
  then
    raise exception
      'SPC permission-group audit records cannot be undone independently. Use SPC User Management.'
      using errcode = 'P0001';
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

revoke all on function private.block_spc_permission_store_partial_undo()
  from public, anon, authenticated, service_role;

drop trigger if exists block_partial_spc_permission_store_audit_undo
  on public.office_calendar_store;
create trigger block_partial_spc_permission_store_audit_undo
before insert or update or delete on public.office_calendar_store
for each row
execute function private.block_spc_permission_store_partial_undo();

create or replace function private.is_spc_user_management_audit_record(
  p_record public.audit_logs
)
returns boolean
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
  select
    (
      p_record.table_schema = 'app'
      and p_record.table_name = 'spc_user_management_events'
    )
    or (
      p_record.table_schema = 'public'
      and p_record.table_name in ('spc_users', 'spc_role_defaults')
    )
    or (
      p_record.table_schema = 'public'
      and p_record.table_name = 'office_calendar_store'
      and coalesce(
        p_record.record_pk ->> 'key',
        p_record.after_row ->> 'key',
        p_record.before_row ->> 'key'
      ) = 'spc-permission-groups'
    );
$$;

create or replace function private.protect_spc_user_management_audit_record()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
  old_is_protected boolean := false;
  new_is_protected boolean := false;
  source_ip_value text;
begin
  if tg_op <> 'INSERT' then
    old_is_protected := private.is_spc_user_management_audit_record(old);
  end if;
  if tg_op <> 'DELETE' then
    new_is_protected := private.is_spc_user_management_audit_record(new);
  end if;

  if tg_op = 'INSERT'
    and new.table_schema = 'app'
    and new.table_name = 'spc_user_management_events'
  then
    source_ip_value := new.request_context ->> 'sourceIp';

    if new.actor_source is distinct from 'app'
      or coalesce(new.actor_id, '') !~ '^spc:.+'
      or nullif(pg_catalog.btrim(new.actor_name), '') is null
      or pg_catalog.length(new.actor_id) > 324
      or pg_catalog.length(new.actor_name) > 256
      or new.before_row is not null
      or coalesce(pg_catalog.array_length(new.changed_fields, 1), 0) <> 0
      or new.undo_of_log_id is not null
      or new.undone_at is not null
      or new.undone_by_log_id is not null
      or pg_catalog.jsonb_typeof(new.record_pk) is distinct from 'object'
      or not (new.record_pk ?& array['requestId', 'targetType'])
      or (
        new.record_pk - array['requestId', 'targetType', 'targetId']
      ) <> '{}'::jsonb
      or coalesce(new.record_pk ->> 'requestId', '')
        !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      or pg_catalog.jsonb_typeof(new.after_row) is distinct from 'object'
      or not (
        new.after_row ?& array[
          'schema',
          'action',
          'outcome',
          'errorCode',
          'targetType'
        ]
      )
      or (
        new.after_row - array[
          'schema',
          'action',
          'outcome',
          'errorCode',
          'targetType',
          'targetId',
          'targetUsername'
        ]
      ) <> '{}'::jsonb
      or new.after_row ->> 'schema'
        is distinct from 'fcuno.spc-user-management-audit/v1'
      or coalesce(new.after_row ->> 'action', '')
        !~ '^[a-z0-9][a-z0-9._:-]{0,127}$'
      or coalesce(new.after_row ->> 'outcome', '') not in ('failed', 'denied')
      or coalesce(new.after_row ->> 'errorCode', '')
        !~ '^[a-z0-9][a-z0-9._:-]{0,127}$'
      or coalesce(new.after_row ->> 'targetType', '')
        !~ '^[a-z0-9][a-z0-9._:-]{0,127}$'
      or pg_catalog.jsonb_typeof(new.request_context) is distinct from 'object'
      or not (
        new.request_context ?& array[
          'pageId',
          'pageLabel',
          'pagePath',
          'correlationId',
          'requestId',
          'actorRole',
          'action',
          'targetType',
          'outcome'
        ]
      )
      or (
        new.request_context - array[
          'pageId',
          'pageLabel',
          'pagePath',
          'sourceIp',
          'correlationId',
          'requestId',
          'platformRequestId',
          'actorRole',
          'action',
          'targetType',
          'targetId',
          'targetUsername',
          'outcome',
          'approvalReference',
          'passwordChanged'
        ]
      ) <> '{}'::jsonb
      or new.request_context ->> 'pageId' is distinct from 'spc-user-management'
      or coalesce(new.request_context ->> 'correlationId', '')
        !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      or new.request_context ->> 'requestId'
        is distinct from new.record_pk ->> 'requestId'
      or new.request_context ->> 'action'
        is distinct from new.after_row ->> 'action'
      or new.request_context ->> 'outcome'
        is distinct from new.after_row ->> 'outcome'
      or new.request_context ->> 'targetType'
        is distinct from new.after_row ->> 'targetType'
      or new.request_context ->> 'targetId'
        is distinct from new.after_row ->> 'targetId'
      or new.request_context ->> 'targetUsername'
        is distinct from new.after_row ->> 'targetUsername'
      or nullif(pg_catalog.btrim(new.request_context ->> 'actorRole'), '') is null
      or pg_catalog.length(new.request_context ->> 'actorRole') > 128
      or (
        new.request_context ? 'platformRequestId'
        and (
          coalesce(new.request_context ->> 'platformRequestId', '')
            !~ '^[A-Za-z0-9._:-]+$'
          or pg_catalog.length(
            new.request_context ->> 'platformRequestId'
          ) > 256
        )
      )
      or (
        new.request_context ? 'approvalReference'
        and (
          pg_catalog.length(new.request_context ->> 'approvalReference') > 256
          or new.request_context ->> 'approvalReference' ~ '[[:cntrl:]]'
        )
      )
    then
      raise exception 'Invalid SPC user-management audit event.';
    end if;

    if source_ip_value is not null then
      if position('/' in source_ip_value) > 0 then
        raise exception 'Invalid SPC user-management audit source IP.';
      end if;
      begin
        perform source_ip_value::inet;
      exception
        when others then
          raise exception 'Invalid SPC user-management audit source IP.';
      end;
    end if;

    return new;
  end if;

  if tg_op = 'UPDATE' and (old_is_protected or new_is_protected) then
    if old_is_protected
      and new_is_protected
      and (
        to_jsonb(new) - array['undone_at', 'undone_by_log_id']
      ) is not distinct from (
        to_jsonb(old) - array['undone_at', 'undone_by_log_id']
      )
      and old.undone_at is null
      and old.undone_by_log_id is null
      and new.undone_at is not null
      and new.undone_by_log_id is not null
      and pg_catalog.current_setting('app.audit_undo_of_log_id', true) = old.id::text
      and exists (
        select 1
        from public.audit_logs as undo_log
        where undo_log.id = new.undone_by_log_id
          and undo_log.undo_of_log_id = old.id
      )
    then
      return new;
    end if;

    raise exception 'SPC user-management audit records are append-only.';
  end if;

  if tg_op = 'DELETE' and old_is_protected then
    raise exception 'SPC user-management audit records are append-only.';
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create or replace function private.protect_spc_user_management_audit_truncate()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  raise exception
    'audit_logs cannot be truncated because it contains protected SPC user-management evidence.';
end;
$$;

revoke all on function private.is_spc_user_management_audit_record(public.audit_logs)
  from public, anon, authenticated;
revoke all on function private.protect_spc_user_management_audit_record()
  from public, anon, authenticated;
revoke all on function private.protect_spc_user_management_audit_truncate()
  from public, anon, authenticated;
grant execute on function private.is_spc_user_management_audit_record(public.audit_logs)
  to service_role;

drop trigger if exists protect_spc_user_management_audit_record
  on public.audit_logs;
create trigger protect_spc_user_management_audit_record
before insert or update or delete on public.audit_logs
for each row
execute function private.protect_spc_user_management_audit_record();

drop trigger if exists protect_spc_user_management_audit_truncate
  on public.audit_logs;
create trigger protect_spc_user_management_audit_truncate
before truncate on public.audit_logs
for each statement
execute function private.protect_spc_user_management_audit_truncate();

-- Record Outlook template insertion as an append-only two-phase audit stream.
-- Keep this baseline definition in lockstep with
-- 20260723141044_outlook_insertion_audit_state_machine.sql.
drop index if exists
  public.audit_logs_outlook_template_insertion_operation_id_key;

create unique index if not exists
  audit_logs_outlook_template_insertion_operation_phase_key
  on public.audit_logs (
    (record_pk ->> 'operationId'),
    (record_pk ->> 'phase')
  )
  where table_schema = 'app'
    and table_name = 'outlook_template_insertion_attempts'
    and operation = 'INSERT'
    and record_pk ->> 'phase' in ('reserved', 'terminal')
    and record_pk ? 'operationId';

create or replace function private.protect_outlook_template_insertion_audit_event()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
  event_phase text;
  event_outcome text;
  event_time_value timestamptz;
  reservation_record public.audit_logs%rowtype;
begin
  if tg_op = 'UPDATE'
    and (
      (
        old.table_schema = 'app'
        and old.table_name = 'outlook_template_insertion_attempts'
      )
      or (
        new.table_schema = 'app'
        and new.table_name = 'outlook_template_insertion_attempts'
      )
    )
  then
    raise exception
      'Outlook template insertion audit events are append-only.';
  end if;

  if tg_op = 'DELETE'
    and old.table_schema = 'app'
    and old.table_name = 'outlook_template_insertion_attempts'
  then
    raise exception
      'Outlook template insertion audit events are append-only.';
  end if;

  if tg_op <> 'INSERT'
    or new.table_schema is distinct from 'app'
    or new.table_name is distinct from 'outlook_template_insertion_attempts'
  then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  event_phase := new.record_pk ->> 'phase';
  event_outcome := new.after_row ->> 'outcome';

  if new.operation is distinct from 'INSERT'
    or new.actor_source is distinct from 'app'
    or nullif(pg_catalog.btrim(new.actor_id), '') is null
    or nullif(pg_catalog.btrim(new.actor_name), '') is null
    or pg_catalog.length(new.actor_id) > 256
    or pg_catalog.length(new.actor_name) > 256
    or new.before_row is not null
    or coalesce(pg_catalog.array_length(new.changed_fields, 1), 0) <> 0
    or new.undo_of_log_id is not null
    or new.undone_at is not null
    or new.undone_by_log_id is not null
    or pg_catalog.jsonb_typeof(new.record_pk) is distinct from 'object'
    or not (
      new.record_pk ?& array[
        'operationId',
        'phase',
        'templateId',
        'templateRevision'
      ]
    )
    or (
      new.record_pk - array[
        'operationId',
        'phase',
        'templateId',
        'templateRevision'
      ]
    ) <> '{}'::jsonb
    or coalesce(new.record_pk ->> 'operationId', '')
      !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or event_phase is null
    or event_phase not in ('reserved', 'terminal')
    or nullif(pg_catalog.btrim(new.record_pk ->> 'templateId'), '') is null
    or pg_catalog.length(new.record_pk ->> 'templateId') > 256
    or coalesce(new.record_pk ->> 'templateRevision', '')
      !~ '^[1-9][0-9]*$'
    or (new.record_pk ->> 'templateRevision')::numeric > 2147483647
    or pg_catalog.jsonb_typeof(new.after_row) is distinct from 'object'
    or new.after_row ->> 'schema'
      is distinct from 'fcuno.outlook-template-insertion-audit/v2'
    or new.after_row ->> 'phase' is distinct from event_phase
    or new.after_row ->> 'operationId'
      is distinct from new.record_pk ->> 'operationId'
    or new.after_row ->> 'templateId'
      is distinct from new.record_pk ->> 'templateId'
    or new.after_row ->> 'templateRevision'
      is distinct from new.record_pk ->> 'templateRevision'
    or coalesce(new.after_row ->> 'certificationRunId', '')
      !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or coalesce(new.after_row ->> 'sourceFingerprint', '')
      !~ '^[0-9a-f]{64}$'
    or new.request_context ->> 'pageId' is distinct from 'email-templates'
    or new.request_context ->> 'auditPhase' is distinct from event_phase
    or new.request_context ->> 'action'
      is distinct from 'outlook-draft-insertion-' || event_phase
  then
    raise exception
      'Invalid Outlook template insertion audit event.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'outlook_template_insertion_operation:'
        || (new.record_pk ->> 'operationId'),
      0
    )
  );

  begin
    event_time_value := (new.after_row ->> 'eventAt')::timestamptz;
  exception
    when others then
      raise exception
        'Outlook template insertion audit eventAt must be a valid timestamp.';
  end;

  if event_time_value is distinct from new.occurred_at then
    raise exception
      'Outlook template insertion audit eventAt must match occurred_at.';
  end if;

  if event_phase = 'reserved' then
    if pg_catalog.current_setting(
      'app.outlook_insertion_reservation_operation_id',
      true
    ) is distinct from new.record_pk ->> 'operationId'
      or not (
      new.after_row ?& array[
        'schema',
        'phase',
        'operationId',
        'templateId',
        'templateTitle',
        'templateRevision',
        'certificationRunId',
        'sourceFingerprint',
        'eventAt'
      ]
    )
      or (
        new.after_row - array[
          'schema',
          'phase',
          'operationId',
          'templateId',
          'templateTitle',
          'templateRevision',
          'certificationRunId',
          'sourceFingerprint',
          'eventAt'
        ]
      ) <> '{}'::jsonb
      or event_outcome is not null
      or pg_catalog.jsonb_typeof(new.after_row -> 'templateTitle')
        is distinct from 'string'
      or nullif(
        pg_catalog.btrim(new.after_row ->> 'templateTitle'),
        ''
      ) is null
      or pg_catalog.length(new.after_row ->> 'templateTitle') > 512
      or new.request_context ? 'auditOutcome'
    then
      raise exception
        'Invalid Outlook template insertion reservation event.';
    end if;

    return new;
  end if;

  if not (
    new.after_row ?& array[
      'schema',
      'phase',
      'outcome',
      'operationId',
      'templateId',
      'templateRevision',
      'certificationRunId',
      'sourceFingerprint',
      'reservationAuditLogId',
      'eventAt'
    ]
  )
    or (
      new.after_row - array[
        'schema',
        'phase',
        'outcome',
        'operationId',
        'templateId',
        'templateRevision',
        'certificationRunId',
        'sourceFingerprint',
        'reservationAuditLogId',
        'eventAt'
      ]
    ) <> '{}'::jsonb
    or event_outcome is null
    or event_outcome not in (
      'inserted',
      'failed-restored',
      'failed-preserved'
    )
    or coalesce(new.after_row ->> 'reservationAuditLogId', '')
      !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or new.request_context ->> 'auditOutcome'
      is distinct from event_outcome
  then
    raise exception
      'Invalid Outlook template insertion terminal event.';
  end if;

  select logs.*
  into reservation_record
  from public.audit_logs as logs
  where logs.table_schema = 'app'
    and logs.table_name = 'outlook_template_insertion_attempts'
    and logs.operation = 'INSERT'
    and logs.record_pk ->> 'operationId'
      = new.record_pk ->> 'operationId'
    and logs.record_pk ->> 'phase' = 'reserved'
  limit 1;

  if not found
    or reservation_record.id::text
      is distinct from new.after_row ->> 'reservationAuditLogId'
    or reservation_record.actor_id is distinct from new.actor_id
    or reservation_record.record_pk ->> 'templateId'
      is distinct from new.record_pk ->> 'templateId'
    or reservation_record.record_pk ->> 'templateRevision'
      is distinct from new.record_pk ->> 'templateRevision'
    or reservation_record.after_row ->> 'certificationRunId'
      is distinct from new.after_row ->> 'certificationRunId'
    or reservation_record.after_row ->> 'sourceFingerprint'
      is distinct from new.after_row ->> 'sourceFingerprint'
    or event_time_value < reservation_record.occurred_at
  then
    raise exception
      'A matching Outlook template insertion reservation is required before a terminal event.';
  end if;

  return new;
end;
$$;

revoke all on function
  private.protect_outlook_template_insertion_audit_event()
  from public, anon, authenticated;

drop trigger if exists protect_outlook_template_insertion_audit_event
  on public.audit_logs;
create trigger protect_outlook_template_insertion_audit_event
before insert or update or delete on public.audit_logs
for each row
execute function private.protect_outlook_template_insertion_audit_event();

create or replace function public.reserve_outlook_template_insertion(
  p_operation_id uuid,
  p_template_id text,
  p_template_revision bigint,
  p_certification_run_id uuid,
  p_source_fingerprint text,
  p_actor_id text,
  p_actor_name text,
  p_certification_max_age_seconds integer
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
  normalized_template_id text := pg_catalog.btrim(p_template_id);
  normalized_fingerprint text := pg_catalog.lower(
    pg_catalog.btrim(p_source_fingerprint)
  );
  normalized_actor_id text := pg_catalog.btrim(p_actor_id);
  normalized_actor_name text := coalesce(
    nullif(pg_catalog.btrim(p_actor_name), ''),
    normalized_actor_id
  );
  reservation_record record;
  template_record record;
  template_truth jsonb;
  exchange_truth jsonb;
  queue_state jsonb;
  event_time timestamptz;
  latest_certified_at timestamptz;
  inserted_audit_log_id uuid;
  reservation_is_idempotent boolean := false;
  reservation_ttl_seconds constant integer := 120;
begin
  if p_operation_id is null
    or p_operation_id::text
      !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or nullif(normalized_template_id, '') is null
    or pg_catalog.length(normalized_template_id) > 256
    or p_template_revision is null
    or p_template_revision < 1
    or p_template_revision > 2147483647
    or p_certification_run_id is null
    or p_certification_run_id::text
      !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or coalesce(normalized_fingerprint, '') !~ '^[0-9a-f]{64}$'
    or nullif(normalized_actor_id, '') is null
    or pg_catalog.length(normalized_actor_id) > 256
    or pg_catalog.length(normalized_actor_name) > 256
    or p_certification_max_age_seconds is null
    or p_certification_max_age_seconds < 120
    or p_certification_max_age_seconds > 604800
  then
    raise exception
      'OUTLOOK_INSERTION_RESERVATION_INVALID: reservation input is malformed.'
      using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'outlook_template_insertion_operation:' || p_operation_id::text,
      0
    )
  );

  select logs.*
  into reservation_record
  from public.audit_logs as logs
  where logs.table_schema = 'app'
    and logs.table_name = 'outlook_template_insertion_attempts'
    and logs.operation = 'INSERT'
    and logs.record_pk ->> 'operationId' = p_operation_id::text
    and logs.record_pk ->> 'phase' = 'reserved'
  limit 1;

  if found then
    if reservation_record.actor_id is not distinct from normalized_actor_id
      and reservation_record.record_pk ->> 'templateId'
        is not distinct from normalized_template_id
      and reservation_record.record_pk ->> 'templateRevision'
        is not distinct from p_template_revision::text
      and reservation_record.after_row ->> 'schema'
        is not distinct from 'fcuno.outlook-template-insertion-audit/v2'
      and reservation_record.after_row ->> 'phase'
        is not distinct from 'reserved'
      and reservation_record.after_row ->> 'operationId'
        is not distinct from p_operation_id::text
      and reservation_record.after_row ->> 'templateId'
        is not distinct from normalized_template_id
      and reservation_record.after_row ->> 'templateRevision'
        is not distinct from p_template_revision::text
      and reservation_record.after_row ->> 'certificationRunId'
        is not distinct from p_certification_run_id::text
      and reservation_record.after_row ->> 'sourceFingerprint'
        is not distinct from normalized_fingerprint
      and pg_catalog.jsonb_typeof(
        reservation_record.after_row -> 'templateTitle'
      ) is not distinct from 'string'
      and nullif(
        pg_catalog.btrim(
          reservation_record.after_row ->> 'templateTitle'
        ),
        ''
      ) is not null
    then
      reservation_is_idempotent := true;
    else
      raise exception
        'OUTLOOK_INSERTION_OPERATION_CONFLICT: operation identifier is already reserved for different evidence.'
        using errcode = '23505';
    end if;
  end if;

  if reservation_is_idempotent
    and exists (
      select 1
      from public.audit_logs as logs
      where logs.table_schema = 'app'
        and logs.table_name = 'outlook_template_insertion_attempts'
        and logs.operation = 'INSERT'
        and logs.record_pk ->> 'operationId' = p_operation_id::text
        and logs.record_pk ->> 'phase' = 'terminal'
    )
  then
    raise exception
      'OUTLOOK_INSERTION_OPERATION_COMPLETED: completed insertion operations cannot be reserved again.'
      using errcode = '23505';
  end if;

  if not reservation_is_idempotent and exists (
    select 1
    from public.audit_logs as logs
    where logs.table_schema = 'app'
      and logs.table_name = 'outlook_template_insertion_attempts'
      and logs.operation = 'INSERT'
      and logs.record_pk ->> 'operationId' = p_operation_id::text
  ) then
    raise exception
      'OUTLOOK_INSERTION_OPERATION_CONFLICT: operation identifier is already used by another insertion event.'
      using errcode = '23505';
  end if;

  -- Every Exchange truth writer acquires this transaction lock before commit.
  -- This VOLATILE function takes a fresh snapshot for each internal query, so
  -- validation after a lock wait observes the writer that just committed.
  perform pg_catalog.pg_advisory_xact_lock(
    913047563612485921::bigint
  );

  -- Canonical template writes and certification reconciliation use this same
  -- lock. The row lock additionally covers a direct concurrent UPDATE/DELETE.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('email_templates_canonical_write', 0)
  );

  select template.*
  into template_record
  from public.email_templates as template
  where template.id = normalized_template_id
  for share;

  if not found
    or template_record.is_active is not true
    or nullif(pg_catalog.btrim(template_record.title), '') is null
    or pg_catalog.length(template_record.title) > 512
    or template_record.revision is distinct from p_template_revision
    or not public.is_valid_outlook_template_recipient_resolution(
      template_record.recipient_resolution
    )
    or template_record.recipient_resolution ->> 'reconciliationRequired'
      is distinct from 'false'
    or template_record.recipient_resolution ->> 'certificationRunId'
      is distinct from p_certification_run_id::text
    or pg_catalog.lower(
      template_record.recipient_resolution ->> 'sourceFingerprint'
    ) is distinct from normalized_fingerprint
    or coalesce(
      template_record.recipient_resolution #>> '{counts,ambiguous}',
      ''
    ) is distinct from '0'
    or coalesce(
      template_record.recipient_resolution #>> '{counts,missing}',
      ''
    ) is distinct from '0'
    or (
      reservation_is_idempotent
      and reservation_record.after_row ->> 'templateTitle'
        is distinct from template_record.title
    )
  then
    raise exception
      'OUTLOOK_INSERTION_TEMPLATE_CHANGED: template revision or recipient evidence is no longer insertable.'
      using errcode = '40001';
  end if;

  template_truth := public.verify_outlook_template_recipient_truth();
  exchange_truth := public.verify_outlook_exchange_truth_ledger();
  queue_state := coalesce(exchange_truth -> 'queue', '{}'::jsonb);
  event_time := pg_catalog.clock_timestamp();

  begin
    latest_certified_at := nullif(
      exchange_truth ->> 'latestCertificationAt',
      ''
    )::timestamptz;
  exception
    when others then
      latest_certified_at := null;
  end;

  if template_truth ->> 'valid' is distinct from 'true'
    or template_truth ->> 'sourceTruthValid' is distinct from 'true'
    or template_truth ->> 'certificationRunId'
      is distinct from p_certification_run_id::text
    or pg_catalog.lower(template_truth ->> 'sourceFingerprint')
      is distinct from normalized_fingerprint
    or exchange_truth ->> 'valid' is distinct from 'true'
    or exchange_truth ->> 'integrityValid' is distinct from 'true'
    or exchange_truth ->> 'ledgerValid' is distinct from 'true'
    or exchange_truth ->> 'snapshotsValid' is distinct from 'true'
    or exchange_truth ->> 'referencesValid' is distinct from 'true'
    or exchange_truth ->> 'operationallyConsistent'
      is distinct from 'true'
    or exchange_truth ->> 'latestCertificationHasProjectionEvidence'
      is distinct from 'true'
    or exchange_truth ->> 'latestCertificationRunId'
      is distinct from p_certification_run_id::text
    or pg_catalog.lower(exchange_truth ->> 'latestSourceFingerprint')
      is distinct from normalized_fingerprint
    or pg_catalog.lower(
      exchange_truth ->> 'latestProjectionSnapshotSha256'
    ) is distinct from normalized_fingerprint
    or coalesce(queue_state ->> 'pending', '') is distinct from '0'
    or coalesce(queue_state ->> 'processing', '') is distinct from '0'
    or coalesce(queue_state ->> 'failed', '') is distinct from '0'
    or coalesce(queue_state ->> 'terminalFailed', '') is distinct from '0'
    or latest_certified_at is null
    or latest_certified_at
      > event_time + pg_catalog.make_interval(secs => 300)
    or latest_certified_at
      < event_time
        - pg_catalog.make_interval(
          secs => p_certification_max_age_seconds
        )
  then
    raise exception
      'OUTLOOK_INSERTION_TRUTH_STALE: certified Exchange truth is not exact, settled, and current.'
      using errcode = '55000';
  end if;

  if reservation_is_idempotent
    and (
      reservation_record.occurred_at is null
      or reservation_record.occurred_at > event_time
      or reservation_record.occurred_at
        < event_time
          - pg_catalog.make_interval(secs => reservation_ttl_seconds)
    )
  then
    raise exception
      'OUTLOOK_INSERTION_RESERVATION_EXPIRED: insertion reservations expire after 120 seconds.'
      using errcode = '55000';
  end if;

  if reservation_is_idempotent then
    return pg_catalog.jsonb_build_object(
      'reserved', true,
      'idempotent', true,
      'auditLogId', reservation_record.id,
      'eventAt', reservation_record.occurred_at
    );
  end if;

  perform pg_catalog.set_config(
    'app.outlook_insertion_reservation_operation_id',
    p_operation_id::text,
    true
  );

  insert into public.audit_logs (
    occurred_at,
    actor_id,
    actor_name,
    actor_source,
    table_schema,
    table_name,
    operation,
    record_pk,
    changed_fields,
    before_row,
    after_row,
    request_context
  )
  values (
    event_time,
    normalized_actor_id,
    normalized_actor_name,
    'app',
    'app',
    'outlook_template_insertion_attempts',
    'INSERT',
    pg_catalog.jsonb_build_object(
      'operationId', p_operation_id,
      'phase', 'reserved',
      'templateId', normalized_template_id,
      'templateRevision', p_template_revision
    ),
    array[]::text[],
    null,
    pg_catalog.jsonb_build_object(
      'schema', 'fcuno.outlook-template-insertion-audit/v2',
      'phase', 'reserved',
      'operationId', p_operation_id,
      'templateId', normalized_template_id,
      'templateTitle', template_record.title,
      'templateRevision', p_template_revision,
      'certificationRunId', p_certification_run_id,
      'sourceFingerprint', normalized_fingerprint,
      'eventAt', event_time
    ),
    pg_catalog.jsonb_build_object(
      'pageId', 'email-templates',
      'pageLabel', 'OUTLOOK TEMPLATES',
      'pagePath', '/api/outlook-addin/taskpane',
      'action', 'outlook-draft-insertion-reserved',
      'auditPhase', 'reserved'
    )
  )
  returning id into inserted_audit_log_id;

  return pg_catalog.jsonb_build_object(
    'reserved', true,
    'idempotent', false,
    'auditLogId', inserted_audit_log_id,
    'eventAt', event_time
  );
end;
$$;

revoke all on function public.reserve_outlook_template_insertion(
  uuid,
  text,
  bigint,
  uuid,
  text,
  text,
  text,
  integer
)
  from public, anon, authenticated;
grant execute on function public.reserve_outlook_template_insertion(
  uuid,
  text,
  bigint,
  uuid,
  text,
  text,
  text,
  integer
)
  to service_role;

create or replace function public.complete_outlook_template_insertion(
  p_operation_id uuid,
  p_template_id text,
  p_template_revision bigint,
  p_certification_run_id uuid,
  p_source_fingerprint text,
  p_actor_id text,
  p_actor_name text,
  p_outcome text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
  normalized_template_id text := pg_catalog.btrim(p_template_id);
  normalized_fingerprint text := pg_catalog.lower(
    pg_catalog.btrim(p_source_fingerprint)
  );
  normalized_actor_id text := pg_catalog.btrim(p_actor_id);
  normalized_actor_name text := coalesce(
    nullif(pg_catalog.btrim(p_actor_name), ''),
    normalized_actor_id
  );
  normalized_outcome text := pg_catalog.lower(pg_catalog.btrim(p_outcome));
  reservation_record record;
  terminal_record record;
  event_time timestamptz;
  inserted_audit_log_id uuid;
  reservation_ttl_seconds constant integer := 120;
begin
  if p_operation_id is null
    or p_operation_id::text
      !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or nullif(normalized_template_id, '') is null
    or pg_catalog.length(normalized_template_id) > 256
    or p_template_revision is null
    or p_template_revision < 1
    or p_template_revision > 2147483647
    or p_certification_run_id is null
    or p_certification_run_id::text
      !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or coalesce(normalized_fingerprint, '') !~ '^[0-9a-f]{64}$'
    or nullif(normalized_actor_id, '') is null
    or pg_catalog.length(normalized_actor_id) > 256
    or pg_catalog.length(normalized_actor_name) > 256
    or normalized_outcome is null
    or normalized_outcome not in (
      'inserted',
      'failed-restored',
      'failed-preserved'
    )
  then
    raise exception
      'OUTLOOK_INSERTION_TERMINAL_INVALID: terminal input is malformed.'
      using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'outlook_template_insertion_operation:' || p_operation_id::text,
      0
    )
  );

  select logs.*
  into reservation_record
  from public.audit_logs as logs
  where logs.table_schema = 'app'
    and logs.table_name = 'outlook_template_insertion_attempts'
    and logs.operation = 'INSERT'
    and logs.record_pk ->> 'operationId' = p_operation_id::text
    and logs.record_pk ->> 'phase' = 'reserved'
  limit 1;

  if not found
    or reservation_record.actor_id is distinct from normalized_actor_id
    or reservation_record.record_pk ->> 'templateId'
      is distinct from normalized_template_id
    or reservation_record.record_pk ->> 'templateRevision'
      is distinct from p_template_revision::text
    or reservation_record.after_row ->> 'schema'
      is distinct from 'fcuno.outlook-template-insertion-audit/v2'
    or reservation_record.after_row ->> 'phase'
      is distinct from 'reserved'
    or reservation_record.after_row ->> 'operationId'
      is distinct from p_operation_id::text
    or reservation_record.after_row ->> 'templateId'
      is distinct from normalized_template_id
    or reservation_record.after_row ->> 'templateRevision'
      is distinct from p_template_revision::text
    or reservation_record.after_row ->> 'certificationRunId'
      is distinct from p_certification_run_id::text
    or reservation_record.after_row ->> 'sourceFingerprint'
      is distinct from normalized_fingerprint
    or pg_catalog.jsonb_typeof(
      reservation_record.after_row -> 'templateTitle'
    ) is distinct from 'string'
    or nullif(
      pg_catalog.btrim(
        reservation_record.after_row ->> 'templateTitle'
      ),
      ''
    ) is null
    or pg_catalog.length(
      reservation_record.after_row ->> 'templateTitle'
    ) > 512
  then
    raise exception
      'OUTLOOK_INSERTION_RESERVATION_REQUIRED: matching durable reservation was not found.'
      using errcode = '55000';
  end if;

  select logs.*
  into terminal_record
  from public.audit_logs as logs
  where logs.table_schema = 'app'
    and logs.table_name = 'outlook_template_insertion_attempts'
    and logs.operation = 'INSERT'
    and logs.record_pk ->> 'operationId' = p_operation_id::text
    and logs.record_pk ->> 'phase' = 'terminal'
  limit 1;

  if found then
    if terminal_record.actor_id is not distinct from normalized_actor_id
      and terminal_record.record_pk ->> 'templateId'
        is not distinct from normalized_template_id
      and terminal_record.record_pk ->> 'templateRevision'
        is not distinct from p_template_revision::text
      and terminal_record.after_row ->> 'schema'
        is not distinct from 'fcuno.outlook-template-insertion-audit/v2'
      and terminal_record.after_row ->> 'phase'
        is not distinct from 'terminal'
      and terminal_record.after_row ->> 'outcome'
        is not distinct from normalized_outcome
      and terminal_record.after_row ->> 'operationId'
        is not distinct from p_operation_id::text
      and terminal_record.after_row ->> 'templateId'
        is not distinct from normalized_template_id
      and terminal_record.after_row ->> 'templateRevision'
        is not distinct from p_template_revision::text
      and terminal_record.after_row ->> 'certificationRunId'
        is not distinct from p_certification_run_id::text
      and terminal_record.after_row ->> 'sourceFingerprint'
        is not distinct from normalized_fingerprint
      and terminal_record.after_row ->> 'reservationAuditLogId'
        is not distinct from reservation_record.id::text
    then
      return pg_catalog.jsonb_build_object(
        'completed', true,
        'idempotent', true,
        'auditLogId', terminal_record.id,
        'reservationAuditLogId', reservation_record.id,
        'outcome', normalized_outcome,
        'eventAt', terminal_record.occurred_at
      );
    end if;

    raise exception
      'OUTLOOK_INSERTION_TERMINAL_CONFLICT: operation already has a different terminal outcome.'
      using errcode = '23505';
  end if;

  event_time := pg_catalog.clock_timestamp();
  if reservation_record.occurred_at is null
    or reservation_record.occurred_at > event_time
    or reservation_record.occurred_at
      < event_time
        - pg_catalog.make_interval(secs => reservation_ttl_seconds)
  then
    raise exception
      'OUTLOOK_INSERTION_RESERVATION_EXPIRED: insertion reservations expire after 120 seconds.'
      using errcode = '55000';
  end if;

  insert into public.audit_logs (
    occurred_at,
    actor_id,
    actor_name,
    actor_source,
    table_schema,
    table_name,
    operation,
    record_pk,
    changed_fields,
    before_row,
    after_row,
    request_context
  )
  values (
    event_time,
    normalized_actor_id,
    normalized_actor_name,
    'app',
    'app',
    'outlook_template_insertion_attempts',
    'INSERT',
    pg_catalog.jsonb_build_object(
      'operationId', p_operation_id,
      'phase', 'terminal',
      'templateId', normalized_template_id,
      'templateRevision', p_template_revision
    ),
    array[]::text[],
    null,
    pg_catalog.jsonb_build_object(
      'schema', 'fcuno.outlook-template-insertion-audit/v2',
      'phase', 'terminal',
      'outcome', normalized_outcome,
      'operationId', p_operation_id,
      'templateId', normalized_template_id,
      'templateRevision', p_template_revision,
      'certificationRunId', p_certification_run_id,
      'sourceFingerprint', normalized_fingerprint,
      'reservationAuditLogId', reservation_record.id,
      'eventAt', event_time
    ),
    pg_catalog.jsonb_build_object(
      'pageId', 'email-templates',
      'pageLabel', 'OUTLOOK TEMPLATES',
      'pagePath', '/api/outlook-addin/taskpane',
      'action', 'outlook-draft-insertion-terminal',
      'auditPhase', 'terminal',
      'auditOutcome', normalized_outcome
    )
  )
  returning id into inserted_audit_log_id;

  return pg_catalog.jsonb_build_object(
    'completed', true,
    'idempotent', false,
    'auditLogId', inserted_audit_log_id,
    'reservationAuditLogId', reservation_record.id,
    'outcome', normalized_outcome,
    'eventAt', event_time
  );
end;
$$;

revoke all on function public.complete_outlook_template_insertion(
  uuid,
  text,
  bigint,
  uuid,
  text,
  text,
  text,
  text
)
  from public, anon, authenticated;
grant execute on function public.complete_outlook_template_insertion(
  uuid,
  text,
  bigint,
  uuid,
  text,
  text,
  text,
  text
)
  to service_role;
