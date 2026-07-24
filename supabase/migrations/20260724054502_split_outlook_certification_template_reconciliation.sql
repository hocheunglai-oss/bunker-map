-- Keep the durable Exchange certification transaction small enough for the
-- production database, then reconcile derived Outlook-template evidence in a
-- separately retryable transaction.

create or replace function private.outlook_exchange_canonical_projection_has_exact_group_smtp(
  p_projection_canonical_json text
)
returns boolean
language plpgsql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
  projection jsonb;
begin
  projection := p_projection_canonical_json::jsonb;
  return public.outlook_exchange_projection_has_exact_group_smtp(projection);
exception
  when others then
    return false;
end;
$$;

revoke all on function
  private.outlook_exchange_canonical_projection_has_exact_group_smtp(text)
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
begin
  if not public.outlook_exchange_worker_supports_group_smtp(
    p_worker_version
  ) then
    raise exception
      'A fresh full certification from an Exchange worker that certifies exact group SMTP truth is required.';
  end if;

  -- Parse and release the guard copy before the legacy certification function
  -- parses the projection for its structural/count/hash checks. Keeping both
  -- multi-megabyte jsonb values alive at once caused an avoidable memory spike.
  if not private.outlook_exchange_canonical_projection_has_exact_group_smtp(
    p_projection_canonical_json
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

create or replace function public.record_outlook_exchange_certification_truth()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  snapshot_canonical_value text;
  snapshot_sha256_value text;
  counts_value jsonb;
  existing_snapshot public.outlook_exchange_truth_snapshots%rowtype;
  payload_value text;
begin
  -- Retain only the canonical text. The previous implementation held both the
  -- complete raw jsonb source and its text form for the rest of the trigger.
  snapshot_canonical_value :=
    public.outlook_exchange_raw_source_snapshot()::text;
  snapshot_sha256_value :=
    public.outlook_exchange_truth_sha256(snapshot_canonical_value);

  select jsonb_build_object(
    'contacts', (select count(*) from public.shared_addressbook_contacts),
    'groups', (select count(*) from public.shared_addressbook_groups),
    'members', (select count(*) from public.shared_addressbook_group_members)
  )
  into counts_value;

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

  select snapshot.* into existing_snapshot
  from public.outlook_exchange_truth_snapshots as snapshot
  where snapshot.snapshot_sha256 = snapshot_sha256_value;

  if existing_snapshot.canonical_json is distinct from snapshot_canonical_value
    or existing_snapshot.snapshot_kind <> 'fcuno_raw'
    or existing_snapshot.schema_version <> 1
    or existing_snapshot.byte_length <> octet_length(snapshot_canonical_value)
    or existing_snapshot.item_counts is distinct from counts_value
  then
    raise exception
      'A conflicting truth snapshot already uses SHA-256 %.',
      snapshot_sha256_value;
  end if;

  payload_value := jsonb_build_object(
    'schema', 'fcuno.exchange.full-certification/v1',
    'certification', to_jsonb(new),
    'rawSourceSnapshotSha256', snapshot_sha256_value,
    'rawSourceCounts', counts_value
  )::text;

  perform public.append_outlook_exchange_truth_event(
    'certification:' || new.run_id::text,
    'full_certification',
    new.certified_at,
    new.run_id,
    null,
    null,
    snapshot_sha256_value,
    payload_value
  );
  return new;
end;
$$;

revoke all on function public.record_outlook_exchange_certification_truth()
  from public, anon, authenticated, service_role;

-- Certification is the durable source-of-truth commit. Template recipient
-- evidence is derived state and must not be able to roll back or crash that
-- commit. The Azure worker invokes the idempotent RPC below immediately after
-- certification and retries it on ambiguous network responses.
drop trigger if exists reconcile_outlook_templates_after_projection
  on public.outlook_exchange_truth_snapshots;
drop trigger if exists reconcile_outlook_templates_after_certification
  on public.outlook_exchange_sync_certifications;

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
  if p_ref is null or pg_catalog.jsonb_typeof(p_ref) <> 'object' then
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
    candidate := p_projection #> array['contactIndex', source_id];
    if candidate is null then
      select item
      into candidate
      from pg_catalog.jsonb_array_elements(
        coalesce(p_projection -> 'contacts', '[]'::jsonb)
      ) as projected(item)
      where item ->> 'sourceContactId' = source_id
      limit 1;
    end if;

    projected_address := pg_catalog.btrim(
      candidate ->> 'externalEmailAddress'
    );
    resolved_address := pg_catalog.lower(projected_address);
    display_name := coalesce(
      nullif(pg_catalog.btrim(candidate ->> 'displayName'), ''),
      nullif(pg_catalog.btrim(candidate ->> 'directoryName'), ''),
      nullif(pg_catalog.btrim(p_ref ->> 'displayName'), ''),
      resolved_address
    );
  else
    candidate := p_projection #> array['groupIndex', source_id];
    if candidate is null then
      select item
      into candidate
      from pg_catalog.jsonb_array_elements(
        coalesce(p_projection -> 'groups', '[]'::jsonb)
      ) as projected(item)
      where item ->> 'sourceGroupId' = source_id
      limit 1;
    end if;

    projected_address := pg_catalog.btrim(candidate ->> 'smtpAddress');
    resolved_address := pg_catalog.lower(projected_address);
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
    return p_ref || pg_catalog.jsonb_build_object(
      'resolvedAddress', null,
      'status', 'missing'
    );
  end if;

  return p_ref || pg_catalog.jsonb_build_object(
    'displayName', display_name,
    'resolvedAddress', resolved_address,
    'status', 'resolved'
  );
end;
$$;

revoke all on function
  public.reconcile_outlook_template_recipient_ref(jsonb, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function
  public.reconcile_outlook_template_recipient_ref(jsonb, jsonb)
  to service_role;

create or replace function public.reconcile_outlook_templates_with_certification(
  p_run_id uuid,
  p_source_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  normalized_fingerprint text := lower(btrim(p_source_fingerprint));
  certification public.outlook_exchange_sync_certifications%rowtype;
  latest_certification public.outlook_exchange_sync_certifications%rowtype;
  projection_snapshot public.outlook_exchange_truth_snapshots%rowtype;
  projection jsonb;
  projection_index jsonb;
  reconciliation_verification jsonb;
  reconciled_at constant timestamptz := clock_timestamp();
  updated_count bigint := 0;
begin
  if p_run_id is null
    or normalized_fingerprint is null
    or normalized_fingerprint !~ '^[0-9a-f]{64}$'
  then
    raise exception
      'A valid certification run UUID and lowercase source fingerprint are required.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('email_templates_canonical_write', 0)
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
  if not found
    or not public.outlook_exchange_truth_snapshot_is_valid(
      projection_snapshot.snapshot_sha256,
      projection_snapshot.snapshot_kind,
      projection_snapshot.schema_version,
      projection_snapshot.canonical_json,
      projection_snapshot.byte_length,
      projection_snapshot.item_counts
    )
  then
    raise exception
      'Exchange certification % has no valid canonical projection snapshot.',
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

  projection := projection_snapshot.canonical_json::jsonb;
  select pg_catalog.jsonb_build_object(
    'contactIndex',
      coalesce(
        (
          select pg_catalog.jsonb_object_agg(
            item ->> 'sourceContactId',
            pg_catalog.jsonb_build_object(
              'displayName', item ->> 'displayName',
              'directoryName', item ->> 'directoryName',
              'externalEmailAddress', item ->> 'externalEmailAddress'
            )
          )
          from pg_catalog.jsonb_array_elements(
            projection -> 'contacts'
          ) as projected(item)
          where nullif(item ->> 'sourceContactId', '') is not null
        ),
        '{}'::jsonb
      ),
    'groupIndex',
      coalesce(
        (
          select pg_catalog.jsonb_object_agg(
            item ->> 'sourceGroupId',
            pg_catalog.jsonb_build_object(
              'groupName', item ->> 'groupName',
              'directoryName', item ->> 'directoryName',
              'smtpAddress', item ->> 'smtpAddress'
            )
          )
          from pg_catalog.jsonb_array_elements(
            projection -> 'groups'
          ) as projected(item)
          where nullif(item ->> 'sourceGroupId', '') is not null
        ),
        '{}'::jsonb
      )
  )
  into projection_index;

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
    pg_catalog.jsonb_build_object(
      'action', 'certified-projection-reconcile',
      'pageId', 'email-templates',
      'pageLabel', 'OUTLOOK TEMPLATES',
      'pagePath', '/admin/outlooktemplates',
      'certificationRunId', certification.run_id,
      'sourceFingerprint', normalized_fingerprint
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
  get diagnostics updated_count = row_count;

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

  return pg_catalog.jsonb_build_object(
    'reconciled', true,
    'idempotent', updated_count = 0,
    'reason', case
      when updated_count = 0
        then 'Outlook template recipient evidence already matches this certification.'
      else 'Outlook template recipient evidence was reconciled against this certification.'
    end,
    'runId', certification.run_id,
    'sourceFingerprint', normalized_fingerprint,
    'certifiedAt', certification.certified_at,
    'reconciledAt', reconciled_at,
    'updatedTemplates', updated_count,
    'verification', reconciliation_verification,
    'supersededCount', 0,
    'supersededRows', '[]'::jsonb
  );
end;
$$;

revoke all on function
  public.reconcile_outlook_templates_with_certification(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function
  public.reconcile_outlook_templates_with_certification(uuid, text)
  to service_role;

comment on function
  public.reconcile_outlook_templates_with_certification(uuid, text)
is
  'Idempotently reconciles Outlook-template recipient evidence after a separately committed Exchange certification.';
