-- BEGIN CANONICAL SPC WHATSAPP LOGIN MFA ALL-USERS BLOCK
-- Expand WhatsApp login MFA from the single-account pilot to every active SPC
-- account. Enrollment fingerprints are always derived from current database
-- values; this migration contains neither raw phone numbers nor fixed digests.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to service_role;

alter table public.spc_users
  drop constraint if exists spc_users_active_requires_whatsapp_phone;
alter table public.spc_users
  add constraint spc_users_active_requires_whatsapp_phone
    check (
      is_active = false
      or (
        whatsapp_phone is not null
        and whatsapp_phone ~ '^[1-9][0-9]{7,14}$'
      )
    ) not valid;

insert into private.spc_whatsapp_login_mfa_enrollment as enrollment (
  spc_user_id,
  whatsapp_phone_hash,
  enabled,
  created_at,
  updated_at
)
select
  users.id,
  pg_catalog.encode(
    extensions.digest(users.whatsapp_phone, 'sha256'),
    'hex'
  ),
  true,
  pg_catalog.statement_timestamp(),
  pg_catalog.statement_timestamp()
from public.spc_users as users
where users.is_active = true
  and users.whatsapp_phone ~ '^[1-9][0-9]{7,14}$'
on conflict (spc_user_id) do update
set
  whatsapp_phone_hash = excluded.whatsapp_phone_hash,
  enabled = true,
  updated_at = excluded.updated_at
where enrollment.whatsapp_phone_hash is distinct from excluded.whatsapp_phone_hash
  or enrollment.enabled is distinct from true;

update private.spc_whatsapp_login_mfa_enrollment as enrollment
set
  enabled = false,
  updated_at = pg_catalog.clock_timestamp()
where enrollment.enabled = true
  and not exists (
    select 1
    from public.spc_users as users
    where users.id = enrollment.spc_user_id
      and users.is_active = true
      and users.whatsapp_phone ~ '^[1-9][0-9]{7,14}$'
  );

do $$
declare
  active_count bigint;
  eligible_count bigint;
  enabled_count bigint;
  matching_enabled_count bigint;
  bootstrap_mode boolean := coalesce(
    pg_catalog.current_setting('app.spc_schema_bootstrap', true),
    ''
  ) = 'true';
begin
  select count(*)
  into active_count
  from public.spc_users as users
  where users.is_active = true;

  select count(*)
  into eligible_count
  from public.spc_users as users
  where users.is_active = true
    and users.whatsapp_phone ~ '^[1-9][0-9]{7,14}$';

  select count(*)
  into enabled_count
  from private.spc_whatsapp_login_mfa_enrollment as enrollment
  where enrollment.enabled = true;

  select count(*)
  into matching_enabled_count
  from private.spc_whatsapp_login_mfa_enrollment as enrollment
  join public.spc_users as users
    on users.id = enrollment.spc_user_id
  where enrollment.enabled = true
    and users.is_active = true
    and users.whatsapp_phone ~ '^[1-9][0-9]{7,14}$'
    and enrollment.whatsapp_phone_hash = pg_catalog.encode(
      extensions.digest(users.whatsapp_phone, 'sha256'),
      'hex'
    );

  if active_count = 0 and bootstrap_mode then
    return;
  end if;

  if active_count <= 0
    or active_count <> eligible_count
    or active_count <> enabled_count
    or active_count <> matching_enabled_count
  then
    raise exception
      'Every active SPC account must have exactly one enabled, current WhatsApp MFA enrollment (active %, eligible %, enabled %, matching %).',
      active_count,
      eligible_count,
      enabled_count,
      matching_enabled_count;
  end if;
end;
$$;

alter table public.spc_users
  validate constraint spc_users_active_requires_whatsapp_phone;

comment on constraint spc_users_active_requires_whatsapp_phone
  on public.spc_users is
  'Every active SPC account must have an 8-15 digit international WhatsApp phone number.';

comment on table private.spc_whatsapp_login_mfa_enrollment is
  'Private all-user SPC WhatsApp login MFA enrollment, bound to a stable user id and the SHA-256 fingerprint of the current phone.';

alter table public.spc_sessions
  drop constraint if exists spc_sessions_mfa_verified_at;
