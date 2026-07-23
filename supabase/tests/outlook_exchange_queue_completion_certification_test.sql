begin;
select plan(25);

select has_table(
  'public',
  'outlook_exchange_sync_certifications',
  'full-sync certification receipts are durable'
);

select ok(
  (
    select relrowsecurity
    from pg_catalog.pg_class
    where oid = 'public.outlook_exchange_sync_certifications'::regclass
  ),
  'certification receipts have row level security enabled'
);

select ok(
  not has_table_privilege('anon', 'public.outlook_exchange_sync_certifications', 'SELECT')
  and not has_table_privilege('authenticated', 'public.outlook_exchange_sync_certifications', 'SELECT'),
  'client roles cannot read certification receipts'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.complete_verified_outlook_exchange_sync_queue_row(uuid,uuid)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.certify_full_outlook_exchange_truth(uuid,bigint,timestamptz,text,text,jsonb,jsonb,text)',
    'EXECUTE'
  ),
  'service_role can execute queue completion and evidence-backed certification RPCs'
);

select ok(
  not has_function_privilege(
    'anon',
    'public.complete_verified_outlook_exchange_sync_queue_row(uuid,uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.complete_verified_outlook_exchange_sync_queue_row(uuid,uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'service_role',
    'public.certify_full_outlook_exchange_sync_queue(uuid,bigint,timestamptz,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.certify_full_outlook_exchange_sync_queue(uuid,bigint,timestamptz,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.certify_full_outlook_exchange_sync_queue(uuid,bigint,timestamptz,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.certify_full_outlook_exchange_truth(uuid,bigint,timestamptz,text,text,jsonb,jsonb,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.certify_full_outlook_exchange_truth(uuid,bigint,timestamptz,text,text,jsonb,jsonb,text)',
    'EXECUTE'
  ),
  'legacy and client callers cannot bypass evidence-backed certification'
);

delete from public.outlook_exchange_sync_queue;

insert into public.outlook_exchange_sync_queue (
  id,
  action,
  entity_type,
  entity_id,
  entity_key,
  display_name,
  status,
  attempts,
  requested_by,
  error_message,
  next_attempt_at,
  completed_at
) values (
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee3',
  'update_contact',
  'contact',
  'malformed-terminal',
  'test:malformed-terminal',
  'Malformed terminal',
  'failed',
  3,
  'Queue test user',
  'original terminal failure',
  clock_timestamp() + interval '1 hour',
  null
);

create temporary table normalization_claim_rows on commit drop as
select *
from public.claim_outlook_exchange_sync_queue(
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee10',
  10
);

insert into normalization_claim_rows
select *
from public.claim_outlook_exchange_sync_queue(
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee11',
  10
);

select ok(
  (
    select status = 'failed'
      and next_attempt_at is null
      and completed_at is not null
      and error_message = 'original terminal failure'
    from public.outlook_exchange_sync_queue
    where id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee3'
  ),
  'exhausted malformed retry metadata is normalized without rewriting the error'
);

select is(
  (
    select count(*)
    from public.outlook_exchange_sync_queue as queue,
      jsonb_array_elements(queue.error_history) as history(event)
    where queue.id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee3'
      and history.event ->> 'type' = 'terminal_normalized'
  ),
  1::bigint,
  'repeated claim calls append terminal normalization exactly once'
);

delete from public.outlook_exchange_sync_queue;

