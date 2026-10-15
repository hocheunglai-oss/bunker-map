-- Operational clocks only: opaque keys, no business rows, recipients or paths.
-- The parent serializes observations; healthy coverage creates no child rows.
create table private.backup_protection_observations (
  domain text primary key check (domain in ('database', 'drive-file')),
  last_observed_at timestamptz not null check (isfinite(last_observed_at))
);
create table private.backup_protection_gaps (
  domain text not null references private.backup_protection_observations(domain) on delete cascade,
  gap_key text not null check (gap_key ~ '^[a-z0-9-]{1,100}$'),
  first_uncovered_at timestamptz not null check (isfinite(first_uncovered_at)),
  first_due_at timestamptz not null check (isfinite(first_due_at)),
  required_since_at timestamptz,
  required_version text,
  required_fingerprint text,
  check (
    (domain = 'database' and gap_key = 'inventory'
      and required_since_at is null
      and required_version is not null and required_version ~ '^[0-9]{14}$'
      and required_fingerprint is not null and required_fingerprint ~ '^[a-f0-9]{64}$')
    or ((domain <> 'database' or gap_key <> 'inventory')
      and required_since_at is not null and isfinite(required_since_at)
      and required_version is null and required_fingerprint is null)
  ),
  primary key (domain, gap_key)
);
alter table private.backup_protection_observations enable row level security;
alter table private.backup_protection_gaps enable row level security;
revoke all on private.backup_protection_observations, private.backup_protection_gaps
  from public, anon, authenticated, service_role;
grant usage on schema private to service_role;
grant select, insert, update on private.backup_protection_observations to service_role;
grant select, insert, update, delete on private.backup_protection_gaps to service_role;