alter table public.spc_sessions
  add constraint spc_sessions_mfa_verified_at
    check (
      mfa_verified_at is null
      or mfa_verified_at <= created_at
    );

comment on constraint spc_sessions_mfa_verified_at
  on public.spc_sessions is
  'MFA assurance cannot post-date session creation and may survive sliding renewal of the same assured session.';

create index if not exists spc_whatsapp_login_mfa_source_created_idx
  on private.spc_whatsapp_login_mfa_challenges(source_ip, created_at desc);

create or replace function private.invalidate_spc_whatsapp_login_mfa_enrollment_change()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  affected_user_id uuid := case
    when tg_op = 'DELETE' then old.spc_user_id
    else new.spc_user_id
  end;
  now_value timestamptz := pg_catalog.clock_timestamp();
begin
  -- Bump the account version as well as revoking sessions. The version bump
  -- also invalidates any application-held snapshot that has not yet checked
  -- the session ledger again.
  update public.spc_users as users
  set updated_at = now_value
  where users.id = affected_user_id;

  update public.spc_sessions as sessions
  set revoked_at = now_value
  where sessions.spc_user_id = affected_user_id
    and sessions.revoked_at is null;

  update private.spc_whatsapp_login_mfa_challenges as challenges
  set
    invalidated_at = now_value,
    invalidation_reason = 'credential_changed'
  where challenges.spc_user_id = affected_user_id
    and challenges.verified_at is null
    and challenges.session_created_at is null
    and challenges.invalidated_at is null;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create or replace function private.sync_spc_whatsapp_login_mfa_enrollment()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  phone_hash_value text;
  now_value timestamptz := pg_catalog.clock_timestamp();
begin
  if new.is_active then
    if new.whatsapp_phone is null
      or new.whatsapp_phone !~ '^[1-9][0-9]{7,14}$'
    then
      raise exception 'An active SPC account requires a valid WhatsApp phone.';
    end if;

    phone_hash_value := pg_catalog.encode(
      extensions.digest(new.whatsapp_phone, 'sha256'),
      'hex'
    );

    insert into private.spc_whatsapp_login_mfa_enrollment as enrollment (
      spc_user_id,
      whatsapp_phone_hash,
      enabled,
      created_at,
      updated_at
    ) values (
      new.id,
      phone_hash_value,
      true,
      now_value,
      now_value
    )
    on conflict (spc_user_id) do update
    set
      whatsapp_phone_hash = excluded.whatsapp_phone_hash,
      enabled = true,
      updated_at = excluded.updated_at
    where enrollment.whatsapp_phone_hash is distinct from excluded.whatsapp_phone_hash
      or enrollment.enabled is distinct from true;
  else
    update private.spc_whatsapp_login_mfa_enrollment as enrollment
    set
      enabled = false,
      updated_at = now_value
    where enrollment.spc_user_id = new.id
      and enrollment.enabled = true;
  end if;

  return new;
end;
$$;

drop trigger if exists invalidate_spc_whatsapp_login_mfa_enrollment_change
  on private.spc_whatsapp_login_mfa_enrollment;
create trigger invalidate_spc_whatsapp_login_mfa_enrollment_change
after insert or update or delete
on private.spc_whatsapp_login_mfa_enrollment
for each row
execute function private.invalidate_spc_whatsapp_login_mfa_enrollment_change();

drop trigger if exists sync_spc_whatsapp_login_mfa_enrollment
  on public.spc_users;
create trigger sync_spc_whatsapp_login_mfa_enrollment
after insert or update of whatsapp_phone, is_active
on public.spc_users
for each row
execute function private.sync_spc_whatsapp_login_mfa_enrollment();

revoke all on function private.invalidate_spc_whatsapp_login_mfa_enrollment_change()
  from public, anon, authenticated, service_role;
