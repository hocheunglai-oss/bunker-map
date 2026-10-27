-- Annual approvals are separate from December monthly approvals. This is an
-- additive cutover: no monthly row is rewritten, copied or deleted.
set local lock_timeout = '5s';
set local statement_timeout = '30s';

do $preflight$
begin
  -- Same lock order as checked confirmations and source invalidation.
  perform 1 from private.attendance_source_revision_state where singleton for update;
  if not found then raise exception 'Attendance source revision is unavailable.'; end if;
  lock table public.attendance_monthly_confirmations in share row exclusive mode;
  if exists (select 1 from public.attendance_monthly_confirmations
    where btrim(note) = 'annual-summary') then
    raise exception 'Legacy annual confirmation appeared during cutover; review it before applying this migration.';
  end if;
end;
$preflight$;

create table public.attendance_annual_confirmations (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references public.attendance_people(id) on delete restrict,
  year integer not null check (year between 2000 and 2200),
  status text not null default 'pending' check (status in ('pending', 'confirmed')),
  confirmed_at timestamptz,
  confirmed_by text,
  note text not null default '',
  created_by text not null check (btrim(created_by) <> ''),
  updated_by text not null check (btrim(updated_by) <> ''),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  confirmed_source_revision bigint check (confirmed_source_revision is null or confirmed_source_revision >= 0),
  constraint attendance_annual_confirmations_shape check (
    (status = 'pending' and confirmed_at is null and confirmed_by is null
      and confirmed_source_revision is null)
    or (status = 'confirmed' and confirmed_at is not null
      and btrim(coalesce(confirmed_by, '')) <> ''
      and confirmed_source_revision is not null)
  ),
  unique (person_id, year)
);
create index attendance_annual_confirmations_period_idx
  on public.attendance_annual_confirmations(year, status);
alter table public.attendance_annual_confirmations enable row level security;
revoke all on public.attendance_annual_confirmations from public, anon, authenticated, service_role;
grant select, insert, update, delete on public.attendance_annual_confirmations to service_role;
create trigger set_attendance_annual_confirmations_updated_at
before update on public.attendance_annual_confirmations
for each row execute function private.set_attendance_updated_at();
create trigger bunker_map_backup_epoch_fence
after insert or update or delete or truncate on public.attendance_annual_confirmations
for each statement execute function private.record_bunker_map_backup_mutation();
select public.audit_enable_table('public.attendance_annual_confirmations'::regclass);

-- Direct writes and generic audit Undo take the same lock order as the RPC.
-- This lock does not advance the source revision: confirmation is not source.
create function private.lock_attendance_annual_confirmation_source()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $annual_lock$
begin
  perform 1 from private.attendance_source_revision_state where singleton for update;
  if not found then raise exception 'Attendance source revision is unavailable.'; end if;
  return null;
end;
$annual_lock$;
revoke all on function private.lock_attendance_annual_confirmation_source()
  from public, anon, authenticated, service_role;
create trigger attendance_annual_confirmation_source_lock
before insert or update or delete or truncate on public.attendance_annual_confirmations
for each statement execute function private.lock_attendance_annual_confirmation_source();

-- Old tabs may not encode an annual approval in December after the cutover.
alter table public.attendance_monthly_confirmations
  add constraint attendance_monthly_confirmations_not_annual
  check (btrim(note) <> 'annual-summary');

create function private.assert_attendance_annual_evidence(p_person_id uuid, p_year integer)
returns void
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $annual_evidence$
begin
  if exists (select 1 from generate_series(1,12) as checked_month(month_number)
    where public.attendance_open_dingtalk_punch_anomaly_count(
      p_person_id, p_year, checked_month.month_number) > 0) then
    raise exception using errcode = 'P0001',
      message = 'ATTENDANCE_DINGTALK_ANOMALY_OPEN: Review the source punch discrepancy before confirming.';
  end if;
  if private.attendance_unresolved_sync_failure(p_person_id,p_year,1,12) then
    raise exception using errcode = 'P0001',
      message = 'ATTENDANCE_SYNC_INCOMPLETE: Recheck the affected DingTalk attendance before confirming.';
  end if;
  if private.attendance_historical_dingtalk_identity_mismatch(p_person_id,p_year,1,12) then
    raise exception using errcode = 'P0001',
      message = 'ATTENDANCE_DINGTALK_IDENTITY_MISMATCH: Review punches from a different DingTalk identity before confirming.';
  end if;
