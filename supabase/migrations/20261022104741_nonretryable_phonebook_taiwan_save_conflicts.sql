-- Expected-version conflicts and definite rolled-back saves must not use
-- SQLSTATE40001: PostgREST14 may retry custom serialization errors indefinitely.
-- Preserve all guards, locks, audit/readback checks, settings and service-only ACLs.
set local lock_timeout = '3s';

do $preflight$
declare expected record;
begin
  for expected in select * from (values
    ('public.save_phonebook_company(uuid,timestamptz,jsonb)', '67809338d3dd64adf6eb1a455a152ae8'),
    ('public.save_taiwan_remarks(jsonb)', 'c94f88f2000c1988cf11a8f99941ce72')
  ) as known(signature,body_md5)
  loop
    if (select pg_catalog.md5(prosrc) from pg_catalog.pg_proc
        where oid=pg_catalog.to_regprocedure(expected.signature))
        is distinct from expected.body_md5 then
      raise exception 'PHONEBOOK_TAIWAN_SAVE_SOURCE_MISMATCH' using errcode='55000';
    end if;
  end loop;
end;
$preflight$;

create or replace function public.save_phonebook_company(p_id uuid,p_expected_updated_at timestamptz,p_patch jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  company public.phonebook_companies%rowtype;
  edited public.phonebook_companies%rowtype;
  saved public.phonebook_companies%rowtype;
  prior_headers jsonb; prior_context jsonb; prior_save text; prior_timeout text;
  contact_ids jsonb;
  allowed text[] := array['name','other_name','phone','address','country','tel_country','tel_area','tel_no_1','tel_no_2','tel_speed_dial','fax_no_1','website','email','contact_type','stem_management','company_status','company_info','seller_term','seller_credit_limit','seller_credit_limit_flexibility','seller_classification','seller_remark_1','seller_remark_2','seller_remark_3','seller_remark_4','buyer_term','buyer_credit_limit','buyer_credit_limit_flexibility','buyer_classification','buyer_remark_1','buyer_remark_2','buyer_remark_3','buyer_remark_4','notes'];
begin
  if coalesce(nullif(btrim(public.audit_text_setting('app.audit_actor_id')),''),nullif(btrim(public.audit_request_header('x-bunker-admin-user')),'')) is null then
    raise exception using errcode='42501',message='A signed-in audit actor is required.';
  end if;
  if p_id is null or p_expected_updated_at is null or not isfinite(p_expected_updated_at)
    or jsonb_typeof(p_patch) is distinct from 'object' or not p_patch ? 'name'
    or exists(select 1 from jsonb_each(p_patch) e where not e.key=any(allowed)
      or (jsonb_typeof(e.value) not in ('string','null')) or octet_length(e.value::text)>80002)
    or jsonb_typeof(p_patch->'name') is distinct from 'string'
    or nullif(btrim(p_patch->>'name'),'') is null or char_length(btrim(p_patch->>'name'))>200
    or (p_patch->>'name') ~ '[[:cntrl:]]' then
    raise exception using errcode='22023',message='Valid company details and a saved version are required.';
  end if;
  prior_timeout:=current_setting('lock_timeout'); perform set_config('lock_timeout','5s',true);
  perform pg_advisory_xact_lock_shared(730261052372033133::bigint);
  lock table public.phonebook_companies in share row exclusive mode;
  lock table public.phonebook_contacts in share row exclusive mode;
  select * into company from public.phonebook_companies where id=p_id for no key update;
  if not found or company.updated_at is distinct from p_expected_updated_at then
    raise exception using errcode='P0001',message='The company changed or was removed. Reopen it.',detail='PHONEBOOK_COMPANY_CONFLICT';
  end if;
  edited:=jsonb_populate_record(company,p_patch);
  edited.name:=upper(btrim(edited.name));
  if exists(select 1 from public.phonebook_companies c where c.id<>p_id and upper(btrim(c.name))=edited.name) then
    raise exception using errcode='23505',message='Another company already uses this name.';
  end if;
  if edited.name is distinct from company.name and exists(
    select 1 from public.phonebook_contacts p join public.phonebook_companies c on c.source_key=p.company_source_id
    where upper(btrim(p.company)) in (upper(btrim(company.name)),edited.name) and c.id<>p_id
  ) then raise exception using errcode='23514',message='Some contacts have conflicting company links.'; end if;
  prior_headers:=public.audit_json_setting('request.headers'); prior_context:=public.audit_json_setting('app.audit_context');
  prior_save:=current_setting('app.phonebook_company_save',true);
  perform set_config('app.phonebook_company_save',p_id::text,true);
  perform set_config('request.headers',(prior_headers||jsonb_build_object('x-bunker-audit-action','phonebook_company_save'))::text,true);
  perform set_config('app.audit_context',(prior_context||jsonb_build_object('action','phonebook_company_save','companyId',p_id))::text,true);
  update public.phonebook_companies set
    name=edited.name,other_name=edited.other_name,phone=edited.phone,address=edited.address,country=edited.country,
    tel_country=edited.tel_country,tel_area=edited.tel_area,tel_no_1=edited.tel_no_1,tel_no_2=edited.tel_no_2,
    tel_speed_dial=edited.tel_speed_dial,fax_no_1=edited.fax_no_1,website=edited.website,email=edited.email,
    contact_type=edited.contact_type,stem_management=edited.stem_management,company_status=edited.company_status,
    company_info=edited.company_info,seller_term=edited.seller_term,seller_credit_limit=edited.seller_credit_limit,
    seller_credit_limit_flexibility=edited.seller_credit_limit_flexibility,seller_classification=edited.seller_classification,
    seller_remark_1=edited.seller_remark_1,seller_remark_2=edited.seller_remark_2,seller_remark_3=edited.seller_remark_3,
    seller_remark_4=edited.seller_remark_4,buyer_term=edited.buyer_term,buyer_credit_limit=edited.buyer_credit_limit,
    buyer_credit_limit_flexibility=edited.buyer_credit_limit_flexibility,buyer_classification=edited.buyer_classification,
    buyer_remark_1=edited.buyer_remark_1,buyer_remark_2=edited.buyer_remark_2,buyer_remark_3=edited.buyer_remark_3,
    buyer_remark_4=edited.buyer_remark_4,notes=edited.notes where id=p_id returning * into saved;
  -- A valid source key also identifies older alias labels. Canonicalize those
  -- on a phone-only save so inherited details and durable queue work agree.
  update public.phonebook_contacts p set company=saved.name
  where (p.company_source_id=company.source_key and p.company is distinct from saved.name)
    or (saved.name is distinct from company.name and upper(btrim(p.company))=upper(btrim(company.name)));
  select coalesce(jsonb_agg(p.id order by p.id),'[]'::jsonb) into contact_ids from public.phonebook_contacts p
    where p.company_source_id=company.source_key or upper(btrim(p.company))=upper(btrim(saved.name));
  perform set_config('app.phonebook_company_save',coalesce(prior_save,''),true);
  perform set_config('request.headers',prior_headers::text,true); perform set_config('app.audit_context',prior_context::text,true);
  perform set_config('lock_timeout',prior_timeout,true);
  return jsonb_build_object('company',to_jsonb(saved),'contactIds',contact_ids);
end $$;

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
        raise exception using errcode='P0001',message='The saved remarks changed. Keep the draft and reload.',detail='TAIWAN_REMARKS_CONFLICT';
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
        raise exception using errcode='P0001',message='The remark save could not be confirmed.',detail='TAIWAN_REMARKS_UNCONFIRMED';
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
        raise exception using errcode='P0001',message='The remark audit could not be confirmed. No changes were saved.',detail='TAIWAN_REMARKS_UNCONFIRMED';
      end if;
    end loop;
    perform set_config('request.headers',prior_headers::text,true);
    perform set_config('app.audit_context',prior_context::text,true);
  end if;
  for change in select value from jsonb_array_elements(p_changes) order by (value->>'id')::integer loop
    notice_id := (change->>'id')::integer;
    select content into saved_content from public.remarks where id=notice_id;
    if not found or saved_content is distinct from change->>'content' then
      raise exception using errcode='P0001',message='The remark save could not be confirmed.',detail='TAIWAN_REMARKS_UNCONFIRMED';
    end if;
    saved_rows := saved_rows||jsonb_build_array(jsonb_build_object('id',notice_id,'content',saved_content));
  end loop;
  return jsonb_build_object('rows',saved_rows,'replayed',replayed);
end $$;