revoke all on function private.sync_spc_whatsapp_login_mfa_enrollment()
  from public, anon, authenticated, service_role;

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
  current_time_value constant timestamptz := pg_catalog.clock_timestamp();
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
    and users.is_active = true
    and users.updated_at = p_observed_user_updated_at
  for update;

  if not found then
    raise exception
      'SPC credentials changed before session creation. Sign in again.';
  end if;

  expires_at_value := current_time_value + interval '400 days';

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
  locked_username_hash text;
  existing_challenge private.spc_whatsapp_login_mfa_challenges%rowtype;
  latest_user_send_at timestamptz;
  oldest_user_hourly_send_at timestamptz;
  oldest_user_daily_send_at timestamptz;
  oldest_source_hourly_send_at timestamptz;
  oldest_source_daily_send_at timestamptz;
  oldest_global_hourly_send_at timestamptz;
  oldest_global_daily_send_at timestamptz;
  user_hourly_send_count bigint;
  user_daily_send_count bigint;
  source_hourly_send_count bigint;
  source_daily_send_count bigint;
  global_hourly_send_count bigint;
  global_daily_send_count bigint;
  retry_after_value integer := 0;
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

  -- Serialize cap decisions in a stable global/source/user order so parallel
  -- requests for different accounts cannot race past aggregate limits.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('spc-whatsapp-login-mfa:global-send', 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'spc-whatsapp-login-mfa:source:' || p_source_ip::text,
      0
    )
  );
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

  select pg_catalog.encode(
    extensions.digest(
      pg_catalog.lower(pg_catalog.btrim(users.username)),
      'sha256'
    ),
    'hex'
  )
  into locked_username_hash
  from public.spc_users as users
  join private.spc_whatsapp_login_mfa_enrollment as enrollment
    on enrollment.spc_user_id = users.id
  where users.id = p_spc_user_id
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
    and attempts.username_hash = locked_username_hash
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

  -- No delivery-status predicate is intentional: accepted, pending, and
  -- failed challenge creations all consume the same send budget.
  select count(*), min(challenges.created_at)
  into user_daily_send_count, oldest_user_daily_send_at
  from private.spc_whatsapp_login_mfa_challenges as challenges
  where challenges.spc_user_id = p_spc_user_id
    and challenges.created_at > now_value - interval '24 hours';

  select count(*), min(challenges.created_at)
  into user_hourly_send_count, oldest_user_hourly_send_at
  from private.spc_whatsapp_login_mfa_challenges as challenges
  where challenges.spc_user_id = p_spc_user_id
    and challenges.created_at > now_value - interval '1 hour';

  select max(challenges.created_at)
  into latest_user_send_at
  from private.spc_whatsapp_login_mfa_challenges as challenges
  where challenges.spc_user_id = p_spc_user_id
    and challenges.created_at > now_value - interval '60 seconds';

  select count(*), min(challenges.created_at)
  into source_daily_send_count, oldest_source_daily_send_at
  from private.spc_whatsapp_login_mfa_challenges as challenges
  where challenges.source_ip = p_source_ip
    and challenges.created_at > now_value - interval '24 hours';

  select count(*), min(challenges.created_at)
  into source_hourly_send_count, oldest_source_hourly_send_at
  from private.spc_whatsapp_login_mfa_challenges as challenges
  where challenges.source_ip = p_source_ip
    and challenges.created_at > now_value - interval '1 hour';

  select count(*), min(challenges.created_at)
  into global_daily_send_count, oldest_global_daily_send_at
  from private.spc_whatsapp_login_mfa_challenges as challenges
  where challenges.created_at > now_value - interval '24 hours';

  select count(*), min(challenges.created_at)
  into global_hourly_send_count, oldest_global_hourly_send_at
  from private.spc_whatsapp_login_mfa_challenges as challenges
  where challenges.created_at > now_value - interval '1 hour';

  if latest_user_send_at is not null then
    retry_after_value := greatest(
      retry_after_value,
      greatest(
        1,
        ceil(extract(epoch from (
          latest_user_send_at + interval '60 seconds' - now_value
        )))::integer
      )
    );
  end if;

  if user_hourly_send_count >= 10 then
    retry_after_value := greatest(
      retry_after_value,
      greatest(
        1,
        ceil(extract(epoch from (
          oldest_user_hourly_send_at + interval '1 hour' - now_value
        )))::integer
      )
    );
  end if;

  if user_daily_send_count >= 20 then
    retry_after_value := greatest(
      retry_after_value,
      greatest(
        1,
        ceil(extract(epoch from (
          oldest_user_daily_send_at + interval '24 hours' - now_value
        )))::integer
      )
    );
  end if;

  if source_hourly_send_count >= 60 then
    retry_after_value := greatest(
      retry_after_value,
      greatest(
        1,
        ceil(extract(epoch from (
          oldest_source_hourly_send_at + interval '1 hour' - now_value
        )))::integer
      )
    );
  end if;

  if source_daily_send_count >= 120 then
    retry_after_value := greatest(
      retry_after_value,
      greatest(
        1,
        ceil(extract(epoch from (
          oldest_source_daily_send_at + interval '24 hours' - now_value
        )))::integer
      )
    );
  end if;

  if global_hourly_send_count >= 120 then
    retry_after_value := greatest(
      retry_after_value,
      greatest(
        1,
        ceil(extract(epoch from (
          oldest_global_hourly_send_at + interval '1 hour' - now_value
        )))::integer
      )
    );
  end if;

  if global_daily_send_count >= 240 then
    retry_after_value := greatest(
      retry_after_value,
      greatest(
        1,
        ceil(extract(epoch from (
          oldest_global_daily_send_at + interval '24 hours' - now_value
        )))::integer
      )
    );
  end if;

  if retry_after_value > 0 then
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
  challenge_source_ip inet;
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

  select challenges.source_ip
  into challenge_source_ip
  from private.spc_whatsapp_login_mfa_challenges as challenges
  where challenges.id = p_challenge_id
    and challenges.spc_user_id = p_spc_user_id
    and challenges.preauth_token_hash = p_preauth_token_hash;

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

  -- Match begin's source-before-user advisory-lock order. This makes the
  -- aggregate source-IP mismatch ceiling exact across concurrent challenges
  -- for different accounts without introducing a lock-order cycle.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'spc-whatsapp-login-mfa:source:' || challenge_source_ip::text,
      0
    )
  );
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
    and challenges.source_ip = challenge_source_ip
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
  session_expires_at_value := now_value + interval '400 days';

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

