-- Align template saves with the certified-map insertion policy installed on
-- 25 August: normal queued delivery is not a broken recipient certification.
-- This changes no template, recipient, audit, queue, or certification data.
set local lock_timeout = '3s';

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
  certified_at timestamptz;
  checked_at timestamptz;
begin
  -- Preserve the canonical writer lock/order and the existing row evidence
  -- trigger. A later certification cannot be substituted into this write.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('email_templates_canonical_write', 0)
  );
  truth := public.verify_outlook_exchange_truth_ledger();
  queue_state := coalesce(truth -> 'queue', '{}'::jsonb);
  expected_run_id := coalesce(truth ->> 'latestCertificationRunId', '');
  expected_certified_at := coalesce(truth ->> 'latestCertificationAt', '');
  expected_fingerprint := lower(coalesce(truth ->> 'latestSourceFingerprint', ''));
  checked_at := pg_catalog.clock_timestamp();
  begin
    certified_at := nullif(expected_certified_at, '')::timestamptz;
  exception when invalid_datetime_format or datetime_field_overflow then
    certified_at := null;
  end;
  if truth ->> 'valid' is distinct from 'true'
    or truth ->> 'integrityValid' is distinct from 'true'
    or truth ->> 'ledgerValid' is distinct from 'true'
    or truth ->> 'snapshotsValid' is distinct from 'true'
    or truth ->> 'referencesValid' is distinct from 'true'
    or truth ->> 'latestCertificationHasProjectionEvidence' is distinct from 'true'
    or lower(coalesce(truth ->> 'latestProjectionSnapshotSha256', '')) is distinct from expected_fingerprint
    or expected_run_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or expected_fingerprint !~ '^[0-9a-f]{64}$'
    or coalesce(queue_state ->> 'failed', '') is distinct from '0'
    or coalesce(queue_state ->> 'terminalFailed', '') is distinct from '0'
    or certified_at is null or not pg_catalog.isfinite(certified_at)
    or certified_at > checked_at + interval '5 minutes'
    or certified_at < checked_at - interval '36 hours'
  then
    raise exception 'OUTLOOK_TEMPLATE_TRUTH_UNAVAILABLE: certified Exchange recipients are unavailable or no longer safely current.' using errcode = '55000';
  end if;
  perform set_config('app.outlook_template_expected_run_id', expected_run_id, true);
  perform set_config('app.outlook_template_expected_certified_at', expected_certified_at, true);
  perform set_config('app.outlook_template_expected_fingerprint', expected_fingerprint, true);
  return null;
end;
$$;

-- Trigger-only execution; do not expose a service-backed arbitrary RPC.
revoke all on function private.prepare_outlook_template_truth_write()
  from public, anon, authenticated, service_role;
