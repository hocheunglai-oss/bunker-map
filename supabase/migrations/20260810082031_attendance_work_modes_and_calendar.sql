-- Preserve effective-dated default work arrangements, record explicit per-day
-- exceptions, and keep later confirmation reviews stable across calendar years.

create table public.attendance_work_mode_policies (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null
    references public.attendance_people(id) on delete restrict,
  mode text not null,
  effective_from date not null,
  effective_to date,
  source text not null default 'manual',
  created_by text not null,
  updated_by text not null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint attendance_work_mode_policies_mode
    check (mode in ('office', 'home-office')),
  constraint attendance_work_mode_policies_dates
    check (effective_to is null or effective_to >= effective_from),
  constraint attendance_work_mode_policies_source_not_blank
    check (btrim(source) <> ''),
  constraint attendance_work_mode_policies_actor_not_blank
    check (btrim(created_by) <> '' and btrim(updated_by) <> '')
);

create unique index attendance_work_mode_policies_open_person_key
  on public.attendance_work_mode_policies (person_id)
  where effective_to is null;
create index attendance_work_mode_policies_person_dates_idx
  on public.attendance_work_mode_policies (
    person_id,
    effective_from,
    effective_to
  );

create table public.attendance_work_mode_overrides (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null
    references public.attendance_people(id) on delete restrict,
  work_date date not null,
  mode text not null,
  note text not null default '',
  created_by text not null,
  updated_by text not null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint attendance_work_mode_overrides_mode
    check (mode in ('office', 'home-office', 'business-trip')),
  constraint attendance_work_mode_overrides_weekday
    check (extract(isodow from work_date) between 1 and 5),
  constraint attendance_work_mode_overrides_actor_not_blank
    check (btrim(created_by) <> '' and btrim(updated_by) <> ''),
  constraint attendance_work_mode_overrides_person_date_key
    unique (person_id, work_date)
);

create index attendance_work_mode_overrides_date_person_idx
  on public.attendance_work_mode_overrides (work_date, person_id);

create or replace function private.enforce_attendance_work_mode_policy()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if tg_op = 'UPDATE' and new.person_id is distinct from old.person_id then
    raise exception 'An attendance work-mode policy cannot be moved to another person.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('attendance-work-mode:' || new.person_id::text, 0)
  );

  if exists (
    select 1
    from public.attendance_work_mode_policies as existing
    where existing.person_id = new.person_id
      and existing.id <> new.id
      and daterange(
        existing.effective_from,
        existing.effective_to,
        '[]'
      ) && daterange(new.effective_from, new.effective_to, '[]')
  ) then
    raise exception 'Attendance work-mode policies cannot overlap for one person.';
  end if;

  return new;
end;
$$;

revoke all on function private.enforce_attendance_work_mode_policy()
  from public, anon, authenticated, service_role;

drop trigger if exists enforce_attendance_work_mode_policy
  on public.attendance_work_mode_policies;
create trigger enforce_attendance_work_mode_policy
before insert or update on public.attendance_work_mode_policies
for each row execute function private.enforce_attendance_work_mode_policy();

drop trigger if exists set_attendance_work_mode_policies_updated_at
  on public.attendance_work_mode_policies;
create trigger set_attendance_work_mode_policies_updated_at
before update on public.attendance_work_mode_policies
for each row execute function private.set_attendance_updated_at();

drop trigger if exists set_attendance_work_mode_overrides_updated_at
  on public.attendance_work_mode_overrides;
create trigger set_attendance_work_mode_overrides_updated_at
before update on public.attendance_work_mode_overrides
for each row execute function private.set_attendance_updated_at();

-- KZ, CY, and JZ work from home by default only from the official
-- 1 September 2026 commencement date. Earlier imported HO figures are retained.
insert into public.attendance_work_mode_policies (
  person_id,
  mode,
  effective_from,
  source,
  created_by,
  updated_by
)
select
  people.id,
  'home-office',
  date '2026-09-01',
  'system:2026-09-default-home-office',
  'system:attendance-migration',
  'system:attendance-migration'
from public.attendance_people as people
where people.staff_code in ('KZ', 'CY', 'JZ')
  and not exists (
    select 1
    from public.attendance_work_mode_policies as existing
    where existing.person_id = people.id
      and existing.effective_from <= date '2026-09-01'
      and (
        existing.effective_to is null
        or existing.effective_to >= date '2026-09-01'
      )
  );