revoke all on function public.create_spc_session(uuid, timestamptz, text)
  from public, anon, authenticated, service_role;
grant execute on function public.create_spc_session(uuid, timestamptz, text)
  to service_role;

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
) is 'Creates an all-user SPC login MFA challenge with per-user, source-IP, and global send caps.';
comment on function public.complete_spc_whatsapp_login_mfa_delivery(
  uuid, text, boolean, text
) is 'Finalizes the accepted or failed Meta delivery request for an all-user SPC login MFA challenge.';
comment on function public.get_spc_whatsapp_login_mfa_challenge(text)
  is 'Returns service-role verification state for one all-user SPC login MFA pre-authentication token.';
comment on function public.verify_spc_whatsapp_login_mfa_challenge(
  uuid, uuid, text, text, text
) is 'Atomically verifies one all-user SPC WhatsApp OTP and creates a version-bound MFA-assured session.';
comment on function public.cancel_spc_whatsapp_login_mfa_challenge(text)
  is 'Invalidates one unused all-user SPC login MFA challenge.';
comment on function public.create_spc_session_from_assured_session(
  uuid, timestamptz, text, text
) is 'Rotates an MFA-assured session after a password change without extending its current expiry.';

-- Existing password-only sessions must reauthenticate through MFA. Existing
-- assured sessions remain valid until their already-issued absolute expiry.
update public.spc_sessions as sessions
set revoked_at = pg_catalog.clock_timestamp()
where sessions.revoked_at is null
  and sessions.mfa_verified_at is null;

-- Retire the isolated delivery test machinery while preserving the append-only
-- app.spc_mfa_test_events audit records and their validation trigger.
drop function if exists public.get_active_spc_whatsapp_mfa_test_challenge(uuid);
drop function if exists public.verify_spc_whatsapp_mfa_test_challenge(
  uuid, uuid, uuid, text
);
drop function if exists public.complete_spc_whatsapp_mfa_test_delivery(
  uuid, uuid, boolean, text
);
drop function if exists public.begin_spc_whatsapp_mfa_test_challenge(
  uuid, uuid, uuid, text, timestamptz
);
drop table if exists private.spc_whatsapp_mfa_test_challenges;

do $$
begin
  if exists (
    select 1
    from public.spc_users as users
    where pg_catalog.lower(pg_catalog.btrim(users.username)) = 'mfa_test'
  ) then
    raise exception
      'Delete the retired MFA_TEST account through audited SPC User Management before applying this migration.';
  end if;
end;
$$;
-- END CANONICAL SPC WHATSAPP LOGIN MFA ALL-USERS BLOCK
