-- Make password verification and session creation one version-bound operation,
-- and make managed password changes atomic with session revocation.

create or replace function public.set_admin_users_updated_at()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  new.updated_at := greatest(
    clock_timestamp(),
    old.updated_at + interval '1 microsecond'
  );
  return new;
end;
$$;

drop trigger if exists set_admin_users_updated_at on public.admin_users;
create trigger set_admin_users_updated_at
before update on public.admin_users
for each row
execute function public.set_admin_users_updated_at();

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
    or p_duration_seconds > 43200
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

revoke insert on table public.admin_sessions from service_role;

create or replace function public.update_admin_user_with_password_and_revoke_sessions(
  p_admin_user_id uuid,
  p_username text,
  p_display_name text,
  p_role text,
  p_permissions jsonb,
  p_new_password_hash text
)
returns setof public.admin_users
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
  changed_at_value constant timestamptz := clock_timestamp();
  updated_user public.admin_users%rowtype;
begin
  if p_admin_user_id is null
    or nullif(btrim(p_username), '') is null
    or nullif(btrim(p_display_name), '') is null
    or nullif(btrim(p_role), '') is null
    or p_permissions is null
    or p_new_password_hash is null
    or p_new_password_hash !~ '^scrypt:[0-9a-f]{32}:[0-9a-f]{128}$'
  then
    raise exception 'A valid admin user and scrypt password hash are required.';
  end if;

  select users.*
  into updated_user
  from public.admin_users as users
  where users.id = p_admin_user_id
  for update;

  if not found then
    raise exception 'Admin user was not found.';
  end if;

  update public.admin_users as users
  set
    username = p_username,
    display_name = p_display_name,
    role = p_role,
    permissions = p_permissions,
    password_hash = p_new_password_hash,
    password_reset_required = true
  where users.id = p_admin_user_id
  returning users.*
  into updated_user;

  update public.admin_sessions as sessions
  set revoked_at = greatest(changed_at_value, sessions.created_at)
  where sessions.admin_user_id = p_admin_user_id
    and sessions.revoked_at is null;

  return next updated_user;
end;
$$;

revoke all on function public.update_admin_user_with_password_and_revoke_sessions(
  uuid,
  text,
  text,
  text,
  jsonb,
  text
) from public, anon, authenticated, service_role;
grant execute on function public.update_admin_user_with_password_and_revoke_sessions(
  uuid,
  text,
  text,
  text,
  jsonb,
  text
) to service_role;

create or replace function public.complete_admin_password_reset(
  p_session_id uuid,
  p_new_password_hash text
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  user_id_value uuid;
  username_value text;
  display_name_value text;
  changed_at_value constant timestamptz := clock_timestamp();
begin
  if p_session_id is null
    or p_new_password_hash is null
    or p_new_password_hash !~ '^scrypt:[0-9a-f]{32}:[0-9a-f]{128}$'
  then
    raise exception 'A valid session and scrypt password hash are required.';
  end if;

  select
    users.id,
    users.username,
    coalesce(users.display_name, users.username)
  into
    user_id_value,
    username_value,
    display_name_value
  from public.admin_sessions as sessions
  join public.admin_users as users
    on users.id = sessions.admin_user_id
  where sessions.id = p_session_id
    and sessions.revoked_at is null
    and sessions.expires_at > changed_at_value
    and users.is_active
    and users.password_reset_required
  for update of sessions, users;

  if not found then
    raise exception
      'The password-reset session is invalid, expired, or already completed.';
  end if;

  perform set_config('app.audit_actor_id', username_value, true);
  perform set_config('app.audit_actor_name', display_name_value, true);
  perform set_config(
    'app.audit_context',
    jsonb_build_object(
      'action', 'password-reset',
      'pageId', 'admin-password-reset'
    )::text,
    true
  );

  update public.admin_users as users
  set
    password_hash = p_new_password_hash,
    password_reset_required = false,
    updated_at = greatest(
      changed_at_value,
      users.updated_at + interval '1 microsecond'
    )
  where users.id = user_id_value;

  update public.admin_sessions as sessions
  set revoked_at = greatest(changed_at_value, sessions.created_at)
  where sessions.admin_user_id = user_id_value
    and sessions.id <> p_session_id
    and sessions.revoked_at is null;

  return true;
end;
$$;

revoke all on function public.complete_admin_password_reset(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.complete_admin_password_reset(uuid, text)
  to service_role;
