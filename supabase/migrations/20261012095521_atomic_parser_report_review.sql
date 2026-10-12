-- Updated versions belong to the database, not request clocks. This fences the
-- existing duplicate-report upsert and audit undo without changing either API.
-- Inserts retain their supplied timestamp so logical restores stay exact.
create or replace function public.advance_parser_report_version()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at := greatest(
    pg_catalog.clock_timestamp(),
    old.updated_at + interval '1 microsecond'
  );
  return new;
end;
$$;

revoke all on function public.advance_parser_report_version()
  from public, anon, authenticated;

create trigger advance_parser_report_version
before update on public.parser_reports
for each row execute function public.advance_parser_report_version();

-- Large report text/metadata travels in the RPC body, never URL predicates.
-- Both the opened version and the workflow stage must still match atomically.
create or replace function public.save_parser_report_review(
  p_id uuid,
  p_source text,
  p_expected_updated_at timestamptz,
  p_action text,
  p_corrected_output text,
  p_note text,
  p_metadata jsonb
)
returns setof public.parser_reports
language plpgsql
security invoker
set search_path = ''
as $$
declare
  affected_rows integer;
begin
  if p_id is null
    or p_source is null or p_source not in ('enquiryworksheet', 'spc')
    or p_expected_updated_at is null
    or not pg_catalog.isfinite(p_expected_updated_at)
    or p_action is null or p_action not in ('submit-ai', 'review', 'acknowledge')
    or p_corrected_output is null
    or pg_catalog.btrim(p_corrected_output) = ''
    or pg_catalog.length(p_corrected_output) > 20000
    or p_note is null or pg_catalog.length(p_note) > 2000
    or pg_catalog.jsonb_typeof(p_metadata) is distinct from 'object'
    or p_metadata -> 'reviewWorkflowVersion' is distinct from '2'::jsonb
    or p_metadata -> 'pendingUserReview' is distinct from 'false'::jsonb
    or p_metadata -> 'aiReviewState' is distinct from
      pg_catalog.to_jsonb(case when p_action = 'submit-ai' then 'pending-ai'::text else 'complete'::text end)
    or p_metadata -> 'pendingReview' is distinct from pg_catalog.to_jsonb(p_action = 'submit-ai')
  then
    raise exception using errcode = '22023', message = 'Invalid parser review.';
  end if;

  return query
  update public.parser_reports as report
  set corrected_output = p_corrected_output,
      note = p_note,
      metadata = p_metadata,
      status = case when p_action = 'submit-ai' then 'new' else 'reviewed' end
  where report.id = p_id
    and report.source = p_source
    and report.updated_at = p_expected_updated_at
    and (
      (p_action = 'submit-ai' and report.status = 'new'
        and report.metadata -> 'aiReviewState' is distinct from '"pending-ai"'::jsonb)
      or (p_action = 'review' and report.status = 'new'
        and report.metadata -> 'aiReviewState' = '"pending-ai"'::jsonb)
      or (p_action = 'acknowledge' and report.status = 'reviewed'
        and (report.metadata -> 'aiReviewState' = '"ready"'::jsonb
          or report.metadata -> 'pendingUserReview' = 'true'::jsonb))
    )
  returning report.*;

  get diagnostics affected_rows = row_count;
  if affected_rows <> 1 then
    -- Raising rolls back statement-level backup markers as well as the write.
    raise exception using errcode = 'P0002', message = 'Parser report changed. Keep your draft and reload the latest report.';
  end if;
end;
$$;

revoke all on function public.save_parser_report_review(uuid, text, timestamptz, text, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.save_parser_report_review(uuid, text, timestamptz, text, text, text, jsonb)
  to service_role;
