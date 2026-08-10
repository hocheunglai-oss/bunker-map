-- Single-account WhatsApp login MFA pilot for otto@cosulich.com.hk.
-- Password validation remains in the application, but the password attempt,
-- pre-authentication bearer, OTP challenge, current phone enrollment, and
-- final assured SPC session are bound and consumed atomically in PostgreSQL.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to service_role;

alter table public.spc_sessions
  add column if not exists mfa_verified_at timestamptz;

alter table public.spc_sessions
  drop constraint if exists spc_sessions_mfa_verified_at;
alter table public.spc_sessions
  add constraint spc_sessions_mfa_verified_at
    check (
      mfa_verified_at is null
      or (
        mfa_verified_at <= created_at
        and mfa_verified_at >= created_at - interval '12 hours'
      )
    );

comment on column public.spc_sessions.mfa_verified_at is
  'Server-verified WhatsApp MFA assurance time. NULL means password-only.';

create table if not exists private.spc_whatsapp_login_mfa_enrollment (
  spc_user_id uuid primary key
    references public.spc_users(id) on delete cascade,
  whatsapp_phone_hash text not null,
  enabled boolean not null default true,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint spc_whatsapp_login_mfa_enrollment_phone_hash
    check (whatsapp_phone_hash ~ '^[0-9a-f]{64}$'),
  constraint spc_whatsapp_login_mfa_enrollment_timestamps
    check (updated_at >= created_at)
);

comment on table private.spc_whatsapp_login_mfa_enrollment is
  'Private stable-user enrollment and SHA-256 WhatsApp phone fingerprint for the Otto login MFA pilot.';

insert into private.spc_whatsapp_login_mfa_enrollment (
  spc_user_id,
  whatsapp_phone_hash,
  enabled
)
select
  users.id,
  pg_catalog.encode(
    extensions.digest(users.whatsapp_phone, 'sha256'),
    'hex'
  ),
  true
from public.spc_users as users
where pg_catalog.lower(users.username) = 'otto@cosulich.com.hk'
  and users.is_active = true
  and users.whatsapp_phone ~ '^[1-9][0-9]{7,14}$'
on conflict (spc_user_id) do nothing;

do $$
declare
  otto_count integer;
  eligible_count integer;
  enrolled_count integer;
begin
  select count(*)::integer
  into otto_count
  from public.spc_users as users
  where pg_catalog.lower(users.username) = 'otto@cosulich.com.hk';

  if otto_count = 0 then
    return;
  end if;

  select count(*)::integer
  into eligible_count
  from public.spc_users as users
  where pg_catalog.lower(users.username) = 'otto@cosulich.com.hk'
    and users.is_active = true
    and users.whatsapp_phone ~ '^[1-9][0-9]{7,14}$';

  select count(*)::integer
  into enrolled_count
  from private.spc_whatsapp_login_mfa_enrollment as enrollment
  join public.spc_users as users
    on users.id = enrollment.spc_user_id
  where enrollment.enabled = true
    and pg_catalog.lower(users.username) = 'otto@cosulich.com.hk'
    and enrollment.whatsapp_phone_hash = pg_catalog.encode(
      extensions.digest(users.whatsapp_phone, 'sha256'),
      'hex'
    );

  if otto_count <> 1 or eligible_count <> 1 or enrolled_count <> 1 then
    raise exception
      'The Otto WhatsApp login MFA enrollment does not match the active SPC account.';
  end if;
end;
$$;

