-- The address book owns bound template recipients. Only an actual source
-- DELETE removes a binding; an UPDATE retains its kind/id and waits for a new
-- certified projection. Missing projection data is never deletion authority.
set local lock_timeout = '3s';

-- A newer certification may commit before its derived template batch. Reject
-- that ordinary stale-envelope condition once, not PostgREST's 40001 retry.
create or replace function private.enforce_outlook_template_truth_write()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
  expected_run_id text := current_setting(
    'app.outlook_template_expected_run_id',
    true
  );
  expected_certified_at text := current_setting(
    'app.outlook_template_expected_certified_at',
    true
  );
  expected_fingerprint text := current_setting(
    'app.outlook_template_expected_fingerprint',
    true
  );
begin
  if not public.is_valid_outlook_template_recipient_resolution(
    new.recipient_resolution
  ) then
    raise exception
      'OUTLOOK_TEMPLATE_RECIPIENT_EVIDENCE_INVALID: recipient evidence is malformed.'
      using errcode = '23514';
  end if;

  if coalesce(
    (new.recipient_resolution ->> 'reconciliationRequired')::boolean,
    false
  ) then
    raise exception
      'OUTLOOK_TEMPLATE_RECONCILIATION_REQUIRED: reconcile this template before it can be written.'
      using errcode = '55000';
  end if;

  if expected_run_id is null
    or new.recipient_resolution ->> 'certificationRunId'
      is distinct from expected_run_id
    or expected_certified_at is null
    or (new.recipient_resolution ->> 'certifiedAt')::timestamptz
      is distinct from expected_certified_at::timestamptz
    or expected_fingerprint is null
    or lower(new.recipient_resolution ->> 'sourceFingerprint')
      is distinct from expected_fingerprint
  then
    raise exception
      'OUTLOOK_TEMPLATE_RECIPIENT_EVIDENCE_STALE: resolve recipients against the latest settled Exchange certification.'
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

create index if not exists audit_outlook_source_identity_time_idx
  on public.audit_logs(table_name, (record_pk ->> 'id'), occurred_at)
  where table_schema = 'public'
    and table_name in ('shared_addressbook_contacts', 'shared_addressbook_groups');
create index if not exists audit_outlook_membership_after_time_idx
  on public.audit_logs((record_pk ->> 'group_id'), occurred_at)
  where table_schema = 'public' and table_name = 'shared_addressbook_group_members';
create index if not exists audit_outlook_membership_before_time_idx
  on public.audit_logs((before_row ->> 'group_id'), occurred_at)
  where table_schema = 'public' and table_name = 'shared_addressbook_group_members';
create index if not exists outlook_membership_contact_group_idx
  on public.shared_addressbook_group_members(contact_id,group_id);

create or replace function private.outlook_template_split_recipient_text(p_text text)
returns text[] language plpgsql immutable security invoker set search_path = ''
as $$
declare
  input_text text := pg_catalog.regexp_replace(coalesce(p_text, ''), E'\\r?\\n', ' ', 'g');
  parts text[] := array[]::text[];
  part text := '';
  quoted boolean := false;
  depth integer := 0;
  character text;
  position integer;
  before_position integer;
  slashes integer;
begin
  for position in 1..pg_catalog.length(input_text) loop
    character := pg_catalog.substr(input_text, position, 1);
    if character = '"' then
      before_position := position - 1;
      slashes := 0;
      while before_position > 0 and pg_catalog.substr(input_text,before_position,1) = E'\\' loop
        slashes := slashes + 1;
        before_position := before_position - 1;
      end loop;
      if slashes % 2 = 0 then quoted := not quoted; end if;
    end if;
    if not quoted and character = '<' then depth := depth + 1; end if;
    if not quoted and character = '>' and depth > 0 then depth := depth - 1; end if;
    if not quoted and depth = 0 and character in (',', ';') then
      if pg_catalog.btrim(part) <> '' then parts := pg_catalog.array_append(parts, pg_catalog.btrim(part)); end if;
      part := '';
    else
      part := part || character;
    end if;
  end loop;
  if pg_catalog.btrim(part) <> '' then parts := pg_catalog.array_append(parts, pg_catalog.btrim(part)); end if;
  return parts;
end;
$$;

