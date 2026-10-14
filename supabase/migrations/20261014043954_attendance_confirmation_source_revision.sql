-- Serialize source edits with confirmation writes. The confirmation RPC checks
-- the revision shown with the attendance view while holding this row lock.
create table private.attendance_source_revision_state (
  singleton boolean primary key default true check (singleton),
  revision bigint not null default 0 check (revision >= 0)
);
insert into private.attendance_source_revision_state (singleton, revision)
values (true, 0);
alter table private.attendance_source_revision_state enable row level security;
revoke all on private.attendance_source_revision_state
  from public, anon, authenticated, service_role;

-- These existing trigger functions call the private reset helper. They run as
-- service_role for API edits, but that role correctly has no direct EXECUTE on
-- the helper. Keep the helper private and run the narrowly scoped triggers as
-- their owner instead (both functions already pin their search_path).
alter function private.invalidate_attendance_confirmation() security definer;
alter function private.invalidate_attendance_work_mode_confirmation() security definer;

create or replace function private.bump_attendance_source_revision()
returns void
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  update private.attendance_source_revision_state
  set revision = revision + 1
  where singleton;
  if not found then
    raise exception 'Attendance source revision is unavailable.';
  end if;
end;
$$;
revoke all on function private.bump_attendance_source_revision()
  from public, anon, authenticated, service_role;

create or replace function private.attendance_source_revision_guard()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  perform private.bump_attendance_source_revision();
  return null; -- ignored for statement triggers
end;
$$;
revoke all on function private.attendance_source_revision_guard()
  from public, anon, authenticated, service_role;

-- BEFORE STATEMENT obtains the revision lock before existing AFTER ROW
-- invalidation. A zero-row write conservatively advances the revision.
do $$
declare
  source_table text;
begin
  foreach source_table in array array[
    'attendance_people',
    'attendance_raw_punches',
    'attendance_leave_entries',
    'attendance_manual_overrides',
    'attendance_team_assignments',
    'attendance_work_mode_policies',
    'attendance_work_mode_overrides',
    'attendance_monthly_adjustments',
    'attendance_entitlements',
    'attendance_sync_runs',
    'attendance_reminder_dispatches'
  ] loop
    execute format(
      'create trigger attendance_source_revision_guard '
      || 'before insert or update or delete on public.%I '
      || 'for each statement execute function private.attendance_source_revision_guard()',
      source_table
    );
  end loop;
end;
$$;

-- Other Event Calendar edits do not change counted attendance. A first insert
-- still advances the revision: the reader can switch from seed to stored data.
create or replace function private.attendance_calendar_source_revision_guard()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  old_uses_seed boolean;
  new_uses_seed boolean;
begin
  if tg_op = 'DELETE' then
    if old.key = 'event-calendar' then
      raise exception 'The Event Calendar cannot be deleted while it is an attendance source.';
    end if;
    return old;
  end if;

  if tg_op = 'UPDATE' then
    if old.key is distinct from new.key
      and (old.key = 'event-calendar' or new.key = 'event-calendar')
    then
      raise exception 'The Event Calendar key cannot be changed.';
    end if;
  end if;
  if new.key <> 'event-calendar' then return new; end if;

  if tg_op = 'INSERT' then
    perform private.bump_attendance_source_revision();
    return new;
  end if;

  -- The attendance reader uses seed events for a missing/empty store. Crossing
  -- that boundary can change counts even when both stored payloads project to
  -- no holiday effects.
  old_uses_seed := old.payload is null or old.payload = '{}'::jsonb;
  new_uses_seed := new.payload is null or new.payload = '{}'::jsonb;
  if old_uses_seed is distinct from new_uses_seed then
    perform private.bump_attendance_source_revision();
    return new;
  end if;

  if exists (
    with old_effects as (
      select * from private.attendance_hk_holiday_effects(old.payload)
    ), new_effects as (
      select * from private.attendance_hk_holiday_effects(new.payload)
    )
    select 1
    from old_effects as previous
    full join new_effects as current using (event_date)
    where previous.attendee_codes is distinct from current.attendee_codes
      and coalesce(previous.event_date, current.event_date) >= date '2026-09-01'
  ) then
    perform private.bump_attendance_source_revision();
  end if;
  return new;
end;
$$;
revoke all on function private.attendance_calendar_source_revision_guard()
  from public, anon, authenticated, service_role;

