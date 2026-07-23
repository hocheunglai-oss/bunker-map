-- Record Outlook template insertion as an append-only two-phase audit stream.
-- A durable reservation must exist before the client mutates a draft. Exactly
-- one terminal outcome may then be appended for the same operation. If the
-- client disappears between those events, Audit Log retains an explicit
-- incomplete reservation instead of silently losing the attempted mutation.

drop index if exists
  public.audit_logs_outlook_template_insertion_operation_id_key;

create unique index if not exists
  audit_logs_outlook_template_insertion_operation_phase_key
  on public.audit_logs (
    (record_pk ->> 'operationId'),
    (record_pk ->> 'phase')
  )
  where table_schema = 'app'
    and table_name = 'outlook_template_insertion_attempts'
    and operation = 'INSERT'
    and record_pk ->> 'phase' in ('reserved', 'terminal')
    and record_pk ? 'operationId';

create or replace function private.protect_outlook_template_insertion_audit_event()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
  event_phase text;
  event_outcome text;
  event_time_value timestamptz;
  reservation_record public.audit_logs%rowtype;
begin
  if tg_op = 'UPDATE'
    and (
      (
        old.table_schema = 'app'
        and old.table_name = 'outlook_template_insertion_attempts'
      )
      or (
        new.table_schema = 'app'
        and new.table_name = 'outlook_template_insertion_attempts'
      )
    )
  then
    raise exception
      'Outlook template insertion audit events are append-only.';
  end if;

  if tg_op = 'DELETE'
    and old.table_schema = 'app'
    and old.table_name = 'outlook_template_insertion_attempts'
  then
    raise exception
      'Outlook template insertion audit events are append-only.';
  end if;

  if tg_op <> 'INSERT'
    or new.table_schema is distinct from 'app'
    or new.table_name is distinct from 'outlook_template_insertion_attempts'
  then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  event_phase := new.record_pk ->> 'phase';
  event_outcome := new.after_row ->> 'outcome';

  if new.operation is distinct from 'INSERT'
    or new.actor_source is distinct from 'app'
    or nullif(pg_catalog.btrim(new.actor_id), '') is null
    or nullif(pg_catalog.btrim(new.actor_name), '') is null
    or pg_catalog.length(new.actor_id) > 256
    or pg_catalog.length(new.actor_name) > 256
    or new.before_row is not null
    or coalesce(pg_catalog.array_length(new.changed_fields, 1), 0) <> 0
    or new.undo_of_log_id is not null
    or new.undone_at is not null
    or new.undone_by_log_id is not null
    or pg_catalog.jsonb_typeof(new.record_pk) is distinct from 'object'
    or not (
      new.record_pk ?& array[
        'operationId',
        'phase',
        'templateId',
        'templateRevision'
      ]
    )
    or (
      new.record_pk - array[
        'operationId',
        'phase',
        'templateId',
        'templateRevision'
      ]
    ) <> '{}'::jsonb
    or coalesce(new.record_pk ->> 'operationId', '')
      !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or event_phase is null
    or event_phase not in ('reserved', 'terminal')
    or nullif(pg_catalog.btrim(new.record_pk ->> 'templateId'), '') is null
    or pg_catalog.length(new.record_pk ->> 'templateId') > 256
    or coalesce(new.record_pk ->> 'templateRevision', '')
      !~ '^[1-9][0-9]*$'
    or (new.record_pk ->> 'templateRevision')::numeric > 2147483647
    or pg_catalog.jsonb_typeof(new.after_row) is distinct from 'object'
    or new.after_row ->> 'schema'
      is distinct from 'fcuno.outlook-template-insertion-audit/v2'
    or new.after_row ->> 'phase' is distinct from event_phase
    or new.after_row ->> 'operationId'
      is distinct from new.record_pk ->> 'operationId'
    or new.after_row ->> 'templateId'
      is distinct from new.record_pk ->> 'templateId'
    or new.after_row ->> 'templateRevision'
      is distinct from new.record_pk ->> 'templateRevision'
    or coalesce(new.after_row ->> 'certificationRunId', '')
      !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or coalesce(new.after_row ->> 'sourceFingerprint', '')
      !~ '^[0-9a-f]{64}$'
    or new.request_context ->> 'pageId' is distinct from 'email-templates'
    or new.request_context ->> 'auditPhase' is distinct from event_phase
    or new.request_context ->> 'action'
      is distinct from 'outlook-draft-insertion-' || event_phase
  then
    raise exception
      'Invalid Outlook template insertion audit event.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'outlook_template_insertion_operation:'
        || (new.record_pk ->> 'operationId'),
      0
    )
  );

  begin
    event_time_value := (new.after_row ->> 'eventAt')::timestamptz;
  exception
    when others then
      raise exception
        'Outlook template insertion audit eventAt must be a valid timestamp.';
  end;

  if event_time_value is distinct from new.occurred_at then
    raise exception
      'Outlook template insertion audit eventAt must match occurred_at.';
  end if;

  if event_phase = 'reserved' then
    if pg_catalog.current_setting(
      'app.outlook_insertion_reservation_operation_id',
      true
    ) is distinct from new.record_pk ->> 'operationId'
      or not (
      new.after_row ?& array[
        'schema',
        'phase',
        'operationId',
        'templateId',
        'templateTitle',
        'templateRevision',
        'certificationRunId',
        'sourceFingerprint',
        'eventAt'
      ]
    )
      or (
        new.after_row - array[
          'schema',
          'phase',
          'operationId',
          'templateId',
          'templateTitle',
          'templateRevision',
          'certificationRunId',
          'sourceFingerprint',
          'eventAt'
        ]
      ) <> '{}'::jsonb
      or event_outcome is not null
      or pg_catalog.jsonb_typeof(new.after_row -> 'templateTitle')
        is distinct from 'string'
      or nullif(
        pg_catalog.btrim(new.after_row ->> 'templateTitle'),
        ''
      ) is null
      or pg_catalog.length(new.after_row ->> 'templateTitle') > 512
      or new.request_context ? 'auditOutcome'
    then
      raise exception
        'Invalid Outlook template insertion reservation event.';
    end if;

    return new;
  end if;

  if not (
    new.after_row ?& array[
      'schema',
      'phase',
      'outcome',
      'operationId',
      'templateId',
      'templateRevision',
      'certificationRunId',
      'sourceFingerprint',
      'reservationAuditLogId',
      'eventAt'
    ]
  )
    or (
      new.after_row - array[
        'schema',
        'phase',
        'outcome',
        'operationId',
        'templateId',
        'templateRevision',
        'certificationRunId',
        'sourceFingerprint',
        'reservationAuditLogId',
        'eventAt'
      ]
    ) <> '{}'::jsonb
    or event_outcome is null
    or event_outcome not in (
      'inserted',
      'failed-restored',
      'failed-preserved'
    )
    or coalesce(new.after_row ->> 'reservationAuditLogId', '')
      !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or new.request_context ->> 'auditOutcome'
      is distinct from event_outcome
  then
    raise exception
      'Invalid Outlook template insertion terminal event.';
  end if;

  select logs.*
  into reservation_record
  from public.audit_logs as logs
  where logs.table_schema = 'app'
    and logs.table_name = 'outlook_template_insertion_attempts'
    and logs.operation = 'INSERT'
    and logs.record_pk ->> 'operationId'
      = new.record_pk ->> 'operationId'
    and logs.record_pk ->> 'phase' = 'reserved'
  limit 1;

  if not found
    or reservation_record.id::text
      is distinct from new.after_row ->> 'reservationAuditLogId'
    or reservation_record.actor_id is distinct from new.actor_id
    or reservation_record.record_pk ->> 'templateId'
      is distinct from new.record_pk ->> 'templateId'
    or reservation_record.record_pk ->> 'templateRevision'
      is distinct from new.record_pk ->> 'templateRevision'
    or reservation_record.after_row ->> 'certificationRunId'
      is distinct from new.after_row ->> 'certificationRunId'
    or reservation_record.after_row ->> 'sourceFingerprint'
      is distinct from new.after_row ->> 'sourceFingerprint'
    or event_time_value < reservation_record.occurred_at
  then
    raise exception
      'A matching Outlook template insertion reservation is required before a terminal event.';
  end if;

  return new;
