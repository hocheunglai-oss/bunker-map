-- Keep both complete pre-row/post-row history proofs. Rehash every current
-- canonical snapshot byte and check its length on every proof, while letting
-- PostgreSQL maintain the unchanged immutable shape/count predicate as an index.
-- This avoids reparsing ~200 MB of historical JSON twice per activation.
--
-- The index adds no data columns, caches, privileges, leases or certification
-- shortcuts. Index maintenance runs for writes even when user triggers are
-- disabled. A sequential-plan fallback remains correct, merely slower.
-- Normal CREATE INDEX takes SHARE, which permits SELECT/Outlook readers;
-- lock acquisition and this migration's own work are bounded below. No runtime
-- RPC timeout, global setting, historical row, or backup column contract changes.
set local lock_timeout = '2s';
set local statement_timeout = '20s';
set local search_path = pg_catalog, pg_temp;

do $snapshot_validation_index$
declare
  verifier_oid oid := to_regprocedure('public.verify_outlook_exchange_truth_ledger_without_group_smtp_guard()');
  wrapper_oid oid := to_regprocedure('public.verify_outlook_exchange_truth_ledger()');
  validator_oid oid := to_regprocedure('public.outlook_exchange_truth_snapshot_is_valid(text,text,integer,text,bigint,jsonb)');
  verifier_before jsonb;
  wrapper_before jsonb;
  validator_before jsonb;
  expected_verifier_body text;
  expected_wrapper_body text;
  definition text;
  expected_index constant text := 'CREATE INDEX outlook_exchange_truth_invalid_snapshot_v1_idx ON public.outlook_exchange_truth_snapshots USING btree (created_at, snapshot_sha256) WHERE (NOT public.outlook_exchange_truth_snapshot_is_valid(snapshot_sha256, snapshot_kind, schema_version, canonical_json, byte_length, item_counts))';
  before_scan constant text := $before$  invalid_snapshot as (
    select snapshot.snapshot_sha256
    from public.outlook_exchange_truth_snapshots as snapshot
    where not public.outlook_exchange_truth_snapshot_is_valid(
      snapshot.snapshot_sha256,
      snapshot.snapshot_kind,
      snapshot.schema_version,
      snapshot.canonical_json,
      snapshot.byte_length,
      snapshot.item_counts
    )
    order by snapshot.created_at, snapshot.snapshot_sha256
    limit 1
  ),$before$;
  after_scan constant text := $after$  invalid_snapshot as (
    select candidate.snapshot_sha256 from (
      (select snapshot.snapshot_sha256,snapshot.created_at
       from public.outlook_exchange_truth_snapshots snapshot
       where snapshot.snapshot_sha256 is distinct from public.outlook_exchange_truth_sha256(snapshot.canonical_json)
          or snapshot.byte_length is distinct from octet_length(snapshot.canonical_json)
       order by snapshot.created_at,snapshot.snapshot_sha256 limit 1)
      union all
      (select snapshot.snapshot_sha256,snapshot.created_at
       from public.outlook_exchange_truth_snapshots snapshot
       where not public.outlook_exchange_truth_snapshot_is_valid(snapshot.snapshot_sha256,snapshot.snapshot_kind,snapshot.schema_version,snapshot.canonical_json,snapshot.byte_length,snapshot.item_counts)
       order by snapshot.created_at,snapshot.snapshot_sha256 limit 1)
    ) candidate order by candidate.created_at,candidate.snapshot_sha256 limit 1
  ),$after$;
  wrapper_needle constant text := $needle$  legacy_verification :=
    public.verify_outlook_exchange_truth_ledger_without_group_smtp_guard();$needle$;
  wrapper_guard constant text := $guard$  -- This historical schema-v1 predicate is immutable. Any future semantic
  -- change must rebuild its index and update this contract together.
  if not exists (
    select 1 from pg_catalog.pg_proc p
    where p.oid='public.outlook_exchange_truth_snapshot_is_valid(text,text,integer,text,bigint,jsonb)'::pg_catalog.regprocedure
      and pg_catalog.md5(p.prosrc)='eb58b625c2483e093d60422dd498a1b3'
      and p.provolatile='i' and not p.prosecdef
      and p.prolang=(select oid from pg_catalog.pg_language where lanname='plpgsql')
      and p.proconfig=array['search_path=pg_catalog, pg_temp']::text[]
  ) then
    raise exception 'OUTLOOK_SNAPSHOT_VALIDATOR_DRIFT: historical validator changed; rebuild its validation index before certification.' using errcode='55000';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_index i
    where i.indexrelid=pg_catalog.to_regclass('public.outlook_exchange_truth_invalid_snapshot_v1_idx')
      and i.indrelid='public.outlook_exchange_truth_snapshots'::pg_catalog.regclass
      and i.indisvalid and i.indisready and i.indislive
      and pg_catalog.pg_get_indexdef(i.indexrelid)='CREATE INDEX outlook_exchange_truth_invalid_snapshot_v1_idx ON public.outlook_exchange_truth_snapshots USING btree (created_at, snapshot_sha256) WHERE (NOT public.outlook_exchange_truth_snapshot_is_valid(snapshot_sha256, snapshot_kind, schema_version, canonical_json, byte_length, item_counts))'
  ) then
    raise exception 'OUTLOOK_SNAPSHOT_INDEX_DRIFT: validation index needs review before certification.' using errcode='55000';
  end if;
