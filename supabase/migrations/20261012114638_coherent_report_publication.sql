-- Additive backend only. The UI and old-writer fence must be migrated together
-- before this is treated as the production publication path.
create or replace function public.read_report_publication_source(p_report text, p_port_names text[])
returns jsonb
language sql stable security invoker
set search_path = ''
set statement_timeout = '15s'
as $$
  with recursive selected(id,fuel) as (
    select p.id, f.fuel from public.ports p
    cross join (values ('hsfo'),('vlsfo'),('mgo')) f(fuel)
    where lower(btrim(p.name)) = any(p_port_names)
      and not (p_report = 'taiwan' and lower(btrim(p.name)) <> 'kaohsiung' and f.fuel = 'hsfo')
    union
    select dependency.id, s.fuel
    from selected s join public.ports p on p.id = s.id
    cross join lateral (values
      (case s.fuel when 'hsfo' then p.hsfo_formula when 'vlsfo' then p.vlsfo_formula when 'mgo' then p.mgo_formula end),
      (case when p_report = 'taiwan' and lower(btrim(p.name)) in ('keelung','suao','hualien') and s.fuel <> 'hsfo'
        and nullif(btrim(case s.fuel when 'vlsfo' then p.vlsfo_formula when 'mgo' then p.mgo_formula end),'') is null
        then 'Taichung + 0' end)
    ) formulas(formula)
    join public.ports dependency on lower(btrim(dependency.name)) = lower(btrim(
      (regexp_match(btrim(formulas.formula), '^(.*?)\s*([+-])\s*(-?\d+(?:\.\d+)?)$'))[1]))
    where p_report <> 'hongkong'
  ), selected_ports as (
    select p.id, p.name, p.type, p.hsfo, p.vlsfo, p.mgo,
      p.hsfo_formula, p.vlsfo_formula, p.mgo_formula, p.updated_at
    from public.ports p where p.id in (select s.id from selected s) order by p.id limit 2001
  ), daily as (
    select distinct on (h.port_id, h.recorded_at::date)
      h.id, h.port_id, h.hsfo, h.vlsfo, h.mgo, h.recorded_at
    from public.price_history h join selected_ports p on p.id = h.port_id
    where p_report in ('hongkong','taiwan')
    order by h.port_id, h.recorded_at::date desc, h.recorded_at desc, h.id desc
  ), ranked as (
    select d.*, row_number() over (partition by d.port_id order by d.recorded_at desc, d.id desc) as position
    from daily d
  ), history as (
    select id, port_id, hsfo, vlsfo, mgo, recorded_at from ranked where position <= 3
  ), notices as (
    select r.id, r.content from public.remarks r
    where p_report = 'taiwan' and r.id in (1,2) order by r.id
  ), publication as (
    select r.id, r.content from public.remarks r
    where r.id = case p_report when 'taiwan' then 101 when 'hongkong' then 102 when 'china' then 103 when 'compact' then 104 end
  )
  select jsonb_build_object(
    'report', p_report,
    'ports', coalesce((select jsonb_agg(to_jsonb(p) order by p.id) from selected_ports p), '[]'::jsonb),
    'history', coalesce((select jsonb_agg(to_jsonb(h) order by h.port_id, h.recorded_at desc, h.id desc) from history h), '[]'::jsonb),
    'notices', coalesce((select jsonb_agg(to_jsonb(n) order by n.id) from notices n), '[]'::jsonb),
    'publication', (select to_jsonb(r) from publication r)
  );
$$;

create or replace function public.publish_report_snapshot(
  p_report text, p_port_names text[], p_expected_source jsonb, p_payload jsonb
)
returns jsonb
language plpgsql volatile security invoker
set search_path = ''
set lock_timeout = '5s'
set statement_timeout = '15s'
as $$
declare
  snapshot_id integer;
  current_source jsonb;
  current_content text;
  saved_content text;
  replayed boolean := false;
begin
  snapshot_id := case p_report when 'taiwan' then 101 when 'hongkong' then 102 when 'china' then 103 when 'compact' then 104 end;
  if snapshot_id is null or p_port_names is null or cardinality(p_port_names) not between 1 and 200
    or exists(select 1 from unnest(p_port_names) n where n is null or n = '' or n <> lower(btrim(n)) or length(n) > 200)
    or jsonb_typeof(p_expected_source) is distinct from 'object'
    or p_expected_source ->> 'report' is distinct from p_report
    or jsonb_typeof(p_payload) is distinct from 'object'
    or jsonb_typeof(p_payload -> 'reportDate') is distinct from 'string'
    or length(p_payload ->> 'reportDate') not between 1 and 80
    or octet_length(p_payload::text) > 1048576 then
    raise exception using errcode = '22023', message = 'Invalid report publication';
  end if;

  -- The same order as pricing/history writers, including absent snapshot rows.
  -- No network calls or report calculation run while these locks are held.
  lock table public.ports in share row exclusive mode;
  lock table public.price_history in share row exclusive mode;
  lock table public.remarks in share row exclusive mode;
  current_source := public.read_report_publication_source(p_report, p_port_names);
  if (current_source - 'publication') is distinct from (p_expected_source - 'publication') then
    raise exception using errcode = 'P0002', message = 'Report source changed';
  end if;
  current_content := current_source -> 'publication' ->> 'content';
  -- Exact saved payload confirmation is read-only, including after a lost reply.
  if current_content is not null and current_content::jsonb = p_payload then
    replayed := true;
    saved_content := current_content;
  else
    if current_source -> 'publication' is distinct from p_expected_source -> 'publication' then
      raise exception using errcode = 'P0002', message = 'Report publication changed';
    end if;
    insert into public.remarks(id,content) values(snapshot_id,p_payload::text)
      on conflict(id) do update set content = excluded.content
      returning content into saved_content;
  end if;
  return jsonb_build_object('report',p_report,'payload',saved_content::jsonb,'content',saved_content,'replayed',replayed);
end;
$$;

revoke all on function public.read_report_publication_source(text,text[]) from public, anon, authenticated;
revoke all on function public.publish_report_snapshot(text,text[],jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.read_report_publication_source(text,text[]) to service_role;
grant execute on function public.publish_report_snapshot(text,text[],jsonb,jsonb) to service_role;