end;
$$;

revoke all on function
  private.protect_outlook_template_insertion_audit_event()
  from public, anon, authenticated;

drop trigger if exists protect_outlook_template_insertion_audit_event
  on public.audit_logs;
create trigger protect_outlook_template_insertion_audit_event
before insert or update or delete on public.audit_logs
for each row
execute function private.protect_outlook_template_insertion_audit_event();

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
    or template_record.recipient_resolution ->> 'reconciliationRequired'
      is distinct from 'false'
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
      using errcode = '40001';
  end if;

  template_truth := public.verify_outlook_template_recipient_truth();
  exchange_truth := public.verify_outlook_exchange_truth_ledger();
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

  if template_truth ->> 'valid' is distinct from 'true'
    or template_truth ->> 'sourceTruthValid' is distinct from 'true'
    or template_truth ->> 'certificationRunId'
      is distinct from p_certification_run_id::text
    or pg_catalog.lower(template_truth ->> 'sourceFingerprint')
      is distinct from normalized_fingerprint
    or exchange_truth ->> 'valid' is distinct from 'true'
    or exchange_truth ->> 'integrityValid' is distinct from 'true'
    or exchange_truth ->> 'ledgerValid' is distinct from 'true'
    or exchange_truth ->> 'snapshotsValid' is distinct from 'true'
    or exchange_truth ->> 'referencesValid' is distinct from 'true'
    or exchange_truth ->> 'operationallyConsistent'
      is distinct from 'true'
    or exchange_truth ->> 'latestCertificationHasProjectionEvidence'
      is distinct from 'true'
    or exchange_truth ->> 'latestCertificationRunId'
      is distinct from p_certification_run_id::text
    or pg_catalog.lower(exchange_truth ->> 'latestSourceFingerprint')
      is distinct from normalized_fingerprint
    or pg_catalog.lower(
      exchange_truth ->> 'latestProjectionSnapshotSha256'
    ) is distinct from normalized_fingerprint
    or coalesce(queue_state ->> 'pending', '') is distinct from '0'
    or coalesce(queue_state ->> 'processing', '') is distinct from '0'
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
      'OUTLOOK_INSERTION_TRUTH_STALE: certified Exchange truth is not exact, settled, and current.'
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

