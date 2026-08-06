-- Bound post-threshold monitoring writes by coalescing repeated blocks, and
-- prevent infrastructure failures from consuming credential-failure budget.

alter table private.spc_login_attempts
  add column if not exists blocked_count bigint not null default 0,
  add column if not exists last_blocked_at timestamptz;

update private.spc_login_attempts
set
  blocked_count = 1,
  last_blocked_at = coalesce(completed_at, started_at)
where outcome = 'blocked'
  and (blocked_count = 0 or last_blocked_at is null);

alter table private.spc_login_attempts
  drop constraint if exists spc_login_attempts_outcome,
  drop constraint if exists spc_login_attempts_failure_reason,
  drop constraint if exists spc_login_attempts_block_state;

update private.spc_login_attempts
set outcome = 'system_error'
where outcome = 'failed'
  and failure_reason = 'stale_pending';

alter table private.spc_login_attempts
  add constraint spc_login_attempts_outcome
    check (outcome in ('pending', 'succeeded', 'failed', 'blocked', 'system_error')),
  add constraint spc_login_attempts_failure_reason
    check (
      (
        outcome = 'failed'
        and failure_reason is not null
        and failure_reason = 'credentials_rejected'
      )
      or (
        outcome = 'system_error'
        and failure_reason is not null
        and failure_reason in (
          'authentication_unavailable',
          'attempt_monitoring_unavailable',
          'session_unavailable',
          'stale_pending'
        )
      )
      or (
        outcome not in ('failed', 'system_error')
        and failure_reason is null
      )
    ),
  add constraint spc_login_attempts_block_state
    check (
      (
        outcome = 'blocked'
        and blocked_by is not null
        and blocked_by in ('username', 'source_ip', 'username_and_source_ip')
        and retry_after_seconds between 1 and 900
        and blocked_count >= 1
        and last_blocked_at is not null
        and last_blocked_at >= started_at
      )
      or (
        outcome <> 'blocked'
        and blocked_by is null
        and retry_after_seconds = 0
        and blocked_count = 0
        and last_blocked_at is null
      )
    );

create index if not exists spc_login_attempts_blocked_username_idx
  on private.spc_login_attempts(blocked_by, username_hash, last_blocked_at desc)
  where outcome = 'blocked';
create index if not exists spc_login_attempts_blocked_source_ip_idx
  on private.spc_login_attempts(blocked_by, source_ip, last_blocked_at desc)
  where outcome = 'blocked';

create or replace function public.cleanup_spc_login_attempts()
returns integer
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  deleted_count integer;
begin
  delete from private.spc_login_attempts as attempts
  where attempts.id in (
    select expired.id
    from private.spc_login_attempts as expired
    where (
      case
        when expired.outcome = 'blocked'
          then coalesce(expired.last_blocked_at, expired.started_at)
        else expired.started_at
      end
    ) < clock_timestamp() - interval '30 days'
    order by (
      case
        when expired.outcome = 'blocked'
          then coalesce(expired.last_blocked_at, expired.started_at)
        else expired.started_at
      end
    )
    limit 10000
  );

  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

revoke all on function public.cleanup_spc_login_attempts()
  from public, anon, authenticated, service_role;
grant execute on function public.cleanup_spc_login_attempts()
  to service_role;

comment on function public.cleanup_spc_login_attempts() is
  'Deletes one bounded batch of SPC login-attempt evidence older than 30 days.';

-- The additional OUT column changes the function return type, so PostgreSQL
-- requires a drop/recreate rather than CREATE OR REPLACE.
drop function public.begin_spc_login_attempt(text, inet, uuid);

create function public.begin_spc_login_attempt(
  p_username_hash text,
  p_source_ip inet,
  p_request_id uuid
)
returns table (
  attempt_id uuid,
  allowed boolean,
  retry_after_seconds integer,
  blocked_by text,
  blocked_count text
)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  now_value timestamptz;
  window_value constant interval := interval '15 minutes';
  pending_timeout_value constant interval := interval '2 minutes';
  retention_value constant interval := interval '30 days';
  username_limit_value constant integer := 5;
  source_ip_limit_value constant integer := 20;
  username_lock_key bigint;
  source_ip_lock_key bigint;
  username_pressure integer;
  source_ip_pressure integer;
  username_oldest timestamptz;
  source_ip_oldest timestamptz;
  username_blocked boolean;
  source_ip_blocked boolean;
  blocked_by_value text;
  retry_after_value integer;
  blocked_attempt_id uuid;
  blocked_count_value bigint;
