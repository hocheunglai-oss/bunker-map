-- One service-only STABLE invocation supplies one MVCC snapshot. It performs no
-- writes/locks and never returns a truncated success. Financial parsing and
-- reporting policy remain in the existing TypeScript aggregator.
create function public.read_spc_statistics_source(
  p_first_fixture_year integer,
  p_last_fixture_year integer,
  p_window_start timestamptz,
  p_window_end timestamptz
) returns jsonb
language plpgsql stable security invoker
set search_path=''
set statement_timeout='15s'
as $function$
declare
  source_bytes bigint;
  largest_row bigint;
  result jsonb;
begin
  if p_first_fixture_year is null or p_last_fixture_year is null
    or p_first_fixture_year<1999 or p_last_fixture_year>2100
    or p_first_fixture_year>p_last_fixture_year
    or p_window_start is null or p_window_end is null
    or not pg_catalog.isfinite(p_window_start) or not pg_catalog.isfinite(p_window_end)
    or p_window_start>p_window_end or p_window_end-p_window_start>interval '91 days'
    or extract(year from p_window_start at time zone 'Asia/Hong_Kong')<p_first_fixture_year
    or extract(year from p_window_end at time zone 'Asia/Hong_Kong')>p_last_fixture_year then
    raise exception using errcode='22023',message='Invalid SPC statistics source bounds.';
  end if;

  -- Check raw row sizes before any JSON projection. Even pathological text
  -- cannot cause a single unbounded jsonb_build_object allocation.
  select coalesce(max(bytes),0) into largest_row from (
    select max(pg_catalog.octet_length(coalesce(f.id::text,''))+pg_catalog.octet_length(coalesce(f.fixture_status::text,''))+pg_catalog.octet_length(coalesce(f.fixture_date::text,''))+pg_catalog.octet_length(coalesce(f.supplier_trader_username::text,''))+pg_catalog.octet_length(coalesce(f.supplier_trader_display_name::text,''))+pg_catalog.octet_length(coalesce(f.buyer_trader_username::text,''))+pg_catalog.octet_length(coalesce(f.buyer_trader_display_name::text,''))+pg_catalog.octet_length(coalesce(f.account::text,''))+pg_catalog.octet_length(coalesce(f.vessel_name::text,''))+pg_catalog.octet_length(coalesce(f.hsfo::text,''))+pg_catalog.octet_length(coalesce(f.vlsfo::text,''))+pg_catalog.octet_length(coalesce(f.lsmgo::text,''))+pg_catalog.octet_length(coalesce(f.supplier_name::text,''))+pg_catalog.octet_length(coalesce(f.supplier_key::text,''))+pg_catalog.octet_length(coalesce(f.created_at::text,''))+pg_catalog.octet_length(coalesce(e.enquiry_number::text,''))+pg_catalog.octet_length(coalesce(e.created_by_username::text,''))+pg_catalog.octet_length(coalesce(e.created_by_display_name::text,''))+pg_catalog.octet_length(coalesce(e.created_at::text,''))) as bytes from public.spc_fixtures f left join public.spc_enquiries e on e.id=f.enquiry_id where f.fixture_status='completed' and f.fixture_date >= pg_catalog.make_date(p_first_fixture_year,1,1) and f.fixture_date <= pg_catalog.make_date(p_last_fixture_year,12,31)
    union all
    select max(pg_catalog.octet_length(coalesce(e.id::text,''))+pg_catalog.octet_length(coalesce(e.enquiry_number::text,''))+pg_catalog.octet_length(coalesce(e.title::text,''))+pg_catalog.octet_length(coalesce(e.created_by_username::text,''))+pg_catalog.octet_length(coalesce(e.created_by_display_name::text,''))+pg_catalog.octet_length(coalesce(e.created_at::text,''))) as bytes from public.spc_enquiries e where e.created_at>=p_window_start and e.created_at<=p_window_end
    union all
    select max(pg_catalog.octet_length(coalesce(u.id::text,''))+pg_catalog.octet_length(coalesce(u.username::text,''))+pg_catalog.octet_length(coalesce(u.display_name::text,''))+pg_catalog.octet_length(coalesce(u.role::text,''))+pg_catalog.octet_length(coalesce(u.is_active::text,''))) as bytes from public.spc_users u
    union all
    select max(pg_catalog.octet_length(n.number)) as bytes from (select distinct l.after_row->>'enquiry_number' as number from public.audit_logs l where l.table_schema='public' and l.table_name='spc_enquiries' and l.operation='INSERT' and l.actor_id like 'spc:%' and l.request_context @> '{"pageId":"spc-buyer-enquiries"}'::jsonb and l.after_row->>'enquiry_number' is not null) n
    union all
    select max(pg_catalog.octet_length(coalesce(case when pg_catalog.jsonb_typeof(a.item->'userId')='string' then a.item->>'userId' else null end,''))+pg_catalog.octet_length(coalesce(case when pg_catalog.jsonb_typeof(a.item->'username')='string' then a.item->>'username' else null end,''))+pg_catalog.octet_length(coalesce(case when pg_catalog.jsonb_typeof(a.item->'role')='string' then a.item->>'role' else null end,''))) as bytes from public.office_calendar_store s cross join lateral pg_catalog.jsonb_array_elements(case when pg_catalog.jsonb_typeof(s.payload->'userRoles')='array' then s.payload->'userRoles' else '[]'::jsonb end) with ordinality a(item,ordinality) where s.key='spc-permission-groups'
    union all
    select max(pg_catalog.octet_length(coalesce(case when pg_catalog.jsonb_typeof(a.item->'userId')='string' then a.item->>'userId' else null end,''))+pg_catalog.octet_length(coalesce(case when pg_catalog.jsonb_typeof(a.item->'username')='string' then a.item->>'username' else null end,''))+pg_catalog.octet_length(coalesce(case when pg_catalog.jsonb_typeof(a.item->'office')='string' then a.item->>'office' else null end,''))) as bytes from public.office_calendar_store s cross join lateral pg_catalog.jsonb_array_elements(case when pg_catalog.jsonb_typeof(s.payload->'userProfiles')='array' then s.payload->'userProfiles' else '[]'::jsonb end) with ordinality a(item,ordinality) where s.key='spc-permission-groups'
  ) sizes;
  if largest_row>1048576 then
    raise exception using errcode='54000',message='SPC statistics source exceeds the safe complete-read budget; no partial totals were produced.';
  end if;

  -- Measure each bounded projection, not a giant aggregate. Reserve envelope/
  -- array separators so the final JSON document is at most 32 MiB.
  select coalesce(sum(bytes),0) into source_bytes from (
    select pg_catalog.octet_length((pg_catalog.jsonb_build_object('id',f.id,'fixture_status',f.fixture_status,'fixture_date',f.fixture_date,'supplier_trader_username',f.supplier_trader_username,'supplier_trader_display_name',f.supplier_trader_display_name,'buyer_trader_username',f.buyer_trader_username,'buyer_trader_display_name',f.buyer_trader_display_name,'account',f.account,'vessel_name',f.vessel_name,'hsfo',f.hsfo,'vlsfo',f.vlsfo,'lsmgo',f.lsmgo,'supplier_name',f.supplier_name,'supplier_key',f.supplier_key,'created_at',f.created_at) || pg_catalog.jsonb_build_object('enquiry',case when e.id is null then null else pg_catalog.jsonb_build_object('enquiry_number',e.enquiry_number,'created_by_username',e.created_by_username,'created_by_display_name',e.created_by_display_name,'created_at',e.created_at) end))::text)+2 as bytes from public.spc_fixtures f left join public.spc_enquiries e on e.id=f.enquiry_id where f.fixture_status='completed' and f.fixture_date >= pg_catalog.make_date(p_first_fixture_year,1,1) and f.fixture_date <= pg_catalog.make_date(p_last_fixture_year,12,31)
    union all
    select pg_catalog.octet_length((pg_catalog.jsonb_build_object('id',e.id,'enquiry_number',e.enquiry_number,'title',e.title,'created_by_username',e.created_by_username,'created_by_display_name',e.created_by_display_name,'created_at',e.created_at))::text)+2 as bytes from public.spc_enquiries e where e.created_at>=p_window_start and e.created_at<=p_window_end
    union all
    select pg_catalog.octet_length((pg_catalog.jsonb_build_object('id',u.id,'username',u.username,'display_name',u.display_name,'role',u.role,'is_active',u.is_active))::text)+2 as bytes from public.spc_users u
    union all
    select pg_catalog.octet_length((pg_catalog.to_jsonb(n.number))::text)+2 as bytes from (select distinct l.after_row->>'enquiry_number' as number from public.audit_logs l where l.table_schema='public' and l.table_name='spc_enquiries' and l.operation='INSERT' and l.actor_id like 'spc:%' and l.request_context @> '{"pageId":"spc-buyer-enquiries"}'::jsonb and l.after_row->>'enquiry_number' is not null) n
    union all
    select pg_catalog.octet_length((pg_catalog.jsonb_build_object('userId',case when pg_catalog.jsonb_typeof(a.item->'userId')='string' then a.item->>'userId' else null end,'username',case when pg_catalog.jsonb_typeof(a.item->'username')='string' then a.item->>'username' else null end,'role',case when pg_catalog.jsonb_typeof(a.item->'role')='string' then a.item->>'role' else null end))::text)+2 as bytes from public.office_calendar_store s cross join lateral pg_catalog.jsonb_array_elements(case when pg_catalog.jsonb_typeof(s.payload->'userRoles')='array' then s.payload->'userRoles' else '[]'::jsonb end) with ordinality a(item,ordinality) where s.key='spc-permission-groups'
    union all
    select pg_catalog.octet_length((pg_catalog.jsonb_build_object('userId',case when pg_catalog.jsonb_typeof(a.item->'userId')='string' then a.item->>'userId' else null end,'username',case when pg_catalog.jsonb_typeof(a.item->'username')='string' then a.item->>'username' else null end,'office',case when pg_catalog.jsonb_typeof(a.item->'office')='string' then a.item->>'office' else null end))::text)+2 as bytes from public.office_calendar_store s cross join lateral pg_catalog.jsonb_array_elements(case when pg_catalog.jsonb_typeof(s.payload->'userProfiles')='array' then s.payload->'userProfiles' else '[]'::jsonb end) with ordinality a(item,ordinality) where s.key='spc-permission-groups'
  ) sizes;
  if source_bytes>33550336 then
    raise exception using errcode='54000',message='SPC statistics source exceeds the safe complete-read budget; no partial totals were produced.';
  end if;

  select pg_catalog.jsonb_build_object(
    'schema','fcuno.spc-statistics-source/v1','complete',true,
    'bounds',pg_catalog.jsonb_build_object('firstFixtureYear',p_first_fixture_year,'lastFixtureYear',p_last_fixture_year,'windowStart',p_window_start,'windowEnd',p_window_end),
    'fixtures',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id',f.id,'fixture_status',f.fixture_status,'fixture_date',f.fixture_date,'supplier_trader_username',f.supplier_trader_username,'supplier_trader_display_name',f.supplier_trader_display_name,'buyer_trader_username',f.buyer_trader_username,'buyer_trader_display_name',f.buyer_trader_display_name,'account',f.account,'vessel_name',f.vessel_name,'hsfo',f.hsfo,'vlsfo',f.vlsfo,'lsmgo',f.lsmgo,'supplier_name',f.supplier_name,'supplier_key',f.supplier_key,'created_at',f.created_at) || pg_catalog.jsonb_build_object('enquiry',case when e.id is null then null else pg_catalog.jsonb_build_object('enquiry_number',e.enquiry_number,'created_by_username',e.created_by_username,'created_by_display_name',e.created_by_display_name,'created_at',e.created_at) end) order by f.fixture_date,f.id),'[]'::jsonb) from public.spc_fixtures f left join public.spc_enquiries e on e.id=f.enquiry_id where f.fixture_status='completed' and f.fixture_date >= pg_catalog.make_date(p_first_fixture_year,1,1) and f.fixture_date <= pg_catalog.make_date(p_last_fixture_year,12,31)),
    'enquiries',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id',e.id,'enquiry_number',e.enquiry_number,'title',e.title,'created_by_username',e.created_by_username,'created_by_display_name',e.created_by_display_name,'created_at',e.created_at) order by e.created_at,e.id),'[]'::jsonb) from public.spc_enquiries e where e.created_at>=p_window_start and e.created_at<=p_window_end),
    'users',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id',u.id,'username',u.username,'display_name',u.display_name,'role',u.role,'is_active',u.is_active) order by u.role,u.username,u.id),'[]'::jsonb) from public.spc_users u),
    'buyerEnquiryNumbers',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(n.number) order by n.number),'[]'::jsonb) from (select distinct l.after_row->>'enquiry_number' as number from public.audit_logs l where l.table_schema='public' and l.table_name='spc_enquiries' and l.operation='INSERT' and l.actor_id like 'spc:%' and l.request_context @> '{"pageId":"spc-buyer-enquiries"}'::jsonb and l.after_row->>'enquiry_number' is not null) n),
    'roles',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('userId',case when pg_catalog.jsonb_typeof(a.item->'userId')='string' then a.item->>'userId' else null end,'username',case when pg_catalog.jsonb_typeof(a.item->'username')='string' then a.item->>'username' else null end,'role',case when pg_catalog.jsonb_typeof(a.item->'role')='string' then a.item->>'role' else null end) order by a.ordinality),'[]'::jsonb) from public.office_calendar_store s cross join lateral pg_catalog.jsonb_array_elements(case when pg_catalog.jsonb_typeof(s.payload->'userRoles')='array' then s.payload->'userRoles' else '[]'::jsonb end) with ordinality a(item,ordinality) where s.key='spc-permission-groups'),
    'profiles',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('userId',case when pg_catalog.jsonb_typeof(a.item->'userId')='string' then a.item->>'userId' else null end,'username',case when pg_catalog.jsonb_typeof(a.item->'username')='string' then a.item->>'username' else null end,'office',case when pg_catalog.jsonb_typeof(a.item->'office')='string' then a.item->>'office' else null end) order by a.ordinality),'[]'::jsonb) from public.office_calendar_store s cross join lateral pg_catalog.jsonb_array_elements(case when pg_catalog.jsonb_typeof(s.payload->'userProfiles')='array' then s.payload->'userProfiles' else '[]'::jsonb end) with ordinality a(item,ordinality) where s.key='spc-permission-groups')
  ) into result;
  result := result || pg_catalog.jsonb_build_object('counts',pg_catalog.jsonb_build_object(
    'fixtures',pg_catalog.jsonb_array_length(result->'fixtures'),
    'enquiries',pg_catalog.jsonb_array_length(result->'enquiries'),
    'users',pg_catalog.jsonb_array_length(result->'users'),
    'buyerEnquiryNumbers',pg_catalog.jsonb_array_length(result->'buyerEnquiryNumbers'),
    'roles',pg_catalog.jsonb_array_length(result->'roles'),
    'profiles',pg_catalog.jsonb_array_length(result->'profiles')
  ));
  if pg_catalog.octet_length(result::text)>33554432 then
    raise exception using errcode='54000',message='SPC statistics source exceeds the safe complete-read budget; no partial totals were produced.';
  end if;
  return result;
end;
$function$;
revoke all on function public.read_spc_statistics_source(integer,integer,timestamptz,timestamptz) from public,anon,authenticated;
grant execute on function public.read_spc_statistics_source(integer,integer,timestamptz,timestamptz) to service_role;
comment on function public.read_spc_statistics_source(integer,integer,timestamptz,timestamptz)
  is 'Read-only complete SPC statistics inputs from one statement snapshot; service only; explicit 32 MiB failure, never partial totals.';
