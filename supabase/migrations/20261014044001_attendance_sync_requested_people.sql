-- Record the exact DingTalk identity requested for each person in a sync run.
-- Existing runs retain an empty manifest and cannot authorize auto-confirmation.
alter table public.attendance_sync_runs
  add column requested_people jsonb not null default '{}'::jsonb;

alter table public.attendance_sync_runs
  add constraint attendance_sync_runs_requested_people_object
  check (jsonb_typeof(requested_people) = 'object');
