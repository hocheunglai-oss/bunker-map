create extension if not exists "pgcrypto";

create table public.attendance_people (
  id uuid primary key default gen_random_uuid(),
  staff_code text not null,
  display_name text not null,
  dingtalk_user_id text,
  team text not null,
  is_active boolean not null default true,
  employment_start_date date,
  employment_end_date date,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint attendance_people_staff_code_format
    check (staff_code ~ '^[A-Z0-9][A-Z0-9_-]{0,15}$'),
  constraint attendance_people_display_name_not_blank
    check (btrim(display_name) <> ''),
  constraint attendance_people_dingtalk_user_id_not_blank
    check (dingtalk_user_id is null or btrim(dingtalk_user_id) <> ''),
  constraint attendance_people_team
    check (team in ('BT', 'BS', 'AC')),
  constraint attendance_people_employment_dates
    check (
      employment_end_date is null
      or employment_start_date is null
      or employment_end_date >= employment_start_date
    )
);

create unique index attendance_people_staff_code_key
  on public.attendance_people (staff_code);
create unique index attendance_people_dingtalk_user_id_key
  on public.attendance_people (dingtalk_user_id)
  where dingtalk_user_id is not null;
create index attendance_people_active_team_idx
  on public.attendance_people (is_active, team, staff_code);

create table public.attendance_raw_punches (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null
    references public.attendance_people(id) on delete restrict,
  source_record_key text not null,
  source_record_id text,
  dingtalk_user_id text not null,
  check_type text not null,
  punch_time timestamptz not null,
  work_date date not null,
  source_type text,
  device_sn text,
  time_result text,
  location_result text,
  raw_payload jsonb not null,
  first_seen_at timestamptz not null default clock_timestamp(),
  constraint attendance_raw_punches_source_record_key_format
    check (source_record_key ~ '^[0-9a-f]{64}$'),
  constraint attendance_raw_punches_source_record_id_not_blank
    check (source_record_id is null or btrim(source_record_id) <> ''),
  constraint attendance_raw_punches_dingtalk_user_id_not_blank
    check (btrim(dingtalk_user_id) <> ''),
  constraint attendance_raw_punches_check_type
    check (check_type in ('OnDuty', 'OffDuty')),
  constraint attendance_raw_punches_payload_object
    check (jsonb_typeof(raw_payload) = 'object')
);

create unique index attendance_raw_punches_source_record_key_key
  on public.attendance_raw_punches (source_record_key);
create index attendance_raw_punches_person_work_date_idx
  on public.attendance_raw_punches (person_id, work_date, punch_time);
create index attendance_raw_punches_dingtalk_user_time_idx
  on public.attendance_raw_punches (dingtalk_user_id, punch_time desc);

create table public.attendance_leave_entries (
  id uuid primary key default gen_random_uuid(),
  entry_group_id uuid not null default gen_random_uuid(),
  person_id uuid not null
    references public.attendance_people(id) on delete restrict,
  leave_date date not null,
  portion text not null,
  code text not null,
  units numeric(4, 2) generated always as (
    case when portion = 'full' then 1.00 else 0.50 end
  ) stored,
  source text not null default 'manual',
  note text not null default '',
  created_by text not null,
  updated_by text not null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint attendance_leave_entries_portion
    check (portion in ('full', 'am', 'pm')),
  constraint attendance_leave_entries_code
    check (code in ('ALS', 'ALU', 'SLM', 'SLR', 'SLX', 'SPL', 'MTL', 'NPL', 'HO', 'OS')),
  constraint attendance_leave_entries_manual_source
    check (source = 'manual'),
  constraint attendance_leave_entries_weekday
    check (extract(isodow from leave_date) between 1 and 5),
  constraint attendance_leave_entries_actor_not_blank
    check (btrim(created_by) <> '' and btrim(updated_by) <> ''),
  constraint attendance_leave_entries_person_date_portion_key
    unique (person_id, leave_date, portion)
);

create index attendance_leave_entries_person_date_idx
  on public.attendance_leave_entries (person_id, leave_date, portion);
create index attendance_leave_entries_group_idx
  on public.attendance_leave_entries (entry_group_id, leave_date);
create index attendance_leave_entries_date_code_idx
  on public.attendance_leave_entries (leave_date, code);

