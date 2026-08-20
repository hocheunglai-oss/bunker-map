alter table public.spc_enquiry_revisions
  drop constraint if exists spc_enquiry_revisions_event_type_check;

alter table public.spc_enquiry_revisions
  add constraint spc_enquiry_revisions_event_type_check
  check (event_type in ('created', 'amended', 'reoffer'));

alter table public.spc_group_delivery_jobs
  drop constraint if exists spc_group_delivery_jobs_event_type_check;

alter table public.spc_group_delivery_jobs
  add constraint spc_group_delivery_jobs_event_type_check
  check (event_type in ('created', 'amended', 'postponed', 'reoffer'));

create or replace function public.postpone_spc_enquiry_with_group_delivery(
  p_enquiry_id uuid,
  p_actor_username text,
  p_notes text,
  p_message_text text
)
returns setof public.spc_enquiries
language plpgsql
security invoker
set search_path = ''
as $$
declare
  enquiry_row public.spc_enquiries%rowtype;
  route_row public.spc_delivery_routes%rowtype;
begin
  if nullif(btrim(p_message_text), '') is null then
    raise exception 'SPC postponement message is required.';
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

  select * into enquiry_row
  from public.spc_enquiries
  where id = p_enquiry_id
    and lower(created_by_username) = lower(btrim(p_actor_username))
  for update;

  if not found then
    raise exception 'SPC enquiry was not found or is not owned by the actor.';
  end if;

  if enquiry_row.status <> 'sent' then
    raise exception 'Only an active enquiry can be postponed.';
  end if;

  update public.spc_enquiries
  set notes = nullif(btrim(p_notes), ''),
      updated_at = clock_timestamp()
  where id = enquiry_row.id
  returning * into enquiry_row;

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
    'postponed',
    btrim(p_message_text),
    route_row.id,
    btrim(route_row.label),
    btrim(route_row.exact_group_name)
  )
  on conflict (enquiry_id, revision_number, event_type) do nothing;

  return next enquiry_row;
end;
$$;

revoke all on function public.postpone_spc_enquiry_with_group_delivery(uuid, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.postpone_spc_enquiry_with_group_delivery(uuid, text, text, text)
  to service_role;

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

  return next reoffer_row;
end;
$$;

revoke all on function public.reoffer_spc_enquiry_with_group_delivery(uuid, text, text, jsonb, text, jsonb, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.reoffer_spc_enquiry_with_group_delivery(uuid, text, text, jsonb, text, jsonb, text, text)
  to service_role;
