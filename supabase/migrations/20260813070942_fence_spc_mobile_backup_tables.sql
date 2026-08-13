-- Keep the SPC mobile-mode and delivery ledger consistent in paged backups.
drop trigger if exists bunker_map_backup_epoch_fence
  on public.spc_mobile_modes;
create trigger bunker_map_backup_epoch_fence
after insert or update or delete or truncate
on public.spc_mobile_modes
for each statement execute function private.record_bunker_map_backup_mutation();

drop trigger if exists bunker_map_backup_epoch_fence
  on public.spc_mobile_enquiry_deliveries;
create trigger bunker_map_backup_epoch_fence
after insert or update or delete or truncate
on public.spc_mobile_enquiry_deliveries
for each statement execute function private.record_bunker_map_backup_mutation();
