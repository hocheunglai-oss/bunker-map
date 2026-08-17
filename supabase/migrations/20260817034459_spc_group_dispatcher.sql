alter table public.spc_enquiries
  add column if not exists revision_number integer not null default 1
    check (revision_number >= 1),
  add column if not exists last_amended_at timestamptz,
  add column if not exists last_amended_by_username text,
  add column if not exists last_amendment_changes jsonb not null default '[]'::jsonb
    check (jsonb_typeof(last_amendment_changes) = 'array');

create table if not exists public.spc_enquiry_revisions (
  id uuid primary key default gen_random_uuid(),
  enquiry_id uuid not null references public.spc_enquiries(id) on delete cascade,
  revision_number integer not null check (revision_number >= 1),
  event_type text not null check (event_type in ('created', 'amended')),
  formatted_text text not null,
  changed_fields jsonb not null default '[]'::jsonb
    check (jsonb_typeof(changed_fields) = 'array'),
  before_snapshot jsonb,
  after_snapshot jsonb not null check (jsonb_typeof(after_snapshot) = 'object'),
  created_by_username text not null,
  created_by_display_name text not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (enquiry_id, revision_number)
);

create index if not exists spc_enquiry_revisions_enquiry_created_idx
  on public.spc_enquiry_revisions(enquiry_id, revision_number desc);

create table if not exists public.spc_group_dispatchers (
  id uuid primary key,
  device_label text not null check (char_length(btrim(device_label)) between 1 and 100),
  group_name text not null check (char_length(btrim(group_name)) between 1 and 200),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  extension_version text not null,
  active boolean not null default true,
  paired_by_username text not null,
  paired_by_display_name text not null,
  last_seen_at timestamptz,
  last_error text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);

create unique index if not exists spc_group_dispatchers_one_active_idx
  on public.spc_group_dispatchers(active)
  where active;

create table if not exists public.spc_group_delivery_jobs (
  id uuid primary key default gen_random_uuid(),
  enquiry_id uuid not null references public.spc_enquiries(id) on delete cascade,
  revision_number integer not null check (revision_number >= 1),
  event_type text not null check (event_type in ('created', 'amended')),
  message_text text not null check (char_length(message_text) between 1 and 12000),
  status text not null default 'queued'
    check (status in ('queued', 'claimed', 'sent', 'failed', 'manual_review', 'cancelled')),
  attempt_count integer not null default 0 check (attempt_count between 0 and 20),
  available_at timestamptz not null default clock_timestamp(),
  claimed_by uuid references public.spc_group_dispatchers(id) on delete set null,
  claim_token_hash text check (claim_token_hash is null or claim_token_hash ~ '^[0-9a-f]{64}$'),
  lease_expires_at timestamptz,
  last_error text,
  sent_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (enquiry_id, revision_number, event_type)
);

create index if not exists spc_group_delivery_jobs_pending_idx
  on public.spc_group_delivery_jobs(available_at, created_at)
  where status in ('queued', 'failed', 'claimed');

