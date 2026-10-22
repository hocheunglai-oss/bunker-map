-- Individually classified business guards must not use PostgREST's retryable40001.
-- Preserve every existing lock, baseline, audit/readback guard, OID, ACL and setting.
set local lock_timeout='3s';
do $preflight$
declare expected record;
begin
 for expected in select * from(values
  ('public.rename_ccinfo_country(uuid,timestamptz,text)','bb1d356502a035a06be834e5527a66e0'),
  ('public.delete_ccinfo_record(text,uuid,timestamptz,boolean)','a2687c5047d811130571a11b1c77d456'),
  ('private.relocate_ccinfo_folder(text,uuid,uuid,text,timestamptz,text,text,text)','ee67470ad2e446192d7b044dd023574f'),
  ('public.delete_ccinfo_folder(text,uuid,uuid,text,timestamptz)','af4804698836a7f0d40b732158f63865'),
  ('public.move_ccinfo_file(text,uuid,text,uuid,timestamptz,uuid)','abee615cfd21590e6cf354a891d707ef'),
  ('public.prepare_ccinfo_file_target(text,uuid,uuid,text)','317aa9586599a3529852583e373f7b9d')
 )as known(signature,body_md5)loop
  if(select pg_catalog.md5(prosrc)from pg_catalog.pg_proc where oid=pg_catalog.to_regprocedure(expected.signature))is distinct from expected.body_md5 then
   raise exception 'CCINFO_OPERATION_SOURCE_MISMATCH' using errcode='55000';
  end if;
 end loop;
end;
$preflight$;