-- Define the private ledger before compiling the service-role RPCs below.
-- The later IF NOT EXISTS declaration keeps the canonical block idempotent.
create table if not exists private.spc_whatsapp_login_mfa_challenges (
  id uuid primary key,
  spc_user_id uuid not null
    references public.spc_users(id) on delete cascade,
  login_attempt_id uuid not null unique
    references private.spc_login_attempts(id) on delete cascade,
  request_id uuid not null unique,
  source_ip inet not null,
  preauth_token_hash text not null unique,
  code_hash text not null,
  observed_user_updated_at timestamptz not null,
  delivery_status text not null default 'pending',
  whatsapp_message_id text,
  delivery_completed_at timestamptz,
  attempt_count smallint not null default 0,
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  last_attempt_at timestamptz,
  verified_at timestamptz,
  invalidated_at timestamptz,
  invalidation_reason text,
  session_id uuid,
  session_created_at timestamptz,
  constraint spc_whatsapp_login_mfa_preauth_hash_format
    check (preauth_token_hash ~ '^[0-9a-f]{64}$'),
  constraint spc_whatsapp_login_mfa_code_hash_format
    check (code_hash ~ '^[0-9a-f]{64}$'),
  constraint spc_whatsapp_login_mfa_distinct_hashes
    check (preauth_token_hash <> code_hash),
  constraint spc_whatsapp_login_mfa_delivery_status
    check (delivery_status in ('pending', 'accepted', 'failed')),
  constraint spc_whatsapp_login_mfa_attempt_count
    check (attempt_count between 0 and 5),
  constraint spc_whatsapp_login_mfa_expiry
    check (expires_at > created_at),
  constraint spc_whatsapp_login_mfa_message_id
    check (
      whatsapp_message_id is null
      or (
        pg_catalog.length(whatsapp_message_id) between 1 and 512
        and whatsapp_message_id !~ '[[:cntrl:]]'
      )
    ),
  constraint spc_whatsapp_login_mfa_delivery_lifecycle
    check (
      (
        delivery_status = 'pending'
        and delivery_completed_at is null
        and whatsapp_message_id is null
      )
      or (
        delivery_status = 'accepted'
        and delivery_completed_at is not null
        and whatsapp_message_id is not null
      )
      or (
        delivery_status = 'failed'
        and delivery_completed_at is not null
        and whatsapp_message_id is null
      )
    ),
  constraint spc_whatsapp_login_mfa_attempt_timestamp
    check (last_attempt_at is null or last_attempt_at >= created_at),
  constraint spc_whatsapp_login_mfa_verified_delivery
    check (
      verified_at is null
      or (
        delivery_status = 'accepted'
        and invalidated_at is null
        and verified_at >= created_at
        and verified_at <= expires_at
      )
    ),
  constraint spc_whatsapp_login_mfa_invalidation
    check (
      (invalidated_at is null and invalidation_reason is null)
      or (
        invalidated_at is not null
        and invalidation_reason is not null
        and invalidation_reason in (
          'delivery_failed',
          'expired',
          'locked',
          'superseded',
          'cancelled',
          'credential_changed'
        )
      )
    ),
  constraint spc_whatsapp_login_mfa_session_state
    check (
      (session_id is null and session_created_at is null)
      or (
        session_id is not null
        and session_created_at is not null
        and verified_at is not null
        and session_created_at >= verified_at
      )
    )
);

