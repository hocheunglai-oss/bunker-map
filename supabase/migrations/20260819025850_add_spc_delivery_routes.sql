create table if not exists public.spc_delivery_routes (
  id uuid primary key default gen_random_uuid(),
  label text not null check (char_length(btrim(label)) between 1 and 100),
  exact_group_name text not null check (char_length(btrim(exact_group_name)) between 1 and 200),
  is_active boolean not null default true,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);

create unique index if not exists spc_delivery_routes_label_lower_key
  on public.spc_delivery_routes(lower(btrim(label)));

create unique index if not exists spc_delivery_routes_group_lower_key
  on public.spc_delivery_routes(lower(btrim(exact_group_name)));

alter table public.spc_users
  add column if not exists delivery_route_id uuid
    references public.spc_delivery_routes(id) on delete restrict;

create index if not exists spc_users_delivery_route_id_idx
  on public.spc_users(delivery_route_id)
  where delivery_route_id is not null;

alter table public.spc_group_delivery_jobs
  add column if not exists delivery_route_id uuid
    references public.spc_delivery_routes(id) on delete restrict,
  add column if not exists destination_route_label text,
  add column if not exists destination_group_name text;

alter table public.spc_group_delivery_jobs
  drop constraint if exists spc_group_delivery_jobs_destination_route_label_check,
  add constraint spc_group_delivery_jobs_destination_route_label_check
    check (
      destination_route_label is null
      or char_length(btrim(destination_route_label)) between 1 and 100
    ),
  drop constraint if exists spc_group_delivery_jobs_destination_group_name_check,
  add constraint spc_group_delivery_jobs_destination_group_name_check
    check (
      destination_group_name is null
      or char_length(btrim(destination_group_name)) between 1 and 200
    );

create index if not exists spc_group_delivery_jobs_delivery_route_id_idx
  on public.spc_group_delivery_jobs(delivery_route_id)
  where delivery_route_id is not null;

do $$
declare
  default_route_id uuid;
  default_route_label constant text := 'SPC TRADING GROUP';
  default_group_name text;
begin
  select btrim(dispatchers.group_name)
    into default_group_name
  from public.spc_group_dispatchers as dispatchers
  where dispatchers.active
    and btrim(dispatchers.group_name) <> ''
  order by dispatchers.updated_at desc, dispatchers.id
  limit 1;

  if default_group_name is null then
    return;
  end if;

  insert into public.spc_delivery_routes (label, exact_group_name, is_active)
  values (default_route_label, default_group_name, true)
  on conflict do nothing;

  select routes.id
    into default_route_id
  from public.spc_delivery_routes as routes
  where lower(btrim(routes.exact_group_name)) = lower(default_group_name)
  order by routes.created_at, routes.id
  limit 1;

  if default_route_id is null then
    return;
  end if;

  update public.spc_users
  set delivery_route_id = default_route_id
  where delivery_route_id is null
    and is_active;

  update public.spc_group_delivery_jobs as jobs
  set delivery_route_id = default_route_id,
      destination_route_label = default_route_label,
      destination_group_name = default_group_name,
      updated_at = clock_timestamp()
  where jobs.delivery_route_id is null
    and jobs.destination_group_name is null;
end;
$$;

