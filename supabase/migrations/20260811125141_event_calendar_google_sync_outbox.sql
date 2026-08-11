-- Keep Google meeting-room side effects durable and ordered independently of
-- long-lived browser tabs. Event changes and queue writes commit together.

create table if not exists public.event_calendar_google_sync_jobs (
  event_id text primary key,
  requested_at timestamptz not null default clock_timestamp(),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default clock_timestamp(),
  locked_until timestamptz,
  locked_by text,
  last_error text,
  constraint event_calendar_google_sync_jobs_event_id_nonempty
    check (length(btrim(event_id)) between 1 and 200)
);

create index if not exists event_calendar_google_sync_jobs_ready_idx
  on public.event_calendar_google_sync_jobs (next_attempt_at, requested_at)
  where locked_until is null;

alter table public.event_calendar_google_sync_jobs enable row level security;
revoke all on table public.event_calendar_google_sync_jobs from public, anon, authenticated;
grant select, insert, update, delete on table public.event_calendar_google_sync_jobs to service_role;

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

  insert into public.event_calendar_google_sync_jobs (
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
    select coalesce(new_events.event_id, old_events.event_id) as event_id
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
    locked_until = null,
    locked_by = null,
    last_error = null;

  return new;
end;
$$;

revoke all on function public.queue_event_calendar_google_sync_jobs() from public;

drop trigger if exists queue_event_calendar_google_sync_jobs
  on public.office_calendar_store;
create trigger queue_event_calendar_google_sync_jobs
after insert or update of payload on public.office_calendar_store
for each row
execute function public.queue_event_calendar_google_sync_jobs();

create or replace function public.claim_event_calendar_google_sync_jobs(
  p_event_ids text[] default null,
  p_limit integer default 12,
  p_worker_id text default 'event-calendar-google-sync'
)
returns table (
  event_id text,
  requested_at timestamptz,
  attempts integer
)
language sql
security definer
set search_path = public, pg_temp
as $$
  with picked as (
    select jobs.event_id, jobs.requested_at
    from public.event_calendar_google_sync_jobs as jobs
    where jobs.next_attempt_at <= clock_timestamp()
      and (jobs.locked_until is null or jobs.locked_until < clock_timestamp())
      and (p_event_ids is null or jobs.event_id = any(p_event_ids))
    order by jobs.requested_at, jobs.event_id
    for update skip locked
    limit least(greatest(coalesce(p_limit, 12), 1), 50)
  ),
  claimed as (
    update public.event_calendar_google_sync_jobs as jobs
    set
      locked_until = clock_timestamp() + interval '5 minutes',
      locked_by = coalesce(nullif(btrim(p_worker_id), ''), 'event-calendar-google-sync')
    from picked
    where jobs.event_id = picked.event_id
      and jobs.requested_at = picked.requested_at
    returning jobs.event_id, jobs.requested_at, jobs.attempts
  )
  select claimed.event_id, claimed.requested_at, claimed.attempts
  from claimed
  order by claimed.requested_at, claimed.event_id;
$$;

revoke all on function public.claim_event_calendar_google_sync_jobs(text[], integer, text)
  from public, anon, authenticated;
grant execute on function public.claim_event_calendar_google_sync_jobs(text[], integer, text)
  to service_role;

-- Reconcile currently active managed meetings and known tombstones once after
-- rollout. The ongoing trigger only queues records whose event JSON changes.
insert into public.event_calendar_google_sync_jobs (event_id)
select distinct event_id
from (
  select event ->> 'id' as event_id
  from public.office_calendar_store as store
  cross join lateral jsonb_array_elements(
    case when jsonb_typeof(store.payload -> 'events') = 'array'
      then store.payload -> 'events'
      else '[]'::jsonb
    end
  ) as items(event)
  where store.key = 'event-calendar'
    and event ->> 'eventType' in ('Meeting', 'Meeting Room')

  union all

  select deleted_id as event_id
  from public.office_calendar_store as store
  cross join lateral jsonb_array_elements_text(
    case when jsonb_typeof(store.payload -> 'deletedEventIds') = 'array'
      then store.payload -> 'deletedEventIds'
      else '[]'::jsonb
    end
  ) as deleted(deleted_id)
  where store.key = 'event-calendar'
) as initial_jobs
where length(btrim(event_id)) between 1 and 200
on conflict (event_id) do nothing;
