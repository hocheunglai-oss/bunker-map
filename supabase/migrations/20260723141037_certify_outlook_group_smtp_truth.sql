-- Resolve template groups only through the exact SMTP address carried by the
-- immutable FCUNO-to-Exchange projection. Older projections intentionally
-- reconcile group refs to missing so insertion remains fail closed until a
-- fresh full Exchange certification records smtpAddress.

create or replace function public.outlook_exchange_projection_has_exact_group_smtp(
  p_projection jsonb
)
returns boolean
language plpgsql
immutable
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
  group_count bigint;
  distinct_source_id_count bigint;
  distinct_alias_count bigint;
  distinct_smtp_count bigint;
begin
  if pg_catalog.jsonb_typeof(p_projection) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_projection -> 'groups')
      is distinct from 'array'
  then
    return false;
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(
      p_projection -> 'groups'
    ) as projected(group_value)
    where pg_catalog.jsonb_typeof(group_value) is distinct from 'object'
      or pg_catalog.jsonb_typeof(group_value -> 'sourceGroupId')
        is distinct from 'string'
      or group_value ->> 'sourceGroupId'
        is distinct from pg_catalog.btrim(group_value ->> 'sourceGroupId')
      or nullif(pg_catalog.btrim(group_value ->> 'sourceGroupId'), '') is null
      or pg_catalog.length(group_value ->> 'sourceGroupId') > 256
      or pg_catalog.jsonb_typeof(group_value -> 'alias')
        is distinct from 'string'
      or group_value ->> 'alias'
        is distinct from pg_catalog.lower(
          pg_catalog.btrim(group_value ->> 'alias')
        )
      or coalesce(group_value ->> 'alias', '')
        !~ '^[a-z0-9._-]{1,64}$'
      or pg_catalog.jsonb_typeof(group_value -> 'smtpAddress')
        is distinct from 'string'
      or group_value ->> 'smtpAddress'
        is distinct from pg_catalog.lower(
          pg_catalog.btrim(group_value ->> 'smtpAddress')
        )
      or coalesce(group_value ->> 'smtpAddress', '')
        !~ '^[^@[:space:]]+@[^@[:space:]]+$'
      or pg_catalog.split_part(
        coalesce(group_value ->> 'smtpAddress', ''),
        '@',
        1
      ) is distinct from group_value ->> 'alias'
      or pg_catalog.split_part(
        coalesce(group_value ->> 'smtpAddress', ''),
        '@',
        2
      ) is distinct from 'cosulich1.onmicrosoft.com'
      or pg_catalog.jsonb_typeof(group_value -> 'memberCount')
        is distinct from 'number'
      or coalesce(group_value ->> 'memberCount', '') !~ '^[1-9][0-9]*$'
      or (group_value ->> 'memberCount')::numeric > 2147483647
  ) then
    return false;
  end if;

  select
    pg_catalog.count(*),
    pg_catalog.count(distinct group_value ->> 'sourceGroupId'),
    pg_catalog.count(distinct group_value ->> 'alias'),
    pg_catalog.count(distinct group_value ->> 'smtpAddress')
  into
    group_count,
    distinct_source_id_count,
    distinct_alias_count,
    distinct_smtp_count
  from pg_catalog.jsonb_array_elements(
    p_projection -> 'groups'
  ) as projected(group_value);

  return group_count = distinct_source_id_count
    and group_count = distinct_alias_count
    and group_count = distinct_smtp_count;
exception
  when others then
    return false;
end;
$$;

create or replace function public.outlook_exchange_worker_supports_group_smtp(
  p_worker_version text
)
returns boolean
language plpgsql
immutable
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
  worker_date text;
  worker_date_value date;
  worker_revision_text text;
begin
  if p_worker_version is null
    or pg_catalog.length(p_worker_version) > 128
    or p_worker_version
      !~ '^fcuno-exchange-runbook/[0-9]{4}-[0-9]{2}-[0-9]{2}\.[0-9]+$'
  then
    return false;
  end if;

  worker_date := pg_catalog.substring(
    p_worker_version,
    '^fcuno-exchange-runbook/([0-9]{4}-[0-9]{2}-[0-9]{2})\.'
  );
  worker_revision_text := pg_catalog.substring(
    p_worker_version,
    '\.([0-9]+)$'
  );
  worker_date_value := worker_date::date;

  if pg_catalog.to_char(worker_date_value, 'YYYY-MM-DD')
    is distinct from worker_date
  then
    return false;
  end if;

  return worker_date_value > date '2026-07-23'
    or (
      worker_date_value = date '2026-07-23'
      and worker_revision_text::numeric >= 3
    );
