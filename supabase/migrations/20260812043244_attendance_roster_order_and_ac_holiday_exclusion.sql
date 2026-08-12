alter table public.attendance_people
  add column if not exists roster_order integer;

with ranked(staff_code, roster_order) as (
  values
    ('VL', 1), ('SC', 2), ('OL', 3), ('DT', 4), ('KZ', 5),
    ('CY', 6), ('MY', 7), ('LC', 8), ('LL', 9), ('JZ', 10)
)
update public.attendance_people as person
set roster_order = ranked.roster_order
from ranked
where person.staff_code = ranked.staff_code;

update public.attendance_people
set roster_order = 1000
where roster_order is null;

alter table public.attendance_people
  alter column roster_order set default 1000,
  alter column roster_order set not null;

create index if not exists attendance_people_active_roster_order_idx
  on public.attendance_people (is_active, roster_order, staff_code);

-- Accounts (AC) never receive holiday-attendance credit. Remove historic
-- manual holiday-attendance decisions and exclude their synthetic legacy
-- punches while retaining the immutable raw evidence.
create temporary table attendance_ac_holiday_days on commit drop as
select distinct person.id as person_id, holiday.event_date as work_date
from public.attendance_people as person
cross join public.office_calendar_store as calendar
cross join lateral private.attendance_hk_holiday_projection(calendar.payload) as holiday
where person.team = 'AC'
  and calendar.key = 'event-calendar';

insert into public.attendance_manual_overrides(
  person_id,
  work_date,
  action,
  raw_punch_id,
  reason,
  created_by,
  updated_by
)
select
  punch.person_id,
  punch.work_date,
  'exclude',
  punch.id,
  'AC holiday attendance is not applicable.',
  'system:ac-holiday-exclusion',
  'system:ac-holiday-exclusion'
from public.attendance_raw_punches as punch
join attendance_ac_holiday_days as excluded
  on excluded.person_id = punch.person_id
  and excluded.work_date = punch.work_date
where punch.source_type = 'LEGACY_XLS'
on conflict (raw_punch_id) where action = 'exclude' do nothing;

delete from public.attendance_work_mode_overrides as mode
using attendance_ac_holiday_days as excluded
where mode.person_id = excluded.person_id
  and mode.work_date = excluded.work_date;

update public.attendance_monthly_confirmations as confirmation
set
  status = 'pending',
  confirmed_at = null,
  confirmed_by = null,
  note = 'Attendance source changed after confirmation.'
from public.attendance_people as person
join attendance_ac_holiday_days as changed
  on changed.person_id = person.id
where confirmation.person_id = person.id
  and person.team = 'AC'
  and confirmation.year = extract(year from changed.work_date)::integer
  and confirmation.month = extract(month from changed.work_date)::integer;