-- One validation boundary for both the durable writer and read-only preview.
create function private.validate_backup_protection_gaps(
  p_domain text,
  p_observed_at timestamptz,
  p_gaps jsonb,
  p_complete boolean
)
returns void
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  -- Validate the entire batch before acquiring/inserting its sparse parent.
  if p_domain is null or p_domain not in ('database', 'drive-file')
    or p_observed_at is null or not pg_catalog.isfinite(p_observed_at)
    or p_observed_at > pg_catalog.clock_timestamp() + interval '5 minutes'
    or p_complete is null or pg_catalog.jsonb_typeof(p_gaps) is distinct from 'array'
  then
    raise exception using errcode = '22023', message = 'Invalid backup protection observation.';
  end if;
  if pg_catalog.jsonb_array_length(p_gaps) > 10000 then
    raise exception using errcode = '22023', message = 'Too many backup protection gaps.';
  end if;
  if exists (
    select 1 from pg_catalog.jsonb_array_elements(p_gaps) as item
    where pg_catalog.jsonb_typeof(item) is distinct from 'object'
      or pg_catalog.jsonb_typeof(item->'key') is distinct from 'string'
      or pg_catalog.jsonb_typeof(item->'dueAt') is distinct from 'string'
      or (item->>'key') !~ '^[a-z0-9-]{1,100}$'
      or (item->>'dueAt') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[Tt][0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?([Zz]|[+-][0-9]{2}:[0-9]{2})$'
      or (item ? 'coveredThroughAt' and (
        pg_catalog.jsonb_typeof(item->'coveredThroughAt') is distinct from 'string'
        or (item->>'coveredThroughAt') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[Tt][0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?([Zz]|[+-][0-9]{2}:[0-9]{2})$'
      ))
      or item - 'key' - 'dueAt' - 'requiredSinceAt' - 'coveredThroughAt' - 'requiredVersion'
        - 'requiredFingerprint' - 'coveredVersion' - 'coveredFingerprint' <> '{}'::jsonb
  ) or exists (
    select 1 from pg_catalog.jsonb_array_elements(p_gaps) as item
    group by item->>'key' having count(*) > 1
  ) then
    raise exception using errcode = '22023', message = 'Invalid or duplicate backup protection gap.';
  end if;
  if exists (
    select 1 from pg_catalog.jsonb_array_elements(p_gaps) as item
    where case when p_domain = 'database' and item->>'key' = 'inventory' then
      item ? 'requiredSinceAt'
      or pg_catalog.jsonb_typeof(item->'requiredVersion') is distinct from 'string'
      or (item->>'requiredVersion') !~ '^[0-9]{14}$'
      or pg_catalog.jsonb_typeof(item->'requiredFingerprint') is distinct from 'string'
      or (item->>'requiredFingerprint') !~ '^[a-fA-F0-9]{64}$'
      or ((item ? 'coveredThroughAt' or item ? 'coveredVersion' or item ? 'coveredFingerprint') and (
        not (item ? 'coveredThroughAt' and item ? 'coveredVersion' and item ? 'coveredFingerprint')
        or pg_catalog.jsonb_typeof(item->'coveredVersion') is distinct from 'string'
        or (item->>'coveredVersion') !~ '^[0-9]{14}$'
        or pg_catalog.jsonb_typeof(item->'coveredFingerprint') is distinct from 'string'
        or (item->>'coveredFingerprint') !~ '^[a-fA-F0-9]{64}$'
      ))
    else pg_catalog.jsonb_typeof(item->'requiredSinceAt') is distinct from 'string'
      or (item->>'requiredSinceAt') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[Tt][0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?([Zz]|[+-][0-9]{2}:[0-9]{2})$'
      or item ? 'requiredVersion' or item ? 'requiredFingerprint'
      or item ? 'coveredVersion' or item ? 'coveredFingerprint' end
  ) then
    raise exception using errcode = '22023', message = 'Invalid backup inventory target or coverage proof.';
  end if;
  begin
    if exists (
      select 1 from pg_catalog.jsonb_array_elements(p_gaps) as item
      where not pg_catalog.isfinite((item->>'dueAt')::timestamptz)
        or (item ? 'requiredSinceAt' and not pg_catalog.isfinite((item->>'requiredSinceAt')::timestamptz))
        or (item ? 'coveredThroughAt' and (
          not pg_catalog.isfinite((item->>'coveredThroughAt')::timestamptz)
          or (item->>'coveredThroughAt')::timestamptz > p_observed_at
        ))
    ) then
      raise exception using errcode = '22023', message = 'Invalid backup protection due date.';
    end if;
  exception when invalid_datetime_format or datetime_field_overflow or invalid_time_zone_displacement_value then
    raise exception using errcode = '22023', message = 'Invalid backup protection due date.';
  end;
end;
$$;

-- This predicate is only called after the shared validation above. A verified
-- late publication covers the pinned requirement, not its observation time.
create function private.backup_protection_gap_is_covered(
  p_domain text,
  p_key text,
  p_required_since_at timestamptz,
  p_required_version text,
  p_required_fingerprint text,
  p_candidate jsonb
)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(case when p_domain = 'database' and p_key = 'inventory' then
    (p_candidate->>'coveredVersion')::bigint <= (p_candidate->>'requiredVersion')::bigint
      and ((p_candidate->>'coveredVersion')::bigint > p_required_version::bigint
        or ((p_candidate->>'coveredVersion')::bigint = p_required_version::bigint
          and pg_catalog.lower(p_candidate->>'coveredFingerprint') = p_required_fingerprint))
    else (p_candidate->>'coveredThroughAt')::timestamptz >= p_required_since_at end, false);
$$;
revoke all on function private.validate_backup_protection_gaps(text,timestamptz,jsonb,boolean),
  private.backup_protection_gap_is_covered(text,text,timestamptz,text,text,jsonb)
  from public, anon, authenticated, service_role;
grant execute on function private.validate_backup_protection_gaps(text,timestamptz,jsonb,boolean),
  private.backup_protection_gap_is_covered(text,text,timestamptz,text,text,jsonb) to service_role;

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
    raise exception using errcode = '40001', message = 'Backup protection observation was not saved.';
  end if;
  if coalesce(inserted, false) and saved_observed_at is distinct from p_observed_at then
    raise exception using errcode = '40001', message = 'Backup protection observation was not saved.';
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
      raise exception using errcode = '40001', message = 'Backup protection gaps were not reconciled.';
    end if;
    if not coalesce(inserted, false) then
      update private.backup_protection_observations set last_observed_at = p_observed_at
        where domain = p_domain returning last_observed_at into saved_observed_at;
      if not found or saved_observed_at is distinct from p_observed_at then
        raise exception using errcode = '40001', message = 'Backup protection observation was not saved.';
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
revoke all on function public.reconcile_backup_protection_gaps(text,timestamptz,jsonb,boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.reconcile_backup_protection_gaps(text,timestamptz,jsonb,boolean) to service_role;

-- Projection only: viewing health must never advance ordering, open a clock or
-- clear durable state. This may reflect fresh/cached request evidence; it is
-- intentionally not a mutation-ordering acknowledgement.
create function public.preview_backup_protection_gaps(
  p_domain text,
  p_observed_at timestamptz,
  p_gaps jsonb,
  p_complete boolean
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  projected_gaps jsonb;
begin
  perform private.validate_backup_protection_gaps(p_domain, p_observed_at, p_gaps, p_complete);
  with candidates as (
    select item, item->>'key' as gap_key
    from pg_catalog.jsonb_array_elements(p_gaps) as item
  ), effective as (
    select candidates.gap_key,
      case when gaps.gap_key is null or covered.yes then p_observed_at
        else gaps.first_uncovered_at end as first_uncovered_at,
      case when gaps.gap_key is null or covered.yes then (candidates.item->>'dueAt')::timestamptz
        else least(gaps.first_due_at, (candidates.item->>'dueAt')::timestamptz) end as first_due_at
    from candidates
    left join private.backup_protection_gaps as gaps
      on gaps.domain = p_domain and gaps.gap_key = candidates.gap_key
    cross join lateral (select private.backup_protection_gap_is_covered(p_domain, candidates.gap_key,
      gaps.required_since_at, gaps.required_version, gaps.required_fingerprint, candidates.item) as yes) as covered
    union all
    select gaps.gap_key, gaps.first_uncovered_at, gaps.first_due_at
    from private.backup_protection_gaps as gaps
    where gaps.domain = p_domain and not p_complete and not exists (
      select 1 from candidates where candidates.gap_key = gaps.gap_key
    )
  )
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'key', gap_key, 'firstUncoveredAt', first_uncovered_at, 'firstDueAt', first_due_at
  ) order by gap_key), '[]'::jsonb) into projected_gaps from effective;
  return pg_catalog.jsonb_build_object(
    'schema', 'fcuno.backup-protection-gaps/v1', 'domain', p_domain,
    'accepted', true, 'observedAt', p_observed_at, 'gaps', projected_gaps
  );
end;
$$;
revoke all on function public.preview_backup_protection_gaps(text,timestamptz,jsonb,boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.preview_backup_protection_gaps(text,timestamptz,jsonb,boolean) to service_role;
