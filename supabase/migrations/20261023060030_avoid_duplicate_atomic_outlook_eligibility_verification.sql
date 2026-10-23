-- The atomic hourly writer already runs the unchanged complete history proof
-- immediately before template rows and again after them. Its eligibility
-- recheck needs current server metadata, not a third complete history scan.
-- This hint is private, carries no truth-valid flag and is not a proof/cache.
-- The public refresh-state getter and both complete history checks are unchanged.
set local lock_timeout = '3s';

do $preimage$
begin
  if (select md5(prosrc) from pg_catalog.pg_proc where oid = pg_catalog.to_regprocedure(
    'private.certify_staged_outlook_truth_and_activate(text,uuid,bigint,timestamptz,text,text,jsonb,jsonb,jsonb,text)'))
    is distinct from 'b6b34be74a2be8b4bfbbaa690bed1394' then
    raise exception 'OUTLOOK_ATOMIC_REFRESH_SOURCE_DRIFT: review the installed atomic activation before replacement.' using errcode = '55000';
  end if;
end;
$preimage$;

create or replace function private.outlook_atomic_refresh_requires_full(p_run_id uuid)
returns boolean language plpgsql stable security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
  certification public.outlook_exchange_sync_certifications%rowtype;
  global_latest_run uuid;
  projection jsonb;
  worker_version text;
  has_projection_evidence boolean := false;
  current_certificate boolean := false;
  requires_full boolean := false;
  activation_payload jsonb;
  current_sequence bigint := 0;
  current_updated_at timestamptz;
  effective_sequence bigint;
  effective_updated_at timestamptz;
  invalid_reference record;
