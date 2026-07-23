create or replace function private.prevent_empty_email_template_library()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
begin
  if exists (select 1 from deleted_templates)
    and not exists (select 1 from public.email_templates)
  then
    raise exception
      'EMAIL_TEMPLATE_LIBRARY_EMPTY_FORBIDDEN: the canonical Outlook template library may not be emptied.'
      using errcode = '23514';
  end if;
  return null;
end;
$$;

revoke all on function private.prevent_empty_email_template_library()
  from public, anon, authenticated, service_role;

drop trigger if exists prevent_empty_email_template_library
  on public.email_templates;
create trigger prevent_empty_email_template_library
after delete on public.email_templates
referencing old table as deleted_templates
for each statement
execute function private.prevent_empty_email_template_library();