$guard$;
begin
  select to_jsonb(p) into verifier_before from pg_catalog.pg_proc p where p.oid=verifier_oid;
  select to_jsonb(p) into wrapper_before from pg_catalog.pg_proc p where p.oid=wrapper_oid;
  select to_jsonb(p) into validator_before from pg_catalog.pg_proc p where p.oid=validator_oid;
  if md5(verifier_before->>'prosrc') is distinct from 'be2ff9edc1446e32a6afa6374e4bc4aa'
    or md5(wrapper_before->>'prosrc') is distinct from '2b7f4e4c505d047449accb9c090537d1'
    or md5(validator_before->>'prosrc') is distinct from 'eb58b625c2483e093d60422dd498a1b3'
    or validator_before->>'provolatile' is distinct from 'i'
    or validator_before->'prosecdef' is distinct from 'false'::jsonb
    or validator_before->'proconfig' is distinct from '["search_path=pg_catalog, pg_temp"]'::jsonb
    or validator_before->>'prolang' is distinct from (select oid::text from pg_catalog.pg_language where lanname='plpgsql')
    or to_regclass('public.outlook_exchange_truth_invalid_snapshot_v1_idx') is not null
  then
    raise exception 'OUTLOOK_SNAPSHOT_INDEX_SOURCE_DRIFT: review installed verifier, validator and index before this migration.' using errcode='55000';
  end if;
  if (length(verifier_before->>'prosrc')-length(replace(verifier_before->>'prosrc',before_scan,'')))/length(before_scan)<>1
    or (length(wrapper_before->>'prosrc')-length(replace(wrapper_before->>'prosrc',wrapper_needle,'')))/length(wrapper_needle)<>1
  then
    raise exception 'OUTLOOK_SNAPSHOT_INDEX_SOURCE_DRIFT: expected proof sections are not unique.' using errcode='55000';
  end if;

  execute expected_index;
  expected_verifier_body := replace(verifier_before->>'prosrc',before_scan,after_scan);
  definition := pg_catalog.pg_get_functiondef(verifier_oid);
  execute replace(definition,before_scan,after_scan);
  expected_wrapper_body := replace(wrapper_before->>'prosrc',wrapper_needle,wrapper_guard||wrapper_needle);
  definition := pg_catalog.pg_get_functiondef(wrapper_oid);
  execute replace(definition,wrapper_needle,wrapper_guard||wrapper_needle);

  -- pg_get_functiondef preserves OID, owner, ACL, volatility and all settings.
  -- Check the complete catalog row rather than merely the altered source text.
  if not exists(select 1 from pg_catalog.pg_proc p where p.oid=verifier_oid
      and p.prosrc=expected_verifier_body and to_jsonb(p)-'prosrc'=verifier_before-'prosrc')
    or not exists(select 1 from pg_catalog.pg_proc p where p.oid=wrapper_oid
      and p.prosrc=expected_wrapper_body and to_jsonb(p)-'prosrc'=wrapper_before-'prosrc')
    or not exists(select 1 from pg_catalog.pg_proc p where p.oid=validator_oid and to_jsonb(p)=validator_before)
    or not exists(select 1 from pg_catalog.pg_index i
      where i.indexrelid='public.outlook_exchange_truth_invalid_snapshot_v1_idx'::regclass
        and i.indrelid='public.outlook_exchange_truth_snapshots'::regclass
        and i.indisvalid and i.indisready and i.indislive
        and pg_catalog.pg_get_indexdef(i.indexrelid)=expected_index)
  then
    raise exception 'OUTLOOK_SNAPSHOT_INDEX_POSTCONDITION: proof identity, privileges, guards or index changed unexpectedly.' using errcode='55000';
  end if;
end;
$snapshot_validation_index$;

comment on index public.outlook_exchange_truth_invalid_snapshot_v1_idx is
  'Immutable historical schema-v1 structural validation. PostgreSQL maintains all six predicate inputs on every write; full verification independently rehashes every canonical byte. Rebuild with any validator semantic change.';