create or replace function public.save_spc_user_with_delivery_route(
  p_user_id uuid,
  p_username text,
  p_display_name text,
  p_whatsapp_phone text,
  p_database_role text,
  p_effective_role text,
  p_office text,
  p_must_change_password boolean,
  p_is_supplier_trader boolean,
  p_password_hash text,
  p_is_active boolean,
  p_delivery_route_id uuid
)
returns table (
  id uuid,
  username text,
  display_name text,
  whatsapp_phone text,
  role text,
  is_active boolean,
  delivery_route_id uuid,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  saved_user_id uuid;
begin
  if p_delivery_route_id is not null
    and not exists (
      select 1
      from public.spc_delivery_routes as routes
      where routes.id = p_delivery_route_id
        and routes.is_active
    )
  then
    raise exception 'Select an active enquiry delivery route.';
  end if;

  select saved.id
    into saved_user_id
  from public.save_spc_user_with_admin_continuity(
    p_user_id,
    p_username,
    p_display_name,
    p_whatsapp_phone,
    p_database_role,
    p_effective_role,
    p_office,
    p_must_change_password,
    p_is_supplier_trader,
    p_password_hash,
    p_is_active
  ) as saved
  limit 1;

  if saved_user_id is null then
    raise exception 'SPC user could not be saved.';
  end if;

  update public.spc_users as users
  set delivery_route_id = p_delivery_route_id,
      updated_at = clock_timestamp()
  where users.id = saved_user_id;

  return query
  select
    users.id,
    users.username,
    users.display_name,
    users.whatsapp_phone,
    users.role,
    users.is_active,
    users.delivery_route_id,
    users.created_at,
    users.updated_at
  from public.spc_users as users
  where users.id = saved_user_id;
end;
$$;

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
  route_row public.spc_delivery_routes%rowtype;
begin
  select * into route_row
  from public.spc_delivery_routes as routes
  where routes.id = (
    select users.delivery_route_id
    from public.spc_users as users
    where lower(users.username) = lower(btrim(p_actor_username))
      and users.is_active
    limit 1
  )
    and routes.is_active;

  if not found then
    raise exception 'No active enquiry delivery route is assigned to this user.';
  end if;

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
    message_text,
    delivery_route_id,
    destination_route_label,
    destination_group_name
  ) values (
    enquiry_row.id,
    enquiry_row.revision_number,
    'created',
    p_message_text,
    route_row.id,
    btrim(route_row.label),
    btrim(route_row.exact_group_name)
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
  route_row public.spc_delivery_routes%rowtype;
  next_revision integer;
  before_snapshot jsonb;
  after_snapshot jsonb;
begin
  if jsonb_typeof(p_enquiry) <> 'object' or jsonb_typeof(p_changed_fields) <> 'array' then
    raise exception 'Invalid SPC amendment payload.';
  end if;

  select * into route_row
  from public.spc_delivery_routes as routes
  where routes.id = (
    select users.delivery_route_id
    from public.spc_users as users
    where lower(users.username) = lower(btrim(p_actor_username))
      and users.is_active
    limit 1
  )
    and routes.is_active;

  if not found then
    raise exception 'No active enquiry delivery route is assigned to this user.';
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
    message_text,
    delivery_route_id,
    destination_route_label,
    destination_group_name
  ) values (
    p_enquiry_id,
    next_revision,
    'amended',
    p_message_text,
    route_row.id,
    btrim(route_row.label),
    btrim(route_row.exact_group_name)
  );

  return query
  select enquiries.*
  from public.spc_enquiries as enquiries
  where enquiries.id = p_enquiry_id;
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
      and nullif(btrim(jobs.destination_group_name), '') is not null
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

drop trigger if exists set_spc_delivery_routes_updated_at on public.spc_delivery_routes;
create trigger set_spc_delivery_routes_updated_at
before update on public.spc_delivery_routes
for each row
execute function public.set_spc_updated_at();

alter table public.spc_delivery_routes enable row level security;

drop policy if exists "spc_delivery_routes_no_public_access" on public.spc_delivery_routes;
create policy "spc_delivery_routes_no_public_access"
  on public.spc_delivery_routes
  for all
  to public
  using (false)
  with check (false);

revoke all privileges on table public.spc_delivery_routes from public, anon, authenticated;
grant select, insert, update, delete on table public.spc_delivery_routes to service_role;

revoke all on function public.save_spc_user_with_delivery_route(
  uuid, text, text, text, text, text, text, boolean, boolean, text, boolean, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.save_spc_user_with_delivery_route(
  uuid, text, text, text, text, text, text, boolean, boolean, text, boolean, uuid
) to service_role;

comment on table public.spc_delivery_routes is
  'Central exact WhatsApp group destinations assigned to SPC enquiry senders.';
comment on column public.spc_group_delivery_jobs.destination_group_name is
  'Immutable exact WhatsApp group-name snapshot used by the dedicated dispatcher.';

do $$
begin
  if to_regprocedure('public.audit_enable_table(regclass)') is not null then
    perform public.audit_enable_table('public.spc_delivery_routes'::regclass);
  end if;
end;
$$;
