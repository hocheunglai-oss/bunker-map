-- Required-root identity is case/outer-space insensitive. Keep exact saved names
-- in the CAS baseline and never rewrite business display names during history edits.
-- This replaces only lookup/product scope; lock order, replay and grants stay unchanged.
-- Apply one Hong Kong day or the two-port Taiwan day as one transaction.
-- No network calls, new tables or timestamp rewrites outside the selected day.
-- Match the Price Setter lock order: ports -> price_history. Reads stay available.
create or replace function public.change_market_price_history(
  p_market text, p_day date, p_operation text,
  p_expected_ports jsonb, p_expected_rows jsonb, p_values jsonb
) returns jsonb
language plpgsql security invoker set search_path = ''
set lock_timeout = '5s' set statement_timeout = '15s'
as $$
declare
  v_names text[];
  v_ids uuid[];
  v_port public.ports%rowtype;
  v_latest public.price_history%rowtype;
  v_existing public.price_history%rowtype;
  v_current_ports jsonb;
  v_current_rows jsonb;
  v_expected_ports jsonb;
  v_expected_rows jsonb;
  v_desired jsonb;
  v_value jsonb;
  v_item jsonb;
  v_key text;
  v_replay boolean := false;
  v_port_fields text[] := array['id','name','lat','lng','hsfo','vlsfo','mgo','hsfo_formula','vlsfo_formula','mgo_formula','updated_at'];
