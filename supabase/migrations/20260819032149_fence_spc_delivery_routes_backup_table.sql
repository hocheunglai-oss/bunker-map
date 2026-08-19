drop trigger if exists bunker_map_backup_epoch_fence on public.spc_delivery_routes;
create trigger bunker_map_backup_epoch_fence
after insert or update or delete or truncate on public.spc_delivery_routes
for each statement
execute function private.record_bunker_map_backup_mutation();
