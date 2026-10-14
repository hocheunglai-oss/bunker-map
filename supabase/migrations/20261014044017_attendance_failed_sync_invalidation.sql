-- Persist precise failure provenance when DingTalk returned a malformed row.
-- Legacy writers remain conservative until they adopt the structured scope.
alter table public.attendance_sync_runs
  add column failure_scope jsonb not null
  default '{"unknown":true,"affected":[]}'::jsonb;

-- A completed sync can expose an invalid or unmapped upstream punch without
-- producing a raw row or a DingTalk anomaly. Reopen previously confirmed
-- affected days. An unknown failure uses the queried window instead. The
-- existing BEFORE STATEMENT source-revision trigger takes the checked
-- confirmation lock before this AFTER trigger updates confirmations.
create or replace function private.invalidate_incomplete_attendance_sync()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  first_date date;
  last_date date;
  manifest_count integer;
  manifest_valid boolean;
  affected_person uuid;
  scope_valid boolean;
  scope_unknown boolean := true;
  scope_item jsonb;
  scope_date date;
  scope_person uuid;
  scope_date_text text;
begin
  if new.status not in ('partial', 'failed') then return new; end if;
  if tg_op = 'UPDATE'
    and old.status = new.status
    and old.completed_at is not distinct from new.completed_at
    and old.window_from is not distinct from new.window_from
    and old.window_to is not distinct from new.window_to
    and old.people_requested is not distinct from new.people_requested
    and old.requested_people is not distinct from new.requested_people
    and old.failure_scope is not distinct from new.failure_scope
  then
    return new;
  end if;

  first_date := (new.window_from at time zone 'Asia/Hong_Kong')::date;
  -- Sync windows touch at whole-second endpoints. The following window owns
  -- the shared endpoint, so a failure ending exactly at a month boundary
  -- must not reopen that unrelated next month.
  last_date := ((
    case when new.window_to > new.window_from
      then new.window_to - interval '1 microsecond'
      else new.window_to end)
    at time zone 'Asia/Hong_Kong'
  )::date;

  scope_valid := jsonb_typeof(new.failure_scope) = 'object'
    and jsonb_typeof(new.failure_scope->'unknown') = 'boolean'
    and jsonb_typeof(new.failure_scope->'affected') = 'array';
  if scope_valid then
    scope_unknown := (new.failure_scope->>'unknown')::boolean;
    for scope_item in
      select value from jsonb_array_elements(new.failure_scope->'affected') as item(value)
    loop
      if jsonb_typeof(scope_item) <> 'object'
        or not (scope_item ? 'person_id')
        or jsonb_typeof(scope_item->'work_date') <> 'string'
      then
        scope_valid := false;
        exit;
      end if;
      scope_date_text := scope_item->>'work_date';
      if scope_date_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
        scope_valid := false;
        exit;
      end if;
      begin
        scope_date := scope_date_text::date;
      exception when others then
        scope_valid := false;
        exit;
      end;
      if to_char(scope_date, 'YYYY-MM-DD') <> scope_date_text then
        scope_valid := false;
        exit;
      end if;
      if jsonb_typeof(scope_item->'person_id') = 'null' then
        continue;
      end if;
      if jsonb_typeof(scope_item->'person_id') <> 'string'
        or (scope_item->>'person_id') !~*
          '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then
        scope_valid := false;
        exit;
      end if;
    end loop;
  end if;

  if scope_valid and not scope_unknown then
    -- Empty affected list means the known correction/missing-punch ledger
    -- already reopened its exact person/month. It must not reset every month
    -- touched by a broad API query.
    for scope_item in
      select value from jsonb_array_elements(new.failure_scope->'affected') as item(value)
    loop
      scope_date := (scope_item->>'work_date')::date;
      if jsonb_typeof(scope_item->'person_id') = 'null' then
        for affected_person in
          select distinct confirmation.person_id
          from public.attendance_monthly_confirmations as confirmation
          where confirmation.status = 'confirmed'
            and make_date(confirmation.year, confirmation.month, 1) <= scope_date
            and (make_date(confirmation.year, confirmation.month, 1)
              + interval '1 month - 1 day')::date >= scope_date
        loop
          perform private.reset_attendance_confirmations_for_range(
            affected_person, scope_date, scope_date
          );
        end loop;
      else
        scope_person := (scope_item->>'person_id')::uuid;
        perform private.reset_attendance_confirmations_for_range(
          scope_person, scope_date, scope_date
        );
      end if;
    end loop;
    return new;
  end if;

  select count(*)::integer,
    coalesce(bool_and(
      entry.key ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      and jsonb_typeof(entry.value) = 'string'
      and nullif(btrim(entry.value #>> '{}'), '') is not null
    ), false)
  into manifest_count, manifest_valid
  from jsonb_each(coalesce(new.requested_people, '{}'::jsonb)) as entry(key, value);
  manifest_valid := manifest_valid
    and manifest_count > 0
    and manifest_count = new.people_requested;

  if manifest_valid then
    for affected_person in
      select distinct entry.key::uuid
      from jsonb_each(new.requested_people) as entry(key, value)
    loop
      perform private.reset_attendance_confirmations_for_range(
        affected_person, first_date, last_date
      );
    end loop;
  else
    -- A failed run can have no reliable manifest (for example, roster load
    -- failed before the run was completed). Its window, rather than an
    -- invented identity, determines the conservative invalidation scope.
    for affected_person in
      select distinct confirmation.person_id
      from public.attendance_monthly_confirmations as confirmation
      where confirmation.status = 'confirmed'
        and make_date(confirmation.year, confirmation.month, 1) <= last_date
        and (make_date(confirmation.year, confirmation.month, 1)
          + interval '1 month - 1 day')::date >= first_date
    loop
      perform private.reset_attendance_confirmations_for_range(
        affected_person, first_date, last_date
      );
    end loop;
  end if;
  return new;
end;
$$;
revoke all on function private.invalidate_incomplete_attendance_sync()
  from public, anon, authenticated, service_role;

create trigger invalidate_incomplete_attendance_sync
after insert or update of status, completed_at, window_from, window_to,
  people_requested, requested_people, failure_scope on public.attendance_sync_runs
for each row execute function private.invalidate_incomplete_attendance_sync();

-- Changing DingTalk identity or the linked account invalidates every
-- historical month for that person. A newly assigned account cannot inherit
-- an old confirmation without a fresh review.
create or replace function private.invalidate_attendance_identity_change()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if old.dingtalk_user_id is distinct from new.dingtalk_user_id
    or old.admin_user_id is distinct from new.admin_user_id
  then
    perform private.reset_attendance_confirmations_for_range(
      new.id, date '2000-01-01', date '2200-12-31'
    );
  end if;
  return new;
end;
$$;
revoke all on function private.invalidate_attendance_identity_change()
  from public, anon, authenticated, service_role;

create trigger invalidate_attendance_identity_change
after update of dingtalk_user_id, admin_user_id on public.attendance_people
for each row execute function private.invalidate_attendance_identity_change();
