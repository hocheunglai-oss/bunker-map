-- The supplier key is intentionally excluded from audit_table_changes.
-- Keep its existing table/fence triggers: row CAS and the explicit audit are
-- one short transaction, with no external reads while a row lock is held.
create or replace function public.compare_and_swap_spc_supplier_store(
  p_expected_payload jsonb,
  p_payload jsonb,
  p_expected_exists boolean,
  p_actor_username text,
  p_request_id uuid,
  p_action text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  before_row public.office_calendar_store%rowtype;
  after_row public.office_calendar_store%rowtype;
  actor_row public.spc_users%rowtype;
  audit_row public.audit_logs%rowtype;
  headers jsonb := coalesce(nullif(current_setting('request.headers', true), ''), '{}')::jsonb;
  now_at timestamptz := clock_timestamp();
  audit_context jsonb;
begin
  if jsonb_typeof(p_payload) is distinct from 'object'
    or (p_expected_payload is not null and jsonb_typeof(p_expected_payload) <> 'object')
    or jsonb_typeof(p_payload->'records') is distinct from 'array'
    or jsonb_typeof(p_payload->'barges') is distinct from 'array'
    or jsonb_typeof(p_payload->'contacts') is distinct from 'array'
    or jsonb_typeof(p_payload->'receipts') is distinct from 'array'
    or jsonb_array_length(p_payload->'receipts') > 256
    or p_expected_exists is null or (not p_expected_exists and p_expected_payload is not null)
    or p_request_id is null or p_action is null
    or p_action not in ('save','delete','save-barges','save-contacts') then
    raise exception using errcode='22023', message='Invalid supplier save request.';
  end if;
  if coalesce(headers->>'x-bunker-admin-user','') <> 'spc:' || coalesce(p_actor_username,'') then
    raise exception using errcode='42501', message='Forbidden';
  end if;
  perform pg_catalog.pg_advisory_xact_lock_shared(730261052372033133::bigint);
  -- Match the application-validated actor without inventing a second page
  -- permission model. FOR SHARE prevents deactivation until this write ends.
  select * into actor_row from public.spc_users
    where lower(username)=lower(btrim(p_actor_username)) and is_active
      and id::text=headers->>'x-bunker-audit-actor-user-id' for share;
  if not found then raise exception using errcode='42501', message='Forbidden'; end if;

  if not p_expected_exists then
    insert into public.office_calendar_store(key,payload,updated_at)
      values ('spc-supplier-overrides',p_payload,now_at)
      on conflict(key) do nothing returning * into after_row;
    if not found then
      raise exception using errcode='40001', message='Supplier data changed. Reload and retry the save.', detail='supplier-store-cas-contention';
    end if;
  else
    select * into before_row from public.office_calendar_store
      where key='spc-supplier-overrides' for update;
    if not found or before_row.payload is distinct from p_expected_payload then
      raise exception using errcode='40001', message='Supplier data changed. Reload and retry the save.', detail='supplier-store-cas-contention';
    end if;
    update public.office_calendar_store set payload=p_payload,updated_at=now_at
      where key='spc-supplier-overrides' returning * into after_row;
    if not found then
      raise exception using errcode='40001', message='Supplier data was not saved.';
    end if;
  end if;
  if after_row.key is distinct from 'spc-supplier-overrides'
    or after_row.payload is distinct from p_payload then
    raise exception using errcode='40001', message='Supplier data was not saved.';
  end if;

  audit_context := jsonb_strip_nulls(jsonb_build_object(
    'pageId',headers->>'x-bunker-admin-page-id','pageLabel',headers->>'x-bunker-admin-page-label',
    'pagePath',headers->>'x-bunker-admin-page-path','correlationId',headers->>'x-bunker-audit-correlation-id',
    'requestId',headers->>'x-bunker-audit-request-id','platformRequestId',headers->>'x-bunker-audit-platform-request-id',
    'sourceIp',headers->>'x-bunker-audit-source-ip','actorRole',headers->>'x-bunker-audit-actor-role',
    'action',headers->>'x-bunker-audit-action','targetType',headers->>'x-bunker-audit-target-type',
    'targetId',headers->>'x-bunker-audit-target-id','targetUsername',headers->>'x-bunker-audit-target-username',
    'outcome',headers->>'x-bunker-audit-outcome','approvalReference',headers->>'x-bunker-audit-approval-reference',
    'passwordChanged',headers->>'x-bunker-audit-password-changed',
    'supplierRequestId',p_request_id,'supplierAction',p_action));
  insert into public.audit_logs(actor_user_id,actor_id,actor_name,actor_source,
    table_schema,table_name,operation,record_pk,changed_fields,before_row,after_row,request_context)
  values(actor_row.id,'spc:' || actor_row.username,
    coalesce(nullif(btrim(actor_row.display_name),''),actor_row.username),'app',
    'public','office_calendar_store',case when not p_expected_exists then 'INSERT' else 'UPDATE' end,
    jsonb_build_object('key','spc-supplier-overrides'),array['payload']::text[],
    case when not p_expected_exists then null else to_jsonb(before_row) end,to_jsonb(after_row),audit_context)
  returning * into audit_row;
  if not found or audit_row.actor_user_id is distinct from actor_row.id
    or audit_row.actor_id is distinct from 'spc:' || actor_row.username
    or audit_row.actor_name is distinct from coalesce(nullif(btrim(actor_row.display_name),''),actor_row.username)
    or audit_row.actor_source is distinct from 'app'
    or audit_row.operation is distinct from (case when not p_expected_exists then 'INSERT' else 'UPDATE' end)
    or audit_row.changed_fields is distinct from array['payload']::text[]
    or audit_row.table_schema is distinct from 'public' or audit_row.table_name is distinct from 'office_calendar_store'
    or audit_row.before_row is distinct from (case when not p_expected_exists then null else to_jsonb(before_row) end)
    or audit_row.after_row is distinct from to_jsonb(after_row)
    or audit_row.record_pk is distinct from jsonb_build_object('key','spc-supplier-overrides')
    or audit_row.request_context is distinct from audit_context then
    raise exception using errcode='40001', message='Supplier audit was not saved. No changes were applied.';
  end if;
  return jsonb_build_object('schema','fcuno.supplier-store-cas/v1',
    'requestId',p_request_id,'payload',after_row.payload,'updatedAt',after_row.updated_at);
end;
$$;
revoke all on function public.compare_and_swap_spc_supplier_store(jsonb,jsonb,boolean,text,uuid,text)
  from public,anon,authenticated,service_role;
grant execute on function public.compare_and_swap_spc_supplier_store(jsonb,jsonb,boolean,text,uuid,text) to service_role;