create or replace function public.complete_spc_whatsapp_login_mfa_delivery(
  p_challenge_id uuid,
  p_preauth_token_hash text,
  p_succeeded boolean,
  p_message_id text
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  challenge private.spc_whatsapp_login_mfa_challenges%rowtype;
  now_value timestamptz;
begin
  if p_challenge_id is null
    or p_preauth_token_hash is null
    or p_preauth_token_hash !~ '^[0-9a-f]{64}$'
    or p_succeeded is null
    or (
      p_succeeded
      and (
        p_message_id is null
        or pg_catalog.length(p_message_id) not between 1 and 512
        or p_message_id ~ '[[:cntrl:]]'
      )
    )
    or (not p_succeeded and p_message_id is not null)
  then
    raise exception 'The WhatsApp login MFA delivery result is invalid.';
  end if;

  select challenges.*
  into challenge
  from private.spc_whatsapp_login_mfa_challenges as challenges
  where challenges.id = p_challenge_id
    and challenges.preauth_token_hash = p_preauth_token_hash
  for update;

  if not found then
    return false;
  end if;

  now_value := pg_catalog.clock_timestamp();
  if challenge.delivery_status <> 'pending'
    or challenge.invalidated_at is not null
    or challenge.verified_at is not null
    or challenge.session_created_at is not null
  then
    return false;
  end if;

  if challenge.expires_at <= now_value then
    update private.spc_whatsapp_login_mfa_challenges as challenges
    set
      delivery_status = 'failed',
      delivery_completed_at = now_value,
      whatsapp_message_id = null,
      invalidated_at = now_value,
      invalidation_reason = 'expired'
    where challenges.id = challenge.id;
    return false;
  end if;

  update private.spc_whatsapp_login_mfa_challenges as challenges
  set
    delivery_status = case when p_succeeded then 'accepted' else 'failed' end,
    delivery_completed_at = now_value,
    whatsapp_message_id = case when p_succeeded then p_message_id else null end,
    invalidated_at = case when p_succeeded then null else now_value end,
    invalidation_reason = case when p_succeeded then null else 'delivery_failed' end
  where challenges.id = challenge.id;

  return true;
end;
$$;

create or replace function public.get_spc_whatsapp_login_mfa_challenge(
  p_preauth_token_hash text
)
returns table (
  challenge_id uuid,
  spc_user_id uuid,
  challenge_expires_at timestamptz,
  attempts_remaining integer
)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if p_preauth_token_hash is null
    or p_preauth_token_hash !~ '^[0-9a-f]{64}$'
  then
    raise exception 'The WhatsApp login MFA token is invalid.';
  end if;

  return query
  select
    challenges.id,
    challenges.spc_user_id,
    challenges.expires_at,
    (5 - challenges.attempt_count)::integer
  from private.spc_whatsapp_login_mfa_challenges as challenges
  where challenges.preauth_token_hash = p_preauth_token_hash;
end;
$$;

create or replace function public.verify_spc_whatsapp_login_mfa_challenge(
  p_challenge_id uuid,
  p_spc_user_id uuid,
  p_preauth_token_hash text,
  p_code_hash text,
  p_session_token_hash text
)
returns table (
  result text,
  attempts_remaining integer,
  challenge_expires_at timestamptz,
  spc_user_id uuid,
  user_updated_at timestamptz,
  session_expires_at timestamptz,
  mfa_verified_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  challenge private.spc_whatsapp_login_mfa_challenges%rowtype;
  current_user_updated_at timestamptz;
  now_value timestamptz;
  session_id_value uuid;
  session_expires_at_value timestamptz;
  user_mismatch_count integer;
  source_ip_mismatch_count integer;
  next_attempt_count integer;
begin
  if p_challenge_id is null
    or p_spc_user_id is null
    or p_preauth_token_hash is null
    or p_preauth_token_hash !~ '^[0-9a-f]{64}$'
    or p_code_hash is null
    or p_code_hash !~ '^[0-9a-f]{64}$'
    or p_session_token_hash is null
    or p_session_token_hash !~ '^[0-9a-f]{64}$'
    or p_code_hash in (p_preauth_token_hash, p_session_token_hash)
    or p_session_token_hash = p_preauth_token_hash
  then
    raise exception 'The WhatsApp login MFA verification is invalid.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'spc-whatsapp-login-mfa:' || p_spc_user_id::text,
      0
    )
  );

  select challenges.*
  into challenge
  from private.spc_whatsapp_login_mfa_challenges as challenges
  where challenges.id = p_challenge_id
    and challenges.spc_user_id = p_spc_user_id
    and challenges.preauth_token_hash = p_preauth_token_hash
  for update;

  if not found then
    return query
    select
      'unavailable'::text,
      0,
      null::timestamptz,
      null::uuid,
      null::timestamptz,
      null::timestamptz,
      null::timestamptz;
    return;
  end if;

  now_value := pg_catalog.clock_timestamp();

  if challenge.verified_at is not null
    or challenge.session_created_at is not null
    or challenge.session_id is not null
  then
    return query
    select
      'already_used'::text,
      (5 - challenge.attempt_count)::integer,
      challenge.expires_at,
      challenge.spc_user_id,
      challenge.observed_user_updated_at,
      null::timestamptz,
      challenge.verified_at;
    return;
  end if;

  if challenge.invalidated_at is not null then
    return query
    select
      case challenge.invalidation_reason
        when 'locked' then 'locked'
        when 'expired' then 'expired'
        when 'cancelled' then 'cancelled'
        when 'credential_changed' then 'user_changed'
        else 'unavailable'
      end::text,
      (5 - challenge.attempt_count)::integer,
      challenge.expires_at,
      challenge.spc_user_id,
      challenge.observed_user_updated_at,
      null::timestamptz,
      null::timestamptz;
    return;
  end if;

  if challenge.delivery_status <> 'accepted' then
    return query
    select
      'unavailable'::text,
      (5 - challenge.attempt_count)::integer,
      challenge.expires_at,
      challenge.spc_user_id,
      challenge.observed_user_updated_at,
      null::timestamptz,
      null::timestamptz;
    return;
  end if;

  if challenge.expires_at <= now_value then
    update private.spc_whatsapp_login_mfa_challenges as challenges
    set
      invalidated_at = now_value,
      invalidation_reason = 'expired'
    where challenges.id = challenge.id;

    return query
    select
      'expired'::text,
      (5 - challenge.attempt_count)::integer,
      challenge.expires_at,
      challenge.spc_user_id,
      challenge.observed_user_updated_at,
      null::timestamptz,
      null::timestamptz;
    return;
  end if;

  select users.updated_at
  into current_user_updated_at
  from public.spc_users as users
  join private.spc_whatsapp_login_mfa_enrollment as enrollment
    on enrollment.spc_user_id = users.id
  where users.id = challenge.spc_user_id
    and pg_catalog.lower(users.username) = 'otto@cosulich.com.hk'
    and users.is_active = true
    and users.updated_at = challenge.observed_user_updated_at
    and users.whatsapp_phone ~ '^[1-9][0-9]{7,14}$'
    and enrollment.enabled = true
    and enrollment.whatsapp_phone_hash = pg_catalog.encode(
      extensions.digest(users.whatsapp_phone, 'sha256'),
      'hex'
    )
  for update of users, enrollment;

  if not found then
    update private.spc_whatsapp_login_mfa_challenges as challenges
    set
      invalidated_at = now_value,
      invalidation_reason = 'credential_changed'
    where challenges.id = challenge.id;

    return query
    select
      'user_changed'::text,
      (5 - challenge.attempt_count)::integer,
      challenge.expires_at,
      challenge.spc_user_id,
      challenge.observed_user_updated_at,
      null::timestamptz,
      null::timestamptz;
    return;
  end if;

  if challenge.code_hash <> p_code_hash then
    select coalesce(sum(challenges.attempt_count), 0)::integer
    into user_mismatch_count
    from private.spc_whatsapp_login_mfa_challenges as challenges
    where challenges.spc_user_id = challenge.spc_user_id
      and challenges.created_at > now_value - interval '15 minutes';

    select coalesce(sum(challenges.attempt_count), 0)::integer
    into source_ip_mismatch_count
    from private.spc_whatsapp_login_mfa_challenges as challenges
    where challenges.source_ip = challenge.source_ip
      and challenges.created_at > now_value - interval '15 minutes';

    next_attempt_count := challenge.attempt_count + 1;
    if next_attempt_count >= 5
      or user_mismatch_count + 1 >= 10
      or source_ip_mismatch_count + 1 >= 20
    then
      update private.spc_whatsapp_login_mfa_challenges as challenges
      set
        attempt_count = next_attempt_count,
        last_attempt_at = now_value,
        invalidated_at = now_value,
        invalidation_reason = 'locked'
      where challenges.id = challenge.id;

      return query
      select
        'locked'::text,
        0,
        challenge.expires_at,
        challenge.spc_user_id,
        challenge.observed_user_updated_at,
        null::timestamptz,
        null::timestamptz;
      return;
    end if;

    update private.spc_whatsapp_login_mfa_challenges as challenges
    set
      attempt_count = next_attempt_count,
      last_attempt_at = now_value
    where challenges.id = challenge.id;

    return query
    select
      'mismatch'::text,
      (5 - next_attempt_count)::integer,
      challenge.expires_at,
      challenge.spc_user_id,
      challenge.observed_user_updated_at,
      null::timestamptz,
      null::timestamptz;
    return;
  end if;

  delete from public.spc_sessions as expired_sessions
  where expired_sessions.id in (
    select sessions.id
    from public.spc_sessions as sessions
    where sessions.expires_at < now_value - interval '30 days'
      or sessions.revoked_at < now_value - interval '30 days'
    order by sessions.expires_at
    limit 1000
  );

  update public.spc_sessions as sessions
  set revoked_at = now_value
  where sessions.spc_user_id = challenge.spc_user_id
    and sessions.revoked_at is null;

  session_id_value := pg_catalog.gen_random_uuid();
  session_expires_at_value := now_value + interval '12 hours';

  insert into public.spc_sessions (
    id,
    spc_user_id,
    token_hash,
    user_updated_at,
    created_at,
    expires_at,
    mfa_verified_at
  ) values (
    session_id_value,
    challenge.spc_user_id,
    p_session_token_hash,
    current_user_updated_at,
    now_value,
    session_expires_at_value,
    now_value
  );

  update private.spc_whatsapp_login_mfa_challenges as challenges
  set
    verified_at = now_value,
    session_id = session_id_value,
    session_created_at = now_value
  where challenges.id = challenge.id;

  update private.spc_whatsapp_login_mfa_challenges as challenges
  set
    invalidated_at = now_value,
    invalidation_reason = 'superseded'
  where challenges.spc_user_id = challenge.spc_user_id
    and challenges.id <> challenge.id
    and challenges.verified_at is null
    and challenges.session_created_at is null
    and challenges.invalidated_at is null;

  return query
  select
    'verified'::text,
    (5 - challenge.attempt_count)::integer,
    challenge.expires_at,
    challenge.spc_user_id,
    current_user_updated_at,
    session_expires_at_value,
    now_value;