create table public.attendance_manual_overrides (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null
    references public.attendance_people(id) on delete restrict,
  work_date date not null,
  action text not null,
  check_type text,
  punch_time timestamptz,
  raw_punch_id uuid
    references public.attendance_raw_punches(id) on delete restrict,
  reason text not null,
  created_by text not null,
  updated_by text not null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint attendance_manual_overrides_action
    check (action in ('replace', 'exclude')),
  constraint attendance_manual_overrides_check_type
    check (check_type is null or check_type in ('OnDuty', 'OffDuty')),
  constraint attendance_manual_overrides_shape
    check (
      (
        action = 'replace'
        and check_type is not null
        and punch_time is not null
        and raw_punch_id is null
      )
      or
      (
        action = 'exclude'
        and check_type is null
        and punch_time is null
        and raw_punch_id is not null
      )
    ),
  constraint attendance_manual_overrides_reason_not_blank
    check (btrim(reason) <> ''),
  constraint attendance_manual_overrides_actor_not_blank
    check (btrim(created_by) <> '' and btrim(updated_by) <> '')
);

create unique index attendance_manual_overrides_replace_key
  on public.attendance_manual_overrides (person_id, work_date, check_type)
  where action = 'replace';
create unique index attendance_manual_overrides_exclude_key
  on public.attendance_manual_overrides (raw_punch_id)
  where action = 'exclude';
create index attendance_manual_overrides_person_date_idx
  on public.attendance_manual_overrides (person_id, work_date);

create table public.attendance_entitlements (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null
    references public.attendance_people(id) on delete restrict,
  year integer not null,
  allowance_units numeric(6, 2) not null default 0,
  opening_carry_forward_units numeric(6, 2) not null default 0,
  source_file_hash text,
  note text not null default '',
  created_by text not null,
  updated_by text not null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint attendance_entitlements_year
    check (year between 2000 and 2200),
  constraint attendance_entitlements_allowance
    check (allowance_units between 0 and 366),
  constraint attendance_entitlements_opening_carry_forward
    check (opening_carry_forward_units between -366 and 366),
  constraint attendance_entitlements_source_file_hash
    check (source_file_hash is null or source_file_hash ~ '^[0-9a-f]{64}$'),
  constraint attendance_entitlements_actor_not_blank
    check (btrim(created_by) <> '' and btrim(updated_by) <> ''),
  constraint attendance_entitlements_person_year_key
    unique (person_id, year)
);

create index attendance_entitlements_year_idx
  on public.attendance_entitlements (year, person_id);

create table public.attendance_monthly_adjustments (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null
    references public.attendance_people(id) on delete restrict,
  year integer not null,
  month integer not null,
  code text not null,
  units numeric(6, 2) not null,
  source text not null,
  source_file_hash text,
  is_confirmed boolean not null default false,
  note text not null default '',
  created_by text not null,
  updated_by text not null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint attendance_monthly_adjustments_year
    check (year between 2000 and 2200),
  constraint attendance_monthly_adjustments_month
    check (month between 1 and 12),
  constraint attendance_monthly_adjustments_code
    check (code in ('ALS', 'ALU', 'SLM', 'SLR', 'SLX', 'HOL', 'SPL', 'MTL', 'NPL', 'HO', 'OS')),
  constraint attendance_monthly_adjustments_units
    check (units <> 0 and units between -366 and 366),
  constraint attendance_monthly_adjustments_source_not_blank
    check (btrim(source) <> ''),
  constraint attendance_monthly_adjustments_source_file_hash
    check (source_file_hash is null or source_file_hash ~ '^[0-9a-f]{64}$'),
  constraint attendance_monthly_adjustments_actor_not_blank
    check (btrim(created_by) <> '' and btrim(updated_by) <> ''),
  constraint attendance_monthly_adjustments_import_key
    unique (person_id, year, month, code, source)
);

create index attendance_monthly_adjustments_period_idx
  on public.attendance_monthly_adjustments (year, month, person_id);