create or replace function private.invalidate_attendance_work_mode_confirmation()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if tg_table_name = 'attendance_work_mode_policies' then
    if tg_op in ('UPDATE', 'DELETE') then
      perform private.reset_attendance_confirmations_for_range(
        old.person_id,
        old.effective_from,
        old.effective_to
      );
    end if;
    if tg_op in ('INSERT', 'UPDATE') then
      perform private.reset_attendance_confirmations_for_range(
        new.person_id,
        new.effective_from,
        new.effective_to
      );
    end if;
  elsif tg_table_name = 'attendance_work_mode_overrides' then
    if tg_op in ('UPDATE', 'DELETE') then
      perform private.reset_attendance_confirmations_for_range(
        old.person_id,
        old.work_date,
        old.work_date
      );
    end if;
    if tg_op in ('INSERT', 'UPDATE') then
      perform private.reset_attendance_confirmations_for_range(
        new.person_id,
        new.work_date,
        new.work_date
      );
    end if;
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

revoke all on function private.invalidate_attendance_work_mode_confirmation()
  from public, anon, authenticated, service_role;

drop trigger if exists invalidate_attendance_work_mode_confirmation
  on public.attendance_work_mode_policies;
create trigger invalidate_attendance_work_mode_confirmation
after insert or update or delete on public.attendance_work_mode_policies
for each row execute function private.invalidate_attendance_work_mode_confirmation();

drop trigger if exists invalidate_attendance_work_mode_confirmation
  on public.attendance_work_mode_overrides;
create trigger invalidate_attendance_work_mode_confirmation
after insert or update or delete on public.attendance_work_mode_overrides
for each row execute function private.invalidate_attendance_work_mode_confirmation();

-- Save the combined day editor in one database transaction. The route calls
-- this function with the service role only; keeping the leave and work-mode
-- changes together prevents a partial attendance-day update.
create or replace function public.save_attendance_day_edit(
  p_person_id uuid,
  p_work_date date,
  p_work_mode text,
  p_work_mode_note text,
  p_leave_enabled boolean,
  p_existing_leave_entry_id uuid,
  p_leave_portion text,
  p_leave_code text,
  p_leave_note text,
  p_actor text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  work_mode_row public.attendance_work_mode_overrides%rowtype;
  leave_row public.attendance_leave_entries%rowtype;
  work_mode_result jsonb := null;
  leave_results jsonb := '[]'::jsonb;
begin
  if p_person_id is null
    or p_work_date is null
    or p_work_mode is null
    or p_work_mode not in ('default', 'office', 'home-office', 'business-trip')
    or p_leave_enabled is null
    or btrim(coalesce(p_actor, '')) = ''
  then
    raise exception 'A valid attendance day edit is required.';
  end if;

  if extract(isodow from p_work_date) not between 1 and 5 then
    raise exception 'An attendance day edit must use a weekday.';
  end if;

  if char_length(coalesce(p_work_mode_note, '')) > 1000
    or char_length(coalesce(p_leave_note, '')) > 2000
  then
    raise exception 'An attendance day note is too long.';
  end if;

  if not exists (
    select 1
    from public.attendance_people as people
    where people.id = p_person_id
      and coalesce(people.employment_start_date, date '-infinity') <= p_work_date
      and coalesce(people.employment_end_date, date 'infinity') >= p_work_date
  ) then
    raise exception 'The attendance person or work date is invalid.';
  end if;

  if p_work_mode = 'default' then
    delete from public.attendance_work_mode_overrides as modes
    where modes.person_id = p_person_id
      and modes.work_date = p_work_date;
  else
    insert into public.attendance_work_mode_overrides (
      person_id,
      work_date,
      mode,
      note,
      created_by,
      updated_by
    ) values (
      p_person_id,
      p_work_date,
      p_work_mode,
      coalesce(p_work_mode_note, ''),
      p_actor,
      p_actor
    )
    on conflict (person_id, work_date) do update
    set
      mode = excluded.mode,
      note = excluded.note,
      updated_by = excluded.updated_by
    returning * into work_mode_row;

    work_mode_result := to_jsonb(work_mode_row);
  end if;

  if p_leave_enabled then
    if p_leave_portion is null
      or p_leave_portion not in ('full', 'am', 'pm')
      or p_leave_code is null
      or p_leave_code not in (
        'ALS', 'ALU', 'SLM', 'SLR', 'SLX', 'SPL', 'MTL', 'NPL'
      )
    then
      raise exception 'A valid leave type and portion are required. HO and OS are work modes.';
    end if;
  end if;

  if p_existing_leave_entry_id is not null then
    perform 1
    from public.attendance_leave_entries as leaves
    where leaves.id = p_existing_leave_entry_id
      and leaves.person_id = p_person_id
      and leaves.leave_date = p_work_date
    for update;

    if not found then
      raise exception 'The attendance leave entry was not found.';
    end if;

    delete from public.attendance_leave_entries as leaves
    where leaves.id = p_existing_leave_entry_id
      and leaves.person_id = p_person_id
      and leaves.leave_date = p_work_date;
  end if;

  if p_leave_enabled then
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
    ) values (
      gen_random_uuid(),
      p_person_id,
      p_work_date,
      p_leave_portion,
      p_leave_code,
      'manual',
      coalesce(p_leave_note, ''),
      p_actor,
      p_actor
    )
    returning * into leave_row;

    leave_results := jsonb_build_array(to_jsonb(leave_row));
  end if;

  return jsonb_build_object(
    'work_mode_override', work_mode_result,
    'leave_entries', leave_results
  );
