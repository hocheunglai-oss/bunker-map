-- FCUNO-only permission-group transactions. No user rows, identity triggers,
-- credentials, signed claims or cross-project records are rewritten.
set local lock_timeout = '3s';

do $preflight$
begin
  if pg_catalog.to_regclass('public.admin_users') is null
    or pg_catalog.to_regclass('public.office_calendar_store') is null
    or pg_catalog.to_regclass('public.audit_logs') is null
    or exists (
      select 1 from (values
        ('admin_users','id','uuid'),('admin_users','role','text'),('admin_users','permissions','jsonb'),
        ('office_calendar_store','key','text'),('office_calendar_store','payload','jsonb'),
        ('office_calendar_store','updated_at','timestamptz')
      ) expected(table_name,column_name,type_name)
      where not exists (select 1 from information_schema.columns actual
        where actual.table_schema='public' and actual.table_name=expected.table_name
          and actual.column_name=expected.column_name and actual.udt_name=expected.type_name and actual.is_nullable='NO')
    ) then
    raise exception 'ADMIN_PERMISSION_GROUP_SCHEMA_MISMATCH' using errcode='55000';
  end if;
  if (select md5(prosrc) from pg_catalog.pg_proc where oid=pg_catalog.to_regprocedure('public.fcuno_set_admin_identity_revision()'))
       is distinct from '364d301fbe2b6e02c3f03b1be3cbbfed'
    or (select md5(prosrc) from pg_catalog.pg_proc where oid=pg_catalog.to_regprocedure('public.fcuno_enqueue_identity_sync()'))
       is distinct from '375a54c3d0d2ddc5cf756d78b1bfeec9' then
    raise exception 'ADMIN_PERMISSION_GROUP_IDENTITY_SOURCE_MISMATCH' using errcode='55000';
  end if;
end;
$preflight$;

-- Application writes already store canonical JS-normalized metadata. Only
-- ASCII legacy aliases are normalized here; Unicode canonical names remain
-- literal. Never approximate Unicode case folding or rewrite old user rows.
create function private.admin_effective_permission_group(p_role text,p_permissions jsonb)
returns text language sql immutable security invoker set search_path=''
as $$
  with raw as (select case when pg_catalog.jsonb_typeof(p_permissions->'__adminRole')='string'
    then p_permissions->>'__adminRole' else p_role end value), normalized as (
    select case when pg_catalog.octet_length(value)=pg_catalog.length(value) then
      pg_catalog.upper(pg_catalog.left(pg_catalog.regexp_replace(pg_catalog.btrim(value,
        ' '||pg_catalog.chr(9)||pg_catalog.chr(10)||pg_catalog.chr(11)||pg_catalog.chr(12)||pg_catalog.chr(13)),
        '[ '||pg_catalog.chr(9)||pg_catalog.chr(10)||pg_catalog.chr(11)||pg_catalog.chr(12)||pg_catalog.chr(13)||']+',' ','g'),40))
      else value end value from raw)
  select case when coalesce(value,'') in ('','USER') then 'AC' else value end from normalized;
$$;

