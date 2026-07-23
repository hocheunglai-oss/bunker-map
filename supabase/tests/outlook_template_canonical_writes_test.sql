begin;
select plan(22);

delete from public.email_templates
where id in (
  '__test_outlook_template_canonical_a',
  '__test_outlook_template_canonical_b'
);

create function pg_temp.current_outlook_template_resolution()
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog, pg_temp
as $$
  with truth as (
    select public.verify_outlook_exchange_truth_ledger() as value
  )
  select jsonb_build_object(
    'schema', 'fcuno.outlook-template-recipient-resolution/v1',
    'certificationRunId', truth.value ->> 'latestCertificationRunId',
    'certifiedAt', truth.value ->> 'latestCertificationAt',
    'sourceFingerprint',
      lower(truth.value ->> 'latestSourceFingerprint'),
    'resolvedAt', clock_timestamp(),
    'refs', jsonb_build_object(
      'to', '[]'::jsonb,
      'cc', '[]'::jsonb,
      'bcc', '[]'::jsonb
    ),
    'counts', jsonb_build_object(
      'total', 0,
      'resolved', 0,
      'external', 0,
      'ambiguous', 0,
      'missing', 0
    )
  )
  from truth;
$$;

select has_column(
  'public',
  'email_templates',
  'revision',
  'canonical templates carry a server-managed revision'
);

select col_type_is(
  'public',
  'email_templates',
  'revision',
  'bigint',
  'template revision uses a monotonic bigint'
);

select has_column(
  'public',
  'email_templates',
  'recipient_resolution',
  'canonical templates preserve certified recipient resolution'
);

select has_trigger(
  'public',
  'email_templates',
  'email_templates_manage_version',
  'template writes are protected by the server version trigger'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.save_email_template_canonical(jsonb,bigint,timestamp with time zone)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.replace_email_template_library_canonical(jsonb,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.save_email_template_canonical(jsonb,bigint,timestamp with time zone)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.replace_email_template_library_canonical(jsonb,text)',
    'EXECUTE'
  ),
  'canonical mutation RPCs are restricted to the hosted service role'
);

select ok(
  not exists (
    select 1
    from public.office_calendar_store
    where key = 'email-templates'
  ),
  'the legacy payload cannot remain under a live runtime key'
);

select ok(
  (
    public.save_email_template_canonical(
      jsonb_build_object(
        'id', '__test_outlook_template_canonical_a',
        'title', 'Canonical A',
        'subject', 'Initial',
        'folder', 'Tests',
        'slug', '__test-outlook-template-canonical-a',
        'is_active', true,
        'recipientResolution',
          pg_temp.current_outlook_template_resolution()
      ),
      null,
      null
    ) ->> 'revision'
  )::bigint = 1
  and (
    select recipient_resolution ->> 'certificationRunId'
    from public.email_templates
    where id = '__test_outlook_template_canonical_a'
  ) = (
    public.verify_outlook_exchange_truth_ledger()
      ->> 'latestCertificationRunId'
  ),
  'single-row insert starts at revision one with current certified camel-case recipient evidence'
);

select throws_ok(
  $test$
    select public.save_email_template_canonical(
      (
        select to_jsonb(template) || jsonb_build_object(
          'subject', 'Malformed recipient evidence',
          'recipient_resolution',
            jsonb_set(
              pg_temp.current_outlook_template_resolution(),
              '{counts,total}',
              '1'::jsonb
            )
        )
        from public.email_templates as template
        where id = '__test_outlook_template_canonical_a'
      ),
      1,
      null
    )
  $test$,
  '23514',
  'OUTLOOK_TEMPLATE_RECIPIENT_EVIDENCE_INVALID: recipient evidence is malformed.',
  'a write with recipient counts that do not match its refs fails closed'
);

select throws_ok(
  $test$
    select public.save_email_template_canonical(
      (
        select to_jsonb(template) || jsonb_build_object(
          'subject', 'Stale recipient evidence',
          'recipient_resolution',
            pg_temp.current_outlook_template_resolution()
            || jsonb_build_object(
              'sourceFingerprint',
              case
                when left(
                  pg_temp.current_outlook_template_resolution()
                    ->> 'sourceFingerprint',
                  1
                ) = '0'
                then '1'
                else '0'
              end
              || substring(
                pg_temp.current_outlook_template_resolution()
                  ->> 'sourceFingerprint'
                from 2
              )
            )
        )
        from public.email_templates as template
        where id = '__test_outlook_template_canonical_a'
      ),
      1,
      null
    )
  $test$,
  '40001',
  'OUTLOOK_TEMPLATE_RECIPIENT_EVIDENCE_STALE: resolve recipients against the latest settled Exchange certification.',
  'a structurally valid resolution from a stale source fingerprint is rejected'
);