begin
  if p_market is null or p_market not in ('hongkong','taiwan') or p_day is null or not isfinite(p_day)
    or p_day < date '1900-01-01' or p_day > date '9999-12-30'
    or p_operation is null or p_operation not in ('save','delete')
    or jsonb_typeof(p_expected_ports) is distinct from 'array'
    or jsonb_typeof(p_expected_rows) is distinct from 'array'
    or jsonb_typeof(p_values) is distinct from 'array' then
    raise exception using errcode='22023',message='Invalid history change';
  end if;
  v_names := case when p_market='hongkong' then array['Hong Kong'] else array['Kaohsiung','Taichung'] end;
  if jsonb_array_length(p_expected_ports) <> cardinality(v_names)
    or jsonb_array_length(p_expected_rows) > 200
    or (p_operation='save' and jsonb_array_length(p_values) <> cardinality(v_names))
    or (p_operation='delete' and (p_values <> '[]'::jsonb or p_expected_rows='[]'::jsonb)) then
    raise exception using errcode='22023',message='Incomplete history change';
  end if;
  foreach v_item in array array(select value from jsonb_array_elements(p_expected_ports)) loop
    if jsonb_typeof(v_item) is distinct from 'object' or not (v_item ?& v_port_fields)
      or (v_item-v_port_fields) <> '{}'::jsonb then
      raise exception using errcode='22023',message='Invalid saved port';
    end if;
  end loop;
  foreach v_item in array array(select value from jsonb_array_elements(p_expected_rows)) loop
    if jsonb_typeof(v_item) is distinct from 'object'
      or not (v_item ?& array['id','port_id','hsfo','vlsfo','mgo','recorded_at'])
      or (v_item-array['id','port_id','hsfo','vlsfo','mgo','recorded_at']) <> '{}'::jsonb then
      raise exception using errcode='22023',message='Invalid saved history';
    end if;
  end loop;

  lock table public.ports in share row exclusive mode;
  lock table public.price_history in share row exclusive mode;
  select array_agg(id order by id) into v_ids from public.ports
    where lower(btrim(name)) in (select lower(n) from unnest(v_names) n) and coalesce(type,'port') <> 'divider';
  if coalesce(cardinality(v_ids),0) <> cardinality(v_names)
    or exists(select 1 from unnest(v_names) n where (select count(*) from public.ports p
      where lower(btrim(p.name))=lower(n) and coalesce(p.type,'port') <> 'divider') <> 1) then
    raise exception using errcode='P0002',message='Market ports changed';
  end if;
  select jsonb_agg((select jsonb_object_agg(k,to_jsonb(p)->k) from unnest(v_port_fields) k) order by p.id)
    into v_current_ports from public.ports p where id=any(v_ids);
  select jsonb_agg(value order by value->>'id') into v_expected_ports from jsonb_array_elements(p_expected_ports);
  if (select count(distinct value->>'id') from jsonb_array_elements(p_expected_ports)) <> cardinality(v_names)
    or exists(select 1 from jsonb_array_elements(p_expected_ports) e where not (e->>'id')::uuid=any(v_ids)) then
    raise exception using errcode='22023',message='Incorrect market ports';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',h.id,'port_id',h.port_id,'hsfo',h.hsfo,'vlsfo',h.vlsfo,'mgo',h.mgo,'recorded_at',h.recorded_at) order by h.id),'[]'::jsonb)
    into v_current_rows from public.price_history h where h.port_id=any(v_ids)
      and recorded_at >= p_day::timestamp and recorded_at < (p_day+1)::timestamp;
  select coalesce(jsonb_agg(value order by value->>'id'),'[]'::jsonb) into v_expected_rows from jsonb_array_elements(p_expected_rows);
  if (select count(distinct value->>'id') from jsonb_array_elements(p_expected_rows)) <> jsonb_array_length(p_expected_rows)
    or exists(select 1 from jsonb_array_elements(p_expected_rows) e where not (e->>'port_id')::uuid=any(v_ids)
      or (e->>'recorded_at')::timestamp < p_day::timestamp or (e->>'recorded_at')::timestamp >= (p_day+1)::timestamp) then
    raise exception using errcode='22023',message='Incorrect history scope';
  end if;
  if p_operation='save' then
    foreach v_item in array array(select value from jsonb_array_elements(p_values)) loop
      if jsonb_typeof(v_item) is distinct from 'object' or not (v_item ?& array['port_id','hsfo','vlsfo','mgo'])
        or (v_item-array['port_id','hsfo','vlsfo','mgo']) <> '{}'::jsonb
        or not (v_item->>'port_id')::uuid=any(v_ids) then
        raise exception using errcode='22023',message='Invalid history values';
      end if;
      foreach v_key in array array['hsfo','vlsfo','mgo'] loop
        if jsonb_typeof(v_item->v_key) not in ('number','null') or (v_item->>v_key)::numeric < 0 then
          raise exception using errcode='22023',message='Invalid price';
        end if;
      end loop;
    end loop;
    if (select count(distinct value->>'port_id') from jsonb_array_elements(p_values)) <> cardinality(v_names)
      or p_market='taiwan' and exists(select 1 from jsonb_array_elements(p_values) e join public.ports p on p.id=(e->>'port_id')::uuid
        where lower(btrim(p.name))='taichung' and e->'hsfo' <> 'null'::jsonb) then
      raise exception using errcode='22023',message='Incorrect product scope';
    end if;
    select jsonb_agg(value order by value->>'port_id') into v_desired from jsonb_array_elements(p_values);
    select coalesce(jsonb_agg(value-array['id','recorded_at'] order by value->>'port_id'),'[]'::jsonb)
      into v_value from jsonb_array_elements(v_current_rows);
    -- Reconciliation is a strictly read-only no-op. Never repair/overwrite newer
    -- current prices on a lost-response replay. The UI receives current roots.
    v_replay := v_value=v_desired and not exists(select 1 from jsonb_array_elements(v_current_rows) e
      where (e->>'recorded_at')::timestamp <> p_day::timestamp + interval '12 hours');
  else
    v_replay := v_current_rows='[]'::jsonb;
  end if;
  if not v_replay then
    if v_current_ports <> v_expected_ports or v_current_rows <> v_expected_rows then
      raise exception using errcode='P0002',message='Saved history or prices changed';
    end if;
    if p_operation='delete' then
      delete from public.price_history where port_id=any(v_ids)
        and recorded_at >= p_day::timestamp and recorded_at < (p_day+1)::timestamp;
    else
      foreach v_item in array array(select value from jsonb_array_elements(p_values)) loop
        select * into v_existing from public.price_history where port_id=(v_item->>'port_id')::uuid
          and recorded_at >= p_day::timestamp and recorded_at < (p_day+1)::timestamp
          order by recorded_at desc,id desc limit 1;
        if found then
          update public.price_history set hsfo=(v_item->>'hsfo')::numeric,vlsfo=(v_item->>'vlsfo')::numeric,
            mgo=(v_item->>'mgo')::numeric,recorded_at=p_day::timestamp+interval '12 hours' where id=v_existing.id;
          delete from public.price_history where port_id=(v_item->>'port_id')::uuid and id<>v_existing.id
            and recorded_at >= p_day::timestamp and recorded_at < (p_day+1)::timestamp;
        else
          insert into public.price_history(port_id,hsfo,vlsfo,mgo,recorded_at) values
            ((v_item->>'port_id')::uuid,(v_item->>'hsfo')::numeric,(v_item->>'vlsfo')::numeric,
            (v_item->>'mgo')::numeric,p_day::timestamp+interval '12 hours');
        end if;
      end loop;
    end if;
    for v_port in select * from public.ports where id=any(v_ids) order by id loop
      select * into v_latest from public.price_history where port_id=v_port.id order by recorded_at desc,id desc limit 1;
      -- Deleting the final record clears unsupported live prices instead of
      -- silently leaving the deleted record's prices displayed as current.
      update public.ports set hsfo=v_latest.hsfo,vlsfo=v_latest.vlsfo,mgo=v_latest.mgo,updated_at=v_latest.recorded_at::date
        where id=v_port.id and (hsfo,vlsfo,mgo,updated_at) is distinct from
          (v_latest.hsfo,v_latest.vlsfo,v_latest.mgo,v_latest.recorded_at::date);
    end loop;
    with recursive affected(root,id,name) as (
      select id,id,name from public.ports where id=any(v_ids)
      union
      select a.root,p.id,p.name from affected a join public.ports p on exists(
        select 1 from unnest(array[p.hsfo_formula,p.vlsfo_formula,p.mgo_formula]) formula
        where lower(btrim((regexp_match(btrim(formula),'^(.*?)\s*([+-])\s*(-?[0-9]+(?:\.[0-9]+)?)$'))[1]))=lower(btrim(a.name))
      ) where coalesce(p.type,'port') <> 'divider'
    ), dates as (
      select a.id,max(root.updated_at) as day from affected a join public.ports root on root.id=a.root group by a.id
    ) update public.ports p set updated_at=d.day from dates d where p.id=d.id
      and not p.id=any(v_ids) and p.updated_at is distinct from d.day;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',h.id,'port_id',h.port_id,'hsfo',h.hsfo,'vlsfo',h.vlsfo,'mgo',h.mgo,'recorded_at',h.recorded_at) order by h.id),'[]'::jsonb)
    into v_current_rows from public.price_history h where h.port_id=any(v_ids)
      and recorded_at >= p_day::timestamp and recorded_at < (p_day+1)::timestamp;
  return jsonb_build_object('market',p_market,'day',p_day,'operation',p_operation,'replayed',v_replay,'rows',v_current_rows,
    'ports',(select jsonb_agg((select jsonb_object_agg(k,to_jsonb(p)->k) from unnest(v_port_fields) k) order by p.id) from public.ports p where id=any(v_ids)));
end;
$$;
revoke all on function public.change_market_price_history(text,date,text,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.change_market_price_history(text,date,text,jsonb,jsonb,jsonb) to service_role;
