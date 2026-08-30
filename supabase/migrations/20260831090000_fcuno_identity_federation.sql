-- FCUNO is the authority for its administrative identities.  This migration is
-- deliberately additive: SPC credentials, MFA enrolment, sessions, roles, and
-- permissions remain owned by the existing SPC tables and workflows.
create extension if not exists "pgcrypto";
create schema if not exists private;

alter table public.admin_users
  add column if not exists email text,
  add column if not exists email_verified boolean not null default false,
  add column if not exists identity_revision bigint not null default 1,
  add column if not exists credential_revision bigint not null default 1,
  add column if not exists use_fcos boolean not null default false,
  add column if not exists use_spc boolean not null default false,
  add column if not exists revoked_before timestamptz not null default '1970-01-01T00:00:00Z'::timestamptz;

do $$
begin
  if exists (
    select 1
    from public.admin_users
    where username ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    group by lower(btrim(username))
    having count(*) > 1
  ) then
    raise exception 'FCUNO identity migration found duplicate email-form usernames.';
  end if;
end;
$$;

update public.admin_users
set email = lower(btrim(username)),
    email_verified = true
where email is null
  and not email_verified
  and username ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$';

update public.admin_users
set revoked_before = '1970-01-01T00:00:00Z'::timestamptz
where revoked_before = '-infinity'::timestamptz;

alter table public.admin_users
  drop constraint if exists admin_users_verified_email;
alter table public.admin_users
  add constraint admin_users_verified_email check (
    not email_verified or (
      email is not null
      and email = lower(btrim(email))
      and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    )
  );

create unique index if not exists admin_users_verified_email_lower_key
  on public.admin_users (lower(btrim(email)))
  where email_verified;

create index if not exists admin_users_fcos_identity_idx
  on public.admin_users (identity_revision)
  where use_fcos and is_active and email_verified;

create or replace function public.fcuno_set_admin_identity_revision()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
  identity_changed boolean;
  credential_changed boolean;
  access_revoked boolean;
begin
  if new.email is not null then
    new.email := lower(btrim(new.email));
  end if;

  if tg_op = 'INSERT' then
    return new;
  end if;

  identity_changed :=
    new.username is distinct from old.username
    or new.display_name is distinct from old.display_name
    or new.role is distinct from old.role
    or new.permissions is distinct from old.permissions
    or new.is_active is distinct from old.is_active
    or new.email is distinct from old.email
    or new.email_verified is distinct from old.email_verified
    or new.use_fcos is distinct from old.use_fcos
    or new.use_spc is distinct from old.use_spc
    or new.revoked_before is distinct from old.revoked_before;
  credential_changed :=
    new.password_hash is distinct from old.password_hash
    or new.password_reset_required is distinct from old.password_reset_required;
  access_revoked :=
    old.is_active and old.use_fcos and old.email_verified
    and not (new.is_active and new.use_fcos and new.email_verified);

  if identity_changed or credential_changed then
    new.identity_revision := old.identity_revision + 1;
  end if;
  if credential_changed then
    new.credential_revision := old.credential_revision + 1;
    new.revoked_before := clock_timestamp();
  elsif access_revoked then
    new.revoked_before := clock_timestamp();
  end if;

  return new;
end;
$$;

drop trigger if exists fcuno_set_admin_identity_revision on public.admin_users;
create trigger fcuno_set_admin_identity_revision
before insert or update on public.admin_users
for each row execute function public.fcuno_set_admin_identity_revision();

create table if not exists public.oidc_authorization_codes (
  id uuid primary key default gen_random_uuid(),
  code_hash text not null unique check (code_hash ~ '^[0-9a-f]{64}$'),
  admin_user_id uuid not null references public.admin_users(id) on delete cascade,
  client_id text not null check (char_length(client_id) between 1 and 200),
  redirect_uri text not null check (char_length(redirect_uri) between 1 and 2048),
  scope text not null check (char_length(scope) between 1 and 500),
  nonce text,
  code_challenge text not null check (code_challenge ~ '^[A-Za-z0-9._~-]{43,128}$'),
  identity_revision bigint not null,
  credential_revision bigint not null,
  auth_time timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  constraint oidc_authorization_codes_expiry check (expires_at > created_at),
  constraint oidc_authorization_codes_consumed check (consumed_at is null or consumed_at >= created_at)
);
create index if not exists oidc_authorization_codes_expiry_idx
  on public.oidc_authorization_codes (expires_at) where consumed_at is null;