create trigger attendance_calendar_source_revision_guard
before insert or update or delete on public.office_calendar_store
for each row execute function private.attendance_calendar_source_revision_guard();

-- On a first stored calendar or a transition to/from the seed fallback, the
-- previous effective seed events are not available in SQL. Reopen all months
-- that use Event Calendar holiday attendance conservatively.
create or replace function private.invalidate_attendance_calendar_seed_transition()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  old_uses_seed boolean;
  new_uses_seed boolean;
  actor text := coalesce(
    nullif(current_setting('app.audit_actor_name', true), ''),
    nullif(current_setting('app.audit_actor_id', true), ''),
    'system:event-calendar-seed-transition'
  );
begin
  if new.key <> 'event-calendar' then return new; end if;
  new_uses_seed := new.payload is null or new.payload = '{}'::jsonb;
  if tg_op = 'INSERT' then
    old_uses_seed := true;
  else
    old_uses_seed := old.payload is null or old.payload = '{}'::jsonb;
  end if;
  if old_uses_seed is distinct from new_uses_seed then
    update public.attendance_monthly_confirmations as confirmations
    set status = 'pending', confirmed_at = null, confirmed_by = null,
      updated_by = actor
    where confirmations.status = 'confirmed'
      and (confirmations.year > 2026
        or (confirmations.year = 2026 and confirmations.month >= 9));
  end if;
  return new;
end;
$$;
revoke all on function private.invalidate_attendance_calendar_seed_transition()
  from public, anon, authenticated, service_role;

create trigger invalidate_attendance_calendar_seed_transition
after insert or update on public.office_calendar_store
for each row execute function private.invalidate_attendance_calendar_seed_transition();

-- Person employment windows and staff codes can change historical required
-- days, HO/OS totals, and Hong Kong holiday attendee matching.
create or replace function private.invalidate_attendance_person_confirmation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  old_start date;
  new_start date;
  old_end date;
  new_end date;
begin
  if old.team is distinct from new.team
    or old.is_active is distinct from new.is_active
  then
    perform private.reset_attendance_confirmations_for_range(
      new.id, date '2000-01-01', date '2200-12-31'
    );
  end if;

  if old.staff_code is distinct from new.staff_code then
    perform private.reset_attendance_confirmations_for_range(
      new.id, date '2026-09-01', date '2200-12-31'
    );
  end if;

  if old.employment_start_date is distinct from new.employment_start_date then
    old_start := coalesce(old.employment_start_date, date '2000-01-01');
    new_start := coalesce(new.employment_start_date, date '2000-01-01');
    perform private.reset_attendance_confirmations_for_range(
      new.id, least(old_start, new_start), greatest(old_start, new_start) - 1
    );
  end if;

  if old.employment_end_date is distinct from new.employment_end_date then
    old_end := coalesce(old.employment_end_date, date '2200-12-31');
    new_end := coalesce(new.employment_end_date, date '2200-12-31');
    perform private.reset_attendance_confirmations_for_range(
      new.id, least(old_end, new_end) + 1, greatest(old_end, new_end)
    );
  end if;
  return new;
end;
$$;
revoke all on function private.invalidate_attendance_person_confirmation()
  from public, anon, authenticated, service_role;

create trigger invalidate_attendance_person_confirmation
after update of team, is_active, staff_code, employment_start_date,
  employment_end_date on public.attendance_people
for each row execute function private.invalidate_attendance_person_confirmation();

-- Raw punches are immutable in normal operation. If maintenance ever lifts
-- their UPDATE/DELETE protector, old and new affected dates still reopen.
create or replace function private.invalidate_mutated_raw_punch_confirmation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  perform private.reset_attendance_confirmations_for_range(
    old.person_id, old.work_date, old.work_date
  );
  if tg_op = 'UPDATE' then
    perform private.reset_attendance_confirmations_for_range(
      new.person_id, new.work_date, new.work_date
    );
    return new;
  end if;
  return old;
end;
$$;
revoke all on function private.invalidate_mutated_raw_punch_confirmation()
  from public, anon, authenticated, service_role;

create trigger invalidate_mutated_raw_punch_confirmation
after update or delete on public.attendance_raw_punches
for each row execute function private.invalidate_mutated_raw_punch_confirmation();


alter table public.attendance_monthly_confirmations
  add column confirmed_source_revision bigint
  check (confirmed_source_revision is null or confirmed_source_revision >= 0);

