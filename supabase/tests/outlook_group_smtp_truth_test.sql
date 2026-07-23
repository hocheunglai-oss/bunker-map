begin;
select plan(25);

select has_function(
  'public',
  'outlook_exchange_projection_has_exact_group_smtp',
  array['jsonb'],
  'projection group SMTP validator exists'
);

select has_function(
  'public',
  'outlook_exchange_worker_supports_group_smtp',
  array['text'],
  'group SMTP worker-version validator exists'
);

select has_trigger(
  'public',
  'outlook_exchange_truth_snapshots',
  'enforce_outlook_exchange_projection_group_smtp',
  'projection snapshots enforce exact group SMTP truth'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.certify_full_outlook_exchange_truth(uuid,bigint,timestamptz,text,text,jsonb,jsonb,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'service_role',
    'public.certify_full_outlook_exchange_truth_without_group_smtp_guard(uuid,bigint,timestamptz,text,text,jsonb,jsonb,text)',
    'EXECUTE'
  ),
  'worker can call only the SMTP-guarded certification RPC'
);

create temporary table group_smtp_truth_cases (
  case_name text primary key,
  canonical_json text not null,
  item_counts jsonb not null
) on commit drop;

insert into group_smtp_truth_cases (
  case_name,
  canonical_json,
  item_counts
)
values
  (
    'missing-smtp',
    '{"contacts":[],"groups":[{"sourceGroupId":"group-old","alias":"ops","memberCount":1}],"members":[],"invalidContacts":[],"skippedInvalidContacts":[],"duplicateContacts":[]}',
    '{"contacts":0,"groups":1,"members":0,"invalidContacts":0,"skippedInvalidContacts":0,"duplicateContacts":0}'::jsonb
  ),
  (
    'wrong-local-part',
    '{"contacts":[],"groups":[{"sourceGroupId":"group-wrong","alias":"ops","smtpAddress":"other@cosulich1.onmicrosoft.com","memberCount":1}],"members":[],"invalidContacts":[],"skippedInvalidContacts":[],"duplicateContacts":[]}',
    '{"contacts":0,"groups":1,"members":0,"invalidContacts":0,"skippedInvalidContacts":0,"duplicateContacts":0}'::jsonb
  ),
  (
    'wrong-domain',
    '{"contacts":[],"groups":[{"sourceGroupId":"group-domain","alias":"ops","smtpAddress":"ops@example.com","memberCount":1}],"members":[],"invalidContacts":[],"skippedInvalidContacts":[],"duplicateContacts":[]}',
    '{"contacts":0,"groups":1,"members":0,"invalidContacts":0,"skippedInvalidContacts":0,"duplicateContacts":0}'::jsonb
  ),
  (
    'duplicate-alias',
    '{"contacts":[],"groups":[{"sourceGroupId":"group-a","alias":"ops","smtpAddress":"ops@cosulich1.onmicrosoft.com","memberCount":1},{"sourceGroupId":"group-b","alias":"ops","smtpAddress":"ops@cosulich1.onmicrosoft.com","memberCount":1}],"members":[],"invalidContacts":[],"skippedInvalidContacts":[],"duplicateContacts":[]}',
    '{"contacts":0,"groups":2,"members":0,"invalidContacts":0,"skippedInvalidContacts":0,"duplicateContacts":0}'::jsonb
  ),
  (
    'exact-smtp',
    '{"contacts":[{"sourceContactId":"contact-one","directoryName":"Member One","displayName":"Member One","firstName":"Member","lastName":"One","baseAlias":"member.one","alias":"member.one","externalEmailAddress":"member.one@example.com","nickname":"member.one","sourceKey":"fcuno-contact:contact-one","allowedOwnerSourceKeys":[]}],"groups":[{"sourceGroupId":"group-one","directoryName":"Operations","groupName":"Operations","baseAlias":"ops","alias":"ops","smtpAddress":"ops@cosulich1.onmicrosoft.com","description":"","memberCount":1,"sourceKey":"fcuno-group:group-one"}],"members":[{"groupName":"Operations","groupAlias":"ops","memberDisplayName":"Member One","memberEmail":"member.one@example.com","sourceGroupId":"group-one","sourceContactId":"contact-one"}],"invalidContacts":[],"skippedInvalidContacts":[],"duplicateContacts":[]}',
    '{"contacts":1,"groups":1,"members":1,"invalidContacts":0,"skippedInvalidContacts":0,"duplicateContacts":0}'::jsonb
  );

select is(
  public.outlook_exchange_projection_has_exact_group_smtp(
    (select canonical_json::jsonb
     from group_smtp_truth_cases
     where case_name = 'missing-smtp')
  ),
  false,
  'legacy projection without smtpAddress is rejected'
);