create table public.attendance_monthly_confirmations (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null
    references public.attendance_people(id) on delete restrict,
  year integer not null,
  month integer not null,
  status text not null default 'pending',
  confirmed_at timestamptz,
  confirmed_by text,
  note text not null default '',
  created_by text not null,
  updated_by text not null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint attendance_monthly_confirmations_year
    check (year between 2000 and 2200),
  constraint attendance_monthly_confirmations_month
    check (month between 1 and 12),
  constraint attendance_monthly_confirmations_status
    check (status in ('pending', 'confirmed')),
  constraint attendance_monthly_confirmations_shape
    check (
      (status = 'pending' and confirmed_at is null and confirmed_by is null)
      or
      (
        status = 'confirmed'
        and confirmed_at is not null
        and btrim(coalesce(confirmed_by, '')) <> ''
      )
    ),
  constraint attendance_monthly_confirmations_actor_not_blank
    check (btrim(created_by) <> '' and btrim(updated_by) <> ''),
  constraint attendance_monthly_confirmations_person_period_key
    unique (person_id, year, month)
);

create index attendance_monthly_confirmations_period_idx
  on public.attendance_monthly_confirmations (year, month, status);

create table public.attendance_sync_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  window_from timestamptz not null,
  window_to timestamptz not null,
  status text not null default 'running',
  people_requested integer not null default 0,
  batches_attempted integer not null default 0,
  records_fetched integer not null default 0,
  records_inserted integer not null default 0,
  error_summary text,
  constraint attendance_sync_runs_window
    check (window_to >= window_from),
  constraint attendance_sync_runs_status
    check (status in ('running', 'succeeded', 'partial', 'failed')),
  constraint attendance_sync_runs_counts
    check (
      people_requested >= 0
      and batches_attempted >= 0
      and records_fetched >= 0
      and records_inserted >= 0
      and records_inserted <= records_fetched
    ),
  constraint attendance_sync_runs_completion
    check (
      (status = 'running' and completed_at is null)
      or (status <> 'running' and completed_at is not null)
    )
);

create index attendance_sync_runs_started_at_idx
  on public.attendance_sync_runs (started_at desc);
create index attendance_sync_runs_status_idx
  on public.attendance_sync_runs (status, started_at desc);

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create or replace function private.set_attendance_updated_at()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  new.updated_at := clock_timestamp();
  return new;
end;
$$;

revoke all on function private.set_attendance_updated_at()
  from public, anon, authenticated, service_role;

create or replace function private.protect_attendance_raw_punch()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  raise exception 'Raw attendance punches are immutable; record a manual override instead.';
end;
$$;

revoke all on function private.protect_attendance_raw_punch()
  from public, anon, authenticated, service_role;

create or replace function private.enforce_attendance_leave_no_overlap()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if exists (
    select 1
    from public.attendance_leave_entries as existing
    where existing.person_id = new.person_id
      and existing.leave_date = new.leave_date
      and existing.id <> new.id
      and (
        existing.portion = new.portion
        or existing.portion = 'full'
        or new.portion = 'full'
      )
  ) then
    raise exception 'The leave entry overlaps an existing leave entry for this person and date.';
  end if;

  return new;
end;
$$;

revoke all on function private.enforce_attendance_leave_no_overlap()
  from public, anon, authenticated, service_role;

create trigger set_attendance_people_updated_at
before update on public.attendance_people
for each row execute function private.set_attendance_updated_at();
create trigger set_attendance_leave_entries_updated_at
before update on public.attendance_leave_entries
for each row execute function private.set_attendance_updated_at();
create trigger enforce_attendance_leave_no_overlap
before insert or update of person_id, leave_date, portion
on public.attendance_leave_entries
for each row execute function private.enforce_attendance_leave_no_overlap();
create trigger set_attendance_manual_overrides_updated_at
before update on public.attendance_manual_overrides
for each row execute function private.set_attendance_updated_at();
create trigger set_attendance_entitlements_updated_at
before update on public.attendance_entitlements
for each row execute function private.set_attendance_updated_at();
create trigger set_attendance_monthly_adjustments_updated_at
before update on public.attendance_monthly_adjustments
for each row execute function private.set_attendance_updated_at();
create trigger set_attendance_monthly_confirmations_updated_at
before update on public.attendance_monthly_confirmations
for each row execute function private.set_attendance_updated_at();

create trigger protect_attendance_raw_punch
before update or delete on public.attendance_raw_punches
for each row execute function private.protect_attendance_raw_punch();

