alter table public.attendance_reminder_dispatches
  drop constraint if exists attendance_reminder_dispatches_dispatch_kind;

alter table public.attendance_reminder_dispatches
  add constraint attendance_reminder_dispatches_dispatch_kind
  check (dispatch_kind in ('manual', 'month_end_review', 'second_reminder', 'annual_summary'));

create unique index if not exists attendance_reminder_dispatches_annual_summary_once
  on public.attendance_reminder_dispatches (person_id, year)
  where dispatch_kind = 'annual_summary';