-- The table trigger protects direct writes as well as calls through the RPC.
-- Pending resets remain possible and clear the stored confirmation revision.
create or replace function private.enforce_attendance_confirmation_revision()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  current_revision bigint;
begin
  if new.status <> 'confirmed' then
    new.confirmed_source_revision := null;
    return new;
  end if;

  select revision into current_revision
  from private.attendance_source_revision_state
  where singleton
  for update;
  if current_revision is null then
    raise exception 'Attendance source revision is unavailable.';
  end if;
  if new.confirmed_source_revision is distinct from current_revision then
    raise exception using
      errcode = 'P0001',
      message = 'ATTENDANCE_SOURCE_CHANGED: Refresh attendance before confirming.';
  end if;
  return new;
end;
$$;
revoke all on function private.enforce_attendance_confirmation_revision()
  from public, anon, authenticated, service_role;

create trigger enforce_attendance_confirmation_revision
before insert or update of status, confirmed_at, confirmed_by,
  confirmed_source_revision on public.attendance_monthly_confirmations
for each row execute function private.enforce_attendance_confirmation_revision();

create or replace function public.attendance_source_revision()
returns bigint
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  select revision from private.attendance_source_revision_state where singleton;
$$;
revoke all on function public.attendance_source_revision()
  from public, anon, authenticated, service_role;
grant execute on function public.attendance_source_revision() to service_role;

create or replace function public.save_attendance_monthly_confirmation_checked(
  p_person_id uuid,
  p_year integer,
  p_month integer,
  p_status text,
  p_note text,
  p_actor text,
  p_expected_revision bigint,
  p_auto_cutoff timestamptz default null
)
returns setof public.attendance_monthly_confirmations
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  current_revision bigint;
  existing public.attendance_monthly_confirmations%rowtype;
  saved public.attendance_monthly_confirmations%rowtype;
  confirmation_time timestamptz;
begin
  if p_person_id is null or p_year is null or p_year not between 2000 and 2200
    or p_month is null or p_month not between 1 and 12
    or p_status is null or p_status not in ('pending', 'confirmed')
    or nullif(btrim(p_actor), '') is null
  then
    raise exception 'Invalid attendance confirmation request.';
  end if;
  if p_auto_cutoff is not null and p_status <> 'confirmed' then
    raise exception 'Auto-confirm cutoff requires confirmed status.';
  end if;

  -- RPC pending resets use the same lock order as confirmations. The conflict
  -- predicate below also protects against any direct pending insert.
  select revision into current_revision
  from private.attendance_source_revision_state
  where singleton
  for update;
  if current_revision is null then
    raise exception 'Attendance source revision is unavailable.';
  end if;

  if p_status = 'confirmed' then
    if make_date(p_year, p_month, 1) >=
      date_trunc('month', clock_timestamp() at time zone 'Asia/Hong_Kong')::date
    then
      raise exception 'Attendance can be confirmed only after the Hong Kong month has closed.';
    end if;
    if p_expected_revision is distinct from current_revision then
      raise exception using
        errcode = 'P0001',
        message = 'ATTENDANCE_SOURCE_CHANGED: Refresh attendance before confirming.';
    end if;
  end if;

  select * into existing
  from public.attendance_monthly_confirmations
  where person_id = p_person_id and year = p_year and month = p_month
  for update;

  if p_auto_cutoff is not null and existing.id is not null
    and (existing.status = 'confirmed' or existing.updated_at >= p_auto_cutoff)
  then
    return;
  end if;

  if p_status = 'confirmed' and existing.id is not null
    and existing.status = 'confirmed'
  then
    if existing.note = coalesce(p_note, '') then
      return next existing;
      return;
    end if;
    if not (p_month = 12 and coalesce(p_note, '') = 'annual-summary'
      and existing.note <> 'annual-summary')
    then
      raise exception using
        errcode = 'P0001',
        message = 'ATTENDANCE_ALREADY_CONFIRMED: Reload the attendance statement before changing a confirmation.';
    end if;
  end if;

  confirmation_time := case when p_status = 'confirmed' then clock_timestamp() else null end;
  insert into public.attendance_monthly_confirmations (
    person_id, year, month, status, confirmed_at, confirmed_by,
    confirmed_source_revision, note, created_by, updated_by
  ) values (
    p_person_id, p_year, p_month, p_status, confirmation_time,
    case when p_status = 'confirmed' then p_actor else null end,
    case when p_status = 'confirmed' then current_revision else null end,
    coalesce(p_note, ''), p_actor, p_actor
  )
  on conflict (person_id, year, month) do update
  set status = excluded.status,
    confirmed_at = excluded.confirmed_at,
    confirmed_by = excluded.confirmed_by,
    confirmed_source_revision = excluded.confirmed_source_revision,
    note = excluded.note,
    updated_by = excluded.updated_by
  where p_auto_cutoff is null or (
    public.attendance_monthly_confirmations.status = 'pending'
    and public.attendance_monthly_confirmations.updated_at < p_auto_cutoff
  )
  returning * into saved;

  if saved.id is not null then
    return next saved;
  end if;