exception
  when others then
    return false;
end;
$$;

-- Replace this function in place so existing dependencies and cached plans
-- retain its OID while gaining the exact group-SMTP invariant.
create or replace function public.outlook_exchange_truth_snapshot_is_valid(
  p_snapshot_sha256 text,
  p_snapshot_kind text,
  p_schema_version integer,
  p_canonical_json text,
  p_byte_length bigint,
  p_item_counts jsonb
)
returns boolean
language plpgsql
immutable
set search_path = pg_catalog, pg_temp
as $$
declare
  snapshot_value jsonb;
  expected_counts jsonb;
begin
  if p_snapshot_sha256 !~ '^[0-9a-f]{64}$'
    or p_schema_version <> 1
    or p_snapshot_sha256
      <> public.outlook_exchange_truth_sha256(p_canonical_json)
    or p_byte_length <> octet_length(p_canonical_json)
    or jsonb_typeof(p_item_counts) <> 'object'
  then
    return false;
  end if;

  snapshot_value := p_canonical_json::jsonb;
  if p_snapshot_kind = 'fcuno_raw' then
    if snapshot_value ->> 'schema' is distinct from 'fcuno.addressbook.raw/v1'
      or jsonb_typeof(snapshot_value -> 'contacts') is distinct from 'array'
      or jsonb_typeof(snapshot_value -> 'groups') is distinct from 'array'
      or jsonb_typeof(snapshot_value -> 'members') is distinct from 'array'
      or snapshot_value - array[
        'schema', 'contacts', 'groups', 'members'
      ] <> '{}'::jsonb
    then
      return false;
    end if;
    expected_counts := jsonb_build_object(
      'contacts', jsonb_array_length(snapshot_value -> 'contacts'),
      'groups', jsonb_array_length(snapshot_value -> 'groups'),
      'members', jsonb_array_length(snapshot_value -> 'members')
    );
  elsif p_snapshot_kind = 'fcuno_exchange_projection' then
    if not public.outlook_exchange_projection_has_exact_group_smtp(
      snapshot_value
    )
      or jsonb_typeof(snapshot_value -> 'contacts') is distinct from 'array'
      or jsonb_typeof(snapshot_value -> 'members') is distinct from 'array'
      or jsonb_typeof(snapshot_value -> 'invalidContacts')
        is distinct from 'array'
      or jsonb_typeof(snapshot_value -> 'skippedInvalidContacts')
        is distinct from 'array'
      or jsonb_typeof(snapshot_value -> 'duplicateContacts')
        is distinct from 'array'
      or snapshot_value - array[
        'contacts',
        'groups',
        'members',
        'invalidContacts',
        'skippedInvalidContacts',
        'duplicateContacts'
      ] <> '{}'::jsonb
    then
      return false;
    end if;
    expected_counts := jsonb_build_object(
      'contacts', jsonb_array_length(snapshot_value -> 'contacts'),
      'groups', jsonb_array_length(snapshot_value -> 'groups'),
      'members', jsonb_array_length(snapshot_value -> 'members'),
      'invalidContacts', jsonb_array_length(snapshot_value -> 'invalidContacts'),
      'skippedInvalidContacts', jsonb_array_length(
        snapshot_value -> 'skippedInvalidContacts'
      ),
      'duplicateContacts', jsonb_array_length(
        snapshot_value -> 'duplicateContacts'
      )
    );
  else
    return false;
  end if;

  return p_item_counts is not distinct from expected_counts;
exception
  when others then
    return false;
end;
$$;

