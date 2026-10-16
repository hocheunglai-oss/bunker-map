-- One versioned CCINFO deletion, including the existing optional country-port
-- action and company-file FK cascade, must commit with its audit or not at all.
create function public.delete_ccinfo_record(
  p_kind text, p_id uuid, p_expected_updated_at timestamptz, p_delete_ports boolean
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
set lock_timeout = '5s'
set statement_timeout = '15s'
as $$
declare
  target_table text;
  target jsonb;
  deleted jsonb;
  ports_before jsonb := '[]'::jsonb;
  files_before jsonb := '[]'::jsonb;
  removed_ports jsonb := '[]'::jsonb;
  expected_audit jsonb := '[]'::jsonb;
  invalid_preserved boolean;
  branch_audit jsonb;
  actual_ack jsonb;
  expected_ack jsonb;
  operation_id uuid := pg_catalog.gen_random_uuid();
  prior_context jsonb;
  prior_headers jsonb;
  actor text;
  actor_name text;
  actor_source text;
  matched bigint;
  deleted_at timestamptz;
begin
  actor := coalesce(nullif(public.audit_text_setting('app.audit_actor_id'), ''),
    nullif(public.audit_request_header('x-bunker-admin-user'), ''));
  if actor is null or pg_catalog.btrim(actor) = '' then
    raise exception using errcode='42501', message='A signed-in audit actor is required.';
  end if;
  actor_name := coalesce(nullif(public.audit_text_setting('app.audit_actor_name'), ''),
    nullif(public.audit_request_header('x-bunker-admin-display-name'), ''), actor);
  actor_source := case when nullif(public.audit_text_setting('app.audit_actor_id'), '') is not null then 'app' else 'header' end;
  if p_kind is null or p_kind not in ('company','country','port') or p_id is null
    or p_expected_updated_at is null or not pg_catalog.isfinite(p_expected_updated_at)
    or p_delete_ports is null or (p_kind <> 'country' and p_delete_ports) then
    raise exception using errcode='22023', message='A valid entry and saved version are required.';
  end if;
  if public.audit_uuid_setting('app.audit_undo_of_log_id') is not null then
    raise exception using errcode='23514', message='Use the versioned CCINFO deletion action.';
  end if;
  target_table := case p_kind when 'company' then 'cc_companies' when 'country' then 'cc_countries' else 'cc_ports' end;
  -- Acquire the same shared backup fence before any relation/row lock. Country
  -- order matches Rename and includes in-flight legacy-name inserts/reparenting.
  perform pg_catalog.pg_advisory_xact_lock_shared(730261052372033133::bigint);
  if p_kind='company' then
    lock table public.cc_companies in share row exclusive mode;
    lock table public.cc_company_files in share row exclusive mode;
  else
    lock table public.cc_countries in share row exclusive mode;
    lock table public.cc_ports in share row exclusive mode;
  end if;
  execute pg_catalog.format('select pg_catalog.to_jsonb(r) from public.%I r where id=$1 for update',target_table)
    into target using p_id;
  if target is null or (target->>'updated_at')::timestamptz is distinct from p_expected_updated_at then
    raise exception using errcode='40001', message='The entry changed or was removed. Refresh it before deleting.';
  end if;
  if p_kind='country' then
    if p_delete_ports and exists(select 1 from public.cc_ports where country_id is null and country_name=target->>'name')
      and exists(select 1 from public.cc_countries where id<>p_id and pg_catalog.upper(pg_catalog.btrim(name))=pg_catalog.upper(pg_catalog.btrim(target->>'name'))) then
      raise exception using errcode='23514', message='Some legacy ports have an ambiguous country name. No entries were deleted.';
    end if;
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(r) order by id),'[]'::jsonb) into ports_before
    from public.cc_ports r where country_id=p_id or (p_delete_ports and country_id is null and country_name=target->>'name');
  elsif p_kind='company' then
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(r) order by id),'[]'::jsonb) into files_before
    from public.cc_company_files r where company_id=p_id;
  end if;

  prior_context := public.audit_json_setting('app.audit_context');
  prior_headers := public.audit_json_setting('request.headers');
  perform pg_catalog.set_config('app.audit_context',(prior_context || pg_catalog.jsonb_build_object(
    'action','ccinfo_record_delete','ccinfoDeleteRequestId',operation_id))::text,true);
  perform pg_catalog.set_config('request.headers',(prior_headers || pg_catalog.jsonb_build_object(
    'x-bunker-audit-action','ccinfo_record_delete','x-bunker-admin-page-id','ccinfo',
    'x-bunker-admin-page-label','CCINFO','x-bunker-admin-page-path','/admin/ccinfo'))::text,true);

  if p_kind='country' and p_delete_ports then
    with removed as (
      delete from public.cc_ports where country_id=p_id or (country_id is null and country_name=target->>'name') returning *
    ) select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(removed) order by id),'[]'::jsonb) into removed_ports from removed;
    if removed_ports is distinct from ports_before then
      raise exception using errcode='40001',message='The port deletion could not be verified. No entries were deleted.';
    end if;
    if exists(select 1 from public.cc_ports p join pg_catalog.jsonb_array_elements(ports_before) old on p.id=(old->>'id')::uuid) then
      raise exception using errcode='40001',message='A deleted port is still present. No entries were deleted.';
    end if;
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'table','cc_ports','operation','DELETE','before',old,'after',null)),'[]'::jsonb) into expected_audit
      from pg_catalog.jsonb_array_elements(ports_before) old;
  end if;
  execute pg_catalog.format('delete from public.%I r where id=$1 and updated_at=$2 returning pg_catalog.to_jsonb(r)',target_table)
    into deleted using p_id,p_expected_updated_at;
  if deleted is distinct from target then
    raise exception using errcode='40001',message='The deletion could not be verified. No entries were deleted.';
  end if;
  execute pg_catalog.format('select count(*) from public.%I where id=$1',target_table) into matched using p_id;
  if matched<>0 then
    raise exception using errcode='40001',message='The deleted entry is still present. No entries were deleted.';
  end if;
  expected_audit := expected_audit || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
    'table',target_table,'operation','DELETE','before',target,'after',null));

  if p_kind='country' and not p_delete_ports then
    with preserved as materialized (
      select old,pg_catalog.to_jsonb(p) as saved from pg_catalog.jsonb_array_elements(ports_before) old
      left join public.cc_ports p on p.id=(old->>'id')::uuid
    ) select coalesce(pg_catalog.bool_or(saved is null or saved->>'country_id' is not null
        or (saved-array['country_id','updated_at']) is distinct from (old-array['country_id','updated_at'])
        or (saved->>'updated_at')::timestamptz <= (old->>'updated_at')::timestamptz),false),
      coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('table','cc_ports','operation','UPDATE','before',old,'after',saved)),'[]'::jsonb)
      into invalid_preserved,branch_audit from preserved;
    if invalid_preserved then
      raise exception using errcode='40001',message='The preserved ports could not be verified. No entries were deleted.';
    end if;
    expected_audit := expected_audit || branch_audit;
  elsif p_kind='company' then
    if exists(select 1 from public.cc_company_files f join pg_catalog.jsonb_array_elements(files_before) old on f.id=(old->>'id')::uuid) then
      raise exception using errcode='40001',message='The existing file cascade could not be verified. No entries were deleted.';
    end if;
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'table','cc_company_files','operation','DELETE','before',old,'after',null)),'[]'::jsonb) into branch_audit
      from pg_catalog.jsonb_array_elements(files_before) old;
    expected_audit := expected_audit || branch_audit;
  end if;
  -- Preserve ordinary row-trigger auditing; require exact acknowledgements,
  -- not merely a trigger invocation or a count of unrelated old audit rows.
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'tableSchema','public','table',r->>'table','operation',r->>'operation',
    'pk',pg_catalog.jsonb_build_object('id',r->'before'->>'id'),'before',r->'before','after',r->'after',
    'changed',case when r->>'operation'='DELETE' then array[]::text[]
      else pg_catalog.array_remove(public.audit_changed_fields(r->'before',r->'after'),'updated_at') end,
    'actor',actor,'actorName',actor_name,'actorSource',actor_source,'undoOf',null,
    'action','ccinfo_record_delete','pageId','ccinfo','pagePath','/admin/ccinfo','requestId',operation_id
  ) order by r->>'table',r->'before'->>'id',r->>'operation'),'[]'::jsonb) into expected_ack
    from pg_catalog.jsonb_array_elements(expected_audit) r;
  -- Read the new receipts once, not once per deleted port/file.
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'tableSchema',a.table_schema,'table',a.table_name,'operation',a.operation,
    'pk',a.record_pk,'before',a.before_row,'after',a.after_row,'changed',a.changed_fields,
    'actor',a.actor_id,'actorName',a.actor_name,'actorSource',a.actor_source,'undoOf',a.undo_of_log_id,
    'action',a.request_context->>'action','pageId',a.request_context->>'pageId',
    'pagePath',a.request_context->>'pagePath','requestId',a.request_context->>'ccinfoDeleteRequestId'
  ) order by a.table_name,a.record_pk->>'id',a.operation),'[]'::jsonb) into actual_ack
    from public.audit_logs a where a.occurred_at>=pg_catalog.transaction_timestamp()
      and a.request_context @> pg_catalog.jsonb_build_object('ccinfoDeleteRequestId',operation_id);
  if actual_ack is distinct from expected_ack then
    raise exception using errcode='P0001',message='Deletion audit details could not be verified. No entries were deleted.';
  end if;
  deleted_at := pg_catalog.clock_timestamp();
  perform pg_catalog.set_config('app.audit_context',prior_context::text,true);
  perform pg_catalog.set_config('request.headers',prior_headers::text,true);
  return pg_catalog.jsonb_build_object('schema','fcuno.ccinfo-delete/v1','kind',p_kind,'id',p_id,
    'deletedAt',deleted_at,'deletedCount',1,
    'portsDeleted',case when p_kind='country' and p_delete_ports then pg_catalog.jsonb_array_length(ports_before) else 0 end,
    'portsDetached',case when p_kind='country' and not p_delete_ports then pg_catalog.jsonb_array_length(ports_before) else 0 end);
end;
$$;
revoke all on function public.delete_ccinfo_record(text,uuid,timestamptz,boolean) from public,anon,authenticated;
grant execute on function public.delete_ccinfo_record(text,uuid,timestamptz,boolean) to service_role;
