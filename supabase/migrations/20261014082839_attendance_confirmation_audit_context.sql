-- Attribute each checked monthly confirmation to its service actor in the same
-- transaction as the audited row write. Preserve caller audit context fields.
create or replace function public.save_attendance_monthly_confirmation_checked(
  p_person_id uuid,
  p_year integer,
  p_month integer,
  p_status text,
  p_note text,
  p_actor text,
  p_expected_revision bigint,
  p_auto_cutoff timestamptz default null
)
returns setof public.attendance_monthly_confirmations
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  current_revision bigint;
  existing public.attendance_monthly_confirmations%rowtype;
  saved public.attendance_monthly_confirmations%rowtype;
  confirmation_time timestamptz;
  audit_context jsonb;
begin
  if p_person_id is null or p_year is null or p_year not between 2000 and 2200
    or p_month is null or p_month not between 1 and 12
    or p_status is null or p_status not in ('pending', 'confirmed')
    or nullif(btrim(p_actor), '') is null
  then
    raise exception 'Invalid attendance confirmation request.';
  end if;
  if p_auto_cutoff is not null and p_status <> 'confirmed' then
    raise exception 'Auto-confirm cutoff requires confirmed status.';
  end if;

  -- RPC pending resets use the same lock order as confirmations. The conflict
  -- predicate below also protects against any direct pending insert.
  select revision into current_revision
  from private.attendance_source_revision_state
  where singleton
  for update;
  if current_revision is null then
    raise exception 'Attendance source revision is unavailable.';
  end if;

  if p_status = 'confirmed' then
    if make_date(p_year, p_month, 1) >=
      date_trunc('month', clock_timestamp() at time zone 'Asia/Hong_Kong')::date
    then
      raise exception 'Attendance can be confirmed only after the Hong Kong month has closed.';
    end if;
    if p_expected_revision is distinct from current_revision then
      raise exception using
        errcode = 'P0001',
        message = 'ATTENDANCE_SOURCE_CHANGED: Refresh attendance before confirming.';
    end if;
  end if;

  select * into existing
  from public.attendance_monthly_confirmations
  where person_id = p_person_id and year = p_year and month = p_month
  for update;

  if p_auto_cutoff is not null and existing.id is not null
    and (existing.status = 'confirmed' or existing.updated_at >= p_auto_cutoff)
  then
    return;
  end if;

  if p_status = 'confirmed' and existing.id is not null
    and existing.status = 'confirmed'
  then
    if existing.note = coalesce(p_note, '') then
      return next existing;
      return;
    end if;
    if not (p_month = 12 and coalesce(p_note, '') = 'annual-summary'
      and existing.note <> 'annual-summary')
    then
      raise exception using
        errcode = 'P0001',
        message = 'ATTENDANCE_ALREADY_CONFIRMED: Reload the attendance statement before changing a confirmation.';
    end if;
  end if;

  -- Audit context must be set inside this service-only RPC transaction. The
  -- table audit trigger skips writes without an actor, and a separate request
  -- cannot carry transaction-local settings to the confirmation write.
  audit_context := public.audit_json_setting('app.audit_context');
  if jsonb_typeof(audit_context) is distinct from 'object' then
    audit_context := '{}'::jsonb;
  end if;
  perform set_config('app.audit_actor_id', p_actor, true);
  perform set_config('app.audit_actor_name', p_actor, true);
  perform set_config(
    'app.audit_context',
    (audit_context || jsonb_strip_nulls(jsonb_build_object(
      'action', case
        when p_auto_cutoff is not null then 'attendance-auto-confirm'
        when p_status = 'pending' then 'attendance-confirmation-reset'
        else 'attendance-confirmation-save'
      end,
      'pageId', 'attendance-record',
      'personId', p_person_id,
      'year', p_year,
      'month', p_month,
      'status', p_status,
      'sourceRevision', current_revision,
      'autoCutoff', p_auto_cutoff
    )))::text,
    true
  );

  confirmation_time := case when p_status = 'confirmed' then clock_timestamp() else null end;
  insert into public.attendance_monthly_confirmations (
    person_id, year, month, status, confirmed_at, confirmed_by,
    confirmed_source_revision, note, created_by, updated_by
  ) values (
    p_person_id, p_year, p_month, p_status, confirmation_time,
    case when p_status = 'confirmed' then p_actor else null end,
    case when p_status = 'confirmed' then current_revision else null end,
    coalesce(p_note, ''), p_actor, p_actor
  )
  on conflict (person_id, year, month) do update
  set status = excluded.status,
    confirmed_at = excluded.confirmed_at,
    confirmed_by = excluded.confirmed_by,
    confirmed_source_revision = excluded.confirmed_source_revision,
    note = excluded.note,
    updated_by = excluded.updated_by
  where p_auto_cutoff is null or (
    public.attendance_monthly_confirmations.status = 'pending'
    and public.attendance_monthly_confirmations.updated_at < p_auto_cutoff
  )
  returning * into saved;

  if saved.id is not null then
    return next saved;
  end if;
end;
$$;
revoke all on function public.save_attendance_monthly_confirmation_checked(
  uuid, integer, integer, text, text, text, bigint, timestamptz
) from public, anon, authenticated, service_role;
grant execute on function public.save_attendance_monthly_confirmation_checked(
  uuid, integer, integer, text, text, text, bigint, timestamptz
) to service_role;
