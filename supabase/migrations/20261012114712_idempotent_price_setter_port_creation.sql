-- Durable retry receipts deliberately have no ports FK: deleting a port must
-- not delete its receipt and allow a delayed retry to recreate it. Include this
-- table in every backup contract; recovery must preserve the whole database.
create table public.price_setter_creation_receipts (
  request_id uuid primary key,
  port_id uuid not null unique,
  kind text not null check (kind in ('port','divider')),
  created_at timestamptz not null default clock_timestamp()
);
alter table public.price_setter_creation_receipts enable row level security;
revoke all on public.price_setter_creation_receipts from public, anon, authenticated, service_role;
grant select, insert on public.price_setter_creation_receipts to service_role;
create trigger bunker_map_backup_epoch_fence
after insert or update or delete or truncate on public.price_setter_creation_receipts
for each statement execute function private.record_bunker_map_backup_mutation();

create function public.create_price_setter_port(p_request_id uuid, p_kind text)
returns jsonb language plpgsql volatile security invoker
set search_path = '' set lock_timeout = '5s' set statement_timeout = '15s'
as $$
declare
  v_receipt public.price_setter_creation_receipts%rowtype;
  v_port public.ports%rowtype;
  v_id uuid;
  v_name text;
  v_suffix bigint := 1;
  v_order bigint;
  v_count integer;
begin
  if p_request_id is null or p_kind is null or p_kind not in ('port','divider') then
    raise exception using errcode='22023',message='Invalid port creation';
  end if;
  -- Same first lock as saves, reorder and deletion. Serialize allocation with
  -- all ports writers, including old service-side inserts/updates/deletes.
  lock table public.ports in share row exclusive mode;
  select * into v_receipt from public.price_setter_creation_receipts where request_id=p_request_id;
  if found then
    if v_receipt.kind<>p_kind then
      raise exception using errcode='P0002',message='CREATION_KIND_CHANGED';
    end if;
    select * into v_port from public.ports where id=v_receipt.port_id;
    return jsonb_build_object('requestId',p_request_id,'portId',v_receipt.port_id,
      'kind',p_kind,'replayed',true,'port',case when found then to_jsonb(v_port) else null end);
  end if;

  select greatest(coalesce(max(display_order),0),0)::bigint+1 into v_order from public.ports;
  if v_order>2147483647 then
    raise exception using errcode='P0002',message='CREATION_ORDER_FULL';
  end if;
  v_name := case when p_kind='divider' then 'Section' else 'New Port' end;
  if p_kind='port' then
    while exists(select 1 from public.ports where coalesce(type,'port')<>'divider' and lower(btrim(name))=lower(v_name)) loop
      v_suffix := v_suffix+1;
      v_name := 'New Port '||v_suffix::text;
    end loop;
  end if;
  v_id := gen_random_uuid();
  insert into public.ports(id,name,type,display_order,lat,lng,hsfo,vlsfo,mgo,hsfo_formula,vlsfo_formula,mgo_formula,updated_at)
    values(v_id,v_name,p_kind,v_order::integer,null,null,null,null,null,null,null,null,null);
  get diagnostics v_count=row_count;
  if v_count<>1 then raise exception 'Port creation unconfirmed'; end if;
  select * into v_port from public.ports where id=v_id;
  if not found or v_port.name is distinct from v_name or v_port.type is distinct from p_kind
    or v_port.display_order is distinct from v_order::integer
    or v_port.lat is not null or v_port.lng is not null or v_port.hsfo is not null
    or v_port.vlsfo is not null or v_port.mgo is not null or v_port.hsfo_formula is not null
    or v_port.vlsfo_formula is not null or v_port.mgo_formula is not null or v_port.updated_at is not null then
    raise exception 'Port creation unconfirmed';
  end if;
  insert into public.price_setter_creation_receipts(request_id,port_id,kind) values(p_request_id,v_id,p_kind);
  get diagnostics v_count=row_count;
  select * into v_receipt from public.price_setter_creation_receipts where request_id=p_request_id;
  if v_count<>1 or not found or v_receipt.port_id is distinct from v_id or v_receipt.kind is distinct from p_kind then
    raise exception 'Creation receipt unconfirmed';
  end if;
  -- A receipt trigger must not silently remove/change the newly created row.
  if not exists(select 1 from public.ports p where p.id=v_id and to_jsonb(p)=to_jsonb(v_port)) then
    raise exception 'Port creation unconfirmed';
  end if;
  return jsonb_build_object('requestId',p_request_id,'portId',v_id,'kind',p_kind,'replayed',false,'port',to_jsonb(v_port));
end;
$$;
revoke all on function public.create_price_setter_port(uuid,text) from public, anon, authenticated;
grant execute on function public.create_price_setter_port(uuid,text) to service_role;
