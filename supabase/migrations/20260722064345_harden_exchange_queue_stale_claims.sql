alter table public.outlook_exchange_sync_queue
  add column if not exists error_history jsonb not null default '[]'::jsonb;

alter table public.outlook_exchange_sync_queue
  alter column error_history set default '[]'::jsonb;

update public.outlook_exchange_sync_queue
set error_history = '[]'::jsonb
where error_history is null;

alter table public.outlook_exchange_sync_queue
  alter column error_history set not null;

comment on column public.outlook_exchange_sync_queue.error_history is
  'Append-only history of queue errors, expired processing leases, and retry claims.';

do $$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'public.outlook_exchange_sync_queue'::regclass
      and conname = 'outlook_exchange_sync_queue_error_history_array'
  ) then
    alter table public.outlook_exchange_sync_queue
      add constraint outlook_exchange_sync_queue_error_history_array
      check (jsonb_typeof(error_history) = 'array') not valid;
  end if;
end;
$$;

alter table public.outlook_exchange_sync_queue
  validate constraint outlook_exchange_sync_queue_error_history_array;

create table if not exists public.outlook_exchange_sync_certifications (
  run_id uuid primary key,
  sync_mode text not null,
  queue_high_water_sequence bigint not null,
  queue_high_water_updated_at timestamptz,
  source_fingerprint text not null,
  certified_at timestamptz not null,
  result jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  constraint outlook_exchange_sync_certifications_full_mode
    check (sync_mode = 'full'),
  constraint outlook_exchange_sync_certifications_result_object
    check (jsonb_typeof(result) = 'object')
);

comment on table public.outlook_exchange_sync_certifications is
  'Protected durable receipts for source-fenced full Exchange certifications and lost-response replay.';
comment on column public.outlook_exchange_sync_certifications.run_id is
  'Unique certification identity; reusing a run ID with a different fence or fingerprint is rejected.';
comment on column public.outlook_exchange_sync_certifications.result is
  'Original successful RPC result returned verbatim, with idempotent=true added on replay.';

alter table public.outlook_exchange_sync_certifications enable row level security;
revoke all on public.outlook_exchange_sync_certifications from public, anon, authenticated;

-- Repair exhausted failures written by older workers that left retry metadata
-- behind. The predicate becomes false after this update, so rerunning the
-- migration cannot append the event twice or rewrite the original error.
with malformed_terminal as materialized (
  select
    queue.id,
    queue.next_attempt_at as previous_next_attempt_at,
    queue.completed_at as previous_completed_at,
    clock_timestamp() as normalized_at
  from public.outlook_exchange_sync_queue as queue
  where queue.status = 'failed'
    and queue.attempts >= 3
    and (queue.next_attempt_at is not null or queue.completed_at is null)
  for update of queue
)
update public.outlook_exchange_sync_queue as queue
set next_attempt_at = null,
    completed_at = coalesce(queue.completed_at, malformed_terminal.normalized_at),
    error_history = coalesce(queue.error_history, '[]'::jsonb) || jsonb_build_array(
      jsonb_strip_nulls(jsonb_build_object(
        'type', 'terminal_normalized',
        'message', 'Retry limit was already exhausted; terminal queue metadata was normalized without changing the recorded failure.',
        'recorded_at', malformed_terminal.normalized_at,
        'attempt', queue.attempts,
        'run_id', queue.run_id,
        'previous_next_attempt_at', malformed_terminal.previous_next_attempt_at,
        'previous_completed_at', malformed_terminal.previous_completed_at,
        'previous_error_message', nullif(queue.error_message, '')
      ))
    ),
    updated_at = malformed_terminal.normalized_at
from malformed_terminal
where queue.id = malformed_terminal.id;

create or replace function public.claim_outlook_exchange_sync_queue(
  p_run_id uuid,
  p_limit integer default 200
)
returns setof public.outlook_exchange_sync_queue
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  claim_time constant timestamptz := clock_timestamp();
  stale_before constant timestamptz := claim_time - interval '20 minutes';