insert into public.outlook_exchange_sync_queue (
  id,
  action,
  entity_type,
  entity_id,
  entity_key,
  display_name,
  status,
  attempts,
  requested_by,
  error_message,
  next_attempt_at,
  completed_at,
  run_id
) values
  (
    '10000000-0000-4000-8000-000000000001',
    'update_contact', 'contact', 'contact-atomic', 'legacy:audit-cleanup',
    'Old contact failure', 'failed', 1, 'Prior editor',
    'old contact failure', null, null,
    '10000000-0000-4000-8000-000000000010'
  ),
  (
    '10000000-0000-4000-8000-000000000002',
    'update_contact', 'contact', 'contact-atomic', 'contact:canonical',
    'Current contact', 'processing', 2, 'Latest editor',
    null, null, null,
    '10000000-0000-4000-8000-000000000020'
  ),
  (
    '10000000-0000-4000-8000-000000000003',
    'update_contact', 'contact', 'contact-atomic', 'contact:newer',
    'Newer contact failure', 'failed', 1, 'Newer editor',
    'newer contact failure', null, null,
    '10000000-0000-4000-8000-000000000030'
  ),
  (
    '10000000-0000-4000-8000-000000000004',
    'update_contact', 'contact', 'contact-atomic', 'contact:pending',
    'Pending contact state', 'pending', 0, 'Pending editor',
    null, null, null, null
  ),
  (
    '10000000-0000-4000-8000-000000000005',
    'update_contact', 'contact', 'contact-atomic', 'contact:processing',
    'Other processing contact state', 'processing', 1, 'Processing editor',
    null, null, null,
    '10000000-0000-4000-8000-000000000050'
  ),
  (
    '20000000-0000-4000-8000-000000000001',
    'update_group_members', 'group_members', 'group-atomic',
    'group_members:group-atomic:member-a', 'Old member A', 'failed', 1,
    'Group editor A', 'old member A failure', null, null,
    '20000000-0000-4000-8000-000000000010'
  ),
  (
    '20000000-0000-4000-8000-000000000004',
    'update_group', 'group', 'group-atomic', 'group:group-atomic',
    'Old group metadata', 'failed', 1, 'Group editor B',
    'old group metadata failure', null, null,
    '20000000-0000-4000-8000-000000000040'
  ),
  (
    '20000000-0000-4000-8000-000000000002',
    'update_group_members', 'group_members', 'group-other',
    'group_members:group-other:member-b', 'Other group member', 'failed', 1,
    'Other group editor', 'other group failure', null, null,
    '20000000-0000-4000-8000-000000000020'
  ),
  (
    '20000000-0000-4000-8000-000000000003',
    'update_group_members', 'group_members', 'group-atomic',
    'group_members:group-atomic:member-current', 'Current group member',
    'processing', 1, 'Latest group editor', null, null, null,
    '20000000-0000-4000-8000-000000000030'
  ),
  (
    '30000000-0000-4000-8000-000000000001',
    'update_contact', 'contact', 'completed-unverified',
    'contact:completed-unverified', 'Completed unverified', 'completed', 1,
    'Unverified editor', null, null, clock_timestamp(),
    '30000000-0000-4000-8000-000000000010'
  );

create temporary table wrong_run_result on commit drop as
select public.complete_verified_outlook_exchange_sync_queue_row(
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000099'
) as result;

select ok(
  not (select (result ->> 'completed')::boolean from wrong_run_result)
  and (
    select status = 'processing'
    from public.outlook_exchange_sync_queue
    where id = '10000000-0000-4000-8000-000000000002'
  ),
  'wrong-run completion fails closed and leaves the row processing'
);

create temporary table contact_completion_result on commit drop as
select public.complete_verified_outlook_exchange_sync_queue_row(
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000020'
) as result;

select ok(
  (select (result ->> 'completed')::boolean from contact_completion_result)
  and not (select (result ->> 'idempotent')::boolean from contact_completion_result)
  and (select (result ->> 'supersededCount')::integer = 2 from contact_completion_result)
  and (
    select (result -> 'supersededRows') @> jsonb_build_array(
      jsonb_build_object('id', '10000000-0000-4000-8000-000000000001')
    )
    and (result -> 'supersededRows') @> jsonb_build_array(
      jsonb_build_object('id', '10000000-0000-4000-8000-000000000003')
    )
    from contact_completion_result
  ),
  'contact completion atomically supersedes every existing same-contact terminal row despite sequence or legacy key'
);

select ok(
  (
    select status = 'skipped'
      and error_message like 'old contact failure%Superseded by later Exchange-verified%'
      and exists (
        select 1
        from jsonb_array_elements(error_history) as history(event)
        where history.event ->> 'type' = 'terminal_failure_superseded'
          and history.event ->> 'superseding_queue_row_id' =
            '10000000-0000-4000-8000-000000000002'
      )
    from public.outlook_exchange_sync_queue
    where id = '10000000-0000-4000-8000-000000000001'
  ),
  'superseded contact retains its prior error and explicit linkage history'
);

