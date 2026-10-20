-- Read-only coherent pages. No business data, writer, global or role settings change.
-- PostgREST must hoist statement_timeout before the outer RPC to enforce15s.
-- A direct SELECT with only function proconfig does not arm its existing timer.
set local lock_timeout='5s';
set local statement_timeout='15s';

create function private.spc_record_ascii_name(p_value text)
returns text language sql immutable security invoker set search_path='' as $function$
  select case when pg_catalog.octet_length(coalesce(p_value,''))=pg_catalog.char_length(coalesce(p_value,''))
    then pg_catalog.lower(pg_catalog.btrim(pg_catalog.regexp_replace(coalesce(p_value,'') collate "C",'[^a-zA-Z0-9]+',' ','g')) collate "C")
    else null end;
$function$;

-- Candidate selector only: original raw notes always go to the existing JS
-- metadata parser. An unprovable SQL decode widens candidates, never invents{}.
create function private.spc_record_imo_selector(p_notes text)
returns jsonb language plpgsql immutable security invoker set search_path='' as $function$
declare marker integer; parsed json; value text;
begin
  marker:=pg_catalog.strpos(coalesce(p_notes,''),'---SPC_META---');
  if marker=0 then return '{"imo":"","uncertain":false}'::jsonb;end if;
  if pg_catalog.octet_length(p_notes)>1048576 then return '{"imo":"","uncertain":true}'::jsonb;end if;
  begin
    parsed:=pg_catalog.btrim(pg_catalog.substr(p_notes,marker+14),U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')::json;
    if pg_catalog.json_typeof(parsed)<>'object' or pg_catalog.json_typeof(parsed->'imo') is distinct from 'string' then
      return '{"imo":"","uncertain":false}'::jsonb;
    end if;
    value:=pg_catalog.regexp_replace(parsed->>'imo','[^0-9]','','g');
    return pg_catalog.jsonb_build_object('imo',case when pg_catalog.length(value)=7 then value else '' end,'uncertain',false);
  exception when invalid_text_representation or untranslatable_character or numeric_value_out_of_range then
    return '{"imo":"","uncertain":true}'::jsonb;
  end;
end;
$function$;

create function private.spc_record_row(p_row public.spc_enquiries)
returns jsonb language sql stable security invoker set search_path='' as $function$
  select pg_catalog.jsonb_build_object('id',p_row.id,'enquiry_number',p_row.enquiry_number,'title',p_row.title,
    'vessel_name',p_row.vessel_name,'port',p_row.port,'product',p_row.product,'quantity',p_row.quantity,
    'delivery_date',p_row.delivery_date,'supplier_name',p_row.supplier_name,'status',p_row.status,'notes',p_row.notes,
    'created_by_username',p_row.created_by_username,'created_by_display_name',p_row.created_by_display_name,
    'created_at',p_row.created_at,'updated_at',p_row.updated_at);
$function$;

create function private.spc_record_main_page(p_kind text,p_created timestamptz,p_id uuid,p_size integer,p_start timestamptz,p_end timestamptz)
returns setof public.spc_enquiries language plpgsql stable security invoker set search_path='' as $function$
begin
  if p_kind='lost' then
    if p_id is null then
      return query select e.* from public.spc_enquiries e where e.status='cancelled' order by e.created_at desc,e.id limit p_size;
      return;
    end if;
    return query select page.* from (
      (select e.* from public.spc_enquiries e where e.status='cancelled' and e.created_at<p_created order by e.created_at desc,e.id limit p_size)
      union all
      (select e.* from public.spc_enquiries e where e.status='cancelled' and e.created_at=p_created and e.id>p_id order by e.id limit p_size)
      order by created_at desc,id limit p_size
    ) page;
  else
    if p_id is null then
      return query select e.* from public.spc_enquiries e where e.created_at>=p_start and e.created_at<p_end order by e.created_at,e.id limit p_size;
      return;
    end if;
    return query select e.* from public.spc_enquiries e where e.created_at>=p_start and e.created_at<p_end and
      (e.created_at,e.id)>(p_created,p_id) order by e.created_at,e.id limit p_size;
  end if;
end;
$function$;


create function private.spc_record_fixture_ids(names text[],imos text[],uncertain boolean)
returns setof uuid language sql stable security invoker set search_path='' as $function$
      select f.id from public.spc_fixtures f where f.fixture_status='completed' and f.vessel_imo=any(imos)
      union select f.id from public.spc_fixtures f where f.fixture_status='completed' and private.spc_record_ascii_name(f.vessel_name)=any(names)
      union select f.id from public.spc_fixtures f where f.fixture_status='completed' and pg_catalog.cardinality(names)>0 and private.spc_record_ascii_name(f.vessel_name) is null
      union select f.id from public.spc_fixtures f join public.spc_enquiries e on e.id=f.enquiry_id where f.fixture_status='completed' and coalesce(f.vessel_name,'')='' and
        (private.spc_record_ascii_name(e.vessel_name)=any(names) or (pg_catalog.cardinality(names)>0 and private.spc_record_ascii_name(e.vessel_name) is null))
      union select f.id from public.spc_fixtures f where f.fixture_status='completed' and uncertain;
$function$;
create function private.spc_record_lost_ids(names text[],imos text[],uncertain boolean)
returns setof uuid language sql stable security invoker set search_path='' as $function$
      select e.id from public.spc_enquiries e where e.status='cancelled' and private.spc_record_imo_selector(e.notes)->>'imo'=any(imos)
      union select e.id from public.spc_enquiries e where e.status='cancelled' and private.spc_record_ascii_name(e.vessel_name)=any(names)
      union select e.id from public.spc_enquiries e where e.status='cancelled' and pg_catalog.cardinality(names)>0 and private.spc_record_ascii_name(e.vessel_name) is null
      union select e.id from public.spc_enquiries e where e.status='cancelled' and pg_catalog.cardinality(imos)>0 and private.spc_record_imo_selector(e.notes)->>'uncertain'='true'
      union select e.id from public.spc_enquiries e where e.status='cancelled' and uncertain;
$function$;
create function private.spc_record_fixture_row(p_row public.spc_fixtures,p_parent_name text)
returns jsonb language sql stable security invoker set search_path='' as $function$
  select pg_catalog.jsonb_build_object('id',p_row.id,'fixture_date',p_row.fixture_date,
    'supplier_trader_display_name',p_row.supplier_trader_display_name,'buyer_trader_display_name',p_row.buyer_trader_display_name,
    'vessel_name',p_row.vessel_name,'vessel_imo',p_row.vessel_imo,'supplier_name',p_row.supplier_name,
    'price',p_row.price,'barging',p_row.barging,'completed_at',p_row.completed_at,'created_at',p_row.created_at,
    'enquiry',pg_catalog.jsonb_build_object('vessel_name',p_parent_name));
$function$;
create function private.spc_record_lost_row(p_row public.spc_enquiries)
returns jsonb language sql stable security invoker set search_path='' as $function$
  select pg_catalog.jsonb_build_object('id',p_row.id,'vessel_name',p_row.vessel_name,'notes',p_row.notes,'created_at',p_row.created_at,'updated_at',p_row.updated_at);
$function$;

create index spc_record_cancelled_page_idx on public.spc_enquiries(created_at desc,id)
  where status='cancelled';
create index spc_record_today_page_idx on public.spc_enquiries(created_at,id);
create index spc_record_enquiry_ascii_idx on public.spc_enquiries(private.spc_record_ascii_name(vessel_name));
create index spc_record_enquiry_imo_idx on public.spc_enquiries((private.spc_record_imo_selector(notes)->>'imo'))
  where status='cancelled';
create index spc_record_enquiry_uncertain_imo_idx on public.spc_enquiries(id)
  where status='cancelled' and private.spc_record_imo_selector(notes)->>'uncertain'='true';
create index spc_record_enquiry_uncertain_name_idx on public.spc_enquiries(id)
  where private.spc_record_ascii_name(vessel_name) is null;
create index spc_record_fixture_ascii_idx on public.spc_fixtures(private.spc_record_ascii_name(vessel_name))
  where fixture_status='completed';
create index spc_record_fixture_uncertain_name_idx on public.spc_fixtures(id)
  where fixture_status='completed' and private.spc_record_ascii_name(vessel_name) is null;

create function private.read_spc_record_page(p_kind text,p_cursor jsonb,p_page_size integer)
returns jsonb language plpgsql stable security invoker
set search_path='' set timezone='UTC' set lock_timeout='5s' as $function$
declare
  day_key date; day_start timestamptz; day_end timestamptz; checked_at timestamptz:=pg_catalog.statement_timestamp();
  count_rows bigint; preceding bigint:=0; max_bytes bigint; revision text; cursor_created timestamptz; cursor_id uuid;
  main_rows jsonb; fixture_rows jsonb:='[]'::jsonb; lost_rows jsonb:='[]'::jsonb;
  names text[]; imos text[]; uncertain boolean; source_bytes bigint; largest_row bigint; result jsonb; next_cursor jsonb;
begin
  if p_kind not in ('lost','today') or p_kind is null or p_page_size is null or p_page_size<1 or p_page_size>250 then
    raise exception using errcode='22023',message='Invalid record page request.';
  end if;
  if p_kind='today' then
    day_key:=(checked_at at time zone 'Asia/Hong_Kong')::date;
    day_start:=day_key::timestamp at time zone 'Asia/Hong_Kong';day_end:=(day_key+1)::timestamp at time zone 'Asia/Hong_Kong';
  end if;
  if p_cursor is not null then
    if pg_catalog.jsonb_typeof(p_cursor)<>'object' or
      (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(p_cursor))<>5 or
      exists(select 1 from pg_catalog.jsonb_object_keys(p_cursor) k where k not in ('kind','day','createdAt','id','revision')) or
      pg_catalog.jsonb_typeof(p_cursor->'kind') is distinct from 'string' or p_cursor->>'kind'<>p_kind or
      pg_catalog.jsonb_typeof(p_cursor->'id') is distinct from 'string' or (p_cursor->>'id')!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' or
      pg_catalog.jsonb_typeof(p_cursor->'revision') is distinct from 'string' or (p_cursor->>'revision')!~'^[0-9a-f]{64}$' or
      pg_catalog.jsonb_typeof(p_cursor->'createdAt') is distinct from 'string' or (p_cursor->>'createdAt')!~'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$' or
      (p_kind='lost' and p_cursor->'day' is distinct from 'null'::jsonb) or
      (p_kind='today' and (pg_catalog.jsonb_typeof(p_cursor->'day') is distinct from 'string' or p_cursor->>'day'<>day_key::text)) then
      raise exception using errcode='40001',message='The record list changed. Refresh before browsing another page.';
    end if;
    begin cursor_created:=(p_cursor->>'createdAt')::timestamptz;cursor_id:=(p_cursor->>'id')::uuid;
    exception when invalid_text_representation or datetime_field_overflow then
      raise exception using errcode='22023',message='Invalid record page cursor.';
    end;
    if not pg_catalog.isfinite(cursor_created) then raise exception using errcode='22023',message='Invalid record page cursor.';end if;
  end if;

  -- Content-bound, not timestamp-only: the existing writer uses now(), which
  -- can repeat inside one transaction. A per-row digest keeps memory bounded.
  select pg_catalog.count(*),coalesce(pg_catalog.max(
    pg_catalog.octet_length(coalesce(e.notes,''))+pg_catalog.octet_length(coalesce(e.title,''))+
    pg_catalog.octet_length(coalesce(e.vessel_name,''))+pg_catalog.octet_length(coalesce(e.port,''))+
    pg_catalog.octet_length(coalesce(e.product,''))+pg_catalog.octet_length(coalesce(e.quantity,''))+
    pg_catalog.octet_length(coalesce(e.supplier_name,''))+pg_catalog.octet_length(e.enquiry_number)+
    pg_catalog.octet_length(e.status)+pg_catalog.octet_length(e.created_by_username)+pg_catalog.octet_length(e.created_by_display_name)),0)
    into count_rows,max_bytes from public.spc_enquiries e
    where (p_kind='lost' and e.status='cancelled') or (p_kind='today' and e.created_at>=day_start and e.created_at<day_end);
  if max_bytes>1048576 or count_rows*64>33500000 then
    raise exception using errcode='54000',message='The complete record list exceeds its safe read budget. No partial list was returned.';
  end if;
  -- Check exact escaped per-row projections before hashing/ordered aggregate.
  -- Raw preflight above bounds allocation even if one field is pathological.
  select coalesce(pg_catalog.max(pg_catalog.octet_length(private.spc_record_row(e)::text)),0)
    into max_bytes from public.spc_enquiries e
    where (p_kind='lost' and e.status='cancelled') or (p_kind='today' and e.created_at>=day_start and e.created_at<day_end);
  if max_bytes>1048576 then
    raise exception using errcode='54000',message='The complete record list exceeds its safe read budget. No partial list was returned.';
  end if;
  select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_kind||'|'||coalesce(day_key::text,'')||'|'||coalesce(pg_catalog.string_agg(
      pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(private.spc_record_row(e)::text,'UTF8')),'hex'),'' order by e.created_at,e.id),''),'UTF8')),'hex')
    into revision from public.spc_enquiries e
    where (p_kind='lost' and e.status='cancelled') or (p_kind='today' and e.created_at>=day_start and e.created_at<day_end);
  if p_cursor is not null then
    if p_cursor->>'revision'<>revision or not exists(select 1 from public.spc_enquiries e where e.id=cursor_id and e.created_at=cursor_created and
      ((p_kind='lost' and e.status='cancelled') or (p_kind='today' and e.created_at>=day_start and e.created_at<day_end))) then
      raise exception using errcode='40001',message='The record list changed. Refresh before browsing another page.';
    end if;
    select pg_catalog.count(*) into preceding from public.spc_enquiries e where
      ((p_kind='lost' and e.status='cancelled' and (e.created_at>cursor_created or (e.created_at=cursor_created and e.id<=cursor_id))) or
       (p_kind='today' and e.created_at>=day_start and e.created_at<day_end and (e.created_at,e.id)<=(cursor_created,cursor_id)));
    if preceding%p_page_size<>0 then raise exception using errcode='22023',message='Invalid record page boundary.';end if;
  end if;

  select coalesce(pg_catalog.sum(pg_catalog.octet_length(private.spc_record_row(page)::text)+1),0),
    coalesce(pg_catalog.max(pg_catalog.octet_length(private.spc_record_row(page)::text)),0)
    into source_bytes,largest_row from private.spc_record_main_page(p_kind,cursor_created,cursor_id,p_page_size,day_start,day_end) page;
  if source_bytes>33500000 or largest_row>1048576 then
    raise exception using errcode='54000',message='The complete record page exceeds its safe read budget. No partial page was returned.';
  end if;
  select coalesce(pg_catalog.jsonb_agg(private.spc_record_row(page)
    order by case when p_kind='lost' then page.created_at end desc,case when p_kind='today' then page.created_at end,page.id),'[]'::jsonb)
    into main_rows from private.spc_record_main_page(p_kind,cursor_created,cursor_id,p_page_size,day_start,day_end) page;
  if pg_catalog.jsonb_array_length(main_rows)<>least(p_page_size,count_rows-preceding) then
    raise exception using errcode='40001',message='The complete record page could not be verified.';
  end if;

  if p_kind='today' and pg_catalog.jsonb_array_length(main_rows)>0 then
    select coalesce(pg_catalog.array_agg(distinct a.name) filter(where a.name<>''),'{}'::text[]),
      coalesce(pg_catalog.array_agg(distinct a.imo->>'imo') filter(where a.imo->>'imo'<>''),'{}'::text[]),
      coalesce(pg_catalog.bool_or(a.name is null or a.imo->>'uncertain'='true'),false)
      into names,imos,uncertain from (select private.spc_record_ascii_name(r->>'vessel_name') as name,private.spc_record_imo_selector(r->>'notes') as imo
        from pg_catalog.jsonb_array_elements(main_rows) r) a;

    -- Size raw fields before any per-row JSON, then size projections before
    -- aggregate allocation. Selectors are reused in the same STABLE snapshot.
    select coalesce(pg_catalog.max(pg_catalog.octet_length(coalesce(f.vessel_name,''))+
      pg_catalog.octet_length(coalesce(f.vessel_imo,''))+pg_catalog.octet_length(coalesce(f.supplier_name,''))+
      pg_catalog.octet_length(coalesce(f.price,''))+pg_catalog.octet_length(coalesce(f.barging,''))+
      pg_catalog.octet_length(f.supplier_trader_display_name)+pg_catalog.octet_length(f.buyer_trader_display_name)+
      pg_catalog.octet_length(coalesce(e.vessel_name,''))),0)
      into largest_row from private.spc_record_fixture_ids(names,imos,uncertain) c(id)
      join public.spc_fixtures f on f.id=c.id left join public.spc_enquiries e on e.id=f.enquiry_id;
    if largest_row>1048576 then raise exception using errcode='54000',message='The complete vessel history exceeds its safe read budget. No partial history was returned.';end if;
    select coalesce(pg_catalog.sum(pg_catalog.octet_length(private.spc_record_fixture_row(f,e.vessel_name)::text)+1),0),
      coalesce(pg_catalog.max(pg_catalog.octet_length(private.spc_record_fixture_row(f,e.vessel_name)::text)),0)
      into source_bytes,largest_row from private.spc_record_fixture_ids(names,imos,uncertain) c(id)
      join public.spc_fixtures f on f.id=c.id left join public.spc_enquiries e on e.id=f.enquiry_id;
    if source_bytes+pg_catalog.octet_length(main_rows::text)>33500000 or largest_row>1048576 then
      raise exception using errcode='54000',message='The complete vessel history exceeds its safe read budget. No partial history was returned.';
    end if;
    -- JS Date.parse truncates sub-ms timestamps and stable sort preserves the
    -- old query input order on ties. Keep its completed_at DESC NULLS LAST.
    select coalesce(pg_catalog.jsonb_agg(private.spc_record_fixture_row(f,e.vessel_name) order by f.completed_at desc nulls last,f.id),'[]'::jsonb)
      into fixture_rows from private.spc_record_fixture_ids(names,imos,uncertain) c(id)
      join public.spc_fixtures f on f.id=c.id left join public.spc_enquiries e on e.id=f.enquiry_id;

    select coalesce(pg_catalog.max(pg_catalog.octet_length(coalesce(e.notes,''))+pg_catalog.octet_length(coalesce(e.vessel_name,''))),0)
      into largest_row from private.spc_record_lost_ids(names,imos,uncertain) c(id) join public.spc_enquiries e on e.id=c.id;
    if largest_row>1048576 then raise exception using errcode='54000',message='The complete vessel history exceeds its safe read budget. No partial history was returned.';end if;
    select coalesce(pg_catalog.sum(pg_catalog.octet_length(private.spc_record_lost_row(e)::text)+1),0),
      coalesce(pg_catalog.max(pg_catalog.octet_length(private.spc_record_lost_row(e)::text)),0)
      into source_bytes,largest_row from private.spc_record_lost_ids(names,imos,uncertain) c(id) join public.spc_enquiries e on e.id=c.id;
    if source_bytes+pg_catalog.octet_length(main_rows::text)+pg_catalog.octet_length(fixture_rows::text)>33500000 or largest_row>1048576 then
      raise exception using errcode='54000',message='The complete vessel history exceeds its safe read budget. No partial history was returned.';
    end if;
    -- Outcome metadata may have identical/legacy dates; preserve old review
    -- order for equal Date.parse values, with id only as a deterministic tie.
    select coalesce(pg_catalog.jsonb_agg(private.spc_record_lost_row(e) order by e.updated_at desc,e.id),'[]'::jsonb)
      into lost_rows from private.spc_record_lost_ids(names,imos,uncertain) c(id) join public.spc_enquiries e on e.id=c.id;
  end if;

  if preceding+pg_catalog.jsonb_array_length(main_rows)<count_rows then
    next_cursor:=pg_catalog.jsonb_build_object('kind',p_kind,'day',day_key,'createdAt',main_rows->-1->>'created_at','id',main_rows->-1->>'id','revision',revision);
  end if;
  result:=pg_catalog.jsonb_build_object('schema','spc.record-page-source/v1','kind',p_kind,'day',day_key,'checkedAt',checked_at,
    'pageSize',p_page_size,'totalCount',count_rows,'pageCount',case when count_rows=0 then 0 else (count_rows+p_page_size-1)/p_page_size end,
    'pageIndex',case when count_rows=0 then 0 else preceding/p_page_size+1 end,'mainRevision',revision,'nextCursor',next_cursor,
    'rows',main_rows,'fixtures',fixture_rows,'lost',lost_rows,'sourceCounts',pg_catalog.jsonb_build_object('rows',pg_catalog.jsonb_array_length(main_rows),
      'fixtures',pg_catalog.jsonb_array_length(fixture_rows),'lost',pg_catalog.jsonb_array_length(lost_rows)));
  if pg_catalog.octet_length(result::text)>33554432 then raise exception using errcode='54000',message='The complete record page exceeds its safe read budget. No partial page was returned.';end if;
  return result;