end;
$$;

revoke all on function public.save_attendance_day_edit(
  uuid,
  date,
  text,
  text,
  boolean,
  uuid,
  text,
  text,
  text,
  text
) from public, anon, authenticated, service_role;
grant execute on function public.save_attendance_day_edit(
  uuid,
  date,
  text,
  text,
  boolean,
  uuid,
  text,
  text,
  text,
  text
) to service_role;

-- Only Hong Kong holiday-attendance fields are projected. An unrelated Event
-- Calendar edit therefore does not reopen confirmed attendance months.
create or replace function private.attendance_safe_iso_date(p_value text)
returns date
language plpgsql
immutable
strict
set search_path = pg_catalog, pg_temp
as $$
begin
  if p_value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then return null; end if;
  return p_value::date;
exception when others then
  return null;
end;
$$;

revoke all on function private.attendance_safe_iso_date(text)
  from public, anon, authenticated, service_role;

create or replace function private.attendance_hk_holiday_projection(
  p_payload jsonb
)
returns table (
  event_date date,
  event_id text,
  title text,
  people jsonb
)
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select
    private.attendance_safe_iso_date(events.event ->> 'startDate'),
    coalesce(events.event ->> 'id', ''),
    coalesce(events.event ->> 'title', ''),
    coalesce(events.event -> 'people', '[]'::jsonb)
  from jsonb_array_elements(
    case
      when jsonb_typeof(coalesce(p_payload -> 'events', '[]'::jsonb)) = 'array'
        then coalesce(p_payload -> 'events', '[]'::jsonb)
      else '[]'::jsonb
    end
  ) as events(event)
  where private.attendance_safe_iso_date(events.event ->> 'startDate')
      is not null
    and (
      upper(coalesce(events.event ->> 'title', '')) like 'HOLIDAY ATTENDANCE%'
      or upper(coalesce(events.event ->> 'title', '')) = 'PUBLIC HOLIDAY - HONG KONG'
      or (
        jsonb_typeof(coalesce(events.event -> 'tags', '[]'::jsonb)) = 'array'
        and exists (
          select 1
          from jsonb_array_elements_text(
            case
              when jsonb_typeof(events.event -> 'tags') = 'array'
                then events.event -> 'tags'
              else '[]'::jsonb
            end
          ) as tag(value)
          where upper(tag.value) = 'HK'
        )
        and exists (
          select 1
          from jsonb_array_elements_text(
            case
              when jsonb_typeof(events.event -> 'tags') = 'array'
                then events.event -> 'tags'
              else '[]'::jsonb
            end
          ) as tag(value)
          where lower(tag.value) = 'public-holiday'
        )
      )
    );
$$;

revoke all on function private.attendance_hk_holiday_projection(jsonb)
  from public, anon, authenticated, service_role;

create or replace function private.invalidate_attendance_calendar_confirmations()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
  old_projection jsonb;
  new_projection jsonb;
  affected record;
  actor text := coalesce(
    nullif(current_setting('app.audit_actor_name', true), ''),
    nullif(current_setting('app.audit_actor_id', true), ''),
    'system:event-calendar-holiday-change'
  );
