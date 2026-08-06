begin;
select plan(23);

select ok(
  has_function_privilege(
    'service_role',
    'public.save_spc_user_with_admin_continuity(uuid,text,text,text,text,text,text,boolean,boolean,text,boolean)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.save_spc_user_with_admin_continuity(uuid,text,text,text,text,text,text,boolean,boolean,text,boolean)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.save_spc_user_with_admin_continuity(uuid,text,text,text,text,text,text,boolean,boolean,text,boolean)',
    'EXECUTE'
  ),
  'only the hosted service can invoke the transactional SPC user-save RPC'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.delete_spc_user_with_admin_continuity(uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.delete_spc_user_with_admin_continuity(uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.delete_spc_user_with_admin_continuity(uuid)',
    'EXECUTE'
  ),
  'only the hosted service can invoke the transactional SPC user-delete RPC'
);

select has_trigger(
  'public',
  'spc_users',
  'lock_spc_user_administration',
  'SPC user writes acquire the shared transaction lock'
);

select has_trigger(
  'public',
  'spc_users',
  'enforce_spc_active_admin_continuity',
  'SPC user writes have a deferred active-admin invariant'
);

select has_trigger(
  'public',
  'office_calendar_store',
  'lock_spc_permission_store_administration',
  'SPC permission-store writes acquire the shared transaction lock'
);

select has_trigger(
  'public',
  'office_calendar_store',
  'enforce_spc_permission_store_admin_continuity',
  'SPC permission-store writes have a deferred active-admin invariant'
);

select ok(
  not has_table_privilege('anon', 'public.spc_users', 'TRUNCATE')
  and not has_table_privilege('authenticated', 'public.spc_users', 'TRUNCATE')
  and not has_table_privilege('service_role', 'public.spc_users', 'TRUNCATE')
  and not has_table_privilege('anon', 'public.office_calendar_store', 'TRUNCATE')
  and not has_table_privilege('authenticated', 'public.office_calendar_store', 'TRUNCATE')
  and not has_table_privilege('service_role', 'public.office_calendar_store', 'TRUNCATE'),
  'Data API and hosted-service roles cannot bypass row invariants with TRUNCATE'
);

create temporary table test_spc_admins as
select *
from public.save_spc_user_with_admin_continuity(
  null::uuid,
  '__spc_continuity_admin_a__@example.com',
  'SPC Continuity Admin A',
  null,
  'buyer_trader',
  'ADMIN',
  'HONG KONG',
  false,
  false,
  'scrypt:00000000000000000000000000000000:11111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111',
  true
);

select is(
  (select count(*)::integer from test_spc_admins),
  1,
  'the transactional save creates an ADMIN account'
);

select is(
  (
    select profile.value ->> 'mustChangePassword'
    from public.office_calendar_store as store
    cross join lateral jsonb_array_elements(store.payload -> 'userProfiles') as profile(value)
    where store.key = 'spc-permission-groups'
      and profile.value ->> 'userId' = (select id::text from test_spc_admins limit 1)
  ),
  'true',
  'new accounts are forced to change password even when the caller requests false'
);

select ok(
  pg_get_function_result(
    'public.save_spc_user_with_admin_continuity(uuid,text,text,text,text,text,text,boolean,boolean,text,boolean)'::regprocedure
  ) not ilike '%password_hash%',
  'the transactional save result never returns a password hash'
);

insert into test_spc_admins
select *
from public.save_spc_user_with_admin_continuity(
  null::uuid,
  '__spc_continuity_admin_b__@example.com',
  'SPC Continuity Admin B',
  null,
  'buyer_trader',
  'ADMIN',
  'SINGAPORE',
  false,
  false,
  'scrypt:22222222222222222222222222222222:33333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333',
  true
);

select is(
  (select count(*)::integer from test_spc_admins),
  2,
  'a second active ADMIN can be created normally'
);

update public.office_calendar_store as store
set payload = jsonb_set(
  store.payload,
  '{userRoles}',
  (
    select jsonb_agg(
      jsonb_build_object(
        'userId', users.id,
        'username', users.username,
        'role', case
          when users.id in (select id from test_spc_admins) then 'ADMIN'
          else 'BUYER TRADER'
        end,
        'updatedAt', clock_timestamp()
      )
      order by users.id
    )
    from public.spc_users as users
  ),
  true
), updated_at = clock_timestamp()
where store.key = 'spc-permission-groups';

select lives_ok(
  $test$
    select *
    from public.save_spc_user_with_admin_continuity(
      (select id from test_spc_admins order by username limit 1),
      '__spc_continuity_admin_a__@example.com',
      'SPC Continuity Admin A',
      null,
      'buyer_trader',
      'BUYER TRADER',
      'HONG KONG',
      null,
      false,
      null,
      true
    )
  $test$,
  'one ADMIN can be demoted while another active ADMIN remains'
);

select throws_ok(
  $test$
    select *
    from public.save_spc_user_with_admin_continuity(
      (select id from test_spc_admins order by username desc limit 1),
      '__spc_continuity_admin_b__@example.com',
      'SPC Continuity Admin B',
      null,
      'buyer_trader',
      'BUYER TRADER',
      'SINGAPORE',
      null,
      false,
      null,
      true
    )
  $test$,
  'P0001',
  'The final active ADMIN cannot be demoted, deactivated, or deleted.',
  'the database rejects demotion of the final active ADMIN'
);

select is(
  (
    select private.spc_effective_role(
      users.id,
      users.username,
      users.role,
      store.payload
    )
    from public.spc_users as users
    cross join public.office_calendar_store as store
    where users.id = (select id from test_spc_admins order by username desc limit 1)
      and store.key = 'spc-permission-groups'
  ),
  'ADMIN',
  'a rejected demotion rolls back both the user row and permission metadata'
);

create or replace function pg_temp.fail_spc_permission_store_write()
returns trigger
language plpgsql
as $$
begin
  if current_setting('spc.test_fail_permission_store', true) = 'on'
    and new.key = 'spc-permission-groups'
  then
    raise exception 'forced permission-store failure';
  end if;
  return new;
end;
$$;

create trigger test_fail_spc_permission_store_write
before insert or update on public.office_calendar_store
for each row
execute function pg_temp.fail_spc_permission_store_write();

select set_config('spc.test_fail_permission_store', 'on', true);

select throws_ok(
  $test$
    select *
    from public.save_spc_user_with_admin_continuity(
      null::uuid,
      '__spc_atomic_failure__@example.com',
      'SPC Atomic Failure',
      null,
      'buyer_trader',
      'BUYER TRADER',
      'ITALY',
      false,
      false,
      'scrypt:44444444444444444444444444444444:55555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555',
      true
    )
  $test$,
  'P0001',
  'forced permission-store failure',
  'a permission-metadata failure aborts the whole user creation'
);

select set_config('spc.test_fail_permission_store', 'off', true);

select is(
  (
    select count(*)::integer
    from public.spc_users
    where username = '__spc_atomic_failure__@example.com'
  ),
  0,
  'a failed permission-store write leaves no active credential row behind'
);

select is(
  (
    select count(*)::integer
    from public.office_calendar_store as store
    cross join lateral jsonb_array_elements(store.payload -> 'userProfiles') as profile(value)
    where store.key = 'spc-permission-groups'
      and profile.value ->> 'username' = '__spc_atomic_failure__@example.com'
  ),
  0,
  'a failed transactional save leaves no orphaned user profile metadata'
);

select lives_ok(
  $test$
    select public.delete_spc_user_with_admin_continuity(
      (select id from test_spc_admins order by username limit 1)
    )
  $test$,
  'a non-final user can be deleted normally'
);

select ok(
  not exists (
    select 1
    from public.office_calendar_store as store
    cross join lateral jsonb_array_elements(store.payload -> 'userRoles') as assignment(value)
    where store.key = 'spc-permission-groups'
      and assignment.value ->> 'username' = '__spc_continuity_admin_a__@example.com'
  )
  and not exists (
    select 1
    from public.office_calendar_store as store
    cross join lateral jsonb_array_elements(store.payload -> 'userProfiles') as profile(value)
    where store.key = 'spc-permission-groups'
      and profile.value ->> 'username' = '__spc_continuity_admin_a__@example.com'
  ),
  'transactional delete removes both role and profile metadata'
);

select throws_ok(
  format(
    'select public.delete_spc_user_with_admin_continuity(%L::uuid)',
    (select id::text from test_spc_admins order by username desc limit 1)
  ),
  'P0001',
  'The final active ADMIN cannot be demoted, deactivated, or deleted.',
  'the delete RPC rejects removal of the final active ADMIN'
);

set constraints all immediate;

select throws_ok(
  $test$
    update public.office_calendar_store
    set key = 'spc-permission-groups-renamed'
    where key = 'spc-permission-groups'
  $test$,
  'P0001',
  'The final active ADMIN cannot be demoted, deactivated, or deleted.',
  'renaming the protected permission-store key cannot bypass the ADMIN invariant'
);

select throws_ok(
  format(
    'delete from public.spc_users where id = %L::uuid',
    (select id::text from test_spc_admins order by username desc limit 1)
  ),
  'P0001',
  'The final active ADMIN cannot be demoted, deactivated, or deleted.',
  'the deferred database trigger also rejects a direct final-ADMIN delete'
);

select is(
  (
    select count(*)::integer
    from public.spc_users
    where id = (select id from test_spc_admins order by username desc limit 1)
  ),
  1,
  'the final active ADMIN remains after rejected RPC and direct-delete attempts'
);

select * from finish();
rollback;
