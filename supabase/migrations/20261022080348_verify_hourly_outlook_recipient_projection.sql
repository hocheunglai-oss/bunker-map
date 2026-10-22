-- Hourly delivery remains incremental. Only a genuine full, read-only Exchange
-- verification may publish a new full-scope certificate; a derivative-only
-- retry reuses the existing certificate and cannot refresh its age. A new
-- hourly certificate and every derived template are activated in one atomic
-- transaction, so no reader can observe a new map with half-updated templates.
set local lock_timeout = '3s';

create or replace function public.get_outlook_template_recipient_refresh_state(p_run_id uuid)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, pg_temp
set statement_timeout = '20s'
as $$
declare
  lease public.outlook_exchange_sync_lock%rowtype;
  certification public.outlook_exchange_sync_certifications%rowtype;
  truth jsonb;
  mode text := 'none';
  reasons jsonb := '[]'::jsonb;
  settled boolean;
  current_certificate boolean := false;
  pending_source boolean := false;
  delivered_this_run boolean := false;
  delivery_awaiting_verification boolean := false;
  current_high_water_sequence bigint := 0;
  current_high_water_updated_at timestamptz;
  effective_high_water_sequence bigint;
  effective_high_water_updated_at timestamptz;
  activation_payload jsonb;
  stale_templates boolean := false;
