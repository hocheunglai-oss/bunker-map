-- Business refusals must not enter PostgREST's serialization retry loop.
-- Append-only: refuse an unexpected live body before replacing any RPC.
set local lock_timeout = '3s';
do $preflight$
begin
  if not exists (select 1 from pg_catalog.pg_proc where oid = pg_catalog.to_regprocedure('public.compare_and_swap_spc_supplier_store(jsonb,jsonb,boolean,text,uuid,text)') and md5(prosrc) = 'ff265a4af87bb4b9e3ca6b79f9133169') then
    raise exception using errcode = '55000', message = 'SPC write-conflict function baseline changed; review before applying.';
  end if;
  if not exists (select 1 from pg_catalog.pg_proc where oid = pg_catalog.to_regprocedure('public.stem_spc_enquiry_with_fixture(uuid,text,timestamptz,uuid,text,text,jsonb)') and md5(prosrc) = '7309aaf7fce7eba9d9e51dd75ca3b649') then
    raise exception using errcode = '55000', message = 'SPC write-conflict function baseline changed; review before applying.';
  end if;
  if not exists (select 1 from pg_catalog.pg_proc where oid = pg_catalog.to_regprocedure('public.update_spc_fixture_with_enquiry(uuid,text,timestamptz,text,text,jsonb,text)') and md5(prosrc) = '5f3bf387a8291435453dc1701f18914e') then
    raise exception using errcode = '55000', message = 'SPC write-conflict function baseline changed; review before applying.';
  end if;
end;
$preflight$;

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
      raise exception using errcode='P0001', message='Supplier data changed. Reload and retry the save.', detail='supplier-store-cas-contention';
    end if;
  else
    select * into before_row from public.office_calendar_store
      where key='spc-supplier-overrides' for update;
    if not found or before_row.payload is distinct from p_expected_payload then
      raise exception using errcode='P0001', message='Supplier data changed. Reload and retry the save.', detail='supplier-store-cas-contention';
    end if;
    update public.office_calendar_store set payload=p_payload,updated_at=now_at
      where key='spc-supplier-overrides' returning * into after_row;
    if not found then
      raise exception using errcode='P0001', message='Supplier data was not saved.', detail = 'supplier-store-write-unconfirmed';
    end if;
  end if;
  if after_row.key is distinct from 'spc-supplier-overrides'
    or after_row.payload is distinct from p_payload then
    raise exception using errcode='P0001', message='Supplier data was not saved.', detail = 'supplier-store-write-unconfirmed';
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
    raise exception using errcode='P0001', message='Supplier audit was not saved. No changes were applied.', detail = 'supplier-store-write-unconfirmed';
  end if;
  return jsonb_build_object('schema','fcuno.supplier-store-cas/v1',
    'requestId',p_request_id,'payload',after_row.payload,'updatedAt',after_row.updated_at);
end;
$$;

create or replace function public.stem_spc_enquiry_with_fixture(
  p_enquiry_id uuid,
  p_actor_username text,
  p_expected_updated_at timestamptz,
  p_request_id uuid,
  p_supplier_username text,
  p_notes text,
  p_fixture jsonb
)
returns setof public.spc_enquiries
language plpgsql
security invoker
set search_path = ''
as $$
declare
  source_row public.spc_enquiries%rowtype;
  fixture_row public.spc_fixtures%rowtype;
  supplier_row public.spc_users%rowtype;
  buyer_row public.spc_users%rowtype;
  new_fixture_id uuid := pg_catalog.gen_random_uuid();
  headers jsonb := coalesce(nullif(current_setting('request.headers', true), ''), '{}')::jsonb;
