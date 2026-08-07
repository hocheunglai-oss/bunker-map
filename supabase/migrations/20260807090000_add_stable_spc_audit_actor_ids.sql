-- Add stable SPC actor attribution without changing the existing actor_id or
-- actor_name contracts. This migration is intentionally backward-compatible:
-- callers that do not yet send the trusted header continue to write NULL.

alter table public.audit_logs
  add column if not exists actor_user_id uuid;

comment on column public.audit_logs.actor_user_id is
  'Stable SPC user UUID captured from the server-validated session. Deliberately not a foreign key so deleting a user cannot erase historical attribution.';

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create or replace function private.capture_spc_audit_actor_user_id()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
  trusted_actor_user_id_text text;
  trusted_actor_user_id uuid;
begin
  if coalesce(new.actor_id, '') !~ '^spc:.+' then
    return new;
  end if;

  trusted_actor_user_id_text := nullif(
    public.audit_request_header('x-bunker-audit-actor-user-id'),
    ''
  );
  if trusted_actor_user_id_text is null then
    return new;
  end if;

  trusted_actor_user_id := public.audit_uuid_text(trusted_actor_user_id_text);
  if trusted_actor_user_id is null then
    raise exception 'Trusted SPC audit actor user id is invalid.';
  end if;

  if new.actor_user_id is not null
    and new.actor_user_id is distinct from trusted_actor_user_id
  then
    raise exception 'Audit actor user id does not match the trusted SPC session.';
  end if;

  new.actor_user_id := trusted_actor_user_id;
  return new;
end;
$$;

create or replace function private.protect_audit_actor_user_id()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if old.actor_user_id is distinct from new.actor_user_id then
    raise exception 'Audit actor user id is immutable.';
  end if;
  return new;
end;
$$;

revoke all on function private.capture_spc_audit_actor_user_id()
  from public, anon, authenticated;
revoke all on function private.protect_audit_actor_user_id()
  from public, anon, authenticated;

drop trigger if exists capture_spc_audit_actor_user_id
  on public.audit_logs;
create trigger capture_spc_audit_actor_user_id
before insert on public.audit_logs
for each row
execute function private.capture_spc_audit_actor_user_id();

drop trigger if exists protect_audit_actor_user_id
  on public.audit_logs;
create trigger protect_audit_actor_user_id
before update of actor_user_id on public.audit_logs
for each row
execute function private.protect_audit_actor_user_id();