create or replace function private.outlook_template_recount_resolution(p_resolution jsonb, p_refs jsonb)
returns jsonb language sql immutable security invoker set search_path = ''
as $$
  select p_resolution || pg_catalog.jsonb_build_object(
    'refs', p_refs,
    'counts', pg_catalog.jsonb_build_object(
      'total', count(*),
      'resolved', count(*) filter (where ref ->> 'status' = 'resolved'),
      'external', count(*) filter (where ref ->> 'status' = 'external'),
      'ambiguous', count(*) filter (where ref ->> 'status' = 'ambiguous'),
      'missing', count(*) filter (where ref ->> 'status' = 'missing')
    )
  ) from pg_catalog.jsonb_each(p_refs) fields,
    lateral pg_catalog.jsonb_array_elements(fields.value) recipients(ref);
$$;

create or replace function private.outlook_template_source_change(
  p_template public.email_templates,
  p_kind text,
  p_source_id text,
  p_source jsonb,
  p_membership_only boolean default false
)
returns jsonb language plpgsql immutable security invoker set search_path = ''
as $$
declare
  field_name text;
  source_text text;
  tokens text[];
  output_tokens text[];
  refs jsonb := p_template.recipient_resolution -> 'refs';
  output_refs jsonb;
  ref jsonb;
  position integer;
  name text;
  address text;
  literal text;
  changed boolean := false;
  output jsonb := pg_catalog.jsonb_build_object(
    'to_recipients', p_template.to_recipients,
    'cc_recipients', p_template.cc_recipients,
    'bcc_recipients', p_template.bcc_recipients
  );
begin
  if p_kind not in ('contact', 'group') or nullif(p_source_id, '') is null then
    raise exception 'OUTLOOK_TEMPLATE_SOURCE_INVALID' using errcode = '22023';
  end if;
  foreach field_name in array array['to', 'cc', 'bcc'] loop
    source_text := pg_catalog.to_jsonb(p_template) ->> (field_name || '_recipients');
    tokens := private.outlook_template_split_recipient_text(source_text);
    output_tokens := array[]::text[];
    output_refs := '[]'::jsonb;
    if pg_catalog.cardinality(tokens) <> pg_catalog.jsonb_array_length(refs -> field_name) then
      raise exception 'OUTLOOK_TEMPLATE_BINDING_MISMATCH: recipient text must match its stored identities.' using errcode = '23514';
    end if;
    for position in 1..pg_catalog.cardinality(tokens) loop
      ref := refs -> field_name -> (position - 1);
      if ref ->> 'field' is distinct from field_name
        or (ref ->> 'position')::integer is distinct from position - 1
        or ref ->> 'literal' is distinct from tokens[position]
      then
        raise exception 'OUTLOOK_TEMPLATE_BINDING_MISMATCH: recipient text must match its stored identities.' using errcode = '23514';
      end if;
      if ref ->> 'kind' = p_kind and ref ->> 'sourceId' = p_source_id then
        changed := true;
        -- A membership change never deletes or renames the group recipient.
        if p_source is null and not p_membership_only then continue; end if;
        if not p_membership_only then
          name := pg_catalog.btrim(pg_catalog.regexp_replace(coalesce(
            p_source ->> case when p_kind = 'contact' then 'display_name' else 'name' end, ''
          ), '[[:space:]]+', ' ', 'g'));
          address := pg_catalog.lower(pg_catalog.btrim(coalesce(p_source ->> 'primary_email', '')));
          literal := '"' || pg_catalog.replace(pg_catalog.replace(name, E'\\', E'\\\\'), '"', E'\\"') || '"';
          if p_kind = 'contact' then literal := literal || ' <' || address || '>'; end if;
          ref := ref || pg_catalog.jsonb_build_object(
            'literal', literal, 'displayName', name,
            'sourceValue', case when p_kind = 'contact' then address else name end
          );
        end if;
        ref := ref || pg_catalog.jsonb_build_object('status', 'missing', 'resolvedAddress', null);
      end if;
      ref := ref || pg_catalog.jsonb_build_object('position', pg_catalog.cardinality(output_tokens));
      output_tokens := pg_catalog.array_append(output_tokens, ref ->> 'literal');
      output_refs := output_refs || pg_catalog.jsonb_build_array(ref);
    end loop;
    refs := pg_catalog.jsonb_set(refs, array[field_name], output_refs);
    -- Untouched fields retain their exact original formatting.
    if output_refs is distinct from p_template.recipient_resolution #> array['refs', field_name] then
      output := output || pg_catalog.jsonb_build_object(field_name || '_recipients', pg_catalog.array_to_string(output_tokens, '; '));
    end if;
  end loop;
  if not changed then return null; end if;
  return output || pg_catalog.jsonb_build_object('recipient_resolution', private.outlook_template_recount_resolution(p_template.recipient_resolution, refs));
end;
$$;