begin
  if p_run_id is null then raise exception 'p_run_id is required'; end if;

  -- Keep future exhausted failures terminal even if an older worker writes a
  -- misleading retry timestamp or omits completed_at. Locked rows skipped by a
  -- concurrent claimant are repaired by a later claim call.
  with malformed_terminal as materialized (
    select
      queue.id,
      queue.next_attempt_at as previous_next_attempt_at,
      queue.completed_at as previous_completed_at
    from public.outlook_exchange_sync_queue as queue
    where queue.status = 'failed'
      and queue.attempts >= 3
      and (queue.next_attempt_at is not null or queue.completed_at is null)
    for update of queue skip locked
  )
  update public.outlook_exchange_sync_queue as queue
  set next_attempt_at = null,
      completed_at = coalesce(queue.completed_at, claim_time),
      error_history = coalesce(queue.error_history, '[]'::jsonb) || jsonb_build_array(
        jsonb_strip_nulls(jsonb_build_object(
          'type', 'terminal_normalized',
          'message', 'Retry limit was already exhausted; terminal queue metadata was normalized without changing the recorded failure.',
          'recorded_at', claim_time,
          'attempt', queue.attempts,
          'run_id', queue.run_id,
          'previous_next_attempt_at', malformed_terminal.previous_next_attempt_at,
          'previous_completed_at', malformed_terminal.previous_completed_at,
          'previous_error_message', nullif(queue.error_message, '')
        ))
      ),
      updated_at = claim_time
  from malformed_terminal
  where queue.id = malformed_terminal.id;

  -- Always expire abandoned leases before selecting more work. A row whose
  -- third claim expired is terminally failed; earlier expiries are made due
  -- for retry and can be reclaimed by the candidate query below.
  with stale as materialized (
    select
      queue.id,
      queue.attempts,
      coalesce(
        queue.claimed_at,
        queue.processing_started_at,
        queue.updated_at,
        queue.created_at
      ) as lease_started_at,
      case
        when queue.attempts >= 3 then format(
          'Processing lease expired after 20 minutes on attempt %s of 3; retry limit exhausted and the queue row is terminally failed.',
          queue.attempts
        )
        else format(
          'Processing lease expired after 20 minutes on attempt %s of 3; the queue row is eligible for retry.',
          queue.attempts
        )
      end as expiry_message
    from public.outlook_exchange_sync_queue as queue
    where queue.status = 'processing'
      and coalesce(
        queue.claimed_at,
        queue.processing_started_at,
        queue.updated_at,
        queue.created_at
      ) < stale_before
    for update of queue skip locked
  )
  update public.outlook_exchange_sync_queue as queue
  set status = 'failed',
      next_attempt_at = case
        when stale.attempts >= 3 then null
        else claim_time
      end,
      completed_at = case
        when stale.attempts >= 3 then claim_time
        else null
      end,
      exchange_verified_at = null,
      error_message = stale.expiry_message,
      error_history = coalesce(queue.error_history, '[]'::jsonb) || jsonb_build_array(
        jsonb_strip_nulls(jsonb_build_object(
          'type', 'lease_expired',
          'message', stale.expiry_message,
          'recorded_at', claim_time,
          'attempt', stale.attempts,
          'terminal', stale.attempts >= 3,
          'previous_run_id', queue.run_id,
          'lease_started_at', stale.lease_started_at,
          'previous_error_message', nullif(queue.error_message, '')
        ))
      ),
      updated_at = claim_time
  from stale
  where queue.id = stale.id;

  return query
  with eligible as (
    select
      queue.id,
      row_number() over (
        partition by queue.entity_key
        order by queue.queue_sequence
      ) as entity_rank
    from public.outlook_exchange_sync_queue as queue
    where (
      queue.status = 'pending'
      or (
        queue.status = 'failed'
        and queue.attempts < 3
        and queue.next_attempt_at is not null
        and queue.next_attempt_at <= claim_time
      )
    )
    and not exists (
      select 1
      from public.outlook_exchange_sync_queue as active
      where active.entity_key = queue.entity_key
        and active.id <> queue.id
        and active.status = 'processing'
    )
  ), candidates as (
    select queue.id
    from public.outlook_exchange_sync_queue as queue
    join eligible on eligible.id = queue.id and eligible.entity_rank = 1
    order by queue.queue_sequence
    for update of queue skip locked
    limit greatest(1, least(coalesce(p_limit, 200), 500))
  ), claimed as (
    update public.outlook_exchange_sync_queue as queue
    set status = 'processing',
        attempts = queue.attempts + 1,
        processing_started_at = claim_time,
        claimed_at = claim_time,
        next_attempt_at = null,
        completed_at = null,
        exchange_verified_at = null,
        error_history = case
          when queue.status = 'failed' then
            coalesce(queue.error_history, '[]'::jsonb) || jsonb_build_array(
              jsonb_strip_nulls(jsonb_build_object(
                'type', 'retry_claimed',
                'recorded_at', claim_time,
                'from_attempt', queue.attempts,
                'to_attempt', queue.attempts + 1,
                'new_run_id', p_run_id,
                'previous_run_id', queue.run_id,
                'previous_next_attempt_at', queue.next_attempt_at,
                'previous_error_message', nullif(queue.error_message, '')
              ))
            )
          else coalesce(queue.error_history, '[]'::jsonb)
        end,
        error_message = null,
        run_id = p_run_id,
        updated_at = claim_time
    from candidates
    where queue.id = candidates.id
    returning queue.*
  )
  select claimed.*
  from claimed
  order by claimed.queue_sequence;
