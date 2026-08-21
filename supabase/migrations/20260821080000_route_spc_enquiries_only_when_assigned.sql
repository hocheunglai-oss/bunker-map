do $$
declare
  default_route_id uuid;
begin
  select routes.id
    into default_route_id
  from public.spc_delivery_routes as routes
  where lower(btrim(routes.exact_group_name)) = lower('Otto (FCBHK) SG Enqs')
  limit 1;

  if default_route_id is null then
    return;
  end if;

  update public.spc_users as users
  set delivery_route_id = null,
      updated_at = clock_timestamp()
  where users.delivery_route_id = default_route_id
    and lower(users.username) <> lower('otto@cosulich.com.hk');
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

  if route_row.id is not null then
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
  end if;
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

  if route_row.id is not null then
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
  end if;

  return query
  select enquiries.*
  from public.spc_enquiries as enquiries
  where enquiries.id = p_enquiry_id;
end;
$$;

create or replace function public.reoffer_spc_enquiry_with_group_delivery(
  p_source_enquiry_id uuid,
  p_actor_username text,
  p_actor_display_name text,
  p_enquiry jsonb,
  p_formatted_text text,
  p_after_snapshot jsonb,
  p_message_text text,
  p_retired_notes text
)
returns setof public.spc_enquiries
language plpgsql
security invoker
set search_path = ''
as $$
declare
  source_row public.spc_enquiries%rowtype;
  reoffer_row public.spc_enquiries%rowtype;
  route_row public.spc_delivery_routes%rowtype;
begin
  if jsonb_typeof(p_enquiry) <> 'object' or jsonb_typeof(p_after_snapshot) <> 'object' then
    raise exception 'Invalid SPC reoffer payload.';
  end if;

  if nullif(btrim(p_enquiry->>'title'), '') is null
    or nullif(btrim(p_formatted_text), '') is null
    or nullif(btrim(p_message_text), '') is null then
    raise exception 'SPC reoffer title and message are required.';
  end if;

  select * into source_row
  from public.spc_enquiries
  where id = p_source_enquiry_id
    and lower(created_by_username) = lower(btrim(p_actor_username))
  for update;

  if not found then
    raise exception 'SPC enquiry was not found or is not owned by the actor.';
  end if;

  if source_row.status <> 'sent' then
    raise exception 'Only an active enquiry can be reoffered.';
  end if;

  insert into public.spc_enquiries (
    title,
    vessel_name,
    port,
    product,
    quantity,
    delivery_date,
    supplier_name,
    status,
    notes,
    created_by_username,
    created_by_display_name
  ) values (
    btrim(p_enquiry->>'title'),
    nullif(btrim(p_enquiry->>'vesselName'), ''),
    nullif(btrim(p_enquiry->>'port'), ''),
    nullif(btrim(p_enquiry->>'product'), ''),
    nullif(btrim(p_enquiry->>'quantity'), ''),
    case
      when coalesce(p_enquiry->>'deliveryDate', '') ~ '^\d{4}-\d{2}-\d{2}$'
        then (p_enquiry->>'deliveryDate')::date
      else null
    end,
    nullif(btrim(p_enquiry->>'supplierName'), ''),
    'sent',
    nullif(btrim(p_enquiry->>'notes'), ''),
    btrim(p_actor_username),
    btrim(p_actor_display_name)
  )
  returning * into reoffer_row;

  update public.spc_enquiries
  set status = 'closed',
      notes = nullif(btrim(p_retired_notes), ''),
      updated_at = clock_timestamp()
  where id = source_row.id;

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
    reoffer_row.id,
    reoffer_row.revision_number,
    'reoffer',
    p_formatted_text,
    '[]'::jsonb,
    null,
    p_after_snapshot,
    btrim(p_actor_username),
    btrim(p_actor_display_name)
  );

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

  if route_row.id is not null then
    insert into public.spc_group_delivery_jobs (
      enquiry_id,
      revision_number,
      event_type,
      message_text,
      delivery_route_id,
      destination_route_label,
      destination_group_name
    ) values (
      reoffer_row.id,
      reoffer_row.revision_number,
      'reoffer',
      p_message_text,
      route_row.id,
      btrim(route_row.label),
      btrim(route_row.exact_group_name)
    );
  end if;

  return next reoffer_row;
end;
$$;

revoke all on function public.enqueue_spc_enquiry_group_delivery(uuid, text, text, text, jsonb, text)
  from public, anon, authenticated, service_role;
grant execute on function public.enqueue_spc_enquiry_group_delivery(uuid, text, text, text, jsonb, text)
  to service_role;

revoke all on function public.amend_spc_enquiry_with_group_delivery(uuid, text, text, jsonb, text, jsonb, text)
  from public, anon, authenticated, service_role;
grant execute on function public.amend_spc_enquiry_with_group_delivery(uuid, text, text, jsonb, text, jsonb, text)
  to service_role;

revoke all on function public.reoffer_spc_enquiry_with_group_delivery(uuid, text, text, jsonb, text, jsonb, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.reoffer_spc_enquiry_with_group_delivery(uuid, text, text, jsonb, text, jsonb, text, text)
  to service_role;