select ok(
  (
    select status = 'skipped'
    from public.outlook_exchange_sync_queue
    where id = '10000000-0000-4000-8000-000000000003'
  )
  and (
    select status = 'pending'
    from public.outlook_exchange_sync_queue
    where id = '10000000-0000-4000-8000-000000000004'
  )
  and (
    select status = 'processing'
    from public.outlook_exchange_sync_queue
    where id = '10000000-0000-4000-8000-000000000005'
  ),
  'higher-sequence terminal state is resolved while pending and processing work remains untouched'
);

create temporary table contact_replay_result on commit drop as
select public.complete_verified_outlook_exchange_sync_queue_row(
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000020'
) as result;

select ok(
  (select (result ->> 'completed')::boolean from contact_replay_result)
  and (select (result ->> 'idempotent')::boolean from contact_replay_result)
  and (select (result ->> 'supersededCount')::integer = 2 from contact_replay_result)
  and (
    select result #>> '{supersededRows,0,requestedBy}' = 'Prior editor'
    from contact_replay_result
  ),
  'lost-response completion replay reconstructs the original details and requestor'
);

create temporary table group_completion_result on commit drop as
select public.complete_verified_outlook_exchange_sync_queue_row(
  '20000000-0000-4000-8000-000000000003',
  '20000000-0000-4000-8000-000000000030'
) as result;

select ok(
  (select (result ->> 'completed')::boolean from group_completion_result)
  and (select (result ->> 'supersededCount')::integer = 2 from group_completion_result)
  and (
    select (result -> 'supersededRows') @> jsonb_build_array(
      jsonb_build_object('id', '20000000-0000-4000-8000-000000000001')
    )
    and (result -> 'supersededRows') @> jsonb_build_array(
      jsonb_build_object('id', '20000000-0000-4000-8000-000000000004')
    )
    from group_completion_result
  ),
  'group-member verification supersedes older member and metadata failures for the whole group'
);

select ok(
  (
    select count(*) = 2
    from public.outlook_exchange_sync_queue
    where id in (
      '20000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000004'
    )
      and status = 'skipped'
  )
  and (
    select status = 'failed'
    from public.outlook_exchange_sync_queue
    where id = '20000000-0000-4000-8000-000000000002'
  ),
  'same-group failures are resolved while a different group remains untouched'
);

select ok(
  not (
    select (
      public.complete_verified_outlook_exchange_sync_queue_row(
        '30000000-0000-4000-8000-000000000001',
        '30000000-0000-4000-8000-000000000010'
      ) ->> 'completed'
    )::boolean
  ),
  'a pre-completed row without Exchange verification fails closed'
);

delete from public.outlook_exchange_sync_queue;
delete from public.outlook_exchange_sync_certifications;

insert into public.outlook_exchange_sync_queue (
  id,
  action,
  entity_type,
  entity_id,
  entity_key,
  display_name,
  status,
  attempts,
  requested_by,
  error_message,
  next_attempt_at,
  completed_at,
  updated_at
) values
  (
    '40000000-0000-4000-8000-000000000001',
    'update_contact', 'contact', 'full-terminal-one',
    'contact:full-terminal-one', 'Full terminal one', 'failed', 1,
    'Full editor one', 'legacy terminal one', null, null,
    clock_timestamp() - interval '2 seconds'
  ),
  (
    '40000000-0000-4000-8000-000000000002',
    'update_group', 'group', 'full-terminal-three',
    'group:full-terminal-three', 'Full terminal three', 'failed', 3,
    'Full editor three', 'legacy terminal three', null, clock_timestamp(),
    clock_timestamp() - interval '1 second'
  );

create temporary table full_initial_fence on commit drop as
select queue_sequence, updated_at
from public.outlook_exchange_sync_queue
order by updated_at desc, queue_sequence desc
limit 1;

