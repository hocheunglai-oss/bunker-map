-- HOME and overseas/business-trip attendance can cover AM, PM, or a full day.
-- They use the existing portion-aware attendance ledger so the choice remains
-- auditable and contributes to attended days without becoming an absence.
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
        'ALS', 'ALU', 'SLM', 'SLR', 'SLX', 'SPL', 'MTL', 'NPL', 'HO', 'OS'
      )
    then
      raise exception 'A valid attendance status and portion are required.';
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
      raise exception 'The attendance entry was not found.';
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
  uuid, date, text, text, boolean, uuid, text, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.save_attendance_day_edit(
  uuid, date, text, text, boolean, uuid, text, text, text, text
) to service_role;
