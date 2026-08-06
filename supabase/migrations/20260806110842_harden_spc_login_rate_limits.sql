-- Persist login-attempt pressure outside individual Vercel instances so
-- distributed or concurrent requests cannot bypass the SPC login limits.

create schema if not exists private;

revoke all on schema private from public, anon, authenticated;
grant usage on schema private to service_role;

create table private.spc_login_attempts (
  id uuid primary key default gen_random_uuid(),
  username_hash text not null,
  source_ip inet not null,
  request_id uuid not null,
  started_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  outcome text not null default 'pending',
  failure_reason text,
  blocked_by text,
  retry_after_seconds integer not null default 0,
  constraint spc_login_attempts_username_hash_format
    check (username_hash ~ '^[0-9a-f]{64}$'),
  constraint spc_login_attempts_outcome
    check (outcome in ('pending', 'succeeded', 'failed', 'blocked')),
  constraint spc_login_attempts_lifecycle
    check (
      (outcome = 'pending' and completed_at is null)
      or (
        outcome <> 'pending'
        and completed_at is not null
        and completed_at >= started_at
      )
    ),
  constraint spc_login_attempts_failure_reason
    check (
      (
        outcome = 'failed'
        and failure_reason is not null
        and failure_reason in ('credentials_rejected', 'stale_pending')
      )
      or (outcome <> 'failed' and failure_reason is null)
    ),
  constraint spc_login_attempts_block_state
    check (
      (
        outcome = 'blocked'
        and blocked_by is not null
        and blocked_by in ('username', 'source_ip', 'username_and_source_ip')
        and retry_after_seconds > 0
        and retry_after_seconds <= 900
      )
      or (
        outcome <> 'blocked'
        and blocked_by is null
        and retry_after_seconds = 0
      )
    )
);

create unique index spc_login_attempts_request_id_idx
  on private.spc_login_attempts(request_id);

create index spc_login_attempts_username_pressure_idx
  on private.spc_login_attempts(username_hash, started_at)
  where outcome in ('pending', 'failed');

create index spc_login_attempts_source_ip_pressure_idx
  on private.spc_login_attempts(source_ip, started_at)
  where outcome in ('pending', 'failed');

create index spc_login_attempts_started_at_idx
  on private.spc_login_attempts(started_at);

create index spc_login_attempts_pending_started_at_idx
  on private.spc_login_attempts(started_at)
  where outcome = 'pending';

alter table private.spc_login_attempts enable row level security;

revoke all privileges on table private.spc_login_attempts
  from public, anon, authenticated, service_role;
grant select, insert, update, delete on table private.spc_login_attempts
  to service_role;

comment on table private.spc_login_attempts is
  'Service-role-only SPC login rate-limit and monitoring evidence. Usernames are stored only as SHA-256 hashes.';

create or replace function public.begin_spc_login_attempt(
  p_username_hash text,
  p_source_ip inet,
  p_request_id uuid
)
returns table (
  attempt_id uuid,
  allowed boolean,
  retry_after_seconds integer,
  blocked_by text
)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  now_value constant timestamptz := clock_timestamp();
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

  -- Acquire the two identity locks in numeric order so concurrent requests
  -- are serialized without creating a lock-order cycle.
  perform pg_advisory_xact_lock(
    least(username_lock_key, source_ip_lock_key)
  );
  if username_lock_key <> source_ip_lock_key then
    perform pg_advisory_xact_lock(
      greatest(username_lock_key, source_ip_lock_key)
    );
  end if;

  -- A crashed request must not reserve an in-flight slot forever. Treat a
  -- stale pending request as a failed attempt so it still contributes to the
  -- rolling protection and remains visible as monitoring evidence.
  update private.spc_login_attempts as attempts
  set
    outcome = 'failed',
    failure_reason = 'stale_pending',
    completed_at = now_value
  where attempts.outcome = 'pending'
    and attempts.started_at <= now_value - pending_timeout_value
    and (
      attempts.username_hash = p_username_hash
      or attempts.source_ip = p_source_ip
    );

  -- Retain sufficient evidence for investigation without keeping source IPs
  -- indefinitely. The index on started_at keeps this bounded cleanup cheap.
  delete from private.spc_login_attempts as attempts
  where attempts.id in (
    select retained.id
    from private.spc_login_attempts as retained
    where retained.started_at < now_value - retention_value
    order by retained.started_at
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

    insert into private.spc_login_attempts (
      username_hash,
      source_ip,
      request_id,
      started_at,
      completed_at,
      outcome,
      blocked_by,
      retry_after_seconds
    )
    values (
      p_username_hash,
      p_source_ip,
      p_request_id,
      now_value,
      now_value,
      'blocked',
      blocked_by_value,
      retry_after_value
    )
    returning id into attempt_id;

    allowed := false;
    retry_after_seconds := retry_after_value;
    blocked_by := blocked_by_value;
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
  now_value constant timestamptz := clock_timestamp();
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

  if started_at_value <= now_value - pending_timeout_value then
    update private.spc_login_attempts as attempts
    set
      outcome = 'failed',
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

revoke all on function public.begin_spc_login_attempt(text, inet, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.begin_spc_login_attempt(text, inet, uuid)
  to service_role;

revoke all on function public.complete_spc_login_attempt(uuid, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.complete_spc_login_attempt(uuid, boolean)
  to service_role;

comment on function public.begin_spc_login_attempt(text, inet, uuid) is
  'Atomically reserves an SPC login attempt or records a rate-limit block.';
comment on function public.complete_spc_login_attempt(uuid, boolean) is
  'Finalizes a pending SPC login attempt as succeeded or failed.';
