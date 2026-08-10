create extension if not exists "pgcrypto";

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to service_role;

create sequence if not exists public.spc_enquiry_number_seq;

create table if not exists public.spc_users (
  id uuid primary key default gen_random_uuid(),
  username text not null,
  display_name text,
  whatsapp_phone text
    check (whatsapp_phone is null or whatsapp_phone ~ '^[1-9][0-9]{7,14}$'),
  role text not null default 'buyer_trader'
    check (role in ('buyer_trader', 'supplier_trader')),
  password_hash text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists spc_users_username_lower_key
on public.spc_users(lower(username));

create table if not exists public.spc_sessions (
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

create index if not exists spc_sessions_active_user_idx
  on public.spc_sessions(spc_user_id, expires_at)
  where revoked_at is null;

create table if not exists private.spc_login_attempts (
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
  blocked_count bigint not null default 0,
  last_blocked_at timestamptz,
  constraint spc_login_attempts_username_hash_format
    check (username_hash ~ '^[0-9a-f]{64}$'),
  constraint spc_login_attempts_lifecycle
    check (
      (outcome = 'pending' and completed_at is null)
      or (
        outcome <> 'pending'
        and completed_at is not null
        and completed_at >= started_at
      )
    )
);

alter table private.spc_login_attempts
  add column if not exists blocked_count bigint not null default 0,
  add column if not exists last_blocked_at timestamptz;

update private.spc_login_attempts
set
  blocked_count = 1,
  last_blocked_at = coalesce(completed_at, started_at)
where outcome = 'blocked'
  and (blocked_count = 0 or last_blocked_at is null);

alter table private.spc_login_attempts
  drop constraint if exists spc_login_attempts_outcome,
  drop constraint if exists spc_login_attempts_failure_reason,
  drop constraint if exists spc_login_attempts_block_state;

update private.spc_login_attempts
set outcome = 'system_error'
where outcome = 'failed'
  and failure_reason = 'stale_pending';

alter table private.spc_login_attempts
  add constraint spc_login_attempts_outcome
    check (outcome in ('pending', 'succeeded', 'failed', 'blocked', 'system_error')),
  add constraint spc_login_attempts_failure_reason
    check (
      (
        outcome = 'failed'
        and failure_reason is not null
        and failure_reason = 'credentials_rejected'
      )
      or (
        outcome = 'system_error'
        and failure_reason is not null
        and failure_reason in (
          'authentication_unavailable',
          'attempt_monitoring_unavailable',
          'session_unavailable',
          'stale_pending'
        )
      )
      or (
        outcome not in ('failed', 'system_error')
        and failure_reason is null
      )
    ),
  add constraint spc_login_attempts_block_state
    check (
      (
        outcome = 'blocked'
        and blocked_by is not null
        and blocked_by in ('username', 'source_ip', 'username_and_source_ip')
        and retry_after_seconds between 1 and 900
        and blocked_count >= 1
        and last_blocked_at is not null
        and last_blocked_at >= started_at
      )
      or (
        outcome <> 'blocked'
        and blocked_by is null
        and retry_after_seconds = 0
        and blocked_count = 0
        and last_blocked_at is null
      )
    );

create unique index if not exists spc_login_attempts_request_id_idx
  on private.spc_login_attempts(request_id);
create index if not exists spc_login_attempts_username_pressure_idx
  on private.spc_login_attempts(username_hash, started_at)
  where outcome in ('pending', 'failed');
create index if not exists spc_login_attempts_source_ip_pressure_idx
  on private.spc_login_attempts(source_ip, started_at)
  where outcome in ('pending', 'failed');
create index if not exists spc_login_attempts_started_at_idx
  on private.spc_login_attempts(started_at);
create index if not exists spc_login_attempts_pending_started_at_idx
  on private.spc_login_attempts(started_at)
  where outcome = 'pending';
create index if not exists spc_login_attempts_blocked_username_idx
  on private.spc_login_attempts(blocked_by, username_hash, last_blocked_at desc)
  where outcome = 'blocked';
create index if not exists spc_login_attempts_blocked_source_ip_idx
  on private.spc_login_attempts(blocked_by, source_ip, last_blocked_at desc)
  where outcome = 'blocked';

alter table private.spc_login_attempts enable row level security;
drop policy if exists "spc_login_attempts_no_public_access"
  on private.spc_login_attempts;
create policy "spc_login_attempts_no_public_access"
  on private.spc_login_attempts
  for all
  using (false)
  with check (false);

revoke all privileges on table private.spc_login_attempts
  from public, anon, authenticated, service_role;
grant select, insert, update, delete on table private.spc_login_attempts
  to service_role;

create table if not exists public.spc_enquiries (
  id uuid primary key default gen_random_uuid(),
  enquiry_number text not null default (
    'SPC-' ||
    to_char(now() at time zone 'Asia/Hong_Kong', 'YYYYMMDD') ||
    '-' ||
    lpad(nextval('public.spc_enquiry_number_seq')::text, 4, '0')
  ),
  title text not null,
  vessel_name text,
  port text,
  product text,
  quantity text,
  delivery_date date,
  supplier_name text,
  status text not null default 'draft'
    check (status in ('draft', 'sent', 'quoted', 'closed', 'cancelled')),
  notes text,
  created_by_username text not null,
  created_by_display_name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists spc_enquiries_enquiry_number_key
on public.spc_enquiries(enquiry_number);

create index if not exists spc_enquiries_created_at_idx
on public.spc_enquiries(created_at desc);

create index if not exists spc_enquiries_created_by_idx
on public.spc_enquiries(created_by_username, created_at desc);

create table if not exists public.spc_fixtures (
  id uuid primary key default gen_random_uuid(),
  enquiry_id uuid not null,
  fixture_status text not null default 'pending'
    check (fixture_status in ('pending', 'completed', 'cancelled')),
  fixture_date date default ((now() at time zone 'Asia/Hong_Kong')::date),
  supplier_trader_user_id uuid,
  supplier_trader_username text not null,
  supplier_trader_display_name text not null,
  buyer_trader_user_id uuid,
  buyer_trader_username text not null,
  buyer_trader_display_name text not null,
  account text,
  commission text,
  earliest_eta text,
  vessel_name text,
  hsfo text,
  vlsfo text,
  lsmgo text,
  supplier_name text,
  supplier_key text,
  price text,
  barging text,
  completed_at timestamptz,
  completed_by_username text,
  completed_by_display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint spc_fixtures_enquiry_id_fkey
    foreign key (enquiry_id) references public.spc_enquiries(id) on delete cascade,
  constraint spc_fixtures_supplier_trader_user_id_fkey
    foreign key (supplier_trader_user_id) references public.spc_users(id) on delete set null,
  constraint spc_fixtures_buyer_trader_user_id_fkey
    foreign key (buyer_trader_user_id) references public.spc_users(id) on delete set null
);

create unique index if not exists spc_fixtures_enquiry_id_key
on public.spc_fixtures(enquiry_id);

create index if not exists spc_fixtures_status_created_idx
on public.spc_fixtures(fixture_status, created_at desc);

create index if not exists spc_fixtures_supplier_key_idx
on public.spc_fixtures(supplier_key);

create index if not exists spc_fixtures_supplier_trader_user_id_idx
on public.spc_fixtures(supplier_trader_user_id);

create index if not exists spc_fixtures_buyer_trader_user_id_idx
on public.spc_fixtures(buyer_trader_user_id);

create index if not exists spc_fixtures_traders_idx
on public.spc_fixtures(supplier_trader_username, buyer_trader_username);

create table if not exists public.spc_suppliers (
  key text primary key,
  name text not null,
  aliases text[] not null default '{}',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by_username text,
  updated_by_username text
);

create index if not exists spc_suppliers_name_idx
on public.spc_suppliers(name);

create table if not exists public.spc_presentation_chunks (
  id uuid primary key default gen_random_uuid(),
  slug text not null,
  sort_order integer not null default 0,
  section_label text not null default 'CHAPTER',
  title text not null,
  summary text not null default '',
  narration text not null default '',
  key_points text[] not null default '{}',
  q_and_a_prompt text not null default '',
  visual_kind text not null default 'video',
  visual_copy jsonb not null default '[]'::jsonb,
  video_path text,
  video_mime_type text,
  video_bytes bigint,
  narration_path text,
  narration_mime_type text,
  narration_bytes bigint,
  duration_seconds integer,
  media_version integer not null default 1,
  revision integer not null default 1,
  status text not null default 'draft'
    check (status in ('draft', 'published')),
  created_by_username text,
  updated_by_username text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint spc_presentation_chunks_duration_check
    check (duration_seconds is null or duration_seconds between 0 and 3600),
  constraint spc_presentation_chunks_media_version_check
    check (media_version > 0),
  constraint spc_presentation_chunks_revision_check
    check (revision > 0),
  constraint spc_presentation_chunks_visual_copy_check
    check (jsonb_typeof(visual_copy) = 'array')
);

create unique index if not exists spc_presentation_chunks_slug_key
on public.spc_presentation_chunks(lower(slug));

create index if not exists spc_presentation_chunks_status_order_idx
on public.spc_presentation_chunks(status, sort_order, created_at);

create or replace function public.set_spc_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_spc_users_updated_at on public.spc_users;
create trigger set_spc_users_updated_at
before update on public.spc_users
for each row
execute function public.set_spc_updated_at();

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

create or replace function public.cleanup_spc_login_attempts()
returns integer
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  deleted_count integer;
begin
  delete from private.spc_login_attempts as attempts
  where attempts.id in (
    select expired.id
    from private.spc_login_attempts as expired
    where (
      case
        when expired.outcome = 'blocked'
          then coalesce(expired.last_blocked_at, expired.started_at)
        else expired.started_at
      end
    ) < clock_timestamp() - interval '30 days'
    order by (
      case
        when expired.outcome = 'blocked'
          then coalesce(expired.last_blocked_at, expired.started_at)
        else expired.started_at
      end
    )
    limit 10000
  );

  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

revoke all on function public.cleanup_spc_login_attempts()
  from public, anon, authenticated, service_role;
grant execute on function public.cleanup_spc_login_attempts()
  to service_role;

drop function if exists public.begin_spc_login_attempt(text, inet, uuid);

create function public.begin_spc_login_attempt(
  p_username_hash text,
  p_source_ip inet,
  p_request_id uuid
)
returns table (
  attempt_id uuid,
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
  now_value timestamptz;
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
  blocked_attempt_id uuid;
  blocked_count_value bigint;
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

  perform pg_advisory_xact_lock(
    least(username_lock_key, source_ip_lock_key)
  );
  if username_lock_key <> source_ip_lock_key then
    perform pg_advisory_xact_lock(
      greatest(username_lock_key, source_ip_lock_key)
    );
  end if;

  now_value := clock_timestamp();

  update private.spc_login_attempts as attempts
  set
    outcome = 'system_error',
    failure_reason = 'stale_pending',
    completed_at = now_value
  where attempts.outcome = 'pending'
    and attempts.started_at <= now_value - pending_timeout_value
    and (
      attempts.username_hash = p_username_hash
      or attempts.source_ip = p_source_ip
    );

  delete from private.spc_login_attempts as attempts
  where attempts.id in (
    select retained.id
    from private.spc_login_attempts as retained
    where (
      case
        when retained.outcome = 'blocked'
          then coalesce(retained.last_blocked_at, retained.started_at)
        else retained.started_at
      end
    ) < now_value - retention_value
    order by (
      case
        when retained.outcome = 'blocked'
          then coalesce(retained.last_blocked_at, retained.started_at)
        else retained.started_at
      end
    )
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

    select attempts.id
    into blocked_attempt_id
    from private.spc_login_attempts as attempts
    where attempts.outcome = 'blocked'
      and attempts.blocked_by = blocked_by_value
      and attempts.last_blocked_at > now_value - window_value
      and (
        (
          blocked_by_value = 'username'
          and attempts.username_hash = p_username_hash
        )
        or (
          blocked_by_value = 'source_ip'
          and attempts.source_ip = p_source_ip
        )
        or (
          blocked_by_value = 'username_and_source_ip'
          and attempts.username_hash = p_username_hash
          and attempts.source_ip = p_source_ip
        )
      )
    order by attempts.last_blocked_at desc
    limit 1
    for update;

    if found then
      update private.spc_login_attempts as attempts
      set
        username_hash = p_username_hash,
        source_ip = p_source_ip,
        request_id = p_request_id,
        completed_at = now_value,
        retry_after_seconds = retry_after_value,
        blocked_count = attempts.blocked_count + 1,
        last_blocked_at = now_value
      where attempts.id = blocked_attempt_id
      returning attempts.id, attempts.blocked_count
      into attempt_id, blocked_count_value;
    else
      insert into private.spc_login_attempts as attempts (
        username_hash,
        source_ip,
        request_id,
        started_at,
        completed_at,
        outcome,
        blocked_by,
        retry_after_seconds,
        blocked_count,
        last_blocked_at
      )
      values (
        p_username_hash,
        p_source_ip,
        p_request_id,
        now_value,
        now_value,
        'blocked',
        blocked_by_value,
        retry_after_value,
        1,
        now_value
      )
      returning attempts.id, attempts.blocked_count
      into attempt_id, blocked_count_value;
    end if;

    allowed := false;
    retry_after_seconds := retry_after_value;
    blocked_by := blocked_by_value;
    blocked_count := blocked_count_value::text;
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
  blocked_count := '0';
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
  now_value timestamptz;
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

  now_value := clock_timestamp();

  if started_at_value <= now_value - pending_timeout_value then
    update private.spc_login_attempts as attempts
    set
      outcome = 'system_error',
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

create or replace function public.cancel_spc_login_attempt(
  p_attempt_id uuid,
  p_reason text
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  username_hash_value text;
  source_ip_value inet;
  username_lock_key bigint;
  source_ip_lock_key bigint;
  cancelled_value boolean;
begin
  if p_attempt_id is null
    or p_reason is null
    or p_reason not in (
      'authentication_unavailable',
      'attempt_monitoring_unavailable',
      'session_unavailable'
    )
  then
    raise exception 'A pending attempt and supported system-error reason are required.';
  end if;

  select attempts.username_hash, attempts.source_ip
  into username_hash_value, source_ip_value
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

  update private.spc_login_attempts as attempts
  set
    outcome = 'system_error',
    failure_reason = p_reason,
    completed_at = clock_timestamp()
  where attempts.id = p_attempt_id
    and attempts.outcome = 'pending'
  returning true into cancelled_value;

  return coalesce(cancelled_value, false);
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

revoke all on function public.cancel_spc_login_attempt(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.cancel_spc_login_attempt(uuid, text)
  to service_role;

drop trigger if exists set_spc_enquiries_updated_at on public.spc_enquiries;
create trigger set_spc_enquiries_updated_at
before update on public.spc_enquiries
for each row
execute function public.set_spc_updated_at();

drop trigger if exists set_spc_fixtures_updated_at on public.spc_fixtures;
create trigger set_spc_fixtures_updated_at
before update on public.spc_fixtures
for each row
execute function public.set_spc_updated_at();

drop trigger if exists set_spc_suppliers_updated_at on public.spc_suppliers;
create trigger set_spc_suppliers_updated_at
before update on public.spc_suppliers
for each row
execute function public.set_spc_updated_at();

drop trigger if exists set_spc_presentation_chunks_updated_at on public.spc_presentation_chunks;
create trigger set_spc_presentation_chunks_updated_at
before update on public.spc_presentation_chunks
for each row
execute function public.set_spc_updated_at();

alter table public.spc_users enable row level security;
alter table public.spc_sessions enable row level security;
alter table public.spc_enquiries enable row level security;
alter table public.spc_fixtures enable row level security;
alter table public.spc_suppliers enable row level security;
alter table public.spc_presentation_chunks enable row level security;

drop policy if exists "spc_users_no_public_access" on public.spc_users;
create policy "spc_users_no_public_access"
  on public.spc_users
  for all
  using (false)
  with check (false);

drop policy if exists "spc_sessions_no_public_access" on public.spc_sessions;
create policy "spc_sessions_no_public_access"
  on public.spc_sessions
  for all
  using (false)
  with check (false);

drop policy if exists "spc_enquiries_no_public_access" on public.spc_enquiries;
create policy "spc_enquiries_no_public_access"
  on public.spc_enquiries
  for all
  using (false)
  with check (false);

drop policy if exists "spc_fixtures_no_public_access" on public.spc_fixtures;
create policy "spc_fixtures_no_public_access"
  on public.spc_fixtures
  for all
  using (false)
  with check (false);

drop policy if exists "spc_suppliers_no_public_access" on public.spc_suppliers;
create policy "spc_suppliers_no_public_access"
  on public.spc_suppliers
  for all
  using (false)
  with check (false);

drop policy if exists "spc_presentation_chunks_no_public_access" on public.spc_presentation_chunks;
create policy "spc_presentation_chunks_no_public_access"
  on public.spc_presentation_chunks
  for all
  using (false)
  with check (false);

revoke all on table public.spc_users from anon, authenticated;
revoke all privileges on table public.spc_sessions
from public, anon, authenticated, service_role;
grant select, update, delete on table public.spc_sessions
to service_role;
revoke all on table public.spc_enquiries from anon, authenticated;
revoke all on table public.spc_fixtures from anon, authenticated;
revoke all on table public.spc_suppliers from anon, authenticated;
revoke all on table public.spc_presentation_chunks from anon, authenticated;
revoke all on sequence public.spc_enquiry_number_seq from anon, authenticated;

grant select, insert, update, delete on table public.spc_users to service_role;
grant select, insert, update, delete on table public.spc_enquiries to service_role;
grant select, insert, update, delete on table public.spc_fixtures to service_role;
grant select, insert, update, delete on table public.spc_suppliers to service_role;
grant select, insert, update, delete on table public.spc_presentation_chunks to service_role;
grant usage, select on sequence public.spc_enquiry_number_seq to service_role;

do $$
begin
  if to_regprocedure('public.audit_enable_table(regclass)') is not null then
    perform public.audit_enable_table('public.spc_users'::regclass);
    perform public.audit_enable_table('public.spc_enquiries'::regclass);
    perform public.audit_enable_table('public.spc_fixtures'::regclass);
    perform public.audit_enable_table('public.spc_suppliers'::regclass);
    perform public.audit_enable_table('public.spc_presentation_chunks'::regclass);
  end if;
end $$;

-- Make SPC user rows and their role/profile metadata one atomic security
-- boundary. The advisory lock serializes every affected write, while the
-- deferred triggers protect equivalent direct writes and audit-log undo.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create or replace function private.normalise_spc_effective_role(raw_role text)
returns text
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  with cleaned as (
    select pg_catalog.left(
      pg_catalog.upper(
        pg_catalog.regexp_replace(
          pg_catalog.regexp_replace(
            pg_catalog.btrim(coalesce(raw_role, '')),
            '[_-]+',
            ' ',
            'g'
          ),
          '[[:space:]]+',
          ' ',
          'g'
        )
      ),
      40
    ) as role
  )
  select case
    when role in ('', 'BUYER', 'BUYER TRADER') then 'BUYER TRADER'
    when role in ('SUPPLIER', 'SUPPLIER TRADER') then 'SUPPLIER TRADER'
    when role in ('ADMIN', 'ADMINISTRATOR') then 'ADMIN'
    else role
  end
  from cleaned;
$$;

create or replace function private.spc_effective_role(
  p_user_id uuid,
  p_username text,
  p_database_role text,
  p_store_payload jsonb
)
returns text
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  with assignments as (
    select assignment.value, assignment.ordinality
    from pg_catalog.jsonb_array_elements(
      case
        when pg_catalog.jsonb_typeof(p_store_payload -> 'userRoles') = 'array'
          then p_store_payload -> 'userRoles'
        else '[]'::jsonb
      end
    ) with ordinality as assignment(value, ordinality)
  ), selected_role as (
    select assignment.value ->> 'role' as role
    from assignments as assignment
    where assignment.value ->> 'userId' = p_user_id::text
    order by assignment.ordinality desc
    limit 1
  ), selected_username_role as (
    select assignment.value ->> 'role' as role
    from assignments as assignment
    where pg_catalog.lower(assignment.value ->> 'username') =
      pg_catalog.lower(p_username)
    order by assignment.ordinality desc
    limit 1
  )
  select private.normalise_spc_effective_role(
    coalesce(
      (select role from selected_role),
      (select role from selected_username_role),
      p_database_role
    )
  );
$$;

create or replace function private.lock_spc_user_administration()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if tg_table_name = 'office_calendar_store'
    and coalesce(to_jsonb(new) ->> 'key', '') <> 'spc-permission-groups'
    and coalesce(to_jsonb(old) ->> 'key', '') <> 'spc-permission-groups'
  then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('spc-user-administration', 0)
  );

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create or replace function private.assert_spc_active_admin()
returns void
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  store_payload jsonb := '{}'::jsonb;
begin
  select store.payload
  into store_payload
  from public.office_calendar_store as store
  where store.key = 'spc-permission-groups';

  if not exists (
    select 1
    from public.spc_users as users
    where users.is_active
      and private.spc_effective_role(
        users.id,
        users.username,
        users.role,
        coalesce(store_payload, '{}'::jsonb)
      ) = 'ADMIN'
  ) then
    raise exception
      'The final active ADMIN cannot be demoted, deactivated, or deleted.';
  end if;
end;
$$;

create or replace function private.enforce_spc_active_admin_continuity()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if tg_table_name = 'office_calendar_store'
    and coalesce(to_jsonb(new) ->> 'key', '') <> 'spc-permission-groups'
    and coalesce(to_jsonb(old) ->> 'key', '') <> 'spc-permission-groups'
  then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  perform private.assert_spc_active_admin();

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists lock_spc_user_administration
  on public.spc_users;
create trigger lock_spc_user_administration
before insert or update or delete on public.spc_users
for each row
execute function private.lock_spc_user_administration();

drop trigger if exists enforce_spc_active_admin_continuity
  on public.spc_users;
create constraint trigger enforce_spc_active_admin_continuity
after insert or update or delete on public.spc_users
deferrable initially deferred
for each row
execute function private.enforce_spc_active_admin_continuity();

drop trigger if exists lock_spc_permission_store_administration
  on public.office_calendar_store;
create trigger lock_spc_permission_store_administration
before insert or update or delete on public.office_calendar_store
for each row
execute function private.lock_spc_user_administration();

drop trigger if exists enforce_spc_permission_store_admin_continuity
  on public.office_calendar_store;
create constraint trigger enforce_spc_permission_store_admin_continuity
after insert or update or delete on public.office_calendar_store
deferrable initially deferred
for each row
execute function private.enforce_spc_active_admin_continuity();

create or replace function public.save_spc_user_with_admin_continuity(
  p_user_id uuid,
  p_username text,
  p_display_name text,
  p_whatsapp_phone text,
  p_database_role text,
  p_effective_role text,
  p_office text,
  p_must_change_password boolean,
  p_is_supplier_trader boolean,
  p_password_hash text,
  p_is_active boolean
)
returns table (
  id uuid,
  username text,
  display_name text,
  whatsapp_phone text,
  role text,
  is_active boolean,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  current_time_value constant timestamptz := pg_catalog.clock_timestamp();
  target_id uuid := p_user_id;
  is_new constant boolean := p_user_id is null;
  existing_user public.spc_users%rowtype;
  previous_username text;
  clean_username text := pg_catalog.btrim(coalesce(p_username, ''));
  clean_display_name text;
  clean_database_role text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_database_role, '')));
  clean_effective_role text := private.normalise_spc_effective_role(p_effective_role);
  clean_office text;
  store_payload jsonb := '{}'::jsonb;
  role_assignments jsonb := '[]'::jsonb;
  profile_assignments jsonb := '[]'::jsonb;
  office_assignments jsonb := '[]'::jsonb;
  previous_profile jsonb;
  effective_must_change_password boolean;
  effective_supplier_trader boolean;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('spc-user-administration', 0)
  );

  if clean_username = '' then
    raise exception 'Username is required.';
  end if;
  if pg_catalog.length(clean_username) > 320 then
    raise exception 'Username must contain no more than 320 characters.';
  end if;
  if clean_database_role not in ('buyer_trader', 'supplier_trader') then
    raise exception 'Select a valid permission group.';
  end if;
  if clean_effective_role = '' then
    raise exception 'Select a valid permission group.';
  end if;
  if p_whatsapp_phone is not null
    and p_whatsapp_phone !~ '^[1-9][0-9]{7,14}$'
  then
    raise exception 'WhatsApp phone must include a valid country code.';
  end if;
  if p_password_hash is not null
    and p_password_hash !~ '^scrypt:[0-9a-f]{32}:[0-9a-f]{128}$'
  then
    raise exception 'The password credential is invalid.';
  end if;
  if is_new and p_password_hash is null then
    raise exception 'Password is required for a new user.';
  end if;

  if not is_new then
    select users.*
    into existing_user
    from public.spc_users as users
    where users.id = p_user_id
    for update;

    if not found then
      raise exception 'User not found.';
    end if;
    previous_username := existing_user.username;
  else
    previous_username := clean_username;
  end if;

  select store.payload
  into store_payload
  from public.office_calendar_store as store
  where store.key = 'spc-permission-groups'
  for update;

  if not found or pg_catalog.jsonb_typeof(store_payload) <> 'object' then
    store_payload := '{}'::jsonb;
  end if;

  select profile.value
  into previous_profile
  from pg_catalog.jsonb_array_elements(
    case
      when pg_catalog.jsonb_typeof(store_payload -> 'userProfiles') = 'array'
        then store_payload -> 'userProfiles'
      else '[]'::jsonb
    end
  ) with ordinality as profile(value, ordinality)
  where profile.value ->> 'userId' = target_id::text
    or pg_catalog.lower(profile.value ->> 'username') =
      pg_catalog.lower(previous_username)
  order by
    (profile.value ->> 'userId' = target_id::text) desc,
    profile.ordinality desc
  limit 1;

  clean_display_name := coalesce(
    nullif(pg_catalog.btrim(p_display_name), ''),
    clean_username
  );
  if pg_catalog.length(clean_display_name) > 256 then
    raise exception 'Display name must contain no more than 256 characters.';
  end if;
  clean_office := pg_catalog.upper(
    pg_catalog.regexp_replace(
      pg_catalog.btrim(coalesce(p_office, previous_profile ->> 'office', '')),
      '[[:space:]]+',
      ' ',
      'g'
    )
  );
  if clean_office = '' then clean_office := 'ITALY'; end if;
  if pg_catalog.length(clean_office) > 128 then
    raise exception 'Office must contain no more than 128 characters.';
  end if;

  effective_must_change_password := case
    when is_new then true
    when p_must_change_password is not null then p_must_change_password
    else coalesce(previous_profile ->> 'mustChangePassword', 'false') = 'true'
  end;
  effective_supplier_trader := case
    when clean_effective_role = 'SUPPLIER TRADER' then true
    when p_is_supplier_trader is not null then p_is_supplier_trader
    else coalesce(previous_profile ->> 'isSupplierTrader', 'false') = 'true'
  end;

  if is_new then
    insert into public.spc_users (
      username,
      display_name,
      whatsapp_phone,
      role,
      password_hash,
      is_active,
      created_at,
      updated_at
    ) values (
      clean_username,
      clean_display_name,
      p_whatsapp_phone,
      clean_database_role,
      p_password_hash,
      coalesce(p_is_active, true),
      current_time_value,
      current_time_value
    )
    returning spc_users.id into target_id;
  else
    update public.spc_users as users
    set username = clean_username,
        display_name = clean_display_name,
        whatsapp_phone = p_whatsapp_phone,
        role = clean_database_role,
        password_hash = coalesce(p_password_hash, users.password_hash),
        is_active = coalesce(p_is_active, true),
        updated_at = current_time_value
    where users.id = target_id;
  end if;

  select coalesce(
    pg_catalog.jsonb_agg(role_item.value order by role_item.ordinality),
    '[]'::jsonb
  )
  into role_assignments
  from pg_catalog.jsonb_array_elements(
    case
      when pg_catalog.jsonb_typeof(store_payload -> 'userRoles') = 'array'
        then store_payload -> 'userRoles'
      else '[]'::jsonb
    end
  ) with ordinality as role_item(value, ordinality)
  where role_item.value ->> 'userId' <> target_id::text
    and pg_catalog.lower(role_item.value ->> 'username') not in (
      pg_catalog.lower(previous_username),
      pg_catalog.lower(clean_username)
    );

  if clean_effective_role <>
    private.normalise_spc_effective_role(clean_database_role)
  then
    role_assignments := role_assignments || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'userId', target_id,
        'username', clean_username,
        'role', clean_effective_role,
        'updatedAt', current_time_value
      )
    );
  end if;

  select coalesce(
    pg_catalog.jsonb_agg(profile_item.value order by profile_item.ordinality),
    '[]'::jsonb
  )
  into profile_assignments
  from pg_catalog.jsonb_array_elements(
    case
      when pg_catalog.jsonb_typeof(store_payload -> 'userProfiles') = 'array'
        then store_payload -> 'userProfiles'
      else '[]'::jsonb
    end
  ) with ordinality as profile_item(value, ordinality)
  where profile_item.value ->> 'userId' <> target_id::text
    and pg_catalog.lower(profile_item.value ->> 'username') not in (
      pg_catalog.lower(previous_username),
      pg_catalog.lower(clean_username)
    );

  profile_assignments := profile_assignments || pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_build_object(
      'userId', target_id,
      'username', clean_username,
      'office', clean_office,
      'mustChangePassword', effective_must_change_password,
      'isSupplierTrader', effective_supplier_trader,
      'updatedAt', current_time_value
    )
  );

  office_assignments := case
    when pg_catalog.jsonb_typeof(store_payload -> 'offices') = 'array'
      and pg_catalog.jsonb_array_length(store_payload -> 'offices') > 0
      then store_payload -> 'offices'
    else '["ITALY","HONG KONG","SINGAPORE","MONACO","FRANCE","USA","KOREA","JAPAN","VIETNAM"]'::jsonb
  end;
  if not exists (
    select 1
    from pg_catalog.jsonb_array_elements_text(office_assignments) as office(value)
    where pg_catalog.upper(pg_catalog.btrim(office.value)) = clean_office
  ) then
    office_assignments := office_assignments || pg_catalog.to_jsonb(clean_office);
  end if;

  store_payload := pg_catalog.jsonb_set(store_payload, '{userRoles}', role_assignments, true);
  store_payload := pg_catalog.jsonb_set(store_payload, '{userProfiles}', profile_assignments, true);
  store_payload := pg_catalog.jsonb_set(store_payload, '{offices}', office_assignments, true);

  insert into public.office_calendar_store (key, payload, updated_at)
  values ('spc-permission-groups', store_payload, current_time_value)
  on conflict (key) do update
  set payload = excluded.payload,
      updated_at = excluded.updated_at;

  perform private.assert_spc_active_admin();

  return query
  select
    users.id,
    users.username,
    users.display_name,
    users.whatsapp_phone,
    users.role,
    users.is_active,
    users.created_at,
    users.updated_at
  from public.spc_users as users
  where users.id = target_id;
