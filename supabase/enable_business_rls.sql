-- Run after deploying the authenticated admin read proxy.
-- Public reports retain read-only access; business/admin tables become server-only.

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'ports',
    'cc_countries',
    'cc_companies',
    'cc_documents',
    'cc_entry_folders',
    'cc_company_files',
    'cc_ports',
    'admins',
    'price_history',
    'remarks',
    'phonebook_companies',
    'phonebook_contacts',
    'cc_entry_files'
  ]
  loop
    if to_regclass('public.' || table_name) is not null then
      execute format('alter table public.%I enable row level security', table_name);
    end if;
  end loop;
end $$;

-- These tables feed the public bunker-price pages and reports.
drop policy if exists "ports_public_read" on public.ports;
create policy "ports_public_read"
  on public.ports for select
  to anon, authenticated
  using (true);

drop policy if exists "price_history_public_read" on public.price_history;
create policy "price_history_public_read"
  on public.price_history for select
  to anon, authenticated
  using (true);

drop policy if exists "remarks_public_read" on public.remarks;
create policy "remarks_public_read"
  on public.remarks for select
  to anon, authenticated
  using (true);

-- Admin-only datasets are accessed with the service role after application
-- session and page-permission checks. They intentionally have no public policy.

drop policy if exists "email_templates_read" on public.email_templates;
drop policy if exists "email_templates_write" on public.email_templates;

drop policy if exists "office_calendar_store_read" on public.office_calendar_store;
drop policy if exists "office_calendar_store_write" on public.office_calendar_store;

drop policy if exists "outlook_exchange_sync_queue_read" on public.outlook_exchange_sync_queue;
drop policy if exists "outlook_exchange_sync_queue_write" on public.outlook_exchange_sync_queue;

drop policy if exists "shared_addressbook_contacts_read" on public.shared_addressbook_contacts;
drop policy if exists "shared_addressbook_contacts_write" on public.shared_addressbook_contacts;
drop policy if exists "shared_addressbook_groups_read" on public.shared_addressbook_groups;
drop policy if exists "shared_addressbook_groups_write" on public.shared_addressbook_groups;
drop policy if exists "shared_addressbook_group_members_read" on public.shared_addressbook_group_members;
drop policy if exists "shared_addressbook_group_members_write" on public.shared_addressbook_group_members;
