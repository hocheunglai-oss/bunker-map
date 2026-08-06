begin;
select plan(15);

select has_trigger(
  'public',
  'office_calendar_store',
  'bunker_audit_log',
  'the shared SPC permission store is covered by the audit trigger'
);

select has_trigger(
  'public',
  'spc_users',
  'bunker_audit_log',
  'SPC user lifecycle writes are covered by the audit trigger'
);

select has_trigger(
  'public',
  'audit_logs',
  'protect_spc_user_management_audit_record',
  'SPC user-management audit rows have an append-only guard'
);

do $$
begin
  perform set_config('app.audit_actor_id', '', true);
  perform set_config('app.audit_actor_name', '', true);
  perform set_config('app.audit_context', '', true);
  perform set_config('app.audit_correlation_id', '', true);
  perform set_config(
    'request.headers',
    jsonb_build_object(
      'x-bunker-admin-user', 'spc:audit-test@example.com',
      'x-bunker-admin-display-name', 'SPC AUDIT TEST',
      'x-bunker-admin-role', 'ADMIN',
      'x-bunker-admin-page-id', 'spc-user-management',
      'x-bunker-admin-page-label', 'SPC USER MANAGEMENT',
      'x-bunker-admin-page-path', '/spc/usermanagement',
      'x-bunker-audit-source-ip', '203.0.113.19',
      'x-bunker-audit-correlation-id',
        '11111111-1111-4111-8111-111111111111',
      'x-bunker-audit-request-id',
        '11111111-1111-4111-8111-111111111111',
      'x-bunker-audit-platform-request-id', 'hkg1::audit-test',
      'x-bunker-audit-actor-role', 'ADMIN',
      'x-bunker-audit-action', 'save-permission-groups',
      'x-bunker-audit-target-type', 'spc-permission-groups',
      'x-bunker-audit-target-id', 'spc-permission-groups',
      'x-bunker-audit-outcome', 'success',
      'x-bunker-audit-approval-reference', 'CHANGE-2042'
    )::text,
    true
  );
end;
$$;

insert into public.office_calendar_store(key, payload, updated_at)
values (
  'spc-permission-groups',
  '{"auditTest":true,"groups":[],"offices":[],"userProfiles":[],"userRoles":[]}'::jsonb,
  clock_timestamp()
)
on conflict (key) do update
set payload = excluded.payload,
    updated_at = excluded.updated_at;

create temporary table captured_spc_permission_audit as
select *
from public.audit_logs
where actor_id = 'spc:audit-test@example.com'
  and table_schema = 'public'
  and table_name = 'office_calendar_store'
  and coalesce(record_pk ->> 'key', '') = 'spc-permission-groups'
order by occurred_at desc
limit 1;

select is(
  (select count(*)::integer from captured_spc_permission_audit),
  1,
  'a permission-store write produces one attributable audit row'
);

select has_trigger(
  'public',
  'office_calendar_store',
  'block_partial_spc_permission_store_audit_undo',
  'SPC permission and profile state cannot be independently restored'
);

select throws_ok(
  format(
    'select public.undo_audit_log(%L::uuid, %L, %L)',
    (select id::text from captured_spc_permission_audit),
    'spc:audit-test@example.com',
    'SPC AUDIT TEST'
  ),
  'P0001',
  'SPC permission-group audit records cannot be undone independently. Use SPC User Management.',
  'the generic audit RPC cannot partially undo coupled SPC user-security state'
);

select ok(
  (
    select request_context @> jsonb_build_object(
      'sourceIp', '203.0.113.19',
      'correlationId', '11111111-1111-4111-8111-111111111111',
      'requestId', '11111111-1111-4111-8111-111111111111',
      'platformRequestId', 'hkg1::audit-test',
      'actorRole', 'ADMIN',
      'action', 'save-permission-groups',
      'targetType', 'spc-permission-groups',
      'targetId', 'spc-permission-groups',
      'outcome', 'success',
      'approvalReference', 'CHANGE-2042'
    )
    from captured_spc_permission_audit
  ),
  'the trigger records source, action, outcome, target, and system-log references'
);

create temporary table captured_spc_denied_audit as
with inserted as (
  insert into public.audit_logs (
    actor_id,
    actor_name,
    actor_source,
    table_schema,
    table_name,
    operation,
    record_pk,
    changed_fields,
    before_row,
    after_row,
    request_context
  ) values (
    'spc:audit-test@example.com',
    'SPC AUDIT TEST',
    'app',
    'app',
    'spc_user_management_events',
    'UPDATE',
    jsonb_build_object(
      'requestId', '22222222-2222-4222-8222-222222222222',
      'targetType', 'spc-user',
      'targetId', 'user-1'
    ),
    array[]::text[],
    null,
    jsonb_build_object(
      'schema', 'fcuno.spc-user-management-audit/v1',
      'action', 'update-user',
      'outcome', 'denied',
      'errorCode', 'admin-required',
      'targetType', 'spc-user',
      'targetId', 'user-1',
      'targetUsername', 'buyer@example.com'
    ),
    jsonb_build_object(
      'pageId', 'spc-user-management',
      'pageLabel', 'SPC USER MANAGEMENT',
      'pagePath', '/spc/usermanagement',
      'sourceIp', '203.0.113.19',
      'correlationId', '22222222-2222-4222-8222-222222222222',
      'requestId', '22222222-2222-4222-8222-222222222222',
      'platformRequestId', 'hkg1::denied-test',
      'actorRole', 'BUYER TRADER',
      'action', 'update-user',
      'targetType', 'spc-user',
      'targetId', 'user-1',
      'targetUsername', 'buyer@example.com',
      'outcome', 'denied'
    )
  )
  returning id
)
select id from inserted;