create function private.admin_permission_group_rows()
returns jsonb language plpgsql stable security invoker set search_path='' set timezone='UTC'
as $$
declare rows_json jsonb; payload_json jsonb; row_json jsonb; row_timestamp timestamptz;
begin
  if pg_catalog.to_regclass('public.admin_role_defaults') is not null then
    if exists(select 1 from (values ('role','text'),('permissions','jsonb'),('updated_at','timestamptz')) expected(column_name,type_name)
      where not exists(select 1 from information_schema.columns actual where actual.table_schema='public' and actual.table_name='admin_role_defaults'
        and actual.column_name=expected.column_name and actual.udt_name=expected.type_name and actual.is_nullable='NO')) then
      raise exception 'ADMIN_PERMISSION_GROUP_SCHEMA_MISMATCH' using errcode='55000';
    end if;
    execute 'select coalesce(jsonb_agg(jsonb_build_object(''role'',role,''permissions'',permissions,''updated_at'',updated_at) order by role),''[]''::jsonb) from public.admin_role_defaults' into rows_json;
  else
    select payload into payload_json from public.office_calendar_store where key='admin-permission-groups';
    if payload_json is null then return '[]'::jsonb; end if;
    if pg_catalog.jsonb_typeof(payload_json) is distinct from 'object'
      or pg_catalog.jsonb_typeof(payload_json->'groups') is distinct from 'array' then
      raise exception 'ADMIN_PERMISSION_GROUP_STORAGE_INVALID' using errcode='55000';
    end if;
    if exists(select 1 from pg_catalog.jsonb_array_elements(payload_json->'groups') item
      where pg_catalog.jsonb_typeof(item) is distinct from 'object'
        or pg_catalog.jsonb_typeof(item->'role') is distinct from 'string') then
      raise exception 'ADMIN_PERMISSION_GROUP_STORAGE_INVALID' using errcode='55000';
    end if;
    select coalesce(jsonb_agg(jsonb_build_object('role',item->>'role','permissions',item->'permissions','updated_at',item->'updatedAt') order by item->>'role'),'[]'::jsonb)
      into rows_json from pg_catalog.jsonb_array_elements(payload_json->'groups') item;
  end if;
  if exists (select 1 from pg_catalog.jsonb_array_elements(rows_json) item where
      pg_catalog.jsonb_typeof(item->'role') is distinct from 'string' or nullif(item->>'role','') is null
      or pg_catalog.length(item->>'role')>40 or pg_catalog.jsonb_typeof(item->'permissions') is distinct from 'object'
      or pg_catalog.jsonb_typeof(item->'updated_at') is distinct from 'string'
      or private.admin_effective_permission_group(item->>'role','{}'::jsonb) is distinct from item->>'role')
    or exists (select 1 from pg_catalog.jsonb_array_elements(rows_json) item group by item->>'role' having count(*)>1) then
    raise exception 'ADMIN_PERMISSION_GROUP_STORAGE_INVALID' using errcode='55000';
  end if;
  -- This data is consumed during every session resolution. Accept only finite,
  -- unambiguous ISO timestamps understood by both PostgreSQL and the JS reader;
  -- a string alone (including table infinity) is not a safe read contract.
  for row_json in select value from pg_catalog.jsonb_array_elements(rows_json) loop
    if row_json->>'updated_at' !~ '^[0-9]{4}-(0[1-9]|1[0-2])-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]+)?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$' then
      raise exception 'ADMIN_PERMISSION_GROUP_STORAGE_INVALID' using errcode='55000';
    end if;
    begin
      row_timestamp:=(row_json->>'updated_at')::timestamptz;
    exception when invalid_datetime_format or datetime_field_overflow then
      raise exception 'ADMIN_PERMISSION_GROUP_STORAGE_INVALID' using errcode='55000';
    end;
    if not pg_catalog.isfinite(row_timestamp) then
      raise exception 'ADMIN_PERMISSION_GROUP_STORAGE_INVALID' using errcode='55000';
    end if;
  end loop;
  return rows_json;
end;
$$;

create function private.admin_permission_group_version(p_row jsonb)
returns text language sql immutable security invoker set search_path=''
as $$ select case when p_row is null then null else pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_row::text,'UTF8')),'hex') end; $$;

-- Existing noncanonical legacy metadata must be assessed, never silently
-- relabelled by this migration. This preflight performs no data writes.
do $roles$
declare groups_json jsonb;
begin
  groups_json:=private.admin_permission_group_rows();
  if exists(select 1 from pg_catalog.jsonb_array_elements(groups_json) item
      where pg_catalog.octet_length(item->>'role')<>pg_catalog.length(item->>'role')) then
    raise exception 'ADMIN_PERMISSION_GROUP_LEGACY_REVIEW_REQUIRED' using errcode='55000';
  end if;
  if exists(select 1 from public.admin_users users where
      pg_catalog.jsonb_typeof(users.permissions) is distinct from 'object'
      or (pg_catalog.jsonb_typeof(users.permissions->'__adminRole')='string' and (
        pg_catalog.octet_length(users.permissions->>'__adminRole')<>pg_catalog.length(users.permissions->>'__adminRole')
        or private.admin_effective_permission_group(users.role,users.permissions) is distinct from users.permissions->>'__adminRole'))
      or (private.admin_effective_permission_group(users.role,users.permissions) not in ('ADMIN','AC','BT','VN') and
        not exists(select 1 from pg_catalog.jsonb_array_elements(groups_json) item
          where item->>'role'=private.admin_effective_permission_group(users.role,users.permissions)))) then
    raise exception 'ADMIN_PERMISSION_GROUP_LEGACY_REVIEW_REQUIRED' using errcode='55000';
  end if;
