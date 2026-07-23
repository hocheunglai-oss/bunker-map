-- Make public.email_templates the only live Outlook-template source of truth.
-- The archived office_calendar_store payload is retained as recovery evidence,
-- but runtime code no longer reads from or writes to it.

do $$
begin
  if exists (
    select 1
    from public.office_calendar_store
    where key = 'email-templates'
  ) then
    if exists (
      select 1
      from public.office_calendar_store
      where key = 'archived-email-templates-legacy-20260521'
    ) then
      raise exception
        'Cannot archive legacy Outlook templates: archival key already exists.'
        using errcode = '23505';
    end if;

    update public.office_calendar_store
    set key = 'archived-email-templates-legacy-20260521'
    where key = 'email-templates';
  end if;
end;
$$;

alter table public.email_templates
  add column if not exists revision bigint,
  add column if not exists recipient_resolution jsonb not null default '{}'::jsonb;

update public.email_templates
set revision = 1
where revision is null;

alter table public.email_templates
  alter column revision set default 1,
  alter column revision set not null;

do $$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'public.email_templates'::regclass
      and conname = 'email_templates_revision_positive'
  ) then
    alter table public.email_templates
      add constraint email_templates_revision_positive
      check (revision > 0);
  end if;
end;
$$;

-- Deferring slug uniqueness lets one atomic library replacement safely swap
-- slugs between two existing rows without a transient unique-index failure.
do $$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'public.email_templates'::regclass
      and conname = 'email_templates_slug_key'
  ) then
    alter table public.email_templates
      add constraint email_templates_slug_key
      unique using index email_templates_slug_key
      deferrable initially deferred;
  end if;
end;
$$;

create or replace function public.email_templates_manage_version()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.revision := 1;
    new.created_at := clock_timestamp();
    new.updated_at := new.created_at;
    return new;
  end if;

  new.created_at := old.created_at;

  if (
    to_jsonb(new) - array['revision', 'updated_at', 'created_at']
  ) is distinct from (
    to_jsonb(old) - array['revision', 'updated_at', 'created_at']
  ) then
    new.revision := old.revision + 1;
    new.updated_at := clock_timestamp();
  else
    new.revision := old.revision;
    new.updated_at := old.updated_at;
  end if;

  return new;
end;
$$;

drop trigger if exists email_templates_manage_version
on public.email_templates;

create trigger email_templates_manage_version
before insert or update on public.email_templates
for each row
execute function public.email_templates_manage_version();

create or replace function public.email_template_library_revision()
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  select pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(
        coalesce(
          (
            select pg_catalog.string_agg(
              pg_catalog.encode(
                pg_catalog.convert_to(template.id, 'UTF8'),
                'base64'
              ) || ':' || template.revision::text,
              E'\n'
              order by pg_catalog.encode(
                pg_catalog.convert_to(template.id, 'UTF8'),
                'base64'
              ) collate "C"
            )
            from public.email_templates as template
          ),
          ''
        ),
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );
$$;