create or replace function private.outlook_template_source_changes(p_template public.email_templates, p_changes jsonb)
returns jsonb language plpgsql immutable security invoker set search_path = ''
as $$
declare change jsonb; value jsonb; result jsonb;
begin
  for change in select * from pg_catalog.jsonb_array_elements(p_changes) loop
    value := private.outlook_template_source_change(p_template, change ->> 'kind', change ->> 'id',
      nullif(change -> 'source', 'null'::jsonb), coalesce((change ->> 'membershipOnly')::boolean, false));
    if value is not null then
      result := coalesce(result, '{}'::jsonb) || value;
      p_template := pg_catalog.jsonb_populate_record(p_template, value);
    end if;
  end loop;
  return result;
end;
$$;

create or replace function private.apply_outlook_template_source_changes(p_changes jsonb)
returns bigint language plpgsql volatile security invoker set search_path = ''
set lock_timeout = '2s'
as $$
declare affected bigint;
begin
  -- Existing source audit and queue triggers have already acquired their own
  -- ledger lock. Never add a reversed canonical->ledger acquisition here.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('email_templates_canonical_write', 0));
  with changed as materialized (
    select template.id, private.outlook_template_source_changes(template, p_changes) as value
    from public.email_templates template
    where exists (select 1 from pg_catalog.jsonb_array_elements(p_changes) changes(change)
      where pg_catalog.jsonb_path_exists(template.recipient_resolution,
        '$.refs.*[*] ? (@.kind == $kind && @.sourceId == $id)',
        pg_catalog.jsonb_build_object('kind', change ->> 'kind', 'id', change ->> 'id')))
  )
  update public.email_templates template
  set to_recipients = changed.value ->> 'to_recipients',
      cc_recipients = changed.value ->> 'cc_recipients',
      bcc_recipients = changed.value ->> 'bcc_recipients',
      recipient_resolution = changed.value -> 'recipient_resolution'
  from changed
  where template.id = changed.id and changed.value is not null
    and (template.to_recipients, template.cc_recipients, template.bcc_recipients, template.recipient_resolution)
      is distinct from (changed.value ->> 'to_recipients', changed.value ->> 'cc_recipients', changed.value ->> 'bcc_recipients', changed.value -> 'recipient_resolution');
  get diagnostics affected = row_count;
  return affected;
end;
$$;

create or replace function private.apply_outlook_template_source_change(
  p_kind text, p_source_id text, p_source jsonb, p_membership_only boolean default false
)
returns bigint language sql volatile security invoker set search_path = ''
as $$
  select private.apply_outlook_template_source_changes(pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
    'kind', p_kind, 'id', p_source_id, 'source', p_source, 'membershipOnly', p_membership_only)));
$$;

create or replace function private.propagate_outlook_template_source_change()
returns trigger language plpgsql volatile security definer set search_path = pg_catalog, pg_temp
as $$
declare
  kind text;
  source_id text;
  group_id text;
  changes jsonb;
begin
  if tg_table_schema <> 'public' or tg_when <> 'AFTER' or tg_level <> 'ROW'
    or tg_op not in ('UPDATE', 'DELETE', 'INSERT')
  then raise exception 'OUTLOOK_TEMPLATE_SOURCE_TRIGGER_REQUIRED'; end if;
  if tg_table_name = 'shared_addressbook_group_members' then
    if tg_op = 'UPDATE' and (new.group_id, new.contact_id, new.source_book)
      is not distinct from (old.group_id, old.contact_id, old.source_book) then return new; end if;
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('kind','group','id',id,'membershipOnly',true) order by id), '[]'::jsonb)
    into changes from (select distinct id from (values
      (case when tg_op in ('UPDATE','DELETE') then old.group_id end),
      (case when tg_op in ('UPDATE','INSERT') then new.group_id end)
    ) groups(id) where id is not null
      -- A cascading group DELETE is handled only by its group DELETE trigger.
      and exists (select 1 from public.shared_addressbook_groups g where g.id = groups.id)) affected;
    perform private.apply_outlook_template_source_changes(changes);
  elsif tg_table_name in ('shared_addressbook_contacts', 'shared_addressbook_groups') then
    if tg_op = 'INSERT' then return new; end if;
    if tg_op = 'UPDATE' and new.id is distinct from old.id then
      raise exception 'OUTLOOK_SOURCE_ID_IMMUTABLE: create a separate source identity instead.' using errcode = '22023';
    end if;
    kind := case when tg_table_name = 'shared_addressbook_contacts' then 'contact' else 'group' end;
    source_id := old.id;
    if tg_op = 'UPDATE' then
      if kind = 'contact' then
        if (new.display_name, new.primary_email) is not distinct from (old.display_name, old.primary_email) then return new; end if;
      else
        if (new.name, new.nickname) is not distinct from (old.name, old.nickname) then return new; end if;
      end if;
    end if;
    changes := pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('kind', kind, 'id', source_id,
      'source', case when tg_op = 'DELETE' then null else pg_catalog.to_jsonb(new) end));
    if kind = 'contact' and tg_op = 'UPDATE' then
      -- The same group address could still expand to an old member address.
      -- Fold every exact-ID dependent group into this ONE template UPDATE.
      select changes || coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'kind','group','id',members.group_id,'membershipOnly',true) order by members.group_id), '[]'::jsonb)
      into changes from public.shared_addressbook_group_members members where members.contact_id = source_id;
    end if;
    perform private.apply_outlook_template_source_changes(changes);
  else raise exception 'OUTLOOK_TEMPLATE_SOURCE_TRIGGER_REQUIRED'; end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

