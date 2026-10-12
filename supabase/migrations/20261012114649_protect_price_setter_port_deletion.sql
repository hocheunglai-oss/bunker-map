-- Delete only an unused, exactly reviewed row. Never cascade away price history
-- or break mandatory report roots/formula references. Existing migrations stay
-- immutable. No new tables or backup-inventory entries are introduced.
create or replace function public.delete_price_setter_port(
  p_port_id uuid, p_expected jsonb, p_expected_fallbacks jsonb
)
returns jsonb language plpgsql volatile security invoker
set search_path = '' set lock_timeout = '5s' set statement_timeout = '15s'
as $$
declare
  v_port public.ports%rowtype;
  v_fields text[] := array['name','lat','lng','hsfo','vlsfo','mgo','hsfo_formula','vlsfo_formula','mgo_formula','updated_at','type','display_order'];
  v_snapshot jsonb;
  v_content text;
  v_map jsonb;
  v_expected_map jsonb := '{}'::jsonb;
  v_new_map jsonb;
  v_name text;
  v_key text;
  v_fuel text;
  v_count integer;
begin
  if p_port_id is null or jsonb_typeof(p_expected) is distinct from 'object'
    or jsonb_typeof(p_expected_fallbacks) is distinct from 'object' then
    raise exception using errcode='22023',message='Invalid port deletion';
  end if;
  if (select count(*) from jsonb_object_keys(p_expected)) <> cardinality(v_fields)
    or not p_expected ?& v_fields
    or jsonb_typeof(p_expected->'name') is distinct from 'string'
    or length(p_expected->>'name') not between 1 and 200 then
    raise exception using errcode='22023',message='Invalid deletion baseline';
  end if;
  v_name := lower(p_expected->>'name');
  if exists(select 1 from jsonb_each(p_expected_fallbacks) e
    where e.key <> all(array[v_name||'::hsfo',v_name||'::vlsfo',v_name||'::mgo'])
      or jsonb_typeof(e.value) <> 'string' or e.value #>> '{}' not in ('-','NA','SE')) then
    raise exception using errcode='22023',message='Invalid deletion settings';
  end if;

  -- Match the ordering used by all pricing/history/publication writers. These
  -- locks also exclude new dependent formulas/history/settings during checks.
  lock table public.ports in share row exclusive mode;
  lock table public.price_history in share row exclusive mode;
  lock table public.remarks in share row exclusive mode;
  select * into v_port from public.ports where id=p_port_id;
  if not found then
    -- Repeating a confirmed/lost-reply deletion is read-only. Do not remove any
    -- settings for a name which may since have been reused by another port.
    return jsonb_build_object('deletedId',p_port_id,'replayed',true);
  end if;
  select jsonb_object_agg(e.key,e.value) into v_snapshot
    from jsonb_each(to_jsonb(v_port)) e where e.key=any(v_fields);
  if v_snapshot is distinct from p_expected then
    raise exception using errcode='P0002',message='Saved port changed';
  end if;

  if coalesce(v_port.type,'port') <> 'divider' then
    -- These reports require every root, including Taiwan's implicit Taichung
    -- basis for Keelung/Suao/Hualien even when no formula is saved on those rows.
    if lower(btrim(v_port.name)) = any(array['hong kong','kaohsiung','keelung','taichung','suao','hualien']) then
      raise exception using errcode='23503',message='PORT_REQUIRED';
    end if;
    if exists(select 1 from public.ports p where p.id<>p_port_id
      and coalesce(p.type,'port')<>'divider' and lower(btrim(p.name))=lower(btrim(v_port.name))) then
      raise exception using errcode='23503',message='PORT_NAME';
    end if;
    if exists(select 1 from public.ports p
      cross join lateral unnest(array[p.hsfo_formula,p.vlsfo_formula,p.mgo_formula]) f(formula)
      where p.id<>p_port_id and coalesce(p.type,'port')<>'divider' and nullif(btrim(f.formula),'') is not null
      and (regexp_match(btrim(f.formula),'^(.*?)\s*([+-])\s*(-?[0-9]+(?:\.[0-9]+)?)$')) is null) then
      raise exception using errcode='23503',message='PORT_FORMULA_INVALID';
    end if;
    if exists(select 1 from public.ports p
      cross join lateral unnest(array[p.hsfo_formula,p.vlsfo_formula,p.mgo_formula]) f(formula)
      where p.id<>p_port_id and coalesce(p.type,'port')<>'divider'
      and lower(btrim((regexp_match(btrim(f.formula),'^(.*?)\s*([+-])\s*(-?[0-9]+(?:\.[0-9]+)?)$'))[1]))=lower(btrim(v_port.name))) then
      raise exception using errcode='23503',message='PORT_FORMULA';
    end if;
  end if;
  if exists(select 1 from public.price_history where port_id=p_port_id) then
    raise exception using errcode='23503',message='PORT_HISTORY';
  end if;

  select content into v_content from public.remarks where id=105;
  begin
    v_map := case when v_content is null or v_content='' then '{}'::jsonb else v_content::jsonb end;
  exception when invalid_text_representation then
    raise exception using errcode='P0001',message='Stored settings unreadable';
  end;
  if jsonb_typeof(v_map) is distinct from 'object' then
    raise exception using errcode='P0001',message='Stored settings unreadable';
  end if;
  if exists(select 1 from jsonb_each(v_map) e where e.key<>lower(e.key) or length(e.key)>260
    or e.key !~ '^.+::(hsfo|vlsfo|mgo)$' or btrim(regexp_replace(e.key,'::(hsfo|vlsfo|mgo)$',''))=''
    or jsonb_typeof(e.value)<>'string' or e.value #>> '{}' not in ('-','NA','SE')) then
    raise exception using errcode='P0001',message='Stored settings unreadable';
  end if;
  v_new_map := v_map;
  if coalesce(v_port.type,'port') <> 'divider' then
    foreach v_fuel in array array['hsfo','vlsfo','mgo'] loop
      v_key := v_name||'::'||v_fuel;
      if v_map ? v_key then v_expected_map := jsonb_set(v_expected_map,array[v_key],v_map->v_key,true); end if;
      v_new_map := v_new_map-v_key;
    end loop;
  end if;
  if v_expected_map is distinct from p_expected_fallbacks then
    raise exception using errcode='P0002',message='Port settings changed';
  end if;
  if v_new_map is distinct from v_map then
    update public.remarks set content=v_new_map::text where id=105;
    select content into v_content from public.remarks where id=105;
    if v_content::jsonb is distinct from v_new_map then raise exception 'Settings cleanup unconfirmed'; end if;
  end if;
  delete from public.ports where id=p_port_id;
  get diagnostics v_count = row_count;
  if v_count<>1 or exists(select 1 from public.ports where id=p_port_id) then
    raise exception 'Deletion unconfirmed';
  end if;
  return jsonb_build_object('deletedId',p_port_id,'replayed',false);
end;
$$;

revoke all on function public.delete_price_setter_port(uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.delete_price_setter_port(uuid,jsonb,jsonb) to service_role;
