-- Task Calendar now uses record versions and deletion tombstones, like Event
-- Calendar. A whole-row audit restore must not bypass those safeguards.
-- Keep the existing trigger name/wiring and Event Calendar behaviour intact.

create or replace function public.block_event_calendar_snapshot_undo()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  target_key text := case when tg_op = 'DELETE' then old.key else new.key end;
begin
  if nullif(current_setting('app.audit_undo_of_log_id', true), '') is not null then
    if target_key = 'event-calendar' then
      raise exception
        'Event Calendar audit snapshots cannot be undone. Use versioned event editing or additive recovery.';
    elsif target_key = 'task-calendar' then
      raise exception
        'Task Calendar audit snapshots cannot be undone. Use versioned task editing.';
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function public.block_event_calendar_snapshot_undo() from public;