begin
  select * into lease from public.outlook_exchange_sync_lock
  where lock_name = 'addressbook' and run_id = p_run_id
    and sync_mode = 'incremental' and expires_at > clock_timestamp();
  if p_run_id is null or not found then
    raise exception 'OUTLOOK_REFRESH_LEASE_REQUIRED: the current incremental run must own a live lease.' using errcode = 'P0001';
  end if;
  select not exists(select 1 from public.outlook_exchange_sync_queue
    where status in ('pending','processing','failed')) into settled;
  select * into certification from public.outlook_exchange_sync_certifications
  order by certified_at desc, run_id desc limit 1;
  if not settled then
    reasons := '["queue-not-settled"]'::jsonb;
  else
    truth := public.verify_outlook_exchange_truth_ledger();
    if truth ->> 'integrityValid' is distinct from 'true'
      or truth ->> 'ledgerValid' is distinct from 'true'
      or truth ->> 'snapshotsValid' is distinct from 'true'
      or truth ->> 'referencesValid' is distinct from 'true'
    then
      raise exception 'OUTLOOK_REFRESH_TRUTH_INVALID: address-book evidence needs review before another verification can be certified.' using errcode = 'P0001';
    end if;
    current_certificate := certification.run_id is not null
      and certification.sync_mode = 'full'
      and truth ->> 'valid' = 'true'
      and truth ->> 'latestCertificationHasProjectionEvidence' = 'true'
      and truth ->> 'latestCertificationRunId' = certification.run_id::text
      and lower(truth ->> 'latestSourceFingerprint') = lower(certification.source_fingerprint)
      and lower(truth ->> 'latestProjectionSnapshotSha256') = lower(certification.source_fingerprint)
      and nullif(truth ->> 'latestCertificationAt','')::timestamptz = certification.certified_at
      and certification.certified_at <= clock_timestamp() + interval '5 minutes'
      and certification.certified_at >= clock_timestamp() - interval '36 hours';
    if certification.run_id is null then
      reasons := reasons || '"certification-missing"'::jsonb;
    elsif certification.certified_at < clock_timestamp() - interval '36 hours' then
      reasons := reasons || '"certification-expired"'::jsonb;
    elsif not coalesce(current_certificate,false) then
      reasons := reasons || '"certification-unavailable"'::jsonb;
    end if;
    if certification.run_id is not null then
      -- Only an existing bound source can require a new projection. A deleted
      -- legacy source or a genuinely unresolved literal must not loop forever.
      select exists(
        select 1 from public.email_templates t,
          lateral jsonb_path_query(t.recipient_resolution,'$.refs.*[*]') refs(ref)
        where ((ref ->> 'kind' = 'contact' and exists(select 1 from public.shared_addressbook_contacts c where c.id = ref ->> 'sourceId'))
          or (ref ->> 'kind' = 'group' and exists(select 1 from public.shared_addressbook_groups g where g.id = ref ->> 'sourceId')))
          and private.outlook_template_source_is_pending(ref ->> 'kind',ref ->> 'sourceId',certification.run_id)
      ) into pending_source;
      if pending_source then reasons := reasons || '"source-updated"'::jsonb; end if;
    end if;
    -- Use the same canonical outbox fence as the original full certificate.
    -- This also recovers a prior run that delivered an UNBOUND contact but
    -- stopped before verification. The new wrapper starts with a settled queue,
    -- so certifying it cannot supersede or rewrite any completed/skipped row.
    select queue.queue_sequence,queue.updated_at
    into current_high_water_sequence,current_high_water_updated_at
    from public.outlook_exchange_sync_queue queue
    order by queue.updated_at desc,queue.queue_sequence desc limit 1;
    if not found then current_high_water_sequence := 0; current_high_water_updated_at := null; end if;
    effective_high_water_sequence := certification.queue_high_water_sequence;
    effective_high_water_updated_at := certification.queue_high_water_updated_at;
    -- A genuine full delivery may supersede terminal failures inside its own
    -- source-fenced transaction. Only its immutable atomic activation receipt
    -- can account for those server-observed queue timestamps. A later queue
    -- change still differs, and the original proof fence is never rewritten.
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
        or not (activation_payload -> 'postActivationQueueFence' ? 'updatedAt')
      then
        raise exception 'OUTLOOK_REFRESH_TRUTH_INVALID: the atomic activation queue receipt is malformed.' using errcode = 'P0001';
      end if;
      effective_high_water_sequence := (activation_payload #>> '{postActivationQueueFence,sequence}')::bigint;
      effective_high_water_updated_at := (activation_payload #>> '{postActivationQueueFence,updatedAt}')::timestamptz;
    end if;
    delivery_awaiting_verification := certification.run_id is not null
      and (effective_high_water_sequence is distinct from current_high_water_sequence
        or effective_high_water_updated_at is distinct from current_high_water_updated_at);
    select (certification.run_id is null or delivery_awaiting_verification)
      and exists(select 1 from public.outlook_exchange_sync_queue
        where run_id = p_run_id and status = 'completed' and exchange_verified_at is not null)
    into delivered_this_run;
    if delivered_this_run then reasons := reasons || '"delivery-completed"'::jsonb; end if;
    if delivery_awaiting_verification then reasons := reasons || '"delivery-awaiting-verification"'::jsonb; end if;
    if not coalesce(current_certificate,false) or pending_source or delivered_this_run or delivery_awaiting_verification then
      mode := 'full';
    else
      select exists(select 1 from public.email_templates t
        where not coalesce((t.recipient_resolution ->> 'reconciliationRequired')::boolean,false)
          and (t.recipient_resolution ->> 'certificationRunId' is distinct from certification.run_id::text
            or lower(t.recipient_resolution ->> 'sourceFingerprint') is distinct from lower(certification.source_fingerprint)
            or nullif(t.recipient_resolution ->> 'certifiedAt','')::timestamptz is distinct from certification.certified_at)
      ) into stale_templates;
      if stale_templates then
        mode := 'reconcile';
        reasons := reasons || '"template-certification-stale"'::jsonb;
      end if;
    end if;
  end if;
  return jsonb_build_object(
    'schema','fcuno.outlook-template-recipient-refresh-state/v1',
    'runId',p_run_id,'executionMode','incremental','verificationScope','full',
    'mode',mode,'queueSettled',settled,'reasons',reasons,
    'certificationRunId',certification.run_id,
    'sourceFingerprint',lower(certification.source_fingerprint),
    'certifiedAt',certification.certified_at
  );
end;
$$;

create or replace function private.certify_staged_outlook_truth_and_activate(
  p_execution_mode text,
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
returns jsonb language plpgsql volatile security invoker
set search_path = pg_catalog, pg_temp
set lock_timeout = '2s'
set statement_timeout = '10s'
as $$
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
      refresh_state := public.get_outlook_template_recipient_refresh_state(p_run_id);
      if refresh_state ->> 'mode' is distinct from 'full' then
        raise exception 'OUTLOOK_REFRESH_NOT_NEEDED: the current certificate only needs derivative reconciliation or no work.' using errcode = 'P0001';
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
$$;

-- Constant-mode server-only entry points. The private shared implementation is
-- not executable by any browser/service role and accepts no caller proof bypass.
create or replace function public.certify_staged_read_only_outlook_exchange_truth(
  p_run_id uuid,p_queue_high_water_sequence bigint,p_queue_high_water_updated_at timestamptz,
  p_source_fingerprint text,p_raw_source_snapshot_hash text,p_projection_counts jsonb,
  p_raw_source_counts jsonb,p_verification_summary jsonb,p_worker_version text
)
returns jsonb language sql volatile security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '2s'
set statement_timeout = '10s'
as $$
  select private.certify_staged_outlook_truth_and_activate('incremental',
    p_run_id,p_queue_high_water_sequence,p_queue_high_water_updated_at,
    p_source_fingerprint,p_raw_source_snapshot_hash,p_projection_counts,
    p_raw_source_counts,p_verification_summary,p_worker_version);
$$;

create or replace function public.certify_staged_full_outlook_exchange_truth_and_activate_templates(
  p_run_id uuid,p_queue_high_water_sequence bigint,p_queue_high_water_updated_at timestamptz,
  p_source_fingerprint text,p_raw_source_snapshot_hash text,p_projection_counts jsonb,
  p_raw_source_counts jsonb,p_verification_summary jsonb,p_worker_version text
)
returns jsonb language sql volatile security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '2s'
set statement_timeout = '10s'
as $$
  select private.certify_staged_outlook_truth_and_activate('full',
    p_run_id,p_queue_high_water_sequence,p_queue_high_water_updated_at,
    p_source_fingerprint,p_raw_source_snapshot_hash,p_projection_counts,
    p_raw_source_counts,p_verification_summary,p_worker_version);
$$;

revoke all on function private.certify_staged_outlook_truth_and_activate(text,uuid,bigint,timestamptz,text,text,jsonb,jsonb,jsonb,text)
from public,anon,authenticated,service_role;

revoke all on function public.get_outlook_template_recipient_refresh_state(uuid),
  public.certify_staged_read_only_outlook_exchange_truth(uuid,bigint,timestamptz,text,text,jsonb,jsonb,jsonb,text),
  public.certify_staged_full_outlook_exchange_truth_and_activate_templates(uuid,bigint,timestamptz,text,text,jsonb,jsonb,jsonb,text)
from public,anon,authenticated,service_role;
grant execute on function public.get_outlook_template_recipient_refresh_state(uuid),
  public.certify_staged_read_only_outlook_exchange_truth(uuid,bigint,timestamptz,text,text,jsonb,jsonb,jsonb,text),
  public.certify_staged_full_outlook_exchange_truth_and_activate_templates(uuid,bigint,timestamptz,text,text,jsonb,jsonb,jsonb,text)
to service_role;

comment on function public.get_outlook_template_recipient_refresh_state(uuid) is
  'Server-only aggregate full-verification or derivative-reconciliation work hint for the exact live incremental run; no recipient bodies or source identities.';
comment on function public.certify_staged_read_only_outlook_exchange_truth(uuid,bigint,timestamptz,text,text,jsonb,jsonb,jsonb,text) is
  'Atomically certifies genuine full-scope read-only Exchange verification and reconciles all templates for a live incremental run; unchanged full-proof validators, strict commit budget and immutable exact replay receipt.';
comment on function public.certify_staged_full_outlook_exchange_truth_and_activate_templates(uuid,bigint,timestamptz,text,text,jsonb,jsonb,jsonb,text) is
  'Atomically activates genuine full-delivery certification and all derived templates under the exact live full-mode lease; preserves the original full source/outbox fence and terminal supersession rules.';
