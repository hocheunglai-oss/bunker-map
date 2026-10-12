-- Additive recovery stage. Legacy receipts remain unowned; do not guess which
-- administrator created one, expire it, or attach it by a supplied request ID.
-- Switch the page/API to the owned functions, then revoke the legacy allocator
-- in a subsequent migration before releasing the complete recovery workflow.
alter table public.price_setter_creation_receipts
  add column actor_id uuid,
  add column acknowledged_at timestamptz,
  add constraint price_setter_receipt_acknowledgement check (
    acknowledged_at is null or (actor_id is not null and acknowledged_at >= created_at)
  );
create unique index price_setter_one_pending_creation_per_actor
  on public.price_setter_creation_receipts(actor_id)
  where actor_id is not null and acknowledged_at is null;
create index price_setter_creation_actor_history
  on public.price_setter_creation_receipts(actor_id) where actor_id is not null;
-- No actor/port FK: deletion must never erase retry or retirement evidence.
-- Browser roles still have no table privileges. The service may acknowledge,
-- but cannot rewrite identities, kinds or timestamps, nor delete receipts.
grant update(acknowledged_at) on public.price_setter_creation_receipts to service_role;

create function public.read_price_setter_creation_state(p_actor_id uuid)
returns jsonb language plpgsql stable security invoker
set search_path = '' set statement_timeout = '15s'
as $$
declare v_result jsonb;
begin
  if p_actor_id is null then raise exception using errcode='22023',message='Invalid creation actor'; end if;
  -- One statement/snapshot: the revision and pending request cannot come from
  -- different committed states. Retained receipt count is a monotonic revision,
  -- represented as text so browsers never round a bigint.
  select jsonb_build_object('actorId',p_actor_id,'version',count(*)::text,
    'pending',coalesce(jsonb_agg(jsonb_build_object('requestId',request_id,'kind',kind))
      filter(where acknowledged_at is null)->0,'null'::jsonb))
    into v_result from public.price_setter_creation_receipts where actor_id=p_actor_id;
  return v_result;
end;
$$;

create function public.create_owned_price_setter_port(
  p_actor_id uuid, p_request_id uuid, p_kind text, p_expected_version bigint
)
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
  v_version bigint;
  v_count integer;
begin
  if p_actor_id is null or p_request_id is null or p_kind is null or p_kind not in ('port','divider')
    or p_expected_version is null or p_expected_version < 0 then
    raise exception using errcode='22023',message='Invalid owned port creation';
  end if;
  -- Use the same first lock as every other price writer. Ownership, pending
  -- state, revision comparison and allocation are one serialized transaction.
  lock table public.ports in share row exclusive mode;
  select * into v_receipt from public.price_setter_creation_receipts where request_id=p_request_id;
  if found then
    if v_receipt.actor_id is distinct from p_actor_id then
      raise exception using errcode='P0002',message='CREATION_OWNER_MISMATCH';
    end if;
    if v_receipt.kind<>p_kind then
      raise exception using errcode='P0002',message='CREATION_KIND_CHANGED';
    end if;
    select * into v_port from public.ports where id=v_receipt.port_id;
    return jsonb_build_object('requestId',p_request_id,'portId',v_receipt.port_id,
      'kind',p_kind,'replayed',true,'port',case when found then to_jsonb(v_port) else null end);
  end if;
  if exists(select 1 from public.price_setter_creation_receipts where actor_id=p_actor_id and acknowledged_at is null) then
    raise exception using errcode='P0002',message='CREATION_PENDING';
  end if;
  select count(*) into v_version from public.price_setter_creation_receipts where actor_id=p_actor_id;
  if v_version<>p_expected_version then
    raise exception using errcode='P0002',message='CREATION_VERSION_CHANGED';
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
  insert into public.price_setter_creation_receipts(request_id,port_id,kind,actor_id)
    values(p_request_id,v_id,p_kind,p_actor_id);
  get diagnostics v_count=row_count;
  select * into v_receipt from public.price_setter_creation_receipts where request_id=p_request_id;
  if v_count<>1 or not found or v_receipt.port_id is distinct from v_id or v_receipt.kind is distinct from p_kind
    or v_receipt.actor_id is distinct from p_actor_id or v_receipt.acknowledged_at is not null
    or not exists(select 1 from public.ports p where p.id=v_id and to_jsonb(p)=to_jsonb(v_port))
    or (select count(*) from public.price_setter_creation_receipts where actor_id=p_actor_id)<>v_version+1 then
    raise exception 'Owned creation receipt unconfirmed';
  end if;
  return jsonb_build_object('requestId',p_request_id,'portId',v_id,'kind',p_kind,'replayed',false,'port',to_jsonb(v_port));
end;
$$;

create function public.acknowledge_price_setter_creation(p_actor_id uuid,p_request_id uuid)
returns jsonb language plpgsql volatile security invoker
set search_path = '' set lock_timeout = '5s' set statement_timeout = '15s'
as $$
declare
  v_before public.price_setter_creation_receipts%rowtype;
  v_after public.price_setter_creation_receipts%rowtype;
  v_time timestamptz;
  v_version bigint;
  v_count integer;
begin
  if p_actor_id is null or p_request_id is null then
    raise exception using errcode='22023',message='Invalid creation acknowledgement';
  end if;
  lock table public.ports in share row exclusive mode;
  select * into v_before from public.price_setter_creation_receipts where request_id=p_request_id;
  if not found or v_before.actor_id is distinct from p_actor_id then
    raise exception using errcode='P0002',message='CREATION_OWNER_MISMATCH';
  end if;
  if v_before.acknowledged_at is null then
    select count(*) into v_version from public.price_setter_creation_receipts where actor_id=p_actor_id;
    v_time := greatest(clock_timestamp(),v_before.created_at);
    update public.price_setter_creation_receipts set acknowledged_at=v_time where request_id=p_request_id;
    get diagnostics v_count=row_count;
    select * into v_after from public.price_setter_creation_receipts where request_id=p_request_id;
    if v_count<>1 or not found or v_after.acknowledged_at is distinct from v_time
      or (to_jsonb(v_after)-'acknowledged_at') is distinct from (to_jsonb(v_before)-'acknowledged_at')
      or (select count(*) from public.price_setter_creation_receipts where actor_id=p_actor_id)<>v_version then
      raise exception 'Creation acknowledgement unconfirmed';
    end if;
  end if;
  return jsonb_build_object('actorId',p_actor_id,'requestId',p_request_id,'acknowledged',true);
end;
$$;

revoke all on function public.read_price_setter_creation_state(uuid) from public,anon,authenticated;
revoke all on function public.create_owned_price_setter_port(uuid,uuid,text,bigint) from public,anon,authenticated;
revoke all on function public.acknowledge_price_setter_creation(uuid,uuid) from public,anon,authenticated;
grant execute on function public.read_price_setter_creation_state(uuid) to service_role;
grant execute on function public.create_owned_price_setter_port(uuid,uuid,text,bigint) to service_role;
grant execute on function public.acknowledge_price_setter_creation(uuid,uuid) to service_role;