end;
$function$;

create function public.read_spc_lost_record_page(p_cursor jsonb default null,p_page_size integer default 250)
returns jsonb language sql stable security invoker set search_path='' set statement_timeout='15s' set lock_timeout='5s' as $function$
  select private.read_spc_record_page('lost',p_cursor,p_page_size);
$function$;
create function public.read_spc_today_enquiry_page(p_cursor jsonb default null,p_page_size integer default 250)
returns jsonb language sql stable security invoker set search_path='' set statement_timeout='15s' set lock_timeout='5s' as $function$
  select private.read_spc_record_page('today',p_cursor,p_page_size);
$function$;

revoke all on function private.spc_record_ascii_name(text),private.spc_record_imo_selector(text),private.spc_record_row(public.spc_enquiries),private.spc_record_main_page(text,timestamptz,uuid,integer,timestamptz,timestamptz),private.spc_record_fixture_ids(text[],text[],boolean),private.spc_record_lost_ids(text[],text[],boolean),private.spc_record_fixture_row(public.spc_fixtures,text),private.spc_record_lost_row(public.spc_enquiries),private.read_spc_record_page(text,jsonb,integer) from public,anon,authenticated;
grant execute on function private.spc_record_ascii_name(text),private.spc_record_imo_selector(text),private.spc_record_row(public.spc_enquiries),private.spc_record_main_page(text,timestamptz,uuid,integer,timestamptz,timestamptz),private.spc_record_fixture_ids(text[],text[],boolean),private.spc_record_lost_ids(text[],text[],boolean),private.spc_record_fixture_row(public.spc_fixtures,text),private.spc_record_lost_row(public.spc_enquiries),private.read_spc_record_page(text,jsonb,integer) to service_role;
revoke all on function public.read_spc_lost_record_page(jsonb,integer),public.read_spc_today_enquiry_page(jsonb,integer) from public,anon,authenticated;
grant execute on function public.read_spc_lost_record_page(jsonb,integer),public.read_spc_today_enquiry_page(jsonb,integer) to service_role;
