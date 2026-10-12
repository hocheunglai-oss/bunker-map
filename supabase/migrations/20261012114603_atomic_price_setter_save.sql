-- One short transaction for the current price, same-HK-day history and linked
-- port dates. No historical timestamps are rewritten and no new backup table
-- is introduced. Only the authenticated server can execute this invoker RPC.
create or replace function public.save_price_setter_port(
  p_port_id uuid,
  p_expected jsonb,
  p_changes jsonb,
  p_recorded_at timestamptz default current_timestamp
) returns jsonb
language plpgsql
security invoker
set search_path = ''
set lock_timeout = '5s'
as $$
declare
  v_port public.ports%rowtype;
  v_history public.price_history%rowtype;
  v_current jsonb;
  v_fields text[] := array['name','lat','lng','hsfo','vlsfo','mgo','hsfo_formula','vlsfo_formula','mgo_formula'];
  v_field text;
  v_fuel text;
  v_match text[];
  v_cycle boolean;
  v_invalid_chain boolean;
  v_affected uuid[];
  v_renamed uuid[] := array[]::uuid[];
  v_replay boolean := false;
  v_fallback_content text;
  v_fallbacks jsonb;
  v_old_key text;
  v_new_key text;
  v_fallbacks_changed boolean := false;
  v_market_time timestamp := p_recorded_at at time zone 'Asia/Hong_Kong';
  v_market_day date := (p_recorded_at at time zone 'Asia/Hong_Kong')::date;