create or replace function public.rename_ccinfo_country(
  p_id uuid, p_expected_updated_at timestamptz, p_name text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  country public.cc_countries%rowtype;
  renamed public.cc_countries%rowtype;
  next_name text;
  prior_timeout text;
  prior_context jsonb;
  prior_headers jsonb;
  prior_rename text;
begin
  if coalesce(nullif(pg_catalog.btrim(public.audit_text_setting('app.audit_actor_id')), ''),
    nullif(pg_catalog.btrim(public.audit_request_header('x-bunker-admin-user')), '')) is null then
    raise exception using errcode = '42501', message = 'A signed-in audit actor is required.';
  end if;
  next_name := pg_catalog.upper(pg_catalog.btrim(p_name));
  if p_id is null or p_expected_updated_at is null or not pg_catalog.isfinite(p_expected_updated_at)
    or next_name is null or next_name = '' or pg_catalog.char_length(next_name) > 200
    or next_name ~ '[[:cntrl:]]' then
    raise exception using errcode = '22023', message = 'A valid country, saved version and country name are required.';
  end if;

  prior_timeout := pg_catalog.current_setting('lock_timeout');
  perform pg_catalog.set_config('lock_timeout', '5s', true);
  -- Match the existing shared backup fence before any table/row locks.
  perform pg_catalog.pg_advisory_xact_lock_shared(730261052372033133::bigint);
  -- Lock in country -> port order, before taking row locks. This prevents two
  -- renames choosing the same name and includes in-flight legacy-name inserts.
  -- ROW SHARE FK lookups remain compatible; normal writers resume at commit.
  lock table public.cc_countries in share row exclusive mode;
  lock table public.cc_ports in share row exclusive mode;
  select * into country from public.cc_countries where id = p_id for no key update;
  if not found or country.updated_at is distinct from p_expected_updated_at then
    raise exception using errcode = 'P0001', message = 'The country changed or was removed. Reopen it before renaming.',detail='CCINFO_COUNTRY_CONFLICT';
  end if;
  if country.name = next_name then
    raise exception using errcode = '22023', message = 'Enter a different country name.';
  end if;
  if exists (select 1 from public.cc_countries where id <> p_id and pg_catalog.upper(pg_catalog.btrim(name)) = next_name) then
    raise exception using errcode = '23505', message = 'Another country already uses this name.';
  end if;
  if exists (select 1 from public.cc_ports where country_id is null and country_name = country.name)
    and exists (select 1 from public.cc_countries where id <> p_id and name = country.name) then
    raise exception using errcode = '23514', message = 'Some ports have an ambiguous country name. Review them before renaming.';
  end if;

  prior_context := public.audit_json_setting('app.audit_context');
  prior_headers := public.audit_json_setting('request.headers');
  prior_rename := pg_catalog.current_setting('app.ccinfo_country_rename', true);
  perform pg_catalog.set_config('app.ccinfo_country_rename', p_id::text, true);
  -- Standard audit capture merges headers last. Mark even direct, trusted
  -- service calls intrinsically, then restore their original request context.
  perform pg_catalog.set_config('request.headers', (prior_headers ||
    pg_catalog.jsonb_build_object('x-bunker-audit-action', 'ccinfo_country_rename'))::text, true);
  perform pg_catalog.set_config('app.audit_context', (
    prior_context || pg_catalog.jsonb_build_object(
      'action', 'ccinfo_country_rename', 'countryId', p_id
    )
  )::text, true);
  update public.cc_countries set name = next_name where id = p_id returning * into renamed;
  update public.cc_ports set country_name = next_name
  where (country_id = p_id or (country_id is null and country_name = country.name))
    and country_name is distinct from next_name;

  perform pg_catalog.set_config('app.ccinfo_country_rename', coalesce(prior_rename, ''), true);
  perform pg_catalog.set_config('app.audit_context', prior_context::text, true);
  perform pg_catalog.set_config('request.headers', prior_headers::text, true);
  perform pg_catalog.set_config('lock_timeout', prior_timeout, true);
  return pg_catalog.jsonb_build_object('id', renamed.id, 'name', renamed.name,
    'updated_at', pg_catalog.to_jsonb(renamed) ->> 'updated_at');
end;
$$;

create or replace function public.delete_ccinfo_record(
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
    raise exception using errcode='P0001', message='The entry changed or was removed. Refresh it before deleting.',detail='CCINFO_DELETE_CONFLICT';
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
      raise exception using errcode='P0001',message='The port deletion could not be verified. No entries were deleted.',detail='CCINFO_DELETE_UNCONFIRMED';
    end if;
    if exists(select 1 from public.cc_ports p join pg_catalog.jsonb_array_elements(ports_before) old on p.id=(old->>'id')::uuid) then
      raise exception using errcode='P0001',message='A deleted port is still present. No entries were deleted.',detail='CCINFO_DELETE_UNCONFIRMED';
    end if;
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'table','cc_ports','operation','DELETE','before',old,'after',null)),'[]'::jsonb) into expected_audit
      from pg_catalog.jsonb_array_elements(ports_before) old;
  end if;
  execute pg_catalog.format('delete from public.%I r where id=$1 and updated_at=$2 returning pg_catalog.to_jsonb(r)',target_table)
    into deleted using p_id,p_expected_updated_at;
  if deleted is distinct from target then
    raise exception using errcode='P0001',message='The deletion could not be verified. No entries were deleted.',detail='CCINFO_DELETE_UNCONFIRMED';
  end if;
  execute pg_catalog.format('select count(*) from public.%I where id=$1',target_table) into matched using p_id;
  if matched<>0 then
    raise exception using errcode='P0001',message='The deleted entry is still present. No entries were deleted.',detail='CCINFO_DELETE_UNCONFIRMED';
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
      raise exception using errcode='P0001',message='The preserved ports could not be verified. No entries were deleted.',detail='CCINFO_DELETE_UNCONFIRMED';
    end if;
    expected_audit := expected_audit || branch_audit;
  elsif p_kind='company' then
    if exists(select 1 from public.cc_company_files f join pg_catalog.jsonb_array_elements(files_before) old on f.id=(old->>'id')::uuid) then
      raise exception using errcode='P0001',message='The existing file cascade could not be verified. No entries were deleted.',detail='CCINFO_DELETE_UNCONFIRMED';
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

