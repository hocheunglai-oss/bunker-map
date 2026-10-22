-- A suppressed required write is an unconfirmed observation, not a native
-- serialization failure. PostgREST must not retry these four business guards.
-- Keep the exact function identity, rights, settings, locks and success payload.
set local lock_timeout = '3s';

do $preflight$
begin
  if (select pg_catalog.md5(prosrc) from pg_catalog.pg_proc
      where oid = pg_catalog.to_regprocedure(
        'public.reconcile_backup_protection_gaps(text,timestamptz,jsonb,boolean)'))
      is distinct from 'f55faf7c1c31453776872e37799c48c1' then
    raise exception 'BACKUP_PROTECTION_OBSERVATION_SOURCE_MISMATCH'
      using errcode = '55000';
  end if;
end;
$preflight$;

create or replace function public.reconcile_backup_protection_gaps(
  p_domain text,
  p_observed_at timestamptz,
  p_gaps jsonb,
  p_complete boolean
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  inserted boolean;
  saved_observed_at timestamptz;
  accepted boolean := false;
  current_gaps jsonb;
  reset_keys jsonb;
begin
  perform private.validate_backup_protection_gaps(p_domain, p_observed_at, p_gaps, p_complete);
  insert into private.backup_protection_observations(domain, last_observed_at)
    values (p_domain, p_observed_at)
    on conflict (domain) do nothing returning true into inserted;
  select last_observed_at into saved_observed_at
    from private.backup_protection_observations where domain = p_domain for update;
  if not found then
    raise exception using errcode = 'P0001', detail = 'BACKUP_PROTECTION_OBSERVATION_UNCONFIRMED', message = 'Backup protection observation was not saved.';
  end if;
  if coalesce(inserted, false) and saved_observed_at is distinct from p_observed_at then
    raise exception using errcode = 'P0001', detail = 'BACKUP_PROTECTION_OBSERVATION_UNCONFIRMED', message = 'Backup protection observation was not saved.';
  end if;
  if coalesce(inserted, false) or p_observed_at > saved_observed_at then
    accepted := true;
    -- Only the trusted service supplies verified artifact/catalog proof. The
    -- inventory clock also pins its FIRST required target: a fresh old-schema
    -- artifact must not postpone it. Other clocks pin when the actual missing
    -- generation/cycle was required, not when a possibly delayed check saw it.
    -- Compute eligible resets once under the
    -- parent lock, not by rescanning all input rows for every conflict.
    select coalesce(pg_catalog.jsonb_object_agg(item->>'key', true), '{}'::jsonb) into reset_keys
    from pg_catalog.jsonb_array_elements(p_gaps) as item
    join private.backup_protection_gaps as gaps
      on gaps.domain = p_domain and gaps.gap_key = item->>'key'
    where private.backup_protection_gap_is_covered(p_domain, gaps.gap_key,
      gaps.required_since_at, gaps.required_version, gaps.required_fingerprint, item);
    insert into private.backup_protection_gaps as gaps (
      domain, gap_key, first_uncovered_at, first_due_at, required_since_at, required_version, required_fingerprint
    )
    select p_domain, item->>'key', p_observed_at, (item->>'dueAt')::timestamptz,
      (item->>'requiredSinceAt')::timestamptz,
      item->>'requiredVersion', pg_catalog.lower(item->>'requiredFingerprint')
      from pg_catalog.jsonb_array_elements(p_gaps) as item order by item->>'key'
    on conflict (domain, gap_key) do update
      set first_uncovered_at = case
        when reset_keys ? excluded.gap_key
        then excluded.first_uncovered_at else gaps.first_uncovered_at end,
      first_due_at = case
        when reset_keys ? excluded.gap_key
        then excluded.first_due_at else least(gaps.first_due_at, excluded.first_due_at) end,
      required_since_at = case when reset_keys ? excluded.gap_key then excluded.required_since_at else gaps.required_since_at end,
      required_version = case when reset_keys ? excluded.gap_key then excluded.required_version else gaps.required_version end,
      required_fingerprint = case when reset_keys ? excluded.gap_key then excluded.required_fingerprint else gaps.required_fingerprint end
      where reset_keys ? excluded.gap_key
        or excluded.first_due_at < gaps.first_due_at;
    -- Unknown/incomplete coverage never closes a previous unresolved clock.
    if p_complete then
      delete from private.backup_protection_gaps as gaps
      where gaps.domain = p_domain and not exists (
        select 1 from pg_catalog.jsonb_array_elements(p_gaps) as item
        where item->>'key' = gaps.gap_key
      );
    end if;
    -- Fail closed if an unexpected trigger suppresses a required write.
    if exists (
      select 1 from pg_catalog.jsonb_array_elements(p_gaps) as item
      left join private.backup_protection_gaps as gaps
        on gaps.domain = p_domain and gaps.gap_key = item->>'key'
      where gaps.gap_key is null or gaps.first_due_at > (item->>'dueAt')::timestamptz
        or (reset_keys ? (item->>'key') and (
          gaps.first_uncovered_at is distinct from p_observed_at
          or gaps.first_due_at is distinct from (item->>'dueAt')::timestamptz
          or gaps.required_since_at is distinct from (item->>'requiredSinceAt')::timestamptz
          or gaps.required_version is distinct from item->>'requiredVersion'
          or gaps.required_fingerprint is distinct from pg_catalog.lower(item->>'requiredFingerprint')
        ))
    ) or (p_complete and exists (
      select 1 from private.backup_protection_gaps as gaps
      where gaps.domain = p_domain and not exists (
        select 1 from pg_catalog.jsonb_array_elements(p_gaps) as item where item->>'key' = gaps.gap_key
      )
    )) then
      raise exception using errcode = 'P0001', detail = 'BACKUP_PROTECTION_OBSERVATION_UNCONFIRMED', message = 'Backup protection gaps were not reconciled.';
    end if;
    if not coalesce(inserted, false) then
      update private.backup_protection_observations set last_observed_at = p_observed_at
        where domain = p_domain returning last_observed_at into saved_observed_at;
      if not found or saved_observed_at is distinct from p_observed_at then
        raise exception using errcode = 'P0001', detail = 'BACKUP_PROTECTION_OBSERVATION_UNCONFIRMED', message = 'Backup protection observation was not saved.';
      end if;
    end if;
  end if;
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'key', gap_key, 'firstUncoveredAt', first_uncovered_at, 'firstDueAt', first_due_at
  ) order by gap_key), '[]'::jsonb) into current_gaps
  from private.backup_protection_gaps where domain = p_domain;
  return pg_catalog.jsonb_build_object(
    'schema', 'fcuno.backup-protection-gaps/v1', 'domain', p_domain,
    'accepted', accepted, 'observedAt', saved_observed_at, 'gaps', current_gaps
  );
end;
$$;