end;
$$;
revoke all on function public.save_attendance_monthly_confirmation_checked(
  uuid, integer, integer, text, text, text, bigint, timestamptz
) from public, anon, authenticated, service_role;
grant execute on function public.save_attendance_monthly_confirmation_checked(
  uuid, integer, integer, text, text, text, bigint, timestamptz
) to service_role;


-- The existing service-only legacy importer must stamp confirmed rows with
-- the same source revision as the imported entitlements and adjustments.
-- Owner-level whole-database restore preserves this function and its data;
-- the repository intentionally has no JSON/REST row-restoration path.
create or replace function private.apply_attendance_legacy_import(
  p_payload jsonb,
  p_source_file_hash text,
  p_actor text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  entitlement_count integer := 0;
  adjustment_count integer := 0;
  confirmation_count integer := 0;
begin
  if p_payload is null
    or jsonb_typeof(p_payload) <> 'object'
    or jsonb_typeof(coalesce(p_payload -> 'openings', '[]'::jsonb)) <> 'array'
    or jsonb_typeof(coalesce(p_payload -> 'monthly', '[]'::jsonb)) <> 'array'
    or jsonb_array_length(coalesce(p_payload -> 'openings', '[]'::jsonb)) > 1000
    or jsonb_array_length(coalesce(p_payload -> 'monthly', '[]'::jsonb)) > 10000
    or p_source_file_hash !~ '^[0-9a-f]{64}$'
    or btrim(coalesce(p_actor, '')) = ''
  then
    raise exception 'A valid attendance legacy-import payload is required.';
  end if;

  perform set_config('app.audit_actor_id', p_actor, true);
  perform set_config('app.audit_actor_name', p_actor, true);
  perform set_config(
    'app.audit_context',
    jsonb_build_object(
      'action', 'attendance-legacy-import',
      'pageId', 'attendance-record',
      'sourceFileHash', p_source_file_hash
    )::text,
    true
  );

  -- An annual workbook is an authoritative replacement for its year. Remove
  -- only rows previously owned by the legacy importer; manual records remain.
  delete from public.attendance_entitlements as existing
  where existing.note like 'Imported from legacy attendance workbook (%'
    and existing.year in (
      select scope.year
      from (
        select opening.year
        from jsonb_to_recordset(coalesce(p_payload -> 'openings', '[]'::jsonb))
          as opening(year integer)
        union
        select monthly.year
        from jsonb_to_recordset(coalesce(p_payload -> 'monthly', '[]'::jsonb))
          as monthly(year integer)
      ) as scope
      where scope.year between 2000 and 2200
    );

  delete from public.attendance_monthly_adjustments as existing
  where existing.source like 'legacy-monthly:%'
    and existing.year in (
      select scope.year
      from (
        select opening.year
        from jsonb_to_recordset(coalesce(p_payload -> 'openings', '[]'::jsonb))
          as opening(year integer)
        union
        select monthly.year
        from jsonb_to_recordset(coalesce(p_payload -> 'monthly', '[]'::jsonb))
          as monthly(year integer)
      ) as scope
      where scope.year between 2000 and 2200
    );

  delete from public.attendance_monthly_confirmations as existing
  where existing.note like 'Imported from legacy monthly statement %'
    and existing.year in (
      select scope.year
      from (
        select opening.year
        from jsonb_to_recordset(coalesce(p_payload -> 'openings', '[]'::jsonb))
          as opening(year integer)
        union
        select monthly.year
        from jsonb_to_recordset(coalesce(p_payload -> 'monthly', '[]'::jsonb))
          as monthly(year integer)
      ) as scope
      where scope.year between 2000 and 2200
    );

  insert into public.attendance_entitlements (
    person_id,
    year,
    allowance_units,
    opening_carry_forward_units,
    source_file_hash,
    note,
    created_by,
    updated_by
  )
  select
    opening.person_id,
    opening.year,
    opening.allowance_units,
    opening.opening_carry_forward_units,
    p_source_file_hash,
    'Imported from legacy attendance workbook (' || opening.source_key || ')',
    p_actor,
    p_actor
  from jsonb_to_recordset(coalesce(p_payload -> 'openings', '[]'::jsonb)) as opening(
    person_id uuid,
    year integer,
    allowance_units numeric,
    opening_carry_forward_units numeric,
    source_key text
  )
  where opening.person_id is not null
    and opening.year between 2000 and 2200
    and opening.allowance_units between 0 and 366
    and opening.opening_carry_forward_units between -366 and 366
    and btrim(coalesce(opening.source_key, '')) <> ''
  on conflict (person_id, year) do update
  set
    allowance_units = excluded.allowance_units,
    opening_carry_forward_units = excluded.opening_carry_forward_units,
    source_file_hash = excluded.source_file_hash,
    note = excluded.note,
    updated_by = excluded.updated_by;
  get diagnostics entitlement_count = row_count;

  insert into public.attendance_monthly_adjustments (
    person_id,
    year,
    month,
    code,
    units,
    source,
    source_file_hash,
    is_confirmed,
    note,
    created_by,
    updated_by
  )
  select
    monthly.person_id,
    monthly.year,
    monthly.month,
    category.code,
    category.units,
    monthly.source_key,
    p_source_file_hash,
    coalesce(monthly.is_confirmed, false),
    'Imported from legacy monthly statement ' || monthly.statement_date::text,
    p_actor,
    p_actor
  from jsonb_to_recordset(coalesce(p_payload -> 'monthly', '[]'::jsonb)) as monthly(
    person_id uuid,
    year integer,
    month integer,
    source_key text,
    statement_date date,
    categories jsonb,
    is_confirmed boolean
  )
  cross join lateral (
    select
      entries.key as code,
      (entries.value #>> '{}')::numeric as units
    from jsonb_each(coalesce(monthly.categories, '{}'::jsonb)) as entries
    where entries.key in ('ALS', 'ALU', 'SLM', 'SLR', 'SLX', 'HOL', 'SPL', 'MTL', 'NPL', 'HO', 'OS')
      and jsonb_typeof(entries.value) = 'number'
      and (entries.value #>> '{}')::numeric <> 0
      and (entries.value #>> '{}')::numeric between -366 and 366
  ) as category
  where monthly.person_id is not null
    and monthly.year between 2000 and 2200
    and monthly.month between 1 and 12
    and btrim(coalesce(monthly.source_key, '')) <> '';
  get diagnostics adjustment_count = row_count;

  insert into public.attendance_monthly_confirmations (
    person_id,
    year,
    month,
    status,
    confirmed_at,
    confirmed_by,
    confirmed_source_revision,
    note,
    created_by,
    updated_by
  )
  select
    monthly.person_id,
    monthly.year,
    monthly.month,
    case when monthly.is_confirmed then 'confirmed' else 'pending' end,
    case when monthly.is_confirmed then clock_timestamp() else null end,
    case when monthly.is_confirmed then p_actor else null end,
    case when monthly.is_confirmed then
      (select revision from private.attendance_source_revision_state where singleton)
      else null end,
    'Imported from legacy monthly statement ' || monthly.statement_date::text,
    p_actor,
    p_actor
  from (
    select distinct on (incoming.person_id, incoming.year, incoming.month)
      incoming.*
    from jsonb_to_recordset(coalesce(p_payload -> 'monthly', '[]'::jsonb)) as incoming(
      person_id uuid,
      year integer,
      month integer,
      source_key text,
      statement_date date,
      categories jsonb,
      is_confirmed boolean
    )
    where incoming.person_id is not null
      and incoming.year between 2000 and 2200
      and incoming.month between 1 and 12
    order by incoming.person_id, incoming.year, incoming.month, incoming.statement_date desc
  ) as monthly
  on conflict (person_id, year, month) do update
  set
    status = excluded.status,
    confirmed_at = excluded.confirmed_at,
    confirmed_by = excluded.confirmed_by,
    confirmed_source_revision = excluded.confirmed_source_revision,
    note = excluded.note,
    updated_by = excluded.updated_by;
  get diagnostics confirmation_count = row_count;

  return jsonb_build_object(
    'entitlementsUpserted', entitlement_count,
    'monthlyAdjustmentsUpserted', adjustment_count,
    'confirmationsUpserted', confirmation_count
  );
end;
$$;
revoke all on function private.apply_attendance_legacy_import(jsonb, text, text)
  from public, anon, authenticated, service_role;


-- The one-time Jan-Jun detail importer restores its pre-import confirmation
-- snapshot after inserting source rows. Stamp that snapshot with the revision
-- of the imported source data; otherwise the confirmation guard rejects it.
create or replace function public.import_attendance_legacy_detail(
  p_punches jsonb,
  p_leaves jsonb,
  p_holidays jsonb,
  p_expected jsonb,
  p_actor text default 'system:legacy-attendance-import',
  p_dt_start date default date '2026-04-01'
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
  mismatch_count integer;
  punch_count integer;
  leave_count integer;
  holiday_count integer;
begin
  if jsonb_typeof(p_punches) <> 'array'
     or jsonb_typeof(p_leaves) <> 'array'
     or jsonb_typeof(p_holidays) <> 'array'
     or jsonb_typeof(p_expected) <> 'array' then
    raise exception 'Legacy attendance import payloads must be JSON arrays.';
  end if;
  if btrim(coalesce(p_actor, '')) = '' then
    raise exception 'Legacy attendance import actor is required.';
  end if;
  if p_dt_start <> date '2026-04-01' then
    raise exception 'DT legacy start date must be 2026-04-01 for this import.';
  end if;

  perform set_config('app.audit_actor_id', p_actor, true);
  perform set_config('app.audit_actor_name', 'Codex legacy attendance import', true);
  perform set_config(
    'app.audit_context',
    '{"source":"approved-legacy-xls-import","period":"2026-01-01/2026-06-30"}',
    true
  );

  if exists (
    select 1 from public.attendance_raw_punches
    where work_date between date '2026-01-01' and date '2026-06-30'
  ) or exists (
    select 1 from public.attendance_leave_entries
    where leave_date between date '2026-01-01' and date '2026-06-30'
  ) or exists (
    select 1 from public.attendance_work_mode_overrides
    where work_date between date '2026-01-01' and date '2026-06-30'
  ) then
    raise exception 'Jan-Jun detailed attendance data already exists; import aborted.';
  end if;

  create temp table import_confirmation_snapshot on commit drop as
  select c.*
  from public.attendance_monthly_confirmations as c
  join public.attendance_people as p on p.id = c.person_id
  where p.is_active and c.year = 2026 and c.month between 1 and 6;

  create temp table import_expected(
    staff_code text,
    month_number integer,
    code text,
    units numeric
  ) on commit drop;
  insert into import_expected(staff_code, month_number, code, units)
  select upper(btrim(value.staff_code)), value.month_number, upper(btrim(value.code)), value.units
  from jsonb_to_recordset(p_expected) as value(
    staff_code text,
    month_number integer,
    code text,
    units numeric
  );

  if exists (
    select 1 from import_expected
    where month_number not between 1 and 6
       or code not in ('ALS','ALU','SLM','SLR','SLX','HOL','SPL','MTL','NPL','HO','OS')
       or units <= 0
  ) then
    raise exception 'Legacy expected totals contain an invalid period, code, or unit value.';
  end if;

  update public.attendance_people
  set employment_start_date = p_dt_start,
      updated_at = clock_timestamp()
  where staff_code = 'DT' and is_active;

  update public.attendance_team_assignments as assignment
  set effective_from = p_dt_start,
      updated_at = clock_timestamp()
  from public.attendance_people as person
  where person.id = assignment.person_id
    and person.staff_code = 'DT'
    and assignment.effective_from < p_dt_start;

  insert into public.attendance_raw_punches(
    person_id,
    source_record_key,
    source_record_id,
    dingtalk_user_id,
    check_type,
    punch_time,
    work_date,
    source_type,
    time_result,
    location_result,
    raw_payload
  )
  select
    person.id,
    value.source_record_key,
    value.source_record_id,
    coalesce(person.dingtalk_user_id, 'legacy-xls:' || lower(person.staff_code)),
    value.check_type,
    value.punch_time,
    value.work_date,
    'LEGACY_XLS',
    'Normal',
    'Normal',
    value.raw_payload
  from jsonb_to_recordset(p_punches) as value(
    staff_code text,
    source_record_key text,
    source_record_id text,
    check_type text,
    punch_time timestamptz,
    work_date date,
    raw_payload jsonb
  )
  join public.attendance_people as person
    on person.staff_code = upper(btrim(value.staff_code)) and person.is_active;
  get diagnostics punch_count = row_count;

  insert into public.attendance_leave_entries(
    person_id,
    leave_date,
    portion,
    code,
    source,
    note,
    created_by,
    updated_by
  )
  select
    person.id,
    value.leave_date,
    value.portion,
    upper(btrim(value.code)),
    'manual',
    value.note,
    p_actor,
    p_actor
  from jsonb_to_recordset(p_leaves) as value(
    staff_code text,
    leave_date date,
    portion text,
    code text,
    note text
  )
  join public.attendance_people as person
    on person.staff_code = upper(btrim(value.staff_code)) and person.is_active;
  get diagnostics leave_count = row_count;

  insert into public.attendance_work_mode_overrides(
    person_id,
    work_date,
    mode,
    note,
    created_by,
    updated_by
  )
  select
    person.id,
    value.work_date,
    'office',
    value.note,
    p_actor,
    p_actor
  from jsonb_to_recordset(p_holidays) as value(
    staff_code text,
    work_date date,
    note text
  )
  join public.attendance_people as person
    on person.staff_code = upper(btrim(value.staff_code)) and person.is_active;
  get diagnostics holiday_count = row_count;

  if punch_count <> jsonb_array_length(p_punches)
     or leave_count <> jsonb_array_length(p_leaves)
     or holiday_count <> jsonb_array_length(p_holidays) then
    raise exception 'One or more legacy import rows did not map to the current attendance roster.';
  end if;

  delete from public.attendance_monthly_adjustments as adjustment
  using public.attendance_people as person
  where person.id = adjustment.person_id
    and person.is_active
    and adjustment.year = 2026
    and adjustment.month between 1 and 6
    and adjustment.source like 'legacy-monthly:%';

  with detail as (
    select
      person.staff_code,
      extract(month from entry.leave_date)::integer as month_number,
      entry.code,
      sum(entry.units)::numeric as units
    from public.attendance_leave_entries as entry
    join public.attendance_people as person on person.id = entry.person_id
    where person.is_active
      and entry.leave_date between date '2026-01-01' and date '2026-06-30'
    group by person.staff_code, extract(month from entry.leave_date), entry.code
    union all
    select
      person.staff_code,
      extract(month from mode.work_date)::integer,
      'HOL',
      count(*)::numeric
    from public.attendance_work_mode_overrides as mode
    join public.attendance_people as person on person.id = mode.person_id
    where person.is_active
      and mode.work_date between date '2026-01-01' and date '2026-06-30'
      and mode.mode = 'office'
      and mode.note like 'Legacy holiday attendance import:%'
    group by person.staff_code, extract(month from mode.work_date)
  ), actual as (
    select staff_code, month_number, code, sum(units)::numeric as units
    from detail
    group by staff_code, month_number, code
  )
  select count(*)
  into mismatch_count
  from import_expected as expected
  full join actual using(staff_code, month_number, code)
  where expected.units is distinct from actual.units;

  if mismatch_count <> 0 then
    raise exception 'Imported detail totals do not match the reconciled workbook totals (% mismatches).', mismatch_count;
  end if;

  update public.attendance_monthly_confirmations as confirmation
  set status = snapshot.status,
      confirmed_at = snapshot.confirmed_at,
      confirmed_by = snapshot.confirmed_by,
      confirmed_source_revision = case when snapshot.status = 'confirmed' then
        public.attendance_source_revision()
        else null end,
      note = snapshot.note,
      created_by = snapshot.created_by,
      updated_by = snapshot.updated_by
  from import_confirmation_snapshot as snapshot
  where confirmation.id = snapshot.id;

  return jsonb_build_object(
    'punches', punch_count,
    'leaveEntries', leave_count,
    'holidayAttendanceDays', holiday_count,
    'detailTotalMismatches', mismatch_count,
    'dtStartDate', p_dt_start
  );
end;
$$;
revoke all on function public.import_attendance_legacy_detail(
  jsonb, jsonb, jsonb, jsonb, text, date
) from public, anon, authenticated, service_role;
grant execute on function public.import_attendance_legacy_detail(
  jsonb, jsonb, jsonb, jsonb, text, date
) to service_role;