begin
  if p_enquiry_id is null or p_expected_updated_at is null or p_request_id is null
    or nullif(btrim(p_supplier_username), '') is null then
    raise exception using errcode = '22023', message = 'The enquiry version, request id and supplier trader are required.';
  end if;
  -- The API supplies this identity from its validated session, never the body.
  if coalesce(headers->>'x-bunker-admin-user', '') <> 'spc:' || coalesce(p_actor_username, '') then
    raise exception using errcode = '42501', message = 'Forbidden';
  end if;
  -- Match the normal backup fence before acquiring any row locks.
  perform pg_catalog.pg_advisory_xact_lock_shared(730261052372033133::bigint);

  select * into source_row from public.spc_enquiries
    where id = p_enquiry_id for update;
  if not found or lower(source_row.created_by_username) <> lower(btrim(coalesce(p_actor_username, ''))) then
    raise exception using errcode = '42501', message = 'Forbidden';
  end if;

  if source_row.stem_request_id = p_request_id then
    if source_row.status <> 'quoted'
      or source_row.stem_source_updated_at is distinct from p_expected_updated_at
      or lower(source_row.stem_supplier_username) <> lower(btrim(p_supplier_username)) then
      raise exception using errcode = 'P0001', message = 'This STEM request no longer matches the saved enquiry. Refresh and try again.', detail = 'SPC_STEM_CONFLICT';
    end if;
    -- A committed retry is read-only. Do not reinitialize, upsert, or lock an
    -- edited/completed fixture in the reverse order of its ordinary editor.
    if not exists (select 1 from public.spc_fixtures where enquiry_id = source_row.id) then
      raise exception using errcode = 'P0001', message = 'The fixture for this STEM is no longer available. Refresh and ask an administrator to review it.', detail = 'SPC_STEM_CONFLICT';
    end if;
    return next source_row;
    return;
  end if;

  if source_row.status <> 'sent' or source_row.updated_at is distinct from p_expected_updated_at then
    raise exception using errcode = 'P0001', message = 'This enquiry changed while you were editing. Refresh and try again.', detail = 'SPC_STEM_CONFLICT';
  end if;
  select * into fixture_row from public.spc_fixtures
    where enquiry_id = source_row.id for update;
  if found then
    -- Never overwrite a pending or completed fixture from a separate/legacy
    -- operation. An administrator must reconcile such pre-existing data.
    raise exception using errcode = 'P0001', message = 'This enquiry already has a fixture. Refresh and ask an administrator to review it.', detail = 'SPC_STEM_CONFLICT';
  end if;
  if jsonb_typeof(p_fixture) is distinct from 'object'
    or nullif(btrim(p_notes), '') is null
    or p_fixture->>'enquiry_id' is distinct from source_row.id::text
    or p_fixture->>'fixture_status' is distinct from 'pending'
    or lower(coalesce(p_fixture->>'supplier_trader_username', '')) <> lower(btrim(p_supplier_username))
    or lower(coalesce(p_fixture->>'buyer_trader_username', '')) <> lower(source_row.created_by_username) then
    raise exception using errcode = '22023', message = 'Invalid SPC STEM fixture details.';
  end if;

  -- SHARE, rather than KEY SHARE, holds is_active/name stable until commit.
  -- Office and custom supplier designation are the server directory snapshot;
  -- this operation does not grant any new page permission to the assignee.
  select * into buyer_row from public.spc_users
    where id = nullif(p_fixture->>'buyer_trader_user_id', '')::uuid
      and lower(username) = lower(source_row.created_by_username) and is_active
      and id::text = headers->>'x-bunker-audit-actor-user-id'
    for share;
  if not found then
    raise exception using errcode = '42501', message = 'The enquiry owner is no longer an active user.';
  end if;
  select * into supplier_row from public.spc_users
    where id = nullif(p_fixture->>'supplier_trader_user_id', '')::uuid
      and lower(username) = lower(btrim(p_supplier_username)) and is_active
    for share;
  if not found then
    raise exception using errcode = '22023', message = 'Select a valid supplier trader.';
  end if;

  update public.spc_enquiries
    set status = 'quoted', notes = p_notes, updated_at = clock_timestamp(),
      stem_request_id = p_request_id, stem_source_updated_at = p_expected_updated_at,
      stem_supplier_username = supplier_row.username
    where id = source_row.id returning * into source_row;
  if not found or source_row.id is distinct from p_enquiry_id or source_row.status is distinct from 'quoted'
    or source_row.stem_request_id is distinct from p_request_id
    or source_row.stem_source_updated_at is distinct from p_expected_updated_at
    or source_row.stem_supplier_username is distinct from supplier_row.username
    or lower(source_row.created_by_username) is distinct from lower(buyer_row.username)
    or source_row.notes is distinct from p_notes then
    raise exception using errcode = 'P0001', message = 'The STEM enquiry was not saved. Refresh and review before trying again.', detail = 'SPC_STEM_UNCONFIRMED';
  end if;

  insert into public.spc_fixtures (
    id, enquiry_id, fixture_status, fixture_date,
    supplier_trader_user_id, supplier_trader_username, supplier_trader_display_name,
    buyer_trader_user_id, buyer_trader_username, buyer_trader_display_name,
    account, earliest_eta, vessel_name, vessel_imo, hsfo, vlsfo, lsmgo,
    supplier_name, supplier_key, price, barging
  ) values (
    new_fixture_id, source_row.id, 'pending', (p_fixture->>'fixture_date')::date,
    supplier_row.id, supplier_row.username, coalesce(nullif(btrim(supplier_row.display_name), ''), supplier_row.username),
    buyer_row.id, buyer_row.username, coalesce(nullif(btrim(buyer_row.display_name), ''), buyer_row.username),
    nullif(btrim(p_fixture->>'account'), ''), nullif(btrim(p_fixture->>'earliest_eta'), ''),
    nullif(btrim(p_fixture->>'vessel_name'), ''), nullif(btrim(p_fixture->>'vessel_imo'), ''),
    nullif(btrim(p_fixture->>'hsfo'), ''), nullif(btrim(p_fixture->>'vlsfo'), ''), nullif(btrim(p_fixture->>'lsmgo'), ''),
    nullif(btrim(p_fixture->>'supplier_name'), ''), nullif(btrim(p_fixture->>'supplier_key'), ''),
    nullif(btrim(p_fixture->>'price'), ''), nullif(btrim(p_fixture->>'barging'), '')
  ) returning * into fixture_row;
  if not found or fixture_row.id is distinct from new_fixture_id
    or fixture_row.enquiry_id is distinct from p_enquiry_id or fixture_row.fixture_status is distinct from 'pending'
    or fixture_row.supplier_trader_user_id is distinct from supplier_row.id
    or fixture_row.buyer_trader_user_id is distinct from buyer_row.id then
    raise exception using errcode = 'P0001', message = 'The STEM fixture was not created. Your enquiry was not changed. Refresh and try again.', detail = 'SPC_STEM_UNCONFIRMED';
  end if;

  return next source_row;
