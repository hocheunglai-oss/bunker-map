-- Apply in Supabase SQL Editor after deploying the matching application code.
-- This script is idempotent and addresses the actionable security/performance lints.

create index if not exists audit_logs_undo_of_log_id_idx
  on public.audit_logs(undo_of_log_id);

create index if not exists audit_logs_undone_by_log_id_idx
  on public.audit_logs(undone_by_log_id);

create index if not exists cc_ports_country_id_idx
  on public.cc_ports(country_id);

create index if not exists price_history_port_id_idx
  on public.price_history(port_id);

create index if not exists shared_addressbook_group_members_contact_id_idx
  on public.shared_addressbook_group_members(contact_id);

alter function public.set_admin_users_updated_at() set search_path = public, pg_temp;
alter function public.set_ccinfo_updated_at() set search_path = public, pg_temp;
alter function public.audit_json_setting(text) set search_path = public, pg_temp;
alter function public.audit_text_setting(text) set search_path = public, pg_temp;
alter function public.audit_uuid_setting(text) set search_path = public, pg_temp;
alter function public.audit_request_header(text) set search_path = public, pg_temp;
alter function public.audit_row_pk(text, text, jsonb) set search_path = public, pg_temp;
alter function public.audit_changed_fields(jsonb, jsonb) set search_path = public, pg_temp;
alter function public.audit_pk_where(jsonb) set search_path = public, pg_temp;

revoke execute on function public.audit_enable_table(regclass) from public, anon, authenticated;
revoke execute on function public.audit_table_changes() from public, anon, authenticated;
revoke execute on function public.undo_audit_log(uuid, text, text) from public, anon, authenticated;

grant execute on function public.audit_enable_table(regclass) to service_role;
grant execute on function public.undo_audit_log(uuid, text, text) to service_role;

-- The following tables currently have browser-side write callers. Enabling RLS
-- without first moving those writes behind authenticated server APIs would
-- break operations; adding USING (true) policies would only hide the lint.
-- They are intentionally listed here as the next migration stage:
--
-- ports, cc_countries, cc_companies, cc_documents, cc_entry_folders,
-- cc_company_files, cc_ports, price_history, remarks, phonebook_companies,
-- phonebook_contacts, cc_entry_files.