-- A stale certified map cannot revive an old address after a source change.
-- Audit events are actual, immutable source mutations, not map absence.
create or replace function private.outlook_template_source_is_pending(p_kind text, p_id text, p_run_id uuid)
returns boolean language sql stable security invoker set search_path = ''
as $$
  with certification as (
    select ledger_sequence from public.outlook_exchange_truth_ledger
    where event_type = 'full_certification' and run_id = p_run_id
  )
  select not exists (select 1 from certification) or case when p_kind = 'contact' then
    not exists (select 1 from public.shared_addressbook_contacts where id = p_id)
    or exists (select 1 from public.audit_logs a where a.table_schema = 'public'
      and a.table_name = 'shared_addressbook_contacts' and a.record_pk ->> 'id' = p_id
      and exists (select 1 from public.outlook_exchange_truth_ledger l, certification c
        where l.audit_log_id = a.id and l.event_type = 'source_change' and l.ledger_sequence > c.ledger_sequence)
      and (a.operation in ('INSERT','DELETE')
        or (a.operation = 'UPDATE' and a.changed_fields && array['display_name','primary_email']::text[])))
  when p_kind = 'group' then
    not exists (select 1 from public.shared_addressbook_groups where id = p_id)
    or exists (select 1 from public.audit_logs a where a.table_schema = 'public'
      and exists (select 1 from public.outlook_exchange_truth_ledger l, certification c
        where l.audit_log_id = a.id and l.event_type = 'source_change' and l.ledger_sequence > c.ledger_sequence)
      and (
        (a.table_name = 'shared_addressbook_groups' and a.record_pk ->> 'id' = p_id
          and (a.operation in ('INSERT','DELETE') or (a.operation = 'UPDATE' and a.changed_fields && array['name','nickname']::text[])))
        or (a.table_name = 'shared_addressbook_group_members'
          and (a.record_pk ->> 'group_id' = p_id or a.before_row ->> 'group_id' = p_id)
          and (a.operation in ('INSERT','DELETE') or (a.operation = 'UPDATE' and a.changed_fields && array['group_id','contact_id','source_book']::text[])))
      ))
    or exists (select 1 from public.shared_addressbook_group_members m
      join public.audit_logs a on a.table_schema='public' and a.table_name='shared_addressbook_contacts' and a.record_pk ->> 'id'=m.contact_id
      join public.outlook_exchange_truth_ledger l on l.audit_log_id=a.id and l.event_type='source_change'
      join certification c on l.ledger_sequence > c.ledger_sequence
      where m.group_id=p_id and (a.operation in ('INSERT','DELETE')
        or (a.operation='UPDATE' and a.changed_fields && array['display_name','primary_email']::text[])))
  else false end;
$$;

create or replace function private.outlook_template_resolution_has_pending_source(p_resolution jsonb)
returns boolean language sql stable security invoker set search_path = ''
as $$
  select exists (select 1 from pg_catalog.jsonb_each(p_resolution -> 'refs') fields,
    lateral pg_catalog.jsonb_array_elements(fields.value) recipients(ref)
    where ref ->> 'kind' in ('contact','group')
      and private.outlook_template_source_is_pending(ref ->> 'kind', ref ->> 'sourceId', (p_resolution ->> 'certificationRunId')::uuid));
$$;