create or replace function private.relocate_ccinfo_folder(
  p_entry_kind text, p_entry_id uuid, p_folder_id uuid, p_folder_path text,
  p_expected_updated_at timestamptz, p_parent_path text, p_name text, p_action text
)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  entry_name text;
  root public.cc_entry_folders%rowtype;
  next_name text := pg_catalog.btrim(p_name);
  next_path text;
  prior_timeout text;
  prior_context jsonb;
  prior_headers jsonb;
  folder_changes jsonb;
  entry_changes jsonb;
  company_changes jsonb := '[]'::jsonb;
begin
  if coalesce(nullif(pg_catalog.btrim(public.audit_text_setting('app.audit_actor_id')), ''),
    nullif(pg_catalog.btrim(public.audit_request_header('x-bunker-admin-user')), '')) is null then
    raise exception using errcode = '42501', message = 'A signed-in audit actor is required.';
  end if;
  if p_entry_kind is null or p_entry_kind not in ('company','country','port') or p_entry_id is null
    or p_folder_path is null or p_folder_path = '' or p_folder_path ~ '(^/|/$|//)'
    or p_parent_path is null or p_parent_path ~ '(^/|/$|//)'
    or next_name is null or next_name = '' or pg_catalog.char_length(next_name) > 200
    or next_name ~ '[[:cntrl:]/\\]'
    or p_action is null or p_action not in ('ccinfo_folder_rename','ccinfo_folder_move') then
    raise exception using errcode = '22023', message = 'A valid entry, folder and single folder name are required.';
  end if;
  prior_timeout := pg_catalog.current_setting('lock_timeout');
  perform pg_catalog.set_config('lock_timeout', '5s', true);
  perform pg_catalog.pg_advisory_xact_lock_shared(730261052372033133::bigint);
  -- Lock the owning entity before file tables, matching entity-delete/FK order.
  if p_entry_kind = 'company' then
    select name into entry_name from public.cc_companies where id = p_entry_id for key share;
  elsif p_entry_kind = 'country' then
    select name into entry_name from public.cc_countries where id = p_entry_id for key share;
  else
    select name into entry_name from public.cc_ports where id = p_entry_id for key share;
  end if;
  if not found then raise exception using errcode = 'P0001', message = 'This entry was removed. Reopen it.',detail='CCINFO_FOLDER_CONFLICT'; end if;
  -- Legacy writers are included before commit, and cannot insert a destination
  -- collision between preflight and the writes. No new tables are introduced.
  lock table public.cc_entry_folders in share row exclusive mode;
  lock table public.cc_entry_files in share row exclusive mode;
  if p_entry_kind = 'company' then lock table public.cc_company_files in share row exclusive mode; end if;
  if p_folder_id is not null then
    select * into root from public.cc_entry_folders
      where id = p_folder_id and entry_kind = p_entry_kind and entry_id = p_entry_id for update;
    if not found or root.updated_at is distinct from p_expected_updated_at
      or pg_catalog.concat_ws('/',nullif(root.folder_path,''),root.name) <> p_folder_path then
      raise exception using errcode = 'P0001', message = 'This folder changed. Reopen it before renaming.',detail='CCINFO_FOLDER_CONFLICT';
    end if;
  elsif exists (select 1 from public.cc_entry_folders where entry_kind = p_entry_kind and entry_id = p_entry_id
      and pg_catalog.concat_ws('/',nullif(folder_path,''),name) = p_folder_path) then
    raise exception using errcode = 'P0001', message = 'This folder changed. Reopen it before renaming.',detail='CCINFO_FOLDER_CONFLICT';
  elsif not exists (select 1 from public.cc_entry_files where entry_kind = p_entry_kind and entry_id = p_entry_id
      and (folder_path = p_folder_path or pg_catalog.starts_with(folder_path,p_folder_path || '/')))
    and not exists (select 1 from public.cc_entry_folders where entry_kind=p_entry_kind and entry_id=p_entry_id
      and (folder_path=p_folder_path or pg_catalog.starts_with(folder_path,p_folder_path || '/')))
    and not (p_entry_kind = 'company' and exists (select 1 from public.cc_company_files where company_id = p_entry_id
      and (private.ccinfo_company_folder_path(original_path) = p_folder_path
        or pg_catalog.starts_with(private.ccinfo_company_folder_path(original_path),p_folder_path || '/')))) then
    raise exception using errcode = 'P0001', message = 'This folder changed or was removed. Reopen it.',detail='CCINFO_FOLDER_CONFLICT';
  end if;
  if p_parent_path = p_folder_path or pg_catalog.starts_with(p_parent_path,p_folder_path || '/') then
    raise exception using errcode = '22023', message = 'A folder cannot be moved inside itself.';
  end if;
  if p_parent_path <> '' and not exists (select 1 from public.cc_entry_folders where entry_kind = p_entry_kind and entry_id = p_entry_id
      and (pg_catalog.concat_ws('/',nullif(folder_path,''),name) = p_parent_path
        or folder_path=p_parent_path or pg_catalog.starts_with(folder_path,p_parent_path || '/')))
    and not exists (select 1 from public.cc_entry_files where entry_kind = p_entry_kind and entry_id = p_entry_id
      and (folder_path = p_parent_path or pg_catalog.starts_with(folder_path,p_parent_path || '/')))
    and not (p_entry_kind = 'company' and exists (select 1 from public.cc_company_files where company_id = p_entry_id
      and (private.ccinfo_company_folder_path(original_path) = p_parent_path
        or pg_catalog.starts_with(private.ccinfo_company_folder_path(original_path),p_parent_path || '/')))) then
    raise exception using errcode = 'P0001', message = 'The destination folder changed or was removed. Reopen it.',detail='CCINFO_FOLDER_CONFLICT';
  end if;
  next_path := pg_catalog.concat_ws('/',nullif(p_parent_path,''),next_name);
  if next_path = p_folder_path then raise exception using errcode = '22023', message = 'Enter a different folder name.'; end if;
  -- Reject merging into either an explicit or an implied folder, including
  -- recently deleted files that still occupy the database's unique paths.
  if exists (select 1 from public.cc_entry_folders where entry_kind = p_entry_kind and entry_id = p_entry_id
      and (pg_catalog.concat_ws('/',nullif(folder_path,''),name) = next_path
        or pg_catalog.starts_with(pg_catalog.concat_ws('/',nullif(folder_path,''),name),next_path || '/')))
    or exists (select 1 from public.cc_entry_files where entry_kind = p_entry_kind and entry_id = p_entry_id
      and (folder_path = next_path or pg_catalog.starts_with(folder_path,next_path || '/')))
    or (p_entry_kind = 'company' and exists (select 1 from public.cc_company_files where company_id = p_entry_id
      and (private.ccinfo_company_folder_path(original_path) = next_path
        or pg_catalog.starts_with(private.ccinfo_company_folder_path(original_path),next_path || '/')))) then
    raise exception using errcode = '23505', message = 'Another folder already uses this name.';
  end if;
  prior_context := public.audit_json_setting('app.audit_context');
  prior_headers := public.audit_json_setting('request.headers');
  perform pg_catalog.set_config('request.headers',(prior_headers || pg_catalog.jsonb_build_object('x-bunker-audit-action',p_action))::text,true);
  perform pg_catalog.set_config('app.audit_context',(prior_context || pg_catalog.jsonb_build_object('action',p_action,'entryId',p_entry_id,'folderPath',p_folder_path))::text,true);
  with changed as (
    update public.cc_entry_folders set
      name = case when pg_catalog.concat_ws('/',nullif(folder_path,''),name) = p_folder_path then next_name else name end,
      folder_path = case when pg_catalog.concat_ws('/',nullif(folder_path,''),name) = p_folder_path then p_parent_path
        when folder_path = p_folder_path or pg_catalog.starts_with(folder_path,p_folder_path || '/')
        then next_path || substring(folder_path from pg_catalog.length(p_folder_path)+1) else folder_path end
    where entry_kind = p_entry_kind and entry_id = p_entry_id
      and (pg_catalog.concat_ws('/',nullif(folder_path,''),name) = p_folder_path
        or folder_path = p_folder_path or pg_catalog.starts_with(folder_path,p_folder_path || '/'))
    returning id,folder_path,name,updated_at,implicit
  ) select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(changed)), '[]') into folder_changes from changed;
  with changed as (
    update public.cc_entry_files set
      folder_path = next_path || substring(folder_path from pg_catalog.length(p_folder_path)+1),
      original_path = private.ccinfo_rebase_original_path(original_path,p_entry_kind,entry_name,
        next_path || substring(folder_path from pg_catalog.length(p_folder_path)+1),file_name)
    where entry_kind = p_entry_kind and entry_id = p_entry_id
      and (folder_path = p_folder_path or pg_catalog.starts_with(folder_path,p_folder_path || '/'))
    returning id,folder_path,original_path
  ) select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(changed)), '[]') into entry_changes from changed;
  if p_entry_kind = 'company' then
    with changed as (
      update public.cc_company_files set original_path = private.ccinfo_rebase_original_path(original_path,'company',entry_name,
        next_path || substring(private.ccinfo_company_folder_path(original_path) from pg_catalog.length(p_folder_path)+1),file_name)
      where company_id = p_entry_id and (private.ccinfo_company_folder_path(original_path) = p_folder_path
        or pg_catalog.starts_with(private.ccinfo_company_folder_path(original_path),p_folder_path || '/'))
      returning id,original_path,private.ccinfo_company_folder_path(original_path) as folder_path
    ) select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(changed)), '[]') into company_changes from changed;
  end if;
  perform pg_catalog.set_config('app.audit_context',prior_context::text,true);
  perform pg_catalog.set_config('request.headers',prior_headers::text,true);
  perform pg_catalog.set_config('lock_timeout',prior_timeout,true);
  return pg_catalog.jsonb_build_object('entryKind',p_entry_kind,'entryId',p_entry_id,
    'previousPath',p_folder_path,'folderPath',next_path,'folders',folder_changes,'entryFiles',entry_changes,'companyFiles',company_changes);
