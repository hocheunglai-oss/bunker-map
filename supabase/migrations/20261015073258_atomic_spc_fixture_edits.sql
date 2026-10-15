-- Save/completion and its source supplier label are one audited aggregate.
-- The browser version prevents a stale editor from reverting a completed row.
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
    raise exception using errcode = '40001', message = 'This fixture is no longer available. Refresh and try again.';
  end if;
  select * into fixture_row from public.spc_fixtures where id = p_fixture_id for update;
  if not found or fixture_row.enquiry_id is distinct from source_id
    or fixture_row.updated_at is distinct from p_expected_updated_at
    or fixture_row.fixture_status is distinct from p_expected_status
    or (p_action <> 'delete' and (source_row.status <> 'quoted' or fixture_row.fixture_status = 'cancelled'))
    or (p_action = 'complete' and fixture_row.fixture_status <> 'pending') then
    raise exception using errcode = '40001', message = 'This fixture changed while you were editing. Your draft was not saved. Refresh and review the latest fixture.';
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
      raise exception using errcode = '40001', message = 'The fixture was not deleted. Refresh and review the latest fixture.';
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
    raise exception using errcode = '40001', message = 'The fixture was not saved. Refresh and review the latest fixture.';
  end if;

  -- Preserve the existing rule: a nonblank primary supplier updates the source
  -- label; clearing fixture supplier cells does not erase the historical label.
  if nullif(btrim(p_primary_supplier),'') is not null then
    update public.spc_enquiries set supplier_name = btrim(p_primary_supplier), updated_at = now_at
      where id = source_row.id returning * into source_row;
    if not found or source_row.id is distinct from source_id then
      raise exception using errcode = '40001', message = 'The fixture supplier could not be synchronized. Your draft was not saved. Refresh and try again.';
    end if;
  end if;
  return to_jsonb(fixture_row) || jsonb_build_object('enquiry',jsonb_build_object(
    'id',source_row.id,'enquiry_number',source_row.enquiry_number,'title',source_row.title));
end;
$$;
revoke all on function public.update_spc_fixture_with_enquiry(uuid,text,timestamptz,text,text,jsonb,text)
  from public, anon, authenticated, service_role;
grant execute on function public.update_spc_fixture_with_enquiry(uuid,text,timestamptz,text,text,jsonb,text) to service_role;

-- A single-row undo must not recreate the same source/fixture inconsistency.
create or replace function private.block_partial_spc_stem_audit_undo()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare undo_id text := nullif(current_setting('app.audit_undo_of_log_id', true), '');
begin
  if undo_id is not null and exists (
    select 1 from public.audit_logs where id = undo_id::uuid
      and request_context->>'action' in ('set-enquiry-stem','save-fixture','complete-fixture')
      and table_schema = 'public' and table_name in ('spc_enquiries','spc_fixtures')
  ) then
    raise exception using errcode = '23514', message = 'A STEM enquiry and fixture must be reviewed together; single-row undo is not supported.';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function private.block_partial_spc_stem_audit_undo() from public, anon, authenticated;