end;
$$;

create or replace function public.cancel_spc_whatsapp_login_mfa_challenge(
  p_preauth_token_hash text
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  challenge private.spc_whatsapp_login_mfa_challenges%rowtype;
begin
  if p_preauth_token_hash is null
    or p_preauth_token_hash !~ '^[0-9a-f]{64}$'
  then
    raise exception 'The WhatsApp login MFA token is invalid.';
  end if;

  select challenges.*
  into challenge
  from private.spc_whatsapp_login_mfa_challenges as challenges
  where challenges.preauth_token_hash = p_preauth_token_hash
  for update;

  if not found then
    return true;
  end if;

  if challenge.verified_at is null
    and challenge.session_created_at is null
    and challenge.invalidated_at is null
  then
    update private.spc_whatsapp_login_mfa_challenges as challenges
    set
      invalidated_at = pg_catalog.clock_timestamp(),
      invalidation_reason = 'cancelled'
    where challenges.id = challenge.id;
  end if;

  return true;
end;
$$;

create or replace function public.create_spc_session_from_assured_session(
  p_spc_user_id uuid,
  p_observed_user_updated_at timestamptz,
  p_previous_token_hash text,
  p_token_hash text
)
returns table (
  id uuid,
  expires_at timestamptz,
  mfa_verified_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  previous_session public.spc_sessions%rowtype;
  now_value timestamptz;
  new_session_id uuid;
begin
  if p_spc_user_id is null
    or p_observed_user_updated_at is null
    or p_previous_token_hash is null
    or p_previous_token_hash !~ '^[0-9a-f]{64}$'
    or p_token_hash is null
    or p_token_hash !~ '^[0-9a-f]{64}$'
    or p_previous_token_hash = p_token_hash
  then
    raise exception 'The assured SPC-session rotation is invalid.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'spc-whatsapp-login-mfa:' || p_spc_user_id::text,
      0
    )
  );

  select sessions.*
  into previous_session
  from public.spc_sessions as sessions
  where sessions.spc_user_id = p_spc_user_id
    and sessions.token_hash = p_previous_token_hash
    and sessions.revoked_at is null
    and sessions.mfa_verified_at is not null
  for update;

  if not found then
    raise exception 'The assured SPC session is unavailable.';
  end if;

  now_value := pg_catalog.clock_timestamp();
  if previous_session.expires_at <= now_value then
    raise exception 'The assured SPC session has expired.';
  end if;

  perform users.id
  from public.spc_users as users
  join private.spc_whatsapp_login_mfa_enrollment as enrollment
    on enrollment.spc_user_id = users.id
  where users.id = p_spc_user_id
    and pg_catalog.lower(users.username) = 'otto@cosulich.com.hk'
    and users.is_active = true
    and users.updated_at = p_observed_user_updated_at
    and users.whatsapp_phone ~ '^[1-9][0-9]{7,14}$'
    and enrollment.enabled = true
    and enrollment.whatsapp_phone_hash = pg_catalog.encode(
      extensions.digest(users.whatsapp_phone, 'sha256'),
      'hex'
    )
  for update of users, enrollment;

  if not found then
    raise exception 'The enrolled SPC account changed before session rotation.';
  end if;

  new_session_id := pg_catalog.gen_random_uuid();
  insert into public.spc_sessions (
    id,
    spc_user_id,
    token_hash,
    user_updated_at,
    created_at,
    expires_at,
    mfa_verified_at
  ) values (
    new_session_id,
    p_spc_user_id,
    p_token_hash,
    p_observed_user_updated_at,
    now_value,
    previous_session.expires_at,
    previous_session.mfa_verified_at
  );

  update public.spc_sessions as sessions
  set revoked_at = now_value
  where sessions.id = previous_session.id;

  return query
  select
    new_session_id,
    previous_session.expires_at,
    previous_session.mfa_verified_at;