end;
$$;

create or replace function public.update_spc_fixture_with_enquiry(
  p_fixture_id uuid,
  p_actor_username text,
  p_expected_updated_at timestamptz,
  p_expected_status text,
  p_action text,
  p_fixture jsonb,
  p_primary_supplier text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  source_id uuid;
  source_row public.spc_enquiries%rowtype;
  fixture_row public.spc_fixtures%rowtype;
  actor_row public.spc_users%rowtype;
  trader_row public.spc_users%rowtype;
  headers jsonb := coalesce(nullif(current_setting('request.headers', true), ''), '{}')::jsonb;
  now_at timestamptz := clock_timestamp();
begin
  if p_fixture_id is null or p_expected_updated_at is null
    or p_expected_status not in ('pending','completed','cancelled') or p_expected_status is null
    or p_action not in ('save','complete','delete') or p_action is null
    or (p_action <> 'delete' and jsonb_typeof(p_fixture) is distinct from 'object') then
    raise exception using errcode = '22023', message = 'Refresh this page before saving the fixture.';
  end if;
  if coalesce(headers->>'x-bunker-admin-user','') <> 'spc:' || coalesce(p_actor_username,'') then
    raise exception using errcode = '42501', message = 'Forbidden';
  end if;
  perform pg_catalog.pg_advisory_xact_lock_shared(730261052372033133::bigint);

  -- Discover the parent without locking the child first. STEM and every edit
  -- acquire the source lock before its fixture, so their retries cannot deadlock.
  select enquiry_id into source_id from public.spc_fixtures where id = p_fixture_id;
  select * into source_row from public.spc_enquiries where id = source_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'This fixture is no longer available. Refresh and try again.', detail = 'SPC_FIXTURE_CONFLICT';
  end if;
  select * into fixture_row from public.spc_fixtures where id = p_fixture_id for update;
  if not found or fixture_row.enquiry_id is distinct from source_id
    or fixture_row.updated_at is distinct from p_expected_updated_at
    or fixture_row.fixture_status is distinct from p_expected_status
    or (p_action <> 'delete' and (source_row.status <> 'quoted' or fixture_row.fixture_status = 'cancelled'))
    or (p_action = 'complete' and fixture_row.fixture_status <> 'pending') then
    raise exception using errcode = 'P0001', message = 'This fixture changed while you were editing. Your draft was not saved. Refresh and review the latest fixture.', detail = 'SPC_FIXTURE_CONFLICT';
  end if;

  select * into actor_row from public.spc_users
    where lower(username) = lower(btrim(coalesce(p_actor_username,''))) and is_active
      and id::text = headers->>'x-bunker-audit-actor-user-id' for share;
  if not found then raise exception using errcode = '42501', message = 'Forbidden'; end if;
  if p_action = 'delete' then
    if fixture_row.fixture_status = 'pending' and lower(actor_row.username) <> lower(fixture_row.supplier_trader_username) then
      raise exception using errcode = '42501', message = 'Only the assigned supplier trader can edit this new stem.';
    end if;
    -- Deliberate deletion preserves the existing policy: the source enquiry,
    -- its status and its original STEM receipt are not modified or fabricated.
    delete from public.spc_fixtures where id = fixture_row.id returning * into fixture_row;
    if not found or fixture_row.id is distinct from p_fixture_id then
      raise exception using errcode = 'P0001', message = 'The fixture was not deleted. Refresh and review the latest fixture.', detail = 'SPC_FIXTURE_UNCONFIRMED';
    end if;
    return jsonb_build_object('id',fixture_row.id);
  end if;
  if fixture_row.fixture_status = 'pending' and actor_row.role not in ('supplier_trader','admin') then
    raise exception using errcode = '42501', message = 'Only supplier traders and admins can edit this new stem.';
  end if;
  -- Completed saves may retain retired traders; otherwise hold each selected
  -- directory identity/name stable until the transaction commits.
  if not (fixture_row.fixture_status = 'completed' and p_action = 'save'
    and nullif(p_fixture->>'supplier_trader_user_id','')::uuid is not distinct from fixture_row.supplier_trader_user_id
    and p_fixture->>'supplier_trader_username' is not distinct from fixture_row.supplier_trader_username
    and p_fixture->>'supplier_trader_display_name' is not distinct from fixture_row.supplier_trader_display_name) then
    select * into trader_row from public.spc_users
      where id = nullif(p_fixture->>'supplier_trader_user_id','')::uuid and is_active
        and username = p_fixture->>'supplier_trader_username' for share;
    if not found then raise exception using errcode = '22023', message = 'Select a valid supplier trader.'; end if;
    p_fixture := p_fixture || jsonb_build_object('supplier_trader_username',trader_row.username,
      'supplier_trader_display_name',coalesce(nullif(btrim(trader_row.display_name),''),trader_row.username));
  end if;
  if not (fixture_row.fixture_status = 'completed' and p_action = 'save'
    and nullif(p_fixture->>'buyer_trader_user_id','')::uuid is not distinct from fixture_row.buyer_trader_user_id
    and p_fixture->>'buyer_trader_username' is not distinct from fixture_row.buyer_trader_username
    and p_fixture->>'buyer_trader_display_name' is not distinct from fixture_row.buyer_trader_display_name) then
    select * into trader_row from public.spc_users
      where id = nullif(p_fixture->>'buyer_trader_user_id','')::uuid and is_active
        and username = p_fixture->>'buyer_trader_username' for share;
    if not found then raise exception using errcode = '22023', message = 'Select a valid buyer trader.'; end if;
    p_fixture := p_fixture || jsonb_build_object('buyer_trader_username',trader_row.username,
      'buyer_trader_display_name',coalesce(nullif(btrim(trader_row.display_name),''),trader_row.username));
  end if;

  update public.spc_fixtures set
    fixture_status = case when p_action = 'complete' then 'completed' else fixture_row.fixture_status end,
    fixture_date = (p_fixture->>'fixture_date')::date,
    supplier_trader_user_id = nullif(p_fixture->>'supplier_trader_user_id','')::uuid,
    supplier_trader_username = p_fixture->>'supplier_trader_username',
    supplier_trader_display_name = p_fixture->>'supplier_trader_display_name',
    buyer_trader_user_id = nullif(p_fixture->>'buyer_trader_user_id','')::uuid,
    buyer_trader_username = p_fixture->>'buyer_trader_username',
    buyer_trader_display_name = p_fixture->>'buyer_trader_display_name',
    account = p_fixture->>'account', commission = p_fixture->>'commission',
    earliest_eta = p_fixture->>'earliest_eta', vessel_name = p_fixture->>'vessel_name',
    hsfo = p_fixture->>'hsfo', vlsfo = p_fixture->>'vlsfo', lsmgo = p_fixture->>'lsmgo',
    supplier_name = p_fixture->>'supplier_name', supplier_key = p_fixture->>'supplier_key',
    price = p_fixture->>'price', barging = p_fixture->>'barging',
    completed_at = case when p_action = 'complete' then coalesce(fixture_row.completed_at,now_at) else fixture_row.completed_at end,
    completed_by_username = case when p_action = 'complete' then actor_row.username else fixture_row.completed_by_username end,
    completed_by_display_name = case when p_action = 'complete' then coalesce(nullif(btrim(actor_row.display_name),''),actor_row.username) else fixture_row.completed_by_display_name end,
    updated_at = now_at
    where id = fixture_row.id returning * into fixture_row;
  if not found or fixture_row.id is distinct from p_fixture_id or fixture_row.enquiry_id is distinct from source_id then
    raise exception using errcode = 'P0001', message = 'The fixture was not saved. Refresh and review the latest fixture.', detail = 'SPC_FIXTURE_UNCONFIRMED';
  end if;

  -- Preserve the existing rule: a nonblank primary supplier updates the source
  -- label; clearing fixture supplier cells does not erase the historical label.
  if nullif(btrim(p_primary_supplier),'') is not null then
    update public.spc_enquiries set supplier_name = btrim(p_primary_supplier), updated_at = now_at
      where id = source_row.id returning * into source_row;
    if not found or source_row.id is distinct from source_id then
      raise exception using errcode = 'P0001', message = 'The fixture supplier could not be synchronized. Your draft was not saved. Refresh and try again.', detail = 'SPC_FIXTURE_UNCONFIRMED';
    end if;
  end if;
  return to_jsonb(fixture_row) || jsonb_build_object('enquiry',jsonb_build_object(
    'id',source_row.id,'enquiry_number',source_row.enquiry_number,'title',source_row.title));
end;
$$;