end;
$roles$;

create function public.read_admin_permission_groups()
returns jsonb language sql stable security invoker set search_path='' set timezone='UTC'
as $$ select jsonb_build_object('schema','fcuno.admin-permission-groups/v1',
  'storage',case when pg_catalog.to_regclass('public.admin_role_defaults') is null then 'shared-store' else 'table' end,
  'groups',(select coalesce(jsonb_agg(item||jsonb_build_object('version',private.admin_permission_group_version(item)) order by item->>'role'),'[]'::jsonb)
    from pg_catalog.jsonb_array_elements(private.admin_permission_group_rows()) item)); $$;

create function private.guard_admin_permission_group_write()
returns trigger language plpgsql security invoker set search_path=''
as $$
begin
  if tg_table_name='office_calendar_store' and
    coalesce(case when tg_op='DELETE' then pg_catalog.to_jsonb(old)->>'key' else pg_catalog.to_jsonb(new)->>'key' end,'')<>'admin-permission-groups'
    and (tg_op<>'UPDATE' or pg_catalog.to_jsonb(old)->>'key'<>'admin-permission-groups') then
    if tg_op='DELETE' then return old; else return new; end if;
  end if;
  if pg_catalog.current_setting('app.fcuno_permission_group_transaction',true) is distinct from 'v1'
    or nullif(pg_catalog.current_setting('app.audit_undo_of_log_id',true),'') is not null then
    raise exception 'ADMIN_PERMISSION_GROUP_CONFLICT' using errcode='P0001',detail='Use version-bound FCUNO User Management.';
  end if;
  if tg_op='DELETE' then return old; else return new; end if;
end;
$$;

create function private.guard_admin_permission_group_membership()
returns trigger language plpgsql security invoker set search_path='' set lock_timeout='2s'
as $$
declare target_role text;
begin
  target_role:=private.admin_effective_permission_group(new.role,new.permissions);
  if tg_op='UPDATE' and target_role is not distinct from private.admin_effective_permission_group(old.role,old.permissions) then return new; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('fcuno:admin-permission-groups:v1',0));
  if target_role not in ('ADMIN','AC','BT','VN') and not exists(
    select 1 from pg_catalog.jsonb_array_elements(private.admin_permission_group_rows()) item where item->>'role'=target_role) then
    raise exception 'ADMIN_PERMISSION_GROUP_CONFLICT' using errcode='P0001',detail='The selected permission group no longer exists.';
  end if;
  return new;
end;
$$;

create function public.write_admin_permission_group(p_action text,p_role text,p_permissions jsonb,p_expected_version text)
returns jsonb language plpgsql security invoker set search_path='' set timezone='UTC' set lock_timeout='2s' set statement_timeout='8s'
as $$
declare
  groups_json jsonb; current_row jsonb; saved_row jsonb; expected_actual text;
  table_storage boolean; payload_before jsonb; payload_after jsonb; next_groups jsonb;
  saved_at timestamptz:=pg_catalog.clock_timestamp(); member_count integer;
  headers jsonb; actor text; audit_id uuid; previous_flag text; prior_audit_count bigint;
  prior_context_text text; prior_context jsonb; group_context jsonb;
