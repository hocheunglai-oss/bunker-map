-- Distinguish editor-triggered confirmation reminders from the automatic
-- current-month review reminder. The partial unique index is the final guard
-- against duplicate email if Vercel retries or overlaps a cron invocation.

alter table public.attendance_reminder_dispatches
  add column if not exists dispatch_kind text not null default 'manual';

alter table public.attendance_reminder_dispatches
  drop constraint if exists attendance_reminder_dispatches_dispatch_kind;

alter table public.attendance_reminder_dispatches
  add constraint attendance_reminder_dispatches_dispatch_kind
  check (dispatch_kind in ('manual', 'month_end_review'));

create unique index if not exists attendance_reminder_dispatches_month_end_once
  on public.attendance_reminder_dispatches (person_id, year, month)
  where dispatch_kind = 'month_end_review'
    and status in ('pending', 'sent');
