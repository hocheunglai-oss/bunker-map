-- Schema-v1 snapshots are immutable historical evidence. Their validator must
-- retain the schema-v1 contract that existed when their hashes were recorded;
-- tightening it retroactively invalidates an otherwise intact ledger.
--
-- Exact group SMTP remains mandatory for all new projection snapshots through
-- enforce_outlook_exchange_projection_group_smtp, for certification through
-- the guarded certify_full_outlook_exchange_truth RPC, and for current truth
-- through verify_outlook_exchange_truth_ledger.

create or replace function public.outlook_exchange_truth_snapshot_is_valid(
  p_snapshot_sha256 text,
  p_snapshot_kind text,
  p_schema_version integer,
  p_canonical_json text,
  p_byte_length bigint,
  p_item_counts jsonb
)
returns boolean
language plpgsql
immutable
set search_path = pg_catalog, pg_temp
as $$
declare
  snapshot_value jsonb;
  expected_counts jsonb;
begin
  if p_snapshot_sha256 !~ '^[0-9a-f]{64}$'
    or p_schema_version <> 1
    or p_snapshot_sha256
      <> public.outlook_exchange_truth_sha256(p_canonical_json)
    or p_byte_length <> octet_length(p_canonical_json)
    or jsonb_typeof(p_item_counts) <> 'object'
  then
    return false;
  end if;

  snapshot_value := p_canonical_json::jsonb;
  if p_snapshot_kind = 'fcuno_raw' then
    if snapshot_value ->> 'schema' is distinct from 'fcuno.addressbook.raw/v1'
      or jsonb_typeof(snapshot_value -> 'contacts') is distinct from 'array'
      or jsonb_typeof(snapshot_value -> 'groups') is distinct from 'array'
      or jsonb_typeof(snapshot_value -> 'members') is distinct from 'array'
      or snapshot_value - array[
        'schema', 'contacts', 'groups', 'members'
      ] <> '{}'::jsonb
    then
      return false;
    end if;
    expected_counts := jsonb_build_object(
      'contacts', jsonb_array_length(snapshot_value -> 'contacts'),
      'groups', jsonb_array_length(snapshot_value -> 'groups'),
      'members', jsonb_array_length(snapshot_value -> 'members')
    );
  elsif p_snapshot_kind = 'fcuno_exchange_projection' then
    if jsonb_typeof(snapshot_value -> 'contacts') is distinct from 'array'
      or jsonb_typeof(snapshot_value -> 'groups') is distinct from 'array'
      or jsonb_typeof(snapshot_value -> 'members') is distinct from 'array'
      or jsonb_typeof(snapshot_value -> 'invalidContacts')
        is distinct from 'array'
      or jsonb_typeof(snapshot_value -> 'skippedInvalidContacts')
        is distinct from 'array'
      or jsonb_typeof(snapshot_value -> 'duplicateContacts')
        is distinct from 'array'
      or snapshot_value - array[
        'contacts',
        'groups',
        'members',
        'invalidContacts',
        'skippedInvalidContacts',
        'duplicateContacts'
      ] <> '{}'::jsonb
    then
      return false;
    end if;
    expected_counts := jsonb_build_object(
      'contacts', jsonb_array_length(snapshot_value -> 'contacts'),
      'groups', jsonb_array_length(snapshot_value -> 'groups'),
      'members', jsonb_array_length(snapshot_value -> 'members'),
      'invalidContacts', jsonb_array_length(snapshot_value -> 'invalidContacts'),
      'skippedInvalidContacts', jsonb_array_length(
        snapshot_value -> 'skippedInvalidContacts'
      ),
      'duplicateContacts', jsonb_array_length(
        snapshot_value -> 'duplicateContacts'
      )
    );
  else
    return false;
  end if;

  return p_item_counts is not distinct from expected_counts;
exception
  when others then
    return false;
end;
$$;

revoke all on function public.outlook_exchange_truth_snapshot_is_valid(
  text,
  text,
  integer,
  text,
  bigint,
  jsonb
) from public, anon, authenticated;
