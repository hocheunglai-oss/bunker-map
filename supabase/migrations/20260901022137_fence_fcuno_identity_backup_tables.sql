-- Identity audit, sync delivery, and FCUNO-to-SPC linkage are durable recovery
-- state. Record their committed writes in the global backup epoch so a paged
-- export fails closed instead of publishing a mixed-time snapshot.
--
-- Production received the identity federation migration from its feature
-- branch before that branch was merged to main. Guard each table so this repair
-- is safe against that temporary schema-history mismatch.
do $$
begin
  if to_regclass('public.fcuno_identity_audit') is not null then
    execute 'drop trigger if exists bunker_map_backup_epoch_fence on public.fcuno_identity_audit';
    execute 'create trigger bunker_map_backup_epoch_fence
      after insert or update or delete or truncate on public.fcuno_identity_audit
      for each statement execute function private.record_bunker_map_backup_mutation()';
  end if;

  if to_regclass('public.fcuno_identity_sync_outbox') is not null then
    execute 'drop trigger if exists bunker_map_backup_epoch_fence on public.fcuno_identity_sync_outbox';
    execute 'create trigger bunker_map_backup_epoch_fence
      after insert or update or delete or truncate on public.fcuno_identity_sync_outbox
      for each statement execute function private.record_bunker_map_backup_mutation()';
  end if;

  if to_regclass('public.spc_identity_links') is not null then
    execute 'drop trigger if exists bunker_map_backup_epoch_fence on public.spc_identity_links';
    execute 'create trigger bunker_map_backup_epoch_fence
      after insert or update or delete or truncate on public.spc_identity_links
      for each statement execute function private.record_bunker_map_backup_mutation()';
  end if;
end;
$$;