begin
  if p_username_hash is null
    or p_username_hash !~ '^[0-9a-f]{64}$'
    or p_source_ip is null
    or p_request_id is null
  then
    raise exception 'A hashed username, trusted source IP, and request ID are required.';
  end if;

  username_lock_key := hashtextextended(
    'spc-login-username:' || p_username_hash,
    0
  );
  source_ip_lock_key := hashtextextended(
    'spc-login-source-ip:' || p_source_ip::text,
    0
  );

  perform pg_advisory_xact_lock(
    least(username_lock_key, source_ip_lock_key)
  );
  if username_lock_key <> source_ip_lock_key then
    perform pg_advisory_xact_lock(
      greatest(username_lock_key, source_ip_lock_key)
    );
  end if;

  now_value := clock_timestamp();

  -- Abandoned requests represent infrastructure interruption, not rejected
  -- credentials, so they must never consume the credential-failure budget.
  update private.spc_login_attempts as attempts
  set
    outcome = 'system_error',
    failure_reason = 'stale_pending',
    completed_at = now_value
  where attempts.outcome = 'pending'
    and attempts.started_at <= now_value - pending_timeout_value
    and (
      attempts.username_hash = p_username_hash
      or attempts.source_ip = p_source_ip
    );

  -- Keep opportunistic cleanup as defense in depth. The dedicated service
  -- RPC can be called by a scheduler until it returns fewer than 10,000 rows.
  delete from private.spc_login_attempts as attempts
  where attempts.id in (
    select retained.id
    from private.spc_login_attempts as retained
    where (
      case
        when retained.outcome = 'blocked'
          then coalesce(retained.last_blocked_at, retained.started_at)
        else retained.started_at
      end
    ) < now_value - retention_value
    order by (
      case
        when retained.outcome = 'blocked'
          then coalesce(retained.last_blocked_at, retained.started_at)
        else retained.started_at
      end
    )
    limit 1000
  );

  select
    count(*)::integer,
    min(attempts.started_at)
  into username_pressure, username_oldest
  from private.spc_login_attempts as attempts
  where attempts.username_hash = p_username_hash
    and attempts.started_at > now_value - window_value
    and attempts.outcome in ('pending', 'failed');

  select
    count(*)::integer,
    min(attempts.started_at)
  into source_ip_pressure, source_ip_oldest
  from private.spc_login_attempts as attempts
  where attempts.source_ip = p_source_ip
    and attempts.started_at > now_value - window_value
    and attempts.outcome in ('pending', 'failed');

  username_blocked := username_pressure >= username_limit_value;
  source_ip_blocked := source_ip_pressure >= source_ip_limit_value;

  if username_blocked or source_ip_blocked then
    blocked_by_value := case
      when username_blocked and source_ip_blocked then 'username_and_source_ip'
      when username_blocked then 'username'
      else 'source_ip'
    end;

    retry_after_value := greatest(
      case
        when username_blocked then greatest(
          1,
          ceil(extract(epoch from (
            username_oldest + window_value - now_value
          )))::integer
        )
        else 0
      end,
      case
        when source_ip_blocked then greatest(
          1,
          ceil(extract(epoch from (
            source_ip_oldest + window_value - now_value
          )))::integer
        )
        else 0
      end
    );

    select attempts.id
    into blocked_attempt_id
    from private.spc_login_attempts as attempts
    where attempts.outcome = 'blocked'
      and attempts.blocked_by = blocked_by_value
      and attempts.last_blocked_at > now_value - window_value
      and (
        (
          blocked_by_value = 'username'
          and attempts.username_hash = p_username_hash
        )
        or (
          blocked_by_value = 'source_ip'
          and attempts.source_ip = p_source_ip
        )
        or (
          blocked_by_value = 'username_and_source_ip'
          and attempts.username_hash = p_username_hash
          and attempts.source_ip = p_source_ip
        )
      )
    order by attempts.last_blocked_at desc
    limit 1
    for update;

    if found then
      update private.spc_login_attempts as attempts
      set
        username_hash = p_username_hash,
        source_ip = p_source_ip,
        request_id = p_request_id,
        completed_at = now_value,
        retry_after_seconds = retry_after_value,
        blocked_count = attempts.blocked_count + 1,
        last_blocked_at = now_value
      where attempts.id = blocked_attempt_id
      returning attempts.id, attempts.blocked_count
      into attempt_id, blocked_count_value;
    else
      insert into private.spc_login_attempts as attempts (
        username_hash,
        source_ip,
        request_id,
        started_at,
        completed_at,
        outcome,
        blocked_by,
        retry_after_seconds,
        blocked_count,
        last_blocked_at
      )
      values (
        p_username_hash,
        p_source_ip,
        p_request_id,
        now_value,
        now_value,
        'blocked',
        blocked_by_value,
        retry_after_value,
        1,
        now_value
      )
      returning attempts.id, attempts.blocked_count
      into attempt_id, blocked_count_value;
    end if;

    allowed := false;
    retry_after_seconds := retry_after_value;
    blocked_by := blocked_by_value;
    blocked_count := blocked_count_value::text;
    return next;
    return;
  end if;

  insert into private.spc_login_attempts (
    username_hash,
    source_ip,
    request_id,
    started_at,
    outcome
  )
  values (
    p_username_hash,
    p_source_ip,
    p_request_id,
    now_value,
    'pending'
  )
  returning id into attempt_id;

  allowed := true;
  retry_after_seconds := 0;
  blocked_by := null;
  blocked_count := '0';
  return next;
