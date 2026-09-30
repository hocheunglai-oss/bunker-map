begin;
select plan(19);

select has_table('public', 'phonebook_carddav_queue', 'durable CardDAV queue exists');
select has_table('public', 'phonebook_carddav_quarantine', 'recoverable quarantine exists');
select ok(
  (select bool_and(relrowsecurity) from pg_class where oid in (
    'public.phonebook_carddav_queue'::regclass,
    'public.phonebook_carddav_quarantine'::regclass
  ))
  and not has_table_privilege('anon', 'public.phonebook_carddav_queue', 'SELECT')
  and not has_table_privilege('authenticated', 'public.phonebook_carddav_queue', 'INSERT')
  and not has_table_privilege('anon', 'public.phonebook_carddav_quarantine', 'SELECT')
  and not has_table_privilege('authenticated', 'public.phonebook_carddav_quarantine', 'SELECT'),
  'queue and original contact backups are inaccessible to browser roles'
);
select ok(
  has_function_privilege('service_role', 'public.enqueue_phonebook_carddav(uuid[])', 'EXECUTE')
  and not has_function_privilege('anon', 'public.enqueue_phonebook_carddav(uuid[])', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.enqueue_phonebook_carddav(uuid[])', 'EXECUTE'),
  'only the hosted worker may enqueue directly'
);
select ok(
  has_column_privilege('service_role', 'public.phonebook_carddav_quarantine', 'deleted_at', 'UPDATE')
  and not has_column_privilege('service_role', 'public.phonebook_carddav_quarantine', 'vcard', 'UPDATE')
  and not has_table_privilege('service_role', 'public.phonebook_carddav_quarantine', 'DELETE'),
  'the worker cannot overwrite or delete recovery evidence'
);

insert into public.phonebook_contacts (id, full_name, company, source_key)
values ('9b865000-0000-4000-8000-000000000001', 'CARDDAV SQL TEST', ' CardDAV SQL Company ', 'carddav-sql-test-contact-1');
select is(
  (select count(*)::integer from public.phonebook_carddav_queue where contact_id = '9b865000-0000-4000-8000-000000000001'),
  1, 'source insert queues the contact without a browser request'
);
create temporary table carddav_test_old_version as
select version from public.phonebook_carddav_queue where contact_id = '9b865000-0000-4000-8000-000000000001';
update public.phonebook_carddav_queue set attempts = 3, last_error = 'retry later'
where contact_id = '9b865000-0000-4000-8000-000000000001';
update public.phonebook_contacts set full_name = 'CARDDAV SQL EDITED'
where id = '9b865000-0000-4000-8000-000000000001';
select ok(
  (select version <> (select version from carddav_test_old_version)
   from public.phonebook_carddav_queue where contact_id = '9b865000-0000-4000-8000-000000000001'),
  'a later source edit rotates the queue version'
);
select ok(
  (select attempts = 0 and last_error is null from public.phonebook_carddav_queue
   where contact_id = '9b865000-0000-4000-8000-000000000001'),
  'a new source version resets prior retry backoff'
);
delete from public.phonebook_carddav_queue
where contact_id = '9b865000-0000-4000-8000-000000000001'
and version = (select version from carddav_test_old_version);
select is(
  (select count(*)::integer from public.phonebook_carddav_queue where contact_id = '9b865000-0000-4000-8000-000000000001'),
  1, 'a stale worker acknowledgment cannot discard a newer source edit'
);
delete from public.phonebook_contacts where id = '9b865000-0000-4000-8000-000000000001';
select is(
  (select count(*)::integer from public.phonebook_carddav_queue where contact_id = '9b865000-0000-4000-8000-000000000001'),
  1, 'contact deletion leaves a durable tombstone for remote cleanup'
);
delete from public.phonebook_carddav_queue where contact_id = '9b865000-0000-4000-8000-000000000001';
savepoint source_write;
insert into public.phonebook_contacts (id, full_name, source_key)
values ('9b865000-0000-4000-8000-000000000001', 'ROLLBACK', 'carddav-sql-test-rollback');
rollback to source_write;
select is(
  (select count(*)::integer from public.phonebook_carddav_queue where contact_id = '9b865000-0000-4000-8000-000000000001'),
  0, 'queue work rolls back atomically with the source write'
);

insert into public.phonebook_contacts (id, full_name, company, source_key) values
  ('9b865000-0000-4000-8000-000000000001', 'OLD COMPANY', ' carddav sql company ', 'carddav-sql-test-contact-1'),
  ('9b865000-0000-4000-8000-000000000002', 'NEW COMPANY', 'CardDAV SQL Company New', 'carddav-sql-test-contact-2');
delete from public.phonebook_carddav_queue where contact_id in (
  '9b865000-0000-4000-8000-000000000001', '9b865000-0000-4000-8000-000000000002'
);
insert into public.phonebook_companies (id, name, source_key)
values ('9b865000-0000-4000-8000-000000000003', 'CardDAV SQL Company', 'carddav-sql-test-company');
select is(
  (select count(*)::integer from public.phonebook_carddav_queue where contact_id = '9b865000-0000-4000-8000-000000000001'),
  1, 'company insert queues contacts with normalized matching company names'
);
update public.phonebook_companies set name = 'CardDAV SQL Company New'
where id = '9b865000-0000-4000-8000-000000000003';
select is(
  (select count(*)::integer from public.phonebook_carddav_queue where contact_id in (
    '9b865000-0000-4000-8000-000000000001', '9b865000-0000-4000-8000-000000000002'
  )), 2, 'company rename queues both old and new matching contacts'
);
delete from public.phonebook_carddav_queue where contact_id = '9b865000-0000-4000-8000-000000000002';
delete from public.phonebook_companies where id = '9b865000-0000-4000-8000-000000000003';
select is(
  (select count(*)::integer from public.phonebook_carddav_queue where contact_id = '9b865000-0000-4000-8000-000000000002'),
  1, 'company deletion refreshes inherited details'
);
select throws_ok(
  $$select public.enqueue_phonebook_carddav(array[null]::uuid[])$$,
  '22023', 'Contact IDs must not contain null.', 'null IDs fail closed'
);
select throws_ok(
  $$select public.enqueue_phonebook_carddav(array_fill('9b865000-0000-4000-8000-000000000001'::uuid, array[5001]))$$,
  '22023', 'A non-null array of at most 5000 contact IDs is required.', 'RPC requests are bounded'
);
select public.enqueue_phonebook_carddav(array[
  '9b865000-0000-4000-8000-000000000001', '9b865000-0000-4000-8000-000000000001'
]::uuid[]);
select is(
  (select count(*)::integer from public.phonebook_carddav_queue where contact_id = '9b865000-0000-4000-8000-000000000001'),
  1, 'duplicate IDs coalesce to one current work item'
);
select is(
  (select count(*)::integer from pg_trigger where tgname = 'bunker_map_backup_epoch_fence'
   and tgrelid in ('public.phonebook_carddav_queue'::regclass, 'public.phonebook_carddav_quarantine'::regclass)
   and tgfoid = 'private.record_bunker_map_backup_mutation()'::regprocedure
   and tgenabled in ('O', 'A') and (tgtype::integer & 60) = 60),
  2, 'both tables participate in the verified-backup epoch'
);
select ok(
  not exists (select 1 from pg_constraint where conrelid = 'public.phonebook_carddav_queue'::regclass and contype = 'f'),
  'no foreign key can erase queued deletions'
);

select * from finish();
rollback;
