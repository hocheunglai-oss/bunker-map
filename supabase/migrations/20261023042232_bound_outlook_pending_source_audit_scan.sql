-- Preserve the exact pending-source contract while reading only authoritative
-- source-change audit events after this certification. A new atomic activation
-- normally has no such events; unrelated historical audits need not be scanned
-- again for every recipient. No trigger, source guard or expiry is bypassed.
set local lock_timeout = '3s';

do $preimage$
begin
  if (select md5(p.prosrc) from pg_catalog.pg_proc p
      where p.oid=pg_catalog.to_regprocedure('private.outlook_template_source_is_pending(text,text,uuid)'))
    is distinct from '2e30cf2c5d0a4d5ec83ea91721b54fa4' then
    raise exception 'OUTLOOK_PENDING_SOURCE_DRIFT: review the installed pending-source function before replacement.' using errcode='55000';
  end if;
end;
$preimage$;

create or replace function private.outlook_template_source_is_pending(p_kind text, p_id text, p_run_id uuid)
returns boolean language sql stable security invoker set search_path = ''
as $$
  with certification as materialized (
    select ledger_sequence from public.outlook_exchange_truth_ledger
    where event_type = 'full_certification' and run_id = p_run_id
  ), newer_source_events as materialized (
    select ledger.audit_log_id
    from certification
    join public.outlook_exchange_truth_ledger ledger
      on ledger.event_type = 'source_change'
      and ledger.ledger_sequence > certification.ledger_sequence
  ), source_changes as materialized (
    select audit.table_name, audit.operation, audit.changed_fields,
      audit.record_pk ->> 'id' as record_id,
      audit.record_pk ->> 'group_id' as group_id,
      audit.before_row ->> 'group_id' as previous_group_id
    from newer_source_events event
    join public.audit_logs audit on audit.id = event.audit_log_id
    where audit.table_schema = 'public'
  )
  select not exists (select 1 from certification) or case when p_kind = 'contact' then
    not exists (select 1 from public.shared_addressbook_contacts where id = p_id)
    or exists (select 1 from source_changes audit
      where audit.table_name = 'shared_addressbook_contacts' and audit.record_id = p_id
      and (audit.operation in ('INSERT','DELETE')
        or (audit.operation = 'UPDATE' and audit.changed_fields && array['display_name','primary_email']::text[])))
  when p_kind = 'group' then
    not exists (select 1 from public.shared_addressbook_groups where id = p_id)
    or exists (select 1 from source_changes audit
      where (
        (audit.table_name = 'shared_addressbook_groups' and audit.record_id = p_id
          and (audit.operation in ('INSERT','DELETE') or (audit.operation = 'UPDATE' and audit.changed_fields && array['name','nickname']::text[])))
        or (audit.table_name = 'shared_addressbook_group_members'
          and (audit.group_id = p_id or audit.previous_group_id = p_id)
          and (audit.operation in ('INSERT','DELETE') or (audit.operation = 'UPDATE' and audit.changed_fields && array['group_id','contact_id','source_book']::text[])))
      ))
    or exists (select 1 from public.shared_addressbook_group_members member
      join source_changes audit on audit.table_name = 'shared_addressbook_contacts' and audit.record_id = member.contact_id
      where member.group_id = p_id and (audit.operation in ('INSERT','DELETE')
        or (audit.operation = 'UPDATE' and audit.changed_fields && array['display_name','primary_email']::text[])))
  else false end;
$$;
