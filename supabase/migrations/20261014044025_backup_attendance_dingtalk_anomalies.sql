-- The daily JSON backup reads public tables through PostgREST. Preserve the
-- private DingTalk discrepancy evidence through a narrow service-only export,
-- and include every insert in the existing backup mutation fence.
create or replace function public.get_attendance_dingtalk_anomaly_backup_page(
  p_section text,
  p_after uuid default null,
  p_limit integer default 500
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  page jsonb;
begin
  if p_limit is null or p_limit not between 1 and 500 then
    raise exception 'Attendance anomaly backup page size must be between 1 and 500.';
  end if;

  if p_section = 'attendanceDingtalkPunchAnomalies' then
    select coalesce(jsonb_agg(to_jsonb(row) order by row.id), '[]'::jsonb)
    into page from (
      select * from private.attendance_dingtalk_punch_anomalies
      where p_after is null or id > p_after
      order by id limit p_limit
    ) as row;
  elsif p_section = 'attendanceDingtalkPunchAnomalyResolutions' then
    select coalesce(jsonb_agg(to_jsonb(row) order by row.anomaly_id), '[]'::jsonb)
    into page from (
      select * from private.attendance_dingtalk_punch_anomaly_resolutions
      where p_after is null or anomaly_id > p_after
      order by anomaly_id limit p_limit
    ) as row;
  elsif p_section = 'attendanceDingtalkMissingPunchAnomalies' then
    select coalesce(jsonb_agg(to_jsonb(row) order by row.id), '[]'::jsonb)
    into page from (
      select * from private.attendance_dingtalk_missing_punch_anomalies
      where p_after is null or id > p_after
      order by id limit p_limit
    ) as row;
  elsif p_section = 'attendanceDingtalkMissingPunchResolutions' then
    select coalesce(jsonb_agg(to_jsonb(row) order by row.anomaly_id), '[]'::jsonb)
    into page from (
      select * from private.attendance_dingtalk_missing_punch_resolutions
      where p_after is null or anomaly_id > p_after
      order by anomaly_id limit p_limit
    ) as row;
  else
    raise exception 'Unknown attendance anomaly backup section.';
  end if;

  return page;
end;
$$;
revoke all on function public.get_attendance_dingtalk_anomaly_backup_page(
  text, uuid, integer
) from public, anon, authenticated, service_role;
grant execute on function public.get_attendance_dingtalk_anomaly_backup_page(
  text, uuid, integer
) to service_role;

create trigger bunker_map_backup_epoch_fence
after insert or update or delete or truncate
on private.attendance_dingtalk_punch_anomalies
for each statement execute function private.record_bunker_map_backup_mutation();
create trigger bunker_map_backup_epoch_fence
after insert or update or delete or truncate
on private.attendance_dingtalk_punch_anomaly_resolutions
for each statement execute function private.record_bunker_map_backup_mutation();
create trigger bunker_map_backup_epoch_fence
after insert or update or delete or truncate
on private.attendance_dingtalk_missing_punch_anomalies
for each statement execute function private.record_bunker_map_backup_mutation();
create trigger bunker_map_backup_epoch_fence
after insert or update or delete or truncate
on private.attendance_dingtalk_missing_punch_resolutions
for each statement execute function private.record_bunker_map_backup_mutation();