end;
$$;

-- Contact canonicalization uses updated_at to choose among duplicate e-mail
-- rows, so every contact UPDATE can change the Exchange projection. Group and
-- membership UPDATEs are limited to projection-relevant fields. The
-- independent audit trigger still sees every source-table change.
drop trigger if exists outlook_exchange_queue_contact on public.shared_addressbook_contacts;
drop trigger if exists outlook_exchange_queue_contact_insert_delete on public.shared_addressbook_contacts;
drop trigger if exists outlook_exchange_queue_contact_relevant_update on public.shared_addressbook_contacts;
create trigger outlook_exchange_queue_contact
  after insert or update or delete on public.shared_addressbook_contacts
  for each row execute function public.outlook_exchange_queue_source_change();

drop trigger if exists outlook_exchange_queue_group on public.shared_addressbook_groups;
drop trigger if exists outlook_exchange_queue_group_insert_delete on public.shared_addressbook_groups;
drop trigger if exists outlook_exchange_queue_group_relevant_update on public.shared_addressbook_groups;
create trigger outlook_exchange_queue_group_insert_delete
  after insert or delete on public.shared_addressbook_groups
  for each row execute function public.outlook_exchange_queue_source_change();
create trigger outlook_exchange_queue_group_relevant_update
  after update of id, name, nickname, description, source_uid
  on public.shared_addressbook_groups
  for each row
  when (
    old.id is distinct from new.id
    or old.name is distinct from new.name
    or old.nickname is distinct from new.nickname
    or old.description is distinct from new.description
    or old.source_uid is distinct from new.source_uid
  )
  execute function public.outlook_exchange_queue_source_change();

drop trigger if exists outlook_exchange_queue_member on public.shared_addressbook_group_members;
drop trigger if exists outlook_exchange_queue_member_insert_delete on public.shared_addressbook_group_members;
drop trigger if exists outlook_exchange_queue_member_relevant_update on public.shared_addressbook_group_members;
create trigger outlook_exchange_queue_member_insert_delete
  after insert or delete on public.shared_addressbook_group_members
  for each row execute function public.outlook_exchange_queue_source_change();
create trigger outlook_exchange_queue_member_relevant_update
  after update of group_id, contact_id
  on public.shared_addressbook_group_members
  for each row
  when (
    old.group_id is distinct from new.group_id
    or old.contact_id is distinct from new.contact_id
  )
  execute function public.outlook_exchange_queue_source_change();