end;
$$;

create or replace function public.delete_spc_user_with_admin_continuity(
  p_user_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  existing_user public.spc_users%rowtype;
  store_payload jsonb;
  role_assignments jsonb := '[]'::jsonb;
  profile_assignments jsonb := '[]'::jsonb;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('spc-user-administration', 0)
  );

  select users.*
  into existing_user
  from public.spc_users as users
  where users.id = p_user_id
  for update;

  if not found then
    raise exception 'User not found.';
  end if;

  select store.payload
  into store_payload
  from public.office_calendar_store as store
  where store.key = 'spc-permission-groups'
  for update;

  delete from public.spc_users as users
  where users.id = p_user_id;

  if found then
    select coalesce(
      pg_catalog.jsonb_agg(role_item.value order by role_item.ordinality),
      '[]'::jsonb
    )
    into role_assignments
    from pg_catalog.jsonb_array_elements(
      case
        when pg_catalog.jsonb_typeof(store_payload -> 'userRoles') = 'array'
          then store_payload -> 'userRoles'
        else '[]'::jsonb
      end
    ) with ordinality as role_item(value, ordinality)
    where role_item.value ->> 'userId' <> p_user_id::text
      and pg_catalog.lower(role_item.value ->> 'username') <>
        pg_catalog.lower(existing_user.username);

    select coalesce(
      pg_catalog.jsonb_agg(profile_item.value order by profile_item.ordinality),
      '[]'::jsonb
    )
    into profile_assignments
    from pg_catalog.jsonb_array_elements(
      case
        when pg_catalog.jsonb_typeof(store_payload -> 'userProfiles') = 'array'
          then store_payload -> 'userProfiles'
        else '[]'::jsonb
      end
    ) with ordinality as profile_item(value, ordinality)
    where profile_item.value ->> 'userId' <> p_user_id::text
      and pg_catalog.lower(profile_item.value ->> 'username') <>
        pg_catalog.lower(existing_user.username);

    store_payload := pg_catalog.jsonb_set(
      coalesce(store_payload, '{}'::jsonb),
      '{userRoles}',
      role_assignments,
      true
    );
    store_payload := pg_catalog.jsonb_set(
      store_payload,
      '{userProfiles}',
      profile_assignments,
      true
    );

    update public.office_calendar_store as store
    set payload = store_payload,
        updated_at = pg_catalog.clock_timestamp()
    where store.key = 'spc-permission-groups';
  end if;

  perform private.assert_spc_active_admin();
  return true;
