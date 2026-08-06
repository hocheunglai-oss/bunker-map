-- Complete W-02 audit evidence for SPC user lifecycle and permission-group
-- operations without exposing credentials or allowing the resulting evidence
-- to be rewritten.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

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
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  before_payload := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) else null end;
  after_payload := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) else null end;

  if tg_op = 'UPDATE' then
    changed := array_remove(public.audit_changed_fields(before_payload, after_payload), 'updated_at');
    if coalesce(array_length(changed, 1), 0) = 0 then return new; end if;
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
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  actor_id := coalesce(
    nullif(public.audit_text_setting('app.audit_actor_id'), ''),
    nullif(public.audit_request_header('x-bunker-admin-user'), '')
  );

  if actor_id is null then
    if tg_op = 'DELETE' then return old; end if;
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
  ) || jsonb_strip_nulls(jsonb_build_object(
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
  ));
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
  ) values (
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

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

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

do $$
begin
  if to_regclass('public.office_calendar_store') is not null
    and to_regprocedure('public.audit_enable_table(regclass)') is not null
  then
    perform public.audit_enable_table('public.office_calendar_store'::regclass);
  end if;
end $$;

revoke execute on function public.audit_uuid_text(text)
  from public, anon, authenticated;
revoke execute on function public.audit_table_changes()
  from public, anon, authenticated;
