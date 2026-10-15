-- One durable operation per source enquiry. These are internal retry receipts,
-- not credentials or a new queue/table; existing audit and backup fences apply.
alter table public.spc_enquiries
  drop constraint if exists spc_enquiries_stem_receipt_complete;
alter table public.spc_enquiries
  add column if not exists stem_request_id uuid,
  add column if not exists stem_source_updated_at timestamptz,
  add column if not exists stem_supplier_username text;

alter table public.spc_enquiries
  add constraint spc_enquiries_stem_receipt_complete check (
    (stem_request_id is null and stem_source_updated_at is null and stem_supplier_username is null)
    or (stem_request_id is not null and stem_source_updated_at is not null
      and nullif(btrim(stem_supplier_username), '') is not null)
  );

comment on column public.spc_enquiries.stem_request_id is
  'Internal idempotency receipt for the atomic STEM enquiry-and-fixture transaction.';
comment on column public.spc_enquiries.stem_source_updated_at is
  'Exact source version accepted by the STEM operation; retained for lost-response retries.';
comment on column public.spc_enquiries.stem_supplier_username is
  'Original requested supplier for the STEM receipt; subsequent fixture edits do not alter retry identity.';

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
      raise exception using errcode = '40001', message = 'This STEM request no longer matches the saved enquiry. Refresh and try again.';
    end if;
    -- A committed retry is read-only. Do not reinitialize, upsert, or lock an
    -- edited/completed fixture in the reverse order of its ordinary editor.
    if not exists (select 1 from public.spc_fixtures where enquiry_id = source_row.id) then
      raise exception using errcode = '40001', message = 'The fixture for this STEM is no longer available. Refresh and ask an administrator to review it.';
    end if;
    return next source_row;
    return;
  end if;

  if source_row.status <> 'sent' or source_row.updated_at is distinct from p_expected_updated_at then
    raise exception using errcode = '40001', message = 'This enquiry changed while you were editing. Refresh and try again.';
  end if;
  select * into fixture_row from public.spc_fixtures
    where enquiry_id = source_row.id for update;
  if found then
    -- Never overwrite a pending or completed fixture from a separate/legacy
    -- operation. An administrator must reconcile such pre-existing data.
    raise exception using errcode = '40001', message = 'This enquiry already has a fixture. Refresh and ask an administrator to review it.';
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
    raise exception using errcode = '40001', message = 'The STEM enquiry was not saved. Refresh and review before trying again.';
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
    raise exception using errcode = '40001', message = 'The STEM fixture was not created. Your enquiry was not changed. Refresh and try again.';
  end if;

  return next source_row;
end;
$$;

revoke all on function public.stem_spc_enquiry_with_fixture(uuid,text,timestamptz,uuid,text,text,jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.stem_spc_enquiry_with_fixture(uuid,text,timestamptz,uuid,text,text,jsonb)
  to service_role;

-- Undoing just one row would split an aggregate STEM back into the same broken
-- state this transaction fixes. Existing immutable logs remain readable.
create or replace function private.block_partial_spc_stem_audit_undo()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  undo_id text := nullif(current_setting('app.audit_undo_of_log_id', true), '');
begin
  if undo_id is not null and exists (
    select 1 from public.audit_logs
      where id = undo_id::uuid and request_context->>'action' = 'set-enquiry-stem'
        and table_schema = 'public' and table_name in ('spc_enquiries', 'spc_fixtures')
  ) then
    raise exception using errcode = '23514', message = 'A STEM enquiry and fixture must be reviewed together; single-row undo is not supported.';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function private.block_partial_spc_stem_audit_undo() from public, anon, authenticated;
drop trigger if exists block_partial_spc_stem_audit_undo on public.spc_enquiries;
create trigger block_partial_spc_stem_audit_undo
  before insert or update or delete on public.spc_enquiries
  for each row execute function private.block_partial_spc_stem_audit_undo();
drop trigger if exists block_partial_spc_stem_audit_undo on public.spc_fixtures;
create trigger block_partial_spc_stem_audit_undo
  before insert or update or delete on public.spc_fixtures
  for each row execute function private.block_partial_spc_stem_audit_undo();