create or replace function public.save_email_template_canonical(
  p_template jsonb,
  p_expected_revision bigint default null,
  p_expected_updated_at timestamptz default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  input_record record;
  input_recipient_resolution jsonb;
  current_record public.email_templates%rowtype;
  saved_record public.email_templates%rowtype;
begin
  if p_template is null or jsonb_typeof(p_template) <> 'object' then
    raise exception 'EMAIL_TEMPLATE_INVALID: template must be a JSON object.'
      using errcode = '22023';
  end if;

  select *
  into input_record
  from jsonb_to_record(p_template) as input(
    id text,
    title text,
    subject text,
    folder text,
    source_path text,
    sender text,
    to_recipients text,
    cc_recipients text,
    bcc_recipients text,
    body_html text,
    body_text text,
    tags text[],
    slug text,
    is_active boolean,
    placeholders text[],
    recipient_resolution jsonb
  );

  input_recipient_resolution := coalesce(
    nullif(input_record.recipient_resolution, 'null'::jsonb),
    nullif(p_template -> 'recipientResolution', 'null'::jsonb),
    '{}'::jsonb
  );

  if nullif(pg_catalog.btrim(input_record.id), '') is null
    or nullif(pg_catalog.btrim(input_record.title), '') is null
    or nullif(pg_catalog.btrim(input_record.slug), '') is null
  then
    raise exception 'EMAIL_TEMPLATE_INVALID: id, title and slug are required.'
      using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('email_templates_canonical_write', 0)
  );

  select *
  into current_record
  from public.email_templates
  where id = input_record.id
  for update;

  if found then
    if p_expected_revision is not null then
      if current_record.revision <> p_expected_revision then
        raise exception 'EMAIL_TEMPLATE_CONFLICT'
          using
            errcode = '40001',
            detail = pg_catalog.format(
              'Template %s expected revision %s but current revision is %s.',
              input_record.id,
              p_expected_revision,
              current_record.revision
            );
      end if;
    elsif p_expected_updated_at is not null then
      if current_record.updated_at <> p_expected_updated_at then
        raise exception 'EMAIL_TEMPLATE_CONFLICT'
          using
            errcode = '40001',
            detail = pg_catalog.format(
              'Template %s changed after the supplied timestamp.',
              input_record.id
            );
      end if;
    else
      raise exception 'EMAIL_TEMPLATE_CONFLICT'
        using
          errcode = '40001',
          detail = pg_catalog.format(
            'Template %s was updated without an expected revision.',
            input_record.id
          );
    end if;

    update public.email_templates
    set
      title = input_record.title,
      subject = coalesce(input_record.subject, ''),
      folder = coalesce(input_record.folder, ''),
      source_path = coalesce(input_record.source_path, ''),
      sender = coalesce(input_record.sender, ''),
      to_recipients = coalesce(input_record.to_recipients, ''),
      cc_recipients = coalesce(input_record.cc_recipients, ''),
      bcc_recipients = coalesce(input_record.bcc_recipients, ''),
      body_html = coalesce(input_record.body_html, ''),
      body_text = coalesce(input_record.body_text, ''),
      tags = coalesce(input_record.tags, '{}'::text[]),
      slug = input_record.slug,
      is_active = coalesce(input_record.is_active, true),
      placeholders = coalesce(input_record.placeholders, '{}'::text[]),
      recipient_resolution = input_recipient_resolution
    where id = input_record.id
    returning * into saved_record;
  else
    if p_expected_revision is not null and p_expected_revision > 0 then
      raise exception 'EMAIL_TEMPLATE_CONFLICT'
        using
          errcode = '40001',
          detail = pg_catalog.format(
            'Template %s no longer exists.',
            input_record.id
          );
    end if;

    insert into public.email_templates (
      id,
      title,
      subject,
      folder,
      source_path,
      sender,
      to_recipients,
      cc_recipients,
      bcc_recipients,
      body_html,
      body_text,
      tags,
      slug,
      is_active,
      placeholders,
      recipient_resolution
    )
    values (
      input_record.id,
      input_record.title,
      coalesce(input_record.subject, ''),
      coalesce(input_record.folder, ''),
      coalesce(input_record.source_path, ''),
      coalesce(input_record.sender, ''),
      coalesce(input_record.to_recipients, ''),
      coalesce(input_record.cc_recipients, ''),
      coalesce(input_record.bcc_recipients, ''),
      coalesce(input_record.body_html, ''),
      coalesce(input_record.body_text, ''),
      coalesce(input_record.tags, '{}'::text[]),
      input_record.slug,
      coalesce(input_record.is_active, true),
      coalesce(input_record.placeholders, '{}'::text[]),
      input_recipient_resolution
    )
    returning * into saved_record;
  end if;

  return to_jsonb(saved_record);
end;
$$;

