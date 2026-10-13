-- One approved label correction; no country rename, price edit, or migration.
-- Exact versions fail closed if a colleague changed either record.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '15s';
select pg_catalog.pg_advisory_xact_lock_shared(730261052372033133::bigint);
lock table public.cc_countries in share row exclusive mode;
lock table public.cc_ports in share row exclusive mode;
select pg_catalog.set_config('app.audit_actor_id', 'codex-maintenance', true);
select pg_catalog.set_config('app.audit_actor_name', 'Codex maintenance approved by Otto Lai', true);
select pg_catalog.set_config('app.audit_correlation_id', 'bd906c1b-4a93-4cc2-bc11-4b852333a036', true);
select pg_catalog.set_config('app.audit_context', '{"pageId":"ccinfo","action":"approved_country_label_normalization","targetType":"cc_ports","targetId":"7c1d5d83-d99c-451d-92f9-372f6947c721","approvalReference":"Human approval in FCUNO sitewide debug, 2026-10-13: Yes, AMERICAN SAMOA","operator":"codex-maintenance"}', true);
do $repair$
declare
  country_row public.cc_countries%rowtype;
  prior_row public.cc_ports%rowtype;
  saved_row public.cc_ports%rowtype;
  row_audit public.audit_logs%rowtype;
  audit_count integer;
begin
  select * into country_row from public.cc_countries
  where id = 'f67e01dc-e68c-4b76-95a3-261779a62ce6' for key share;
  if not found or country_row.name is distinct from 'AMERICAN SAMOA'
    or country_row.updated_at is distinct from '2026-05-14 03:37:54.60614+00'::timestamptz then
    raise exception 'Country preflight changed; no repair applied.';
  end if;
  select * into prior_row from public.cc_ports
  where id = '7c1d5d83-d99c-451d-92f9-372f6947c721' for no key update;
  if not found or prior_row.name is distinct from 'PAGO PAGO'
    or prior_row.country_id is distinct from country_row.id
    or prior_row.country_name is distinct from 'SAMOA, AMERICAN'
    or prior_row.updated_at is distinct from '2026-05-14 03:43:28.163838+00'::timestamptz then
    raise exception 'Port preflight changed; no repair applied.';
  end if;
  update public.cc_ports set country_name = 'AMERICAN SAMOA'
  where id = prior_row.id and country_id = country_row.id
    and country_name = prior_row.country_name and updated_at = prior_row.updated_at
  returning * into saved_row;
  if not found or saved_row.country_name is distinct from country_row.name
    or saved_row.updated_at <= prior_row.updated_at
    or (to_jsonb(saved_row) - 'country_name' - 'updated_at')
       is distinct from (to_jsonb(prior_row) - 'country_name' - 'updated_at') then
    raise exception 'Returned row verification failed; repair rolled back.';
  end if;
  select count(*) into audit_count from public.audit_logs
  where request_context ->> 'correlationId' = 'bd906c1b-4a93-4cc2-bc11-4b852333a036';
  select * into row_audit from public.audit_logs
  where table_schema = 'public' and table_name = 'cc_ports'
    and record_pk ->> 'id' = prior_row.id::text
    and request_context ->> 'correlationId' = 'bd906c1b-4a93-4cc2-bc11-4b852333a036';
  if audit_count <> 1 or not found
    or row_audit.actor_id is distinct from 'codex-maintenance'
    or row_audit.operation is distinct from 'UPDATE'
    or row_audit.request_context ->> 'action' is distinct from 'approved_country_label_normalization'
    or row_audit.changed_fields is distinct from array['country_name']::text[]
    or row_audit.before_row is distinct from to_jsonb(prior_row)
    or row_audit.after_row is distinct from to_jsonb(saved_row) then
    raise exception 'Audit verification failed; repair rolled back.';
  end if;
  if not exists (select 1 from private.bunker_map_backup_mutations
    where transaction_id = pg_catalog.pg_current_xact_id()) then
    raise exception 'Backup fence verification failed; repair rolled back.';
  end if;
end;
$repair$;
commit;
select jsonb_build_object(
  'checkedAt', now(),
  'operationId', 'bd906c1b-4a93-4cc2-bc11-4b852333a036',
  'port', (select jsonb_build_object('id', id, 'name', name, 'countryId', country_id,
    'countryName', country_name, 'version', updated_at::text) from public.cc_ports
    where id = '7c1d5d83-d99c-451d-92f9-372f6947c721'),
  'audit', (select jsonb_build_object('id', id, 'actor', actor_id,
    'changedFields', changed_fields,
    'beforeCountryName', before_row ->> 'country_name',
    'afterCountryName', after_row ->> 'country_name',
    'otherFieldsUnchanged', (before_row - 'country_name' - 'updated_at') =
      (after_row - 'country_name' - 'updated_at'))
    from public.audit_logs where request_context ->> 'correlationId' = 'bd906c1b-4a93-4cc2-bc11-4b852333a036')
) as repair_receipt;