end;
$$;

create or replace function public.cleanup_spc_whatsapp_login_mfa_challenges()
returns integer
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  deleted_count integer;
begin
  delete from private.spc_whatsapp_login_mfa_challenges as challenges
  where challenges.id in (
    select retained.id
    from private.spc_whatsapp_login_mfa_challenges as retained
    where retained.created_at < pg_catalog.clock_timestamp() - interval '30 days'
    order by retained.created_at
    limit 10000
  );
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

-- Establish the signature before the consolidated grant block. The complete
-- implementation replaces this body later in the same transactional migration.
create or replace function public.begin_spc_whatsapp_login_mfa_challenge(
  p_challenge_id uuid,
  p_spc_user_id uuid,
  p_login_attempt_id uuid,
  p_preauth_token_hash text,
  p_code_hash text,
  p_observed_user_updated_at timestamptz,
  p_source_ip inet,
  p_request_id uuid,
  p_expires_at timestamptz
)
returns table (
  challenge_id uuid,
  allowed boolean,
  retry_after_seconds integer,
  challenge_expires_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  raise exception 'The WhatsApp login MFA challenge initializer is unavailable.';
end;
$$;

revoke all on function public.begin_spc_whatsapp_login_mfa_challenge(
  uuid, uuid, uuid, text, text, timestamptz, inet, uuid, timestamptz
) from public, anon, authenticated, service_role;
grant execute on function public.begin_spc_whatsapp_login_mfa_challenge(
  uuid, uuid, uuid, text, text, timestamptz, inet, uuid, timestamptz
) to service_role;

revoke all on function public.complete_spc_whatsapp_login_mfa_delivery(
  uuid, text, boolean, text
) from public, anon, authenticated, service_role;
grant execute on function public.complete_spc_whatsapp_login_mfa_delivery(
  uuid, text, boolean, text
) to service_role;

revoke all on function public.get_spc_whatsapp_login_mfa_challenge(text)
  from public, anon, authenticated, service_role;
grant execute on function public.get_spc_whatsapp_login_mfa_challenge(text)
  to service_role;

revoke all on function public.verify_spc_whatsapp_login_mfa_challenge(
  uuid, uuid, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.verify_spc_whatsapp_login_mfa_challenge(
  uuid, uuid, text, text, text
) to service_role;

revoke all on function public.cancel_spc_whatsapp_login_mfa_challenge(text)
  from public, anon, authenticated, service_role;
grant execute on function public.cancel_spc_whatsapp_login_mfa_challenge(text)
  to service_role;

revoke all on function public.create_spc_session_from_assured_session(
  uuid, timestamptz, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.create_spc_session_from_assured_session(
  uuid, timestamptz, text, text
) to service_role;

revoke all on function public.cleanup_spc_whatsapp_login_mfa_challenges()
  from public, anon, authenticated, service_role;
grant execute on function public.cleanup_spc_whatsapp_login_mfa_challenges()
  to service_role;

comment on function public.begin_spc_whatsapp_login_mfa_challenge(
  uuid, uuid, uuid, text, text, timestamptz, inet, uuid, timestamptz
) is 'Creates one rate-limited Otto login MFA challenge after a completed password attempt.';
comment on function public.complete_spc_whatsapp_login_mfa_delivery(
  uuid, text, boolean, text
) is 'Finalizes the accepted or failed Meta delivery request for an Otto login challenge.';
comment on function public.verify_spc_whatsapp_login_mfa_challenge(
  uuid, uuid, text, text, text
) is 'Atomically verifies one OTP and creates its version-bound MFA-assured SPC session.';
comment on function public.create_spc_session_from_assured_session(
  uuid, timestamptz, text, text
) is 'Rotates an MFA-assured session after a password change without extending its expiry.';

create table if not exists private.spc_whatsapp_login_mfa_challenges (
  id uuid primary key,
  spc_user_id uuid not null
    references public.spc_users(id) on delete cascade,
  login_attempt_id uuid not null unique
    references private.spc_login_attempts(id) on delete cascade,
  request_id uuid not null unique,
  source_ip inet not null,
  preauth_token_hash text not null unique,
  code_hash text not null,
  observed_user_updated_at timestamptz not null,
  delivery_status text not null default 'pending',
  whatsapp_message_id text,
  delivery_completed_at timestamptz,
  attempt_count smallint not null default 0,
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  last_attempt_at timestamptz,
  verified_at timestamptz,
  invalidated_at timestamptz,
  invalidation_reason text,
  session_id uuid,
  session_created_at timestamptz,
  constraint spc_whatsapp_login_mfa_preauth_hash_format
    check (preauth_token_hash ~ '^[0-9a-f]{64}$'),
  constraint spc_whatsapp_login_mfa_code_hash_format
    check (code_hash ~ '^[0-9a-f]{64}$'),
  constraint spc_whatsapp_login_mfa_distinct_hashes
    check (preauth_token_hash <> code_hash),
  constraint spc_whatsapp_login_mfa_delivery_status
    check (delivery_status in ('pending', 'accepted', 'failed')),
  constraint spc_whatsapp_login_mfa_attempt_count
    check (attempt_count between 0 and 5),
  constraint spc_whatsapp_login_mfa_expiry
    check (expires_at > created_at),
  constraint spc_whatsapp_login_mfa_message_id
    check (
      whatsapp_message_id is null
      or (
        pg_catalog.length(whatsapp_message_id) between 1 and 512
        and whatsapp_message_id !~ '[[:cntrl:]]'
      )
    ),
  constraint spc_whatsapp_login_mfa_delivery_lifecycle
    check (
      (
        delivery_status = 'pending'
        and delivery_completed_at is null
        and whatsapp_message_id is null
      )
      or (
        delivery_status = 'accepted'
        and delivery_completed_at is not null
        and whatsapp_message_id is not null
      )
      or (
        delivery_status = 'failed'
        and delivery_completed_at is not null
        and whatsapp_message_id is null
      )
    ),
  constraint spc_whatsapp_login_mfa_attempt_timestamp
    check (last_attempt_at is null or last_attempt_at >= created_at),
  constraint spc_whatsapp_login_mfa_verified_delivery
    check (
      verified_at is null
      or (
        delivery_status = 'accepted'
        and invalidated_at is null
        and verified_at >= created_at
        and verified_at <= expires_at
      )
    ),
  constraint spc_whatsapp_login_mfa_invalidation
    check (
      (invalidated_at is null and invalidation_reason is null)
      or (
        invalidated_at is not null
        and invalidation_reason is not null
        and invalidation_reason in (
          'delivery_failed',
          'expired',
          'locked',
          'superseded',
          'cancelled',
          'credential_changed'
        )
      )
    ),
  constraint spc_whatsapp_login_mfa_session_state
    check (
      (session_id is null and session_created_at is null)
      or (
        session_id is not null
        and session_created_at is not null
        and verified_at is not null
        and session_created_at >= verified_at
      )
    )
);

comment on table private.spc_whatsapp_login_mfa_challenges is
  'Service-role-only WhatsApp login MFA state. Stores SHA-256/HMAC hashes, trusted request binding, and delivery/session evidence; never raw OTPs or pre-authentication tokens.';

create index if not exists spc_whatsapp_login_mfa_user_created_idx
  on private.spc_whatsapp_login_mfa_challenges(spc_user_id, created_at desc);
create index if not exists spc_whatsapp_login_mfa_retention_idx
  on private.spc_whatsapp_login_mfa_challenges(created_at);
create unique index if not exists spc_whatsapp_login_mfa_session_id_idx
  on private.spc_whatsapp_login_mfa_challenges(session_id)
  where session_id is not null;

alter table private.spc_whatsapp_login_mfa_enrollment enable row level security;
alter table private.spc_whatsapp_login_mfa_challenges enable row level security;

drop policy if exists "spc_whatsapp_login_mfa_enrollment_no_access"
  on private.spc_whatsapp_login_mfa_enrollment;
create policy "spc_whatsapp_login_mfa_enrollment_no_access"
  on private.spc_whatsapp_login_mfa_enrollment
  for all
  using (false)
  with check (false);

drop policy if exists "spc_whatsapp_login_mfa_challenges_no_access"
  on private.spc_whatsapp_login_mfa_challenges;
create policy "spc_whatsapp_login_mfa_challenges_no_access"
  on private.spc_whatsapp_login_mfa_challenges
  for all
  using (false)
  with check (false);

revoke all privileges on table private.spc_whatsapp_login_mfa_enrollment
  from public, anon, authenticated, service_role;
revoke all privileges on table private.spc_whatsapp_login_mfa_challenges
  from public, anon, authenticated, service_role;

create or replace function public.begin_spc_whatsapp_login_mfa_challenge(
  p_challenge_id uuid,
  p_spc_user_id uuid,
  p_login_attempt_id uuid,
  p_preauth_token_hash text,
  p_code_hash text,
  p_observed_user_updated_at timestamptz,
  p_source_ip inet,
  p_request_id uuid,
  p_expires_at timestamptz
)
returns table (
  challenge_id uuid,
  allowed boolean,
  retry_after_seconds integer,
  challenge_expires_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  now_value timestamptz;
  target_username_hash constant text := pg_catalog.encode(
    extensions.digest('otto@cosulich.com.hk', 'sha256'),
    'hex'
  );
  existing_challenge private.spc_whatsapp_login_mfa_challenges%rowtype;
  latest_send_at timestamptz;
  oldest_hourly_send_at timestamptz;
  oldest_daily_send_at timestamptz;
  hourly_send_count bigint;
  daily_send_count bigint;
  retry_after_value integer;
begin
  if p_challenge_id is null
    or p_spc_user_id is null
    or p_login_attempt_id is null
    or p_preauth_token_hash is null
    or p_preauth_token_hash !~ '^[0-9a-f]{64}$'
    or p_code_hash is null
    or p_code_hash !~ '^[0-9a-f]{64}$'
    or p_code_hash = p_preauth_token_hash
    or p_observed_user_updated_at is null
    or p_source_ip is null
    or p_request_id is null
    or p_expires_at is null
  then
    raise exception 'The WhatsApp login MFA challenge is invalid.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'spc-whatsapp-login-mfa:' || p_spc_user_id::text,
      0
    )
  );

  now_value := pg_catalog.clock_timestamp();
  if p_expires_at <= now_value + interval '4 minutes'
    or p_expires_at > now_value + interval '6 minutes'
  then
    raise exception 'The WhatsApp login MFA expiry is invalid.';
  end if;

  perform users.id
  from public.spc_users as users
  join private.spc_whatsapp_login_mfa_enrollment as enrollment
    on enrollment.spc_user_id = users.id
  where users.id = p_spc_user_id
    and pg_catalog.lower(users.username) = 'otto@cosulich.com.hk'
    and users.is_active = true
    and users.whatsapp_phone ~ '^[1-9][0-9]{7,14}$'
    and users.updated_at = p_observed_user_updated_at
    and enrollment.enabled = true
    and enrollment.whatsapp_phone_hash = pg_catalog.encode(
      extensions.digest(users.whatsapp_phone, 'sha256'),
      'hex'
    )
  for update of users, enrollment;

  if not found then
    raise exception 'The WhatsApp login MFA account is not eligible.';
  end if;

  perform attempts.id
  from private.spc_login_attempts as attempts
  where attempts.id = p_login_attempt_id
    and attempts.request_id = p_request_id
    and attempts.source_ip = p_source_ip
    and attempts.username_hash = target_username_hash
    and attempts.outcome = 'succeeded'
    and attempts.completed_at is not null
    and attempts.completed_at > now_value - interval '2 minutes'
    and attempts.completed_at <= now_value
  for key share;

  if not found then
    raise exception 'The completed password attempt is unavailable.';
  end if;

  select challenges.*
  into existing_challenge
  from private.spc_whatsapp_login_mfa_challenges as challenges
  where challenges.login_attempt_id = p_login_attempt_id
  for update;

  if found then
    if existing_challenge.id = p_challenge_id
      and existing_challenge.spc_user_id = p_spc_user_id
      and existing_challenge.request_id = p_request_id
      and existing_challenge.source_ip = p_source_ip
      and existing_challenge.preauth_token_hash = p_preauth_token_hash
      and existing_challenge.code_hash = p_code_hash
      and existing_challenge.observed_user_updated_at = p_observed_user_updated_at
      and existing_challenge.expires_at = p_expires_at
      and existing_challenge.delivery_status = 'pending'
      and existing_challenge.invalidated_at is null
      and existing_challenge.expires_at > now_value
    then
      return query
      select existing_challenge.id, true, 0, existing_challenge.expires_at;
      return;
    end if;

    raise exception 'The password attempt already has an MFA challenge.';
  end if;

  delete from private.spc_whatsapp_login_mfa_challenges as challenges
  where challenges.id in (
    select retained.id
    from private.spc_whatsapp_login_mfa_challenges as retained
    where retained.created_at < now_value - interval '30 days'
    order by retained.created_at
    limit 1000
  );

  select count(*), min(challenges.created_at)
  into daily_send_count, oldest_daily_send_at
  from private.spc_whatsapp_login_mfa_challenges as challenges
  where challenges.spc_user_id = p_spc_user_id
    and challenges.created_at > now_value - interval '24 hours';

  if daily_send_count >= 20 then
    retry_after_value := greatest(
      1,
      ceil(extract(epoch from (
        oldest_daily_send_at + interval '24 hours' - now_value
      )))::integer
    );
    return query
    select null::uuid, false, retry_after_value, null::timestamptz;
    return;
  end if;

  select count(*), min(challenges.created_at)
  into hourly_send_count, oldest_hourly_send_at
  from private.spc_whatsapp_login_mfa_challenges as challenges
  where challenges.spc_user_id = p_spc_user_id
    and challenges.created_at > now_value - interval '1 hour';

  if hourly_send_count >= 10 then
    retry_after_value := greatest(
      1,
      ceil(extract(epoch from (
        oldest_hourly_send_at + interval '1 hour' - now_value
      )))::integer
    );
    return query
    select null::uuid, false, retry_after_value, null::timestamptz;
    return;
  end if;

  select max(challenges.created_at)
  into latest_send_at
  from private.spc_whatsapp_login_mfa_challenges as challenges
  where challenges.spc_user_id = p_spc_user_id
    and challenges.created_at > now_value - interval '60 seconds';

  if latest_send_at is not null then
    retry_after_value := greatest(
      1,
      ceil(extract(epoch from (
        latest_send_at + interval '60 seconds' - now_value
      )))::integer
    );
    return query
    select null::uuid, false, retry_after_value, null::timestamptz;
    return;
  end if;

  update private.spc_whatsapp_login_mfa_challenges as challenges
  set
    invalidated_at = now_value,
    invalidation_reason = 'superseded'
  where challenges.spc_user_id = p_spc_user_id
    and challenges.verified_at is null
    and challenges.session_created_at is null
    and challenges.invalidated_at is null;

  insert into private.spc_whatsapp_login_mfa_challenges (
    id,
    spc_user_id,
    login_attempt_id,
    request_id,
    source_ip,
    preauth_token_hash,
    code_hash,
    observed_user_updated_at,
    created_at,
    expires_at
  ) values (
    p_challenge_id,
    p_spc_user_id,
    p_login_attempt_id,
    p_request_id,
    p_source_ip,
    p_preauth_token_hash,
    p_code_hash,
    p_observed_user_updated_at,
    now_value,
    p_expires_at
  );

  return query select p_challenge_id, true, 0, p_expires_at;
end;
$$;