create or replace function public.consume_oidc_authorization_code(
  p_code_hash text,
  p_client_id text,
  p_redirect_uri text,
  p_code_verifier text
)
returns table (
  admin_user_id uuid,
  client_id text,
  redirect_uri text,
  scope text,
  nonce text,
  code_challenge text,
  identity_revision bigint,
  credential_revision bigint,
  auth_time timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  return query
  update public.oidc_authorization_codes as codes
  set consumed_at = clock_timestamp()
  where codes.code_hash = p_code_hash
    and codes.client_id = p_client_id
    and codes.redirect_uri = p_redirect_uri
    and codes.code_challenge = replace(replace(replace(encode(digest(p_code_verifier, 'sha256'), 'base64'), '+', '-'), '/', '_'), '=', '')
    and codes.consumed_at is null
    and codes.expires_at > clock_timestamp()
  returning codes.admin_user_id, codes.client_id, codes.redirect_uri,
    codes.scope, codes.nonce, codes.code_challenge, codes.identity_revision,
    codes.credential_revision, codes.auth_time;
end;
$$;

create table if not exists public.oidc_token_revocations (
  jti_hash text primary key check (jti_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  revoked_at timestamptz not null default clock_timestamp()
);
create index if not exists oidc_token_revocations_expiry_idx
  on public.oidc_token_revocations (expires_at);

create table if not exists public.fcuno_identity_sync_outbox (
  id uuid primary key default gen_random_uuid(),
  admin_user_id uuid not null references public.admin_users(id) on delete cascade,
  identity_revision bigint not null,
  payload jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  delivered_at timestamptz,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  next_attempt_at timestamptz not null default clock_timestamp(),
  lease_token uuid,
  lease_expires_at timestamptz,
  last_error text,
  unique (admin_user_id, identity_revision)
);
create index if not exists fcuno_identity_sync_outbox_pending_idx
  on public.fcuno_identity_sync_outbox (next_attempt_at, created_at)
  where delivered_at is null;

create table if not exists public.fcuno_identity_audit (
  id uuid primary key default gen_random_uuid(),
  admin_user_id uuid references public.admin_users(id) on delete set null,
  event_type text not null check (char_length(event_type) between 1 and 100),
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default clock_timestamp()
);
create index if not exists fcuno_identity_audit_user_created_idx
  on public.fcuno_identity_audit (admin_user_id, created_at desc);

create or replace function public.fcuno_reject_identity_audit_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  raise exception 'fcuno_identity_audit is append-only';
end;
$$;
drop trigger if exists fcuno_reject_identity_audit_mutation on public.fcuno_identity_audit;
create trigger fcuno_reject_identity_audit_mutation
before update or delete on public.fcuno_identity_audit
for each row execute function public.fcuno_reject_identity_audit_mutation();

create or replace function public.fcuno_enqueue_identity_sync()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if tg_op = 'UPDATE' and new.identity_revision = old.identity_revision then
    return new;
  end if;

  if new.email_verified and new.email is not null then
    insert into public.fcuno_identity_sync_outbox (
      admin_user_id, identity_revision, payload
    ) values (
      new.id,
      new.identity_revision,
      jsonb_build_object(
        'sub', new.id::text,
        'username', new.username,
        'email', new.email,
        'email_verified', true,
        'display_name', coalesce(new.display_name, new.username),
        'is_active', new.is_active,
        'use_fcos', new.use_fcos,
        'use_spc', new.use_spc,
        'identity_revision', new.identity_revision,
        'credential_revision', new.credential_revision,
        'revoked_before', new.revoked_before
      )
    ) on conflict (admin_user_id, identity_revision) do nothing;
  elsif tg_op = 'UPDATE' and old.email_verified and old.email is not null then
    -- Losing email verification must revoke a previously projected identity.
    -- Use the former verified address only as stable linkage evidence; the
    -- signed event explicitly removes FCOS access.
    insert into public.fcuno_identity_sync_outbox (
      admin_user_id, identity_revision, payload
    ) values (
      new.id,
      new.identity_revision,
      jsonb_build_object(
        'sub', new.id::text,
        'username', new.username,
        'email', old.email,
        'email_verified', true,
        'display_name', coalesce(new.display_name, new.username),
        'is_active', false,
        'use_fcos', false,
        'use_spc', new.use_spc,
        'identity_revision', new.identity_revision,
        'credential_revision', new.credential_revision,
        'revoked_before', new.revoked_before
      )
    ) on conflict (admin_user_id, identity_revision) do nothing;
  end if;

  insert into public.fcuno_identity_audit (admin_user_id, event_type, details)
  values (
    new.id,
    'identity.changed',
    jsonb_build_object(
      'identity_revision', new.identity_revision,
      'credential_revision', new.credential_revision,
      'use_fcos', new.use_fcos,
      'use_spc', new.use_spc
    )
  );
  return new;
end;
$$;

drop trigger if exists fcuno_enqueue_identity_sync on public.admin_users;
create trigger fcuno_enqueue_identity_sync
after insert or update on public.admin_users
for each row execute function public.fcuno_enqueue_identity_sync();

insert into public.fcuno_identity_sync_outbox (
  admin_user_id, identity_revision, payload
)
select
  users.id,
  users.identity_revision,
  jsonb_build_object(
    'sub', users.id::text,
    'username', users.username,
    'email', users.email,
    'email_verified', true,
    'display_name', coalesce(users.display_name, users.username),
    'is_active', users.is_active,
    'use_fcos', users.use_fcos,
    'use_spc', users.use_spc,
    'identity_revision', users.identity_revision,
    'credential_revision', users.credential_revision,
    'revoked_before', users.revoked_before
  )
from public.admin_users as users
where users.email_verified and users.email is not null
on conflict (admin_user_id, identity_revision) do nothing;

create or replace function public.update_admin_user_identity_with_password_and_revoke_sessions(
  p_admin_user_id uuid,
  p_username text,
  p_display_name text,
  p_email text,
  p_email_verified boolean,
  p_is_active boolean,
  p_use_fcos boolean,
  p_use_spc boolean,
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
  normalized_email text := nullif(lower(btrim(p_email)), '');
  updated_user public.admin_users%rowtype;
begin
  if p_admin_user_id is null
    or nullif(btrim(p_username), '') is null
    or nullif(btrim(p_display_name), '') is null
    or nullif(btrim(p_role), '') is null
    or p_email_verified is null
    or p_is_active is null
    or p_use_fcos is null
    or p_use_spc is null
    or (p_email_verified and normalized_email is null)
    or ((p_use_fcos or p_use_spc) and (not p_is_active or not p_email_verified))
    or p_permissions is null
    or p_new_password_hash is null
    or p_new_password_hash !~ '^scrypt:[0-9a-f]{32}:[0-9a-f]{128}$'
  then
    raise exception 'Valid FCUNO identity and scrypt password data are required.';
  end if;

  select users.* into updated_user
  from public.admin_users as users
  where users.id = p_admin_user_id
  for update;
  if not found then raise exception 'Admin user was not found.'; end if;

  update public.admin_users as users
  set username = btrim(p_username),
      display_name = btrim(p_display_name),
      email = normalized_email,
      email_verified = p_email_verified,
      is_active = p_is_active,
      use_fcos = p_use_fcos,
      use_spc = p_use_spc,
      role = p_role,
      permissions = p_permissions,
      password_hash = p_new_password_hash,
      password_reset_required = true
  where users.id = p_admin_user_id
  returning users.* into updated_user;

  update public.admin_sessions as sessions
  set revoked_at = greatest(changed_at_value, sessions.created_at)
  where sessions.admin_user_id = p_admin_user_id
    and sessions.revoked_at is null;

  return next updated_user;
end;
$$;

revoke all on function public.update_admin_user_identity_with_password_and_revoke_sessions(
  uuid, text, text, text, boolean, boolean, boolean, boolean, text, jsonb, text
) from public, anon, authenticated, service_role;
grant execute on function public.update_admin_user_identity_with_password_and_revoke_sessions(
  uuid, text, text, text, boolean, boolean, boolean, boolean, text, jsonb, text
) to service_role;

-- A link is only an association.  It never writes spc_users and therefore
-- cannot replace its password, MFA, role, permissions, or sessions.
create table if not exists public.spc_identity_links (
  admin_user_id uuid primary key references public.admin_users(id) on delete cascade,
  spc_user_id uuid not null unique references public.spc_users(id) on delete cascade,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);

create or replace function public.fcuno_set_spc_identity_link_updated_at()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  new.updated_at := clock_timestamp();
  return new;
end;
$$;
drop trigger if exists fcuno_set_spc_identity_link_updated_at on public.spc_identity_links;
create trigger fcuno_set_spc_identity_link_updated_at
before update on public.spc_identity_links
for each row execute function public.fcuno_set_spc_identity_link_updated_at();

create or replace function public.fcuno_revoke_linked_spc_sessions()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if new.credential_revision > old.credential_revision
    or (
      old.is_active and old.use_spc and old.email_verified
      and not (new.is_active and new.use_spc and new.email_verified)
    )
  then
    update public.spc_sessions as sessions
    set revoked_at = greatest(clock_timestamp(), sessions.created_at)
    from public.spc_identity_links as links
    where links.admin_user_id = new.id
      and sessions.spc_user_id = links.spc_user_id
      and sessions.revoked_at is null;
  end if;
  return new;
end;
$$;

drop trigger if exists fcuno_revoke_linked_spc_sessions on public.admin_users;
create trigger fcuno_revoke_linked_spc_sessions
after update on public.admin_users
for each row execute function public.fcuno_revoke_linked_spc_sessions();

do $$
declare
  admin_identity_id uuid;
  spc_identity_id uuid;
  admin_identity_count integer;
  spc_identity_count integer;
begin
  select (array_agg(users.id order by users.id))[1], count(*)::integer
  into admin_identity_id, admin_identity_count
  from public.admin_users as users
  where lower(coalesce(users.email, users.username)) = 'otto@cosulich.com.hk';

  select (array_agg(users.id order by users.id))[1], count(*)::integer
  into spc_identity_id, spc_identity_count
  from public.spc_users as users
  where lower(users.username) = 'otto@cosulich.com.hk';

  if admin_identity_count = 1 and spc_identity_count = 1 then
    insert into public.spc_identity_links (admin_user_id, spc_user_id)
    values (admin_identity_id, spc_identity_id)
    on conflict do nothing;

    update public.admin_users
    set use_spc = true
    where id = admin_identity_id
      and email_verified
      and not use_spc;
  end if;
end;
$$;

create or replace function public.claim_fcuno_identity_sync_outbox(
  p_limit integer,
  p_lease_token uuid
)
returns setof public.fcuno_identity_sync_outbox
language sql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  with claimed as (
    select id
    from public.fcuno_identity_sync_outbox
    where delivered_at is null
      and next_attempt_at <= clock_timestamp()
      and (lease_expires_at is null or lease_expires_at < clock_timestamp())
    order by created_at
    for update skip locked
    limit greatest(least(p_limit, 100), 1)
  )
  update public.fcuno_identity_sync_outbox as outbox
  set lease_token = p_lease_token,
      lease_expires_at = clock_timestamp() + interval '2 minutes',
      attempt_count = outbox.attempt_count + 1
  from claimed
  where outbox.id = claimed.id
  returning outbox.*;
$$;

alter table public.oidc_authorization_codes enable row level security;
alter table public.oidc_token_revocations enable row level security;
alter table public.fcuno_identity_sync_outbox enable row level security;
alter table public.fcuno_identity_audit enable row level security;
alter table public.spc_identity_links enable row level security;

drop policy if exists oidc_authorization_codes_service_only on public.oidc_authorization_codes;
create policy oidc_authorization_codes_service_only on public.oidc_authorization_codes for all using (false) with check (false);
drop policy if exists oidc_token_revocations_service_only on public.oidc_token_revocations;
create policy oidc_token_revocations_service_only on public.oidc_token_revocations for all using (false) with check (false);
drop policy if exists fcuno_identity_sync_outbox_service_only on public.fcuno_identity_sync_outbox;
create policy fcuno_identity_sync_outbox_service_only on public.fcuno_identity_sync_outbox for all using (false) with check (false);
drop policy if exists fcuno_identity_audit_service_only on public.fcuno_identity_audit;
create policy fcuno_identity_audit_service_only on public.fcuno_identity_audit for all using (false) with check (false);
drop policy if exists spc_identity_links_service_only on public.spc_identity_links;
create policy spc_identity_links_service_only on public.spc_identity_links for all using (false) with check (false);

revoke all on table public.oidc_authorization_codes, public.oidc_token_revocations,
  public.fcuno_identity_sync_outbox, public.fcuno_identity_audit, public.spc_identity_links
  from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.oidc_authorization_codes,
  public.oidc_token_revocations, public.fcuno_identity_sync_outbox,
  public.spc_identity_links to service_role;
grant select, insert on table public.fcuno_identity_audit to service_role;
revoke all on function public.consume_oidc_authorization_code(text, text, text, text) from public, anon, authenticated;
grant execute on function public.consume_oidc_authorization_code(text, text, text, text) to service_role;
revoke all on function public.claim_fcuno_identity_sync_outbox(integer, uuid) from public, anon, authenticated;
grant execute on function public.claim_fcuno_identity_sync_outbox(integer, uuid) to service_role;
revoke all on function public.fcuno_revoke_linked_spc_sessions() from public, anon, authenticated;
grant execute on function public.fcuno_revoke_linked_spc_sessions() to service_role;

comment on table public.spc_identity_links is
  'FCUNO owns linked identity sign-in; SPC retains operational roles, offices, routes, permissions, and history.';