create temporary table full_mismatch_result on commit drop as
select public.certify_full_outlook_exchange_sync_queue(
  '40000000-0000-4000-8000-000000000010',
  queue_sequence + 1,
  updated_at,
  'fingerprint-mismatch'
) as result
from full_initial_fence;

select ok(
  not (select (result ->> 'certified')::boolean from full_mismatch_result)
  and (
    select count(*) = 2
    from public.outlook_exchange_sync_queue
    where status = 'failed'
  ),
  'full certification rejects a changed queue fence without sweeping terminal rows'
);

insert into public.outlook_exchange_sync_queue (
  id, action, entity_type, entity_id, entity_key, display_name, status, attempts
) values (
  '40000000-0000-4000-8000-000000000003',
  'update_contact', 'contact', 'active-backlog', 'contact:active-backlog',
  'Active backlog', 'pending', 0
);

create temporary table full_active_fence on commit drop as
select queue_sequence, updated_at
from public.outlook_exchange_sync_queue
order by updated_at desc, queue_sequence desc
limit 1;

create temporary table full_active_result on commit drop as
select public.certify_full_outlook_exchange_sync_queue(
  '40000000-0000-4000-8000-000000000020',
  queue_sequence,
  updated_at,
  'fingerprint-active'
) as result
from full_active_fence;

select ok(
  not (select (result ->> 'certified')::boolean from full_active_result),
  'full certification rejects an active or retryable backlog'
);

delete from public.outlook_exchange_sync_queue
where id = '40000000-0000-4000-8000-000000000003';

create temporary table full_success_fence on commit drop as
select queue_sequence, updated_at
from public.outlook_exchange_sync_queue
order by updated_at desc, queue_sequence desc
limit 1;

create temporary table full_success_result on commit drop as
select public.certify_full_outlook_exchange_sync_queue(
  '40000000-0000-4000-8000-000000000030',
  queue_sequence,
  updated_at,
  'fingerprint-success'
) as result
from full_success_fence;

select ok(
  (select (result ->> 'certified')::boolean from full_success_result)
  and not (select (result ->> 'idempotent')::boolean from full_success_result)
  and (select (result ->> 'supersededCount')::integer = 2 from full_success_result),
  'source-fenced full certification sweeps every truthful terminal row'
);

select ok(
  (
    select count(*) = 2
    from public.outlook_exchange_sync_queue as queue
    where queue.status = 'skipped'
      and queue.error_message like 'legacy terminal %Superseded by source-fenced full%'
      and exists (
        select 1
        from jsonb_array_elements(queue.error_history) as history(event)
        where history.event ->> 'type' =
          'terminal_failure_superseded_by_full_certification'
      )
  ),
  'full supersession preserves each prior error and appends certification history'
);

select ok(
  (
    select count(*) = 1
      and max((result ->> 'supersededCount')::integer) = 2
    from public.outlook_exchange_sync_certifications
    where run_id = '40000000-0000-4000-8000-000000000030'
  ),
  'the successful full certification result is stored exactly once'
);

create temporary table full_replay_result on commit drop as
select public.certify_full_outlook_exchange_sync_queue(
  '40000000-0000-4000-8000-000000000030',
  queue_sequence,
  updated_at,
  'fingerprint-success'
) as result
from full_success_fence;

select ok(
  (select (result ->> 'certified')::boolean from full_replay_result)
  and (select (result ->> 'idempotent')::boolean from full_replay_result)
  and (select (result ->> 'supersededCount')::integer = 2 from full_replay_result)
  and (
    select result #>> '{supersededRows,0,requestedBy}' is not null
    from full_replay_result
  ),
  'lost-response full retry returns the durable success and detailed rows'
);

select ok(
  not (
    select (
      public.certify_full_outlook_exchange_sync_queue(
        '40000000-0000-4000-8000-000000000030',
        queue_sequence,
        updated_at,
        'different-fingerprint'
      ) ->> 'certified'
    )::boolean
    from full_success_fence
  )
  and (
    select count(*) = 1
    from public.outlook_exchange_sync_certifications
    where run_id = '40000000-0000-4000-8000-000000000030'
  ),
  'a full run ID cannot be reused for a different certification identity'
);

