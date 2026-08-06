-- Replace forgeable SPC marker/username cookies with revocable, version-bound
-- server-side sessions. Keep SPC identity and permission stores server-only.

create extension if not exists "pgcrypto";

create table public.spc_sessions (
  id uuid primary key default gen_random_uuid(),
  spc_user_id uuid not null
    references public.spc_users(id) on delete cascade,
  token_hash text not null unique,
  user_updated_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  constraint spc_sessions_token_hash_format
    check (token_hash ~ '^[0-9a-f]{64}$'),
  constraint spc_sessions_expiry
    check (expires_at > created_at)
);

create index spc_sessions_active_user_idx
  on public.spc_sessions(spc_user_id, expires_at)
  where revoked_at is null;

alter table public.spc_sessions enable row level security;

create policy "spc_sessions_no_public_access"
  on public.spc_sessions
  for all
  using (false)
  with check (false);

revoke all privileges on table public.spc_sessions
  from public, anon, authenticated, service_role;
grant select, update, delete on table public.spc_sessions
  to service_role;

create or replace function public.create_spc_session(
  p_spc_user_id uuid,
  p_observed_user_updated_at timestamptz,
  p_token_hash text
)
returns table (
  id uuid,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  current_time_value constant timestamptz := clock_timestamp();
  locked_user_id uuid;
  session_id_value uuid;
  expires_at_value timestamptz;
begin
  if p_spc_user_id is null
    or p_observed_user_updated_at is null
    or p_token_hash is null
    or p_token_hash !~ '^[0-9a-f]{64}$'
  then
    raise exception 'Valid version-bound SPC session parameters are required.';
  end if;

  -- Opportunistically keep the session ledger bounded without making sign-in
  -- responsible for an unbounded maintenance transaction.
  delete from public.spc_sessions as expired_sessions
  where expired_sessions.id in (
    select sessions.id
    from public.spc_sessions as sessions
    where sessions.expires_at < current_time_value - interval '30 days'
      or sessions.revoked_at < current_time_value - interval '30 days'
    order by sessions.expires_at
    limit 1000
  );

  select users.id
  into locked_user_id
  from public.spc_users as users
  where users.id = p_spc_user_id
    and users.is_active
    and users.updated_at = p_observed_user_updated_at
  for update;

  if not found then
    raise exception
      'SPC credentials changed before session creation. Sign in again.';
  end if;

  expires_at_value := current_time_value + interval '12 hours';

  insert into public.spc_sessions (
    spc_user_id,
    token_hash,
    user_updated_at,
    created_at,
    expires_at
  ) values (
    locked_user_id,
    p_token_hash,
    p_observed_user_updated_at,
    current_time_value,
    expires_at_value
  )
  returning spc_sessions.id into session_id_value;

  return query
  select session_id_value, expires_at_value;
end;
$$;

revoke all on function public.create_spc_session(uuid, timestamptz, text)
  from public, anon, authenticated, service_role;
grant execute on function public.create_spc_session(uuid, timestamptz, text)
  to service_role;

alter table public.spc_users enable row level security;
drop policy if exists "spc_users_no_public_access" on public.spc_users;
create policy "spc_users_no_public_access"
  on public.spc_users
  for all
  using (false)
  with check (false);
revoke all privileges on table public.spc_users
  from public, anon, authenticated;
grant select, insert, update, delete on table public.spc_users
  to service_role;

alter table public.office_calendar_store enable row level security;
drop policy if exists "office_calendar_store_read"
  on public.office_calendar_store;
drop policy if exists "office_calendar_store_write"
  on public.office_calendar_store;
revoke all privileges on table public.office_calendar_store
  from public, anon, authenticated;
grant select, insert, update, delete on table public.office_calendar_store
  to service_role;
