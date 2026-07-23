begin;
select plan(12);

select has_table(
  'public',
  'admin_sessions',
  'database-backed admin session table exists'
);

select hasnt_column(
  'public',
  'admin_sessions',
  'token',
  'raw admin session tokens are never stored'
);

select ok(
  (
    select relrowsecurity
    from pg_catalog.pg_class
    where oid = 'public.admin_sessions'::regclass
  )
  and not has_table_privilege('anon', 'public.admin_sessions', 'SELECT')
  and not has_table_privilege('authenticated', 'public.admin_sessions', 'SELECT')
  and has_table_privilege('service_role', 'public.admin_sessions', 'SELECT'),
  'admin sessions are service-role only with RLS defense in depth'
);

select has_column(
  'public',
  'admin_users',
  'is_active',
  'admin users expose active state'
);

select has_column(
  'public',
  'admin_users',
  'password_reset_required',
  'admin users expose forced-rotation state'
);

select ok(
  not has_table_privilege('anon', 'public.audit_logs', 'SELECT')
  and not has_table_privilege('authenticated', 'public.audit_logs', 'SELECT'),
  'audit logs are not available to Data API roles'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.complete_admin_password_reset(uuid,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.complete_admin_password_reset(uuid,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.complete_admin_password_reset(uuid,text)',
    'EXECUTE'
  ),
  'only the hosted service can complete password rotation'
);

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
  after_row
) values (
  '__admin_security_test__',
  'Admin Security Test',
  'app',
  'public',
  'admin_users',
  'UPDATE',
  '{"id":"10000000-0000-4000-8000-000000000001"}'::jsonb,
  array['password_hash'],
  '{"username":"test","password_hash":"must-not-survive"}'::jsonb,
  '{"username":"test","password_hash":"must-not-survive-either"}'::jsonb
);

select ok(
  not exists (
    select 1
    from public.audit_logs
    where table_schema = 'public'
      and table_name = 'admin_users'
      and (
        changed_fields @> array['password_hash']::text[]
        or
        coalesce(before_row, '{}'::jsonb) ? 'password_hash'
        or coalesce(after_row, '{}'::jsonb) ? 'password_hash'
      )
  ),
  'admin-user audit snapshots never retain password hashes'
);

insert into public.admin_users (
  id,
  username,
  display_name,
  role,
  password_hash,
  is_active,
  password_reset_required
) values (
  '10000000-0000-4000-8000-000000000001',
  '__admin_security_test__',
  'Admin Security Test',
  'AC',
  'scrypt:00000000000000000000000000000000:11111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111',
  true,
  true
);

insert into public.admin_sessions (
  id,
  admin_user_id,
  token_hash,
  expires_at
) values
  (
    '20000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    repeat('a', 64),
    clock_timestamp() + interval '1 hour'
  ),
  (
    '20000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000001',
    repeat('b', 64),
    clock_timestamp() + interval '1 hour'
  );

select is(
  public.complete_admin_password_reset(
    '20000000-0000-4000-8000-000000000001',
    'scrypt:22222222222222222222222222222222:33333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333'
  ),
  true,
  'a valid restricted session completes password rotation'
);

select ok(
  (
    select not password_reset_required
      and password_hash like 'scrypt:22222222222222222222222222222222:%'
    from public.admin_users
    where id = '10000000-0000-4000-8000-000000000001'
  ),
  'password rotation stores the fresh hash and clears the reset flag'
);

select ok(
  (
    select revoked_at is null
    from public.admin_sessions
    where id = '20000000-0000-4000-8000-000000000001'
  )
  and (
    select revoked_at is not null
    from public.admin_sessions
    where id = '20000000-0000-4000-8000-000000000002'
  ),
  'password rotation preserves only the completing session'
);

create table public.admin_undo_guard_test (
  id uuid primary key,
  value text not null,
  updated_at timestamptz not null default clock_timestamp()
);

do $$
begin
  perform public.audit_enable_table(
    'public.admin_undo_guard_test'::regclass
  );
  perform set_config(
    'app.audit_actor_id',
    '__admin_security_test__',
    true
  );
  perform set_config(
    'app.audit_actor_name',
    'Admin Security Test',
    true
  );
end;
$$;

insert into public.admin_undo_guard_test(id, value)
values ('30000000-0000-4000-8000-000000000001', 'first');

update public.admin_undo_guard_test
set value = 'second'
where id = '30000000-0000-4000-8000-000000000001';

create temporary table captured_admin_undo_log as
select id
from public.audit_logs
where table_name = 'admin_undo_guard_test'
  and operation = 'UPDATE'
order by occurred_at desc
limit 1;

update public.admin_undo_guard_test
set value = 'third'
where id = '30000000-0000-4000-8000-000000000001';

select throws_like(
  format(
    'select public.undo_audit_log(%L::uuid, %L, %L)',
    (select id::text from captured_admin_undo_log),
    '__admin_security_test__',
    'Admin Security Test'
  ),
  '%Undo conflict:%',
  'undo refuses to overwrite a row changed after the selected audit record'
);

select * from finish();
rollback;
