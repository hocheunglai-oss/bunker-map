create table if not exists public.parser_reports (
  id uuid primary key default gen_random_uuid(),
  fingerprint text not null unique,
  source text not null check (source in ('enquiryworksheet', 'spc')),
  context text not null default '',
  raw_text text not null,
  cleaned_text text not null default '',
  parser_output text not null default '',
  corrected_output text not null,
  note text not null default '',
  page_url text not null default '',
  metadata jsonb not null default '{}'::jsonb,
  status text not null default 'new' check (status in ('new', 'reviewed')),
  duplicate_count integer not null default 1 check (duplicate_count > 0),
  created_at timestamptz not null default now(),
  last_reported_at timestamptz not null default now(),
  created_by_username text not null default '',
  created_by_display_name text not null default '',
  app_commit text not null default '',
  updated_at timestamptz not null default now()
);

create index if not exists parser_reports_source_status_last_reported_idx
  on public.parser_reports (source, status, last_reported_at desc);

alter table public.parser_reports enable row level security;
revoke all on table public.parser_reports from anon, authenticated;
grant select, insert, update, delete on table public.parser_reports to service_role;

insert into public.parser_reports (
  id,
  fingerprint,
  source,
  context,
  raw_text,
  cleaned_text,
  parser_output,
  corrected_output,
  note,
  page_url,
  metadata,
  status,
  duplicate_count,
  created_at,
  last_reported_at,
  created_by_username,
  created_by_display_name,
  app_commit,
  updated_at
)
select
  (report->>'id')::uuid,
  report->>'fingerprint',
  report->>'source',
  coalesce(report->>'context', ''),
  coalesce(report->>'rawText', ''),
  coalesce(report->>'cleanedText', ''),
  coalesce(report->>'parserOutput', ''),
  coalesce(report->>'correctedOutput', ''),
  coalesce(report->>'note', ''),
  coalesce(report->>'pageUrl', ''),
  coalesce(report->'metadata', '{}'::jsonb),
  'reviewed',
  greatest(coalesce((report->>'duplicateCount')::integer, 1), 1),
  coalesce((report->>'createdAt')::timestamptz, now()),
  coalesce((report->>'lastReportedAt')::timestamptz, now()),
  coalesce(report->>'createdByUsername', ''),
  coalesce(report->>'createdByDisplayName', ''),
  coalesce(report->>'appCommit', ''),
  now()
from public.office_calendar_store as store
cross join lateral jsonb_array_elements(coalesce(store.payload->'reports', '[]'::jsonb)) as report
where store.key = 'parser-reports'
  and report->>'fingerprint' is not null
  and report->>'source' in ('enquiryworksheet', 'spc')
on conflict (fingerprint) do nothing;

select public.audit_enable_table('public.parser_reports'::regclass);

create or replace function public.upsert_parser_report(
  p_fingerprint text,
  p_source text,
  p_context text,
  p_raw_text text,
  p_cleaned_text text,
  p_parser_output text,
  p_corrected_output text,
  p_note text,
  p_page_url text,
  p_metadata jsonb,
  p_created_by_username text,
  p_created_by_display_name text,
  p_app_commit text,
  p_reported_at timestamptz
)
returns setof public.parser_reports
language sql
security definer
set search_path = ''
as $$
  insert into public.parser_reports (
    fingerprint,
    source,
    context,
    raw_text,
    cleaned_text,
    parser_output,
    corrected_output,
    note,
    page_url,
    metadata,
    status,
    duplicate_count,
    created_at,
    last_reported_at,
    created_by_username,
    created_by_display_name,
    app_commit,
    updated_at
  ) values (
    p_fingerprint,
    p_source,
    p_context,
    p_raw_text,
    p_cleaned_text,
    p_parser_output,
    p_corrected_output,
    p_note,
    p_page_url,
    coalesce(p_metadata, '{}'::jsonb),
    'new',
    1,
    p_reported_at,
    p_reported_at,
    p_created_by_username,
    p_created_by_display_name,
    p_app_commit,
    p_reported_at
  )
  on conflict (fingerprint) do update set
    note = case when excluded.note <> '' then excluded.note else public.parser_reports.note end,
    page_url = case when excluded.page_url <> '' then excluded.page_url else public.parser_reports.page_url end,
    metadata = public.parser_reports.metadata || excluded.metadata,
    status = 'new',
    duplicate_count = public.parser_reports.duplicate_count + 1,
    last_reported_at = excluded.last_reported_at,
    created_by_username = excluded.created_by_username,
    created_by_display_name = excluded.created_by_display_name,
    app_commit = excluded.app_commit,
    updated_at = excluded.updated_at
  returning *;
$$;

revoke all on function public.upsert_parser_report(
  text, text, text, text, text, text, text, text, text, jsonb, text, text, text, timestamptz
) from public, anon, authenticated;
grant execute on function public.upsert_parser_report(
  text, text, text, text, text, text, text, text, text, jsonb, text, text, text, timestamptz
) to service_role;
