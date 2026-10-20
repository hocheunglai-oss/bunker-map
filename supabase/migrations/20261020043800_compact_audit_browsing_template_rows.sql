-- Compact only ordinary audit list reads. Detail and Undo retain the stored
-- original rows. The unnamed composite arguments are computed-field inputs,
-- not a new general-purpose RPC or a change to audit history/RLS.
set local lock_timeout = '5s';
set local statement_timeout = '15s';

create function public.audit_browsing_before_row(public.audit_logs)
returns jsonb
language sql
immutable
security invoker
set search_path = ''
as $$
  select case
    when ($1).table_schema = 'public'
      and ($1).table_name = 'email_templates'
      and pg_catalog.jsonb_typeof(($1).before_row) = 'object'
    then ($1).before_row - 'body_html' - 'body_text'
    else ($1).before_row
  end;
$$;

create function public.audit_browsing_after_row(public.audit_logs)
returns jsonb
language sql
immutable
security invoker
set search_path = ''
as $$
  select case
    when ($1).table_schema = 'public'
      and ($1).table_name = 'email_templates'
      and pg_catalog.jsonb_typeof(($1).after_row) = 'object'
    then ($1).after_row - 'body_html' - 'body_text'
    else ($1).after_row
  end;
$$;

revoke all on function public.audit_browsing_before_row(public.audit_logs)
  from public, anon, authenticated;
revoke all on function public.audit_browsing_after_row(public.audit_logs)
  from public, anon, authenticated;
grant execute on function public.audit_browsing_before_row(public.audit_logs)
  to service_role;
grant execute on function public.audit_browsing_after_row(public.audit_logs)
  to service_role;

notify pgrst, 'reload schema';
