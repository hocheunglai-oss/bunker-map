-- A recipient that was previously resolved can disappear from a later
-- certified projection. Keep its stable FCUNO kind/id as forensic evidence,
-- mark it missing, and continue to fail closed for insertion.

create or replace function public.is_valid_outlook_template_recipient_resolution(
  p_resolution jsonb
)
returns boolean
language plpgsql
immutable
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
  field_name text;
  ref_record record;
  ref_value jsonb;
  ref_status text;
  ref_kind text;
  total_count bigint := 0;
  resolved_count bigint := 0;
  external_count bigint := 0;
  ambiguous_count bigint := 0;
  missing_count bigint := 0;
  recorded_total bigint;
  recorded_resolved bigint;
  recorded_external bigint;
  recorded_ambiguous bigint;
  recorded_missing bigint;
begin
  if jsonb_typeof(p_resolution) is distinct from 'object'
    or p_resolution ->> 'schema'
      is distinct from 'fcuno.outlook-template-recipient-resolution/v1'
    or coalesce(p_resolution ->> 'certificationRunId', '')
      !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or coalesce(p_resolution ->> 'certifiedAt', '')
      !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
    or coalesce(p_resolution ->> 'resolvedAt', '')
      !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
    or coalesce(p_resolution ->> 'sourceFingerprint', '')
      !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(p_resolution -> 'refs') is distinct from 'object'
    or jsonb_typeof(p_resolution -> 'counts') is distinct from 'object'
    or (
      p_resolution - array[
        'schema',
        'certificationRunId',
        'certifiedAt',
        'sourceFingerprint',
        'resolvedAt',
        'refs',
        'counts',
        'reconciliationRequired'
      ]
    ) <> '{}'::jsonb
    or (
      (p_resolution -> 'refs') - array['to', 'cc', 'bcc']
    ) <> '{}'::jsonb
    or (
      (p_resolution -> 'counts') - array[
        'total',
        'resolved',
        'external',
        'ambiguous',
        'missing'
      ]
    ) <> '{}'::jsonb
  then
    return false;
  end if;

  if p_resolution ? 'reconciliationRequired'
    and jsonb_typeof(p_resolution -> 'reconciliationRequired')
      is distinct from 'boolean'
  then
    return false;
  end if;

  if coalesce(p_resolution #>> '{counts,total}', '')
      !~ '^(0|[1-9][0-9]*)$'
    or coalesce(p_resolution #>> '{counts,resolved}', '')
      !~ '^(0|[1-9][0-9]*)$'
    or coalesce(p_resolution #>> '{counts,external}', '')
      !~ '^(0|[1-9][0-9]*)$'
    or coalesce(p_resolution #>> '{counts,ambiguous}', '')
      !~ '^(0|[1-9][0-9]*)$'
    or coalesce(p_resolution #>> '{counts,missing}', '')
      !~ '^(0|[1-9][0-9]*)$'
  then
    return false;
  end if;

  if (p_resolution #>> '{counts,total}')::numeric > 10000
    or (p_resolution #>> '{counts,resolved}')::numeric > 10000
    or (p_resolution #>> '{counts,external}')::numeric > 10000
    or (p_resolution #>> '{counts,ambiguous}')::numeric > 10000
    or (p_resolution #>> '{counts,missing}')::numeric > 10000
  then
    return false;
  end if;

  recorded_total := (p_resolution #>> '{counts,total}')::bigint;
  recorded_resolved := (p_resolution #>> '{counts,resolved}')::bigint;
  recorded_external := (p_resolution #>> '{counts,external}')::bigint;
  recorded_ambiguous := (p_resolution #>> '{counts,ambiguous}')::bigint;
  recorded_missing := (p_resolution #>> '{counts,missing}')::bigint;

  foreach field_name in array array['to', 'cc', 'bcc']
  loop
    if jsonb_typeof(p_resolution #> array['refs', field_name])
      is distinct from 'array'
    then
      return false;
    end if;

    for ref_record in
      select item.value, item.ordinality
      from jsonb_array_elements(
        p_resolution #> array['refs', field_name]
      ) with ordinality as item(value, ordinality)
    loop
      ref_value := ref_record.value;
      if jsonb_typeof(ref_value) is distinct from 'object'
        or (
          ref_value - array[
            'field',
            'position',
            'literal',
            'displayName',
            'sourceValue',
            'kind',
            'sourceId',
            'resolvedAddress',
            'status'
          ]
        ) <> '{}'::jsonb
        or ref_value ->> 'field' is distinct from field_name
        or coalesce(ref_value ->> 'position', '')
          !~ '^(0|[1-9][0-9]*)$'
        or (ref_value ->> 'position')::numeric
          <> ref_record.ordinality - 1
        or jsonb_typeof(ref_value -> 'literal') is distinct from 'string'
        or nullif(btrim(ref_value ->> 'literal'), '') is null
        or jsonb_typeof(ref_value -> 'displayName') is distinct from 'string'
        or jsonb_typeof(ref_value -> 'sourceValue') is distinct from 'string'
      then
        return false;
      end if;

      ref_status := ref_value ->> 'status';
      ref_kind := ref_value ->> 'kind';
      if ref_status not in ('resolved', 'external', 'ambiguous', 'missing')
        or ref_kind not in ('contact', 'group', 'external', 'unresolved')
      then
        return false;
      end if;

      if ref_status = 'resolved' then
        if ref_kind not in ('contact', 'group')
          or nullif(btrim(ref_value ->> 'sourceId'), '') is null
          or coalesce(ref_value ->> 'resolvedAddress', '')
            !~* '^[^@[:space:]]+@[^@[:space:]]+$'
        then
          return false;
        end if;
        resolved_count := resolved_count + 1;
      elsif ref_status = 'external' then
        if ref_kind <> 'external'
          or (
            ref_value ? 'sourceId'
            and jsonb_typeof(ref_value -> 'sourceId') <> 'null'
          )
          or coalesce(ref_value ->> 'resolvedAddress', '')
            !~* '^[^@[:space:]]+@[^@[:space:]]+$'
        then
          return false;
        end if;
        external_count := external_count + 1;
      elsif ref_status = 'ambiguous' then
        if ref_kind <> 'unresolved'
          or (
            ref_value ? 'sourceId'
            and jsonb_typeof(ref_value -> 'sourceId') <> 'null'
          )
          or (
            ref_value ? 'resolvedAddress'
            and jsonb_typeof(ref_value -> 'resolvedAddress')
              not in ('string', 'null')
          )
        then
          return false;
        end if;
        ambiguous_count := ambiguous_count + 1;
      else
        if (
          ref_kind = 'unresolved'
          and ref_value ? 'sourceId'
          and jsonb_typeof(ref_value -> 'sourceId') <> 'null'
        )
          or (
            ref_kind in ('contact', 'group')
            and nullif(btrim(ref_value ->> 'sourceId'), '') is null
          )
          or ref_kind = 'external'
          or (
            ref_value ? 'resolvedAddress'
            and jsonb_typeof(ref_value -> 'resolvedAddress') <> 'null'
          )
        then
          return false;
        end if;
        missing_count := missing_count + 1;
      end if;

      total_count := total_count + 1;
      if total_count > 10000 then
        return false;
      end if;
    end loop;
  end loop;

  return recorded_total = total_count
    and recorded_resolved = resolved_count
    and recorded_external = external_count
    and recorded_ambiguous = ambiguous_count
    and recorded_missing = missing_count
    and recorded_total =
      recorded_resolved
      + recorded_external
      + recorded_ambiguous
      + recorded_missing;
exception
  when others then
    return false;
end;
$$;

revoke all on function
  public.is_valid_outlook_template_recipient_resolution(jsonb)
  from public, anon, authenticated;
grant execute on function
  public.is_valid_outlook_template_recipient_resolution(jsonb)
  to service_role;
