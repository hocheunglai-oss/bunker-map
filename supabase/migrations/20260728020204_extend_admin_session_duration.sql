create or replace function public.create_admin_session(
  p_admin_user_id uuid,
  p_observed_user_updated_at timestamptz,
  p_token_hash text,
  p_duration_seconds integer
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
  if p_admin_user_id is null
    or p_observed_user_updated_at is null
    or p_token_hash is null
    or p_token_hash !~ '^[0-9a-f]{64}$'
    or p_duration_seconds is null
    or p_duration_seconds < 60
    or p_duration_seconds > 34560000
  then
    raise exception 'Valid version-bound session parameters are required.';
  end if;

  select users.id
  into locked_user_id
  from public.admin_users as users
  where users.id = p_admin_user_id
    and users.is_active
    and users.updated_at = p_observed_user_updated_at
  for update;

  if not found then
    raise exception
      'Admin credentials changed before session creation. Sign in again.';
  end if;

  expires_at_value :=
    current_time_value + make_interval(secs => p_duration_seconds);

  insert into public.admin_sessions (
    admin_user_id,
    token_hash,
    created_at,
    last_seen_at,
    expires_at
  ) values (
    locked_user_id,
    p_token_hash,
    current_time_value,
    current_time_value,
    expires_at_value
  )
  returning admin_sessions.id
  into session_id_value;

  return query
  select session_id_value, expires_at_value;
end;
$$;

revoke all on function public.create_admin_session(uuid, timestamptz, text, integer)
from public, anon, authenticated, service_role;
grant execute on function public.create_admin_session(uuid, timestamptz, text, integer)
to service_role;

comment on function public.create_admin_session(uuid, timestamptz, text, integer) is
  'Creates a version-bound FCUNO admin session for up to the browser maximum persistent-cookie lifetime of 400 days.';
