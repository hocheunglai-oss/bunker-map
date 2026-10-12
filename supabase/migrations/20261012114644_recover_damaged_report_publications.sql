-- Additive repair support; keep the original published migration immutable.
-- No schema/data changes. Lock order, source/publication CAS and rollback remain.
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
  current_payload jsonb;
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
  -- Damaged JSON is replaceable only against the exact reviewed raw content.
  -- Invalid JSON must not abort before the publication-version CAS below.
  begin
    current_payload := current_content::jsonb;
  exception when invalid_text_representation then
    current_payload := null;
  end;
  if current_content is not null and current_payload = p_payload then
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

revoke all on function public.publish_report_snapshot(text,text[],jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.publish_report_snapshot(text,text[],jsonb,jsonb) to service_role;
