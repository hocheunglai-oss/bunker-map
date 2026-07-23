create extension if not exists "pgcrypto";

create table if not exists public.admin_users (
  id uuid primary key default gen_random_uuid(),
  username text not null,
  display_name text,
  role text not null default 'AC',
  password_hash text not null,
  is_active boolean not null default true,
  password_reset_required boolean not null default true,
  permissions jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.admin_role_defaults (
  role text primary key,
  permissions jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.admin_users
drop constraint if exists admin_users_role_check;

alter table public.admin_users
alter column role set default 'AC';

update public.admin_users
set role = normalised.role
from (
  select id,
    case
      when upper(role) = 'ADMIN' then 'ADMIN'
      when upper(role) = 'BT' then 'BT'
      when upper(role) = 'VN' then 'VN'
      else 'AC'
    end as role
  from public.admin_users
) as normalised
where public.admin_users.id = normalised.id
  and public.admin_users.role is distinct from normalised.role;

alter table public.admin_users
add column if not exists is_active boolean not null default true;

alter table public.admin_users
add column if not exists password_reset_required boolean not null default true;

create unique index if not exists admin_users_username_lower_key
on public.admin_users(lower(username));

create index if not exists admin_users_active_idx
on public.admin_users(is_active)
where is_active;

create table if not exists public.admin_sessions (
  id uuid primary key default gen_random_uuid(),
  admin_user_id uuid not null
    references public.admin_users(id) on delete cascade,
  token_hash text not null,
  created_at timestamptz not null default clock_timestamp(),
  last_seen_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  constraint admin_sessions_token_hash_format
    check (token_hash ~ '^[0-9a-f]{64}$'),
  constraint admin_sessions_expiry
    check (expires_at > created_at),
  constraint admin_sessions_last_seen
    check (last_seen_at >= created_at),
  constraint admin_sessions_revocation
    check (revoked_at is null or revoked_at >= created_at)
);

create unique index if not exists admin_sessions_token_hash_idx
on public.admin_sessions(token_hash);

create index if not exists admin_sessions_user_active_idx
on public.admin_sessions(admin_user_id, expires_at)
where revoked_at is null;

create index if not exists admin_sessions_expiry_idx
on public.admin_sessions(expires_at);

insert into public.admin_role_defaults(role, permissions)
values
  ('ADMIN', '{}'::jsonb),
  ('AC', '{}'::jsonb),
  ('BT', '{}'::jsonb),
  ('VN', '{}'::jsonb)
on conflict (role) do nothing;

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

drop trigger if exists set_admin_role_defaults_updated_at on public.admin_role_defaults;
create trigger set_admin_role_defaults_updated_at
before update on public.admin_role_defaults
for each row
execute function public.set_admin_users_updated_at();

alter table public.admin_users enable row level security;
alter table public.admin_role_defaults enable row level security;
alter table public.admin_sessions enable row level security;

drop policy if exists "admin_users_no_public_access" on public.admin_users;
create policy "admin_users_no_public_access"
  on public.admin_users
  for all
  using (false)
  with check (false);

drop policy if exists "admin_role_defaults_no_public_access" on public.admin_role_defaults;
create policy "admin_role_defaults_no_public_access"
  on public.admin_role_defaults
  for all
  using (false)
  with check (false);

drop policy if exists "admin_sessions_no_public_access"
  on public.admin_sessions;
create policy "admin_sessions_no_public_access"
  on public.admin_sessions
  for all
  using (false)
  with check (false);

revoke all privileges on table public.admin_sessions
from public, anon, authenticated, service_role;
grant select, update, delete on table public.admin_sessions
to service_role;

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

do $$
begin
  if to_regprocedure('public.audit_enable_table(regclass)') is not null then
    perform public.audit_enable_table('public.admin_users'::regclass);
    perform public.audit_enable_table('public.admin_role_defaults'::regclass);
  end if;
end $$;