create or replace function public.delete_email_template_canonical(
  p_id text,
  p_expected_revision bigint default null,
  p_expected_updated_at timestamptz default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_record public.email_templates%rowtype;
  deleted_record public.email_templates%rowtype;
begin
  if nullif(pg_catalog.btrim(p_id), '') is null then
    raise exception 'EMAIL_TEMPLATE_INVALID: id is required.'
      using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('email_templates_canonical_write', 0)
  );

  select *
  into current_record
  from public.email_templates
  where id = p_id
  for update;

  if not found then
    return null;
  end if;

  if p_expected_revision is not null then
    if current_record.revision <> p_expected_revision then
      raise exception 'EMAIL_TEMPLATE_CONFLICT'
        using
          errcode = '40001',
          detail = pg_catalog.format(
            'Template %s expected revision %s but current revision is %s.',
            p_id,
            p_expected_revision,
            current_record.revision
          );
    end if;
  elsif p_expected_updated_at is not null
    and current_record.updated_at <> p_expected_updated_at
  then
    raise exception 'EMAIL_TEMPLATE_CONFLICT'
      using
        errcode = '40001',
        detail = pg_catalog.format(
          'Template %s changed after the supplied timestamp.',
          p_id
        );
  elsif p_expected_updated_at is null then
    raise exception 'EMAIL_TEMPLATE_CONFLICT'
      using
        errcode = '40001',
        detail = pg_catalog.format(
          'Template %s was deleted without an expected revision.',
          p_id
        );
  end if;

  delete from public.email_templates
  where id = p_id
  returning * into deleted_record;

  return to_jsonb(deleted_record);
end;
$$;

create or replace function public.replace_email_template_library_canonical(
  p_templates jsonb,
  p_expected_library_revision text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_library_revision text;
  normalised_templates jsonb;
  saved_rows jsonb;
  saved_updated_at timestamptz;
begin
  if p_templates is null or jsonb_typeof(p_templates) <> 'array' then
    raise exception 'EMAIL_TEMPLATE_INVALID: templates must be a JSON array.'
      using errcode = '22023';
  end if;

  if jsonb_array_length(p_templates) > 5000 then
    raise exception 'EMAIL_TEMPLATE_INVALID: template library exceeds 5000 rows.'
      using errcode = '22023';
  end if;

  select coalesce(
    jsonb_agg(
      item.value || jsonb_build_object(
        'recipient_resolution',
        coalesce(
          nullif(item.value -> 'recipient_resolution', 'null'::jsonb),
          nullif(item.value -> 'recipientResolution', 'null'::jsonb),
          '{}'::jsonb
        )
      )
      order by item.ordinality
    ),
    '[]'::jsonb
  )
  into normalised_templates
  from jsonb_array_elements(p_templates) with ordinality as item(value, ordinality);

  if p_expected_library_revision is null
    or p_expected_library_revision !~ '^[0-9a-f]{64}$'
  then
    raise exception 'EMAIL_TEMPLATE_CONFLICT'
      using
        errcode = '40001',
        detail = 'A valid expected library revision is required.';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(normalised_templates) as item(value)
    where jsonb_typeof(item.value) <> 'object'
  ) then
    raise exception 'EMAIL_TEMPLATE_INVALID: every template must be a JSON object.'
      using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(normalised_templates) as item(value)
    where nullif(pg_catalog.btrim(item.value ->> 'id'), '') is null
      or nullif(pg_catalog.btrim(item.value ->> 'title'), '') is null
      or nullif(pg_catalog.btrim(item.value ->> 'slug'), '') is null
  ) then
    raise exception 'EMAIL_TEMPLATE_INVALID: id, title and slug are required.'
      using errcode = '22023';
  end if;

  if (
    select count(*)
    from jsonb_array_elements(normalised_templates)
  ) <> (
    select count(distinct item.value ->> 'id')
    from jsonb_array_elements(normalised_templates) as item(value)
  ) then
    raise exception 'EMAIL_TEMPLATE_INVALID: duplicate template ids are not allowed.'
      using errcode = '22023';
  end if;

  if (
    select count(*)
    from jsonb_array_elements(normalised_templates)
  ) <> (
    select count(distinct item.value ->> 'slug')
    from jsonb_array_elements(normalised_templates) as item(value)
  ) then
    raise exception 'EMAIL_TEMPLATE_INVALID: duplicate template slugs are not allowed.'
      using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('email_templates_canonical_write', 0)
  );
  lock table public.email_templates in share row exclusive mode;

  current_library_revision := public.email_template_library_revision();
  if current_library_revision <> p_expected_library_revision then
    raise exception 'EMAIL_TEMPLATE_CONFLICT'
      using
        errcode = '40001',
        detail = pg_catalog.format(
          'Expected library revision %s but current revision is %s.',
          p_expected_library_revision,
          current_library_revision
        );
  end if;

  insert into public.email_templates as current_template (
    id,
    title,
    subject,
    folder,
    source_path,
    sender,
    to_recipients,
    cc_recipients,
    bcc_recipients,
    body_html,
    body_text,
    tags,
    slug,
    is_active,
    placeholders,
    recipient_resolution
  )
  select
    input.id,
    input.title,
    coalesce(input.subject, ''),
    coalesce(input.folder, ''),
    coalesce(input.source_path, ''),
    coalesce(input.sender, ''),
    coalesce(input.to_recipients, ''),
    coalesce(input.cc_recipients, ''),
    coalesce(input.bcc_recipients, ''),
    coalesce(input.body_html, ''),
    coalesce(input.body_text, ''),
    coalesce(input.tags, '{}'::text[]),
    input.slug,
    coalesce(input.is_active, true),
    coalesce(input.placeholders, '{}'::text[]),
    coalesce(input.recipient_resolution, '{}'::jsonb)
  from jsonb_to_recordset(normalised_templates) as input(
    id text,
    title text,
    subject text,
    folder text,
    source_path text,
    sender text,
    to_recipients text,
    cc_recipients text,
    bcc_recipients text,
    body_html text,
    body_text text,
    tags text[],
    slug text,
    is_active boolean,
    placeholders text[],
    recipient_resolution jsonb
  )
  on conflict (id) do update
  set
    title = excluded.title,
    subject = excluded.subject,
    folder = excluded.folder,
    source_path = excluded.source_path,
    sender = excluded.sender,
    to_recipients = excluded.to_recipients,
    cc_recipients = excluded.cc_recipients,
    bcc_recipients = excluded.bcc_recipients,
    body_html = excluded.body_html,
    body_text = excluded.body_text,
    tags = excluded.tags,
    slug = excluded.slug,
    is_active = excluded.is_active,
    placeholders = excluded.placeholders,
    recipient_resolution = excluded.recipient_resolution
  where (
    current_template.title,
    current_template.subject,
    current_template.folder,
    current_template.source_path,
    current_template.sender,
    current_template.to_recipients,
    current_template.cc_recipients,
    current_template.bcc_recipients,
    current_template.body_html,
    current_template.body_text,
    current_template.tags,
    current_template.slug,
    current_template.is_active,
    current_template.placeholders,
    current_template.recipient_resolution
  ) is distinct from (
    excluded.title,
    excluded.subject,
    excluded.folder,
    excluded.source_path,
    excluded.sender,
    excluded.to_recipients,
    excluded.cc_recipients,
    excluded.bcc_recipients,
    excluded.body_html,
    excluded.body_text,
    excluded.tags,
    excluded.slug,
    excluded.is_active,
    excluded.placeholders,
    excluded.recipient_resolution
  );

  delete from public.email_templates as current_template
  where not exists (
    select 1
    from jsonb_to_recordset(normalised_templates) as input(id text)
    where input.id = current_template.id
  );

  select
    coalesce(
      jsonb_agg(to_jsonb(template) order by template.folder, template.title, template.id),
      '[]'::jsonb
    ),
    max(template.updated_at)
  into saved_rows, saved_updated_at
  from public.email_templates as template;

  return jsonb_build_object(
    'templates', saved_rows,
    'revision', public.email_template_library_revision(),
    'lastImportedAt', saved_updated_at,
    'lastUpdatedAt', saved_updated_at
  );
