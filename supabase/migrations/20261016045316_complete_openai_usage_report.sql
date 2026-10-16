-- Single read snapshot: complete period totals/groups and deterministic recent20.
-- Applying this migration creates only a service-only read RPC; no data changes.
create function public.get_openai_usage_report(p_days integer)
returns jsonb language plpgsql stable security invoker
set search_path = '' set statement_timeout = '15s'
as $$
declare report jsonb; safe boolean;
begin
  if p_days is null or p_days not in (7,30,90) then
    raise exception using errcode='22023',message='Choose a supported usage period.';
  end if;
  with anchor as materialized (select statement_timestamp() as at), events as materialized (
    select e.id,e.occurred_at,e.page_id,e.page_path,e.feature,e.model,e.status,
      e.input_tokens,e.cached_input_tokens,e.output_tokens,e.reasoning_tokens,e.total_tokens,e.web_search_calls,e.duration_ms
    from public.openai_usage_events e cross join anchor a
    where e.occurred_at >= a.at-make_interval(secs=>p_days*86400) and e.occurred_at <= a.at
  ), totals as (
    select count(*) as requests,count(*) filter(where status='error') as errors,
      coalesce(sum(input_tokens),0) as input_tokens,coalesce(sum(cached_input_tokens),0) as cached_input_tokens,
      coalesce(sum(output_tokens),0) as output_tokens,coalesce(sum(reasoning_tokens),0) as reasoning_tokens,
      coalesce(sum(total_tokens),0) as total_tokens,coalesce(sum(web_search_calls),0) as web_search_calls,
      coalesce(sum(duration_ms),0) as duration_ms from events
  ), latest_paths as (
    select distinct on (page_id) page_id,page_path from events order by page_id,occurred_at desc,id desc
  ), groups as (
    select page_id,count(*) as requests,count(*) filter(where status='error') as errors,
      sum(input_tokens) as input_tokens,sum(cached_input_tokens) as cached_input_tokens,
      sum(output_tokens) as output_tokens,sum(reasoning_tokens) as reasoning_tokens,sum(total_tokens) as total_tokens,
      sum(web_search_calls) as web_search_calls,sum(duration_ms) as duration_ms,
      coalesce(jsonb_agg(distinct feature collate "C" order by feature collate "C") filter(where feature<>''),'[]') as features,
      coalesce(jsonb_agg(distinct model collate "C" order by model collate "C") filter(where model<>''),'[]') as models
    from events group by page_id
  ), recent as (select * from events order by occurred_at desc,id desc limit 20)
  select jsonb_build_object('generatedAt',a.at,'since',a.at-make_interval(secs=>p_days*86400),'days',p_days,
    'totals',jsonb_build_object('requests',t.requests,'errors',t.errors,'inputTokens',t.input_tokens,
      'cachedInputTokens',t.cached_input_tokens,'outputTokens',t.output_tokens,'reasoningTokens',t.reasoning_tokens,
      'totalTokens',t.total_tokens,'webSearchCalls',t.web_search_calls),
    'pages',coalesce((select jsonb_agg(jsonb_build_object('pageId',g.page_id,'pagePath',p.page_path,
      'requests',g.requests,'errors',g.errors,'inputTokens',g.input_tokens,'cachedInputTokens',g.cached_input_tokens,
      'outputTokens',g.output_tokens,'reasoningTokens',g.reasoning_tokens,'totalTokens',g.total_tokens,
      'webSearchCalls',g.web_search_calls,'durationMs',g.duration_ms,'averageDurationMs',round(g.duration_ms::numeric/g.requests),
      'tokenPercentage',case when t.total_tokens=0 then 0 else g.total_tokens*100/t.total_tokens end,
      'requestPercentage',g.requests::numeric*100/t.requests,'features',g.features,'models',g.models
    ) order by g.total_tokens desc,g.page_id collate "C") from groups g join latest_paths p using(page_id)),'[]'),
    'recent',coalesce((select jsonb_agg(jsonb_build_object('occurred_at',r.occurred_at,'page_id',r.page_id,
      'page_path',r.page_path,'feature',r.feature,'model',r.model,'status',r.status,'input_tokens',r.input_tokens,
      'cached_input_tokens',r.cached_input_tokens,'output_tokens',r.output_tokens,'reasoning_tokens',r.reasoning_tokens,
      'total_tokens',r.total_tokens,'web_search_calls',r.web_search_calls,'duration_ms',r.duration_ms
    ) order by r.occurred_at desc,r.id desc) from recent r),'[]')
  ), greatest(t.requests,t.errors,t.input_tokens,t.cached_input_tokens,t.output_tokens,t.reasoning_tokens,
    t.total_tokens,t.web_search_calls,t.duration_ms)<=9007199254740991
  into report,safe from totals t cross join anchor a;
  if not safe then raise exception using errcode='22003',message='Usage totals exceed the supported exact numeric range.'; end if;
  return report;
end $$;
revoke all on function public.get_openai_usage_report(integer) from public,anon,authenticated;
grant execute on function public.get_openai_usage_report(integer) to service_role;