select is(
  (select count(*)::integer from captured_spc_denied_audit),
  1,
  'a schema-constrained denied event can be appended'
);

select ok(
  has_function_privilege(
    'service_role',
    'private.is_spc_user_management_audit_record(public.audit_logs)',
    'EXECUTE'
  ),
  'the server-only role can execute the trigger classification helper'
);

set local role service_role;

insert into public.audit_logs (
  actor_id,
  actor_name,
  actor_source,
  table_schema,
  table_name,
  operation,
  record_pk,
  changed_fields,
  before_row,
  after_row,
  request_context
) values (
  'spc:service-role-audit-test@example.com',
  'SPC SERVICE ROLE AUDIT TEST',
  'app',
  'app',
  'spc_user_management_events',
  'UPDATE',
  '{"requestId":"44444444-4444-4444-8444-444444444444","targetType":"spc-user","targetId":"user-2"}'::jsonb,
  array[]::text[],
  null,
  '{"schema":"fcuno.spc-user-management-audit/v1","action":"change-password","outcome":"failed","errorCode":"invalid-request","targetType":"spc-user","targetId":"user-2","targetUsername":"buyer2@example.com"}'::jsonb,
  '{"pageId":"spc-user-management","pageLabel":"SPC USER MANAGEMENT","pagePath":"/spc/usermanagement","sourceIp":"203.0.113.20","correlationId":"44444444-4444-4444-8444-444444444444","requestId":"44444444-4444-4444-8444-444444444444","platformRequestId":"hkg1::service-role-test","actorRole":"BUYER TRADER","action":"change-password","targetType":"spc-user","targetId":"user-2","targetUsername":"buyer2@example.com","outcome":"failed","passwordChanged":true}'::jsonb
);

reset role;

select is(
  (
    select count(*)::integer
    from public.audit_logs
    where actor_id = 'spc:service-role-audit-test@example.com'
      and table_schema = 'app'
      and table_name = 'spc_user_management_events'
  ),
  1,
  'service_role can append a valid schema-constrained security event'
);

select throws_ok(
  format(
    'update public.audit_logs set actor_name = %L where id = %L::uuid',
    'TAMPERED',
    (select id::text from captured_spc_denied_audit)
  ),
  'P0001',
  'SPC user-management audit records are append-only.',
  'a protected SPC audit row cannot be edited'
);

select throws_ok(
  format(
    'delete from public.audit_logs where id = %L::uuid',
    (select id::text from captured_spc_denied_audit)
  ),
  'P0001',
  'SPC user-management audit records are append-only.',
  'a protected SPC audit row cannot be deleted'
);

select throws_ok(
  $test$
    insert into public.audit_logs (
      actor_id,
      actor_name,
      actor_source,
      table_schema,
      table_name,
      operation,
      record_pk,
      changed_fields,
      after_row,
      request_context
    ) values (
      'spc:audit-test@example.com',
      'SPC AUDIT TEST',
      'app',
      'app',
      'spc_user_management_events',
      'UPDATE',
      '{"requestId":"33333333-3333-4333-8333-333333333333","targetType":"spc-user"}'::jsonb,
      array[]::text[],
      '{"schema":"fcuno.spc-user-management-audit/v1","action":"update-user","outcome":"denied","errorCode":"admin-required","targetType":"spc-user"}'::jsonb,
      '{"pageId":"spc-user-management","pageLabel":"SPC USER MANAGEMENT","pagePath":"/spc/usermanagement","correlationId":"33333333-3333-4333-8333-333333333333","requestId":"33333333-3333-4333-8333-333333333333","actorRole":"BUYER TRADER","action":"update-user","targetType":"spc-user","outcome":"denied","password":"must-not-be-stored"}'::jsonb
    )
  $test$,
  'P0001',
  'Invalid SPC user-management audit event.',
  'unexpected credential-shaped metadata is rejected'
);

select throws_ok(
  'truncate table public.audit_logs cascade',
  'P0001',
  'audit_logs cannot be truncated because it contains protected SPC user-management evidence.',
  'the audit evidence table cannot be truncated'
);

select ok(
  not has_function_privilege(
    'anon',
    'private.protect_spc_user_management_audit_record()',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'private.protect_spc_user_management_audit_record()',
    'EXECUTE'
  ),
  'Data API roles cannot invoke the audit protection function directly'
);

select * from finish();
rollback;