create or replace function private.enforce_outlook_template_source_currentness()
returns trigger language plpgsql security definer set search_path = pg_catalog, pg_temp
as $$
declare ref jsonb;
begin
  for ref in select item from pg_catalog.jsonb_each(new.recipient_resolution -> 'refs') fields,
    lateral pg_catalog.jsonb_array_elements(fields.value) recipients(item) loop
    if ref ->> 'status' = 'resolved' and ref ->> 'kind' in ('contact','group')
      and private.outlook_template_source_is_pending(ref ->> 'kind', ref ->> 'sourceId', (new.recipient_resolution ->> 'certificationRunId')::uuid)
    then
      raise exception 'OUTLOOK_TEMPLATE_SOURCE_SYNC_PENDING: a recipient was updated and is awaiting address-book synchronization.' using errcode = 'P0001';
    end if;
  end loop;
  return new;
end;
$$;

-- Retrospective removal is separately callable only by the server, and only
-- with real DELETE audit proof plus current absence. Re-created IDs survive.
create or replace function public.prune_deleted_outlook_template_source(p_kind text, p_source_id text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp
set lock_timeout = '2s'
as $$
declare
  source_table text;
  affected bigint;
  proof_audit_id uuid;
  old_actor_id text := current_setting('app.audit_actor_id',true);
  old_actor_name text := current_setting('app.audit_actor_name',true);
  old_context text := current_setting('app.audit_context',true);
begin
  if p_kind not in ('contact','group') or nullif(pg_catalog.btrim(p_source_id), '') is null then raise exception 'OUTLOOK_TEMPLATE_SOURCE_INVALID' using errcode = '22023'; end if;
  source_table := case when p_kind = 'contact' then 'shared_addressbook_contacts' else 'shared_addressbook_groups' end;
  -- Rare retrospective repairs freeze source mutation before entering the
  -- existing queue/ledger/canonical lock path. NOWAIT never waits while holding
  -- a ledger lock and never races a same-ID re-creation in this source table.
  if p_kind = 'contact' then
    lock table public.shared_addressbook_contacts in share row exclusive mode nowait;
  else
    lock table public.shared_addressbook_groups in share row exclusive mode nowait;
  end if;
  -- Match the source writers' ledger->canonical order, then take a fresh
  -- snapshot. A committed same-ID re-creation is not deletion authority.
  perform pg_catalog.pg_advisory_xact_lock(913047563612485921::bigint);
  if (p_kind = 'contact' and exists (select 1 from public.shared_addressbook_contacts where id = p_source_id))
    or (p_kind = 'group' and exists (select 1 from public.shared_addressbook_groups where id = p_source_id))
  then raise exception 'OUTLOOK_TEMPLATE_DELETE_NOT_PROVEN' using errcode = 'P0001'; end if;
  select a.id into proof_audit_id from public.audit_logs a
  join public.outlook_exchange_truth_ledger l on l.audit_log_id=a.id and l.event_type='source_change'
  where a.table_schema='public' and a.table_name=source_table and a.operation='DELETE'
    and a.record_pk ->> 'id'=p_source_id and a.before_row ->> 'id'=p_source_id and a.after_row is null
  order by l.ledger_sequence desc limit 1;
  if proof_audit_id is null then raise exception 'OUTLOOK_TEMPLATE_DELETE_NOT_PROVEN' using errcode = 'P0001'; end if;
  -- Never forge an original user's identity during a later repair.
  perform pg_catalog.set_config('app.audit_actor_id', 'system:outlook-source-deletion-policy', true);
  perform pg_catalog.set_config('app.audit_actor_name', 'Address-book deletion policy', true);
  perform pg_catalog.set_config('app.audit_context', pg_catalog.jsonb_build_object(
    'policy','outlook-source-deletion','sourceKind',p_kind,'sourceId',p_source_id,'sourceDeleteAuditLogId',proof_audit_id)::text, true);
  affected := private.apply_outlook_template_source_change(p_kind, p_source_id, null);
  perform pg_catalog.set_config('app.audit_actor_id',coalesce(old_actor_id,''),true);
  perform pg_catalog.set_config('app.audit_actor_name',coalesce(old_actor_name,''),true);
  perform pg_catalog.set_config('app.audit_context',coalesce(old_context,''),true);
  return pg_catalog.jsonb_build_object('updated', affected);
end;
$$;

revoke all on function private.outlook_template_split_recipient_text(text),
  private.outlook_template_recount_resolution(jsonb,jsonb),
  private.outlook_template_source_change(public.email_templates,text,text,jsonb,boolean),
  private.outlook_template_source_changes(public.email_templates,jsonb),
  private.apply_outlook_template_source_changes(jsonb),
  private.apply_outlook_template_source_change(text,text,jsonb,boolean),
  private.propagate_outlook_template_source_change(),
  private.outlook_template_source_is_pending(text,text,uuid),
  private.outlook_template_resolution_has_pending_source(jsonb),
  private.enforce_outlook_template_source_currentness(),
  public.prune_deleted_outlook_template_source(text,text)
from public, anon, authenticated, service_role;
grant execute on function public.prune_deleted_outlook_template_source(text,text) to service_role;
-- Reservation is deliberately SECURITY INVOKER. These read-only predicates
-- use only source/audit/ledger rows already readable by the server role.
grant execute on function private.outlook_template_source_is_pending(text,text,uuid),
  private.outlook_template_resolution_has_pending_source(jsonb) to service_role;

create trigger zz_propagate_outlook_template_contact
after update or delete on public.shared_addressbook_contacts
for each row execute function private.propagate_outlook_template_source_change();
create trigger zz_propagate_outlook_template_group
after update or delete on public.shared_addressbook_groups
for each row execute function private.propagate_outlook_template_source_change();
create trigger zz_propagate_outlook_template_membership
after insert or update or delete on public.shared_addressbook_group_members
for each row execute function private.propagate_outlook_template_source_change();
create trigger zz_enforce_outlook_template_source_currentness
before insert or update on public.email_templates
for each row execute function private.enforce_outlook_template_source_currentness();

-- Keep every bounded PR90 reservation gate, and additionally reject an exact
-- bound source changed after this certification. No global validity relaxation.
create or replace function public.reserve_outlook_template_insertion(
  p_operation_id uuid,
  p_template_id text,
  p_template_revision bigint,
  p_certification_run_id uuid,
  p_source_fingerprint text,
  p_actor_id text,
  p_actor_name text,
  p_certification_max_age_seconds integer
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = pg_catalog, pg_temp
set statement_timeout = '20s'
set lock_timeout = '2s'
as $$
declare
  normalized_template_id text := pg_catalog.btrim(p_template_id);
  normalized_fingerprint text := pg_catalog.lower(
    pg_catalog.btrim(p_source_fingerprint)
  );
  normalized_actor_id text := pg_catalog.btrim(p_actor_id);
  normalized_actor_name text := coalesce(
    nullif(pg_catalog.btrim(p_actor_name), ''),
    normalized_actor_id
  );
  reservation_record record;
  template_record record;
  template_truth jsonb;
  exchange_truth jsonb;
  queue_state jsonb;
  event_time timestamptz;
  latest_certified_at timestamptz;
  inserted_audit_log_id uuid;
  reservation_is_idempotent boolean := false;
  reservation_ttl_seconds constant integer := 120;
begin
  if p_operation_id is null
    or p_operation_id::text
      !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or nullif(normalized_template_id, '') is null
    or pg_catalog.length(normalized_template_id) > 256
    or p_template_revision is null
    or p_template_revision < 1
    or p_template_revision > 2147483647
    or p_certification_run_id is null
    or p_certification_run_id::text
      !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or coalesce(normalized_fingerprint, '') !~ '^[0-9a-f]{64}$'
    or nullif(normalized_actor_id, '') is null
    or pg_catalog.length(normalized_actor_id) > 256
    or pg_catalog.length(normalized_actor_name) > 256
    or p_certification_max_age_seconds is null
    or p_certification_max_age_seconds < 120
    or p_certification_max_age_seconds > 604800
  then
    raise exception
      'OUTLOOK_INSERTION_RESERVATION_INVALID: reservation input is malformed.'
      using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'outlook_template_insertion_operation:' || p_operation_id::text,
      0
    )
  );

  select logs.*
  into reservation_record
  from public.audit_logs as logs
  where logs.table_schema = 'app'
    and logs.table_name = 'outlook_template_insertion_attempts'
    and logs.operation = 'INSERT'
    and logs.record_pk ->> 'operationId' = p_operation_id::text
    and logs.record_pk ->> 'phase' = 'reserved'
  limit 1;

  if found then
    if reservation_record.actor_id is not distinct from normalized_actor_id
      and reservation_record.record_pk ->> 'templateId'
        is not distinct from normalized_template_id
      and reservation_record.record_pk ->> 'templateRevision'
        is not distinct from p_template_revision::text
      and reservation_record.after_row ->> 'schema'
        is not distinct from 'fcuno.outlook-template-insertion-audit/v2'
      and reservation_record.after_row ->> 'phase'
        is not distinct from 'reserved'
      and reservation_record.after_row ->> 'operationId'
        is not distinct from p_operation_id::text
      and reservation_record.after_row ->> 'templateId'
        is not distinct from normalized_template_id
      and reservation_record.after_row ->> 'templateRevision'
        is not distinct from p_template_revision::text
      and reservation_record.after_row ->> 'certificationRunId'
        is not distinct from p_certification_run_id::text
      and reservation_record.after_row ->> 'sourceFingerprint'
        is not distinct from normalized_fingerprint
      and pg_catalog.jsonb_typeof(
        reservation_record.after_row -> 'templateTitle'
      ) is not distinct from 'string'
      and nullif(
        pg_catalog.btrim(
          reservation_record.after_row ->> 'templateTitle'
        ),
        ''
      ) is not null
    then
      reservation_is_idempotent := true;
    else
      raise exception
        'OUTLOOK_INSERTION_OPERATION_CONFLICT: operation identifier is already reserved for different evidence.'
        using errcode = '23505';
    end if;
  end if;

  if reservation_is_idempotent
    and exists (
      select 1
      from public.audit_logs as logs
      where logs.table_schema = 'app'
        and logs.table_name = 'outlook_template_insertion_attempts'
        and logs.operation = 'INSERT'
        and logs.record_pk ->> 'operationId' = p_operation_id::text
        and logs.record_pk ->> 'phase' = 'terminal'
    )
  then
    raise exception
      'OUTLOOK_INSERTION_OPERATION_COMPLETED: completed insertion operations cannot be reserved again.'
      using errcode = '23505';
  end if;

  if not reservation_is_idempotent and exists (
    select 1
    from public.audit_logs as logs
    where logs.table_schema = 'app'
      and logs.table_name = 'outlook_template_insertion_attempts'
      and logs.operation = 'INSERT'
      and logs.record_pk ->> 'operationId' = p_operation_id::text
  ) then
    raise exception
      'OUTLOOK_INSERTION_OPERATION_CONFLICT: operation identifier is already used by another insertion event.'
      using errcode = '23505';
  end if;

  -- Every Exchange truth writer acquires this transaction lock before commit.
  -- This VOLATILE function takes a fresh snapshot for each internal query, so
  -- validation after a lock wait observes the writer that just committed.
  perform pg_catalog.pg_advisory_xact_lock(
    913047563612485921::bigint
  );

  -- Canonical template writes and certification reconciliation use this same
  -- lock. The row lock additionally covers a direct concurrent UPDATE/DELETE.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('email_templates_canonical_write', 0)
  );

  select template.*
  into template_record
  from public.email_templates as template
  where template.id = normalized_template_id
  for share;

  if not found
    or template_record.is_active is not true
    or nullif(pg_catalog.btrim(template_record.title), '') is null
    or pg_catalog.length(template_record.title) > 512
    or template_record.revision is distinct from p_template_revision
    or not public.is_valid_outlook_template_recipient_resolution(
      template_record.recipient_resolution
    )
    or coalesce(
      (template_record.recipient_resolution ->> 'reconciliationRequired')::boolean,
      false
    ) is not false
    or template_record.recipient_resolution ->> 'certificationRunId'
      is distinct from p_certification_run_id::text
    or pg_catalog.lower(
      template_record.recipient_resolution ->> 'sourceFingerprint'
    ) is distinct from normalized_fingerprint
    or private.outlook_template_resolution_has_pending_source(
      template_record.recipient_resolution
    )
    or coalesce(
      template_record.recipient_resolution #>> '{counts,ambiguous}',
      ''
    ) is distinct from '0'
    or coalesce(
      template_record.recipient_resolution #>> '{counts,missing}',
      ''
    ) is distinct from '0'
    or (
      reservation_is_idempotent
      and reservation_record.after_row ->> 'templateTitle'
        is distinct from template_record.title
    )
  then
    raise exception
      'OUTLOOK_INSERTION_TEMPLATE_CHANGED: template revision or recipient evidence is no longer insertable.'
      -- This is a business rejection, not a serialization failure. PostgREST
      -- retries SQLSTATE 40001 transactions, which cannot repair this evidence.
      using errcode = 'P0001';
  end if;

  template_truth := public.verify_outlook_template_recipient_truth();
  -- This exact proof was computed above inside the same locked transaction.
  -- Missing/invalid proof still fails every unchanged explicit gate below.
  exchange_truth := template_truth -> 'exchangeTruth';
  queue_state := coalesce(exchange_truth -> 'queue', '{}'::jsonb);
  event_time := pg_catalog.clock_timestamp();

  begin
    latest_certified_at := nullif(
      exchange_truth ->> 'latestCertificationAt',
      ''
    )::timestamptz;
  exception
    when others then
      latest_certified_at := null;
  end;

  if template_truth ->> 'sourceTruthValid' is distinct from 'true'
    or coalesce(
      template_truth #>> '{templates,unresolved}',
      ''
    ) is distinct from '0'
    or coalesce(
      template_truth #>> '{templates,stale}',
      ''
    ) is distinct from '0'
    or coalesce(
      template_truth #>> '{templates,invalidShape}',
      ''
    ) is distinct from '0'
    or template_truth ->> 'certificationRunId'
      is distinct from p_certification_run_id::text
    or pg_catalog.lower(template_truth ->> 'sourceFingerprint')
      is distinct from normalized_fingerprint
    or exchange_truth ->> 'valid' is distinct from 'true'
    or exchange_truth ->> 'integrityValid' is distinct from 'true'
    or exchange_truth ->> 'ledgerValid' is distinct from 'true'
    or exchange_truth ->> 'snapshotsValid' is distinct from 'true'
    or exchange_truth ->> 'referencesValid' is distinct from 'true'
    or exchange_truth ->> 'latestCertificationHasProjectionEvidence'
      is distinct from 'true'
    or exchange_truth ->> 'latestCertificationRunId'
      is distinct from p_certification_run_id::text
    or pg_catalog.lower(exchange_truth ->> 'latestSourceFingerprint')
      is distinct from normalized_fingerprint
    or pg_catalog.lower(
      exchange_truth ->> 'latestProjectionSnapshotSha256'
    ) is distinct from normalized_fingerprint
    or coalesce(queue_state ->> 'failed', '') is distinct from '0'
    or coalesce(queue_state ->> 'terminalFailed', '') is distinct from '0'
    or latest_certified_at is null
    or latest_certified_at
      > event_time + pg_catalog.make_interval(secs => 300)
    or latest_certified_at
      < event_time
        - pg_catalog.make_interval(
          secs => p_certification_max_age_seconds
        )
  then
    raise exception
      'OUTLOOK_INSERTION_TRUTH_STALE: certified Exchange truth is not valid and current.'
      using errcode = '55000';
  end if;

  if reservation_is_idempotent
    and (
      reservation_record.occurred_at is null
      or reservation_record.occurred_at > event_time
      or reservation_record.occurred_at
        < event_time
          - pg_catalog.make_interval(secs => reservation_ttl_seconds)
    )
  then
    raise exception
      'OUTLOOK_INSERTION_RESERVATION_EXPIRED: insertion reservations expire after 120 seconds.'
      using errcode = '55000';
  end if;

  if reservation_is_idempotent then
    return pg_catalog.jsonb_build_object(
      'reserved', true,
      'idempotent', true,
      'auditLogId', reservation_record.id,
      'eventAt', reservation_record.occurred_at
    );
  end if;

  perform pg_catalog.set_config(
    'app.outlook_insertion_reservation_operation_id',
    p_operation_id::text,
    true
  );

  insert into public.audit_logs (
    occurred_at,
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
    request_context
  )
  values (
    event_time,
    normalized_actor_id,
    normalized_actor_name,
    'app',
    'app',
    'outlook_template_insertion_attempts',
    'INSERT',
    pg_catalog.jsonb_build_object(
      'operationId', p_operation_id,
      'phase', 'reserved',
      'templateId', normalized_template_id,
      'templateRevision', p_template_revision
    ),
    array[]::text[],
    null,
    pg_catalog.jsonb_build_object(
      'schema', 'fcuno.outlook-template-insertion-audit/v2',
      'phase', 'reserved',
      'operationId', p_operation_id,
      'templateId', normalized_template_id,
      'templateTitle', template_record.title,
      'templateRevision', p_template_revision,
      'certificationRunId', p_certification_run_id,
      'sourceFingerprint', normalized_fingerprint,
      'eventAt', event_time
    ),
    pg_catalog.jsonb_build_object(
      'pageId', 'email-templates',
      'pageLabel', 'OUTLOOK TEMPLATES',
      'pagePath', '/api/outlook-addin/taskpane',
      'action', 'outlook-draft-insertion-reserved',
      'auditPhase', 'reserved'
    )
  )
  returning id into inserted_audit_log_id;

  return pg_catalog.jsonb_build_object(
    'reserved', true,
    'idempotent', false,
    'auditLogId', inserted_audit_log_id,
    'eventAt', event_time
  );
exception
  when lock_not_available then
    raise exception
      'OUTLOOK_INSERTION_STATE_BUSY: recipient or template state is changing; retry this reservation.'
      using errcode = '55P03';
end;
$$;