end;
$$;

create or replace function public.delete_ccinfo_folder(
  p_entry_kind text, p_entry_id uuid, p_folder_id uuid, p_folder_path text,
  p_expected_updated_at timestamptz
)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  root public.cc_entry_folders%rowtype;
  entry_file_ids jsonb := '[]'::jsonb;
  company_file_ids jsonb := '[]'::jsonb;
  folder_ids jsonb := '[]'::jsonb;
  deleted_time timestamptz := pg_catalog.clock_timestamp();
  prior_timeout text;
  prior_headers jsonb;
  prior_context jsonb;
  delete_contents boolean;
begin
  if coalesce(nullif(pg_catalog.btrim(public.audit_text_setting('app.audit_actor_id')), ''),
    nullif(pg_catalog.btrim(public.audit_request_header('x-bunker-admin-user')), '')) is null then
    raise exception using errcode = '42501', message = 'A signed-in audit actor is required.';
  end if;
  if p_entry_kind is null or p_entry_kind not in ('company','country','port') or p_entry_id is null
    or p_folder_path is null or p_folder_path = '' or p_folder_path ~ '(^/|/$|//)' then
    raise exception using errcode = '22023', message = 'A valid entry and folder are required.';
  end if;
  prior_timeout := pg_catalog.current_setting('lock_timeout');
  perform pg_catalog.set_config('lock_timeout','5s',true);
  perform pg_catalog.pg_advisory_xact_lock_shared(730261052372033133::bigint);
  if p_entry_kind = 'company' then perform 1 from public.cc_companies where id=p_entry_id for key share;
  elsif p_entry_kind = 'country' then perform 1 from public.cc_countries where id=p_entry_id for key share;
  else perform 1 from public.cc_ports where id=p_entry_id for key share;
  end if;
  if not found then raise exception using errcode='P0001',message='This entry was removed. Reopen it.',detail='CCINFO_FOLDER_CONFLICT'; end if;
  lock table public.cc_entry_folders in share row exclusive mode;
  lock table public.cc_entry_files in share row exclusive mode;
  if p_entry_kind='company' then lock table public.cc_company_files in share row exclusive mode; end if;
  if p_folder_id is not null then
    select * into root from public.cc_entry_folders where id=p_folder_id and entry_kind=p_entry_kind and entry_id=p_entry_id for update;
    if not found or root.updated_at is distinct from p_expected_updated_at
      or pg_catalog.concat_ws('/',nullif(root.folder_path,''),root.name)<>p_folder_path then
      raise exception using errcode='P0001',message='This folder changed. Reopen it before deleting.',detail='CCINFO_FOLDER_CONFLICT';
    end if;
  elsif exists(select 1 from public.cc_entry_folders where entry_kind=p_entry_kind and entry_id=p_entry_id
    and pg_catalog.concat_ws('/',nullif(folder_path,''),name)=p_folder_path) then
    raise exception using errcode='P0001',message='This folder changed. Reopen it before deleting.',detail='CCINFO_FOLDER_CONFLICT';
  end if;
  delete_contents := p_folder_id is null or root.implicit;
  -- Explicit subfolders must remain accessible and are never silently removed.
  if exists(select 1 from public.cc_entry_folders where entry_kind=p_entry_kind and entry_id=p_entry_id
    and (not delete_contents or not implicit)
    and (folder_path=p_folder_path or pg_catalog.starts_with(folder_path,p_folder_path||'/')))
    or (not delete_contents and (
      exists(select 1 from public.cc_entry_files where entry_kind=p_entry_kind and entry_id=p_entry_id and deleted_at is null
        and (folder_path=p_folder_path or pg_catalog.starts_with(folder_path,p_folder_path||'/')))
      or (p_entry_kind='company' and exists(select 1 from public.cc_company_files where company_id=p_entry_id and deleted_at is null
        and (private.ccinfo_company_folder_path(original_path)=p_folder_path
          or pg_catalog.starts_with(private.ccinfo_company_folder_path(original_path),p_folder_path||'/')))))) then
    raise exception using errcode='23514',message='Move or delete files and subfolders inside this folder first.';
  end if;
  prior_headers:=public.audit_json_setting('request.headers');
  prior_context:=public.audit_json_setting('app.audit_context');
  perform pg_catalog.set_config('request.headers',(prior_headers||pg_catalog.jsonb_build_object('x-bunker-audit-action','ccinfo_folder_delete'))::text,true);
  perform pg_catalog.set_config('app.audit_context',(prior_context||pg_catalog.jsonb_build_object('action','ccinfo_folder_delete','entryId',p_entry_id,'folderPath',p_folder_path))::text,true);
  if not delete_contents then
    delete from public.cc_entry_folders where id=p_folder_id;
    folder_ids:=pg_catalog.jsonb_build_array(p_folder_id);
  else
    with changed as (update public.cc_entry_files set deleted_at=deleted_time
      where entry_kind=p_entry_kind and entry_id=p_entry_id and deleted_at is null
        and (folder_path=p_folder_path or pg_catalog.starts_with(folder_path,p_folder_path||'/')) returning id)
    select coalesce(pg_catalog.jsonb_agg(id),'[]') into entry_file_ids from changed;
    if p_entry_kind='company' then
      with changed as (update public.cc_company_files set deleted_at=deleted_time
        where company_id=p_entry_id and deleted_at is null and (private.ccinfo_company_folder_path(original_path)=p_folder_path
          or pg_catalog.starts_with(private.ccinfo_company_folder_path(original_path),p_folder_path||'/')) returning id)
      select coalesce(pg_catalog.jsonb_agg(id),'[]') into company_file_ids from changed;
    end if;
    with removed as (delete from public.cc_entry_folders where entry_kind=p_entry_kind and entry_id=p_entry_id and implicit
      and (pg_catalog.concat_ws('/',nullif(folder_path,''),name)=p_folder_path
        or folder_path=p_folder_path or pg_catalog.starts_with(folder_path,p_folder_path||'/')) returning id)
    select coalesce(pg_catalog.jsonb_agg(id),'[]') into folder_ids from removed;
    if pg_catalog.jsonb_array_length(entry_file_ids)+pg_catalog.jsonb_array_length(company_file_ids)+pg_catalog.jsonb_array_length(folder_ids)=0 then
      raise exception using errcode='P0001',message='This folder changed or was removed. Reopen it.',detail='CCINFO_FOLDER_CONFLICT';
    end if;
  end if;
  perform pg_catalog.set_config('request.headers',prior_headers::text,true);
  perform pg_catalog.set_config('app.audit_context',prior_context::text,true);
  perform pg_catalog.set_config('lock_timeout',prior_timeout,true);
  return pg_catalog.jsonb_build_object('entryKind',p_entry_kind,'entryId',p_entry_id,'folderPath',p_folder_path,
    'folderIds',folder_ids,'entryFileIds',entry_file_ids,'companyFileIds',company_file_ids,'deletedAt',deleted_time);