do $$
begin
  perform set_config('app.audit_actor_id', 'queue-trigger-test', true);
  perform set_config('app.audit_actor_name', 'Queue Trigger Test', true);
  perform set_config(
    'app.audit_correlation_id',
    '50000000-0000-4000-8000-000000000001',
    true
  );
end;
$$;

delete from public.shared_addressbook_group_members
where group_id like 'queue-trigger-%' or contact_id like 'queue-trigger-%';
delete from public.shared_addressbook_groups where id like 'queue-trigger-%';
delete from public.shared_addressbook_contacts where id like 'queue-trigger-%';
delete from public.outlook_exchange_sync_queue;
delete from public.audit_logs where actor_id = 'queue-trigger-test';

insert into public.shared_addressbook_contacts (
  id, source_book, source_card, display_name, primary_email,
  nickname, first_name, last_name, vcard, properties
) values
  (
    'queue-trigger-contact-1', 'queue-trigger-book-a', 'queue-trigger-card-1',
    'Queue Contact One', 'queue-duplicate@example.com', 'queue-one',
    'Queue', 'One', 'vcard-one', '{"source":"initial"}'::jsonb
  ),
  (
    'queue-trigger-contact-2', 'queue-trigger-book-a', 'queue-trigger-card-2',
    'Queue Contact Two', 'queue-two@example.com', 'queue-two',
    'Queue', 'Two', 'vcard-two', '{"source":"initial"}'::jsonb
  ),
  (
    'queue-trigger-contact-3', 'queue-trigger-book-b', 'queue-trigger-card-3',
    'Queue Contact Duplicate', 'queue-duplicate@example.com', 'queue-duplicate',
    'Queue', 'Duplicate', 'vcard-three', '{"source":"initial"}'::jsonb
  );

insert into public.shared_addressbook_groups (
  id, source_book, source_uid, name, nickname, description
) values
  (
    'queue-trigger-group-1', 'queue-trigger-book-a', 'queue-trigger-group-uid-1',
    '', 'queue-group-one', 'First queue group'
  ),
  (
    'queue-trigger-group-2', 'queue-trigger-book-a', 'queue-trigger-group-uid-2',
    'Queue Group Two', 'queue-group-two', 'Second queue group'
  );

insert into public.shared_addressbook_group_members (
  group_id, contact_id, source_book
) values (
  'queue-trigger-group-1', 'queue-trigger-contact-1', 'queue-trigger-book-a'
);

delete from public.outlook_exchange_sync_queue;
delete from public.audit_logs where actor_id = 'queue-trigger-test';

update public.shared_addressbook_contacts
set display_name = display_name,
    primary_email = primary_email,
    first_name = first_name,
    last_name = last_name,
    nickname = nickname,
    source_book = 'queue-trigger-book-metadata',
    source_card = source_card,
    vcard = 'vcard-metadata-only',
    properties = '{"source":"metadata-only"}'::jsonb
where id = 'queue-trigger-contact-1';

update public.shared_addressbook_groups
set id = id,
    name = name,
    nickname = nickname,
    description = description,
    source_uid = source_uid,
    source_book = 'queue-trigger-book-metadata'
where id = 'queue-trigger-group-1';

update public.shared_addressbook_group_members
set group_id = group_id,
    contact_id = contact_id,
    source_book = 'queue-trigger-book-metadata'
where group_id = 'queue-trigger-group-1'
  and contact_id = 'queue-trigger-contact-1';

select ok(
  (
    select count(*) = 1
      and bool_and(entity_type = 'contact')
    from public.outlook_exchange_sync_queue
  ),
  'duplicate-email contact metadata updates queue, while group/member metadata-only updates stay out of Exchange'
);

select ok(
  (
    select count(*) = 3
    from public.audit_logs
    where actor_id = 'queue-trigger-test'
      and operation = 'UPDATE'
      and table_name in (
        'shared_addressbook_contacts',
        'shared_addressbook_groups',
        'shared_addressbook_group_members'
      )
  ),
  'metadata-only source edits remain independently visible in the audit log'
);

create temporary table relevant_trigger_results (
  field_name text primary key,
  enqueued boolean not null
) on commit drop;