end;
$$;

revoke all on function private.normalise_spc_effective_role(text)
  from public, anon, authenticated, service_role;
revoke all on function private.spc_effective_role(uuid, text, text, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function private.lock_spc_user_administration()
  from public, anon, authenticated, service_role;
revoke all on function private.assert_spc_active_admin()
  from public, anon, authenticated, service_role;
revoke all on function private.enforce_spc_active_admin_continuity()
  from public, anon, authenticated, service_role;

revoke all on function public.save_spc_user_with_admin_continuity(
  uuid, text, text, text, text, text, text, boolean, boolean, text, boolean
) from public, anon, authenticated, service_role;
grant execute on function public.save_spc_user_with_admin_continuity(
  uuid, text, text, text, text, text, text, boolean, boolean, text, boolean
) to service_role;

revoke all on function public.delete_spc_user_with_admin_continuity(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.delete_spc_user_with_admin_continuity(uuid)
  to service_role;

-- RLS and row triggers do not cover TRUNCATE. No application path requires it.
revoke truncate on table public.spc_users
  from public, anon, authenticated, service_role;
revoke truncate on table public.office_calendar_store
  from public, anon, authenticated, service_role;

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

-- Cover administrator-bound challenge status and verification lookups.
create index if not exists spc_whatsapp_mfa_test_actor_created_idx
  on private.spc_whatsapp_mfa_test_challenges(
    created_by_user_id,
    created_at desc
  );
