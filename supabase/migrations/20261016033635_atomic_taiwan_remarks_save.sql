-- Browser-reviewed baselines for notices only. Quotes/publications are untouched.
-- The shared backup fence is acquired before the last table in the existing
-- ports -> price_history -> remarks writer order, including absent notice rows.
create or replace function public.save_taiwan_remarks(p_changes jsonb)
returns jsonb language plpgsql volatile security invoker
set search_path = '' set lock_timeout = '5s' set statement_timeout = '15s'
as $$
declare
  change jsonb;
  expected jsonb;
  notice_id integer;
  current_content text;
  current_exists boolean;
  saved_content text;
  replayed boolean := true;
  saved_rows jsonb := '[]'::jsonb;
  prior_headers jsonb;
  prior_context jsonb;
  expected_actor_id text;
  expected_actor_name text;
  expected_actor_source text;
  operation_id uuid;
  audit_count bigint;
begin
  expected_actor_id := coalesce(nullif(public.audit_text_setting('app.audit_actor_id'),''),
    nullif(public.audit_request_header('x-bunker-admin-user'),''));
  if nullif(btrim(expected_actor_id),'') is null then
    raise exception using errcode='42501',message='A signed-in audit actor is required.';
  end if;
  if jsonb_typeof(p_changes) is distinct from 'array' or jsonb_array_length(p_changes) not between 1 and 3 then
    raise exception using errcode='22023',message='Complete notice changes and saved baselines are required.';
  end if;
  for change in select value from jsonb_array_elements(p_changes) loop
    expected := change->'expected';
    if jsonb_typeof(change) is distinct from 'object'
      or (select count(*) from jsonb_object_keys(change)) <> 3
      or not change ?& array['id','expected','content']
      or change->'id' not in ('1'::jsonb,'2'::jsonb,'3'::jsonb)
      or jsonb_typeof(change->'content') is distinct from 'string'
      or octet_length(change->>'content') > 1048576
      or jsonb_typeof(expected) is distinct from 'object'
      or (select count(*) from jsonb_object_keys(expected)) <> 3
      or not expected ?& array['id','exists','content']
      or expected->'id' is distinct from change->'id'
      or jsonb_typeof(expected->'exists') is distinct from 'boolean'
      or jsonb_typeof(expected->'content') not in ('string','null')
      or octet_length(expected->>'content') > 1048576
      or expected->>'exists'='false' and expected->'content' is distinct from 'null'::jsonb then
      raise exception using errcode='22023',message='Complete notice changes and saved baselines are required.';
    end if;
  end loop;
  if (select count(distinct value->'id') from jsonb_array_elements(p_changes)) <> jsonb_array_length(p_changes) then
    raise exception using errcode='22023',message='Each notice may be changed once.';
  end if;

  perform pg_advisory_xact_lock_shared(730261052372033133::bigint);
  lock table public.remarks in share row exclusive mode;
  -- Exact committed readback makes an identical lost-ack retry read-only.
  for change in select value from jsonb_array_elements(p_changes) order by (value->>'id')::integer loop
    select content into current_content from public.remarks where id=(change->>'id')::integer;
    current_exists := found;
    replayed := replayed and current_exists and current_content is not distinct from change->>'content';
  end loop;
  if not replayed then
    -- Validate EVERY captured baseline before changing ANY requested row.
    for change in select value from jsonb_array_elements(p_changes) order by (value->>'id')::integer loop
      expected := change->'expected';
      select content into current_content from public.remarks where id=(change->>'id')::integer;
      current_exists := found;
      if current_exists is distinct from (expected->>'exists')::boolean
        or current_content is distinct from expected->>'content' then
        raise exception using errcode='40001',message='The saved remarks changed. Keep the draft and reload.';
      end if;
    end loop;
    prior_headers := public.audit_json_setting('request.headers');
    prior_context := public.audit_json_setting('app.audit_context');
    expected_actor_name := coalesce(nullif(public.audit_text_setting('app.audit_actor_name'),''),
      nullif(public.audit_request_header('x-bunker-admin-display-name'),''),expected_actor_id);
    expected_actor_source := case when nullif(public.audit_text_setting('app.audit_actor_id'),'') is not null then 'app' else 'header' end;
    operation_id := gen_random_uuid();
    perform set_config('request.headers',(prior_headers||jsonb_build_object('x-bunker-audit-action','taiwan_remarks_save'))::text,true);
    perform set_config('app.audit_context',(prior_context||jsonb_build_object('action','taiwan_remarks_save','taiwanRemarksOperationId',operation_id))::text,true);
    for change in select value from jsonb_array_elements(p_changes) order by (value->>'id')::integer loop
      notice_id := (change->>'id')::integer;
      select content into current_content from public.remarks where id=notice_id;
      current_exists := found;
      if current_exists and current_content is not distinct from change->>'content' then continue; end if;
      if current_exists then
        update public.remarks set content=change->>'content' where id=notice_id returning content into saved_content;
      else
        insert into public.remarks(id,content) values(notice_id,change->>'content') returning content into saved_content;
      end if;
      if not found or saved_content is distinct from change->>'content' then
        raise exception using errcode='40001',message='The remark save could not be confirmed.';
      end if;
      -- Existing row audit trigger owns the audit. Require its exact new receipt,
      -- rather than treating a suppressed/altered INSERT as a successful save.
      select count(*) into audit_count from public.audit_logs a
      where a.table_schema='public' and a.table_name='remarks'
        and a.record_pk @> jsonb_build_object('id',notice_id)
        and a.record_pk=jsonb_build_object('id',notice_id)
        and a.actor_id is not distinct from expected_actor_id
        and a.actor_name is not distinct from expected_actor_name
        and a.actor_source=expected_actor_source
        and a.operation=case when current_exists then 'UPDATE' else 'INSERT' end
        and a.changed_fields=case when current_exists then array['content']::text[] else '{}'::text[] end
        and a.before_row is not distinct from case when current_exists then jsonb_build_object('id',notice_id,'content',current_content) else null end
        and a.after_row=jsonb_build_object('id',notice_id,'content',saved_content)
        and a.request_context @> jsonb_build_object('action','taiwan_remarks_save','taiwanRemarksOperationId',operation_id);
      if audit_count <> 1 then
        raise exception using errcode='40001',message='The remark audit could not be confirmed. No changes were saved.';
      end if;
    end loop;
    perform set_config('request.headers',prior_headers::text,true);
    perform set_config('app.audit_context',prior_context::text,true);
  end if;
  for change in select value from jsonb_array_elements(p_changes) order by (value->>'id')::integer loop
    notice_id := (change->>'id')::integer;
    select content into saved_content from public.remarks where id=notice_id;
    if not found or saved_content is distinct from change->>'content' then
      raise exception using errcode='40001',message='The remark save could not be confirmed.';
    end if;
    saved_rows := saved_rows||jsonb_build_array(jsonb_build_object('id',notice_id,'content',saved_content));
  end loop;
  return jsonb_build_object('rows',saved_rows,'replayed',replayed);
end $$;
revoke all on function public.save_taiwan_remarks(jsonb) from public,anon,authenticated;
grant execute on function public.save_taiwan_remarks(jsonb) to service_role;
