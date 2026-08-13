-- These durable tables were added after the backup mutation-fence migration.
-- Track every committed write so a paged export fails closed instead of
-- publishing a mixed-time snapshot.
drop trigger if exists bunker_map_backup_epoch_fence
  on public.event_calendar_google_sync_jobs;
create trigger bunker_map_backup_epoch_fence
after insert or update or delete or truncate
on public.event_calendar_google_sync_jobs
for each statement execute function private.record_bunker_map_backup_mutation();

drop trigger if exists bunker_map_backup_epoch_fence
  on public.spc_feedback;
create trigger bunker_map_backup_epoch_fence
after insert or update or delete or truncate
on public.spc_feedback
for each statement execute function private.record_bunker_map_backup_mutation();
