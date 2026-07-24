-- Bound every expensive Exchange truth operation to its own transaction.
-- The final source-fenced certification consumes only immutable snapshot
-- metadata and small receipts, so a micro compute instance never has to retain
-- the raw FCUNO source and canonical Exchange projection in one transaction.

drop trigger if exists outlook_exchange_truth_certification
  on public.outlook_exchange_sync_certifications;

create or replace function public.stage_outlook_exchange_projection_snapshot(
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
  normalized_fingerprint text := lower(btrim(p_source_fingerprint));
  projection_value jsonb;
  expected_projection_counts jsonb;
  existing_snapshot public.outlook_exchange_truth_snapshots%rowtype;
  inserted_count bigint := 0;
begin
  if nullif(p_projection_canonical_json, '') is null
    or normalized_fingerprint !~ '^[0-9a-f]{64}$'
    or not public.outlook_exchange_worker_supports_group_smtp(
      p_worker_version
    )
    or p_projection_counts is null
    or p_verification_summary is null
    or jsonb_typeof(p_projection_counts) <> 'object'
    or jsonb_typeof(p_verification_summary) <> 'object'
  then
    raise exception
      'Canonical projection, lowercase fingerprint, supported worker, counts, and verification summary are required.';
  end if;

  -- This is the only transaction that parses the projection. It deliberately
  -- performs no raw-source snapshot work and no certification write.
  projection_value := p_projection_canonical_json::jsonb;
  if not public.outlook_exchange_projection_has_exact_group_smtp(
    projection_value
  )
    or jsonb_typeof(projection_value -> 'contacts') is distinct from 'array'
    or jsonb_typeof(projection_value -> 'groups') is distinct from 'array'
    or jsonb_typeof(projection_value -> 'members') is distinct from 'array'
    or jsonb_typeof(projection_value -> 'invalidContacts')
      is distinct from 'array'
    or jsonb_typeof(projection_value -> 'skippedInvalidContacts')
      is distinct from 'array'
    or jsonb_typeof(projection_value -> 'duplicateContacts')
      is distinct from 'array'
    or projection_value - array[
      'contacts',
      'groups',
      'members',
      'invalidContacts',
      'skippedInvalidContacts',
      'duplicateContacts'
    ] <> '{}'::jsonb
  then
    raise exception
      'Canonical projection must contain exactly the six expected arrays and exact lowercase group SMTP truth.';
  end if;

  expected_projection_counts := jsonb_build_object(
    'contacts', jsonb_array_length(projection_value -> 'contacts'),
    'groups', jsonb_array_length(projection_value -> 'groups'),
    'members', jsonb_array_length(projection_value -> 'members'),
    'invalidContacts',
      jsonb_array_length(projection_value -> 'invalidContacts'),
    'skippedInvalidContacts',
      jsonb_array_length(projection_value -> 'skippedInvalidContacts'),
    'duplicateContacts',
      jsonb_array_length(projection_value -> 'duplicateContacts')
  );
  if p_projection_counts <> expected_projection_counts then
    raise exception
      'Projection counts % do not match canonical projection counts %.',
      p_projection_counts,
      expected_projection_counts;
  end if;

  if p_verification_summary ->> 'status' <> 'match'
    or coalesce(
      (p_verification_summary ->> 'mismatchCount')::integer,
      -1
    ) <> 0
    or coalesce(
      (p_verification_summary ->> 'sourceFenceStable')::boolean,
      false
    ) is not true
    or lower(p_verification_summary ->> 'sourceFingerprint')
      is distinct from normalized_fingerprint
    or coalesce(
      (p_verification_summary ->> 'verifiedManagedContacts')::integer,
      -1
    ) <> (expected_projection_counts ->> 'contacts')::integer
    or coalesce(
      (p_verification_summary ->> 'verifiedManagedGroups')::integer,
      -1
    ) <> (expected_projection_counts ->> 'groups')::integer
    or coalesce(
      (p_verification_summary ->> 'verifiedMembershipGroups')::integer,
      -1
    ) <> (expected_projection_counts ->> 'groups')::integer
    or coalesce(
      (p_verification_summary ->> 'verifiedMemberships')::integer,
      -1
    ) <> (expected_projection_counts ->> 'members')::integer
  then
    raise exception
      'Verification summary does not certify an exact, stable projection match.';
  end if;

  if public.outlook_exchange_truth_sha256(p_projection_canonical_json)
    <> normalized_fingerprint
  then
    raise exception
      'Canonical projection SHA-256 does not match source fingerprint.';
  end if;

  insert into public.outlook_exchange_truth_snapshots (
    snapshot_sha256,
    snapshot_kind,
    canonical_json,
    byte_length,
    item_counts
  ) values (
    normalized_fingerprint,
    'fcuno_exchange_projection',
    p_projection_canonical_json,
    octet_length(p_projection_canonical_json),
    expected_projection_counts
  )
  on conflict (snapshot_sha256) do nothing;
  get diagnostics inserted_count = row_count;

  select snapshot.* into existing_snapshot
  from public.outlook_exchange_truth_snapshots as snapshot
  where snapshot.snapshot_sha256 = normalized_fingerprint;

  if existing_snapshot.snapshot_kind <> 'fcuno_exchange_projection'
    or existing_snapshot.schema_version <> 1
    or existing_snapshot.canonical_json is distinct from
      p_projection_canonical_json
    or existing_snapshot.byte_length <>
      octet_length(p_projection_canonical_json)
    or existing_snapshot.item_counts is distinct from
      expected_projection_counts
  then
    raise exception
      'A conflicting projection snapshot already uses SHA-256 %.',
      normalized_fingerprint;
  end if;

  return jsonb_build_object(
    'staged', true,
    'idempotent', inserted_count = 0,
    'reason', case
      when inserted_count = 0
        then 'The exact canonical Exchange projection was already staged.'
      else 'The exact canonical Exchange projection was staged.'
    end,
    'sourceFingerprint', normalized_fingerprint,
    'projectionSnapshotHash', normalized_fingerprint,
    'projectionCounts', expected_projection_counts,
    'workerVersion', p_worker_version,
    'supersededCount', 0,
    'supersededRows', '[]'::jsonb
  );
end;
$$;

revoke all on function
  public.stage_outlook_exchange_projection_snapshot(
    text,
    text,
    jsonb,
    jsonb,
    text
  )
  from public, anon, authenticated, service_role;
grant execute on function
  public.stage_outlook_exchange_projection_snapshot(
    text,
    text,
    jsonb,
    jsonb,
    text
  )
  to service_role;

create or replace function public.stage_outlook_exchange_raw_source_snapshot(
  p_run_id uuid,
  p_queue_high_water_sequence bigint,
  p_queue_high_water_updated_at timestamptz,
  p_source_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  normalized_fingerprint text := lower(btrim(p_source_fingerprint));
  current_high_water_sequence bigint := 0;
  current_high_water_updated_at timestamptz;
  snapshot_canonical_value text;
  snapshot_sha256_value text;
  counts_value jsonb;
  existing_snapshot public.outlook_exchange_truth_snapshots%rowtype;
  inserted_count bigint := 0;
begin
  if p_run_id is null
    or p_queue_high_water_sequence is null
    or normalized_fingerprint !~ '^[0-9a-f]{64}$'
  then
    raise exception
      'Run ID, queue high-water fence, and lowercase source fingerprint are required.';
  end if;

  -- The source locks make this raw snapshot correspond to one durable outbox
  -- fence. The final certification repeats the same fence check, so any source
  -- write between these transactions invalidates the run.
  lock table
    public.shared_addressbook_contacts,
    public.shared_addressbook_groups,
    public.shared_addressbook_group_members
  in share mode;
  lock table public.outlook_exchange_sync_queue in share row exclusive mode;

  select queue.queue_sequence, queue.updated_at
  into current_high_water_sequence, current_high_water_updated_at
  from public.outlook_exchange_sync_queue as queue
  order by queue.updated_at desc, queue.queue_sequence desc
  limit 1;
  if not found then
    current_high_water_sequence := 0;
    current_high_water_updated_at := null;
  end if;

  if current_high_water_sequence is distinct from
      p_queue_high_water_sequence
    or current_high_water_updated_at is distinct from
      p_queue_high_water_updated_at
  then
    return jsonb_build_object(
      'staged', false,
      'idempotent', false,
      'reason',
        'Queue high-water changed before raw source evidence was staged.',
      'runId', p_run_id,
      'sourceFingerprint', normalized_fingerprint,
      'rawSourceSnapshotHash', null,
      'rawSourceCounts', null,
      'supersededCount', 0,
      'supersededRows', '[]'::jsonb,
      'queueFence', jsonb_build_object(
        'expectedSequence', p_queue_high_water_sequence,
        'expectedUpdatedAt', p_queue_high_water_updated_at,
        'currentSequence', current_high_water_sequence,
        'currentUpdatedAt', current_high_water_updated_at
      )
    );
  end if;

  -- This is the only transaction that builds the raw FCUNO source JSON. It
  -- deliberately performs no projection parsing and no certification write.
  snapshot_canonical_value :=
    public.outlook_exchange_raw_source_snapshot()::text;
  snapshot_sha256_value :=
    public.outlook_exchange_truth_sha256(snapshot_canonical_value);
  counts_value := jsonb_build_object(
    'contacts', (select count(*) from public.shared_addressbook_contacts),
    'groups', (select count(*) from public.shared_addressbook_groups),
    'members',
      (select count(*) from public.shared_addressbook_group_members)
  );

  insert into public.outlook_exchange_truth_snapshots (
    snapshot_sha256,
    snapshot_kind,
    canonical_json,
    byte_length,
    item_counts
  ) values (
    snapshot_sha256_value,
    'fcuno_raw',
    snapshot_canonical_value,
    octet_length(snapshot_canonical_value),
    counts_value
  )
  on conflict (snapshot_sha256) do nothing;
  get diagnostics inserted_count = row_count;

  select snapshot.* into existing_snapshot
  from public.outlook_exchange_truth_snapshots as snapshot
  where snapshot.snapshot_sha256 = snapshot_sha256_value;

  if existing_snapshot.snapshot_kind <> 'fcuno_raw'
    or existing_snapshot.schema_version <> 1
    or existing_snapshot.canonical_json is distinct from
      snapshot_canonical_value
    or existing_snapshot.byte_length <> octet_length(
      snapshot_canonical_value
    )
    or existing_snapshot.item_counts is distinct from counts_value
  then
    raise exception
      'A conflicting raw source snapshot already uses SHA-256 %.',
      snapshot_sha256_value;
  end if;

  return jsonb_build_object(
    'staged', true,
    'idempotent', inserted_count = 0,
    'reason', case
      when inserted_count = 0
        then 'The exact raw FCUNO source snapshot was already staged.'
      else 'The exact raw FCUNO source snapshot was staged.'
    end,
    'runId', p_run_id,
    'sourceFingerprint', normalized_fingerprint,
    'rawSourceSnapshotHash', snapshot_sha256_value,
    'rawSourceCounts', counts_value,
    'supersededCount', 0,
    'supersededRows', '[]'::jsonb,
    'queueFence', jsonb_build_object(
      'expectedSequence', p_queue_high_water_sequence,
      'expectedUpdatedAt', p_queue_high_water_updated_at,
      'currentSequence', current_high_water_sequence,
      'currentUpdatedAt', current_high_water_updated_at
    )
  );
end;
$$;

revoke all on function
  public.stage_outlook_exchange_raw_source_snapshot(
    uuid,
    bigint,
    timestamptz,
    text
  )
  from public, anon, authenticated, service_role;
grant execute on function
  public.stage_outlook_exchange_raw_source_snapshot(
    uuid,
    bigint,
    timestamptz,
    text
  )
  to service_role;

create or replace function public.certify_staged_full_outlook_exchange_truth(
  p_run_id uuid,
  p_queue_high_water_sequence bigint,
  p_queue_high_water_updated_at timestamptz,
  p_source_fingerprint text,
  p_raw_source_snapshot_hash text,
  p_projection_counts jsonb,
  p_raw_source_counts jsonb,
  p_verification_summary jsonb,
  p_worker_version text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  normalized_fingerprint text := lower(btrim(p_source_fingerprint));
  normalized_raw_hash text := lower(btrim(p_raw_source_snapshot_hash));
  projection_snapshot public.outlook_exchange_truth_snapshots%rowtype;
  raw_snapshot public.outlook_exchange_truth_snapshots%rowtype;
  certification_result jsonb;
  certification_row public.outlook_exchange_sync_certifications%rowtype;
  certification_entry_result jsonb;
  projection_entry_result jsonb;
  certification_payload text;
  projection_payload text;
begin
  if p_run_id is null
    or p_queue_high_water_sequence is null
    or normalized_fingerprint !~ '^[0-9a-f]{64}$'
    or normalized_raw_hash !~ '^[0-9a-f]{64}$'
    or not public.outlook_exchange_worker_supports_group_smtp(
      p_worker_version
    )
    or p_projection_counts is null
    or p_raw_source_counts is null
    or p_verification_summary is null
    or jsonb_typeof(p_projection_counts) <> 'object'
    or jsonb_typeof(p_raw_source_counts) <> 'object'
    or jsonb_typeof(p_verification_summary) <> 'object'
  then
    raise exception
      'Staged certification requires a run, fence, immutable snapshot hashes, supported worker, counts, and verification summary.';
  end if;

  select snapshot.* into projection_snapshot
  from public.outlook_exchange_truth_snapshots as snapshot
  where snapshot.snapshot_sha256 = normalized_fingerprint
    and snapshot.snapshot_kind = 'fcuno_exchange_projection'
    and snapshot.schema_version = 1;
  if not found
    or projection_snapshot.item_counts is distinct from p_projection_counts
  then
    raise exception
      'The immutable staged Exchange projection does not match this certification.';
  end if;

  select snapshot.* into raw_snapshot
  from public.outlook_exchange_truth_snapshots as snapshot
  where snapshot.snapshot_sha256 = normalized_raw_hash
    and snapshot.snapshot_kind = 'fcuno_raw'
    and snapshot.schema_version = 1;
  if not found
    or raw_snapshot.item_counts is distinct from p_raw_source_counts
  then
    raise exception
      'The immutable staged raw FCUNO source does not match this certification.';
  end if;

  if p_verification_summary ->> 'status' <> 'match'
    or coalesce(
      (p_verification_summary ->> 'mismatchCount')::integer,
      -1
    ) <> 0
    or coalesce(
      (p_verification_summary ->> 'sourceFenceStable')::boolean,
      false
    ) is not true
    or lower(p_verification_summary ->> 'sourceFingerprint')
      is distinct from normalized_fingerprint
    or coalesce(
      (p_verification_summary ->> 'verifiedManagedContacts')::integer,
      -1
    ) <> (p_projection_counts ->> 'contacts')::integer
    or coalesce(
      (p_verification_summary ->> 'verifiedManagedGroups')::integer,
      -1
    ) <> (p_projection_counts ->> 'groups')::integer
    or coalesce(
      (p_verification_summary ->> 'verifiedMembershipGroups')::integer,
      -1
    ) <> (p_projection_counts ->> 'groups')::integer
    or coalesce(
      (p_verification_summary ->> 'verifiedMemberships')::integer,
      -1
    ) <> (p_projection_counts ->> 'members')::integer
  then
    raise exception
      'Verification summary does not certify the immutable staged projection.';
  end if;

  -- This transaction now performs only the source/outbox fence, certification
  -- row, and two small ledger receipts. It never parses either large snapshot.
  certification_result :=
    public.certify_full_outlook_exchange_sync_queue(
      p_run_id,
      p_queue_high_water_sequence,
      p_queue_high_water_updated_at,
      normalized_fingerprint
    );

  if not coalesce(
    (certification_result ->> 'certified')::boolean,
    false
  ) then
    return certification_result || jsonb_build_object(
      'runId', p_run_id,
      'evidenceRecorded', false,
      'truthLedgerSequence', null,
      'truthLedgerHash', null,
      'sourceSnapshotHash', null,
      'rawSourceSnapshotHash', null,
      'workerVersion', p_worker_version
    );
  end if;

  select certification.* into certification_row
  from public.outlook_exchange_sync_certifications as certification
  where certification.run_id = p_run_id;
  if not found then
    raise exception
      'Full certification % did not produce its durable row.',
      p_run_id;
  end if;

  certification_payload := jsonb_build_object(
    'schema', 'fcuno.exchange.full-certification/v1',
    'certification', to_jsonb(certification_row),
    'rawSourceSnapshotSha256', normalized_raw_hash,
    'rawSourceCounts', p_raw_source_counts
  )::text;
  certification_entry_result :=
    public.append_outlook_exchange_truth_event(
      'certification:' || p_run_id::text,
      'full_certification',
      certification_row.certified_at,
      p_run_id,
      null,
      null,
      normalized_raw_hash,
      certification_payload
    );

  projection_payload := jsonb_build_object(
    'schema', 'fcuno.exchange.projection-evidence/v1',
    'runId', p_run_id,
    'sourceFingerprint', normalized_fingerprint,
    'projectionSnapshotSha256', normalized_fingerprint,
    'rawSourceSnapshotSha256', normalized_raw_hash,
    'certificationLedgerSequence',
      certification_entry_result -> 'ledgerSequence',
    'certificationLedgerSha256',
      certification_entry_result -> 'entrySha256',
    'projectionCounts', p_projection_counts,
    'verificationSummary', p_verification_summary,
    'workerVersion', p_worker_version
  )::text;
  projection_entry_result :=
    public.append_outlook_exchange_truth_event(
      'projection:' || p_run_id::text,
      'full_projection_evidence',
      certification_row.certified_at,
      p_run_id,
      null,
      null,
      normalized_fingerprint,
      projection_payload
    );

  return certification_result || jsonb_build_object(
    'runId', p_run_id,
    'sourceFingerprint', normalized_fingerprint,
    'evidenceRecorded', true,
    'truthLedgerSequence',
      projection_entry_result -> 'ledgerSequence',
    'truthLedgerHash', projection_entry_result -> 'entrySha256',
    'sourceSnapshotHash', normalized_fingerprint,
    'rawSourceSnapshotHash', normalized_raw_hash,
    'workerVersion', p_worker_version
  );
end;
$$;

revoke all on function
  public.certify_staged_full_outlook_exchange_truth(
    uuid,
    bigint,
    timestamptz,
    text,
    text,
    jsonb,
    jsonb,
    jsonb,
    text
  )
  from public, anon, authenticated, service_role;
grant execute on function
  public.certify_staged_full_outlook_exchange_truth(
    uuid,
    bigint,
    timestamptz,
    text,
    text,
    jsonb,
    jsonb,
    jsonb,
    text
  )
  to service_role;

comment on function public.stage_outlook_exchange_projection_snapshot(
  text,
  text,
  jsonb,
  jsonb,
  text
) is
  'Validates and stores one immutable Exchange projection without raw-source or certification work.';
comment on function public.stage_outlook_exchange_raw_source_snapshot(
  uuid,
  bigint,
  timestamptz,
  text
) is
  'Stores one source-fenced immutable raw FCUNO snapshot without projection or certification work.';
comment on function public.certify_staged_full_outlook_exchange_truth(
  uuid,
  bigint,
  timestamptz,
  text,
  text,
  jsonb,
  jsonb,
  jsonb,
  text
) is
  'Commits a source-fenced full certification using previously validated immutable snapshots and small ledger receipts only.';

create or replace function public.reconcile_outlook_templates_with_certification_batch(
  p_run_id uuid,
  p_source_fingerprint text,
  p_batch_limit integer default 25
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  normalized_fingerprint text := lower(btrim(p_source_fingerprint));
  bounded_limit integer := greatest(1, least(coalesce(p_batch_limit, 25), 50));
  certification public.outlook_exchange_sync_certifications%rowtype;
  latest_certification public.outlook_exchange_sync_certifications%rowtype;
  projection_snapshot public.outlook_exchange_truth_snapshots%rowtype;
  projection jsonb;
  projection_index jsonb;
  selected_ids text[];
  selected_count bigint := 0;
  updated_count bigint := 0;
  remaining_count bigint := 0;
  current_count bigint := 0;
  reconciliation_verification jsonb;
  reconciled_at constant timestamptz := clock_timestamp();
begin
  if p_run_id is null
    or normalized_fingerprint !~ '^[0-9a-f]{64}$'
  then
    raise exception
      'A valid certification run UUID and lowercase source fingerprint are required.';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('email_templates_canonical_write', 0)
  );

  select row_value.* into certification
  from public.outlook_exchange_sync_certifications as row_value
  where row_value.run_id = p_run_id
    and lower(row_value.source_fingerprint) = normalized_fingerprint;
  if not found then
    raise exception
      'Exchange certification % with source fingerprint % does not exist.',
      p_run_id,
      normalized_fingerprint;
  end if;

  select row_value.* into latest_certification
  from public.outlook_exchange_sync_certifications as row_value
  order by row_value.certified_at desc, row_value.run_id desc
  limit 1;
  if latest_certification.run_id is distinct from certification.run_id
    or lower(latest_certification.source_fingerprint)
      is distinct from normalized_fingerprint
  then
    raise exception
      'Exchange certification % is no longer the latest source truth.',
      p_run_id;
  end if;

  select snapshot.* into projection_snapshot
  from public.outlook_exchange_truth_snapshots as snapshot
  where snapshot.snapshot_sha256 = normalized_fingerprint
    and snapshot.snapshot_kind = 'fcuno_exchange_projection'
    and snapshot.schema_version = 1;
  if not found then
    raise exception
      'Exchange certification % has no immutable canonical projection snapshot.',
      p_run_id;
  end if;

  if not exists (
    select 1
    from public.outlook_exchange_truth_ledger as ledger
    where ledger.event_key = 'projection:' || p_run_id::text
      and ledger.event_type = 'full_projection_evidence'
      and ledger.snapshot_sha256 = normalized_fingerprint
  ) then
    raise exception
      'Exchange certification % has no durable projection evidence receipt.',
      p_run_id;
  end if;

  -- Each call parses the immutable projection but updates at most 25 templates.
  -- This bounds audit-trigger work and row-version memory on micro compute.
  projection := projection_snapshot.canonical_json::jsonb;
  select jsonb_build_object(
    'contactIndex',
      coalesce(
        (
          select jsonb_object_agg(
            item ->> 'sourceContactId',
            jsonb_build_object(
              'displayName', item ->> 'displayName',
              'directoryName', item ->> 'directoryName',
              'externalEmailAddress', item ->> 'externalEmailAddress'
            )
          )
          from jsonb_array_elements(
            projection -> 'contacts'
          ) as projected(item)
          where nullif(item ->> 'sourceContactId', '') is not null
        ),
        '{}'::jsonb
      ),
    'groupIndex',
      coalesce(
        (
          select jsonb_object_agg(
            item ->> 'sourceGroupId',
            jsonb_build_object(
              'groupName', item ->> 'groupName',
              'directoryName', item ->> 'directoryName',
              'smtpAddress', item ->> 'smtpAddress'
            )
          )
          from jsonb_array_elements(
            projection -> 'groups'
          ) as projected(item)
          where nullif(item ->> 'sourceGroupId', '') is not null
        ),
        '{}'::jsonb
      )
  )
  into projection_index;

  select coalesce(array_agg(candidate.id order by candidate.id), '{}'::text[])
  into selected_ids
  from (
    select template.id
    from public.email_templates as template
    where not coalesce(
        (template.recipient_resolution ->> 'reconciliationRequired')::boolean,
        false
      )
      and (
        lower(template.recipient_resolution ->> 'sourceFingerprint')
          is distinct from normalized_fingerprint
        or template.recipient_resolution ->> 'certificationRunId'
          is distinct from certification.run_id::text
        or (template.recipient_resolution ->> 'certifiedAt')::timestamptz
          is distinct from certification.certified_at
      )
    order by template.id
    limit bounded_limit
  ) as candidate;
  selected_count := coalesce(cardinality(selected_ids), 0);

  if selected_count > 0 then
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
        'action', 'certified-projection-reconcile-batch',
        'pageId', 'email-templates',
        'pageLabel', 'OUTLOOK TEMPLATES',
        'pagePath', '/admin/outlooktemplates',
        'certificationRunId', certification.run_id,
        'sourceFingerprint', normalized_fingerprint,
        'batchLimit', bounded_limit
      )::text,
      true
    );

    update public.email_templates as template
    set recipient_resolution =
      public.reconcile_outlook_template_resolution(
        template.recipient_resolution,
        projection_index,
        certification.run_id,
        certification.certified_at,
        normalized_fingerprint,
        reconciled_at
      )
    where template.id = any(selected_ids);
    get diagnostics updated_count = row_count;
  end if;

  select count(*) into remaining_count
  from public.email_templates as template
  where not coalesce(
      (template.recipient_resolution ->> 'reconciliationRequired')::boolean,
      false
    )
    and (
      lower(template.recipient_resolution ->> 'sourceFingerprint')
        is distinct from normalized_fingerprint
      or template.recipient_resolution ->> 'certificationRunId'
        is distinct from certification.run_id::text
      or (template.recipient_resolution ->> 'certifiedAt')::timestamptz
        is distinct from certification.certified_at
    );

  select count(*) into current_count
  from public.email_templates as template
  where not coalesce(
      (template.recipient_resolution ->> 'reconciliationRequired')::boolean,
      false
    )
    and lower(template.recipient_resolution ->> 'sourceFingerprint')
      = normalized_fingerprint
    and template.recipient_resolution ->> 'certificationRunId'
      = certification.run_id::text
    and (template.recipient_resolution ->> 'certifiedAt')::timestamptz
      = certification.certified_at;

  if remaining_count = 0 then
    reconciliation_verification :=
      public.verify_outlook_template_recipient_truth();
    if reconciliation_verification ->> 'valid' is distinct from 'true'
      or reconciliation_verification ->> 'sourceTruthValid'
        is distinct from 'true'
      or reconciliation_verification ->> 'certificationRunId'
        is distinct from certification.run_id::text
      or lower(reconciliation_verification ->> 'sourceFingerprint')
        is distinct from normalized_fingerprint
      or coalesce(
        (reconciliation_verification #>> '{templates,unresolved}')::bigint,
        -1
      ) <> 0
      or coalesce(
        (reconciliation_verification #>> '{templates,stale}')::bigint,
        -1
      ) <> 0
      or coalesce(
        (reconciliation_verification #>> '{templates,invalidShape}')::bigint,
        -1
      ) <> 0
    then
      raise exception
        'Outlook template recipient evidence did not settle on certification %.',
        certification.run_id;
    end if;
  end if;

  return jsonb_build_object(
    'processed', true,
    'idempotent', selected_count = 0,
    'reason', case
      when remaining_count = 0 and selected_count = 0
        then 'Outlook template recipient evidence already matches this certification.'
      when remaining_count = 0
        then 'Outlook template recipient evidence is fully reconciled.'
      else 'One bounded Outlook template recipient batch was reconciled.'
    end,
    'runId', certification.run_id,
    'sourceFingerprint', normalized_fingerprint,
    'certifiedAt', certification.certified_at,
    'reconciledAt', reconciled_at,
    'complete', remaining_count = 0,
    'currentTemplates', current_count,
    'remainingTemplates', remaining_count,
    'verification', reconciliation_verification,
    'batch', jsonb_build_object(
      'limit', bounded_limit,
      'selected', selected_count,
      'updated', updated_count
    ),
    'supersededCount', 0,
    'supersededRows', '[]'::jsonb
  );
end;
$$;

revoke all on function
  public.reconcile_outlook_templates_with_certification_batch(
    uuid,
    text,
    integer
  )
  from public, anon, authenticated, service_role;
grant execute on function
  public.reconcile_outlook_templates_with_certification_batch(
    uuid,
    text,
    integer
  )
  to service_role;

revoke all on function
  public.reconcile_outlook_templates_with_certification(uuid, text)
  from public, anon, authenticated, service_role;

comment on function
  public.reconcile_outlook_templates_with_certification_batch(
    uuid,
    text,
    integer
  )
is
  'Reconciles at most 50 Outlook templates per transaction and returns a retry-safe completion receipt.';