begin
  if p_action is null or p_action not in ('save','delete') or p_role is null or nullif(p_role,'') is null
    or pg_catalog.length(p_role)>40 or private.admin_effective_permission_group(p_role,'{}'::jsonb) is distinct from p_role
    or (p_expected_version is not null and p_expected_version!~'^[a-f0-9]{64}$')
    or (p_action='save' and (pg_catalog.jsonb_typeof(p_permissions) is distinct from 'object'
      or exists(select 1 from pg_catalog.jsonb_each(p_permissions) entry where entry.value not in ('"none"'::jsonb,'"view"'::jsonb,'"edit"'::jsonb)))) then
    raise exception 'ADMIN_PERMISSION_GROUP_INVALID' using errcode='22023';
  end if;
  if p_action='delete' and p_role in ('ADMIN','AC','BT','VN') then
    raise exception 'ADMIN_PERMISSION_GROUP_BUILT_IN' using errcode='P0001';
  end if;
  begin headers:=coalesce(nullif(pg_catalog.current_setting('request.headers',true),'')::jsonb,'{}'::jsonb);
  exception when invalid_text_representation then raise exception 'ADMIN_PERMISSION_GROUP_ACTOR_REQUIRED' using errcode='22023'; end;
  actor:=nullif(headers->>'x-bunker-admin-user','');
  if actor is null then raise exception 'ADMIN_PERMISSION_GROUP_ACTOR_REQUIRED' using errcode='22023'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('fcuno:admin-permission-groups:v1',0));
  table_storage:=pg_catalog.to_regclass('public.admin_role_defaults') is not null;
  if table_storage and (not exists(select 1 from pg_catalog.pg_trigger where tgrelid=pg_catalog.to_regclass('public.admin_role_defaults')
      and tgname='guard_fcuno_permission_group_defaults' and tgenabled='O')
    or not exists(select 1 from pg_catalog.pg_trigger where tgrelid=pg_catalog.to_regclass('public.admin_role_defaults')
      and tgfoid=pg_catalog.to_regprocedure('public.audit_table_changes()') and tgenabled='O')) then
    raise exception 'ADMIN_PERMISSION_GROUP_SCHEMA_MISMATCH' using errcode='55000';
  end if;
  if table_storage then execute 'select role from public.admin_role_defaults where role=$1 for update' using p_role;
  else perform 1 from public.office_calendar_store where key='admin-permission-groups' for update; end if;
  groups_json:=private.admin_permission_group_rows();
  select item into current_row from pg_catalog.jsonb_array_elements(groups_json) item where item->>'role'=p_role;
  expected_actual:=private.admin_permission_group_version(current_row);
  if expected_actual is distinct from p_expected_version then
    raise exception 'ADMIN_PERMISSION_GROUP_CONFLICT' using errcode='P0001';
  end if;
  select count(*) into member_count from public.admin_users users
    where private.admin_effective_permission_group(users.role,users.permissions)=p_role;
  if p_action='delete' and member_count>0 then
    raise exception 'ADMIN_PERMISSION_GROUP_IN_USE' using errcode='P0001';
  end if;
  if p_action='delete' and current_row is null then
    return jsonb_build_object('saved',true,'role',p_role,'deleted',true,'memberCount',0,'version',null);
  end if;
  if table_storage then select count(*) into prior_audit_count from public.audit_logs
    where table_schema='public' and table_name='admin_role_defaults' and record_pk->>'role'=p_role and actor_id=actor; end if;
  previous_flag:=pg_catalog.current_setting('app.fcuno_permission_group_transaction',true);
  prior_context_text:=pg_catalog.current_setting('app.audit_context',true);
  prior_context:=coalesce(public.audit_json_setting('app.audit_context'),'{}'::jsonb);
  group_context:=prior_context||jsonb_build_object('pageId','user-management','action','permission-group-'||p_action);
  perform pg_catalog.set_config('app.fcuno_permission_group_transaction','v1',true);
  perform pg_catalog.set_config('app.audit_context',group_context::text,true);
  if table_storage then
    if p_action='delete' then execute 'delete from public.admin_role_defaults where role=$1' using p_role;
    else execute 'insert into public.admin_role_defaults(role,permissions,updated_at) values($1,$2,$3) on conflict(role) do update set permissions=excluded.permissions,updated_at=excluded.updated_at'
      using p_role,p_permissions,saved_at; end if;
  else
    select payload into payload_before from public.office_calendar_store where key='admin-permission-groups';
    select coalesce(jsonb_agg(item order by item->>'role'),'[]'::jsonb) into next_groups
      from pg_catalog.jsonb_array_elements(coalesce(payload_before->'groups','[]'::jsonb)) item where item->>'role'<>p_role;
    if p_action='save' then next_groups:=next_groups||jsonb_build_array(jsonb_build_object('role',p_role,'permissions',p_permissions,'updatedAt',saved_at)); end if;
    payload_after:=jsonb_set(coalesce(payload_before,'{}'::jsonb),'{groups}',next_groups,true);
    insert into public.office_calendar_store(key,payload,updated_at) values('admin-permission-groups',payload_after,saved_at)
      on conflict(key) do update set payload=excluded.payload,updated_at=excluded.updated_at;
    -- The generic audit trigger intentionally excludes this FCUNO-only key.
    -- Its typed semantic audit is committed in the same transaction instead.
    insert into public.audit_logs(actor_id,actor_name,actor_source,table_schema,table_name,operation,record_pk,changed_fields,before_row,after_row,request_context)
      values(actor,coalesce(nullif(headers->>'x-bunker-admin-display-name',''),actor),'header','public','office_calendar_store',
        case when payload_before is null then 'INSERT' else 'UPDATE' end,jsonb_build_object('key','admin-permission-groups'),array['payload'],
        case when payload_before is null then null else jsonb_build_object('key','admin-permission-groups','payload',payload_before) end,
        jsonb_build_object('key','admin-permission-groups','payload',payload_after),
        group_context||jsonb_build_object('schema','fcuno.permission-group-change/v1','role',p_role)) returning id into audit_id;
    if audit_id is null or not exists(select 1 from public.audit_logs where id=audit_id and actor_id=actor
      and request_context->>'schema'='fcuno.permission-group-change/v1' and after_row->'payload'=payload_after) then
      raise exception 'ADMIN_PERMISSION_GROUP_NOT_SAVED' using errcode='P0001';
    end if;
    if (select payload from public.office_calendar_store where key='admin-permission-groups') is distinct from payload_after then
      raise exception 'ADMIN_PERMISSION_GROUP_NOT_SAVED' using errcode='P0001';
    end if;
  end if;
  groups_json:=private.admin_permission_group_rows();
  select item into saved_row from pg_catalog.jsonb_array_elements(groups_json) item where item->>'role'=p_role;
  if (p_action='delete' and saved_row is not null) or (p_action='save' and (saved_row is null or saved_row->'permissions' is distinct from p_permissions)) then
    raise exception 'ADMIN_PERMISSION_GROUP_NOT_SAVED' using errcode='P0001';
  end if;
  if table_storage and (current_row is null or p_action='delete' or current_row->'permissions' is distinct from p_permissions)
    and (select count(*) from public.audit_logs where table_schema='public' and table_name='admin_role_defaults'
      and record_pk->>'role'=p_role and actor_id=actor)<=prior_audit_count then
    raise exception 'ADMIN_PERMISSION_GROUP_NOT_SAVED' using errcode='P0001';
  end if;
  perform pg_catalog.set_config('app.fcuno_permission_group_transaction',coalesce(previous_flag,''),true);
  perform pg_catalog.set_config('app.audit_context',coalesce(prior_context_text,''),true);
  return jsonb_build_object('saved',true,'role',p_role,'deleted',p_action='delete','memberCount',member_count,
    'row',case when saved_row is null then null else saved_row||jsonb_build_object('version',private.admin_permission_group_version(saved_row)) end,
    'version',private.admin_permission_group_version(saved_row));