delete from public.outlook_exchange_sync_queue;
update public.shared_addressbook_contacts set display_name = 'Queue Contact Display' where id = 'queue-trigger-contact-1';
insert into relevant_trigger_results values ('contact.display_name', exists(select 1 from public.outlook_exchange_sync_queue where entity_type = 'contact'));
delete from public.outlook_exchange_sync_queue;
update public.shared_addressbook_contacts set primary_email = 'queue-one-new@example.com' where id = 'queue-trigger-contact-1';
insert into relevant_trigger_results values ('contact.primary_email', exists(select 1 from public.outlook_exchange_sync_queue where entity_type = 'contact'));
delete from public.outlook_exchange_sync_queue;
update public.shared_addressbook_contacts set first_name = 'Queue First' where id = 'queue-trigger-contact-1';
insert into relevant_trigger_results values ('contact.first_name', exists(select 1 from public.outlook_exchange_sync_queue where entity_type = 'contact'));
delete from public.outlook_exchange_sync_queue;
update public.shared_addressbook_contacts set last_name = 'Queue Last' where id = 'queue-trigger-contact-1';
insert into relevant_trigger_results values ('contact.last_name', exists(select 1 from public.outlook_exchange_sync_queue where entity_type = 'contact'));
delete from public.outlook_exchange_sync_queue;
update public.shared_addressbook_contacts set nickname = 'queue-contact-new' where id = 'queue-trigger-contact-1';
insert into relevant_trigger_results values ('contact.nickname', exists(select 1 from public.outlook_exchange_sync_queue where entity_type = 'contact'));

delete from public.outlook_exchange_sync_queue;
update public.shared_addressbook_groups set source_uid = 'queue-trigger-group-uid-1-new' where id = 'queue-trigger-group-1';
insert into relevant_trigger_results values ('group.source_uid_blank_name_fallback', exists(select 1 from public.outlook_exchange_sync_queue where entity_type = 'group'));
delete from public.outlook_exchange_sync_queue;
update public.shared_addressbook_groups set name = 'Queue Group Display' where id = 'queue-trigger-group-1';
insert into relevant_trigger_results values ('group.name', exists(select 1 from public.outlook_exchange_sync_queue where entity_type = 'group'));
delete from public.outlook_exchange_sync_queue;
update public.shared_addressbook_groups set nickname = 'queue-group-new' where id = 'queue-trigger-group-1';
insert into relevant_trigger_results values ('group.nickname', exists(select 1 from public.outlook_exchange_sync_queue where entity_type = 'group'));
delete from public.outlook_exchange_sync_queue;
update public.shared_addressbook_groups set description = 'Queue group changed' where id = 'queue-trigger-group-1';
insert into relevant_trigger_results values ('group.description', exists(select 1 from public.outlook_exchange_sync_queue where entity_type = 'group'));
delete from public.outlook_exchange_sync_queue;
update public.shared_addressbook_groups set id = 'queue-trigger-group-2-renamed' where id = 'queue-trigger-group-2';
insert into relevant_trigger_results values ('group.id', exists(select 1 from public.outlook_exchange_sync_queue where entity_type = 'group'));

delete from public.outlook_exchange_sync_queue;
update public.shared_addressbook_group_members
set group_id = 'queue-trigger-group-2-renamed'
where group_id = 'queue-trigger-group-1'
  and contact_id = 'queue-trigger-contact-1';
insert into relevant_trigger_results values ('member.group_id', exists(select 1 from public.outlook_exchange_sync_queue where entity_type = 'group_members'));
delete from public.outlook_exchange_sync_queue;
update public.shared_addressbook_group_members
set contact_id = 'queue-trigger-contact-2'
where group_id = 'queue-trigger-group-2-renamed'
  and contact_id = 'queue-trigger-contact-1';
insert into relevant_trigger_results values ('member.contact_id', exists(select 1 from public.outlook_exchange_sync_queue where entity_type = 'group_members'));

select ok(
  (
    select count(*) = 12 and bool_and(enqueued)
    from relevant_trigger_results
  ),
  'every Exchange-relevant contact, group, and membership field enqueues a durable change'
);

select * from finish();
rollback;
