begin;
select plan(20);

select has_table(
  'public',
  'outlook_exchange_truth_ledger',
  'immutable FCUNO Exchange truth ledger exists'
);

select has_table(
  'public',
  'outlook_exchange_truth_snapshots',
  'content-addressed FCUNO Exchange snapshots exist'
);

select ok(
  (
    select relrowsecurity
    from pg_catalog.pg_class
    where oid = 'public.outlook_exchange_truth_ledger'::regclass
  )
  and (
    select relrowsecurity
    from pg_catalog.pg_class
    where oid = 'public.outlook_exchange_truth_snapshots'::regclass
  ),
  'truth tables enforce row level security'
);

select ok(
  has_table_privilege(
    'service_role',
    'public.outlook_exchange_truth_ledger',
    'SELECT'
  )
  and not has_table_privilege(
    'service_role',
    'public.outlook_exchange_truth_ledger',
    'INSERT'
  )
  and not has_table_privilege(
    'service_role',
    'public.outlook_exchange_truth_ledger',
    'UPDATE'
  )
  and not has_table_privilege(
    'service_role',
    'public.outlook_exchange_truth_ledger',
    'DELETE'
  ),
  'service_role can read but cannot mutate the truth ledger'
);

select ok(
  has_table_privilege(
    'service_role',
    'public.outlook_exchange_truth_snapshots',
    'SELECT'
  )
  and not has_table_privilege(
    'service_role',
    'public.outlook_exchange_truth_snapshots',
    'INSERT'
  )
  and not has_table_privilege(
    'service_role',
    'public.outlook_exchange_truth_snapshots',
    'UPDATE'
  )
  and not has_table_privilege(
    'service_role',
    'public.outlook_exchange_truth_snapshots',
    'DELETE'
  ),
  'service_role can read but cannot mutate canonical snapshots'
);

select ok(
  not has_table_privilege(
    'service_role',
    'public.outlook_exchange_sync_certifications',
    'INSERT'
  )
  and not has_table_privilege(
    'service_role',
    'public.outlook_exchange_sync_certifications',
    'UPDATE'
  )
  and not has_table_privilege(
    'service_role',
    'public.outlook_exchange_sync_certifications',
    'DELETE'
  ),
  'service_role cannot forge or rewrite certification receipts'
);

select ok(
  not has_function_privilege(
    'service_role',
    'public.certify_full_outlook_exchange_sync_queue(uuid,bigint,timestamptz,text)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.certify_full_outlook_exchange_truth(uuid,bigint,timestamptz,text,text,jsonb,jsonb,text)',
    'EXECUTE'
  ),
  'only evidence-backed full certification is exposed to the worker'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.get_outlook_exchange_truth_checkpoint()',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.verify_outlook_exchange_truth_ledger()',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.verify_outlook_exchange_truth_ledger()',
    'EXECUTE'
  ),
  'only the service worker can read verification RPCs'
);

select ok(
  (public.verify_outlook_exchange_truth_ledger() ->> 'integrityValid')::boolean,
  'installed legacy backfill and baseline pass full-chain verification'
);

select ok(
  (public.get_outlook_exchange_truth_checkpoint() ->> 'checkpointValid')::boolean,
  'installed baseline has a valid constant-time ledger checkpoint'
);

select ok(
  not has_table_privilege(
    'service_role',
    'public.outlook_exchange_sync_queue',
    'INSERT'
  )
  and not has_table_privilege(
    'service_role',
    'public.outlook_exchange_sync_queue',
    'DELETE'
  )
  and not has_table_privilege(
    'service_role',
    'public.outlook_exchange_sync_queue',
    'TRUNCATE'
  ),
  'worker cannot insert or delete durable queue delivery state directly'
);

select ok(
  not has_table_privilege(
    'service_role',
    'public.shared_addressbook_contacts',
    'TRUNCATE'
  )
  and not has_table_privilege(
    'service_role',
    'public.shared_addressbook_groups',
    'TRUNCATE'
  )
  and not has_table_privilege(
    'service_role',
    'public.shared_addressbook_group_members',
    'TRUNCATE'
  ),
  'worker cannot truncate the authoritative FCUNO source'
);

select ok(
  not has_table_privilege(
    'service_role',
    'public.audit_logs',
    'UPDATE'
  )
  and not has_table_privilege(
    'service_role',
    'public.audit_logs',
    'DELETE'
  )
  and not has_table_privilege(
    'service_role',
    'public.audit_logs',
    'TRUNCATE'
  ),
  'worker cannot rewrite or delete durable audit evidence directly'
);

create temporary table truth_queue_fence (
  high_water_sequence bigint not null,
  high_water_updated_at timestamptz
) on commit drop;

insert into truth_queue_fence (
  high_water_sequence,
  high_water_updated_at
)
select
  coalesce(queue.queue_sequence, 0),
  queue.updated_at
