begin;
select plan(7);

select ok(
  (
    select bool_and(relrowsecurity)
    from pg_catalog.pg_class
    where oid in (
      'public.admins'::regclass,
      'public.whatsapp_conversations'::regclass,
      'public.whatsapp_messages'::regclass
    )
  ),
  'retained legacy tables keep row-level security enabled'
);

select is(
  (
    select count(*)::integer
    from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename in ('whatsapp_conversations', 'whatsapp_messages')
  ),
  0,
  'retired WhatsApp tables have no Data API policies'
);

select ok(
  not has_table_privilege('anon', 'public.admins', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
  and not has_table_privilege('authenticated', 'public.admins', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'),
  'legacy admin records are unavailable to Data API roles'
);

select ok(
  not has_table_privilege('anon', 'public.whatsapp_conversations', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
  and not has_table_privilege('authenticated', 'public.whatsapp_conversations', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'),
  'retired WhatsApp conversations are unavailable to Data API roles'
);

select ok(
  not has_table_privilege('anon', 'public.whatsapp_messages', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
  and not has_table_privilege('authenticated', 'public.whatsapp_messages', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'),
  'retired WhatsApp messages are unavailable to Data API roles'
);

select ok(
  not has_sequence_privilege('anon', 'public.admins_id_seq', 'USAGE')
  and not has_sequence_privilege('authenticated', 'public.admins_id_seq', 'USAGE'),
  'legacy admin sequence is unavailable to Data API roles'
);

select ok(
  has_table_privilege('service_role', 'public.admins', 'SELECT')
  and has_table_privilege('service_role', 'public.whatsapp_conversations', 'SELECT')
  and has_table_privilege('service_role', 'public.whatsapp_messages', 'SELECT')
  and has_sequence_privilege('service_role', 'public.admins_id_seq', 'USAGE'),
  'hosted service access remains available for retained data and backups'
);

select * from finish();
rollback;