end;
$$;

create or replace function public.complete_spc_login_attempt(
  p_attempt_id uuid,
  p_succeeded boolean
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  now_value timestamptz;
  pending_timeout_value constant interval := interval '2 minutes';
  username_hash_value text;
  source_ip_value inet;
  started_at_value timestamptz;
  username_lock_key bigint;
  source_ip_lock_key bigint;
  completed_value boolean;
begin
  if p_attempt_id is null or p_succeeded is null then
    raise exception 'An attempt ID and completion result are required.';
  end if;

  select
    attempts.username_hash,
    attempts.source_ip,
    attempts.started_at
  into
    username_hash_value,
    source_ip_value,
    started_at_value
  from private.spc_login_attempts as attempts
  where attempts.id = p_attempt_id;

  if not found then
    return false;
  end if;

  username_lock_key := hashtextextended(
    'spc-login-username:' || username_hash_value,
    0
  );
  source_ip_lock_key := hashtextextended(
    'spc-login-source-ip:' || source_ip_value::text,
    0
  );

  perform pg_advisory_xact_lock(
    least(username_lock_key, source_ip_lock_key)
  );
  if username_lock_key <> source_ip_lock_key then
    perform pg_advisory_xact_lock(
      greatest(username_lock_key, source_ip_lock_key)
    );
  end if;

  now_value := clock_timestamp();

  if started_at_value <= now_value - pending_timeout_value then
    update private.spc_login_attempts as attempts
    set
      outcome = 'system_error',
      failure_reason = 'stale_pending',
      completed_at = now_value
    where attempts.id = p_attempt_id
      and attempts.outcome = 'pending';

    return false;
  end if;

  update private.spc_login_attempts as attempts
  set
    outcome = case when p_succeeded then 'succeeded' else 'failed' end,
    failure_reason = case
      when p_succeeded then null
      else 'credentials_rejected'
    end,
    completed_at = now_value
  where attempts.id = p_attempt_id
    and attempts.outcome = 'pending'
  returning true into completed_value;

  return coalesce(completed_value, false);
end;
$$;

create or replace function public.cancel_spc_login_attempt(
  p_attempt_id uuid,
  p_reason text
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  username_hash_value text;
  source_ip_value inet;
  username_lock_key bigint;
  source_ip_lock_key bigint;
  cancelled_value boolean;
begin
  if p_attempt_id is null
    or p_reason is null
    or p_reason not in (
      'authentication_unavailable',
      'attempt_monitoring_unavailable',
      'session_unavailable'
    )
  then
    raise exception 'A pending attempt and supported system-error reason are required.';
  end if;

  select attempts.username_hash, attempts.source_ip
  into username_hash_value, source_ip_value
  from private.spc_login_attempts as attempts
  where attempts.id = p_attempt_id;

  if not found then
    return false;
  end if;

  username_lock_key := hashtextextended(
    'spc-login-username:' || username_hash_value,
    0
  );
  source_ip_lock_key := hashtextextended(
    'spc-login-source-ip:' || source_ip_value::text,
    0
  );

  perform pg_advisory_xact_lock(
    least(username_lock_key, source_ip_lock_key)
  );
  if username_lock_key <> source_ip_lock_key then
    perform pg_advisory_xact_lock(
      greatest(username_lock_key, source_ip_lock_key)
    );
  end if;

  update private.spc_login_attempts as attempts
  set
    outcome = 'system_error',
    failure_reason = p_reason,
    completed_at = clock_timestamp()
  where attempts.id = p_attempt_id
    and attempts.outcome = 'pending'
  returning true into cancelled_value;

  return coalesce(cancelled_value, false);
end;
$$;

revoke all on function public.begin_spc_login_attempt(text, inet, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.begin_spc_login_attempt(text, inet, uuid)
  to service_role;

revoke all on function public.complete_spc_login_attempt(uuid, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.complete_spc_login_attempt(uuid, boolean)
  to service_role;

revoke all on function public.cancel_spc_login_attempt(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.cancel_spc_login_attempt(uuid, text)
  to service_role;

comment on function public.begin_spc_login_attempt(text, inet, uuid) is
  'Atomically reserves an SPC login attempt or coalesces repeated rate-limit evidence.';
comment on function public.complete_spc_login_attempt(uuid, boolean) is
  'Finalizes a pending SPC login attempt as succeeded or rejected credentials.';
comment on function public.cancel_spc_login_attempt(uuid, text) is
  'Finalizes a pending SPC login attempt as a non-counting infrastructure error.';
