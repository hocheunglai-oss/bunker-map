-- Request genuine full verification at24h, retaining the existing36h fail-closed
-- acceptance and every source/queue/lease/atomic-activation invariant.
set local lock_timeout = '3s';

do $preimage$
begin
  if (select md5(p.prosrc) from pg_catalog.pg_proc p
      where p.oid = pg_catalog.to_regprocedure('public.get_outlook_template_recipient_refresh_state(uuid)'))
    is distinct from 'babb4851a5732290c97ec3104c9a704a' then
    raise exception 'OUTLOOK_REFRESH_SOURCE_DRIFT: review the installed refresh-state function before replacement.' using errcode='55000';
  end if;
end;
$preimage$;

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
  refresh_due boolean := false;
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
    -- Renewal is requested before the unchanged36h acceptance expires. This
    -- selects genuine full read-only verification, never a timestamp refresh.
    if coalesce(current_certificate,false)
      and certification.certified_at <= clock_timestamp() - interval '24 hours' then
      refresh_due := true;
      reasons := reasons || '"certification-refresh-due"'::jsonb;
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
    if not coalesce(current_certificate,false) or refresh_due or pending_source or delivered_this_run or delivery_awaiting_verification then
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
