create table if not exists private.spc_login_discovery_attempts (
  id uuid primary key default gen_random_uuid(),
  username_hash text not null
    check (username_hash ~ '^[0-9a-f]{64}$'),
  source_ip inet not null,
  request_id uuid not null unique,
  allowed boolean not null,
  blocked_by text
    check (blocked_by in ('username', 'source_ip', 'username_and_source_ip')),
  created_at timestamptz not null default clock_timestamp(),
  check ((allowed and blocked_by is null) or (not allowed and blocked_by is not null))
);

alter table private.spc_login_discovery_attempts enable row level security;

create index if not exists spc_login_discovery_username_idx
  on private.spc_login_discovery_attempts(username_hash, created_at desc);
create index if not exists spc_login_discovery_source_ip_idx
  on private.spc_login_discovery_attempts(source_ip, created_at desc);

revoke all on table private.spc_login_discovery_attempts
  from public, anon, authenticated, service_role;

create or replace function public.begin_spc_login_discovery(
  p_username_hash text,
  p_source_ip inet,
  p_request_id uuid
)
returns table (
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
  now_value timestamptz := clock_timestamp();
  window_value constant interval := interval '15 minutes';
  username_limit_value constant integer := 20;
  source_ip_limit_value constant integer := 100;
  username_lock_key bigint;
  source_ip_lock_key bigint;
  username_count integer;
  source_ip_count integer;
  username_oldest timestamptz;
  source_ip_oldest timestamptz;
  blocked_by_value text;
  retry_after_value integer := 0;
begin
  if p_username_hash is null
    or p_username_hash !~ '^[0-9a-f]{64}$'
    or p_source_ip is null
    or p_request_id is null
  then
    raise exception 'A hashed username, trusted source IP, and request ID are required.';
  end if;

  username_lock_key := hashtextextended(
    'spc-login-discovery-username:' || p_username_hash,
    0
  );
  source_ip_lock_key := hashtextextended(
    'spc-login-discovery-source-ip:' || p_source_ip::text,
    0
  );
  perform pg_advisory_xact_lock(least(username_lock_key, source_ip_lock_key));
  if username_lock_key <> source_ip_lock_key then
    perform pg_advisory_xact_lock(greatest(username_lock_key, source_ip_lock_key));
  end if;

  delete from private.spc_login_discovery_attempts as attempts
  where attempts.id in (
    select expired.id
    from private.spc_login_discovery_attempts as expired
    where expired.created_at < now_value - interval '30 days'
    order by expired.created_at
    limit 1000
  );

  select count(*)::integer, min(attempts.created_at)
  into username_count, username_oldest
  from private.spc_login_discovery_attempts as attempts
  where attempts.username_hash = p_username_hash
    and attempts.created_at > now_value - window_value;

  select count(*)::integer, min(attempts.created_at)
  into source_ip_count, source_ip_oldest
  from private.spc_login_discovery_attempts as attempts
  where attempts.source_ip = p_source_ip
    and attempts.created_at > now_value - window_value;

  blocked_by_value := case
    when username_count >= username_limit_value
      and source_ip_count >= source_ip_limit_value
      then 'username_and_source_ip'
    when username_count >= username_limit_value then 'username'
    when source_ip_count >= source_ip_limit_value then 'source_ip'
    else null
  end;

  if blocked_by_value is not null then
    retry_after_value := greatest(
      1,
      case
        when blocked_by_value in ('username', 'username_and_source_ip')
          then ceil(extract(epoch from (username_oldest + window_value - now_value)))::integer
        else 1
      end,
      case
        when blocked_by_value in ('source_ip', 'username_and_source_ip')
          then ceil(extract(epoch from (source_ip_oldest + window_value - now_value)))::integer
        else 1
      end
    );
  end if;

  insert into private.spc_login_discovery_attempts (
    username_hash,
    source_ip,
    request_id,
    allowed,
    blocked_by,
    created_at
  ) values (
    p_username_hash,
    p_source_ip,
    p_request_id,
    blocked_by_value is null,
    blocked_by_value,
    now_value
  );

  return query select
    blocked_by_value is null,
    retry_after_value,
    blocked_by_value,
    (greatest(username_count, source_ip_count) + 1)::text;
end;
$$;

revoke all on function public.begin_spc_login_discovery(text, inet, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.begin_spc_login_discovery(text, inet, uuid)
  to service_role;

comment on table private.spc_login_discovery_attempts is
  'Durable, hashed evidence used only to rate-limit username-first SPC sign-in routing.';
comment on function public.begin_spc_login_discovery(text, inet, uuid) is
  'Atomically rate-limits SPC identity-method discovery by username hash and trusted source IP.';
