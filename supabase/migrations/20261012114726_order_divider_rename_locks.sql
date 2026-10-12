-- Reorder/save/delete lock the ports table before touching individual rows.
-- Divider rename must use the same order: a row-first rename can deadlock with
-- a reorder that already holds the table lock and then needs that divider row.
-- Keep validation, conflict/replay behavior, privileges and timeout unchanged.
create or replace function public.rename_price_setter_divider(p_port_id uuid, p_expected_name text, p_name text)
returns jsonb language plpgsql security invoker set search_path = '' set lock_timeout = '5s' as $$
declare v_port public.ports%rowtype;
begin
  if p_port_id is null or p_expected_name is null or p_name is null or btrim(p_name)='' or length(p_name)>200 then
    raise exception using errcode='22023',message='Invalid divider name';
  end if;
  lock table public.ports in share row exclusive mode;
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

revoke all on function public.rename_price_setter_divider(uuid,text,text) from public,anon,authenticated;
grant execute on function public.rename_price_setter_divider(uuid,text,text) to service_role;