from (values (true)) as seed(ready)
left join lateral (
  select
    current_queue.queue_sequence,
    current_queue.updated_at
  from public.outlook_exchange_sync_queue as current_queue
  order by current_queue.updated_at desc, current_queue.queue_sequence desc
  limit 1
) as queue on seed.ready;

create temporary table truth_certification_result (
  value jsonb not null
) on commit drop;

insert into truth_certification_result(value)
select public.certify_full_outlook_exchange_truth(
  'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  (select high_water_sequence from truth_queue_fence),
  (select high_water_updated_at from truth_queue_fence),
  public.outlook_exchange_truth_sha256(
    '{"contacts":[],"groups":[],"members":[],"invalidContacts":[],"skippedInvalidContacts":[],"duplicateContacts":[]}'
  ),
  '{"contacts":[],"groups":[],"members":[],"invalidContacts":[],"skippedInvalidContacts":[],"duplicateContacts":[]}',
  '{
    "contacts": 0,
    "groups": 0,
    "members": 0,
    "invalidContacts": 0,
    "skippedInvalidContacts": 0,
    "duplicateContacts": 0
  }'::jsonb,
  jsonb_build_object(
    'status', 'match',
    'mismatchCount', 0,
    'verifiedManagedContacts', 0,
    'verifiedManagedGroups', 0,
    'verifiedMembershipGroups', 0,
    'verifiedMemberships', 0,
    'sourceFenceStable', true,
    'queueFence', (
      select high_water_sequence::text
      from truth_queue_fence
    ),
    'sourceFingerprint', public.outlook_exchange_truth_sha256(
      '{"contacts":[],"groups":[],"members":[],"invalidContacts":[],"skippedInvalidContacts":[],"duplicateContacts":[]}'
    )
  ),
  'fcuno-exchange-runbook/2026-07-23.1'
);

select ok(
  (value ->> 'certified')::boolean
  and (value ->> 'evidenceRecorded')::boolean,
  'full certification atomically records canonical projection evidence'
)
from truth_certification_result;

select ok(
  (value ->> 'truthLedgerSequence')::bigint > 0
  and value ->> 'truthLedgerHash' ~ '^[0-9a-f]{64}$'
  and value ->> 'runId' = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  and value ->> 'sourceSnapshotHash' = value ->> 'sourceFingerprint'
  and value ->> 'rawSourceSnapshotHash' ~ '^[0-9a-f]{64}$'
  and (value #>> '{queueFence,expectedSequence}')::bigint
    = (select high_water_sequence from truth_queue_fence)
  and (value #>> '{queueFence,currentSequence}')::bigint
    = (select high_water_sequence from truth_queue_fence)
  and (value #>> '{queueFence,expectedUpdatedAt}')::timestamptz
    is not distinct from (
      select high_water_updated_at
      from truth_queue_fence
    )
  and (value #>> '{queueFence,currentUpdatedAt}')::timestamptz
    is not distinct from (
      select high_water_updated_at
      from truth_queue_fence
    ),
  'certification returns a run- and fence-bound externally anchorable receipt'
)
from truth_certification_result;

select is(
  (
    select count(*)::integer
    from public.outlook_exchange_truth_ledger
    where event_key in (
      'certification:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      'projection:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    )
  ),
  2,
  'certification and canonical projection are separate immutable events'
);

select is(
  (
    select count(*)::integer
    from public.outlook_exchange_truth_snapshots
    where snapshot_sha256 in (
      select value ->> 'sourceSnapshotHash'
      from truth_certification_result
      union
      select value ->> 'rawSourceSnapshotHash'
      from truth_certification_result
    )
  ),
  2,
  'certification links both raw FCUNO and canonical projection snapshots'
);

select ok(
  (public.verify_outlook_exchange_truth_ledger() ->> 'integrityValid')::boolean
  and (
    public.verify_outlook_exchange_truth_ledger() ->> 'referencesValid'
  )::boolean
  and (
    public.verify_outlook_exchange_truth_ledger()
      ->> 'latestCertificationHasProjectionEvidence'
  )::boolean,
  'full verifier validates the appended certification evidence'
);

select ok(
  (public.get_outlook_exchange_truth_checkpoint() ->> 'checkpointValid')::boolean
  and public.get_outlook_exchange_truth_checkpoint()
    ->> 'latestCertificationRunId'
      = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  and public.get_outlook_exchange_truth_checkpoint()
    ->> 'headEventType' = 'full_projection_evidence'
  and public.get_outlook_exchange_truth_checkpoint()
    ->> 'headRunId' = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  and public.get_outlook_exchange_truth_checkpoint()
    ->> 'headPreviousSha256' ~ '^[0-9a-f]{64}$',
  'constant-time checkpoint identifies its latest certified run and cryptographic predecessor'
);

select is(
  (
    select count(*)::integer
    from public.outlook_exchange_truth_ledger
    where occurred_at_canonical
      <> public.outlook_exchange_truth_timestamp(occurred_at)
  ),
  0,
  'every truth event hashes the exact canonical occurrence timestamp'
);

select * from finish();
rollback;