end;
$$;

revoke all on function private.admin_effective_permission_group(text,jsonb),private.admin_permission_group_rows(),
  private.admin_permission_group_version(jsonb),private.guard_admin_permission_group_write(),private.guard_admin_permission_group_membership(),
  public.read_admin_permission_groups(),public.write_admin_permission_group(text,text,jsonb,text) from public,anon,authenticated,service_role;
grant execute on function private.admin_effective_permission_group(text,jsonb),private.admin_permission_group_rows(),
  private.admin_permission_group_version(jsonb),private.guard_admin_permission_group_write(),private.guard_admin_permission_group_membership(),
  public.read_admin_permission_groups(),public.write_admin_permission_group(text,text,jsonb,text) to service_role;

create trigger guard_fcuno_permission_group_store before insert or update or delete on public.office_calendar_store
  for each row execute function private.guard_admin_permission_group_write();
create trigger guard_fcuno_permission_group_membership before insert or update of role,permissions on public.admin_users
  for each row execute function private.guard_admin_permission_group_membership();
do $optional_table$
begin
  if pg_catalog.to_regclass('public.admin_role_defaults') is not null then
    execute 'create trigger guard_fcuno_permission_group_defaults before insert or update or delete on public.admin_role_defaults for each row execute function private.guard_admin_permission_group_write()';
  end if;
end;
$optional_table$;
