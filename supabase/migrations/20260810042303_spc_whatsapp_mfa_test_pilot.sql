-- Isolated SPC WhatsApp MFA proof of concept. This does not change the SPC
-- login/session flow. Challenges stay in a private schema and can only be
-- operated through service-role-only RPCs.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to service_role;

create table if not exists private.spc_whatsapp_mfa_test_challenges (
  id uuid primary key,
  target_user_id uuid not null
    references public.spc_users(id) on delete cascade,
  created_by_user_id uuid not null
    references public.spc_users(id) on delete cascade,
  code_hash text not null,
  delivery_status text not null default 'pending',
  whatsapp_message_id text,
  attempt_count smallint not null default 0,
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  last_attempt_at timestamptz,
  verified_at timestamptz,
  invalidated_at timestamptz,
  invalidation_reason text,
  constraint spc_whatsapp_mfa_test_code_hash_format
    check (code_hash ~ '^[0-9a-f]{64}$'),
  constraint spc_whatsapp_mfa_test_delivery_status
    check (delivery_status in ('pending', 'accepted', 'failed')),
  constraint spc_whatsapp_mfa_test_attempt_count
    check (attempt_count between 0 and 5),
  constraint spc_whatsapp_mfa_test_expiry
    check (expires_at > created_at),
  constraint spc_whatsapp_mfa_test_message_id
    check (
      whatsapp_message_id is null
      or (
        pg_catalog.length(whatsapp_message_id) between 1 and 512
        and whatsapp_message_id !~ '[[:cntrl:]]'
      )
    ),
  constraint spc_whatsapp_mfa_test_invalidation_reason
    check (
      (invalidated_at is null and invalidation_reason is null)
      or (
        invalidated_at is not null
        and invalidation_reason is not null
        and invalidation_reason in (
          'delivery_failed',
          'expired',
          'locked',
          'superseded'
        )
      )
    ),
  constraint spc_whatsapp_mfa_test_verified_delivery
    check (verified_at is null or delivery_status = 'accepted')
);

comment on table private.spc_whatsapp_mfa_test_challenges is
  'Service-role-only five-minute WhatsApp OTP challenges for inactive SPC test accounts. Stores keyed hashes only.';

-- The pilot account is deliberately inactive and has no usable password. An
-- SPC administrator can add its private WhatsApp number in User Management,
-- but it cannot log in unless it is separately activated and assigned a new
-- valid password.
insert into public.spc_users (
  username,
  display_name,
  role,
  password_hash,
  is_active
)
select
  'MFA_TEST',
  'WHATSAPP MFA TEST',
  'buyer_trader',
  'disabled:mfa-test-account',
  false
where not exists (
  select 1
  from public.spc_users as users
  where pg_catalog.lower(users.username) = 'mfa_test'
)
and exists (
  select 1
  from public.spc_users as active_users
  where active_users.is_active = true
);

create index if not exists spc_whatsapp_mfa_test_target_created_idx
  on private.spc_whatsapp_mfa_test_challenges(target_user_id, created_at desc);

create index if not exists spc_whatsapp_mfa_test_retention_idx
  on private.spc_whatsapp_mfa_test_challenges(created_at);

alter table private.spc_whatsapp_mfa_test_challenges enable row level security;
revoke all on table private.spc_whatsapp_mfa_test_challenges
  from public, anon, authenticated, service_role;

