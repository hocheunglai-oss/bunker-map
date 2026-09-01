create or replace function public.revoke_fcuno_session_and_linked_spc_sessions(
  p_token_hash text
)
returns boolean
language plpgsql
security invoker
set search_path = pg_catalog, public, pg_temp
as $$
declare
  linked_admin_user_id uuid;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    return false;
  end if;

  update public.admin_sessions as sessions
  set revoked_at = greatest(clock_timestamp(), sessions.created_at)
  where sessions.token_hash = p_token_hash
    and sessions.revoked_at is null
    and sessions.expires_at > clock_timestamp()
  returning sessions.admin_user_id into linked_admin_user_id;

  if linked_admin_user_id is null then
    return false;
  end if;

  update public.spc_sessions as sessions
  set revoked_at = greatest(clock_timestamp(), sessions.created_at)
  from public.spc_identity_links as links
  where links.admin_user_id = linked_admin_user_id
    and sessions.spc_user_id = links.spc_user_id
    and sessions.revoked_at is null;

  return true;
end;
$$;

revoke all on function public.revoke_fcuno_session_and_linked_spc_sessions(text)
from public, anon, authenticated, service_role;
grant execute on function public.revoke_fcuno_session_and_linked_spc_sessions(text)
to service_role;

comment on function public.revoke_fcuno_session_and_linked_spc_sessions(text) is
  'Atomically revokes the current FCUNO admin session and every SPC session for its linked SPC identity.';

create or replace function public.create_fcuno_linked_spc_session(
  p_admin_session_id uuid,
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
  current_time_value constant timestamptz := pg_catalog.clock_timestamp();
  locked_admin_user_id uuid;
  locked_spc_user_id uuid;
  session_id_value uuid;
  expires_at_value timestamptz;
begin
  if p_admin_session_id is null
    or p_spc_user_id is null
    or p_observed_user_updated_at is null
    or p_token_hash is null
    or p_token_hash !~ '^[0-9a-f]{64}$'
  then
    raise exception 'Valid FCUNO-linked SPC session parameters are required.';
  end if;

  select sessions.admin_user_id
  into locked_admin_user_id
  from public.admin_sessions as sessions
  join public.admin_users as users
    on users.id = sessions.admin_user_id
  join public.spc_identity_links as links
    on links.admin_user_id = users.id
   and links.spc_user_id = p_spc_user_id
  where sessions.id = p_admin_session_id
    and sessions.revoked_at is null
    and sessions.expires_at > current_time_value
    and users.is_active = true
    and users.use_spc = true
    and users.email_verified = true
  for update of sessions;

  if not found then
    raise exception 'The FCUNO session is no longer authorized for SPC.';
  end if;

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
  into locked_spc_user_id
  from public.spc_users as users
  where users.id = p_spc_user_id
    and users.is_active = true
    and users.updated_at = p_observed_user_updated_at
  for update;

  if not found then
    raise exception 'The SPC account changed before linked session creation.';
  end if;

  expires_at_value := current_time_value + interval '400 days';

  insert into public.spc_sessions (
    spc_user_id,
    token_hash,
    user_updated_at,
    created_at,
    expires_at
  ) values (
    locked_spc_user_id,
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

revoke all on function public.create_fcuno_linked_spc_session(
  uuid, uuid, timestamptz, text
) from public, anon, authenticated, service_role;
grant execute on function public.create_fcuno_linked_spc_session(
  uuid, uuid, timestamptz, text
) to service_role;

comment on function public.create_fcuno_linked_spc_session(
  uuid, uuid, timestamptz, text
) is
  'Creates an SPC session only while the originating FCUNO session remains active and linked, serialized against FCUNO logout.';