with current_resolution as (
  select pg_temp.current_outlook_template_resolution() as value
)
select ok(
  public.is_valid_outlook_template_recipient_resolution(
    current_resolution.value
    || jsonb_build_object(
      'refs',
      jsonb_build_object(
        'to',
        jsonb_build_array(
          jsonb_build_object(
            'field', 'to',
            'position', 0,
            'literal', 'REMOVED CONTACT',
            'displayName', 'Removed Contact',
            'sourceValue', 'REMOVED CONTACT',
            'kind', 'contact',
            'sourceId', 'stable-contact-id',
            'resolvedAddress', null,
            'status', 'missing'
          )
        ),
        'cc', '[]'::jsonb,
        'bcc', '[]'::jsonb
      ),
      'counts',
      jsonb_build_object(
        'total', 1,
        'resolved', 0,
        'external', 0,
        'ambiguous', 0,
        'missing', 1
      )
    )
  ),
  'a removed resolved recipient keeps its stable FCUNO identity while remaining missing'
)
from current_resolution;

with reconciled as (
  select public.reconcile_outlook_template_recipient_ref(
    jsonb_build_object(
      'field', 'to',
      'position', 0,
      'literal', 'GROUP ONE',
      'displayName', 'Group One',
      'sourceValue', 'GROUP ONE',
      'kind', 'group',
      'sourceId', 'stable-group-id',
      'resolvedAddress', 'stale-group@wrong.example',
      'status', 'resolved'
    ),
    jsonb_build_object(
      'contacts', '[]'::jsonb,
      'groups', jsonb_build_array(
        jsonb_build_object(
          'sourceGroupId', 'stable-group-id',
          'alias', 'group-one',
          'smtpAddress', 'group-one@certified.example',
          'groupName', 'Group One',
          'memberCount', 1
        )
      )
    )
  ) as value
)
select ok(
  reconciled.value ->> 'resolvedAddress'
    = 'group-one@certified.example'
  and reconciled.value ->> 'status' = 'resolved',
  'group reconciliation uses the exact certified projection smtpAddress'
)
from reconciled;

with reconciled as (
  select public.reconcile_outlook_template_recipient_ref(
    jsonb_build_object(
      'field', 'to',
      'position', 0,
      'literal', 'GROUP ONE',
      'displayName', 'Group One',
      'sourceValue', 'GROUP ONE',
      'kind', 'group',
      'sourceId', 'stable-group-id',
      'resolvedAddress', 'group-one@legacy.example',
      'status', 'resolved'
    ),
    jsonb_build_object(
      'contacts', '[]'::jsonb,
      'groups', jsonb_build_array(
        jsonb_build_object(
          'sourceGroupId', 'stable-group-id',
          'alias', 'group-one',
          'groupName', 'Group One',
          'memberCount', 1
        )
      )
    )
  ) as value
)
select ok(
  reconciled.value -> 'resolvedAddress' = 'null'::jsonb
  and reconciled.value ->> 'status' = 'missing',
  'an older projection without exact group SMTP evidence reconciles fail closed'
)
from reconciled;

select is(
  (
    public.save_email_template_canonical(
      (
        select to_jsonb(template) || jsonb_build_object('subject', 'Updated')
        from public.email_templates as template
        where id = '__test_outlook_template_canonical_a'
      ),
      1,
      null
    ) ->> 'revision'
  )::bigint,
  2::bigint,
  'an expected revision update increments the server revision'
);

select is(
  (
    public.save_email_template_canonical(
      (
        select to_jsonb(template)
        from public.email_templates as template
        where id = '__test_outlook_template_canonical_a'
      ),
      2,
      null
    ) ->> 'revision'
  )::bigint,
  2::bigint,
  'a no-op write preserves revision and updated_at'
);

select throws_ok(
  $test$
    select public.save_email_template_canonical(
      (
        select to_jsonb(template) || jsonb_build_object('subject', 'Stale overwrite')
        from public.email_templates as template
        where id = '__test_outlook_template_canonical_a'
      ),
      1,
      null
    )
  $test$,
  '40001',
  'EMAIL_TEMPLATE_CONFLICT',
  'a stale row revision is rejected instead of overwriting newer data'
);

