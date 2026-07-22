begin;
select plan(18);

insert into public.outlook_exchange_sync_queue (
  id,
  action,
  entity_type,
  entity_id,
  entity_key,
  display_name,
  status,
  attempts,
  error_message,
  processing_started_at,
  claimed_at,
  next_attempt_at,
  run_id
)
values
  (
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    'update_contact',
    'contact',
    'stale-retry',
    'test:stale-retry',
    'Stale retry',
    'processing',
    1,
    'unfinished first attempt',
    clock_timestamp() - interval '21 minutes',
    clock_timestamp() - interval '21 minutes',
    null,
    '11111111-1111-4111-8111-111111111111'
  ),
  (
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',
    'update_contact',
    'contact',
    'stale-terminal',
    'test:stale-terminal',
    'Stale terminal',
    'processing',
    3,
    'unfinished third attempt',
    clock_timestamp() - interval '21 minutes',
    clock_timestamp() - interval '21 minutes',
    null,
    '33333333-3333-4333-8333-333333333333'
  ),
  (
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
    'update_contact',
    'contact',
    'failed-due',
    'test:failed-due',
    'Failed due',
    'failed',
    1,
    'Exchange throttled',
    null,
    null,
    clock_timestamp() - interval '1 minute',
    '44444444-4444-4444-8444-444444444444'
  ),
  (
    'cccccccc-cccc-4ccc-8ccc-ccccccccccc3',
    'update_contact',
    'contact',
    'fresh-processing',
    'test:fresh-processing',
    'Fresh processing',
    'processing',
    3,
    null,
    clock_timestamp(),
    clock_timestamp(),
    null,
    '55555555-5555-4555-8555-555555555555'
  ),
  (
    'dddddddd-dddd-4ddd-8ddd-ddddddddddd0',
    'update_contact',
    'contact',
    'pending',
    'test:stale-terminal',
    'Pending',
    'pending',
    0,
    null,
    null,
    null,
    null,
    null
  );

create temporary table claimed_queue_rows on commit drop as
select *
from public.claim_outlook_exchange_sync_queue(
  '99999999-9999-4999-8999-999999999999',
  10
);

select has_column(
  'public',
  'outlook_exchange_sync_queue',
  'error_history',
  'queue rows retain an append-only error history'
);

select col_type_is(
  'public',
  'outlook_exchange_sync_queue',
  'error_history',
  'jsonb',
  'error history is stored as jsonb'
);

select ok(
  (
    select relrowsecurity
    from pg_catalog.pg_class
    where oid = 'public.outlook_exchange_sync_queue'::regclass
  ),
  'row level security remains enabled on the queue'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.claim_outlook_exchange_sync_queue(uuid,integer)',
    'EXECUTE'
  ),
  'service_role can execute the claim RPC'
);

select ok(
  not has_function_privilege(
    'anon',
    'public.claim_outlook_exchange_sync_queue(uuid,integer)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.claim_outlook_exchange_sync_queue(uuid,integer)',
    'EXECUTE'
  ),
  'client roles cannot execute the privileged claim RPC'
);

select ok(
  not has_table_privilege('anon', 'public.outlook_exchange_sync_queue', 'SELECT')
  and not has_table_privilege('anon', 'public.outlook_exchange_sync_queue', 'INSERT')
  and not has_table_privilege('anon', 'public.outlook_exchange_sync_queue', 'UPDATE')
  and not has_table_privilege('anon', 'public.outlook_exchange_sync_queue', 'DELETE'),
  'anon retains no direct queue read or mutation privileges'
);

select ok(
  not has_table_privilege('authenticated', 'public.outlook_exchange_sync_queue', 'SELECT')
  and not has_table_privilege('authenticated', 'public.outlook_exchange_sync_queue', 'INSERT')
  and not has_table_privilege('authenticated', 'public.outlook_exchange_sync_queue', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.outlook_exchange_sync_queue', 'DELETE'),
  'authenticated retains no direct queue read or mutation privileges'
);

select is(
  (
    select count(*)
    from pg_catalog.pg_policy
    where polrelid = 'public.outlook_exchange_sync_queue'::regclass
      and polcmd in ('r', '*')
      and pg_get_expr(polqual, polrelid) = 'true'
  ),
  0::bigint,
  'the queue has no permissive public SELECT policy'
);

select results_eq(
  $$
    select id
    from claimed_queue_rows
    order by id
  $$,
  $$
    values
      ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'::uuid),
      ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1'::uuid),
      ('dddddddd-dddd-4ddd-8ddd-ddddddddddd0'::uuid)
  $$,
  'only pending, due failed, and retryable stale rows are claimed'
);

select ok(
  (
    select status = 'processing'
      and attempts = 2
      and run_id = '99999999-9999-4999-8999-999999999999'::uuid
      and error_message is null
      and next_attempt_at is null
    from public.outlook_exchange_sync_queue
    where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
  ),
  'a retryable stale lease is normalized and reclaimed as attempt two'
);

select is(
  (
    select count(*)
    from public.outlook_exchange_sync_queue as queue,
      jsonb_array_elements(queue.error_history) as event
    where queue.id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
      and event ->> 'type' = 'lease_expired'
      and event ->> 'previous_error_message' = 'unfinished first attempt'
  ),
  1::bigint,
  'the expired lease and its previous error are retained'
);

select is(
  (
    select count(*)
    from public.outlook_exchange_sync_queue as queue,
      jsonb_array_elements(queue.error_history) as event
    where queue.id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
      and event ->> 'type' = 'retry_claimed'
      and (event ->> 'from_attempt')::integer = 1
      and (event ->> 'to_attempt')::integer = 2
  ),
  1::bigint,
  'the retry claim is appended after the lease-expiry event'
);

select ok(
  (
    select status = 'failed'
      and attempts = 3
      and next_attempt_at is null
      and completed_at is not null
      and error_message like '%retry limit exhausted%terminally failed%'
    from public.outlook_exchange_sync_queue
    where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3'
  ),
  'a third expired claim becomes terminal failed with an explicit message'
);

select is(
  (
    select count(*)
    from public.outlook_exchange_sync_queue as queue,
      jsonb_array_elements(queue.error_history) as event
    where queue.id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3'
      and event ->> 'type' = 'lease_expired'
      and (event ->> 'terminal')::boolean
      and event ->> 'previous_error_message' = 'unfinished third attempt'
  ),
  1::bigint,
  'the terminal lease failure retains the third attempt context'
);

select ok(
  (
    select status = 'processing'
      and attempts = 2
      and error_message is null
      and next_attempt_at is null
    from public.outlook_exchange_sync_queue
    where id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1'
  ),
  'an ordinary due failure starts a clean second attempt'
);

select is(
  (
    select count(*)
    from public.outlook_exchange_sync_queue as queue,
      jsonb_array_elements(queue.error_history) as event
    where queue.id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1'
      and event ->> 'type' = 'retry_claimed'
      and event ->> 'previous_error_message' = 'Exchange throttled'
  ),
  1::bigint,
  'a normal retry archives the previous Exchange error before clearing it'
);

select ok(
  (
    select status = 'processing'
      and attempts = 3
      and run_id = '55555555-5555-4555-8555-555555555555'::uuid
    from public.outlook_exchange_sync_queue
    where id = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc3'
  ),
  'a non-expired processing lease is not disturbed'
);

select ok(
  (
    select status = 'processing'
      and attempts = 1
      and jsonb_array_length(error_history) = 0
    from public.outlook_exchange_sync_queue
    where id = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd0'
  ),
  'a newer pending row proceeds after the older entity row becomes terminal'
);

select * from finish();
rollback;
