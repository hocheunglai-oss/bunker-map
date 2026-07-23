-- Extend the credential redaction boundary to SPC users. Older audit rows
-- captured password hashes before this invariant was introduced.

create or replace function private.redact_admin_user_audit_snapshot()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if new.table_schema = 'public'
    and new.table_name in ('admin_users', 'spc_users')
  then
    new.changed_fields := array_remove(
      coalesce(new.changed_fields, array[]::text[]),
      'password_hash'
    );
    new.before_row := new.before_row - 'password_hash';
    new.after_row := new.after_row - 'password_hash';
  end if;
  return new;
end;
$$;

revoke all on function private.redact_admin_user_audit_snapshot()
  from public, anon, authenticated;

update public.audit_logs
set
  changed_fields = array_remove(changed_fields, 'password_hash'),
  before_row = before_row - 'password_hash',
  after_row = after_row - 'password_hash'
where table_schema = 'public'
  and table_name in ('admin_users', 'spc_users')
  and (
    changed_fields @> array['password_hash']::text[]
    or coalesce(before_row, '{}'::jsonb) ? 'password_hash'
    or coalesce(after_row, '{}'::jsonb) ? 'password_hash'
  );

alter function public.undo_audit_log(uuid, text, text)
  rename to undo_audit_log_noncredential;

revoke all on function public.undo_audit_log_noncredential(uuid, text, text)
  from public, anon, authenticated, service_role;

create or replace function public.undo_audit_log(
  p_log_id uuid,
  p_actor_id text default null,
  p_actor_name text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target_table_schema text;
  target_table_name text;
begin
  select
    audit.table_schema,
    audit.table_name
  into
    target_table_schema,
    target_table_name
  from public.audit_logs as audit
  where audit.id = p_log_id;

  if target_table_schema = 'public'
    and target_table_name in ('admin_users', 'spc_users')
  then
    raise exception
      'Credential-bearing user audit records cannot be undone because credentials are redacted.';
  end if;

  return public.undo_audit_log_noncredential(
    p_log_id,
    p_actor_id,
    p_actor_name
  );
end;
$$;

revoke all on function public.undo_audit_log(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.undo_audit_log(uuid, text, text)
  to service_role;