end;
$annual_evidence$;
revoke all on function private.assert_attendance_annual_evidence(uuid,integer)
  from public, anon, authenticated, service_role;

create function private.enforce_attendance_annual_confirmation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $annual_guard$
declare
  current_revision bigint;
begin
  if new.status <> 'confirmed' then
    new.confirmed_source_revision := null;
    return new;
  end if;
  select revision into current_revision
  from private.attendance_source_revision_state where singleton for update;
  if current_revision is null then raise exception 'Attendance source revision is unavailable.'; end if;
  if make_date(new.year + 1, 1, 1) >
    (clock_timestamp() at time zone 'Asia/Hong_Kong')::date then
    raise exception 'Annual attendance can be confirmed only after the Hong Kong year has closed.';
  end if;
  if new.confirmed_source_revision is distinct from current_revision then
    raise exception using errcode = 'P0001',
      message = 'ATTENDANCE_SOURCE_CHANGED: Refresh attendance before confirming.';
  end if;
  perform private.assert_attendance_annual_evidence(new.person_id,new.year);
  return new;
end;
$annual_guard$;
revoke all on function private.enforce_attendance_annual_confirmation()
  from public, anon, authenticated, service_role;
create trigger enforce_attendance_annual_confirmation
before insert or update on public.attendance_annual_confirmations
for each row execute function private.enforce_attendance_annual_confirmation();

create function public.save_attendance_annual_confirmation_checked(
  p_person_id uuid, p_year integer, p_status text, p_note text,
  p_actor text, p_expected_revision bigint
)
returns setof public.attendance_annual_confirmations
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $annual_rpc$
declare
  current_revision bigint;
  existing public.attendance_annual_confirmations%rowtype;
  saved public.attendance_annual_confirmations%rowtype;
  audit_context jsonb;
begin
  if p_person_id is null or p_year is null or p_year not between 2000 and 2200
    or p_status is null or p_status not in ('pending','confirmed')
    or p_actor is null or btrim(p_actor) = '' then
    raise exception 'Invalid annual attendance confirmation request.';
  end if;
  select revision into current_revision
  from private.attendance_source_revision_state where singleton for update;
  if current_revision is null then raise exception 'Attendance source revision is unavailable.'; end if;
  if p_status = 'confirmed' then
    if make_date(p_year + 1, 1, 1) >
      (clock_timestamp() at time zone 'Asia/Hong_Kong')::date then
      raise exception 'Annual attendance can be confirmed only after the Hong Kong year has closed.';
    end if;
    if p_expected_revision is distinct from current_revision then
      raise exception using errcode = 'P0001',
        message = 'ATTENDANCE_SOURCE_CHANGED: Refresh attendance before confirming.';
    end if;
  end if;
  select * into existing from public.attendance_annual_confirmations
  where person_id=p_person_id and year=p_year for update;
  if p_status='confirmed' and existing.id is not null and existing.status='confirmed' then
    if existing.note=coalesce(p_note,'') and existing.confirmed_source_revision=current_revision
    then return next existing; return; end if;
    raise exception using errcode='P0001',
      message='ATTENDANCE_ALREADY_CONFIRMED: Reload the attendance statement before changing a confirmation.';
  end if;
  audit_context := public.audit_json_setting('app.audit_context');
  if jsonb_typeof(audit_context) is distinct from 'object' then audit_context := '{}'::jsonb; end if;
  perform set_config('app.audit_actor_id',p_actor,true);
  perform set_config('app.audit_actor_name',p_actor,true);
  perform set_config('app.audit_context',(audit_context || jsonb_build_object(
    'action',case when p_status='pending' then 'attendance-annual-confirmation-reset'
      else 'attendance-annual-confirmation-save' end,
    'pageId','attendance-record','personId',p_person_id,'year',p_year,
    'confirmationKind','annual','status',p_status,'sourceRevision',current_revision
  ))::text,true);
  insert into public.attendance_annual_confirmations(
    person_id,year,status,confirmed_at,confirmed_by,confirmed_source_revision,note,created_by,updated_by
  ) values(p_person_id,p_year,p_status,
    case when p_status='confirmed' then clock_timestamp() else null end,
    case when p_status='confirmed' then p_actor else null end,
    case when p_status='confirmed' then current_revision else null end,
    coalesce(p_note,''),p_actor,p_actor
  )
  on conflict(person_id,year) do update set
    status=excluded.status,confirmed_at=excluded.confirmed_at,confirmed_by=excluded.confirmed_by,
    confirmed_source_revision=excluded.confirmed_source_revision,note=excluded.note,updated_by=excluded.updated_by
  returning * into saved;
  return next saved;
