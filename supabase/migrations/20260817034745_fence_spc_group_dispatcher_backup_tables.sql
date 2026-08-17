do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'spc_enquiry_revisions',
    'spc_group_delivery_jobs',
    'spc_group_dispatchers'
  ] loop
    execute format('drop trigger if exists bunker_map_backup_epoch_fence on public.%I', table_name);
    execute format(
      'create trigger bunker_map_backup_epoch_fence after insert or update or delete or truncate on public.%I for each statement execute function private.record_bunker_map_backup_mutation()',
      table_name
    );
  end loop;
end;
$$;
