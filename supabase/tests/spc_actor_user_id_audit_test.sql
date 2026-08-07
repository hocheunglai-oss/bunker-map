begin;
select plan(8);

select has_column(
  'public',
  'audit_logs',
  'actor_user_id',
  'audit rows have a stable actor user id column'
);

select col_type_is(
  'public',
  'audit_logs',
  'actor_user_id',
  'uuid',
  'the stable actor user id uses the SPC user primary-key type'
);

select has_trigger(
  'public',
  'audit_logs',
  'capture_spc_audit_actor_user_id',
  'trusted SPC session identity is captured on every audit insert'
);

select has_trigger(
  'public',
  'audit_logs',
  'protect_audit_actor_user_id',
  'stored actor user identity cannot be rewritten'
);

select set_config(
  'request.headers',
  '{"x-bunker-audit-actor-user-id":"22222222-2222-4222-8222-222222222222"}',
  true
);

create temporary table captured_spc_actor_audit as
with inserted as (
  insert into public.audit_logs (
    actor_id,
    actor_name,
    actor_source,
    table_schema,
    table_name,
    operation
  ) values (
    'spc:stable-actor-test@example.com',
    'STABLE ACTOR TEST',
    'app',
    'app',
    'spc_actor_user_id_test',
    'INSERT'
  )
  returning id, actor_user_id
)
select * from inserted;

select is(
  (select actor_user_id::text from captured_spc_actor_audit),
  '22222222-2222-4222-8222-222222222222',
  'the trusted request header becomes stable audit attribution'
);

select throws_ok(
  format(
    'update public.audit_logs set actor_user_id = %L::uuid where id = %L::uuid',
    '33333333-3333-4333-8333-333333333333',
    (select id::text from captured_spc_actor_audit)
  ),
  'P0001',
  'Audit actor user id is immutable.',
  'stable audit attribution cannot be modified'
);

select set_config('request.headers', '{}', true);

create temporary table legacy_null_spc_actor_audit as
with inserted as (
  insert into public.audit_logs (
    actor_id,
    actor_name,
    actor_source,
    table_schema,
    table_name,
    operation
  ) values (
    'spc:legacy-null-actor-test@example.com',
    'LEGACY NULL ACTOR TEST',
    'app',
    'app',
    'spc_actor_user_id_test',
    'INSERT'
  )
  returning id, actor_user_id
)
select * from inserted;

select throws_ok(
  format(
    'update public.audit_logs set actor_user_id = %L::uuid where id = %L::uuid',
    '33333333-3333-4333-8333-333333333333',
    (select id::text from legacy_null_spc_actor_audit)
  ),
  'P0001',
  'Audit actor user id is immutable.',
  'historical null attribution cannot be rewritten after insertion'
);

select set_config(
  'request.headers',
  '{"x-bunker-audit-actor-user-id":"22222222-2222-4222-8222-222222222222"}',
  true
);

select throws_ok(
  $test$
    insert into public.audit_logs (
      actor_user_id,
      actor_id,
      actor_name,
      actor_source,
      table_schema,
      table_name,
      operation
    ) values (
      '33333333-3333-4333-8333-333333333333',
      'spc:mismatch-test@example.com',
      'MISMATCH TEST',
      'app',
      'app',
      'spc_actor_user_id_test',
      'INSERT'
    )
  $test$,
  'P0001',
  'Audit actor user id does not match the trusted SPC session.',
  'an explicit value cannot contradict the server-trusted session identity'
);

select * from finish();
rollback;