begin
  if p_port_id is null or p_recorded_at is null or not isfinite(p_recorded_at)
    or jsonb_typeof(p_expected) is distinct from 'object'
    or jsonb_typeof(p_changes) is distinct from 'object'
    or not (p_expected ?& (v_fields || array['updated_at']))
    or not (p_changes ?& v_fields)
    or (p_expected - (v_fields || array['updated_at'])) <> '{}'::jsonb
    or (p_changes - v_fields) <> '{}'::jsonb
    or jsonb_typeof(p_changes->'name') is distinct from 'string'
    or length(p_changes->>'name') > 200 or btrim(p_changes->>'name') = '' then
    raise exception using errcode = '22023', message = 'Invalid price save';
  end if;
  foreach v_field in array array['lat','lng','hsfo','vlsfo','mgo'] loop
    if jsonb_typeof(p_changes->v_field) not in ('number','null') then
      raise exception using errcode = '22023', message = 'Invalid numeric price field';
    end if;
  end loop;
  if abs((p_changes->>'lat')::numeric) > 90 or abs((p_changes->>'lng')::numeric) > 180
    or (p_changes->>'hsfo')::numeric < 0 or (p_changes->>'vlsfo')::numeric < 0 or (p_changes->>'mgo')::numeric < 0 then
    raise exception using errcode = '22023', message = 'Invalid numeric range';
  end if;
  foreach v_field in array array['hsfo_formula','vlsfo_formula','mgo_formula'] loop
    if jsonb_typeof(p_changes->v_field) not in ('string','null') or length(p_changes->>v_field) > 200 then
      raise exception using errcode = '22023', message = 'Invalid formula';
    end if;
    if nullif(btrim(p_changes->>v_field), '') is not null
      and regexp_match(btrim(p_changes->>v_field), '^(.*?)\s*([+-])\s*(-?[0-9]+(?:\.[0-9]+)?)$') is null then
      raise exception using errcode = '22023', message = 'Invalid formula';
    end if;
  end loop;

  -- Consistent table-lock order also fences legacy direct writers during this
  -- transaction. Reads remain available; all work below stays inside Postgres.
  lock table public.ports in share row exclusive mode;
  lock table public.price_history in share row exclusive mode;
  select * into v_port from public.ports where id = p_port_id;
  if not found or v_port.type = 'divider' then
    raise exception using errcode = 'P0002', message = 'Port changed or was removed';
  end if;
  select jsonb_object_agg(field, to_jsonb(v_port)->field) into v_current
    from unnest(v_fields || array['updated_at']) as field;

  if v_current <> p_expected then
    -- A lost HTTP response can be reconciled without repeating writes if the
    -- requested state and its one same-day history row are already committed.
    select * into v_history from public.price_history
      where port_id = p_port_id and recorded_at >= v_market_day::timestamp
        and recorded_at < (v_market_day + 1)::timestamp
      order by recorded_at desc, id desc limit 1;
    if (v_current - 'updated_at') = p_changes and v_port.updated_at = v_market_day
      and found and (select count(*) from public.price_history where port_id = p_port_id
        and recorded_at >= v_market_day::timestamp and recorded_at < (v_market_day + 1)::timestamp) = 1
      and jsonb_build_object('hsfo',v_history.hsfo,'vlsfo',v_history.vlsfo,'mgo',v_history.mgo)
        = jsonb_build_object('hsfo',p_changes->'hsfo','vlsfo',p_changes->'vlsfo','mgo',p_changes->'mgo') then
      v_replay := true;
    else
      raise exception using errcode = 'P0002', message = 'Saved port changed';
    end if;
  end if;

  if not v_replay then
    if exists (select 1 from public.ports where id <> p_port_id and coalesce(type,'port') <> 'divider'
      and lower(btrim(name)) = lower(btrim(p_changes->>'name'))) then
      raise exception using errcode = '22023', message = 'Port name is ambiguous';
    end if;

    -- Report overrides are keyed by the exact lower-cased port name. Move them
    -- in this transaction, before changing the port/formulas/history. Lock order
    -- stays ports -> history -> remarks; fallback saves use ports -> remarks.
    if lower(v_port.name) <> lower(btrim(p_changes->>'name')) then
      lock table public.remarks in share row exclusive mode;
      select content into v_fallback_content from public.remarks where id=105;
      begin
        v_fallbacks := case when v_fallback_content is null or v_fallback_content='' then '{}'::jsonb else v_fallback_content::jsonb end;
      exception when invalid_text_representation then
        raise exception using errcode='P0001',message='Stored report settings could not be read';
      end;
      if jsonb_typeof(v_fallbacks) is distinct from 'object' then
        raise exception using errcode='P0001',message='Stored report settings could not be read';
      end if;
      if exists(select 1 from jsonb_each(v_fallbacks) e where e.key <> lower(e.key) or length(e.key)>260
        or e.key !~ '^.+::(hsfo|vlsfo|mgo)$' or btrim(regexp_replace(e.key,'::(hsfo|vlsfo|mgo)$',''))=''
        or jsonb_typeof(e.value) <> 'string' or e.value #>> '{}' not in ('-','NA','SE')) then
        raise exception using errcode='P0001',message='Stored report settings could not be read';
      end if;
      foreach v_fuel in array array['hsfo','vlsfo','mgo'] loop
        v_old_key := lower(v_port.name) || '::' || v_fuel;
        v_new_key := lower(btrim(p_changes->>'name')) || '::' || v_fuel;
        -- Never replace a different destination override or inherit an orphan
        -- destination value that was not attached to this port.
        if v_fallbacks ? v_new_key and (not (v_fallbacks ? v_old_key)
          or v_fallbacks->v_new_key is distinct from v_fallbacks->v_old_key) then
          raise exception using errcode='P0002',message='Destination report setting conflicts';
        end if;
        if v_fallbacks ? v_old_key then
          v_fallbacks := jsonb_set(v_fallbacks,array[v_new_key],v_fallbacks->v_old_key,true) - v_old_key;
          v_fallbacks_changed := true;
        end if;
      end loop;
      if v_fallbacks_changed then update public.remarks set content=v_fallbacks::text where id=105; end if;
    end if;
    update public.ports set name = btrim(p_changes->>'name'),
      lat = (p_changes->>'lat')::numeric, lng = (p_changes->>'lng')::numeric,
      hsfo = (p_changes->>'hsfo')::numeric, vlsfo = (p_changes->>'vlsfo')::numeric, mgo = (p_changes->>'mgo')::numeric,
      hsfo_formula = nullif(btrim(p_changes->>'hsfo_formula'),''),
      vlsfo_formula = nullif(btrim(p_changes->>'vlsfo_formula'),''),
      mgo_formula = nullif(btrim(p_changes->>'mgo_formula'),''), updated_at = v_market_day
    where id = p_port_id;

    -- Renaming a basis port must not leave formulas pointing at its old name.
    if v_port.name <> btrim(p_changes->>'name') then
      foreach v_field in array array['hsfo_formula','vlsfo_formula','mgo_formula'] loop
        with matches as (
          select id, regexp_match(btrim(to_jsonb(p)->>v_field), '^(.*?)\s*([+-])\s*(-?[0-9]+(?:\.[0-9]+)?)$') as parts
          from public.ports p where coalesce(type,'port') <> 'divider'
        ), changed as (
          update public.ports p set
            hsfo_formula = case when v_field = 'hsfo_formula' then btrim(p_changes->>'name') || ' ' || m.parts[2] || ' ' || m.parts[3] else p.hsfo_formula end,
            vlsfo_formula = case when v_field = 'vlsfo_formula' then btrim(p_changes->>'name') || ' ' || m.parts[2] || ' ' || m.parts[3] else p.vlsfo_formula end,
            mgo_formula = case when v_field = 'mgo_formula' then btrim(p_changes->>'name') || ' ' || m.parts[2] || ' ' || m.parts[3] else p.mgo_formula end
          from matches m where p.id = m.id and lower(btrim(m.parts[1])) = lower(btrim(v_port.name)) returning p.id
        ) select v_renamed || coalesce(array_agg(id), array[]::uuid[]) into v_renamed from changed;
      end loop;
    end if;

    -- Validate the saved formula chains, including self/cyclic references,
    -- against this transaction's authoritative rows rather than browser data.
    foreach v_fuel in array array['hsfo','vlsfo','mgo'] loop
      select regexp_match(btrim(to_jsonb(p)->>(v_fuel || '_formula')), '^(.*?)\s*([+-])\s*(-?[0-9]+(?:\.[0-9]+)?)$')
        into v_match from public.ports p where id = p_port_id;
      if v_match is not null and (select count(*) from public.ports where coalesce(type,'port') <> 'divider'
        and lower(btrim(name)) = lower(btrim(v_match[1]))) <> 1 then
        raise exception using errcode = '22023', message = 'Formula reference is missing or ambiguous';
      end if;
      with recursive chain(id, next_name, path, cycle, formula) as (
        select p.id, lower(btrim((regexp_match(btrim(to_jsonb(p)->>(v_fuel || '_formula')), '^(.*?)\s*([+-])\s*(-?[0-9]+(?:\.[0-9]+)?)$'))[1])), array[p.id], false, to_jsonb(p)->>(v_fuel || '_formula')
        from public.ports p where p.id = p_port_id
        union all
        select p.id, lower(btrim((regexp_match(btrim(to_jsonb(p)->>(v_fuel || '_formula')), '^(.*?)\s*([+-])\s*(-?[0-9]+(?:\.[0-9]+)?)$'))[1])), c.path || p.id, p.id = any(c.path), to_jsonb(p)->>(v_fuel || '_formula')
        from chain c join public.ports p on lower(btrim(p.name)) = c.next_name
        where not c.cycle and coalesce(p.type,'port') <> 'divider'
      ) select coalesce(bool_or(cycle),false), coalesce(bool_or(nullif(btrim(formula),'') is not null
        and (next_name is null or (select count(*) from public.ports p where coalesce(p.type,'port') <> 'divider'
          and lower(btrim(p.name)) = c.next_name) <> 1)),false)
        into v_cycle, v_invalid_chain from chain c;
      if v_cycle then raise exception using errcode = '22023', message = 'Formula chain contains a loop'; end if;
      if v_invalid_chain then raise exception using errcode = '22023', message = 'Formula chain is missing or ambiguous'; end if;
    end loop;
  end if;

  with recursive affected(id, name) as (
    select id, name from public.ports where id = p_port_id
    union
    select p.id, p.name from public.ports p join affected a on exists (
      select 1 from unnest(array[p.hsfo_formula,p.vlsfo_formula,p.mgo_formula]) as formula
      where lower(btrim((regexp_match(btrim(formula), '^(.*?)\s*([+-])\s*(-?[0-9]+(?:\.[0-9]+)?)$'))[1])) = lower(btrim(a.name))
    ) where coalesce(p.type,'port') <> 'divider'
  ) select array_agg(id) || v_renamed into v_affected from affected;

  if not v_replay then
    update public.ports set updated_at = v_market_day where id = any(v_affected);
    select * into v_history from public.price_history where port_id = p_port_id
      and recorded_at >= v_market_day::timestamp and recorded_at < (v_market_day + 1)::timestamp
      order by recorded_at desc, id desc limit 1;
    if found then
      update public.price_history set hsfo = (p_changes->>'hsfo')::numeric,
        vlsfo = (p_changes->>'vlsfo')::numeric, mgo = (p_changes->>'mgo')::numeric, recorded_at = v_market_time
      where id = v_history.id returning * into v_history;
      delete from public.price_history where port_id = p_port_id and id <> v_history.id
        and recorded_at >= v_market_day::timestamp and recorded_at < (v_market_day + 1)::timestamp;
    else
      insert into public.price_history(port_id,hsfo,vlsfo,mgo,recorded_at) values
        (p_port_id,(p_changes->>'hsfo')::numeric,(p_changes->>'vlsfo')::numeric,(p_changes->>'mgo')::numeric,v_market_time)
      returning * into v_history;
    end if;
  end if;
  return jsonb_build_object('replayed',v_replay,'history',to_jsonb(v_history),
    'ports',(select jsonb_agg(to_jsonb(p) order by p.id) from public.ports p where id = any(v_affected)));
end;
$$;

revoke all on function public.save_price_setter_port(uuid,jsonb,jsonb,timestamptz) from public, anon, authenticated;
grant execute on function public.save_price_setter_port(uuid,jsonb,jsonb,timestamptz) to service_role;

-- Change one override only. Edits to different keys merge; a stale edit to the
-- same key conflicts. A malformed stored map is never replaced by an empty map.
create or replace function public.save_price_setter_fallback(p_key text, p_expected_value text, p_value text)
returns jsonb language plpgsql security invoker set search_path = '' set lock_timeout = '5s' as $$
declare
  v_content text;
  v_map jsonb;
  v_exists boolean;
  v_name text;
begin
  if p_key is null or length(p_key) > 260 or p_key <> lower(p_key) or p_key !~ '^.+::(hsfo|vlsfo|mgo)$'
    or p_value is null or p_value not in ('-','NA','SE')
    or p_expected_value is not null and p_expected_value not in ('-','NA','SE') then
    raise exception using errcode='22023',message='Invalid report setting';
  end if;
  v_name := regexp_replace(p_key,'::(hsfo|vlsfo|mgo)$','');
  lock table public.ports in share mode;
  lock table public.remarks in share row exclusive mode;
  if btrim(v_name) = '' or not exists(select 1 from public.ports where lower(name)=v_name and coalesce(type,'port') <> 'divider') then
    raise exception using errcode='22023',message='Port is not available';
  end if;
  select content into v_content from public.remarks where id=105;
  v_exists := found;
  begin
    v_map := case when v_content is null or v_content='' then '{}'::jsonb else v_content::jsonb end;
  exception when invalid_text_representation then
    raise exception using errcode='P0001',message='Stored report settings could not be read';
  end;
  if jsonb_typeof(v_map) is distinct from 'object' then
    raise exception using errcode='P0001',message='Stored report settings could not be read';
  end if;
  if exists(select 1 from jsonb_each(v_map) e where e.key <> lower(e.key) or length(e.key)>260
    or e.key !~ '^.+::(hsfo|vlsfo|mgo)$' or btrim(regexp_replace(e.key,'::(hsfo|vlsfo|mgo)$',''))=''
    or jsonb_typeof(e.value) <> 'string' or e.value #>> '{}' not in ('-','NA','SE')) then
    raise exception using errcode='P0001',message='Stored report settings could not be read';
  end if;
  if (v_map->>p_key) is distinct from p_expected_value then
    if (v_map->>p_key) = p_value then return jsonb_build_object('key',p_key,'fallbacks',v_map); end if;
    raise exception using errcode='P0002',message='Saved report setting changed';
  end if;
  v_map := jsonb_set(v_map,array[p_key],to_jsonb(p_value),true);
  if v_exists then update public.remarks set content=v_map::text where id=105;
  else insert into public.remarks(id,content) values(105,v_map::text); end if;
  return jsonb_build_object('key',p_key,'fallbacks',v_map);
end;
$$;

create or replace function public.rename_price_setter_divider(p_port_id uuid, p_expected_name text, p_name text)
returns jsonb language plpgsql security invoker set search_path = '' set lock_timeout = '5s' as $$
declare v_port public.ports%rowtype;
begin
  if p_port_id is null or p_expected_name is null or p_name is null or btrim(p_name)='' or length(p_name)>200 then
    raise exception using errcode='22023',message='Invalid divider name';
  end if;
  select * into v_port from public.ports where id=p_port_id for update;
  if not found or v_port.type is distinct from 'divider' then
    raise exception using errcode='P0002',message='Divider changed or was removed';
  end if;
  if v_port.name is distinct from p_expected_name then
    if v_port.name=btrim(p_name) then return jsonb_build_object('port',to_jsonb(v_port)); end if;
    raise exception using errcode='P0002',message='Saved divider name changed';
  end if;
  update public.ports set name=btrim(p_name) where id=p_port_id returning * into v_port;
  return jsonb_build_object('port',to_jsonb(v_port));
end;
$$;

revoke all on function public.save_price_setter_fallback(text,text,text) from public,anon,authenticated;
revoke all on function public.rename_price_setter_divider(uuid,text,text) from public,anon,authenticated;
grant execute on function public.save_price_setter_fallback(text,text,text) to service_role;
grant execute on function public.rename_price_setter_divider(uuid,text,text) to service_role;

-- All order positions commit together; a stale client cannot overwrite an
-- added/deleted/reordered list. Price/name edits do not invalidate ordering.
create or replace function public.reorder_price_setter_ports(p_expected jsonb, p_order uuid[])
returns jsonb language plpgsql security invoker set search_path='' set lock_timeout='5s' as $$
declare
  v_entry jsonb;
  v_current jsonb;
  v_desired jsonb;
  v_expected_ids uuid[];
begin
  if jsonb_typeof(p_expected) is distinct from 'array' or p_order is null then
    raise exception using errcode='22023',message='Invalid port order';
  end if;
  if jsonb_array_length(p_expected) < 1 or jsonb_array_length(p_expected)>1000
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
  update public.ports p set display_order=desired.position::integer
    from unnest(p_order) with ordinality as desired(id,position)
    where p.id=desired.id and p.display_order is distinct from desired.position::integer;
  return jsonb_build_object('order',v_desired,'replayed',false);
end;
$$;
revoke all on function public.reorder_price_setter_ports(jsonb,uuid[]) from public,anon,authenticated;
grant execute on function public.reorder_price_setter_ports(jsonb,uuid[]) to service_role;