revoke all on function
  public.outlook_exchange_projection_has_exact_group_smtp(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function
  public.outlook_exchange_worker_supports_group_smtp(text)
  from public, anon, authenticated, service_role;

alter function public.certify_full_outlook_exchange_truth(
  uuid,
  bigint,
  timestamptz,
  text,
  text,
  jsonb,
  jsonb,
  text
)
rename to certify_full_outlook_exchange_truth_without_group_smtp_guard;

revoke all on function
  public.certify_full_outlook_exchange_truth_without_group_smtp_guard(
    uuid,
    bigint,
    timestamptz,
    text,
    text,
    jsonb,
    jsonb,
    text
  )
  from public, anon, authenticated, service_role;

create or replace function public.certify_full_outlook_exchange_truth(
  p_run_id uuid,
  p_queue_high_water_sequence bigint,
  p_queue_high_water_updated_at timestamptz,
  p_source_fingerprint text,
  p_projection_canonical_json text,
  p_projection_counts jsonb,
  p_verification_summary jsonb,
  p_worker_version text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  projection_value jsonb;
begin
  begin
    projection_value := p_projection_canonical_json::jsonb;
  exception
    when others then
      raise exception
        'The canonical Exchange projection must be valid JSON with exact group SMTP truth.';
  end;

  if not public.outlook_exchange_worker_supports_group_smtp(
    p_worker_version
  ) then
    raise exception
      'A fresh full certification from an Exchange worker that certifies exact group SMTP truth is required.';
  end if;

  if not public.outlook_exchange_projection_has_exact_group_smtp(
    projection_value
  ) then
    raise exception
      'Every certified Exchange group must carry one exact lowercase alias@cosulich1.onmicrosoft.com SMTP address.';
  end if;

  return public.certify_full_outlook_exchange_truth_without_group_smtp_guard(
    p_run_id,
    p_queue_high_water_sequence,
    p_queue_high_water_updated_at,
    p_source_fingerprint,
    p_projection_canonical_json,
    p_projection_counts,
    p_verification_summary,
    p_worker_version
  );
end;
$$;

revoke all on function public.certify_full_outlook_exchange_truth(
  uuid,
  bigint,
  timestamptz,
  text,
  text,
  jsonb,
  jsonb,
  text
) from public, anon, authenticated, service_role;
grant execute on function public.certify_full_outlook_exchange_truth(
  uuid,
  bigint,
  timestamptz,
  text,
  text,
  jsonb,
  jsonb,
  text
) to service_role;

create or replace function private.enforce_outlook_exchange_projection_group_smtp()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
begin
  if new.snapshot_kind = 'fcuno_exchange_projection'
    and not public.outlook_exchange_projection_has_exact_group_smtp(
      new.canonical_json::jsonb
    )
  then
    raise exception
      'An Exchange projection snapshot without exact group SMTP truth cannot be recorded.';
  end if;

  return new;
end;
$$;

revoke all on function
  private.enforce_outlook_exchange_projection_group_smtp()
  from public, anon, authenticated, service_role;

drop trigger if exists enforce_outlook_exchange_projection_group_smtp
  on public.outlook_exchange_truth_snapshots;
create trigger enforce_outlook_exchange_projection_group_smtp
before insert on public.outlook_exchange_truth_snapshots
for each row
execute function private.enforce_outlook_exchange_projection_group_smtp();

alter function public.verify_outlook_exchange_truth_ledger()
rename to verify_outlook_exchange_truth_ledger_without_group_smtp_guard;

revoke all on function
  public.verify_outlook_exchange_truth_ledger_without_group_smtp_guard()
  from public, anon, authenticated, service_role;

create or replace function public.verify_outlook_exchange_truth_ledger()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  legacy_verification jsonb;
  latest_run_id uuid;
  latest_projection jsonb;
  latest_worker_version text;
  projection_group_smtp_valid boolean := false;
  worker_group_smtp_valid boolean := false;
  group_smtp_truth_valid boolean := false;
begin
  legacy_verification :=
    public.verify_outlook_exchange_truth_ledger_without_group_smtp_guard();

  begin
    latest_run_id := nullif(
      legacy_verification ->> 'latestCertificationRunId',
      ''
    )::uuid;
  exception
    when others then
      latest_run_id := null;
  end;

  if latest_run_id is not null then
    select
      snapshot.canonical_json::jsonb,
      evidence.payload_canonical_json::jsonb ->> 'workerVersion'
    into
      latest_projection,
      latest_worker_version
    from public.outlook_exchange_sync_certifications as certification
    left join public.outlook_exchange_truth_snapshots as snapshot
      on snapshot.snapshot_sha256 = certification.source_fingerprint
      and snapshot.snapshot_kind = 'fcuno_exchange_projection'
      and snapshot.schema_version = 1
    left join public.outlook_exchange_truth_ledger as evidence
      on evidence.event_key =
        'projection:' || certification.run_id::text
      and evidence.event_type = 'full_projection_evidence'
      and evidence.snapshot_sha256 = certification.source_fingerprint
    where certification.run_id = latest_run_id;
  end if;

  projection_group_smtp_valid := coalesce(
    public.outlook_exchange_projection_has_exact_group_smtp(
      latest_projection
    ),
    false
  );
  worker_group_smtp_valid := coalesce(
    public.outlook_exchange_worker_supports_group_smtp(
      latest_worker_version
    ),
    false
  );
  group_smtp_truth_valid :=
    projection_group_smtp_valid and worker_group_smtp_valid;

  return legacy_verification || pg_catalog.jsonb_build_object(
    'valid',
      coalesce((legacy_verification ->> 'valid')::boolean, false)
      and group_smtp_truth_valid,
    'operationallyConsistent',
      coalesce(
        (legacy_verification ->> 'operationallyConsistent')::boolean,
        false
      )
      and group_smtp_truth_valid,
    'groupSmtpTruthValid', group_smtp_truth_valid,
    'latestProjectionGroupSmtpValid', projection_group_smtp_valid,
    'latestCertificationGroupSmtpWorkerValid', worker_group_smtp_valid,
    'latestCertificationWorkerVersion', latest_worker_version,
    'requiredGroupSmtpWorkerVersion',
      'fcuno-exchange-runbook/2026-07-23.3'
  );
end;
$$;

revoke all on function public.verify_outlook_exchange_truth_ledger()
  from public, anon, authenticated, service_role;
grant execute on function public.verify_outlook_exchange_truth_ledger()
  to service_role;

-- Replace this validator in place so existing CHECK constraints retain its OID.
-- Missing keys and JSON null both become SQL NULL through ->>, so reject them
-- before status/kind branching.
create or replace function public.is_valid_outlook_template_recipient_resolution(
  p_resolution jsonb
)
returns boolean
language plpgsql
immutable
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
  field_name text;
  ref_record record;
  ref_value jsonb;
  ref_status text;
  ref_kind text;
  total_count bigint := 0;
  resolved_count bigint := 0;
  external_count bigint := 0;
  ambiguous_count bigint := 0;
  missing_count bigint := 0;
  recorded_total bigint;
  recorded_resolved bigint;
  recorded_external bigint;
  recorded_ambiguous bigint;
  recorded_missing bigint;
begin
  if jsonb_typeof(p_resolution) is distinct from 'object'
    or p_resolution ->> 'schema'
      is distinct from 'fcuno.outlook-template-recipient-resolution/v1'
    or coalesce(p_resolution ->> 'certificationRunId', '')
      !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or coalesce(p_resolution ->> 'certifiedAt', '')
      !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
    or coalesce(p_resolution ->> 'resolvedAt', '')
      !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
    or coalesce(p_resolution ->> 'sourceFingerprint', '')
      !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(p_resolution -> 'refs') is distinct from 'object'
    or jsonb_typeof(p_resolution -> 'counts') is distinct from 'object'
    or (
      p_resolution - array[
        'schema',
        'certificationRunId',
        'certifiedAt',
        'sourceFingerprint',
        'resolvedAt',
        'refs',
        'counts',
        'reconciliationRequired'
      ]
    ) <> '{}'::jsonb
    or (
      (p_resolution -> 'refs') - array['to', 'cc', 'bcc']
    ) <> '{}'::jsonb
    or (
      (p_resolution -> 'counts') - array[
        'total',
        'resolved',
        'external',
        'ambiguous',
        'missing'
      ]
    ) <> '{}'::jsonb
  then
    return false;
  end if;

  if p_resolution ? 'reconciliationRequired'
    and jsonb_typeof(p_resolution -> 'reconciliationRequired')
      is distinct from 'boolean'
  then
    return false;
  end if;

  if coalesce(p_resolution #>> '{counts,total}', '')
      !~ '^(0|[1-9][0-9]*)$'
    or coalesce(p_resolution #>> '{counts,resolved}', '')
      !~ '^(0|[1-9][0-9]*)$'
    or coalesce(p_resolution #>> '{counts,external}', '')
      !~ '^(0|[1-9][0-9]*)$'
    or coalesce(p_resolution #>> '{counts,ambiguous}', '')
      !~ '^(0|[1-9][0-9]*)$'
    or coalesce(p_resolution #>> '{counts,missing}', '')
      !~ '^(0|[1-9][0-9]*)$'
  then
    return false;
  end if;

  if (p_resolution #>> '{counts,total}')::numeric > 10000
    or (p_resolution #>> '{counts,resolved}')::numeric > 10000
    or (p_resolution #>> '{counts,external}')::numeric > 10000
    or (p_resolution #>> '{counts,ambiguous}')::numeric > 10000
    or (p_resolution #>> '{counts,missing}')::numeric > 10000
  then
    return false;
  end if;

  recorded_total := (p_resolution #>> '{counts,total}')::bigint;
  recorded_resolved := (p_resolution #>> '{counts,resolved}')::bigint;
  recorded_external := (p_resolution #>> '{counts,external}')::bigint;
  recorded_ambiguous := (p_resolution #>> '{counts,ambiguous}')::bigint;
  recorded_missing := (p_resolution #>> '{counts,missing}')::bigint;

  foreach field_name in array array['to', 'cc', 'bcc']
  loop
    if jsonb_typeof(p_resolution #> array['refs', field_name])
      is distinct from 'array'
    then
      return false;
    end if;

    for ref_record in
      select item.value, item.ordinality
      from jsonb_array_elements(
        p_resolution #> array['refs', field_name]
      ) with ordinality as item(value, ordinality)
    loop
      ref_value := ref_record.value;
      if jsonb_typeof(ref_value) is distinct from 'object'
        or (
          ref_value - array[
            'field',
            'position',
            'literal',
            'displayName',
            'sourceValue',
            'kind',
            'sourceId',
            'resolvedAddress',
            'status'
          ]
        ) <> '{}'::jsonb
        or not (ref_value ?& array['kind', 'status'])
        or jsonb_typeof(ref_value -> 'kind') is distinct from 'string'
        or jsonb_typeof(ref_value -> 'status') is distinct from 'string'
        or ref_value ->> 'field' is distinct from field_name
        or coalesce(ref_value ->> 'position', '')
          !~ '^(0|[1-9][0-9]*)$'
        or (ref_value ->> 'position')::numeric
          <> ref_record.ordinality - 1
        or jsonb_typeof(ref_value -> 'literal') is distinct from 'string'
        or nullif(btrim(ref_value ->> 'literal'), '') is null
        or jsonb_typeof(ref_value -> 'displayName') is distinct from 'string'
        or jsonb_typeof(ref_value -> 'sourceValue') is distinct from 'string'
      then
        return false;
      end if;

      ref_status := ref_value ->> 'status';
      ref_kind := ref_value ->> 'kind';
      if ref_status is null
        or ref_kind is null
        or ref_status not in ('resolved', 'external', 'ambiguous', 'missing')
        or ref_kind not in ('contact', 'group', 'external', 'unresolved')
      then
        return false;
      end if;

      if ref_status = 'resolved' then
        if ref_kind not in ('contact', 'group')
          or nullif(btrim(ref_value ->> 'sourceId'), '') is null
          or coalesce(ref_value ->> 'resolvedAddress', '')
            !~* '^[^@[:space:]]+@[^@[:space:]]+$'
        then
          return false;
        end if;
        resolved_count := resolved_count + 1;
      elsif ref_status = 'external' then
        if ref_kind <> 'external'
          or (
            ref_value ? 'sourceId'
            and jsonb_typeof(ref_value -> 'sourceId') <> 'null'
          )
          or coalesce(ref_value ->> 'resolvedAddress', '')
            !~* '^[^@[:space:]]+@[^@[:space:]]+$'
        then
          return false;
        end if;
        external_count := external_count + 1;
      elsif ref_status = 'ambiguous' then
        if ref_kind <> 'unresolved'
          or (
            ref_value ? 'sourceId'
            and jsonb_typeof(ref_value -> 'sourceId') <> 'null'
          )
          or (
            ref_value ? 'resolvedAddress'
            and jsonb_typeof(ref_value -> 'resolvedAddress')
              not in ('string', 'null')
          )
        then
          return false;
        end if;
        ambiguous_count := ambiguous_count + 1;
      else
        if (
          ref_kind = 'unresolved'
          and ref_value ? 'sourceId'
          and jsonb_typeof(ref_value -> 'sourceId') <> 'null'
        )
          or (
            ref_kind in ('contact', 'group')
            and nullif(btrim(ref_value ->> 'sourceId'), '') is null
          )
          or ref_kind = 'external'
          or (
            ref_value ? 'resolvedAddress'
            and jsonb_typeof(ref_value -> 'resolvedAddress') <> 'null'
          )
        then
          return false;
        end if;
        missing_count := missing_count + 1;
      end if;

      total_count := total_count + 1;
      if total_count > 10000 then
        return false;
      end if;
    end loop;
  end loop;

  return recorded_total = total_count
    and recorded_resolved = resolved_count
    and recorded_external = external_count
    and recorded_ambiguous = ambiguous_count
    and recorded_missing = missing_count
    and recorded_total =
      recorded_resolved
      + recorded_external
      + recorded_ambiguous
      + recorded_missing;
exception
  when others then
    return false;
end;
$$;

revoke all on function
  public.is_valid_outlook_template_recipient_resolution(jsonb)
  from public, anon, authenticated;
grant execute on function
  public.is_valid_outlook_template_recipient_resolution(jsonb)
  to service_role;

create or replace function public.reconcile_outlook_template_recipient_ref(
  p_ref jsonb,
  p_projection jsonb
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  source_id text;
  recipient_kind text;
  candidate jsonb;
  display_name text;
  resolved_address text;
  projected_address text;
begin
  if p_ref is null or jsonb_typeof(p_ref) <> 'object' then
    return p_ref;
  end if;

  source_id := nullif(pg_catalog.btrim(p_ref ->> 'sourceId'), '');
  recipient_kind := p_ref ->> 'kind';
  if source_id is null
    or not (p_ref ? 'kind')
    or pg_catalog.jsonb_typeof(p_ref -> 'kind') is distinct from 'string'
    or recipient_kind is null
    or recipient_kind not in ('contact', 'group')
  then
    return p_ref;
  end if;

  if recipient_kind = 'contact' then
    select item
    into candidate
    from jsonb_array_elements(
      coalesce(p_projection -> 'contacts', '[]'::jsonb)
    ) as projected(item)
    where item ->> 'sourceContactId' = source_id
    limit 1;

    projected_address := pg_catalog.btrim(
      candidate ->> 'externalEmailAddress'
    );
    resolved_address := lower(projected_address);
    display_name := coalesce(
      nullif(pg_catalog.btrim(candidate ->> 'displayName'), ''),
      nullif(pg_catalog.btrim(candidate ->> 'directoryName'), ''),
      nullif(pg_catalog.btrim(p_ref ->> 'displayName'), ''),
      resolved_address
    );
  else
    select item
    into candidate
    from jsonb_array_elements(
      coalesce(p_projection -> 'groups', '[]'::jsonb)
    ) as projected(item)
    where item ->> 'sourceGroupId' = source_id
    limit 1;

    projected_address := pg_catalog.btrim(
      candidate ->> 'smtpAddress'
    );
    resolved_address := lower(projected_address);
    display_name := coalesce(
      nullif(pg_catalog.btrim(candidate ->> 'groupName'), ''),
      nullif(pg_catalog.btrim(candidate ->> 'directoryName'), ''),
      nullif(pg_catalog.btrim(p_ref ->> 'displayName'), ''),
      resolved_address
    );
  end if;

  if candidate is null
    or nullif(projected_address, '') is null
    or projected_address <> resolved_address
    or resolved_address !~ '^[^@[:space:]]+@[^@[:space:]]+$'
  then
    return p_ref || jsonb_build_object(
      'resolvedAddress', null,
      'status', 'missing'
    );
  end if;

  return p_ref || jsonb_build_object(
    'displayName', display_name,
    'resolvedAddress', resolved_address,
    'status', 'resolved'
  );
end;
$$;

revoke all on function
  public.reconcile_outlook_template_recipient_ref(jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function
  public.reconcile_outlook_template_recipient_ref(jsonb, jsonb)
  to service_role;
