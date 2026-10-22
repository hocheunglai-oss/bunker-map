-- Preserve full, current certified-recipient verification while bounding lock contention.
-- No caller-provided proof, historical-check bypass, cache or privilege expansion.
-- lock_timeout is reservation-local (per lock acquisition), automatically restored.

set local lock_timeout = '3s';

create or replace function public.verify_outlook_template_recipient_truth()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
set statement_timeout = '20s'
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
    'queue', truth -> 'queue',
    -- Privileged, server-computed proof: reservation must not scan it twice.
    'exchangeTruth', truth
  );
end;
$$;

revoke all on function public.verify_outlook_template_recipient_truth()
  from public, anon, authenticated;
grant execute on function public.verify_outlook_template_recipient_truth()
  to service_role;

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

revoke all on function public.reserve_outlook_template_insertion(
  uuid,
  text,
  bigint,
  uuid,
  text,
  text,
  text,
  integer
)
  from public, anon, authenticated;
grant execute on function public.reserve_outlook_template_insertion(
  uuid,
  text,
  bigint,
  uuid,
  text,
  text,
  text,
  integer
)
  to service_role;