select is(
  (
    public.repair_email_templates_canonical(
      jsonb_build_array(
        (
          select to_jsonb(template) || jsonb_build_object(
            'subject', 'Repaired',
            'expected_revision', 2,
            'recipient_resolution',
              pg_temp.current_outlook_template_resolution()
          )
          from public.email_templates as template
          where id = '__test_outlook_template_canonical_a'
        )
      )
    ) -> 0 ->> 'revision'
  )::bigint,
  3::bigint,
  'format repair updates only supplied rows under their expected revisions'
);

select throws_ok(
  $test$
    select public.repair_email_templates_canonical(
      jsonb_build_array(
        (
          select to_jsonb(template) || jsonb_build_object(
            'subject', 'Stale repair',
            'expected_revision', 2
          )
          from public.email_templates as template
          where id = '__test_outlook_template_canonical_a'
        )
      )
    )
  $test$,
  '40001',
  'EMAIL_TEMPLATE_CONFLICT',
  'a stale repair batch is rejected atomically'
);

select is(
  (
    public.save_email_template_canonical(
      jsonb_build_object(
        'id', '__test_outlook_template_canonical_b',
        'title', 'Canonical B',
        'subject', 'Initial',
        'folder', 'Tests',
        'slug', '__test-outlook-template-canonical-b',
        'is_active', true,
        'recipient_resolution',
          pg_temp.current_outlook_template_resolution()
      ),
      null,
      null
    ) ->> 'revision'
  )::bigint,
  1::bigint,
  'snake-case recipient_resolution is also accepted for a new row'
);

select ok(
  public.email_template_library_revision() ~ '^[0-9a-f]{64}$',
  'the canonical library exposes a deterministic SHA-256 revision'
);

with replacement as (
  select jsonb_agg(
    case template.id
      when '__test_outlook_template_canonical_a' then
        to_jsonb(template) || jsonb_build_object(
          'slug',
          '__test-outlook-template-canonical-b'
        )
      when '__test_outlook_template_canonical_b' then
        to_jsonb(template) || jsonb_build_object(
          'slug',
          '__test-outlook-template-canonical-a'
        )
      else to_jsonb(template)
    end
    order by template.id
  ) as payload
  from public.email_templates as template
),
saved as (
  select public.replace_email_template_library_canonical(
    replacement.payload,
    public.email_template_library_revision()
  ) as result
  from replacement
)
select ok(
  (saved.result ->> 'revision') ~ '^[0-9a-f]{64}$'
  and (
    select slug = '__test-outlook-template-canonical-b'
    from public.email_templates
    where id = '__test_outlook_template_canonical_a'
  )
  and (
    select recipient_resolution ->> 'certificationRunId'
      = (
        public.verify_outlook_exchange_truth_ledger()
          ->> 'latestCertificationRunId'
      )
    from public.email_templates
    where id = '__test_outlook_template_canonical_a'
  ),
  'atomic library replacement supports slug swaps and preserves recipient evidence'
)
from saved;

create temporary table outlook_template_test_revision (
  revision text not null
) on commit drop;

insert into outlook_template_test_revision (revision)
values (public.email_template_library_revision());

do $$
begin
  perform public.save_email_template_canonical(
    (
      select to_jsonb(template) || jsonb_build_object('subject', 'Changed after snapshot')
      from public.email_templates as template
      where id = '__test_outlook_template_canonical_a'
    ),
    (
      select revision
      from public.email_templates
      where id = '__test_outlook_template_canonical_a'
    ),
    null
  );
end;
$$;

select throws_ok(
  pg_catalog.format(
    'select public.replace_email_template_library_canonical(%L::jsonb, %L::text)',
    (
      select jsonb_agg(to_jsonb(template) order by template.id)::text
      from public.email_templates as template
    ),
    (
      select revision
      from outlook_template_test_revision
    )
  ),
  '40001',
  'EMAIL_TEMPLATE_CONFLICT',
  'a stale full-library snapshot cannot replace current rows'
);

with replacement as (
  select jsonb_agg(to_jsonb(template) order by template.id) as payload
  from public.email_templates as template
  where template.id <> '__test_outlook_template_canonical_b'
),
saved as (
  select public.replace_email_template_library_canonical(
    replacement.payload,
    public.email_template_library_revision()
  )
  from replacement
)
select ok(
  exists (
    select 1
    from public.email_templates
    where id = '__test_outlook_template_canonical_a'
  )
  and not exists (
    select 1
    from public.email_templates
    where id = '__test_outlook_template_canonical_b'
  ),
  'atomic replacement can remove selected rows without an empty-table window'
)
from saved;

select * from finish();
rollback;
