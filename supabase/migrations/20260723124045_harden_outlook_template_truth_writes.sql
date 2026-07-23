-- Make recipient evidence structurally exact, require every template write to
-- use the latest settled certification, and reconcile on every successful full
-- certification (including repeated projection hashes).

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
      if ref_status not in ('resolved', 'external', 'ambiguous', 'missing')
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
        if ref_kind <> 'unresolved'
          or (
            ref_value ? 'sourceId'
            and jsonb_typeof(ref_value -> 'sourceId') <> 'null'
          )
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

alter table public.email_templates
  drop constraint if exists email_templates_recipient_resolution_shape;
alter table public.email_templates
  add constraint email_templates_recipient_resolution_shape
  check (
    public.is_valid_outlook_template_recipient_resolution(
      recipient_resolution
    )
  )
  not valid;
alter table public.email_templates
  validate constraint email_templates_recipient_resolution_shape;

create or replace function private.prepare_outlook_template_truth_write()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  truth jsonb;
  queue_state jsonb;
  expected_run_id text;
  expected_certified_at text;
  expected_fingerprint text;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('email_templates_canonical_write', 0)
  );

  truth := public.verify_outlook_exchange_truth_ledger();
  queue_state := coalesce(truth -> 'queue', '{}'::jsonb);
  expected_run_id := coalesce(
    truth ->> 'latestCertificationRunId',
    ''
  );
  expected_certified_at := coalesce(
    truth ->> 'latestCertificationAt',
    ''
  );
  expected_fingerprint := lower(
    coalesce(truth ->> 'latestSourceFingerprint', '')
  );

  if truth ->> 'valid' is distinct from 'true'
    or truth ->> 'integrityValid' is distinct from 'true'
    or truth ->> 'ledgerValid' is distinct from 'true'
    or truth ->> 'snapshotsValid' is distinct from 'true'
    or truth ->> 'referencesValid' is distinct from 'true'
    or truth ->> 'operationallyConsistent' is distinct from 'true'
    or truth ->> 'latestCertificationHasProjectionEvidence'
      is distinct from 'true'
    or coalesce(truth ->> 'latestProjectionSnapshotSha256', '')
      is distinct from expected_fingerprint
    or expected_run_id
      !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or expected_certified_at = ''
    or expected_fingerprint !~ '^[0-9a-f]{64}$'
    or coalesce((queue_state ->> 'pending')::bigint, -1) <> 0
    or coalesce((queue_state ->> 'processing')::bigint, -1) <> 0
    or coalesce((queue_state ->> 'failed')::bigint, -1) <> 0
    or coalesce((queue_state ->> 'terminalFailed')::bigint, -1) <> 0
  then
    raise exception
      'OUTLOOK_TEMPLATE_TRUTH_UNAVAILABLE: the latest FCUNO-to-Exchange certification is not settled and fully verified.'
      using errcode = '55000';
  end if;

  perform set_config(
    'app.outlook_template_expected_run_id',
    expected_run_id,
    true
  );
  perform set_config(
    'app.outlook_template_expected_certified_at',
    expected_certified_at,
    true
  );
  perform set_config(
    'app.outlook_template_expected_fingerprint',
    expected_fingerprint,
    true
  );
  return null;
end;
$$;

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
      using errcode = '40001';
  end if;

  return new;
end;
$$;

revoke all on function private.prepare_outlook_template_truth_write()
  from public, anon, authenticated, service_role;
revoke all on function private.enforce_outlook_template_truth_write()
  from public, anon, authenticated, service_role;

drop trigger if exists prepare_outlook_template_truth_write
  on public.email_templates;
create trigger prepare_outlook_template_truth_write
before insert or update on public.email_templates
for each statement
execute function private.prepare_outlook_template_truth_write();

drop trigger if exists enforce_outlook_template_truth_write
  on public.email_templates;
create trigger enforce_outlook_template_truth_write
before insert or update on public.email_templates
for each row
execute function private.enforce_outlook_template_truth_write();

create or replace function public.verify_outlook_template_recipient_truth()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  truth jsonb;
  current_fingerprint text;
  current_run_id text;
  current_certified_at timestamptz;
  total_count bigint;
  unresolved_count bigint;
  stale_count bigint;
  invalid_shape_count bigint;
  missing_count bigint;
  ambiguous_count bigint;
  sendable_count bigint;
