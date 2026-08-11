-- Event Calendar changes are record-versioned. Restoring an audit snapshot of
-- the whole JSON row would bypass those safeguards, so corrections must use
-- the additive recovery tool or normal per-event mutations instead.

create or replace function public.block_event_calendar_snapshot_undo()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  target_key text := case when tg_op = 'DELETE' then old.key else new.key end;
begin
  if target_key = 'event-calendar'
    and nullif(current_setting('app.audit_undo_of_log_id', true), '') is not null
  then
    raise exception
      'Event Calendar audit snapshots cannot be undone. Use versioned event editing or additive recovery.';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function public.block_event_calendar_snapshot_undo() from public;

drop trigger if exists block_event_calendar_snapshot_undo
  on public.office_calendar_store;
create trigger block_event_calendar_snapshot_undo
before insert or update or delete on public.office_calendar_store
for each row
execute function public.block_event_calendar_snapshot_undo();
