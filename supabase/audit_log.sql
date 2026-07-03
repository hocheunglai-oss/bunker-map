create extension if not exists "pgcrypto";

create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  occurred_at timestamptz not null default now(),
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
create policy "audit_logs_read"
  on public.audit_logs
  for select
  using (true);

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
    changed := public.audit_changed_fields(before_payload, after_payload);
    if coalesce(array_length(changed, 1), 0) = 0 then
      return new;
    end if;
  else
    changed := array[]::text[];
  end if;

  if tg_table_name = 'office_calendar_store'
    and coalesce(coalesce(after_payload, before_payload) ->> 'key', '')
      not in ('event-calendar', 'task-calendar')
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

  context_payload := coalesce(
    public.audit_json_setting('app.audit_context'),
    '{}'::jsonb
  ) || jsonb_strip_nulls(
    jsonb_build_object(
      'pageId', nullif(public.audit_request_header('x-bunker-admin-page-id'), ''),
      'pageLabel', nullif(public.audit_request_header('x-bunker-admin-page-label'), ''),
      'pagePath', nullif(public.audit_request_header('x-bunker-admin-page-path'), '')
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

  perform set_config('app.audit_actor_id', coalesce(p_actor_id, 'system'), true);
  perform set_config('app.audit_actor_name', coalesce(p_actor_name, p_actor_id, 'System'), true);
  perform set_config('app.audit_undo_of_log_id', p_log_id::text, true);
  perform set_config(
    'app.audit_context',
    jsonb_build_object('action', 'undo', 'targetAuditLogId', p_log_id)::text,
    true
  );

  where_sql := public.audit_pk_where(audit_record.record_pk);

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
  elsif audit_record.operation = 'UPDATE' then
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
    'spc_fixtures'
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
revoke execute on function public.undo_audit_log(uuid, text, text) from public, anon, authenticated;

grant execute on function public.audit_enable_table(regclass) to service_role;
grant execute on function public.undo_audit_log(uuid, text, text) to service_role;
