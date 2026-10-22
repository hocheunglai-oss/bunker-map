-- An intentional cursor/content conflict is not a serialization failure.
-- PostgREST14 retries40001; use one exact named P0001 business response.
-- Keep all guards, successful payloads, function identity/ACL and settings.
set local lock_timeout='5s';
set local statement_timeout='15s';

do $preflight$
begin
  if (select pg_catalog.md5(prosrc) from pg_catalog.pg_proc
      where oid=pg_catalog.to_regprocedure('private.read_spc_record_page(text,jsonb,integer)'))
      is distinct from '800d72588abf62d2a11f3edff4067617' then
    raise exception 'SPC_RECORD_PAGE_SOURCE_MISMATCH' using errcode='55000';
  end if;
end;
$preflight$;

create or replace function private.read_spc_record_page(p_kind text,p_cursor jsonb,p_page_size integer)
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
      raise exception using errcode='P0001',message='SPC_RECORD_PAGE_REFRESH_REQUIRED',detail='The record list changed. Refresh before browsing another page.';
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
      raise exception using errcode='P0001',message='SPC_RECORD_PAGE_REFRESH_REQUIRED',detail='The record list changed. Refresh before browsing another page.';
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
    raise exception using errcode='P0001',message='SPC_RECORD_PAGE_REFRESH_REQUIRED',detail='The complete record page could not be verified.';
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

notify pgrst, 'reload schema';