end;
$annual_rpc$;
revoke all on function public.save_attendance_annual_confirmation_checked(uuid,integer,text,text,text,bigint)
  from public, anon, authenticated, service_role;
grant execute on function public.save_attendance_annual_confirmation_checked(uuid,integer,text,text,text,bigint)
  to service_role;

-- Existing monthly auto-cutoff and revision semantics are retained.
-- Attribute each checked monthly confirmation to its service actor in the same
-- transaction as the audited row write. Preserve caller audit context fields.
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
  audit_context jsonb;
begin
  if btrim(coalesce(p_note, '')) = 'annual-summary' then
    raise exception using errcode = 'P0001',
      message = 'ATTENDANCE_ANNUAL_CONFIRMATION_SEPARATE: Reload the year-end statement before confirming.';
  end if;
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
    raise exception using
      errcode = 'P0001',
      message = 'ATTENDANCE_ALREADY_CONFIRMED: Reload the attendance statement before changing a confirmation.';
  end if;

  -- Audit context must be set inside this service-only RPC transaction. The
  -- table audit trigger skips writes without an actor, and a separate request
  -- cannot carry transaction-local settings to the confirmation write.
  audit_context := public.audit_json_setting('app.audit_context');
  if jsonb_typeof(audit_context) is distinct from 'object' then
    audit_context := '{}'::jsonb;
  end if;
  perform set_config('app.audit_actor_id', p_actor, true);
  perform set_config('app.audit_actor_name', p_actor, true);
  perform set_config(
    'app.audit_context',
    (audit_context || jsonb_strip_nulls(jsonb_build_object(
      'action', case
        when p_auto_cutoff is not null then 'attendance-auto-confirm'
        when p_status = 'pending' then 'attendance-confirmation-reset'
        else 'attendance-confirmation-save'
      end,
      'pageId', 'attendance-record',
      'personId', p_person_id,
      'year', p_year,
      'month', p_month,
      'status', p_status,
      'sourceRevision', current_revision,
      'autoCutoff', p_auto_cutoff
    )))::text,
    true
  );

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


create or replace function private.reset_attendance_confirmations_for_range(
  p_person_id uuid,
  p_from date,
  p_to date
)
returns void
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
  actor text := coalesce(
    nullif(current_setting('app.audit_actor_name', true), ''),
    nullif(current_setting('app.audit_actor_id', true), ''),
    'system:attendance-source-change'
  );
begin
  if p_person_id is null or p_from is null then return; end if;

  update public.attendance_monthly_confirmations as confirmations
  set status = 'pending', confirmed_at = null, confirmed_by = null,
    updated_by = actor
  where confirmations.person_id = p_person_id
    and confirmations.status = 'confirmed'
    and make_date(confirmations.year, confirmations.month, 1)
      <= coalesce(p_to, date '2200-12-31')
    and (make_date(confirmations.year, confirmations.month, 1)
      + interval '1 month - 1 day')::date >= p_from;

  update public.attendance_annual_confirmations as confirmations
  set status = 'pending', confirmed_at = null, confirmed_by = null,
    confirmed_source_revision = null, updated_by = actor
  where confirmations.person_id = p_person_id
    and confirmations.status = 'confirmed'
    and make_date(confirmations.year,1,1) <= coalesce(p_to,date '2200-12-31')
    and make_date(confirmations.year,12,31) >= p_from;

end;
$$;