create or replace function public.complete_verified_outlook_exchange_sync_queue_row(
  p_queue_row_id uuid,
  p_run_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  completed_row public.outlook_exchange_sync_queue%rowtype;
  completed_at_value constant timestamptz := clock_timestamp();
  supersession_reason text;
  superseded_count_value bigint := 0;
  superseded_rows_value jsonb := '[]'::jsonb;
begin
  if p_queue_row_id is null or p_run_id is null then
    return jsonb_build_object(
      'completed', false,
      'idempotent', false,
      'reason', 'Queue row ID and run ID are required.',
      'completedRow', null,
      'supersededCount', 0,
      'supersededRows', '[]'::jsonb
    );
  end if;

  select queue.* into completed_row
  from public.outlook_exchange_sync_queue as queue
  where queue.id = p_queue_row_id
  for update of queue;

  if not found then
    return jsonb_build_object(
      'completed', false,
      'idempotent', false,
      'reason', 'Queue row was not found.',
      'completedRow', null,
      'supersededCount', 0,
      'supersededRows', '[]'::jsonb
    );
  end if;

  if completed_row.run_id is distinct from p_run_id then
    return jsonb_build_object(
      'completed', false,
      'idempotent', false,
      'reason', 'Queue row is not owned by the supplied run.',
      'completedRow', null,
      'supersededCount', 0,
      'supersededRows', '[]'::jsonb
    );
  end if;

  if completed_row.status = 'completed'
    and completed_row.exchange_verified_at is not null
  then
    with linked_superseded as materialized (
      select distinct on (queue.id)
        queue.id,
        queue.event_id,
        queue.entity_type,
        queue.entity_id,
        queue.entity_key,
        queue.entity_email,
        queue.entity_alias,
        queue.action,
        queue.display_name,
        queue.payload,
        queue.change_set_id,
        queue.change_set_ids,
        queue.audit_log_id,
        queue.audit_log_ids,
        queue.actor_id,
        queue.changed_fields,
        queue.source_version,
        queue.status,
        queue.attempts,
        queue.requested_by,
        queue.error_message,
        queue.error_history,
        queue.completed_at,
        history.event ->> 'previous_error_message' as previous_error_message,
        history.event ->> 'previous_run_id' as previous_run_id
      from public.outlook_exchange_sync_queue as queue
      cross join lateral jsonb_array_elements(
        coalesce(queue.error_history, '[]'::jsonb)
      ) as history(event)
      where queue.status = 'skipped'
        and history.event ->> 'type' = 'terminal_failure_superseded'
        and history.event ->> 'superseding_queue_row_id' = completed_row.id::text
        and history.event ->> 'superseding_run_id' = p_run_id::text
      order by
        queue.id,
        (history.event ->> 'recorded_at')::timestamptz desc nulls last
    )
    select
      count(*),
      coalesce(
        jsonb_agg(
          jsonb_build_object(
            'id', linked_superseded.id,
            'eventId', linked_superseded.event_id,
            'entityType', linked_superseded.entity_type,
            'entityId', linked_superseded.entity_id,
            'entityKey', linked_superseded.entity_key,
            'entityEmail', linked_superseded.entity_email,
            'entityAlias', linked_superseded.entity_alias,
            'action', linked_superseded.action,
            'displayName', linked_superseded.display_name,
            'payload', linked_superseded.payload,
            'changeSetId', linked_superseded.change_set_id,
            'changeSetIds', linked_superseded.change_set_ids,
            'auditLogId', linked_superseded.audit_log_id,
            'auditLogIds', linked_superseded.audit_log_ids,
            'actorId', linked_superseded.actor_id,
            'changedFields', linked_superseded.changed_fields,
            'sourceVersion', linked_superseded.source_version,
            'status', linked_superseded.status,
            'attempts', linked_superseded.attempts,
            'requestedBy', linked_superseded.requested_by,
            'previousErrorMessage', linked_superseded.previous_error_message,
            'errorMessage', linked_superseded.error_message,
            'errorHistory', linked_superseded.error_history,
            'previousRunId', linked_superseded.previous_run_id,
            'supersededByQueueRowId', completed_row.id,
            'supersededByRunId', p_run_id,
            'completedAt', linked_superseded.completed_at
          ) order by linked_superseded.id
        ),
        '[]'::jsonb
      )
    into superseded_count_value, superseded_rows_value
    from linked_superseded;

    return jsonb_build_object(
      'completed', true,
      'idempotent', true,
      'reason', 'Queue row was already completed and Exchange-verified by this run.',
      'completedRow', jsonb_build_object(
        'id', completed_row.id,
        'eventId', completed_row.event_id,
        'entityType', completed_row.entity_type,
        'entityId', completed_row.entity_id,
        'entityKey', completed_row.entity_key,
        'entityEmail', completed_row.entity_email,
        'entityAlias', completed_row.entity_alias,
        'action', completed_row.action,
        'displayName', completed_row.display_name,
        'payload', completed_row.payload,
        'changeSetId', completed_row.change_set_id,
        'changeSetIds', completed_row.change_set_ids,
        'auditLogId', completed_row.audit_log_id,
        'auditLogIds', completed_row.audit_log_ids,
        'actorId', completed_row.actor_id,
        'changedFields', completed_row.changed_fields,
        'sourceVersion', completed_row.source_version,
        'status', completed_row.status,
        'attempts', completed_row.attempts,
        'requestedBy', completed_row.requested_by,
        'errorHistory', completed_row.error_history,
        'runId', completed_row.run_id,
        'exchangeVerifiedAt', completed_row.exchange_verified_at,
        'completedAt', completed_row.completed_at
      ),
      'supersededCount', superseded_count_value,
      'supersededRows', superseded_rows_value
    );
  end if;

  if completed_row.status <> 'processing' then
    return jsonb_build_object(
      'completed', false,
      'idempotent', false,
      'reason', format(
        'Queue row must be processing before verified completion; current status is %s.',
        completed_row.status
      ),
      'completedRow', null,
      'supersededCount', 0,
      'supersededRows', '[]'::jsonb
    );
  end if;

  update public.outlook_exchange_sync_queue as queue
  set status = 'completed',
      exchange_verified_at = completed_at_value,
      completed_at = completed_at_value,
      processing_started_at = null,
      claimed_at = null,
      next_attempt_at = null,
      error_message = null,
      updated_at = completed_at_value
  where queue.id = p_queue_row_id
    and queue.status = 'processing'
    and queue.run_id = p_run_id
  returning queue.* into completed_row;

  if not found then
    return jsonb_build_object(
      'completed', false,
      'idempotent', false,
      'reason', 'Queue processing ownership changed before completion could be saved.',
      'completedRow', null,
      'supersededCount', 0,
      'supersededRows', '[]'::jsonb
    );
  end if;

  if nullif(btrim(completed_row.entity_id), '') is not null
    and completed_row.entity_type in ('contact', 'group', 'group_members')
  then
    supersession_reason := format(
      'Superseded by later Exchange-verified current state from queue row %s, run %s, at %s.',
      completed_row.id,
      p_run_id,
      completed_at_value
    );

    with existing_terminal as materialized (
      select
        queue.id,
        queue.status as previous_status,
        queue.error_message as previous_error_message,
        queue.completed_at as previous_completed_at,
        queue.run_id as previous_run_id
      from public.outlook_exchange_sync_queue as queue
      where queue.id <> completed_row.id
        and (
          (
            completed_row.entity_type = 'contact'
            and queue.entity_type = 'contact'
            and queue.entity_id = completed_row.entity_id
          )
          or (
            completed_row.entity_type in ('group', 'group_members')
            and queue.entity_type in ('group', 'group_members')
            and queue.entity_id = completed_row.entity_id
          )
        )
        and queue.status = 'failed'
        and queue.next_attempt_at is null
      for update of queue
    ), superseded as (
      update public.outlook_exchange_sync_queue as queue
      set status = 'skipped',
          completed_at = completed_at_value,
          processing_started_at = null,
          claimed_at = null,
          next_attempt_at = null,
          error_message = case
            when nullif(btrim(queue.error_message), '') is null then supersession_reason
            else queue.error_message || E'\n' || supersession_reason
          end,
          error_history = coalesce(queue.error_history, '[]'::jsonb) || jsonb_build_array(
            jsonb_strip_nulls(jsonb_build_object(
              'type', 'terminal_failure_superseded',
              'message', supersession_reason,
              'recorded_at', completed_at_value,
              'superseding_queue_row_id', completed_row.id,
              'superseding_run_id', p_run_id,
              'superseding_exchange_verified_at', completed_row.exchange_verified_at,
              'previous_status', existing_terminal.previous_status,
              'previous_run_id', existing_terminal.previous_run_id,
              'previous_completed_at', existing_terminal.previous_completed_at,
              'previous_error_message', nullif(existing_terminal.previous_error_message, '')
            ))
          ),
          updated_at = completed_at_value
      from existing_terminal
      where queue.id = existing_terminal.id
        and queue.status = 'failed'
        and queue.next_attempt_at is null
      returning
        queue.id,
        queue.event_id,
        queue.entity_type,
        queue.entity_id,
        queue.entity_key,
        queue.entity_email,
        queue.entity_alias,
        queue.action,
        queue.display_name,
        queue.payload,
        queue.change_set_id,
        queue.change_set_ids,
        queue.audit_log_id,
        queue.audit_log_ids,
        queue.actor_id,
        queue.changed_fields,
        queue.source_version,
        queue.status,
        queue.attempts,
        queue.requested_by,
        queue.error_message,
        queue.error_history,
        queue.completed_at,
        existing_terminal.previous_error_message,
        existing_terminal.previous_run_id
    )
    select
      count(*),
      coalesce(
        jsonb_agg(
          jsonb_build_object(
            'id', superseded.id,
            'eventId', superseded.event_id,
            'entityType', superseded.entity_type,
            'entityId', superseded.entity_id,
            'entityKey', superseded.entity_key,
            'entityEmail', superseded.entity_email,
            'entityAlias', superseded.entity_alias,
            'action', superseded.action,
            'displayName', superseded.display_name,
            'payload', superseded.payload,
            'changeSetId', superseded.change_set_id,
            'changeSetIds', superseded.change_set_ids,
            'auditLogId', superseded.audit_log_id,
            'auditLogIds', superseded.audit_log_ids,
            'actorId', superseded.actor_id,
            'changedFields', superseded.changed_fields,
            'sourceVersion', superseded.source_version,
            'status', superseded.status,
            'attempts', superseded.attempts,
            'requestedBy', superseded.requested_by,
            'previousErrorMessage', superseded.previous_error_message,
            'errorMessage', superseded.error_message,
            'errorHistory', superseded.error_history,
            'previousRunId', superseded.previous_run_id,
            'supersededByQueueRowId', completed_row.id,
            'supersededByRunId', p_run_id,
            'completedAt', superseded.completed_at
          ) order by superseded.id
        ),
        '[]'::jsonb
      )
    into superseded_count_value, superseded_rows_value
    from superseded;
  end if;

  return jsonb_build_object(
    'completed', true,
    'idempotent', false,
    'reason', 'Queue row was completed, Exchange-verified, and existing terminal failures for the reconciled current state were superseded atomically.',
    'completedRow', jsonb_build_object(
      'id', completed_row.id,
      'eventId', completed_row.event_id,
      'entityType', completed_row.entity_type,
      'entityId', completed_row.entity_id,
      'entityKey', completed_row.entity_key,
      'entityEmail', completed_row.entity_email,
      'entityAlias', completed_row.entity_alias,
      'action', completed_row.action,
      'displayName', completed_row.display_name,
      'payload', completed_row.payload,
      'changeSetId', completed_row.change_set_id,
      'changeSetIds', completed_row.change_set_ids,
      'auditLogId', completed_row.audit_log_id,
      'auditLogIds', completed_row.audit_log_ids,
      'actorId', completed_row.actor_id,
      'changedFields', completed_row.changed_fields,
      'sourceVersion', completed_row.source_version,
      'status', completed_row.status,
      'attempts', completed_row.attempts,
      'requestedBy', completed_row.requested_by,
      'errorHistory', completed_row.error_history,
      'runId', completed_row.run_id,
      'exchangeVerifiedAt', completed_row.exchange_verified_at,
      'completedAt', completed_row.completed_at
    ),
    'supersededCount', superseded_count_value,
    'supersededRows', superseded_rows_value
  );
end;
$$;

-- Clean up the exact 63-byte identifier PostgreSQL would have produced if an
-- earlier preview applied the original overlong draft name.
drop function if exists public.supersede_terminal_outlook_exchange_sync_queue_after_full_certi(
  uuid,
  bigint,
  timestamptz,
  text
);

create or replace function public.certify_full_outlook_exchange_sync_queue(
  p_run_id uuid,
  p_queue_high_water_sequence bigint,
  p_queue_high_water_updated_at timestamptz,
  p_source_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  certified_at_value constant timestamptz := clock_timestamp();
  current_high_water_sequence bigint := 0;
  current_high_water_updated_at timestamptz;
  active_backlog_count bigint := 0;
  prior_certification public.outlook_exchange_sync_certifications%rowtype;
  supersession_reason text;
  superseded_count_value bigint := 0;
  superseded_rows_value jsonb := '[]'::jsonb;
  result_value jsonb;
begin
  if p_run_id is null
    or p_queue_high_water_sequence is null
    or nullif(btrim(p_source_fingerprint), '') is null
  then
    return jsonb_build_object(
      'certified', false,
      'idempotent', false,
      'reason', 'Run ID, queue high-water sequence, and source fingerprint are required.',
      'certifiedAt', null,
      'queueFence', null,
      'supersededCount', 0,
      'supersededRows', '[]'::jsonb
    );
  end if;

  select certification.* into prior_certification
  from public.outlook_exchange_sync_certifications as certification
  where certification.run_id = p_run_id;

  if found then
    if prior_certification.queue_high_water_sequence = p_queue_high_water_sequence
      and prior_certification.queue_high_water_updated_at is not distinct from p_queue_high_water_updated_at
      and prior_certification.source_fingerprint = p_source_fingerprint
    then
      return prior_certification.result || jsonb_build_object(
        'idempotent', true,
        'reason', 'This full certification run was already committed; returning its durable result.'
      );
    end if;
    return jsonb_build_object(
      'certified', false,
      'idempotent', false,
      'reason', 'Run ID was already used for a different full-certification fence.',
      'certifiedAt', null,
      'queueFence', null,
      'supersededCount', 0,
      'supersededRows', '[]'::jsonb
    );
  end if;

  -- Lock source tables before the outbox. A concurrent source writer either
  -- commits its durable queue change first (invalidating the fence) or waits
  -- until this source-certified sweep commits.
  lock table
    public.shared_addressbook_contacts,
    public.shared_addressbook_groups,
    public.shared_addressbook_group_members
  in share mode;
  lock table public.outlook_exchange_sync_queue in share row exclusive mode;

  -- Recheck after locking so concurrent calls with the same run ID converge on
  -- the first committed certification result.
  select certification.* into prior_certification
  from public.outlook_exchange_sync_certifications as certification
  where certification.run_id = p_run_id
  for update of certification;

  if found then
    if prior_certification.queue_high_water_sequence = p_queue_high_water_sequence
      and prior_certification.queue_high_water_updated_at is not distinct from p_queue_high_water_updated_at
      and prior_certification.source_fingerprint = p_source_fingerprint
    then
      return prior_certification.result || jsonb_build_object(
        'idempotent', true,
        'reason', 'This full certification run was already committed; returning its durable result.'
      );
    end if;
    return jsonb_build_object(
      'certified', false,
      'idempotent', false,
      'reason', 'Run ID was already used for a different full-certification fence.',
      'certifiedAt', null,
      'queueFence', null,
      'supersededCount', 0,
      'supersededRows', '[]'::jsonb
    );
  end if;

  select queue.queue_sequence, queue.updated_at
  into current_high_water_sequence, current_high_water_updated_at
  from public.outlook_exchange_sync_queue as queue
  order by queue.updated_at desc, queue.queue_sequence desc
  limit 1;

  if not found then
    current_high_water_sequence := 0;
    current_high_water_updated_at := null;
  end if;

  if current_high_water_sequence is distinct from p_queue_high_water_sequence
    or current_high_water_updated_at is distinct from p_queue_high_water_updated_at
  then
    return jsonb_build_object(
      'certified', false,
      'idempotent', false,
      'reason', 'Queue high-water changed after full projection verification; no terminal rows were superseded.',
      'certifiedAt', null,
      'queueFence', jsonb_build_object(
        'expectedSequence', p_queue_high_water_sequence,
        'expectedUpdatedAt', p_queue_high_water_updated_at,
        'currentSequence', current_high_water_sequence,
        'currentUpdatedAt', current_high_water_updated_at
      ),
      'supersededCount', 0,
      'supersededRows', '[]'::jsonb
    );
  end if;

  select count(*) into active_backlog_count
  from public.outlook_exchange_sync_queue as queue
  where queue.status in ('pending', 'processing')
    or (queue.status = 'failed' and queue.next_attempt_at is not null);

  if active_backlog_count > 0 then
    return jsonb_build_object(
      'certified', false,
      'idempotent', false,
      'reason', format(
        'Full certification cannot supersede terminal rows while %s active or retryable queue row(s) remain.',
        active_backlog_count
      ),
      'certifiedAt', null,
      'queueFence', jsonb_build_object(
        'expectedSequence', p_queue_high_water_sequence,
        'expectedUpdatedAt', p_queue_high_water_updated_at,
        'currentSequence', current_high_water_sequence,
        'currentUpdatedAt', current_high_water_updated_at
      ),
      'supersededCount', 0,
      'supersededRows', '[]'::jsonb
    );
  end if;

  supersession_reason := format(
    'Superseded by source-fenced full Exchange certification run %s at %s.',
    p_run_id,
    certified_at_value
  );

  with terminal as materialized (
    select
      queue.id,
      queue.status as previous_status,
      queue.error_message as previous_error_message,
      queue.completed_at as previous_completed_at,
      queue.run_id as previous_run_id
    from public.outlook_exchange_sync_queue as queue
    where queue.status = 'failed'
      and queue.next_attempt_at is null
    for update of queue
  ), superseded as (
    update public.outlook_exchange_sync_queue as queue
    set status = 'skipped',
        completed_at = certified_at_value,
        processing_started_at = null,
        claimed_at = null,
        next_attempt_at = null,
        error_message = case
          when nullif(btrim(queue.error_message), '') is null then supersession_reason
          else queue.error_message || E'\n' || supersession_reason
        end,
        error_history = coalesce(queue.error_history, '[]'::jsonb) || jsonb_build_array(
          jsonb_strip_nulls(jsonb_build_object(
            'type', 'terminal_failure_superseded_by_full_certification',
            'message', supersession_reason,
            'recorded_at', certified_at_value,
            'superseding_full_run_id', p_run_id,
            'source_fingerprint', p_source_fingerprint,
            'queue_high_water_sequence', current_high_water_sequence,
            'queue_high_water_updated_at', current_high_water_updated_at,
            'previous_status', terminal.previous_status,
            'previous_run_id', terminal.previous_run_id,
            'previous_completed_at', terminal.previous_completed_at,
            'previous_error_message', nullif(terminal.previous_error_message, '')
          ))
        ),
        updated_at = certified_at_value
    from terminal
    where queue.id = terminal.id
      and queue.status = 'failed'
      and queue.next_attempt_at is null
    returning
      queue.id,
      queue.event_id,
      queue.entity_type,
      queue.entity_id,
      queue.entity_key,
      queue.entity_email,
      queue.entity_alias,
      queue.action,
      queue.display_name,
      queue.payload,
      queue.change_set_id,
      queue.change_set_ids,
      queue.audit_log_id,
      queue.audit_log_ids,
      queue.actor_id,
      queue.changed_fields,
      queue.source_version,
      queue.status,
      queue.attempts,
      queue.requested_by,
      queue.error_message,
      queue.error_history,
      queue.completed_at,
      terminal.previous_error_message,
      terminal.previous_run_id
  )
  select
    count(*),
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', superseded.id,
          'eventId', superseded.event_id,
          'entityType', superseded.entity_type,
          'entityId', superseded.entity_id,
          'entityKey', superseded.entity_key,
          'entityEmail', superseded.entity_email,
          'entityAlias', superseded.entity_alias,
          'action', superseded.action,
          'displayName', superseded.display_name,
          'payload', superseded.payload,
          'changeSetId', superseded.change_set_id,
          'changeSetIds', superseded.change_set_ids,
          'auditLogId', superseded.audit_log_id,
          'auditLogIds', superseded.audit_log_ids,
          'actorId', superseded.actor_id,
          'changedFields', superseded.changed_fields,
          'sourceVersion', superseded.source_version,
          'status', superseded.status,
          'attempts', superseded.attempts,
          'requestedBy', superseded.requested_by,
          'previousErrorMessage', superseded.previous_error_message,
          'errorMessage', superseded.error_message,
          'errorHistory', superseded.error_history,
          'previousRunId', superseded.previous_run_id,
          'supersededByFullRunId', p_run_id,
          'completedAt', superseded.completed_at
        ) order by superseded.id
      ),
      '[]'::jsonb
    )
  into superseded_count_value, superseded_rows_value
  from superseded;

  result_value := jsonb_build_object(
    'certified', true,
    'idempotent', false,
    'reason', 'Source-fenced full Exchange certification superseded all terminal queue rows.',
    'certifiedAt', certified_at_value,
    'sourceFingerprint', p_source_fingerprint,
    'queueFence', jsonb_build_object(
      'expectedSequence', p_queue_high_water_sequence,
      'expectedUpdatedAt', p_queue_high_water_updated_at,
      'currentSequence', current_high_water_sequence,
      'currentUpdatedAt', current_high_water_updated_at
    ),
    'supersededCount', superseded_count_value,
    'supersededRows', superseded_rows_value
  );

  insert into public.outlook_exchange_sync_certifications (
    run_id,
    sync_mode,
    queue_high_water_sequence,
    queue_high_water_updated_at,
    source_fingerprint,
    certified_at,
    result
  ) values (
    p_run_id,
    'full',
    p_queue_high_water_sequence,
    p_queue_high_water_updated_at,
    p_source_fingerprint,
    certified_at_value,
    result_value
  );

  return result_value;
end;
$$;

alter table public.outlook_exchange_sync_queue enable row level security;
drop policy if exists "outlook_exchange_sync_queue_read" on public.outlook_exchange_sync_queue;
revoke select, insert, update, delete on public.outlook_exchange_sync_queue from anon, authenticated;
alter table public.outlook_exchange_sync_certifications enable row level security;
revoke all on public.outlook_exchange_sync_certifications from public, anon, authenticated;

revoke all on function public.outlook_exchange_queue_source_change()
  from public, anon, authenticated;
revoke all on function public.claim_outlook_exchange_sync_queue(uuid, integer)
  from public, anon, authenticated;
revoke all on function public.complete_verified_outlook_exchange_sync_queue_row(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.certify_full_outlook_exchange_sync_queue(uuid, bigint, timestamptz, text)
  from public, anon, authenticated;
grant execute on function public.claim_outlook_exchange_sync_queue(uuid, integer)
  to service_role;
grant execute on function public.complete_verified_outlook_exchange_sync_queue_row(uuid, uuid)
  to service_role;
grant execute on function public.certify_full_outlook_exchange_sync_queue(uuid, bigint, timestamptz, text)
  to service_role;