end;
$$;

create or replace function public.move_ccinfo_file(
  p_entry_kind text,p_entry_id uuid,p_source text,p_file_id uuid,p_expected_updated_at timestamptz,p_folder_id uuid
)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  target jsonb;
  saved jsonb;
  company_file public.cc_company_files%rowtype;
  entry_file public.cc_entry_files%rowtype;
begin
  target:=public.prepare_ccinfo_file_target(p_entry_kind,p_entry_id,p_folder_id,'');
  if p_source='company' and p_entry_kind='company' then
    select * into company_file from public.cc_company_files where id=p_file_id and company_id=p_entry_id and deleted_at is null for update;
    if not found or company_file.updated_at is distinct from p_expected_updated_at then raise exception using errcode='P0001',message='This file changed or was removed. Reopen it.',detail='CCINFO_FILE_CONFLICT'; end if;
    update public.cc_company_files set original_path=private.ccinfo_rebase_original_path(original_path,'company',target->>'entryName',target->>'folderPath',file_name)
      where id=p_file_id returning pg_catalog.to_jsonb(cc_company_files.*) into saved;
  elsif p_source='entry' then
    select * into entry_file from public.cc_entry_files where id=p_file_id and entry_kind=p_entry_kind and entry_id=p_entry_id and deleted_at is null for update;
    if not found or entry_file.updated_at is distinct from p_expected_updated_at then raise exception using errcode='P0001',message='This file changed or was removed. Reopen it.',detail='CCINFO_FILE_CONFLICT'; end if;
    update public.cc_entry_files set folder_path=target->>'folderPath',original_path=private.ccinfo_rebase_original_path(original_path,p_entry_kind,target->>'entryName',target->>'folderPath',file_name)
      where id=p_file_id returning pg_catalog.to_jsonb(cc_entry_files.*) into saved;
  else raise exception using errcode='22023',message='A valid file source is required.';
  end if;
  return saved||pg_catalog.jsonb_build_object('source',p_source,'folder_path',target->>'folderPath');