select is(
  public.outlook_exchange_projection_has_exact_group_smtp(
    (select canonical_json::jsonb
     from group_smtp_truth_cases
     where case_name = 'wrong-local-part')
  ),
  false,
  'group SMTP local part must equal the certified alias'
);

select is(
  public.outlook_exchange_projection_has_exact_group_smtp(
    (select canonical_json::jsonb
     from group_smtp_truth_cases
     where case_name = 'wrong-domain')
  ),
  false,
  'group SMTP domain must equal the verified Exchange tenant domain'
);

select is(
  public.outlook_exchange_projection_has_exact_group_smtp(
    (select canonical_json::jsonb
     from group_smtp_truth_cases
     where case_name = 'duplicate-alias')
  ),
  false,
  'projection cannot certify duplicate group aliases'
);

select is(
  public.outlook_exchange_projection_has_exact_group_smtp(
    (select canonical_json::jsonb
     from group_smtp_truth_cases
     where case_name = 'exact-smtp')
  ),
  true,
  'projection with one exact lowercase SMTP address per group is valid'
);

select is(
  public.outlook_exchange_truth_snapshot_is_valid(
    public.outlook_exchange_truth_sha256(
      (select canonical_json
       from group_smtp_truth_cases
       where case_name = 'missing-smtp')
    ),
    'fcuno_exchange_projection',
    1,
    (select canonical_json
     from group_smtp_truth_cases
     where case_name = 'missing-smtp'),
    octet_length(
      (select canonical_json
       from group_smtp_truth_cases
       where case_name = 'missing-smtp')
    ),
    (select item_counts
     from group_smtp_truth_cases
     where case_name = 'missing-smtp')
  ),
  true,
  'historical schema-v1 validator preserves a legacy projection'
);

select is(
  public.reconcile_outlook_template_recipient_ref(
    '{"sourceId":"group-one"}'::jsonb,
    (select canonical_json::jsonb
     from group_smtp_truth_cases
     where case_name = 'exact-smtp')
  ),
  '{"sourceId":"group-one"}'::jsonb,
  'reconciliation does not infer group kind when the key is absent'
);

select is(
  public.reconcile_outlook_template_recipient_ref(
    '{"sourceId":"group-one","kind":null}'::jsonb,
    (select canonical_json::jsonb
     from group_smtp_truth_cases
     where case_name = 'exact-smtp')
  ),
  '{"sourceId":"group-one","kind":null}'::jsonb,
  'reconciliation does not infer group kind from JSON null'
);

select is(
  public.outlook_exchange_worker_supports_group_smtp(
    'fcuno-exchange-runbook/2026-07-23.2'
  ),
  false,
  'pre-SMTP worker certification is stale'
);

select is(
  public.outlook_exchange_worker_supports_group_smtp(
    'fcuno-exchange-runbook/2026-07-23.3'
  ),
  true,
  'SMTP-aware worker certification is accepted'
);

select is(
  public.outlook_exchange_worker_supports_group_smtp(
    'fcuno-exchange-runbook/9999-99-99.1'
  ),
  false,
  'worker version rejects an impossible calendar date'
);

create temporary table recipient_resolution_truth_case (
  value jsonb not null
) on commit drop;

insert into recipient_resolution_truth_case(value)
values (
  '{
    "schema":"fcuno.outlook-template-recipient-resolution/v1",
    "certificationRunId":"e2222222-2222-4222-8222-222222222222",
    "certifiedAt":"2026-07-23T13:13:03.000Z",
    "sourceFingerprint":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "resolvedAt":"2026-07-23T13:13:04.000Z",
    "refs":{
      "to":[{
        "field":"to",
        "position":0,
        "literal":"Operations",
        "displayName":"Operations",
        "sourceValue":"Operations",
        "kind":"group",
        "sourceId":"group-one",
        "resolvedAddress":"ops@cosulich1.onmicrosoft.com",
        "status":"resolved"
      }],
      "cc":[],
      "bcc":[]
    },
    "counts":{
      "total":1,
      "resolved":1,
      "external":0,
      "ambiguous":0,
      "missing":0
    },
    "reconciliationRequired":false
  }'::jsonb
);

select is(
  public.is_valid_outlook_template_recipient_resolution(
    (select value from recipient_resolution_truth_case)
  ),
  true,
  'recipient evidence fixture is valid'
);

select is(
  public.is_valid_outlook_template_recipient_resolution(
    (select value #- '{refs,to,0,kind}'
     from recipient_resolution_truth_case)
  ),
  false,
  'recipient evidence rejects a missing kind key'
);

select is(
  public.is_valid_outlook_template_recipient_resolution(
    (select jsonb_set(value, '{refs,to,0,kind}', 'null'::jsonb)
     from recipient_resolution_truth_case)
  ),
  false,
  'recipient evidence rejects a JSON-null kind'
);