create or replace function public.begin_spc_whatsapp_mfa_test_challenge(
  p_challenge_id uuid,
  p_target_user_id uuid,
  p_created_by_user_id uuid,
  p_code_hash text,
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
  latest_send_at timestamptz;
  oldest_hourly_send_at timestamptz;
  oldest_daily_send_at timestamptz;
  hourly_send_count bigint;
  daily_send_count bigint;
  retry_after_value integer;
begin
  if p_challenge_id is null
    or p_target_user_id is null
    or p_created_by_user_id is null
    or p_code_hash is null
    or p_code_hash !~ '^[0-9a-f]{64}$'
    or p_expires_at is null
  then
    raise exception 'The WhatsApp MFA test challenge is invalid.';
  end if;

  if not exists (
    select 1
    from public.spc_users as creators
    where creators.id = p_created_by_user_id
      and creators.is_active = true
  ) then
    raise exception 'The WhatsApp MFA test administrator is not eligible.';
  end if;

  if not exists (
    select 1
    from public.spc_users as users
    where users.id = p_target_user_id
      and users.is_active = false
      and pg_catalog.lower(users.username) = 'mfa_test'
      and users.whatsapp_phone ~ '^[1-9][0-9]{7,14}$'
  ) then
    raise exception 'The WhatsApp MFA test account is not eligible.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'spc-whatsapp-mfa-test:' || p_target_user_id::text,
      0
    )
  );

  now_value := pg_catalog.clock_timestamp();
  if p_expires_at <= now_value + interval '4 minutes'
    or p_expires_at > now_value + interval '6 minutes'
  then
    raise exception 'The WhatsApp MFA test expiry is invalid.';
  end if;

  delete from private.spc_whatsapp_mfa_test_challenges as challenges
  where challenges.id in (
    select retained.id
    from private.spc_whatsapp_mfa_test_challenges as retained
    where retained.created_at < now_value - interval '30 days'
    order by retained.created_at
    limit 1000
  );

  select count(*), min(challenges.created_at)
  into daily_send_count, oldest_daily_send_at
  from private.spc_whatsapp_mfa_test_challenges as challenges
  where challenges.target_user_id = p_target_user_id
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
  from private.spc_whatsapp_mfa_test_challenges as challenges
  where challenges.target_user_id = p_target_user_id
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
  from private.spc_whatsapp_mfa_test_challenges as challenges
  where challenges.target_user_id = p_target_user_id
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

  update private.spc_whatsapp_mfa_test_challenges as challenges
  set
    invalidated_at = now_value,
    invalidation_reason = 'superseded'
  where challenges.target_user_id = p_target_user_id
    and challenges.verified_at is null
    and challenges.invalidated_at is null;

  insert into private.spc_whatsapp_mfa_test_challenges (
    id,
    target_user_id,
    created_by_user_id,
    code_hash,
    created_at,
    expires_at
  ) values (
    p_challenge_id,
    p_target_user_id,
    p_created_by_user_id,
    p_code_hash,
    now_value,
    p_expires_at
  );

  return query
  select p_challenge_id, true, 0, p_expires_at;
end;
$$;

revoke all on function public.begin_spc_whatsapp_mfa_test_challenge(
  uuid,
  uuid,
  uuid,
  text,
  timestamptz
) from public, anon, authenticated, service_role;
grant execute on function public.begin_spc_whatsapp_mfa_test_challenge(
  uuid,
  uuid,
  uuid,
  text,
  timestamptz
) to service_role;