begin
  if new.key <> 'event-calendar' then return new; end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'date', projection.event_date,
        'id', projection.event_id,
        'title', projection.title,
        'people', projection.people
      )
      order by projection.event_date, projection.event_id
    ),
    '[]'::jsonb
  ) into old_projection
  from private.attendance_hk_holiday_projection(
    case when tg_op = 'INSERT' then '{}'::jsonb else old.payload end
  ) as projection
  where projection.event_date >= date '2026-09-01';

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'date', projection.event_date,
        'id', projection.event_id,
        'title', projection.title,
        'people', projection.people
      )
      order by projection.event_date, projection.event_id
    ),
    '[]'::jsonb
  ) into new_projection
  from private.attendance_hk_holiday_projection(new.payload) as projection
  where projection.event_date >= date '2026-09-01';

  if old_projection is not distinct from new_projection then return new; end if;

  for affected in
    select distinct
      extract(year from projection.event_date)::integer as year,
      extract(month from projection.event_date)::integer as month
    from (
      select *
      from private.attendance_hk_holiday_projection(
        case when tg_op = 'INSERT' then '{}'::jsonb else old.payload end
      )
      union all
      select *
      from private.attendance_hk_holiday_projection(new.payload)
    ) as projection
    where projection.event_date >= date '2026-09-01'
  loop
    update public.attendance_monthly_confirmations as confirmations
    set
      status = 'pending',
      confirmed_at = null,
      confirmed_by = null,
      updated_by = actor
    where confirmations.year = affected.year
      and confirmations.month = affected.month
      and confirmations.status = 'confirmed';
  end loop;

  return new;
end;
$$;

revoke all on function private.invalidate_attendance_calendar_confirmations()
  from public, anon, authenticated, service_role;

drop trigger if exists invalidate_attendance_calendar_confirmations
  on public.office_calendar_store;
create trigger invalidate_attendance_calendar_confirmations
after insert or update of payload on public.office_calendar_store
for each row execute function private.invalidate_attendance_calendar_confirmations();

create or replace function public.list_attendance_available_years()
returns table (year integer)
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
  select distinct available.year
  from (
    select entitlements.year
    from public.attendance_entitlements as entitlements
    union all
    select adjustments.year
    from public.attendance_monthly_adjustments as adjustments
    union all
    select confirmations.year
    from public.attendance_monthly_confirmations as confirmations
    union all
    select extract(year from punches.work_date)::integer
    from public.attendance_raw_punches as punches
    union all
    select extract(year from leaves.leave_date)::integer
    from public.attendance_leave_entries as leaves
    union all
    select extract(year from overrides.work_date)::integer
    from public.attendance_manual_overrides as overrides
    union all
    select extract(year from modes.work_date)::integer
    from public.attendance_work_mode_overrides as modes
    union all
    select extract(year from policies.effective_from)::integer
    from public.attendance_work_mode_policies as policies
    union all
    select extract(
      year from current_timestamp at time zone 'Asia/Hong_Kong'
    )::integer
  ) as available
  where available.year between 2000 and 2200
  order by available.year desc;
$$;

revoke all on function public.list_attendance_available_years()
  from public, anon, authenticated, service_role;
grant execute on function public.list_attendance_available_years()
  to service_role;

drop trigger if exists bunker_map_backup_epoch_fence
  on public.attendance_work_mode_policies;
create trigger bunker_map_backup_epoch_fence
after insert or update or delete or truncate
on public.attendance_work_mode_policies
for each statement execute function private.record_bunker_map_backup_mutation();

drop trigger if exists bunker_map_backup_epoch_fence
  on public.attendance_work_mode_overrides;
create trigger bunker_map_backup_epoch_fence
after insert or update or delete or truncate
on public.attendance_work_mode_overrides
for each statement execute function private.record_bunker_map_backup_mutation();

alter table public.attendance_work_mode_policies enable row level security;
alter table public.attendance_work_mode_overrides enable row level security;

revoke all privileges on table public.attendance_work_mode_policies
  from public, anon, authenticated, service_role;
revoke all privileges on table public.attendance_work_mode_overrides
  from public, anon, authenticated, service_role;
grant select, insert, update, delete
  on table public.attendance_work_mode_policies to service_role;
grant select, insert, update, delete
  on table public.attendance_work_mode_overrides to service_role;

do $$
begin
  if to_regprocedure('public.audit_enable_table(regclass)') is not null then
    perform public.audit_enable_table(
      'public.attendance_work_mode_policies'::regclass
    );
    perform public.audit_enable_table(
      'public.attendance_work_mode_overrides'::regclass
    );
  end if;
end;
$$;