end;
$$;

create or replace function public.prepare_ccinfo_file_target(
  p_entry_kind text, p_entry_id uuid, p_folder_id uuid, p_folder_path text
)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  entry_name text;
  target public.cc_entry_folders%rowtype;
begin
  if coalesce(nullif(pg_catalog.btrim(public.audit_text_setting('app.audit_actor_id')), ''),
    nullif(pg_catalog.btrim(public.audit_request_header('x-bunker-admin-user')), '')) is null then
    raise exception using errcode='42501',message='A signed-in audit actor is required.';
  end if;
  if p_entry_kind is null or p_entry_kind not in ('company','country','port') or p_entry_id is null
    or p_folder_path is null or p_folder_path ~ '(^/|/$|//)' then
    raise exception using errcode='22023',message='A valid destination is required.';
  end if;
  perform pg_catalog.pg_advisory_xact_lock_shared(730261052372033133::bigint);
  if p_entry_kind='company' then select name into entry_name from public.cc_companies where id=p_entry_id for key share;
  elsif p_entry_kind='country' then select name into entry_name from public.cc_countries where id=p_entry_id for key share;
  else select name into entry_name from public.cc_ports where id=p_entry_id for key share;
  end if;
  if not found then raise exception using errcode='P0001',message='The entry was removed. Reopen it.',detail='CCINFO_FILE_TARGET_CONFLICT'; end if;
  lock table public.cc_entry_folders in share row exclusive mode;
  lock table public.cc_entry_files in share row exclusive mode;
  if p_entry_kind='company' then lock table public.cc_company_files in share row exclusive mode; end if;
  if p_folder_id is not null then
    select * into target from public.cc_entry_folders where id=p_folder_id and entry_kind=p_entry_kind and entry_id=p_entry_id for update;
    if not found then raise exception using errcode='P0001',message='The destination was removed. Reopen it.',detail='CCINFO_FILE_TARGET_CONFLICT'; end if;
  elsif p_folder_path<>'' then
    select * into target from public.cc_entry_folders where entry_kind=p_entry_kind and entry_id=p_entry_id
      and pg_catalog.concat_ws('/',nullif(folder_path,''),name)=p_folder_path for update;
    if not found then
      if not exists(select 1 from public.cc_entry_folders where entry_kind=p_entry_kind and entry_id=p_entry_id
          and (folder_path=p_folder_path or pg_catalog.starts_with(folder_path,p_folder_path||'/')))
        and not exists(select 1 from public.cc_entry_files where entry_kind=p_entry_kind and entry_id=p_entry_id and deleted_at is null
          and (folder_path=p_folder_path or pg_catalog.starts_with(folder_path,p_folder_path||'/')))
        and not (p_entry_kind='company' and exists(select 1 from public.cc_company_files where company_id=p_entry_id and deleted_at is null
          and (private.ccinfo_company_folder_path(original_path)=p_folder_path
            or pg_catalog.starts_with(private.ccinfo_company_folder_path(original_path),p_folder_path||'/')))) then
        raise exception using errcode='P0001',message='The destination changed or was removed. Reopen it.',detail='CCINFO_FILE_TARGET_CONFLICT';
      end if;
      insert into public.cc_entry_folders(entry_kind,entry_id,folder_path,name,implicit)
      values(p_entry_kind,p_entry_id,pg_catalog.regexp_replace(p_folder_path,'(^|/)[^/]+$',''),substring(p_folder_path from '[^/]+$'),true) returning * into target;
    end if;
  end if;
  return pg_catalog.jsonb_build_object('entryKind',p_entry_kind,'entryId',p_entry_id,'entryName',entry_name,
    'folderId',target.id,'folderPath',case when target.id is null then '' else pg_catalog.concat_ws('/',nullif(target.folder_path,''),target.name) end);
end;
$$;

