-- Make each annual legacy import an authoritative replacement for the imported
-- year without touching manual attendance records.

alter function public.apply_attendance_legacy_import(jsonb, text, text)
  set schema private;

revoke all on function private.apply_attendance_legacy_import(jsonb, text, text)
  from public, anon, authenticated, service_role;

create or replace function public.apply_attendance_legacy_import(
  p_payload jsonb,
  p_source_file_hash text,
  p_actor text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  result jsonb;
begin
  if p_payload is null
    or jsonb_typeof(p_payload) <> 'object'
    or jsonb_typeof(coalesce(p_payload -> 'openings', '[]'::jsonb)) <> 'array'
    or jsonb_typeof(coalesce(p_payload -> 'monthly', '[]'::jsonb)) <> 'array'
    or jsonb_array_length(coalesce(p_payload -> 'openings', '[]'::jsonb)) > 1000
    or jsonb_array_length(coalesce(p_payload -> 'monthly', '[]'::jsonb)) > 10000
    or p_source_file_hash !~ '^[0-9a-f]{64}$'
    or btrim(coalesce(p_actor, '')) = ''
  then
    raise exception 'A valid attendance legacy-import payload is required.';
  end if;

  perform set_config('app.audit_actor_id', p_actor, true);
  perform set_config('app.audit_actor_name', p_actor, true);
  perform set_config(
    'app.audit_context',
    jsonb_build_object(
      'action', 'attendance-legacy-import-replacement',
      'pageId', 'attendance-record',
      'sourceFileHash', p_source_file_hash
    )::text,
    true
  );

  delete from public.attendance_entitlements as existing
  where existing.note like 'Imported from legacy attendance workbook (%'
    and existing.year in (
      select scope.year
      from (
        select opening.year
        from jsonb_to_recordset(coalesce(p_payload -> 'openings', '[]'::jsonb))
          as opening(year integer)
        union
        select monthly.year
        from jsonb_to_recordset(coalesce(p_payload -> 'monthly', '[]'::jsonb))
          as monthly(year integer)
      ) as scope
      where scope.year between 2000 and 2200
    );

  delete from public.attendance_monthly_adjustments as existing
  where existing.source like 'legacy-monthly:%'
    and existing.year in (
      select scope.year
      from (
        select opening.year
        from jsonb_to_recordset(coalesce(p_payload -> 'openings', '[]'::jsonb))
          as opening(year integer)
        union
        select monthly.year
        from jsonb_to_recordset(coalesce(p_payload -> 'monthly', '[]'::jsonb))
          as monthly(year integer)
      ) as scope
      where scope.year between 2000 and 2200
    );

  delete from public.attendance_monthly_confirmations as existing
  where existing.note like 'Imported from legacy monthly statement %'
    and existing.year in (
      select scope.year
      from (
        select opening.year
        from jsonb_to_recordset(coalesce(p_payload -> 'openings', '[]'::jsonb))
          as opening(year integer)
        union
        select monthly.year
        from jsonb_to_recordset(coalesce(p_payload -> 'monthly', '[]'::jsonb))
          as monthly(year integer)
      ) as scope
      where scope.year between 2000 and 2200
    );

  result := private.apply_attendance_legacy_import(
    p_payload,
    p_source_file_hash,
    p_actor
  );
  return result;
end;
$$;

revoke all on function public.apply_attendance_legacy_import(jsonb, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.apply_attendance_legacy_import(jsonb, text, text)
  to service_role;