create or replace function private.invalidate_attendance_calendar_confirmations()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  affected record;
  actor text := coalesce(
    nullif(current_setting('app.audit_actor_name', true), ''),
    nullif(current_setting('app.audit_actor_id', true), ''),
    'system:event-calendar-holiday-change'
  );
begin
  if new.key <> 'event-calendar' then return new; end if;

  for affected in
    with old_effects as (
      select * from private.attendance_hk_holiday_effects(
        case when tg_op = 'INSERT' then '{}'::jsonb else old.payload end
      )
    ), new_effects as (
      select * from private.attendance_hk_holiday_effects(new.payload)
    )
    select distinct
      extract(year from coalesce(previous.event_date, current.event_date))::integer as year,
      extract(month from coalesce(previous.event_date, current.event_date))::integer as month
    from old_effects as previous
    full join new_effects as current using (event_date)
    where previous.attendee_codes is distinct from current.attendee_codes
      and coalesce(previous.event_date, current.event_date) >= date '2026-09-01'
  loop
    update public.attendance_monthly_confirmations as confirmations
    set status = 'pending', confirmed_at = null, confirmed_by = null,
      updated_by = actor
    where confirmations.year = affected.year
      and confirmations.month = affected.month
      and confirmations.status = 'confirmed';

    update public.attendance_annual_confirmations as confirmations
    set status = 'pending', confirmed_at = null, confirmed_by = null,
      confirmed_source_revision = null, updated_by = actor
    where confirmations.year = affected.year and confirmations.status = 'confirmed';
  end loop;

  return new;
end;
$$;

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

    update public.attendance_annual_confirmations as confirmations
    set status='pending',confirmed_at=null,confirmed_by=null,
      confirmed_source_revision=null,updated_by=actor
    where confirmations.status='confirmed' and confirmations.year>=2026;
  end if;
  return new;
end;
$$;

create or replace function private.invalidate_incomplete_attendance_sync()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  first_date date;
  last_date date;
  manifest_count integer;
  manifest_valid boolean;
  affected_person uuid;
  scope_valid boolean;
  scope_unknown boolean := true;
  scope_item jsonb;
  scope_date date;
  scope_person uuid;
  scope_date_text text;
