-- One-time production recovery. Run only after the effective-calendar-change
-- migration is deployed and the nine candidates have been reviewed.
-- Executed on 2026-10-14 before the source-revision migration. This file is
-- retained as audit evidence; do not rerun it against the revised schema.
begin;
set transaction isolation level serializable;
select set_config('app.audit_actor_id', 'system:attendance-confirmation-recovery', true);
select set_config('app.audit_actor_name', 'system:attendance-confirmation-recovery', true);

-- Source writers take row-exclusive locks before their confirmation triggers.
-- Hold shared locks through validation and restoration so their writes cannot
-- slip between the guard and the update.
lock table public.office_calendar_store, public.attendance_people,
  public.attendance_team_assignments, public.attendance_raw_punches,
  public.attendance_leave_entries, public.attendance_manual_overrides,
  public.attendance_work_mode_policies, public.attendance_work_mode_overrides,
  public.attendance_entitlements, public.attendance_monthly_adjustments
  in share mode;
lock table public.attendance_monthly_confirmations in share row exclusive mode;

create temp table attendance_september_recovery on commit drop as
select
  (log.record_pk ->> 'id')::uuid as id,
  log.before_row,
  log.after_row
from public.audit_logs as log
where log.table_name = 'attendance_monthly_confirmations'
  and log.operation = 'UPDATE'
  and log.occurred_at = '2026-10-07 12:05:41.353465+00'::timestamptz
  and log.request_context ->> 'action' = 'apply-approved-verified-holiday-reconciliation'
  and log.before_row ->> 'status' = 'confirmed'
  and log.after_row ->> 'status' = 'pending'
  and (log.before_row ->> 'year')::integer = 2026
  and (log.before_row ->> 'month')::integer = 9;

do $$
begin
  if (select count(*) from attendance_september_recovery) <> 9
    or (select count(distinct id) from attendance_september_recovery) <> 9
    or (select count(distinct before_row ->> 'person_id')
      from attendance_september_recovery) <> 9 then
    raise exception 'Expected exactly nine September confirmation snapshots';
  end if;

  if exists (
    select 1 from attendance_september_recovery as snapshot
    left join public.attendance_monthly_confirmations as current on current.id = snapshot.id
    where current.id is null
      or current.status <> 'pending'
      or current.year <> 2026 or current.month <> 9
      or current.person_id::text is distinct from snapshot.before_row ->> 'person_id'
      or current.updated_at is distinct from
        (snapshot.after_row ->> 'updated_at')::timestamptz
  ) then
    raise exception 'A September confirmation changed after the calendar reset';
  end if;

  if exists (
    select 1 from public.attendance_raw_punches
    where work_date between date '2026-09-01' and date '2026-09-30'
      and first_seen_at > '2026-10-07 12:05:41.353465+00'::timestamptz
  ) or exists (
    select 1 from public.attendance_monthly_adjustments
    where year = 2026 and month = 9
      and updated_at > '2026-10-07 12:05:41.353465+00'::timestamptz
  ) or exists (
    select 1 from public.audit_logs as log
    where log.occurred_at > '2026-10-07 12:05:41.353465+00'::timestamptz
      and (
        (log.table_name = 'attendance_leave_entries'
          and (
            log.before_row ->> 'leave_date' between '2026-09-01' and '2026-09-30'
            or log.after_row ->> 'leave_date' between '2026-09-01' and '2026-09-30'
          ))
        or (log.table_name in ('attendance_manual_overrides', 'attendance_work_mode_overrides')
          and (
            log.before_row ->> 'work_date' between '2026-09-01' and '2026-09-30'
            or log.after_row ->> 'work_date' between '2026-09-01' and '2026-09-30'
          ))
        or (log.table_name = 'attendance_raw_punches'
          and (
            log.before_row ->> 'work_date' between '2026-09-01' and '2026-09-30'
            or log.after_row ->> 'work_date' between '2026-09-01' and '2026-09-30'
          ))
        or (log.table_name = 'attendance_monthly_adjustments'
          and (
            ((log.before_row ->> 'year')::integer = 2026
              and (log.before_row ->> 'month')::integer = 9)
            or ((log.after_row ->> 'year')::integer = 2026
              and (log.after_row ->> 'month')::integer = 9)
          ))
        or log.table_name in (
          'attendance_team_assignments', 'attendance_work_mode_policies',
          'attendance_entitlements', 'attendance_people'
        )
      )
  ) then
    raise exception 'September attendance sources changed after confirmation reset';
  end if;

  if exists (
    select 1 from public.audit_logs as log
    where log.table_name = 'office_calendar_store'
      and log.record_pk ->> 'key' = 'event-calendar'
      and log.occurred_at > '2026-10-07 12:05:41.353465+00'::timestamptz
      and (
        select coalesce(jsonb_agg(jsonb_build_array(event_date, attendee_codes)
          order by event_date), '[]'::jsonb)
        from private.attendance_hk_holiday_effects(log.before_row -> 'payload')
        where event_date between date '2026-09-01' and date '2026-09-30'
      ) is distinct from (
        select coalesce(jsonb_agg(jsonb_build_array(event_date, attendee_codes)
          order by event_date), '[]'::jsonb)
        from private.attendance_hk_holiday_effects(log.after_row -> 'payload')
        where event_date between date '2026-09-01' and date '2026-09-30'
      )
  ) then
    raise exception 'Effective September holiday calendar changed after reset';
  end if;
end;
$$;

update public.attendance_monthly_confirmations as current
set status = 'confirmed',
    confirmed_at = (snapshot.before_row ->> 'confirmed_at')::timestamptz,
    confirmed_by = snapshot.before_row ->> 'confirmed_by',
    note = snapshot.before_row ->> 'note',
    updated_by = 'system:attendance-confirmation-recovery'
from attendance_september_recovery as snapshot
where current.id = snapshot.id
  and current.year = 2026 and current.month = 9 and current.status = 'pending';

do $$
begin
  if (select count(*) from public.attendance_monthly_confirmations
      where year = 2026 and month = 9 and status = 'confirmed') <> 9 then
    raise exception 'September confirmation recovery did not verify nine rows';
  end if;
end;
$$;

commit;
