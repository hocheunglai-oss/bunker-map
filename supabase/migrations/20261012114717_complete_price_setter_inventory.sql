-- One scalar result, not SETOF: the Data API row cap must not truncate the
-- nested port inventory. Count and rows use the same MVCC statement snapshot.
create function public.read_price_setter_inventory()
returns jsonb
language sql
stable
security invoker
set search_path = ''
set statement_timeout = '15s'
as $$
  select pg_catalog.jsonb_build_object(
    'version', 1,
    'count', pg_catalog.count(*),
    'ports', coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', p.id, 'name', p.name, 'type', p.type,
      'lat', p.lat, 'lng', p.lng, 'hsfo', p.hsfo, 'vlsfo', p.vlsfo, 'mgo', p.mgo,
      'hsfo_formula', p.hsfo_formula, 'vlsfo_formula', p.vlsfo_formula,
      'mgo_formula', p.mgo_formula, 'updated_at', p.updated_at,
      'display_order', p.display_order
    ) order by p.display_order asc nulls last, p.id asc), '[]'::jsonb)
  ) from public.ports p;
$$;
revoke all on function public.read_price_setter_inventory() from public, anon, authenticated;
grant execute on function public.read_price_setter_inventory() to service_role;

-- Keep complete inventory reordering independent of the Data API row cap.
-- Confirm the persisted order and all non-order values after triggers.
create or replace function public.reorder_price_setter_ports(p_expected jsonb, p_order uuid[])
returns jsonb language plpgsql security invoker set search_path='' set lock_timeout='5s' set statement_timeout='15s' as $$
declare
  v_entry jsonb;
  v_current jsonb;
  v_desired jsonb;
  v_expected_ids uuid[];
  v_before_ports jsonb;
  v_after_ports jsonb;
begin
  if jsonb_typeof(p_expected) is distinct from 'array' or p_order is null then
    raise exception using errcode='22023',message='Invalid port order';
  end if;
  if jsonb_array_length(p_expected) < 1
    or cardinality(p_order)<>jsonb_array_length(p_expected) then
    raise exception using errcode='22023',message='Invalid port order';
  end if;
  for v_entry in select value from jsonb_array_elements(p_expected) loop
    if jsonb_typeof(v_entry) is distinct from 'array' then
      raise exception using errcode='22023',message='Invalid order snapshot';
    end if;
    if jsonb_array_length(v_entry)<>2 or jsonb_typeof(v_entry->0) is distinct from 'string'
      or (v_entry->>0) !~* '^[a-f0-9]{8}-([a-f0-9]{4}-){3}[a-f0-9]{12}$'
      or jsonb_typeof(v_entry->1) not in ('number','null') then
      raise exception using errcode='22023',message='Invalid order snapshot';
    end if;
    if jsonb_typeof(v_entry->1)='number' and ((v_entry->>1)::numeric<>trunc((v_entry->>1)::numeric)
      or (v_entry->>1)::numeric not between -2147483648 and 2147483647) then
      raise exception using errcode='22023',message='Invalid order position';
    end if;
  end loop;
  select array_agg((value->>0)::uuid) into v_expected_ids from jsonb_array_elements(p_expected);
  if (select count(distinct id) from unnest(v_expected_ids) id)<>cardinality(v_expected_ids)
    or (select count(distinct id) from unnest(p_order) id)<>cardinality(p_order)
    or not (v_expected_ids @> p_order and p_order @> v_expected_ids) then
    raise exception using errcode='22023',message='Order must contain each saved port exactly once';
  end if;
  lock table public.ports in share row exclusive mode;
  select coalesce(jsonb_agg(jsonb_build_array(id,display_order) order by display_order asc nulls last,id),'[]'::jsonb)
    into v_current from public.ports;
  select jsonb_agg(jsonb_build_array(id,position) order by position) into v_desired
    from unnest(p_order) with ordinality as desired(id,position);
  if v_current is distinct from p_expected then
    if v_current=v_desired then return jsonb_build_object('order',v_current,'replayed',true); end if;
    raise exception using errcode='P0002',message='Saved port order changed';
  end if;
  select jsonb_agg(to_jsonb(p)-'display_order' order by id) into v_before_ports from public.ports p;
  update public.ports p set display_order=desired.position::integer
    from unnest(p_order) with ordinality as desired(id,position)
    where p.id=desired.id and p.display_order is distinct from desired.position::integer;
  select coalesce(jsonb_agg(jsonb_build_array(id,display_order) order by display_order asc nulls last,id),'[]'::jsonb)
    into v_current from public.ports;
  select jsonb_agg(to_jsonb(p)-'display_order' order by id) into v_after_ports from public.ports p;
  if v_current is distinct from v_desired or v_before_ports is distinct from v_after_ports then
    raise exception using errcode='P0001',message='Port order was not persisted exactly';
  end if;
  return jsonb_build_object('order',v_current,'replayed',false);
end;
$$;
revoke all on function public.reorder_price_setter_ports(jsonb,uuid[]) from public,anon,authenticated;
grant execute on function public.reorder_price_setter_ports(jsonb,uuid[]) to service_role;