create or replace function public.enqueue_spc_enquiry_group_delivery(
  p_enquiry_id uuid,
  p_actor_username text,
  p_actor_display_name text,
  p_formatted_text text,
  p_after_snapshot jsonb,
  p_message_text text
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  enquiry_row public.spc_enquiries%rowtype;
begin
  select * into enquiry_row
  from public.spc_enquiries
  where id = p_enquiry_id
    and lower(created_by_username) = lower(btrim(p_actor_username));

  if not found then
    raise exception 'SPC enquiry was not found or is not owned by the actor.';
  end if;

  insert into public.spc_enquiry_revisions (
    enquiry_id,
    revision_number,
    event_type,
    formatted_text,
    changed_fields,
    before_snapshot,
    after_snapshot,
    created_by_username,
    created_by_display_name
  ) values (
    enquiry_row.id,
    enquiry_row.revision_number,
    'created',
    p_formatted_text,
    '[]'::jsonb,
    null,
    p_after_snapshot,
    btrim(p_actor_username),
    btrim(p_actor_display_name)
  )
  on conflict (enquiry_id, revision_number) do nothing;

  insert into public.spc_group_delivery_jobs (
    enquiry_id,
    revision_number,
    event_type,
    message_text
  ) values (
    enquiry_row.id,
    enquiry_row.revision_number,
    'created',
    p_message_text
  )
  on conflict (enquiry_id, revision_number, event_type) do nothing;
end;
$$;

create or replace function public.amend_spc_enquiry_with_group_delivery(
  p_enquiry_id uuid,
  p_actor_username text,
  p_actor_display_name text,
  p_enquiry jsonb,
  p_formatted_text text,
  p_changed_fields jsonb,
  p_message_text text
)
returns setof public.spc_enquiries
language plpgsql
security invoker
set search_path = ''
as $$
declare
  existing public.spc_enquiries%rowtype;
  next_revision integer;
  before_snapshot jsonb;
  after_snapshot jsonb;
begin
  if jsonb_typeof(p_enquiry) <> 'object' or jsonb_typeof(p_changed_fields) <> 'array' then
    raise exception 'Invalid SPC amendment payload.';
  end if;

  select * into existing
  from public.spc_enquiries
  where id = p_enquiry_id
    and lower(created_by_username) = lower(btrim(p_actor_username))
  for update;

  if not found then
    raise exception 'SPC enquiry was not found or is not owned by the actor.';
  end if;

  if existing.status <> 'sent' then
    raise exception 'Only a sent enquiry can be amended.';
  end if;

  if jsonb_array_length(p_changed_fields) = 0 then
    raise exception 'At least one enquiry field must change.';
  end if;

  next_revision := existing.revision_number + 1;
  before_snapshot := jsonb_build_object(
    'title', existing.title,
    'vesselName', existing.vessel_name,
    'port', existing.port,
    'product', existing.product,
    'quantity', existing.quantity,
    'deliveryDate', existing.delivery_date,
    'supplierName', existing.supplier_name,
    'notes', existing.notes
  );
  after_snapshot := jsonb_build_object(
    'title', p_enquiry->>'title',
    'vesselName', nullif(btrim(p_enquiry->>'vesselName'), ''),
    'port', nullif(btrim(p_enquiry->>'port'), ''),
    'product', nullif(btrim(p_enquiry->>'product'), ''),
    'quantity', nullif(btrim(p_enquiry->>'quantity'), ''),
    'deliveryDate', nullif(btrim(p_enquiry->>'deliveryDate'), ''),
    'supplierName', nullif(btrim(p_enquiry->>'supplierName'), ''),
    'notes', nullif(btrim(p_enquiry->>'notes'), '')
  );

  update public.spc_enquiries
  set title = btrim(p_enquiry->>'title'),
      vessel_name = nullif(btrim(p_enquiry->>'vesselName'), ''),
      port = nullif(btrim(p_enquiry->>'port'), ''),
      product = nullif(btrim(p_enquiry->>'product'), ''),
      quantity = nullif(btrim(p_enquiry->>'quantity'), ''),
      delivery_date = case
        when coalesce(p_enquiry->>'deliveryDate', '') ~ '^\d{4}-\d{2}-\d{2}$'
          then (p_enquiry->>'deliveryDate')::date
        else null
      end,
      supplier_name = nullif(btrim(p_enquiry->>'supplierName'), ''),
      notes = nullif(btrim(p_enquiry->>'notes'), ''),
      revision_number = next_revision,
      last_amended_at = clock_timestamp(),
      last_amended_by_username = btrim(p_actor_username),
      last_amendment_changes = p_changed_fields,
      updated_at = clock_timestamp()
  where id = p_enquiry_id;

  insert into public.spc_enquiry_revisions (
    enquiry_id,
    revision_number,
    event_type,
    formatted_text,
    changed_fields,
    before_snapshot,
    after_snapshot,
    created_by_username,
    created_by_display_name
  ) values (
    p_enquiry_id,
    next_revision,
    'amended',
    p_formatted_text,
    p_changed_fields,
    before_snapshot,
    after_snapshot,
    btrim(p_actor_username),
    btrim(p_actor_display_name)
  );

  insert into public.spc_group_delivery_jobs (
    enquiry_id,
    revision_number,
    event_type,
    message_text
  ) values (
    p_enquiry_id,
    next_revision,
    'amended',
    p_message_text
  );

  return query select enquiries.* from public.spc_enquiries as enquiries where enquiries.id = p_enquiry_id;
end;
$$;

create or replace function public.claim_spc_group_delivery_job(
  p_dispatcher_id uuid,
  p_claim_token_hash text,
  p_lease_seconds integer default 90
)
returns setof public.spc_group_delivery_jobs
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_claim_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid claim token hash.';
  end if;

  if p_lease_seconds < 30 or p_lease_seconds > 300 then
    raise exception 'Invalid claim lease.';
  end if;

  return query
  with candidate as (
    select jobs.id
    from public.spc_group_delivery_jobs as jobs
    where (
      jobs.status in ('queued', 'failed')
      or (
        jobs.status = 'claimed'
        and jobs.lease_expires_at is not null
        and jobs.lease_expires_at <= clock_timestamp()
      )
    )
      and jobs.available_at <= clock_timestamp()
      and jobs.attempt_count < 20
    order by jobs.created_at, jobs.id
    for update skip locked
    limit 1
  )
  update public.spc_group_delivery_jobs as jobs
  set status = 'claimed',
      attempt_count = jobs.attempt_count + 1,
      claimed_by = p_dispatcher_id,
      claim_token_hash = p_claim_token_hash,
      lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
      last_error = null,
      updated_at = clock_timestamp()
  from candidate
  where jobs.id = candidate.id
  returning jobs.*;
end;
$$;

create or replace function public.complete_spc_group_delivery_job(
  p_job_id uuid,
  p_dispatcher_id uuid,
  p_claim_token_hash text,
  p_result text,
  p_error text default null
)
returns setof public.spc_group_delivery_jobs
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_result not in ('sent', 'failed', 'manual_review') then
    raise exception 'Invalid delivery result.';
  end if;

  return query
  update public.spc_group_delivery_jobs as jobs
  set status = p_result,
      available_at = case
        when p_result = 'failed' then clock_timestamp() + make_interval(secs => least(300, 15 * greatest(1, jobs.attempt_count)))
        else jobs.available_at
      end,
      claim_token_hash = null,
      lease_expires_at = null,
      last_error = nullif(left(coalesce(p_error, ''), 1000), ''),
      sent_at = case when p_result = 'sent' then clock_timestamp() else jobs.sent_at end,
      updated_at = clock_timestamp()
  where jobs.id = p_job_id
    and jobs.status = 'claimed'
    and jobs.claimed_by = p_dispatcher_id
    and jobs.claim_token_hash = p_claim_token_hash
  returning jobs.*;
end;
$$;

alter table public.spc_enquiry_revisions enable row level security;
alter table public.spc_group_dispatchers enable row level security;
alter table public.spc_group_delivery_jobs enable row level security;

revoke all privileges on table public.spc_enquiry_revisions from public, anon, authenticated;
revoke all privileges on table public.spc_group_dispatchers from public, anon, authenticated;
revoke all privileges on table public.spc_group_delivery_jobs from public, anon, authenticated;
revoke all on function public.claim_spc_group_delivery_job(uuid, text, integer) from public, anon, authenticated;
revoke all on function public.complete_spc_group_delivery_job(uuid, uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.enqueue_spc_enquiry_group_delivery(uuid, text, text, text, jsonb, text) from public, anon, authenticated;
revoke all on function public.amend_spc_enquiry_with_group_delivery(uuid, text, text, jsonb, text, jsonb, text) from public, anon, authenticated;

grant select, insert, update, delete on table public.spc_enquiry_revisions to service_role;
grant select, insert, update, delete on table public.spc_group_dispatchers to service_role;
grant select, insert, update, delete on table public.spc_group_delivery_jobs to service_role;
grant execute on function public.claim_spc_group_delivery_job(uuid, text, integer) to service_role;
grant execute on function public.complete_spc_group_delivery_job(uuid, uuid, text, text, text) to service_role;
grant execute on function public.enqueue_spc_enquiry_group_delivery(uuid, text, text, text, jsonb, text) to service_role;
grant execute on function public.amend_spc_enquiry_with_group_delivery(uuid, text, text, jsonb, text, jsonb, text) to service_role;

comment on table public.spc_enquiry_revisions is
  'Immutable SPC enquiry creation and amendment history used by the trader feed and group dispatcher.';
comment on table public.spc_group_dispatchers is
  'Server-authorized dedicated WhatsApp Web dispatcher devices. Only one device may be active.';
comment on table public.spc_group_delivery_jobs is
  'Idempotent, leased delivery queue for new and amended enquiries sent to the SPC trading group.';

do $$
begin
  if to_regprocedure('public.audit_enable_table(regclass)') is not null then
    perform public.audit_enable_table('public.spc_enquiry_revisions'::regclass);
    perform public.audit_enable_table('public.spc_group_dispatchers'::regclass);
    perform public.audit_enable_table('public.spc_group_delivery_jobs'::regclass);
  end if;
end;
$$;
