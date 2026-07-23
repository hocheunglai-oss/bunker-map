-- Bind Outlook templates to the exact certified FCUNO-to-Exchange projection
-- used to resolve their recipients. Empty resolutions are temporarily allowed
-- so the existing library can be reconciled immediately after this migration;
-- the follow-up enforcement migration removes that allowance.

alter table public.email_templates enable row level security;

do $$
declare
  policy_record record;
begin
  for policy_record in
    select policyname
    from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'email_templates'
  loop
    execute format(
      'drop policy %I on public.email_templates',
      policy_record.policyname
    );
  end loop;
end;
$$;

revoke all privileges on table public.email_templates
  from public, anon, authenticated;
grant select, insert, update, delete on table public.email_templates
  to service_role;

do $$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'public.email_templates'::regclass
      and conname = 'email_templates_recipient_resolution_shape'
  ) then
    alter table public.email_templates
      add constraint email_templates_recipient_resolution_shape
      check (
        recipient_resolution = '{}'::jsonb
        or (
          jsonb_typeof(recipient_resolution) = 'object'
          and recipient_resolution ->> 'schema' =
            'fcuno.outlook-template-recipient-resolution/v1'
          and coalesce(
            recipient_resolution ->> 'sourceFingerprint',
            ''
          ) ~ '^[0-9a-f]{64}$'
          and jsonb_typeof(recipient_resolution -> 'refs') = 'object'
          and jsonb_typeof(
            recipient_resolution #> '{refs,to}'
          ) = 'array'
          and jsonb_typeof(
            recipient_resolution #> '{refs,cc}'
          ) = 'array'
          and jsonb_typeof(
            recipient_resolution #> '{refs,bcc}'
          ) = 'array'
          and jsonb_typeof(recipient_resolution -> 'counts') = 'object'
        )
      );
  end if;
end;
$$;

create index if not exists email_templates_recipient_fingerprint_idx
  on public.email_templates (
    (recipient_resolution ->> 'sourceFingerprint')
  );

create or replace function public.verify_outlook_template_recipient_truth()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  truth jsonb;
  current_fingerprint text;
  total_count bigint;
  unresolved_count bigint;
  stale_count bigint;
  invalid_shape_count bigint;
  missing_count bigint;
  ambiguous_count bigint;
  blocked_count bigint;
begin
  truth := public.verify_outlook_exchange_truth_ledger();
  current_fingerprint := coalesce(
    truth ->> 'latestSourceFingerprint',
    ''
  );

  select
    count(*),
    count(*) filter (
      where recipient_resolution = '{}'::jsonb
    ),
    count(*) filter (
      where recipient_resolution <> '{}'::jsonb
        and recipient_resolution ->> 'sourceFingerprint'
          is distinct from current_fingerprint
    ),
    count(*) filter (
      where recipient_resolution <> '{}'::jsonb
        and (
          recipient_resolution ->> 'schema'
            is distinct from
              'fcuno.outlook-template-recipient-resolution/v1'
          or jsonb_typeof(recipient_resolution -> 'refs')
            is distinct from 'object'
        )
    ),
    count(*) filter (
      where jsonb_path_exists(
        recipient_resolution,
        '$.refs.*[*] ? (@.status == "missing")'
      )
    ),
    count(*) filter (
      where jsonb_path_exists(
        recipient_resolution,
        '$.refs.*[*] ? (@.status == "ambiguous")'
      )
    ),
    count(*) filter (
      where jsonb_path_exists(
        recipient_resolution,
        '$.refs.*[*] ? (@.status == "missing" || @.status == "ambiguous")'
      )
    )
  into
    total_count,
    unresolved_count,
    stale_count,
    invalid_shape_count,
    missing_count,
    ambiguous_count,
    blocked_count
  from public.email_templates;

  return jsonb_build_object(
    'schema', 'fcuno.outlook-template-recipient-truth/v1',
    'valid',
      coalesce((truth ->> 'valid')::boolean, false)
      and coalesce((truth ->> 'integrityValid')::boolean, false)
      and coalesce((truth ->> 'ledgerValid')::boolean, false)
      and coalesce((truth ->> 'snapshotsValid')::boolean, false)
      and coalesce((truth ->> 'referencesValid')::boolean, false)
      and coalesce(
        (truth ->> 'operationallyConsistent')::boolean,
        false
      )
      and unresolved_count = 0
      and stale_count = 0
      and invalid_shape_count = 0,
    'sourceTruthValid', coalesce((truth ->> 'valid')::boolean, false),
    'certificationRunId', truth ->> 'latestCertificationRunId',
    'certifiedAt', truth ->> 'latestCertificationAt',
    'sourceFingerprint', current_fingerprint,
    'templates', jsonb_build_object(
      'total', total_count,
      'unresolved', unresolved_count,
      'stale', stale_count,
      'invalidShape', invalid_shape_count,
      'withMissingRecipients', missing_count,
      'withAmbiguousRecipients', ambiguous_count,
      'sendable', total_count - blocked_count
    ),
    'queue', truth -> 'queue'
  );
end;
$$;

revoke all on function public.verify_outlook_template_recipient_truth()
  from public, anon, authenticated;
grant execute on function public.verify_outlook_template_recipient_truth()
  to service_role;
