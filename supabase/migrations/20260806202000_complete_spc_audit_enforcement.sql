-- Complete the SPC W-02 audit boundary after the initial hardening migration.
-- Keep successful user mutations trigger-backed, make the trigger helper usable
-- by the server-only role, and preserve request evidence for undo operations.

grant usage on schema private to service_role;
grant execute on function private.is_spc_user_management_audit_record(public.audit_logs)
  to service_role;

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

revoke all on function public.audit_undo_context(uuid)
  from public, anon, authenticated, service_role;

-- This is the optimistic-concurrency implementation renamed by
-- 20260723120726_redact_spc_user_audit_credentials.sql. Replacing it keeps the
-- credential wrapper intact while enriching the transaction-local context.
create or replace function public.undo_audit_log_noncredential(
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
    public.audit_undo_context(p_log_id)::text,
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

revoke all on function public.undo_audit_log_noncredential(uuid, text, text)
  from public, anon, authenticated, service_role;

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
  target_table_schema text;
  target_table_name text;
begin
  select
    audit.table_schema,
    audit.table_name
  into
    target_table_schema,
    target_table_name
  from public.audit_logs as audit
  where audit.id = p_log_id;

  if target_table_schema = 'public'
    and target_table_name in ('admin_users', 'spc_users')
  then
    raise exception
      'Credential-bearing user audit records cannot be undone because credentials are redacted.';
  end if;

  return public.undo_audit_log_noncredential(
    p_log_id,
    p_actor_id,
    p_actor_name
  );
end;
$$;

revoke all on function public.undo_audit_log(uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.undo_audit_log(uuid, text, text)
  to service_role;

do $$
declare
  table_reg regclass;
begin
  if to_regprocedure('public.audit_enable_table(regclass)') is null then
    raise exception 'public.audit_enable_table(regclass) is required.';
  end if;

  foreach table_reg in array array[
    to_regclass('public.spc_users'),
    to_regclass('public.office_calendar_store')
  ]
  loop
    if table_reg is null then
      raise exception 'Required SPC audit table is missing.';
    end if;
    perform public.audit_enable_table(table_reg);
  end loop;
end $$;