begin
  if p_run_id is null or not exists (
    select 1 from public.outlook_exchange_sync_lock
    where lock_name = 'addressbook' and run_id = p_run_id
      and sync_mode = 'incremental' and expires_at > clock_timestamp()
  ) then
    raise exception 'OUTLOOK_REFRESH_LEASE_REQUIRED: the current incremental run must own a live lease.' using errcode = 'P0001';
  end if;
  if exists(select 1 from public.outlook_exchange_sync_queue
    where status in ('pending','processing','failed')) then return false; end if;

  -- Provisional certificate insertion could otherwise heal a pre-existing
  -- dangling full-certification reference with this same run UUID. Preserve
  -- the original complete reference/orphan rejection BEFORE those writes.
  select ledger.ledger_sequence,
    case when ledger.audit_log_id is not null and logs.id is null then 'audit_log'
      when ledger.queue_row_id is not null and queue.id is null then 'queue_row'
      when ledger.event_type in ('full_certification','legacy_full_certification')
        and existing_certification.run_id is null then 'certification' end as reference_kind
  into invalid_reference
  from public.outlook_exchange_truth_ledger ledger
  left join public.audit_logs logs on logs.id = ledger.audit_log_id
  left join public.outlook_exchange_sync_queue queue on queue.id = ledger.queue_row_id
  left join public.outlook_exchange_sync_certifications existing_certification
    on existing_certification.run_id = ledger.run_id
  where (ledger.audit_log_id is not null and logs.id is null)
    or (ledger.queue_row_id is not null and queue.id is null)
    or (ledger.event_type in ('full_certification','legacy_full_certification')
      and existing_certification.run_id is null)
  order by ledger.ledger_sequence limit 1;
  if found or exists (
    select 1 from public.outlook_exchange_sync_certifications existing_certification
    where not exists(select 1 from public.outlook_exchange_truth_ledger ledger
      where ledger.run_id = existing_certification.run_id
        and ledger.event_type in ('full_certification','legacy_full_certification'))
  ) then
    raise exception 'OUTLOOK_REFRESH_TRUTH_INVALID: address-book evidence needs review before another verification can be certified.' using errcode = 'P0001';
  end if;

  select * into certification from public.outlook_exchange_sync_certifications
  order by certified_at desc,run_id desc limit 1;
  if not found then return true; end if;
  -- The legacy whole verifier deliberately has no run-ID tie breaker. A
  -- different SELECT target/plan must not guess its winner; the caller uses
  -- the unchanged public getter for this ambiguous (non-fast-path) case.
  if (select count(*)from public.outlook_exchange_sync_certifications
      where certified_at=certification.certified_at)>1 then return false; end if;
  -- Preserve the legacy verifier's tie selection as well as the getter's
  -- explicit run-ID tie breaker; do not silently broaden current certification.
  select run_id into global_latest_run from public.outlook_exchange_sync_certifications
  order by certified_at desc limit 1;
  select snapshot.canonical_json::jsonb,
    evidence.payload_canonical_json::jsonb ->> 'workerVersion',
    evidence.ledger_sequence is not null
  into projection,worker_version,has_projection_evidence
  from public.outlook_exchange_sync_certifications selected_certification
  left join public.outlook_exchange_truth_snapshots snapshot
    on snapshot.snapshot_sha256 = selected_certification.source_fingerprint
      and snapshot.snapshot_kind = 'fcuno_exchange_projection' and snapshot.schema_version = 1
  left join public.outlook_exchange_truth_ledger evidence
    on evidence.event_key = 'projection:' || selected_certification.run_id::text
      and evidence.event_type = 'full_projection_evidence'
      and evidence.snapshot_sha256 = selected_certification.source_fingerprint
  where selected_certification.run_id = global_latest_run;
  current_certificate := certification.sync_mode = 'full'
    and certification.run_id = global_latest_run
    and has_projection_evidence
    and coalesce(public.outlook_exchange_projection_has_exact_group_smtp(projection),false)
    and coalesce(public.outlook_exchange_worker_supports_group_smtp(worker_version),false)
    and certification.certified_at <= clock_timestamp() + interval '5 minutes'
    and certification.certified_at >= clock_timestamp() - interval '36 hours';
  requires_full := not coalesce(current_certificate,false)
    or certification.certified_at <= clock_timestamp() - interval '24 hours';
  if exists (
    select 1 from public.email_templates template,
      lateral jsonb_path_query(template.recipient_resolution,'$.refs.*[*]') refs(ref)
    where ((ref ->> 'kind' = 'contact' and exists(select 1 from public.shared_addressbook_contacts contact where contact.id = ref ->> 'sourceId'))
      or (ref ->> 'kind' = 'group' and exists(select 1 from public.shared_addressbook_groups source_group where source_group.id = ref ->> 'sourceId')))
      and private.outlook_template_source_is_pending(ref ->> 'kind',ref ->> 'sourceId',certification.run_id)
  ) then requires_full := true; end if;

  select queue.queue_sequence,queue.updated_at into current_sequence,current_updated_at
  from public.outlook_exchange_sync_queue queue
  order by queue.updated_at desc,queue.queue_sequence desc limit 1;
  if not found then current_sequence := 0; current_updated_at := null; end if;
  effective_sequence := certification.queue_high_water_sequence;
  effective_updated_at := certification.queue_high_water_updated_at;
  select payload_canonical_json::jsonb into activation_payload
  from public.outlook_exchange_truth_ledger
  where event_key = 'template-activation:' || certification.run_id::text
    and event_type = 'template_recipient_activation' and run_id = certification.run_id
    and snapshot_sha256 = certification.source_fingerprint;
  if found then
    if activation_payload ->> 'schema' is distinct from 'fcuno.outlook-template-recipient-activation/v1'
      or activation_payload ->> 'runId' is distinct from certification.run_id::text
      or activation_payload ->> 'sourceFingerprint' is distinct from certification.source_fingerprint
      or jsonb_typeof(activation_payload #> '{postActivationQueueFence,sequence}') is distinct from 'number'
      or activation_payload #>> '{postActivationQueueFence,sequence}' !~ '^[0-9]+$'
      or not (activation_payload -> 'postActivationQueueFence' ? 'updatedAt') then
      raise exception 'OUTLOOK_REFRESH_TRUTH_INVALID: the atomic activation queue receipt is malformed.' using errcode = 'P0001';
    end if;
    effective_sequence := (activation_payload #>> '{postActivationQueueFence,sequence}')::bigint;
    effective_updated_at := (activation_payload #>> '{postActivationQueueFence,updatedAt}')::timestamptz;
  end if;
  return requires_full or effective_sequence is distinct from current_sequence
    or effective_updated_at is distinct from current_updated_at;
end;
$$;

revoke all on function private.outlook_atomic_refresh_requires_full(uuid)
  from public,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION private.certify_staged_outlook_truth_and_activate(p_execution_mode text, p_run_id uuid, p_queue_high_water_sequence bigint, p_queue_high_water_updated_at timestamp with time zone, p_source_fingerprint text, p_raw_source_snapshot_hash text, p_projection_counts jsonb, p_raw_source_counts jsonb, p_verification_summary jsonb, p_worker_version text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
 SET lock_timeout TO '2s'
 SET statement_timeout TO '10s'
AS $function$
declare
  lease public.outlook_exchange_sync_lock%rowtype;
  prior_certification public.outlook_exchange_sync_certifications%rowtype;
  prior_projection public.outlook_exchange_truth_ledger%rowtype;
  prior_activation public.outlook_exchange_truth_ledger%rowtype;
  prior_payload jsonb;
  refresh_state jsonb;
  result jsonb;
  activation jsonb;
  post_queue_sequence bigint := 0;
  post_queue_updated_at timestamptz;
  started_at constant timestamptz := clock_timestamp();
begin
  if p_execution_mode is null or p_execution_mode not in ('full','incremental')
    or p_run_id is null
    or p_verification_summary ->> 'verificationScope' is distinct from 'full'
    or p_verification_summary ->> 'executionMode' is distinct from p_execution_mode
    or p_verification_summary -> 'readOnlyVerification' is distinct from to_jsonb(p_execution_mode = 'incremental')
  then
    raise exception 'OUTLOOK_REFRESH_SCOPE_INVALID: full verification must retain the actual delivery mode and read-only phase contract.' using errcode = '22023';
  end if;
  -- Serialize only duplicates of this exact run before checking its immutable
  -- receipt. A retry arriving before the original commit then either observes
  -- that receipt after commit or gets the honest local lock timeout to retry.
  perform pg_advisory_xact_lock(hashtextextended('outlook_atomic_activation:' || p_run_id::text,0));
  select * into prior_certification from public.outlook_exchange_sync_certifications where run_id = p_run_id;
  if found then
    select * into prior_projection from public.outlook_exchange_truth_ledger
    where event_key = 'projection:' || p_run_id::text and event_type = 'full_projection_evidence';
    if not found then
      raise exception 'OUTLOOK_REFRESH_REPLAY_CONFLICT: an existing run has no complete immutable verification receipt.' using errcode = 'P0001';
    end if;
    select * into prior_activation from public.outlook_exchange_truth_ledger
    where event_key = 'template-activation:' || p_run_id::text
      and event_type = 'template_recipient_activation'
      and run_id = p_run_id and snapshot_sha256 = lower(p_source_fingerprint);
    if not found then
      raise exception 'OUTLOOK_REFRESH_REPLAY_CONFLICT: an existing run has no complete immutable activation receipt.' using errcode = 'P0001';
    end if;
    activation := prior_activation.payload_canonical_json::jsonb;
    if activation ->> 'schema' is distinct from 'fcuno.outlook-template-recipient-activation/v1'
      or activation ->> 'runId' is distinct from p_run_id::text
      or activation ->> 'executionMode' is distinct from p_execution_mode
      or activation ->> 'sourceFingerprint' is distinct from lower(p_source_fingerprint)
      or activation -> 'templateReconciliation' -> 'reconciled' is distinct from 'true'::jsonb
      or activation #>> '{templateReconciliation,runId}' is distinct from p_run_id::text
      or activation #>> '{templateReconciliation,sourceFingerprint}' is distinct from lower(p_source_fingerprint)
    then
      raise exception 'OUTLOOK_REFRESH_REPLAY_CONFLICT: an existing activation receipt does not match this run.' using errcode = 'P0001';
    end if;
    prior_payload := prior_projection.payload_canonical_json::jsonb;
    if prior_payload -> 'verificationSummary' is distinct from p_verification_summary
      or prior_payload ->> 'workerVersion' is distinct from p_worker_version
      or prior_payload -> 'projectionCounts' is distinct from p_projection_counts
      or prior_payload ->> 'rawSourceSnapshotSha256' is distinct from lower(p_raw_source_snapshot_hash)
      or prior_certification.source_fingerprint is distinct from lower(p_source_fingerprint)
      or prior_certification.queue_high_water_sequence is distinct from p_queue_high_water_sequence
      or prior_certification.queue_high_water_updated_at is distinct from p_queue_high_water_updated_at
    then
      raise exception 'OUTLOOK_REFRESH_REPLAY_CONFLICT: an existing run cannot certify different evidence.' using errcode = 'P0001';
    end if;
    -- This invokes only the exact existing idempotent receipt path. It cannot
    -- mint a missing certification or projection after the lease is released.
    result := public.certify_staged_full_outlook_exchange_truth(
      p_run_id,p_queue_high_water_sequence,p_queue_high_water_updated_at,
      p_source_fingerprint,p_raw_source_snapshot_hash,p_projection_counts,
      p_raw_source_counts,p_verification_summary,p_worker_version);
    if result -> 'idempotent' is distinct from 'true'::jsonb then
      raise exception 'OUTLOOK_REFRESH_REPLAY_CONFLICT: replay did not confirm an existing receipt.' using errcode = 'P0001';
    end if;
    -- Return the original immutable receipt, never a guessed current result.
    -- Replaying an older run cannot rewrite templates after a later certificate.
    result := result || jsonb_build_object(
      'atomicTemplateActivation',true,
      'templateReconciliation',activation -> 'templateReconciliation');
  else
    -- Lease -> source -> queue -> ledger matches the certification lock path.
    -- Source writers never acquire this lease row after queue/ledger locks.
    select * into lease from public.outlook_exchange_sync_lock
    where lock_name = 'addressbook' for update;
    if not found or lease.run_id is distinct from p_run_id
      or lease.sync_mode is distinct from p_execution_mode
      or lease.expires_at <= clock_timestamp()
    then
      raise exception 'OUTLOOK_REFRESH_LEASE_REQUIRED: the exact delivery run must own a live matching-mode lease.' using errcode = 'P0001';
    end if;
    lock table public.shared_addressbook_contacts,public.shared_addressbook_groups,public.shared_addressbook_group_members in share mode;
    lock table public.outlook_exchange_sync_queue in share row exclusive mode;
    if p_execution_mode = 'incremental' then
      if exists(select 1 from public.outlook_exchange_sync_queue where status in ('pending','processing','failed')) then
        raise exception 'OUTLOOK_REFRESH_QUEUE_NOT_SETTLED: finish queued changes before certifying a full verification.' using errcode = 'P0001';
      end if;
      if not private.outlook_atomic_refresh_requires_full(p_run_id) then
        -- A no-op still preserves the original integrity error and a possible
        -- clock-boundary transition. Only genuine publishing work defers this
        -- redundant scan to the unchanged pre-row and final full proofs.
        refresh_state := public.get_outlook_template_recipient_refresh_state(p_run_id);
        if refresh_state ->> 'mode' is distinct from 'full' then
          raise exception 'OUTLOOK_REFRESH_NOT_NEEDED: the current certificate only needs derivative reconciliation or no work.' using errcode = 'P0001';
        end if;
      end if;
    end if;
    -- Preserve every existing full-projection, raw-source, count, queue fence,
    -- immutable evidence and idempotency validator. No delta or mutable map.
    result := public.certify_staged_full_outlook_exchange_truth(
      p_run_id,p_queue_high_water_sequence,p_queue_high_water_updated_at,
      p_source_fingerprint,p_raw_source_snapshot_hash,p_projection_counts,
      p_raw_source_counts,p_verification_summary,p_worker_version);
    if result -> 'certified' = 'true'::jsonb then
      -- The existing full-proof statement guard, projection validator, stable
      -- source-ID reconciliation, every row guard/version and audit stay active.
      -- A failure anywhere rolls back this certificate AND all template writes.
      activation := public.reconcile_outlook_templates_with_certification(
        p_run_id,lower(p_source_fingerprint));
      select queue.queue_sequence,queue.updated_at
      into post_queue_sequence,post_queue_updated_at
      from public.outlook_exchange_sync_queue queue
      order by queue.updated_at desc,queue.queue_sequence desc limit 1;
      if not found then post_queue_sequence := 0; post_queue_updated_at := null; end if;
      perform public.append_outlook_exchange_truth_event(
        'template-activation:' || p_run_id::text,
        'template_recipient_activation',clock_timestamp(),p_run_id,
        null,null,lower(p_source_fingerprint),
        jsonb_build_object(
          'schema','fcuno.outlook-template-recipient-activation/v1',
          'runId',p_run_id,'executionMode',p_execution_mode,'sourceFingerprint',lower(p_source_fingerprint),
          'postActivationQueueFence',jsonb_build_object('sequence',post_queue_sequence,'updatedAt',post_queue_updated_at),
          'templateReconciliation',activation)::text);
      result := result || jsonb_build_object(
        'atomicTemplateActivation',true,'templateReconciliation',activation);
    elsif p_execution_mode = 'incremental' then
      -- A rejected proof cannot silently bypass the original integrity error:
      -- no template UPDATE means neither of the full row-path guards ran.
      perform public.get_outlook_template_recipient_refresh_state(p_run_id);
    end if;
    -- The configured statement timeout is complemented by an explicit elapsed
    -- commit fence. No slow transaction is allowed to publish after its budget,
    -- even when its caller's top-level statement timer was configured earlier.
    if clock_timestamp() > started_at + interval '10 seconds' then
      raise exception 'OUTLOOK_REFRESH_ACTIVATION_TIMEOUT: atomic activation exceeded its commit budget.' using errcode = '57014';
    end if;
    if lease.expires_at <= clock_timestamp() then
      raise exception 'OUTLOOK_REFRESH_LEASE_REQUIRED: the delivery lease expired before activation was committed.' using errcode = 'P0001';
    end if;
  end if;
  return result || jsonb_build_object('verificationScope','full','executionMode',p_execution_mode,'readOnlyVerification',p_execution_mode = 'incremental');
end;
$function$
;
