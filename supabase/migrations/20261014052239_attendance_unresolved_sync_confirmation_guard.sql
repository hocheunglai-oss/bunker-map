-- A failed query can omit a punch without creating a raw-punch anomaly. A
-- fresh source revision alone must not allow manual confirmation of that gap.
-- Existing runs predate complete person provenance. The September legacy
-- empty-manifest runs were reviewed separately; guard only older terminal
-- failures whose affected person/date or manifest can be identified. New
-- running rows are guarded as unknown-scope until they complete or a later
-- successful query covers their window.
alter table public.attendance_sync_runs
  add column confirmation_guard_applies boolean not null default false,
  add column confirmation_guard_period daterange;

-- Store the HKT dates that may actually be affected. A known scope can name a
-- date outside its broad query window, so its dates take precedence. An empty
-- known scope belongs to the separate punch-anomaly ledger.
create function private.attendance_sync_effective_guard_period(
  p_status text, p_scope jsonb, p_window_from timestamptz, p_window_to timestamptz
)
returns daterange
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  scope_known boolean;
  item jsonb;
  date_text text;
  affected_date date;
  first_date date;
  last_date date;
begin
  if p_status not in ('running', 'partial', 'failed') then return null; end if;
  scope_known := p_status <> 'running'
    and jsonb_typeof(p_scope) = 'object'
    and jsonb_typeof(p_scope->'unknown') = 'boolean'
    and p_scope->>'unknown' = 'false'
    and jsonb_typeof(p_scope->'affected') = 'array';
  if scope_known then
    for item in select value from jsonb_array_elements(p_scope->'affected') as entry(value) loop
      if jsonb_typeof(item) <> 'object' or not (item ? 'person_id')
        or jsonb_typeof(item->'person_id') not in ('string', 'null')
        or jsonb_typeof(item->'work_date') <> 'string'
      then
        scope_known := false;
        exit;
      end if;
      date_text := item->>'work_date';
      if date_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        or (jsonb_typeof(item->'person_id') = 'string'
          and (item->>'person_id') !~*
            '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
      then
        scope_known := false;
        exit;
      end if;
      begin
        affected_date := date_text::date;
        if to_char(affected_date, 'YYYY-MM-DD') <> date_text then
          scope_known := false;
          exit;
        end if;
      exception when others then
        scope_known := false;
        exit;
      end;
      first_date := least(coalesce(first_date, affected_date), affected_date);
      last_date := greatest(coalesce(last_date, affected_date), affected_date);
    end loop;
    if scope_known then
      return case when first_date is null then null
        else daterange(first_date, last_date + 1, '[)') end;
    end if;
  end if;
  first_date := (p_window_from at time zone 'Asia/Hong_Kong')::date;
  last_date := ((case when p_window_to > p_window_from
    then p_window_to - interval '1 microsecond' else p_window_to end)
    at time zone 'Asia/Hong_Kong')::date;
  return daterange(first_date, last_date + 1, '[)');
end;
$$;
revoke all on function private.attendance_sync_effective_guard_period(
  text, jsonb, timestamptz, timestamptz
) from public, anon, authenticated, service_role;

create function private.set_attendance_sync_guard_period()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  new.confirmation_guard_period := case
    when new.confirmation_guard_applies then
      private.attendance_sync_effective_guard_period(
        new.status, new.failure_scope, new.window_from, new.window_to
      )
    else null end;
  return new;
end;
$$;
revoke all on function private.set_attendance_sync_guard_period()
  from public, anon, authenticated, service_role;
create trigger set_attendance_sync_guard_period
before insert or update on public.attendance_sync_runs
for each row execute function private.set_attendance_sync_guard_period();

update public.attendance_sync_runs as run
set confirmation_guard_applies = true
where run.status in ('partial', 'failed')
  and (
    (jsonb_typeof(run.failure_scope) = 'object'
      and jsonb_typeof(run.failure_scope->'unknown') = 'boolean'
      and run.failure_scope->>'unknown' = 'false'
      and jsonb_typeof(run.failure_scope->'affected') = 'array')
    or (run.people_requested > 0
      and run.people_requested = (
        select count(*) from jsonb_each(run.requested_people)
      )
      and not exists (
        select 1 from jsonb_each(run.requested_people) as entry(key, value)
        where entry.key !~*
          '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          or jsonb_typeof(entry.value) <> 'string'
          or nullif(btrim(entry.value #>> '{}'), '') is null
      ))
  );
alter table public.attendance_sync_runs
  alter column confirmation_guard_applies set default true;

create index attendance_sync_runs_guard_period_idx
  on public.attendance_sync_runs using gist (confirmation_guard_period)
  where confirmation_guard_applies
    and status in ('running', 'partial', 'failed');

create index attendance_sync_runs_success_window_idx
  on public.attendance_sync_runs (started_at, window_from, window_to)
  where status = 'succeeded';

create function private.attendance_sync_interval_rechecked(
  p_person_id uuid, p_dingtalk_user_id text, p_from timestamptz,
  p_to timestamptz, p_after timestamptz
)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  covered_until timestamptz := p_from;
  next_until timestamptz;
begin
  if p_person_id is null or p_dingtalk_user_id is null
    or nullif(btrim(p_dingtalk_user_id), '') is null
    or p_from is null or p_to is null or p_from >= p_to or p_after is null
  then
    return false;
  end if;

  -- Adjacent successful windows may jointly recheck a failed interval. Only
  -- queries started after the failure was observed can clear it.
  while covered_until < p_to loop
    select max(least(success.window_to, p_to)) into next_until
    from public.attendance_sync_runs as success
    where success.status = 'succeeded'
      and success.started_at > p_after
      and success.completed_at >= greatest(success.started_at, success.window_to)
      and success.window_from <= covered_until
      and success.window_to > covered_until
      and success.requested_people->>p_person_id::text = p_dingtalk_user_id
      and success.people_requested > 0
      and success.people_requested = (
        select count(*) from jsonb_each(success.requested_people)
      )
      and success.batches_attempted >= ceil(success.people_requested / 50.0);
    if next_until is null or next_until <= covered_until then
      return false;
    end if;
    covered_until := next_until;
  end loop;
  return true;
end;
$$;
revoke all on function private.attendance_sync_interval_rechecked(
  uuid, text, timestamptz, timestamptz, timestamptz
) from public, anon, authenticated, service_role;

create function private.attendance_unresolved_sync_failure(
  p_person_id uuid, p_year integer, p_from_month integer, p_to_month integer
)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  period_from date := make_date(p_year, p_from_month, 1);
  period_to date := (make_date(p_year, p_to_month, 1) + interval '1 month')::date;
  period_from_at timestamptz := period_from::timestamp at time zone 'Asia/Hong_Kong';
  period_to_at timestamptz := period_to::timestamp at time zone 'Asia/Hong_Kong';
  current_dingtalk_id text;
  failed record;
  scope_known boolean;
  item jsonb;
  affected_date date;
  item_date_text text;
  manifest_count integer;
  manifest_valid boolean;
  recheck_from timestamptz;
  recheck_to timestamptz;
  observed_at timestamptz;
begin
  select nullif(btrim(person.dingtalk_user_id), '') into current_dingtalk_id
  from public.attendance_people as person where person.id = p_person_id;

  for failed in
    select * from public.attendance_sync_runs as run
    where run.status in ('running', 'partial', 'failed')
      and run.confirmation_guard_applies
      and run.confirmation_guard_period && daterange(period_from, period_to, '[)')
  loop
    observed_at := coalesce(failed.completed_at, failed.started_at);
    select count(*)::integer, coalesce(bool_and(
      entry.key ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      and jsonb_typeof(entry.value) = 'string'
      and nullif(btrim(entry.value #>> '{}'), '') is not null
    ), false)
    into manifest_count, manifest_valid
    from jsonb_each(failed.requested_people) as entry(key, value);
    manifest_valid := manifest_valid and manifest_count > 0
      and manifest_count = failed.people_requested;

    scope_known := failed.status <> 'running'
      and jsonb_typeof(failed.failure_scope) = 'object'
      and jsonb_typeof(failed.failure_scope->'unknown') = 'boolean'
      and failed.failure_scope->>'unknown' = 'false'
      and jsonb_typeof(failed.failure_scope->'affected') = 'array';

    if scope_known then
      for item in select value from jsonb_array_elements(
        failed.failure_scope->'affected'
      ) as entry(value) loop
        if jsonb_typeof(item) <> 'object'
          or not (item ? 'person_id')
          or jsonb_typeof(item->'work_date') <> 'string'
          or jsonb_typeof(item->'person_id') not in ('string', 'null')
        then
          scope_known := false;
          exit;
        end if;
        item_date_text := item->>'work_date';
        if item_date_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
          or (jsonb_typeof(item->'person_id') = 'string'
            and (item->>'person_id') !~*
              '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
        then
          scope_known := false;
          exit;
        end if;
        begin
          affected_date := item_date_text::date;
          if to_char(affected_date, 'YYYY-MM-DD') <> item_date_text then
            scope_known := false;
            exit;
          end if;
        exception when others then
          scope_known := false;
          exit;
        end;
      end loop;
    end if;

    if scope_known then
      -- An empty known scope represents a changed/missing source punch. Its
      -- separate private anomaly ledger already blocks confirmation.
      for item in select value from jsonb_array_elements(
        failed.failure_scope->'affected'
      ) as entry(value) loop
        affected_date := (item->>'work_date')::date;
        if affected_date < period_from or affected_date >= period_to
          or (jsonb_typeof(item->'person_id') = 'string'
            and (item->>'person_id')::uuid <> p_person_id)
          or (jsonb_typeof(item->'person_id') = 'null'
            and manifest_valid
            and not (failed.requested_people ? p_person_id::text))
        then
          continue;
        end if;
        if manifest_valid and
          failed.requested_people->>p_person_id::text is distinct from current_dingtalk_id
        then
          return true;
        end if;
        recheck_from := affected_date::timestamp at time zone 'Asia/Hong_Kong';
        recheck_to := (affected_date + 1)::timestamp at time zone 'Asia/Hong_Kong';
        if not private.attendance_sync_interval_rechecked(
          p_person_id, current_dingtalk_id, recheck_from, recheck_to, observed_at
        ) then
          return true;
        end if;
      end loop;
      continue;
    end if;

    -- When a batch failed or the scope is invalid, use its queried window.
    -- An invalid requested-person manifest cannot safely exclude anyone.
    if manifest_valid and not (failed.requested_people ? p_person_id::text) then
      continue;
    end if;
    if manifest_valid and
      failed.requested_people->>p_person_id::text is distinct from current_dingtalk_id
    then
      return true;
    end if;
    recheck_from := greatest(failed.window_from, period_from_at);
    recheck_to := least(failed.window_to, period_to_at);
    if recheck_from >= recheck_to then continue; end if;
    if not private.attendance_sync_interval_rechecked(
      p_person_id, current_dingtalk_id, recheck_from, recheck_to, observed_at
    ) then
      return true;
    end if;
  end loop;
  return false;
end;
$$;
revoke all on function private.attendance_unresolved_sync_failure(
  uuid, integer, integer, integer
) from public, anon, authenticated, service_role;

-- Imported XLS punches predate DingTalk ingestion and retain their legacy
-- source identity. Later counted DingTalk punches must match the person's
-- current link. An audited exclusion removes a raw punch from the count.
create function private.attendance_historical_dingtalk_identity_mismatch(
  p_person_id uuid, p_year integer, p_from_month integer, p_to_month integer
)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  current_dingtalk_id text;
  period_from date := greatest(make_date(p_year, p_from_month, 1), date '2026-08-13');
  period_to date := (make_date(p_year, p_to_month, 1) + interval '1 month')::date;
begin
  select nullif(btrim(person.dingtalk_user_id), '') into current_dingtalk_id
  from public.attendance_people as person where person.id = p_person_id;
  return exists (
    select 1 from public.attendance_raw_punches as raw
    where raw.person_id = p_person_id
      and raw.work_date >= period_from and raw.work_date < period_to
      and raw.source_type is distinct from 'LEGACY_XLS'
      and raw.dingtalk_user_id is distinct from current_dingtalk_id
      and not exists (
        select 1 from public.attendance_manual_overrides as excluded
        where excluded.action = 'exclude'
          and excluded.raw_punch_id = raw.id
          and excluded.person_id = raw.person_id
          and excluded.work_date = raw.work_date
      )
  );
end;
$$;
revoke all on function private.attendance_historical_dingtalk_identity_mismatch(
  uuid, integer, integer, integer
) from public, anon, authenticated, service_role;

create function private.block_unresolved_attendance_sync_confirmation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if new.status <> 'confirmed' then return new; end if;
  -- Serialize this read with sync completion and source-revision changes.
  perform 1 from private.attendance_source_revision_state where singleton for update;
  if not found then raise exception 'Attendance source revision is unavailable.'; end if;
  if private.attendance_unresolved_sync_failure(
    new.person_id, new.year,
    case when new.month = 12 and new.note = 'annual-summary' then 1 else new.month end,
    new.month
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'ATTENDANCE_SYNC_INCOMPLETE: Recheck the affected DingTalk attendance before confirming.';
  end if;
  if private.attendance_historical_dingtalk_identity_mismatch(
    new.person_id, new.year,
    case when new.month = 12 and new.note = 'annual-summary' then 1 else new.month end,
    new.month
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'ATTENDANCE_DINGTALK_IDENTITY_MISMATCH: Review punches from a different DingTalk identity before confirming.';
  end if;
  return new;
end;
$$;
revoke all on function private.block_unresolved_attendance_sync_confirmation()
  from public, anon, authenticated, service_role;
create trigger zzz_block_unresolved_attendance_sync_confirmation
before insert or update on public.attendance_monthly_confirmations
for each row execute function private.block_unresolved_attendance_sync_confirmation();

-- A historical confirmation may have been written after an incomplete sync
-- was observed but before this guard existed. Reopen exactly those monthly or
-- annual rows now; the existing confirmation audit trigger records the change.
update public.attendance_monthly_confirmations as confirmation
set status = 'pending', confirmed_at = null, confirmed_by = null,
  updated_by = 'system:attendance-source-review'
where confirmation.status = 'confirmed'
  and (private.attendance_unresolved_sync_failure(
    confirmation.person_id, confirmation.year,
    case when confirmation.month = 12 and confirmation.note = 'annual-summary'
      then 1 else confirmation.month end,
    confirmation.month
  ) or private.attendance_historical_dingtalk_identity_mismatch(
    confirmation.person_id, confirmation.year,
    case when confirmation.month = 12 and confirmation.note = 'annual-summary'
      then 1 else confirmation.month end,
    confirmation.month
  ));