create trigger bunker_map_backup_epoch_fence
after insert or update or delete or truncate on public.attendance_people
for each statement execute function private.record_bunker_map_backup_mutation();
create trigger bunker_map_backup_epoch_fence
after insert or update or delete or truncate on public.attendance_raw_punches
for each statement execute function private.record_bunker_map_backup_mutation();
create trigger bunker_map_backup_epoch_fence
after insert or update or delete or truncate on public.attendance_leave_entries
for each statement execute function private.record_bunker_map_backup_mutation();
create trigger bunker_map_backup_epoch_fence
after insert or update or delete or truncate on public.attendance_manual_overrides
for each statement execute function private.record_bunker_map_backup_mutation();
create trigger bunker_map_backup_epoch_fence
after insert or update or delete or truncate on public.attendance_entitlements
for each statement execute function private.record_bunker_map_backup_mutation();
create trigger bunker_map_backup_epoch_fence
after insert or update or delete or truncate on public.attendance_monthly_adjustments
for each statement execute function private.record_bunker_map_backup_mutation();
create trigger bunker_map_backup_epoch_fence
after insert or update or delete or truncate on public.attendance_monthly_confirmations
for each statement execute function private.record_bunker_map_backup_mutation();
create trigger bunker_map_backup_epoch_fence
after insert or update or delete or truncate on public.attendance_sync_runs
for each statement execute function private.record_bunker_map_backup_mutation();

alter table public.attendance_people enable row level security;
alter table public.attendance_raw_punches enable row level security;
alter table public.attendance_leave_entries enable row level security;
alter table public.attendance_manual_overrides enable row level security;
alter table public.attendance_entitlements enable row level security;
alter table public.attendance_monthly_adjustments enable row level security;
alter table public.attendance_monthly_confirmations enable row level security;
alter table public.attendance_sync_runs enable row level security;

revoke all privileges on table public.attendance_people
  from public, anon, authenticated, service_role;
revoke all privileges on table public.attendance_raw_punches
  from public, anon, authenticated, service_role;
revoke all privileges on table public.attendance_leave_entries
  from public, anon, authenticated, service_role;
revoke all privileges on table public.attendance_manual_overrides
  from public, anon, authenticated, service_role;
revoke all privileges on table public.attendance_entitlements
  from public, anon, authenticated, service_role;
revoke all privileges on table public.attendance_monthly_adjustments
  from public, anon, authenticated, service_role;
revoke all privileges on table public.attendance_monthly_confirmations
  from public, anon, authenticated, service_role;
revoke all privileges on table public.attendance_sync_runs
  from public, anon, authenticated, service_role;

grant select, insert, update, delete on table public.attendance_people
  to service_role;
grant select, insert on table public.attendance_raw_punches
  to service_role;
grant select, insert, update, delete on table public.attendance_leave_entries
  to service_role;
grant select, insert, update, delete on table public.attendance_manual_overrides
  to service_role;
grant select, insert, update, delete on table public.attendance_entitlements
  to service_role;
grant select, insert, update, delete on table public.attendance_monthly_adjustments
  to service_role;
grant select, insert, update, delete on table public.attendance_monthly_confirmations
  to service_role;
grant select, insert, update on table public.attendance_sync_runs
  to service_role;