begin
  if new.status not in ('partial', 'failed') then return new; end if;
  if tg_op = 'UPDATE'
    and old.status = new.status
    and old.completed_at is not distinct from new.completed_at
    and old.window_from is not distinct from new.window_from
    and old.window_to is not distinct from new.window_to
    and old.people_requested is not distinct from new.people_requested
    and old.requested_people is not distinct from new.requested_people
    and old.failure_scope is not distinct from new.failure_scope
  then
    return new;
  end if;

  first_date := (new.window_from at time zone 'Asia/Hong_Kong')::date;
  -- Sync windows touch at whole-second endpoints. The following window owns
  -- the shared endpoint, so a failure ending exactly at a month boundary
  -- must not reopen that unrelated next month.
  last_date := ((
    case when new.window_to > new.window_from
      then new.window_to - interval '1 microsecond'
      else new.window_to end)
    at time zone 'Asia/Hong_Kong'
  )::date;

  scope_valid := jsonb_typeof(new.failure_scope) = 'object'
    and jsonb_typeof(new.failure_scope->'unknown') = 'boolean'
    and jsonb_typeof(new.failure_scope->'affected') = 'array';
  if scope_valid then
    scope_unknown := (new.failure_scope->>'unknown')::boolean;
    for scope_item in
      select value from jsonb_array_elements(new.failure_scope->'affected') as item(value)
    loop
      if jsonb_typeof(scope_item) <> 'object'
        or not (scope_item ? 'person_id')
        or jsonb_typeof(scope_item->'work_date') <> 'string'
      then
        scope_valid := false;
        exit;
      end if;
      scope_date_text := scope_item->>'work_date';
      if scope_date_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
        scope_valid := false;
        exit;
      end if;
      begin
        scope_date := scope_date_text::date;
      exception when others then
        scope_valid := false;
        exit;
      end;
      if to_char(scope_date, 'YYYY-MM-DD') <> scope_date_text then
        scope_valid := false;
        exit;
      end if;
      if jsonb_typeof(scope_item->'person_id') = 'null' then
        continue;
      end if;
      if jsonb_typeof(scope_item->'person_id') <> 'string'
        or (scope_item->>'person_id') !~*
          '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then
        scope_valid := false;
        exit;
      end if;
    end loop;
  end if;

  if scope_valid and not scope_unknown then
    -- Empty affected list means the known correction/missing-punch ledger
    -- already reopened its exact person/month. It must not reset every month
    -- touched by a broad API query.
    for scope_item in
      select value from jsonb_array_elements(new.failure_scope->'affected') as item(value)
    loop
      scope_date := (scope_item->>'work_date')::date;
      if jsonb_typeof(scope_item->'person_id') = 'null' then
        for affected_person in
          select confirmation.person_id
          from public.attendance_monthly_confirmations as confirmation
          where confirmation.status = 'confirmed'
            and make_date(confirmation.year, confirmation.month, 1) <= scope_date
            and (make_date(confirmation.year, confirmation.month, 1)
              + interval '1 month - 1 day')::date >= scope_date
          union
          select annual.person_id from public.attendance_annual_confirmations as annual
          where annual.status='confirmed' and make_date(annual.year,1,1)<=scope_date
            and make_date(annual.year,12,31)>=scope_date
        loop
          perform private.reset_attendance_confirmations_for_range(
            affected_person, scope_date, scope_date
          );
        end loop;
      else
        scope_person := (scope_item->>'person_id')::uuid;
        perform private.reset_attendance_confirmations_for_range(
          scope_person, scope_date, scope_date
        );
      end if;
    end loop;
    return new;
  end if;

  select count(*)::integer,
    coalesce(bool_and(
      entry.key ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      and jsonb_typeof(entry.value) = 'string'
      and nullif(btrim(entry.value #>> '{}'), '') is not null
    ), false)
  into manifest_count, manifest_valid
  from jsonb_each(coalesce(new.requested_people, '{}'::jsonb)) as entry(key, value);
  manifest_valid := manifest_valid
    and manifest_count > 0
    and manifest_count = new.people_requested;

  if manifest_valid then
    for affected_person in
      select distinct entry.key::uuid
      from jsonb_each(new.requested_people) as entry(key, value)
    loop
      perform private.reset_attendance_confirmations_for_range(
        affected_person, first_date, last_date
      );
    end loop;
  else
    -- A failed run can have no reliable manifest (for example, roster load
    -- failed before the run was completed). Its window, rather than an
    -- invented identity, determines the conservative invalidation scope.
    for affected_person in
      select confirmation.person_id
      from public.attendance_monthly_confirmations as confirmation
      where confirmation.status = 'confirmed'
        and make_date(confirmation.year, confirmation.month, 1) <= last_date
        and (make_date(confirmation.year, confirmation.month, 1)
          + interval '1 month - 1 day')::date >= first_date
      union
      select annual.person_id from public.attendance_annual_confirmations as annual
      where annual.status='confirmed' and make_date(annual.year,1,1)<=last_date
        and make_date(annual.year,12,31)>=first_date
    loop
      perform private.reset_attendance_confirmations_for_range(
        affected_person, first_date, last_date
      );
    end loop;
  end if;
  return new;
end;
$$;

-- Add exact sparse-migration and physical receipt-schema evidence. Preserve the
-- current inventory/catalog/fence behavior; no business rows are changed.
-- Missing tables or recovery columns after their exact migration remain errors.
CREATE OR REPLACE FUNCTION public.get_bunker_map_backup_inventory()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  select pg_catalog.jsonb_build_object(
    'schema', 'bunker-map.backup-inventory/v1',
    'migrationHead', (
      select max(migration.version)
      from supabase_migrations.schema_migrations as migration
    ),
    'tables', coalesce(
      (
        select pg_catalog.jsonb_agg(tables.relname order by tables.relname)
        from pg_catalog.pg_class as tables
        join pg_catalog.pg_namespace as schemas
          on schemas.oid = tables.relnamespace
        where schemas.nspname = 'public'
          and tables.relkind in ('r', 'p')
          and tables.relpersistence = 'p'
      ),
      '[]'::jsonb
    ),
    'unfencedTables', coalesce(
      (
        select pg_catalog.jsonb_agg(tables.relname order by tables.relname)
        from pg_catalog.pg_class as tables
        join pg_catalog.pg_namespace as schemas
          on schemas.oid = tables.relnamespace
        where schemas.nspname = 'public'
          and tables.relkind in ('r', 'p')
          and tables.relpersistence = 'p'
          and tables.relname not in (
            'admin_sessions',
            'bunker_map_backup_lock',
            'outlook_exchange_sync_lock'
          )
          and not exists (
            select 1
            from pg_catalog.pg_trigger as triggers
            where triggers.tgrelid = tables.oid
              and triggers.tgname = 'bunker_map_backup_epoch_fence'
              and not triggers.tgisinternal
              and triggers.tgenabled in ('O', 'A')
              and triggers.tgfoid =
                'private.record_bunker_map_backup_mutation()'::regprocedure
              and (triggers.tgtype::integer & 1) = 0
              and (triggers.tgtype::integer & 2) = 0
              and (triggers.tgtype::integer & 64) = 0
              and (triggers.tgtype::integer & 60) = 60
          )
      ),
      '[]'::jsonb
    ),
    'catalogSha256', (
      select pg_catalog.encode(
        extensions.digest(
          pg_catalog.convert_to(
            coalesce(
              pg_catalog.string_agg(
                pg_catalog.jsonb_build_array(
                  tables.relname,
                  tables.relkind,
                  columns.attnum,
                  columns.attname,
                  pg_catalog.format_type(
                    columns.atttypid,
                    columns.atttypmod
                  ),
                  columns.attnotnull,
                  columns.attidentity,
                  columns.attgenerated,
                  columns.attcollation,
                  coalesce(
                    pg_catalog.pg_get_expr(
                      defaults.adbin,
                      defaults.adrelid
                    ),
                    ''
                  )
                )::text,
                E'\n'
                order by tables.relname, columns.attnum
              ),
              ''
            ),
            'UTF8'
          ),
          'sha256'
        ),
        'hex'
      )
      from pg_catalog.pg_class as tables
      join pg_catalog.pg_namespace as schemas
        on schemas.oid = tables.relnamespace
      join pg_catalog.pg_attribute as columns
        on columns.attrelid = tables.oid
      left join pg_catalog.pg_attrdef as defaults
        on defaults.adrelid = tables.oid
        and defaults.adnum = columns.attnum
      where schemas.nspname = 'public'
        and tables.relkind in ('r', 'p')
        and tables.relpersistence = 'p'
        and columns.attnum > 0
        and not columns.attisdropped
    )
  ) || pg_catalog.jsonb_build_object(
    'appliedMigrations', coalesce(
      (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
         'version', migration.version, 'name', migration.name
       ) order by migration.version)
       from supabase_migrations.schema_migrations as migration),
      '[]'::jsonb
    ),
    'annualConfirmationColumns', coalesce(
      (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'name',columns.attname,'type',pg_catalog.format_type(columns.atttypid,columns.atttypmod),
        'nullable',not columns.attnotnull) order by columns.attname)
       from pg_catalog.pg_attribute as columns
       where columns.attrelid=pg_catalog.to_regclass('public.attendance_annual_confirmations')
         and columns.attnum>0 and not columns.attisdropped),'[]'::jsonb),
    'receiptColumns', coalesce(
      (select pg_catalog.jsonb_agg(
         pg_catalog.jsonb_build_object(
           'name', columns.attname,
           'type', pg_catalog.format_type(columns.atttypid, columns.atttypmod),
           'nullable', not columns.attnotnull
         ) order by columns.attname
       )
       from pg_catalog.pg_attribute as columns
       where columns.attrelid = pg_catalog.to_regclass('public.price_setter_creation_receipts')
         and columns.attnum > 0 and not columns.attisdropped),
      '[]'::jsonb
    )
  );
$function$;
revoke all on function public.get_bunker_map_backup_inventory()
  from public, anon, authenticated;
grant execute on function public.get_bunker_map_backup_inventory()
  to service_role;
