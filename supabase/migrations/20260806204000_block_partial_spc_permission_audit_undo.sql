-- SPC user rows and their permission/profile metadata form one security
-- boundary. Generic audit undo is intentionally single-row, so it must not
-- restore only the permission-store half of a user-management transaction.

create or replace function private.block_spc_permission_store_partial_undo()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if nullif(
    pg_catalog.current_setting('app.audit_undo_of_log_id', true),
    ''
  ) is not null
    and (
      coalesce(pg_catalog.to_jsonb(new) ->> 'key', '') = 'spc-permission-groups'
      or coalesce(pg_catalog.to_jsonb(old) ->> 'key', '') = 'spc-permission-groups'
    )
  then
    raise exception
      'SPC permission-group audit records cannot be undone independently. Use SPC User Management.'
      using errcode = 'P0001';
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

revoke all on function private.block_spc_permission_store_partial_undo()
  from public, anon, authenticated, service_role;

drop trigger if exists block_partial_spc_permission_store_audit_undo
  on public.office_calendar_store;
create trigger block_partial_spc_permission_store_audit_undo
before insert or update or delete on public.office_calendar_store
for each row
execute function private.block_spc_permission_store_partial_undo();