end;
$$;

create or replace function public.repair_email_templates_canonical(
  p_repairs jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  conflicting_ids text;
  normalised_repairs jsonb;
  repaired_rows jsonb;
begin
  if p_repairs is null or jsonb_typeof(p_repairs) <> 'array' then
    raise exception 'EMAIL_TEMPLATE_INVALID: repairs must be a JSON array.'
      using errcode = '22023';
  end if;

  if jsonb_array_length(p_repairs) > 5000 then
    raise exception 'EMAIL_TEMPLATE_INVALID: repair batch exceeds 5000 rows.'
      using errcode = '22023';
  end if;

  select coalesce(
    jsonb_agg(
      item.value || jsonb_build_object(
        'recipient_resolution',
        coalesce(
          nullif(item.value -> 'recipient_resolution', 'null'::jsonb),
          nullif(item.value -> 'recipientResolution', 'null'::jsonb),
          '{}'::jsonb
        )
      )
      order by item.ordinality
    ),
    '[]'::jsonb
  )
  into normalised_repairs
  from jsonb_array_elements(p_repairs) with ordinality as item(value, ordinality);

  if exists (
    select 1
    from jsonb_array_elements(normalised_repairs) as item(value)
    where jsonb_typeof(item.value) <> 'object'
      or nullif(pg_catalog.btrim(item.value ->> 'id'), '') is null
      or nullif(pg_catalog.btrim(item.value ->> 'title'), '') is null
      or nullif(pg_catalog.btrim(item.value ->> 'slug'), '') is null
      or coalesce((item.value ->> 'expected_revision')::bigint, 0) < 1
  ) then
    raise exception 'EMAIL_TEMPLATE_INVALID: each repair needs id, title, slug and expected_revision.'
      using errcode = '22023';
  end if;

  if (
    select count(*)
    from jsonb_array_elements(normalised_repairs)
  ) <> (
    select count(distinct item.value ->> 'id')
    from jsonb_array_elements(normalised_repairs) as item(value)
  ) then
    raise exception 'EMAIL_TEMPLATE_INVALID: duplicate repair ids are not allowed.'
      using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('email_templates_canonical_write', 0)
  );
  lock table public.email_templates in share row exclusive mode;

  select pg_catalog.string_agg(input.id, ', ' order by input.id)
  into conflicting_ids
  from jsonb_to_recordset(normalised_repairs) as input(
    id text,
    expected_revision bigint
  )
  left join public.email_templates as current_template
    on current_template.id = input.id
  where current_template.id is null
    or current_template.revision <> input.expected_revision;

  if conflicting_ids is not null then
    raise exception 'EMAIL_TEMPLATE_CONFLICT'
      using
        errcode = '40001',
        detail = 'Formatting repair conflicted with newer rows: ' || conflicting_ids;
  end if;

  with repaired as (
    update public.email_templates as current_template
    set
      title = input.title,
      subject = coalesce(input.subject, ''),
      folder = coalesce(input.folder, ''),
      source_path = coalesce(input.source_path, ''),
      sender = coalesce(input.sender, ''),
      to_recipients = coalesce(input.to_recipients, ''),
      cc_recipients = coalesce(input.cc_recipients, ''),
      bcc_recipients = coalesce(input.bcc_recipients, ''),
      body_html = coalesce(input.body_html, ''),
      body_text = coalesce(input.body_text, ''),
      tags = coalesce(input.tags, '{}'::text[]),
      slug = input.slug,
      is_active = coalesce(input.is_active, true),
      placeholders = coalesce(input.placeholders, '{}'::text[]),
      recipient_resolution = coalesce(input.recipient_resolution, '{}'::jsonb)
    from jsonb_to_recordset(normalised_repairs) as input(
      id text,
      title text,
      subject text,
      folder text,
      source_path text,
      sender text,
      to_recipients text,
      cc_recipients text,
      bcc_recipients text,
      body_html text,
      body_text text,
      tags text[],
      slug text,
      is_active boolean,
      placeholders text[],
      recipient_resolution jsonb,
      expected_revision bigint
    )
    where current_template.id = input.id
    returning current_template.*
  )
  select coalesce(
    jsonb_agg(to_jsonb(repaired) order by repaired.id),
    '[]'::jsonb
  )
  into repaired_rows
  from repaired;

  return repaired_rows;
end;
$$;

revoke execute on function public.email_templates_manage_version()
  from public, anon, authenticated;
revoke execute on function public.email_template_library_revision()
  from public, anon, authenticated;
revoke execute on function public.save_email_template_canonical(jsonb, bigint, timestamptz)
  from public, anon, authenticated;
revoke execute on function public.delete_email_template_canonical(text, bigint, timestamptz)
  from public, anon, authenticated;
revoke execute on function public.replace_email_template_library_canonical(jsonb, text)
  from public, anon, authenticated;
revoke execute on function public.repair_email_templates_canonical(jsonb)
  from public, anon, authenticated;

grant execute on function public.email_template_library_revision()
  to service_role;
grant execute on function public.save_email_template_canonical(jsonb, bigint, timestamptz)
  to service_role;
grant execute on function public.delete_email_template_canonical(text, bigint, timestamptz)
  to service_role;
grant execute on function public.replace_email_template_library_canonical(jsonb, text)
  to service_role;
grant execute on function public.repair_email_templates_canonical(jsonb)
  to service_role;