create or replace function public.complete_spc_whatsapp_mfa_test_delivery(
  p_challenge_id uuid,
  p_created_by_user_id uuid,
  p_succeeded boolean,
  p_message_id text default null
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  now_value timestamptz;
begin
  if p_challenge_id is null
    or p_created_by_user_id is null
    or p_succeeded is null
    or (
      p_succeeded = true
      and (
        nullif(pg_catalog.btrim(p_message_id), '') is null
        or pg_catalog.length(p_message_id) > 512
        or p_message_id ~ '[[:cntrl:]]'
      )
    )
  then
    raise exception 'The WhatsApp MFA test delivery result is invalid.';
  end if;

  now_value := pg_catalog.clock_timestamp();

  update private.spc_whatsapp_mfa_test_challenges as challenges
  set
    delivery_status = case when p_succeeded then 'accepted' else 'failed' end,
    whatsapp_message_id = case
      when p_succeeded then pg_catalog.btrim(p_message_id)
      else null
    end,
    invalidated_at = case when p_succeeded then null else now_value end,
    invalidation_reason = case
      when p_succeeded then null
      else 'delivery_failed'
    end
  where challenges.id = p_challenge_id
    and challenges.created_by_user_id = p_created_by_user_id
    and challenges.delivery_status = 'pending'
    and challenges.invalidated_at is null
    and (p_succeeded = false or challenges.expires_at > now_value);

  return found;
end;
$$;

revoke all on function public.complete_spc_whatsapp_mfa_test_delivery(
  uuid,
  uuid,
  boolean,
  text
) from public, anon, authenticated, service_role;
grant execute on function public.complete_spc_whatsapp_mfa_test_delivery(
  uuid,
  uuid,
  boolean,
  text
) to service_role;

create or replace function public.verify_spc_whatsapp_mfa_test_challenge(
  p_challenge_id uuid,
  p_target_user_id uuid,
  p_created_by_user_id uuid,
  p_candidate_hash text
)
returns table (
  result text,
  attempts_remaining integer,
  challenge_expires_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  challenge private.spc_whatsapp_mfa_test_challenges%rowtype;
  now_value timestamptz;
  next_attempt_count smallint;
begin
  if p_challenge_id is null
    or p_target_user_id is null
    or p_created_by_user_id is null
    or p_candidate_hash is null
    or p_candidate_hash !~ '^[0-9a-f]{64}$'
  then
    raise exception 'The WhatsApp MFA test verification is invalid.';
  end if;

  select challenges.*
  into challenge
  from private.spc_whatsapp_mfa_test_challenges as challenges
  where challenges.id = p_challenge_id
    and challenges.created_by_user_id = p_created_by_user_id
    and challenges.target_user_id = p_target_user_id
  for update;

  now_value := pg_catalog.clock_timestamp();

  if not found or challenge.delivery_status <> 'accepted' then
    return query select 'unavailable', 0, null::timestamptz;
    return;
  end if;

  if challenge.verified_at is not null then
    return query select 'already_used', 0, challenge.expires_at;
    return;
  end if;

  if challenge.invalidated_at is not null then
    return query select
      case when challenge.invalidation_reason = 'locked' then 'locked' else 'unavailable' end,
      0,
      challenge.expires_at;
    return;
  end if;

  if challenge.expires_at <= now_value then
    update private.spc_whatsapp_mfa_test_challenges as challenges
    set
      invalidated_at = now_value,
      invalidation_reason = 'expired'
    where challenges.id = challenge.id;

    return query select 'expired', 0, challenge.expires_at;
    return;
  end if;

  if challenge.code_hash = p_candidate_hash then
    update private.spc_whatsapp_mfa_test_challenges as challenges
    set
      verified_at = now_value,
      last_attempt_at = now_value
    where challenges.id = challenge.id;

    return query select
      'verified',
      greatest(0, 5 - challenge.attempt_count)::integer,
      challenge.expires_at;
    return;
  end if;

  next_attempt_count := least(5, challenge.attempt_count + 1);
  update private.spc_whatsapp_mfa_test_challenges as challenges
  set
    attempt_count = next_attempt_count,
    last_attempt_at = now_value,
    invalidated_at = case when next_attempt_count >= 5 then now_value else null end,
    invalidation_reason = case when next_attempt_count >= 5 then 'locked' else null end
  where challenges.id = challenge.id;

  return query select
    case when next_attempt_count >= 5 then 'locked' else 'mismatch' end,
    greatest(0, 5 - next_attempt_count)::integer,
    challenge.expires_at;
end;
$$;

revoke all on function public.verify_spc_whatsapp_mfa_test_challenge(
  uuid,
  uuid,
  uuid,
  text
) from public, anon, authenticated, service_role;
grant execute on function public.verify_spc_whatsapp_mfa_test_challenge(
  uuid,
  uuid,
  uuid,
  text
) to service_role;

create or replace function public.get_active_spc_whatsapp_mfa_test_challenge(
  p_created_by_user_id uuid
)
returns table (
  challenge_id uuid,
  target_user_id uuid,
  challenge_expires_at timestamptz,
  attempts_remaining integer
)
language sql
security definer
set search_path = pg_catalog, pg_temp
as $$
  select
    challenges.id,
    challenges.target_user_id,
    challenges.expires_at,
    greatest(0, 5 - challenges.attempt_count)::integer
  from private.spc_whatsapp_mfa_test_challenges as challenges
  where challenges.created_by_user_id = p_created_by_user_id
    and challenges.delivery_status = 'accepted'
    and challenges.verified_at is null
    and challenges.invalidated_at is null
    and challenges.expires_at > pg_catalog.clock_timestamp()
  order by challenges.created_at desc
  limit 1;
$$;

revoke all on function public.get_active_spc_whatsapp_mfa_test_challenge(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_active_spc_whatsapp_mfa_test_challenge(uuid)
  to service_role;

-- Extend the existing append-only SPC audit boundary to the MFA pilot, then
-- validate the exact event shape so OTPs, hashes and full phone numbers cannot
-- be stored as audit evidence.
create or replace function private.is_spc_user_management_audit_record(
  p_record public.audit_logs
)
returns boolean
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
  select
    (
      p_record.table_schema = 'app'
      and p_record.table_name in (
        'spc_user_management_events',
        'spc_mfa_test_events'
      )
    )
    or (
      p_record.table_schema = 'public'
      and p_record.table_name in ('spc_users', 'spc_role_defaults')
    )
    or (
      p_record.table_schema = 'public'
      and p_record.table_name = 'office_calendar_store'
      and coalesce(
        p_record.record_pk ->> 'key',
        p_record.after_row ->> 'key',
        p_record.before_row ->> 'key'
      ) = 'spc-permission-groups'
    );
$$;

create or replace function private.validate_spc_mfa_test_audit_record()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
  event_status text := new.after_row ->> 'status';
  event_outcome text := new.after_row ->> 'outcome';
  source_ip_value text := new.request_context ->> 'sourceIp';
begin
  if new.table_schema is distinct from 'app'
    or new.table_name is distinct from 'spc_mfa_test_events'
    or new.operation is distinct from 'INSERT'
    or new.actor_user_id is null
    or new.actor_source is distinct from 'app'
    or coalesce(new.actor_id, '') !~ '^spc:.+'
    or nullif(pg_catalog.btrim(new.actor_name), '') is null
    or pg_catalog.length(new.actor_id) > 324
    or pg_catalog.length(new.actor_name) > 256
    or new.before_row is not null
    or new.changed_fields is distinct from array['status', 'outcome']::text[]
    or new.undo_of_log_id is not null
    or new.undone_at is not null
    or new.undone_by_log_id is not null
    or pg_catalog.jsonb_typeof(new.record_pk) is distinct from 'object'
    or not (new.record_pk ?& array['requestId', 'status', 'challengeId'])
    or (new.record_pk - array['requestId', 'status', 'challengeId']) <> '{}'::jsonb
    or coalesce(new.record_pk ->> 'requestId', '')
      !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or coalesce(new.record_pk ->> 'challengeId', '')
      !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or pg_catalog.jsonb_typeof(new.after_row) is distinct from 'object'
    or not (
      new.after_row ?& array[
        'schema',
        'title',
        'action',
        'status',
        'outcome',
        'target_id',
        'target_username'
      ]
    )
    or (
      new.after_row - array[
        'schema',
        'title',
        'action',
        'status',
        'outcome',
        'target_id',
        'target_username',
        'phone_hint',
        'whatsapp_message_id'
      ]
    ) <> '{}'::jsonb
    or new.after_row ->> 'schema'
      is distinct from 'fcuno.spc-whatsapp-mfa-test-audit/v1'
    or new.after_row ->> 'title' is distinct from 'WhatsApp MFA test'
    or coalesce(new.after_row ->> 'action', '') not in (
      'send-whatsapp-mfa-test-code',
      'verify-whatsapp-mfa-test-code'
    )
    or event_status is null
    or event_outcome is null
    or event_status not in (
      'challenge_created',
      'delivery_accepted',
      'delivery_failed',
      'activation_failed',
      'verification_requested',
      'verified',
      'mismatch',
      'locked',
      'expired',
      'already_used',
      'unavailable'
    )
    or event_outcome not in ('success', 'failed')
    or (
      event_status in (
        'challenge_created',
        'delivery_accepted',
        'verification_requested',
        'verified'
      )
      and event_outcome <> 'success'
    )
    or (
      event_status in (
        'delivery_failed',
        'activation_failed',
        'mismatch',
        'locked',
        'expired',
        'already_used',
        'unavailable'
      )
      and event_outcome <> 'failed'
    )
    or new.record_pk ->> 'status' is distinct from event_status
    or coalesce(new.after_row ->> 'target_id', '')
      !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or pg_catalog.lower(coalesce(new.after_row ->> 'target_username', ''))
      <> 'mfa_test'
    or (
      new.after_row ? 'phone_hint'
      and coalesce(new.after_row ->> 'phone_hint', '')
        !~ '^\+[0-9]{1,2}•+[0-9]{4}$'
    )
    or (
      new.after_row ? 'whatsapp_message_id'
      and (
        nullif(pg_catalog.btrim(new.after_row ->> 'whatsapp_message_id'), '') is null
        or pg_catalog.length(new.after_row ->> 'whatsapp_message_id') > 512
        or new.after_row ->> 'whatsapp_message_id' ~ '[[:cntrl:]]'
      )
    )
    or pg_catalog.jsonb_typeof(new.request_context) is distinct from 'object'
    or not (
      new.request_context ?& array[
        'pageId',
        'pageLabel',
        'pagePath',
        'correlationId',
        'requestId',
        'actorRole',
        'action',
        'targetType',
        'targetId',
        'targetUsername',
        'outcome'
      ]
    )
    or (
      new.request_context - array[
        'pageId',
        'pageLabel',
        'pagePath',
        'sourceIp',
        'correlationId',
        'requestId',
        'platformRequestId',
        'actorRole',
        'action',
        'targetType',
        'targetId',
        'targetUsername',
        'outcome'
      ]
    ) <> '{}'::jsonb
    or new.request_context ->> 'pageId' is distinct from 'spc-mfa-test'
    or new.request_context ->> 'pageLabel' is distinct from 'SPC MFA TEST'
    or new.request_context ->> 'pagePath' is distinct from '/spc/mfa-test'
    or new.request_context ->> 'actorRole' is distinct from 'ADMIN'
    or new.request_context ->> 'targetType' is distinct from 'spc-user'
    or new.request_context ->> 'requestId'
      is distinct from new.record_pk ->> 'requestId'
    or coalesce(new.request_context ->> 'correlationId', '')
      !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or new.request_context ->> 'correlationId'
      is distinct from new.request_context ->> 'requestId'
    or new.request_context ->> 'action'
      is distinct from new.after_row ->> 'action'
    or new.request_context ->> 'targetId'
      is distinct from new.after_row ->> 'target_id'
    or new.request_context ->> 'targetUsername'
      is distinct from new.after_row ->> 'target_username'
    or new.request_context ->> 'outcome' is distinct from event_outcome
    or (
      new.request_context ? 'platformRequestId'
      and pg_catalog.jsonb_typeof(new.request_context -> 'platformRequestId') <> 'null'
      and (
        coalesce(new.request_context ->> 'platformRequestId', '')
          !~ '^[A-Za-z0-9._:-]+$'
        or pg_catalog.length(new.request_context ->> 'platformRequestId') > 256
      )
    )
  then
    raise exception 'Invalid SPC WhatsApp MFA test audit event.';
  end if;

  if source_ip_value is not null then
    if position('/' in source_ip_value) > 0 then
      raise exception 'Invalid SPC WhatsApp MFA test audit source IP.';
    end if;
    begin
      perform source_ip_value::inet;
    exception
      when others then
        raise exception 'Invalid SPC WhatsApp MFA test audit source IP.';
    end;
  end if;

  return new;
end;
$$;

revoke all on function private.is_spc_user_management_audit_record(public.audit_logs)
  from public, anon, authenticated;
revoke all on function private.validate_spc_mfa_test_audit_record()
  from public, anon, authenticated;

drop trigger if exists validate_spc_mfa_test_audit_record
  on public.audit_logs;
create trigger validate_spc_mfa_test_audit_record
before insert on public.audit_logs
for each row
when (
  new.table_schema = 'app'
  and new.table_name = 'spc_mfa_test_events'
)
execute function private.validate_spc_mfa_test_audit_record();
