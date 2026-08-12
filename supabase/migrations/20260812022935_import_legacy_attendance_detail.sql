-- One-time-compatible, atomic legacy detail importer. The public RPC surface is
-- service-role only; every source row is constrained to Jan-Jun 2026 and the
-- transaction aborts unless detailed category totals equal the legacy summary.

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
  jsonb,
  jsonb,
  jsonb,
  jsonb,
  text,
  date
) from public, anon, authenticated;

grant execute on function public.import_attendance_legacy_detail(
  jsonb,
  jsonb,
  jsonb,
  jsonb,
  text,
  date
) to service_role;
