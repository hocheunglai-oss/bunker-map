-- A calendar label or event ID does not change attendance. Compare the
-- effective Hong Kong holiday dates and attendee codes instead. Expand date
-- ranges exactly as the attendance reader does (at most fourteen days).
create or replace function private.attendance_hk_holiday_projection(p_payload jsonb)
returns table (event_date date, event_id text, title text, people jsonb)
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select
    days.day::date,
    coalesce(events.event ->> 'id', ''),
    coalesce(events.event ->> 'title', ''),
    coalesce(events.event -> 'people', '[]'::jsonb)
  from jsonb_array_elements(
    case when jsonb_typeof(p_payload -> 'events') = 'array'
      then p_payload -> 'events' else '[]'::jsonb end
  ) as events(event)
  cross join lateral generate_series(
    private.attendance_safe_iso_date(events.event ->> 'startDate'),
    least(
      coalesce(
        private.attendance_safe_iso_date(events.event ->> 'endDate'),
        private.attendance_safe_iso_date(events.event ->> 'startDate')
      ),
      private.attendance_safe_iso_date(events.event ->> 'startDate') + 13
    ),
    interval '1 day'
  ) as days(day)
  where upper(btrim(coalesce(events.event ->> 'title', ''))) like 'HOLIDAY ATTENDANCE%'
    or upper(btrim(coalesce(events.event ->> 'title', ''))) = 'PUBLIC HOLIDAY - HONG KONG'
    or (
      jsonb_typeof(events.event -> 'tags') = 'array'
      and exists (
        select 1 from jsonb_array_elements_text(events.event -> 'tags') as tag(value)
        where upper(btrim(tag.value)) = 'HK'
      )
      and exists (
        select 1 from jsonb_array_elements_text(events.event -> 'tags') as tag(value)
        where lower(btrim(tag.value)) = 'public-holiday'
      )
    );
$$;

create or replace function private.attendance_hk_holiday_effects(p_payload jsonb)
returns table (event_date date, attendee_codes jsonb)
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select
    holiday.event_date,
    coalesce(
      jsonb_agg(distinct upper(btrim(attendee.code)) order by upper(btrim(attendee.code)))
        filter (where attendee.code is not null and btrim(attendee.code) <> ''),
      '[]'::jsonb
    )
  from private.attendance_hk_holiday_projection(p_payload) as holiday
  left join lateral jsonb_array_elements_text(
    case when jsonb_typeof(holiday.people) = 'array'
      then holiday.people else '[]'::jsonb end
  ) as attendee(code) on true
  where extract(isodow from holiday.event_date) between 1 and 5
  group by holiday.event_date;
$$;

revoke all on function private.attendance_hk_holiday_effects(jsonb)
  from public, anon, authenticated, service_role;

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
  end loop;

  return new;
end;
$$;

-- Entitlement units are part of every monthly leave balance and the year-end
-- statement. Changing them must reopen that person's affected year.
create or replace function private.invalidate_attendance_entitlement_confirmations()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    perform private.reset_attendance_confirmations_for_range(
      old.person_id, make_date(old.year, 1, 1), make_date(old.year, 12, 31)
    );
    return old;
  end if;

  if tg_op = 'INSERT' then
    perform private.reset_attendance_confirmations_for_range(
      new.person_id, make_date(new.year, 1, 1), make_date(new.year, 12, 31)
    );
    return new;
  end if;

  if old.person_id is distinct from new.person_id
    or old.year is distinct from new.year
    or old.allowance_units is distinct from new.allowance_units
    or old.opening_carry_forward_units is distinct from new.opening_carry_forward_units
  then
    perform private.reset_attendance_confirmations_for_range(
      old.person_id, make_date(old.year, 1, 1), make_date(old.year, 12, 31)
    );
    perform private.reset_attendance_confirmations_for_range(
      new.person_id, make_date(new.year, 1, 1), make_date(new.year, 12, 31)
    );
  end if;

  return new;
end;
$$;

revoke all on function private.invalidate_attendance_entitlement_confirmations()
  from public, anon, authenticated, service_role;

drop trigger if exists invalidate_attendance_entitlement_confirmations
  on public.attendance_entitlements;
create trigger invalidate_attendance_entitlement_confirmations
after insert or update or delete on public.attendance_entitlements
for each row execute function private.invalidate_attendance_entitlement_confirmations();