create or replace function public.complete_outlook_template_insertion(
  p_operation_id uuid,
  p_template_id text,
  p_template_revision bigint,
  p_certification_run_id uuid,
  p_source_fingerprint text,
  p_actor_id text,
  p_actor_name text,
  p_outcome text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = pg_catalog, pg_temp
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
  normalized_outcome text := pg_catalog.lower(pg_catalog.btrim(p_outcome));
  reservation_record record;
  terminal_record record;
  event_time timestamptz;
  inserted_audit_log_id uuid;
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
    or normalized_outcome is null
    or normalized_outcome not in (
      'inserted',
      'failed-restored',
      'failed-preserved'
    )
  then
    raise exception
      'OUTLOOK_INSERTION_TERMINAL_INVALID: terminal input is malformed.'
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

  if not found
    or reservation_record.actor_id is distinct from normalized_actor_id
    or reservation_record.record_pk ->> 'templateId'
      is distinct from normalized_template_id
    or reservation_record.record_pk ->> 'templateRevision'
      is distinct from p_template_revision::text
    or reservation_record.after_row ->> 'schema'
      is distinct from 'fcuno.outlook-template-insertion-audit/v2'
    or reservation_record.after_row ->> 'phase'
      is distinct from 'reserved'
    or reservation_record.after_row ->> 'operationId'
      is distinct from p_operation_id::text
    or reservation_record.after_row ->> 'templateId'
      is distinct from normalized_template_id
    or reservation_record.after_row ->> 'templateRevision'
      is distinct from p_template_revision::text
    or reservation_record.after_row ->> 'certificationRunId'
      is distinct from p_certification_run_id::text
    or reservation_record.after_row ->> 'sourceFingerprint'
      is distinct from normalized_fingerprint
    or pg_catalog.jsonb_typeof(
      reservation_record.after_row -> 'templateTitle'
    ) is distinct from 'string'
    or nullif(
      pg_catalog.btrim(
        reservation_record.after_row ->> 'templateTitle'
      ),
      ''
    ) is null
    or pg_catalog.length(
      reservation_record.after_row ->> 'templateTitle'
    ) > 512
  then
    raise exception
      'OUTLOOK_INSERTION_RESERVATION_REQUIRED: matching durable reservation was not found.'
      using errcode = '55000';
  end if;

  select logs.*
  into terminal_record
  from public.audit_logs as logs
  where logs.table_schema = 'app'
    and logs.table_name = 'outlook_template_insertion_attempts'
    and logs.operation = 'INSERT'
    and logs.record_pk ->> 'operationId' = p_operation_id::text
    and logs.record_pk ->> 'phase' = 'terminal'
  limit 1;

  if found then
    if terminal_record.actor_id is not distinct from normalized_actor_id
      and terminal_record.record_pk ->> 'templateId'
        is not distinct from normalized_template_id
      and terminal_record.record_pk ->> 'templateRevision'
        is not distinct from p_template_revision::text
      and terminal_record.after_row ->> 'schema'
        is not distinct from 'fcuno.outlook-template-insertion-audit/v2'
      and terminal_record.after_row ->> 'phase'
        is not distinct from 'terminal'
      and terminal_record.after_row ->> 'outcome'
        is not distinct from normalized_outcome
      and terminal_record.after_row ->> 'operationId'
        is not distinct from p_operation_id::text
      and terminal_record.after_row ->> 'templateId'
        is not distinct from normalized_template_id
      and terminal_record.after_row ->> 'templateRevision'
        is not distinct from p_template_revision::text
      and terminal_record.after_row ->> 'certificationRunId'
        is not distinct from p_certification_run_id::text
      and terminal_record.after_row ->> 'sourceFingerprint'
        is not distinct from normalized_fingerprint
      and terminal_record.after_row ->> 'reservationAuditLogId'
        is not distinct from reservation_record.id::text
    then
      return pg_catalog.jsonb_build_object(
        'completed', true,
        'idempotent', true,
        'auditLogId', terminal_record.id,
        'reservationAuditLogId', reservation_record.id,
        'outcome', normalized_outcome,
        'eventAt', terminal_record.occurred_at
      );
    end if;

    raise exception
      'OUTLOOK_INSERTION_TERMINAL_CONFLICT: operation already has a different terminal outcome.'
      using errcode = '23505';
  end if;

  event_time := pg_catalog.clock_timestamp();
  if reservation_record.occurred_at is null
    or reservation_record.occurred_at > event_time
    or reservation_record.occurred_at
      < event_time
        - pg_catalog.make_interval(secs => reservation_ttl_seconds)
  then
    raise exception
      'OUTLOOK_INSERTION_RESERVATION_EXPIRED: insertion reservations expire after 120 seconds.'
      using errcode = '55000';
  end if;

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
      'phase', 'terminal',
      'templateId', normalized_template_id,
      'templateRevision', p_template_revision
    ),
    array[]::text[],
    null,
    pg_catalog.jsonb_build_object(
      'schema', 'fcuno.outlook-template-insertion-audit/v2',
      'phase', 'terminal',
      'outcome', normalized_outcome,
      'operationId', p_operation_id,
      'templateId', normalized_template_id,
      'templateRevision', p_template_revision,
      'certificationRunId', p_certification_run_id,
      'sourceFingerprint', normalized_fingerprint,
      'reservationAuditLogId', reservation_record.id,
      'eventAt', event_time
    ),
    pg_catalog.jsonb_build_object(
      'pageId', 'email-templates',
      'pageLabel', 'OUTLOOK TEMPLATES',
      'pagePath', '/api/outlook-addin/taskpane',
      'action', 'outlook-draft-insertion-terminal',
      'auditPhase', 'terminal',
      'auditOutcome', normalized_outcome
    )
  )
  returning id into inserted_audit_log_id;

  return pg_catalog.jsonb_build_object(
    'completed', true,
    'idempotent', false,
    'auditLogId', inserted_audit_log_id,
    'reservationAuditLogId', reservation_record.id,
    'outcome', normalized_outcome,
    'eventAt', event_time
  );
end;
$$;

revoke all on function public.complete_outlook_template_insertion(
  uuid,
  text,
  bigint,
  uuid,
  text,
  text,
  text,
  text
)
  from public, anon, authenticated;
grant execute on function public.complete_outlook_template_insertion(
  uuid,
  text,
  bigint,
  uuid,
  text,
  text,
  text,
  text
)
  to service_role;