begin
  truth := public.verify_outlook_exchange_truth_ledger();
  current_fingerprint := lower(
    coalesce(truth ->> 'latestSourceFingerprint', '')
  );
  current_run_id := coalesce(
    truth ->> 'latestCertificationRunId',
    ''
  );
  current_certified_at := nullif(
    truth ->> 'latestCertificationAt',
    ''
  )::timestamptz;

  select
    count(*),
    count(*) filter (
      where recipient_resolution = '{}'::jsonb
        or coalesce(
          (recipient_resolution ->> 'reconciliationRequired')::boolean,
          false
        )
    ),
    count(*) filter (
      where recipient_resolution <> '{}'::jsonb
        and (
          lower(recipient_resolution ->> 'sourceFingerprint')
            is distinct from current_fingerprint
          or recipient_resolution ->> 'certificationRunId'
            is distinct from current_run_id
          or (recipient_resolution ->> 'certifiedAt')::timestamptz
            is distinct from current_certified_at
        )
    ),
    count(*) filter (
      where not public.is_valid_outlook_template_recipient_resolution(
        recipient_resolution
      )
    ),
    count(*) filter (
      where jsonb_path_exists(
        recipient_resolution,
        '$.refs.*[*] ? (@.status == "missing")'
      )
    ),
    count(*) filter (
      where jsonb_path_exists(
        recipient_resolution,
        '$.refs.*[*] ? (@.status == "ambiguous")'
      )
    ),
    count(*) filter (
      where public.is_valid_outlook_template_recipient_resolution(
          recipient_resolution
        )
        and not coalesce(
          (recipient_resolution ->> 'reconciliationRequired')::boolean,
          false
        )
        and lower(recipient_resolution ->> 'sourceFingerprint')
          is not distinct from current_fingerprint
        and recipient_resolution ->> 'certificationRunId'
          is not distinct from current_run_id
        and (recipient_resolution ->> 'certifiedAt')::timestamptz
          is not distinct from current_certified_at
        and not jsonb_path_exists(
          recipient_resolution,
          '$.refs.*[*] ? (@.status == "missing" || @.status == "ambiguous")'
        )
    )
  into
    total_count,
    unresolved_count,
    stale_count,
    invalid_shape_count,
    missing_count,
    ambiguous_count,
    sendable_count
  from public.email_templates;

  return jsonb_build_object(
    'schema', 'fcuno.outlook-template-recipient-truth/v2',
    'valid',
      coalesce((truth ->> 'valid')::boolean, false)
      and coalesce((truth ->> 'integrityValid')::boolean, false)
      and coalesce((truth ->> 'ledgerValid')::boolean, false)
      and coalesce((truth ->> 'snapshotsValid')::boolean, false)
      and coalesce((truth ->> 'referencesValid')::boolean, false)
      and coalesce(
        (truth ->> 'operationallyConsistent')::boolean,
        false
      )
      and unresolved_count = 0
      and stale_count = 0
      and invalid_shape_count = 0,
    'allTemplatesSendable',
      unresolved_count = 0
      and stale_count = 0
      and invalid_shape_count = 0
      and missing_count = 0
      and ambiguous_count = 0,
    'sourceTruthValid', coalesce((truth ->> 'valid')::boolean, false),
    'certificationRunId', current_run_id,
    'certifiedAt', truth ->> 'latestCertificationAt',
    'sourceFingerprint', current_fingerprint,
    'templates', jsonb_build_object(
      'total', total_count,
      'unresolved', unresolved_count,
      'stale', stale_count,
      'invalidShape', invalid_shape_count,
      'withMissingRecipients', missing_count,
      'withAmbiguousRecipients', ambiguous_count,
      'sendable', sendable_count
    ),
    'queue', truth -> 'queue'
  );
end;
$$;

revoke all on function public.verify_outlook_template_recipient_truth()
  from public, anon, authenticated;
grant execute on function public.verify_outlook_template_recipient_truth()
  to service_role;

create or replace function public.reconcile_outlook_templates_after_certification()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  projection jsonb;
  reconciled_at constant timestamptz := clock_timestamp();
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('email_templates_canonical_write', 0)
  );

  select snapshot.canonical_json::jsonb
  into projection
  from public.outlook_exchange_truth_snapshots as snapshot
  where snapshot.snapshot_sha256 = new.source_fingerprint
    and snapshot.snapshot_kind = 'fcuno_exchange_projection'
    and snapshot.schema_version = 1;

  if projection is null then
    raise exception
      'Exchange certification % has no exact canonical projection snapshot.',
      new.run_id;
  end if;

  perform set_config(
    'app.audit_actor_id',
    'system:outlook-template-recipient-truth',
    true
  );
  perform set_config(
    'app.audit_actor_name',
    'Outlook Template Recipient Truth',
    true
  );
  perform set_config(
    'app.audit_context',
    jsonb_build_object(
      'action', 'certified-projection-reconcile',
      'pageId', 'email-templates',
      'pageLabel', 'OUTLOOK TEMPLATES',
      'pagePath', '/admin/outlooktemplates',
      'certificationRunId', new.run_id,
      'sourceFingerprint', new.source_fingerprint
    )::text,
    true
  );

  update public.email_templates as template
  set recipient_resolution =
    public.reconcile_outlook_template_resolution(
      template.recipient_resolution,
      projection,
      new.run_id,
      new.certified_at,
      new.source_fingerprint,
      reconciled_at
    )
  where not coalesce(
      (template.recipient_resolution ->> 'reconciliationRequired')::boolean,
      false
    )
    and (
      lower(template.recipient_resolution ->> 'sourceFingerprint')
        is distinct from lower(new.source_fingerprint)
      or template.recipient_resolution ->> 'certificationRunId'
        is distinct from new.run_id::text
      or (template.recipient_resolution ->> 'certifiedAt')::timestamptz
        is distinct from new.certified_at
    );

  return null;
end;
$$;

revoke all on function
  public.reconcile_outlook_templates_after_certification()
  from public, anon, authenticated, service_role;

drop trigger if exists reconcile_outlook_templates_after_projection
  on public.outlook_exchange_truth_snapshots;
drop trigger if exists reconcile_outlook_templates_after_certification
  on public.outlook_exchange_sync_certifications;
create constraint trigger reconcile_outlook_templates_after_certification
after insert on public.outlook_exchange_sync_certifications
deferrable initially deferred
for each row
execute function public.reconcile_outlook_templates_after_certification();
