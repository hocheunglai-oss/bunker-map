-- Support User Management deletion checks and ON DELETE SET NULL maintenance
-- for the effective-dated attendance group history.
create index if not exists attendance_team_assignments_source_admin_user_id_idx
  on public.attendance_team_assignments (source_admin_user_id)
  where source_admin_user_id is not null;
