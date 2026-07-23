-- Keep template recipient references aligned automatically whenever a new
-- immutable FCUNO-to-Exchange projection is certified. Stable source IDs are
-- the join key; missing IDs fail closed instead of retaining an old address.

alter table public.email_templates
  drop constraint if exists email_templates_recipient_resolution_shape;

alter table public.email_templates
  add constraint email_templates_recipient_resolution_shape
  check (
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
  );

create or replace function public.reconcile_outlook_template_recipient_ref(
  p_ref jsonb,
  p_projection jsonb
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  source_id text;
  recipient_kind text;
  candidate jsonb;
  display_name text;
  resolved_address text;
  group_domain text;
begin
  if p_ref is null or jsonb_typeof(p_ref) <> 'object' then
    return p_ref;
  end if;

  source_id := nullif(pg_catalog.btrim(p_ref ->> 'sourceId'), '');
  recipient_kind := p_ref ->> 'kind';
  if source_id is null
    or recipient_kind not in ('contact', 'group')
  then
    return p_ref;
  end if;

  if recipient_kind = 'contact' then
    select item
    into candidate
    from jsonb_array_elements(
      coalesce(p_projection -> 'contacts', '[]'::jsonb)
    ) as projected(item)
    where item ->> 'sourceContactId' = source_id
    limit 1;

    resolved_address := lower(
      pg_catalog.btrim(candidate ->> 'externalEmailAddress')
    );
    display_name := coalesce(
      nullif(pg_catalog.btrim(candidate ->> 'displayName'), ''),
      nullif(pg_catalog.btrim(candidate ->> 'directoryName'), ''),
      nullif(pg_catalog.btrim(p_ref ->> 'displayName'), ''),
      resolved_address
    );
  else
    select item
    into candidate
    from jsonb_array_elements(
      coalesce(p_projection -> 'groups', '[]'::jsonb)
    ) as projected(item)
    where item ->> 'sourceGroupId' = source_id
    limit 1;

    group_domain := substring(
      coalesce(p_ref ->> 'resolvedAddress', '')
      from '@([^@]+)$'
    );
    group_domain := coalesce(
      nullif(lower(pg_catalog.btrim(group_domain)), ''),
      'cosulich1.onmicrosoft.com'
    );
    resolved_address := lower(
      pg_catalog.btrim(candidate ->> 'alias')
    ) || '@' || group_domain;
    display_name := coalesce(
      nullif(pg_catalog.btrim(candidate ->> 'groupName'), ''),
      nullif(pg_catalog.btrim(candidate ->> 'directoryName'), ''),
      nullif(pg_catalog.btrim(p_ref ->> 'displayName'), ''),
      resolved_address
    );
  end if;

  if candidate is null
    or nullif(pg_catalog.btrim(resolved_address), '') is null
  then
    return p_ref || jsonb_build_object(
      'resolvedAddress', null,
      'status', 'missing'
    );
  end if;

  return p_ref || jsonb_build_object(
    'displayName', display_name,
    'resolvedAddress', resolved_address,
    'status', 'resolved'
  );
end;
$$;

create or replace function public.reconcile_outlook_template_recipient_array(
  p_refs jsonb,
  p_projection jsonb
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(
    jsonb_agg(
      public.reconcile_outlook_template_recipient_ref(
        item.value,
        p_projection
      )
      order by item.ordinality
    ),
    '[]'::jsonb
  )
  from jsonb_array_elements(
    case
      when jsonb_typeof(p_refs) = 'array' then p_refs
      else '[]'::jsonb
    end
  ) with ordinality as item(value, ordinality);
$$;

create or replace function public.reconcile_outlook_template_resolution(
  p_resolution jsonb,
  p_projection jsonb,
  p_certification_run_id uuid,
  p_certified_at timestamptz,
  p_source_fingerprint text,
  p_resolved_at timestamptz
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  reconciled_refs jsonb;
  total_count bigint;
  resolved_count bigint;
  external_count bigint;
  ambiguous_count bigint;
  missing_count bigint;
begin
  reconciled_refs := jsonb_build_object(
    'to',
      public.reconcile_outlook_template_recipient_array(
        p_resolution #> '{refs,to}',
        p_projection
      ),
    'cc',
      public.reconcile_outlook_template_recipient_array(
        p_resolution #> '{refs,cc}',
        p_projection
      ),
    'bcc',
      public.reconcile_outlook_template_recipient_array(
        p_resolution #> '{refs,bcc}',
        p_projection
      )
  );

  select
    count(*),
    count(*) filter (where ref ->> 'status' = 'resolved'),
    count(*) filter (where ref ->> 'status' = 'external'),
    count(*) filter (where ref ->> 'status' = 'ambiguous'),
    count(*) filter (where ref ->> 'status' = 'missing')
  into
    total_count,
    resolved_count,
    external_count,
    ambiguous_count,
    missing_count
  from (
    select jsonb_array_elements(
      reconciled_refs -> 'to'
    ) as ref
    union all
    select jsonb_array_elements(
      reconciled_refs -> 'cc'
    ) as ref
    union all
    select jsonb_array_elements(
      reconciled_refs -> 'bcc'
    ) as ref
  ) as all_refs;

  return p_resolution || jsonb_build_object(
    'schema', 'fcuno.outlook-template-recipient-resolution/v1',
    'certificationRunId', p_certification_run_id,
    'certifiedAt', p_certified_at,
    'sourceFingerprint', lower(p_source_fingerprint),
    'resolvedAt', p_resolved_at,
    'refs', reconciled_refs,
    'counts', jsonb_build_object(
      'total', total_count,
      'resolved', resolved_count,
      'external', external_count,
      'ambiguous', ambiguous_count,
      'missing', missing_count
    )
  );
end;
$$;

create or replace function public.reconcile_outlook_templates_after_projection()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  certification_run_id uuid;
  certification_at timestamptz;
  projection jsonb;
  reconciled_at constant timestamptz := clock_timestamp();
begin
  if new.snapshot_kind <> 'fcuno_exchange_projection' then
    return new;
  end if;

  select
    certification.run_id,
    certification.certified_at
  into
    certification_run_id,
    certification_at
  from public.outlook_exchange_sync_certifications as certification
  where certification.source_fingerprint = new.snapshot_sha256
  order by certification.certified_at desc, certification.run_id desc
  limit 1;

  if certification_run_id is null or certification_at is null then
    raise exception
      'Projection snapshot % has no matching Exchange certification.',
      new.snapshot_sha256;
  end if;

  projection := new.canonical_json::jsonb;
  perform set_config(
    'app.audit_actor_id',
    'system:outlook-template-recipient-truth',
    true
  );
  perform set_config(
    'app.audit_actor_name',
    'Outlook Template Recipient Truth',
    true
  );
  perform set_config(
    'app.audit_context',
    jsonb_build_object(
      'action', 'certified-projection-reconcile',
      'pageId', 'email-templates',
      'pageLabel', 'OUTLOOK TEMPLATES',
      'pagePath', '/admin/outlooktemplates',
      'certificationRunId', certification_run_id,
      'sourceFingerprint', new.snapshot_sha256
    )::text,
    true
  );

  update public.email_templates as template
  set recipient_resolution =
    public.reconcile_outlook_template_resolution(
      template.recipient_resolution,
      projection,
      certification_run_id,
      certification_at,
      new.snapshot_sha256,
      reconciled_at
    )
  where template.recipient_resolution ->> 'sourceFingerprint'
    is distinct from new.snapshot_sha256;

  return new;
end;
$$;

drop trigger if exists reconcile_outlook_templates_after_projection
  on public.outlook_exchange_truth_snapshots;
create trigger reconcile_outlook_templates_after_projection
after insert on public.outlook_exchange_truth_snapshots
for each row
when (new.snapshot_kind = 'fcuno_exchange_projection')
execute function public.reconcile_outlook_templates_after_projection();

revoke all on function
  public.reconcile_outlook_template_recipient_ref(jsonb, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function
  public.reconcile_outlook_template_recipient_array(jsonb, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function
  public.reconcile_outlook_template_resolution(
    jsonb,
    jsonb,
    uuid,
    timestamptz,
    text,
    timestamptz
  )
  from public, anon, authenticated, service_role;
revoke all on function
  public.reconcile_outlook_templates_after_projection()
  from public, anon, authenticated, service_role;
