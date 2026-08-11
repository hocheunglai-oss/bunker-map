-- Preserve an active per-event worker lease when a newer event generation is
-- queued. The current worker cannot acknowledge the newer requested_at value,
-- and a second worker cannot overlap it before the lease is released/expires.

create or replace function public.queue_event_calendar_google_sync_jobs()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  old_payload jsonb := '{}'::jsonb;
  new_payload jsonb := coalesce(new.payload, '{}'::jsonb);
begin
  if new.key <> 'event-calendar' then
    return new;
  end if;

  if tg_op = 'UPDATE' then
    old_payload := coalesce(old.payload, '{}'::jsonb);
  end if;

  insert into public.event_calendar_google_sync_jobs as existing (
    event_id,
    requested_at,
    attempts,
    next_attempt_at,
    locked_until,
    locked_by,
    last_error
  )
  with old_events as (
    select event ->> 'id' as event_id, event
    from jsonb_array_elements(
      case when jsonb_typeof(old_payload -> 'events') = 'array'
        then old_payload -> 'events'
        else '[]'::jsonb
      end
    ) as items(event)
    where jsonb_typeof(event -> 'id') = 'string'
      and btrim(event ->> 'id') <> ''
  ),
  new_events as (
    select event ->> 'id' as event_id, event
    from jsonb_array_elements(
      case when jsonb_typeof(new_payload -> 'events') = 'array'
        then new_payload -> 'events'
        else '[]'::jsonb
      end
    ) as items(event)
    where jsonb_typeof(event -> 'id') = 'string'
      and btrim(event ->> 'id') <> ''
  ),
  changed_events as (
    select distinct coalesce(new_events.event_id, old_events.event_id) as event_id
    from old_events
    full join new_events using (event_id)
    where old_events.event is distinct from new_events.event
      and (
        old_events.event ->> 'eventType' in ('Meeting', 'Meeting Room')
        or new_events.event ->> 'eventType' in ('Meeting', 'Meeting Room')
      )
  )
  select event_id, clock_timestamp(), 0, clock_timestamp(), null, null, null
  from changed_events
  where length(btrim(event_id)) between 1 and 200
  on conflict (event_id) do update
  set
    requested_at = excluded.requested_at,
    attempts = 0,
    next_attempt_at = excluded.next_attempt_at,
    locked_until = case
      when existing.locked_until > clock_timestamp() then existing.locked_until
      else null
    end,
    locked_by = case
      when existing.locked_until > clock_timestamp() then existing.locked_by
      else null
    end,
    last_error = null;

  return new;
end;
$$;

revoke all on function public.queue_event_calendar_google_sync_jobs() from public;