create or replace function public.replace_attendance_leave_group(
  p_existing_group_id uuid,
  p_new_group_id uuid,
  p_person_id uuid,
  p_leave_dates date[],
  p_portion text,
  p_code text,
  p_note text,
  p_actor text
)
returns setof public.attendance_leave_entries
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if p_new_group_id is null
    or p_person_id is null
    or coalesce(array_length(p_leave_dates, 1), 0) = 0
    or array_length(p_leave_dates, 1) > 366
    or p_portion not in ('full', 'am', 'pm')
    or p_code not in ('ALS', 'ALU', 'SLM', 'SLR', 'SLX', 'SPL', 'MTL', 'NPL', 'HO', 'OS')
    or btrim(coalesce(p_actor, '')) = ''
  then
    raise exception 'A valid attendance leave range is required.';
  end if;

  if exists (
    select 1
    from unnest(p_leave_dates) as requested(leave_date)
    where extract(isodow from requested.leave_date) not between 1 and 5
  ) then
    raise exception 'Attendance leave can only be recorded on weekdays.';
  end if;

  if p_existing_group_id is not null then
    if not exists (
      select 1
      from public.attendance_leave_entries
      where entry_group_id = p_existing_group_id
        and person_id = p_person_id
    ) then
      raise exception 'The attendance leave group was not found.';
    end if;

    delete from public.attendance_leave_entries
    where entry_group_id = p_existing_group_id
      and person_id = p_person_id;
  end if;

  return query
    insert into public.attendance_leave_entries (
      entry_group_id,
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
      p_new_group_id,
      p_person_id,
      requested.leave_date,
      p_portion,
      p_code,
      'manual',
      coalesce(p_note, ''),
      p_actor,
      p_actor
    from (
      select distinct leave_date
      from unnest(p_leave_dates) as dates(leave_date)
    ) as requested
    order by requested.leave_date
    returning *;
end;
$$;

revoke all on function public.replace_attendance_leave_group(
  uuid,
  uuid,
  uuid,
  date[],
  text,
  text,
  text,
  text
) from public, anon, authenticated, service_role;
grant execute on function public.replace_attendance_leave_group(
  uuid,
  uuid,
  uuid,
  date[],
  text,
  text,
  text,
  text
) to service_role;

create or replace function public.insert_attendance_raw_punches(
  p_rows jsonb
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  inserted_count integer;
begin
  if p_rows is null
    or jsonb_typeof(p_rows) <> 'array'
    or jsonb_array_length(p_rows) > 1000
  then
    raise exception 'Attendance raw-punch input must be an array of at most 1000 records.';
  end if;

  with inserted as (
    insert into public.attendance_raw_punches (
      person_id,
      source_record_key,
      source_record_id,
      dingtalk_user_id,
      check_type,
      punch_time,
      work_date,
      source_type,
      device_sn,
      time_result,
      location_result,
      raw_payload
    )
    select
      incoming.person_id,
      incoming.source_record_key,
      incoming.source_record_id,
      incoming.dingtalk_user_id,
      incoming.check_type,
      incoming.punch_time,
      incoming.work_date,
      incoming.source_type,
      incoming.device_sn,
      incoming.time_result,
      incoming.location_result,
      incoming.raw_payload
    from jsonb_to_recordset(p_rows) as incoming(
      person_id uuid,
      source_record_key text,
      source_record_id text,
      dingtalk_user_id text,
      check_type text,
      punch_time timestamptz,
      work_date date,
      source_type text,
      device_sn text,
      time_result text,
      location_result text,
      raw_payload jsonb
    )
    on conflict (source_record_key) do nothing
    returning 1
  )
  select count(*)::integer
  into inserted_count
  from inserted;

  return inserted_count;
end;
$$;

revoke all on function public.insert_attendance_raw_punches(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.insert_attendance_raw_punches(jsonb)
  to service_role;

create or replace function public.apply_attendance_legacy_import(
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

  delete from public.attendance_monthly_adjustments as existing
  using jsonb_to_recordset(coalesce(p_payload -> 'monthly', '[]'::jsonb)) as monthly(
    person_id uuid,
    year integer,
    month integer,
    source_key text,
    statement_date date,
    categories jsonb,
    is_confirmed boolean
  )
  where existing.person_id = monthly.person_id
    and existing.year = monthly.year
    and existing.month = monthly.month
    and existing.source = monthly.source_key;

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

revoke all on function public.apply_attendance_legacy_import(jsonb, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.apply_attendance_legacy_import(jsonb, text, text)
  to service_role;

do $$
begin
  if to_regprocedure('public.audit_enable_table(regclass)') is not null then
    perform public.audit_enable_table('public.attendance_people'::regclass);
    perform public.audit_enable_table('public.attendance_leave_entries'::regclass);
    perform public.audit_enable_table('public.attendance_manual_overrides'::regclass);
    perform public.audit_enable_table('public.attendance_entitlements'::regclass);
    perform public.audit_enable_table('public.attendance_monthly_adjustments'::regclass);
    perform public.audit_enable_table('public.attendance_monthly_confirmations'::regclass);
  end if;
end;
$$;