select is(
  public.is_valid_outlook_template_recipient_resolution(
    (select value #- '{refs,to,0,status}'
     from recipient_resolution_truth_case)
  ),
  false,
  'recipient evidence rejects a missing status key'
);

select is(
  public.is_valid_outlook_template_recipient_resolution(
    (select jsonb_set(value, '{refs,to,0,status}', 'null'::jsonb)
     from recipient_resolution_truth_case)
  ),
  false,
  'recipient evidence rejects a JSON-null status'
);

create temporary table group_smtp_queue_fence (
  high_water_sequence bigint not null,
  high_water_updated_at timestamptz
) on commit drop;

insert into group_smtp_queue_fence (
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
  order by
    current_queue.updated_at desc,
    current_queue.queue_sequence desc
  limit 1
) as queue on seed.ready;

select throws_ok(
  $statement$
    select public.certify_full_outlook_exchange_truth(
      'd1111111-1111-4111-8111-111111111111',
      (select high_water_sequence from group_smtp_queue_fence),
      (select high_water_updated_at from group_smtp_queue_fence),
      public.outlook_exchange_truth_sha256(
        (select canonical_json
         from group_smtp_truth_cases
         where case_name = 'missing-smtp')
      ),
      (select canonical_json
       from group_smtp_truth_cases
       where case_name = 'missing-smtp'),
      (select item_counts
       from group_smtp_truth_cases
       where case_name = 'missing-smtp'),
      jsonb_build_object(
        'status', 'match',
        'mismatchCount', 0,
        'verifiedManagedContacts', 0,
        'verifiedManagedGroups', 1,
        'verifiedMembershipGroups', 1,
        'verifiedMemberships', 0,
        'sourceFenceStable', true,
        'sourceFingerprint', public.outlook_exchange_truth_sha256(
          (select canonical_json
           from group_smtp_truth_cases
           where case_name = 'missing-smtp')
        )
      ),
      'fcuno-exchange-runbook/2026-07-23.3'
    )
  $statement$,
  'P0001',
  'Every certified Exchange group must carry one exact lowercase alias@cosulich1.onmicrosoft.com SMTP address.',
  'certification rejects a legacy projection before writing evidence'
);

select is(
  (
    select count(*)
    from public.outlook_exchange_sync_certifications
    where run_id = 'd1111111-1111-4111-8111-111111111111'
  ),
  0::bigint,
  'rejected certification leaves no durable receipt'
);

create temporary table group_smtp_certification_result (
  value jsonb not null
) on commit drop;

insert into group_smtp_certification_result(value)
select public.certify_full_outlook_exchange_truth(
  'e2222222-2222-4222-8222-222222222222',
  (select high_water_sequence from group_smtp_queue_fence),
  (select high_water_updated_at from group_smtp_queue_fence),
  public.outlook_exchange_truth_sha256(
    (select canonical_json
     from group_smtp_truth_cases
     where case_name = 'exact-smtp')
  ),
  (select canonical_json
   from group_smtp_truth_cases
   where case_name = 'exact-smtp'),
  (select item_counts
   from group_smtp_truth_cases
   where case_name = 'exact-smtp'),
  jsonb_build_object(
    'status', 'match',
    'mismatchCount', 0,
    'verifiedManagedContacts', 1,
    'verifiedManagedGroups', 1,
    'verifiedMembershipGroups', 1,
    'verifiedMemberships', 1,
    'sourceFenceStable', true,
    'sourceFingerprint', public.outlook_exchange_truth_sha256(
      (select canonical_json
       from group_smtp_truth_cases
       where case_name = 'exact-smtp')
    )
  ),
  'fcuno-exchange-runbook/2026-07-23.3'
);

select ok(
  (value ->> 'certified')::boolean
    and (value ->> 'evidenceRecorded')::boolean,
  'exact group SMTP projection certifies with immutable evidence'
)
from group_smtp_certification_result;

select ok(
  (verification ->> 'valid')::boolean
    and (verification ->> 'groupSmtpTruthValid')::boolean
    and (verification ->> 'latestProjectionGroupSmtpValid')::boolean
    and (
      verification ->> 'latestCertificationGroupSmtpWorkerValid'
    )::boolean,
  'truth verifier accepts the latest exact group SMTP certification'
)
from (
  select public.verify_outlook_exchange_truth_ledger() as verification
) as verified;

select is(
  (
    public.verify_outlook_exchange_truth_ledger()
      ->> 'latestCertificationWorkerVersion'
  ),
  'fcuno-exchange-runbook/2026-07-23.3',
  'truth verifier records the SMTP-aware worker version'
);

select * from finish();
rollback;
