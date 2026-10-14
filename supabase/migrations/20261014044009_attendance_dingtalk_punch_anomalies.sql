-- DingTalk can return a changed value under a source identity that was already
-- imported. Keep the first raw punch immutable, but make later contradictory
-- observations durable and block unattended confirmation until reviewed.
-- Every source invalidation also reopens a prior annual-summary approval for
-- an affected year. Its December row represents January through December,
-- even when the changed punch or leave belongs to an earlier month.
create or replace function private.reset_attendance_confirmations_for_range(
  p_person_id uuid,
  p_from date,
  p_to date
)
returns void
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
  actor text := coalesce(
    nullif(current_setting('app.audit_actor_name', true), ''),
    nullif(current_setting('app.audit_actor_id', true), ''),
    'system:attendance-source-change'
  );
begin
  if p_person_id is null or p_from is null then return; end if;

  update public.attendance_monthly_confirmations as confirmations
  set status = 'pending', confirmed_at = null, confirmed_by = null,
    updated_by = actor
  where confirmations.person_id = p_person_id
    and confirmations.status = 'confirmed'
    and (
      (make_date(confirmations.year, confirmations.month, 1)
        <= coalesce(p_to, date '2200-12-31')
        and (make_date(confirmations.year, confirmations.month, 1)
          + interval '1 month - 1 day')::date >= p_from)
      or (confirmations.month = 12
        and confirmations.note = 'annual-summary'
        and make_date(confirmations.year, 1, 1)
          <= coalesce(p_to, date '2200-12-31')
        and make_date(confirmations.year, 12, 31) >= p_from)
    );
end;
$$;
revoke all on function private.reset_attendance_confirmations_for_range(
  uuid, date, date
) from public, anon, authenticated, service_role;

create table private.attendance_dingtalk_punch_anomalies (
  id uuid primary key default gen_random_uuid(),
  existing_raw_punch_id uuid not null
    references public.attendance_raw_punches(id) on delete restrict,
  kind text not null check (kind in ('changed-fields', 'changed-user')),
  incoming_source_record_key text not null
    check (incoming_source_record_key ~ '^[0-9a-f]{64}$'),
  incoming_source_record_id text,
  incoming_person_id uuid not null
    references public.attendance_people(id) on delete restrict,
  incoming_dingtalk_user_id text not null
    check (btrim(incoming_dingtalk_user_id) <> ''),
  incoming_check_type text not null
    check (incoming_check_type in ('OnDuty', 'OffDuty', 'Unclassified')),
  incoming_punch_time timestamptz not null,
  incoming_work_date date not null,
  first_seen_at timestamptz not null default clock_timestamp(),
  unique (
    existing_raw_punch_id, kind, incoming_source_record_key,
    incoming_person_id, incoming_dingtalk_user_id, incoming_check_type,
    incoming_punch_time, incoming_work_date
  )
);

-- Resolution is separate append-only evidence. It does not alter either raw
-- punch or the observed correction, and requires an explicit service action.
create table private.attendance_dingtalk_punch_anomaly_resolutions (
  anomaly_id uuid primary key
    references private.attendance_dingtalk_punch_anomalies(id) on delete restrict,
  resolved_at timestamptz not null default clock_timestamp(),
  resolved_by text not null check (btrim(resolved_by) <> ''),
  resolution_note text not null check (btrim(resolution_note) <> '')
);

-- A complete DingTalk requery can reveal that a previously imported punch is
-- no longer returned. Preserve that raw punch and the observation separately.
create table private.attendance_dingtalk_missing_punch_anomalies (
  id uuid primary key default gen_random_uuid(),
  existing_raw_punch_id uuid not null unique
    references public.attendance_raw_punches(id) on delete restrict,
  observed_window_from timestamptz not null,
  observed_window_to timestamptz not null,
  first_seen_at timestamptz not null default clock_timestamp(),
  check (observed_window_from <= observed_window_to)
);
create table private.attendance_dingtalk_missing_punch_resolutions (
  anomaly_id uuid primary key
    references private.attendance_dingtalk_missing_punch_anomalies(id) on delete restrict,
  resolved_at timestamptz not null default clock_timestamp(),
  resolved_by text not null check (btrim(resolved_by) <> ''),
  resolution_note text not null check (btrim(resolution_note) <> '')
);

alter table private.attendance_dingtalk_punch_anomalies enable row level security;
alter table private.attendance_dingtalk_punch_anomaly_resolutions enable row level security;
alter table private.attendance_dingtalk_missing_punch_anomalies enable row level security;
alter table private.attendance_dingtalk_missing_punch_resolutions enable row level security;
revoke all on private.attendance_dingtalk_punch_anomalies,
  private.attendance_dingtalk_punch_anomaly_resolutions,
  private.attendance_dingtalk_missing_punch_anomalies,
  private.attendance_dingtalk_missing_punch_resolutions
  from public, anon, authenticated, service_role;

create index attendance_raw_punches_source_record_id_idx
  on public.attendance_raw_punches (source_record_id)
  where source_record_id is not null;
create index attendance_dingtalk_punch_anomalies_incoming_period_idx
  on private.attendance_dingtalk_punch_anomalies
  (incoming_person_id, incoming_work_date);

create or replace function private.protect_attendance_dingtalk_punch_evidence()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  raise exception 'DingTalk punch anomaly evidence is append-only.';
end;
$$;
revoke all on function private.protect_attendance_dingtalk_punch_evidence()
  from public, anon, authenticated, service_role;

create trigger protect_attendance_dingtalk_punch_anomalies
before update or delete on private.attendance_dingtalk_punch_anomalies
for each row execute function private.protect_attendance_dingtalk_punch_evidence();
create trigger protect_attendance_dingtalk_punch_anomaly_resolutions
before update or delete on private.attendance_dingtalk_punch_anomaly_resolutions
for each row execute function private.protect_attendance_dingtalk_punch_evidence();
create trigger protect_attendance_dingtalk_missing_punch_anomalies
before update or delete on private.attendance_dingtalk_missing_punch_anomalies
for each row execute function private.protect_attendance_dingtalk_punch_evidence();
create trigger protect_attendance_dingtalk_missing_punch_resolutions
before update or delete on private.attendance_dingtalk_missing_punch_resolutions
for each row execute function private.protect_attendance_dingtalk_punch_evidence();

create or replace function public.insert_attendance_raw_punches_checked(p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  incoming record;
  existing public.attendance_raw_punches%rowtype;
  current_anomaly_id uuid;
  inserted_count integer := 0;
  anomaly_count integer := 0;
  has_open_anomaly boolean;
  anomaly_kind text;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array'
    or jsonb_array_length(p_rows) > 1000
  then
    raise exception 'Attendance raw-punch input must be an array of at most 1000 records.';
  end if;

  -- Acquire the same singleton lock as confirmation writes before touching
  -- raw rows or confirmations. An anomaly-only batch must also advance the
  -- revision, so an already-open attendance view cannot confirm stale data.
  perform private.bump_attendance_source_revision();

  for incoming in
    select * from jsonb_to_recordset(p_rows) as item(
      person_id uuid,
      source_record_key text,
      source_record_id text,
      dingtalk_user_id text,
      check_type text,
      punch_time timestamptz,
      work_date date,
      source_type text,
      device_sn text,
      time_result text,
      location_result text,
      raw_payload jsonb
    )
  loop
    if incoming.person_id is null
      or incoming.source_record_key is null
      or incoming.source_record_key !~ '^[0-9a-f]{64}$'
      or nullif(btrim(incoming.dingtalk_user_id), '') is null
      or incoming.check_type is null
      or incoming.check_type not in ('OnDuty', 'OffDuty', 'Unclassified')
      or incoming.punch_time is null or incoming.work_date is null
      or incoming.work_date is distinct from
        (incoming.punch_time at time zone 'Asia/Hong_Kong')::date
      or jsonb_typeof(incoming.raw_payload) is distinct from 'object'
      or (incoming.source_record_id is not null
        and nullif(btrim(incoming.source_record_id), '') is null)
    then
      raise exception 'Attendance raw-punch input contains invalid fields.';
    end if;

    has_open_anomaly := false;
    -- A stable source key can have changed count-affecting fields. A source
    -- record ID changing user has a different key, so check the ID as well.
    -- The revision lock serializes this comparison with other raw inserts.
    for existing in
      select * from public.attendance_raw_punches as raw
      where raw.source_record_key = incoming.source_record_key
        or (incoming.source_record_id is not null
          and raw.source_record_id = incoming.source_record_id
          and raw.dingtalk_user_id <> incoming.dingtalk_user_id)
      order by raw.first_seen_at, raw.id
    loop
      if existing.source_record_key = incoming.source_record_key then
        if existing.person_id is not distinct from incoming.person_id
          and existing.dingtalk_user_id is not distinct from incoming.dingtalk_user_id
          and existing.check_type is not distinct from incoming.check_type
          and existing.punch_time is not distinct from incoming.punch_time
          and existing.work_date is not distinct from incoming.work_date
        then
          -- Non-counting device/location/result metadata may change upstream;
          -- keep the first restricted raw snapshot without an anomaly.
          continue;
        end if;
        anomaly_kind := 'changed-fields';
      else
        anomaly_kind := 'changed-user';
      end if;

      insert into private.attendance_dingtalk_punch_anomalies (
        existing_raw_punch_id, kind, incoming_source_record_key,
        incoming_source_record_id, incoming_person_id,
        incoming_dingtalk_user_id, incoming_check_type,
        incoming_punch_time, incoming_work_date
      ) values (
        existing.id, anomaly_kind, incoming.source_record_key,
        incoming.source_record_id, incoming.person_id,
        incoming.dingtalk_user_id, incoming.check_type,
        incoming.punch_time, incoming.work_date
      )
      on conflict (
        existing_raw_punch_id, kind, incoming_source_record_key,
        incoming_person_id, incoming_dingtalk_user_id, incoming_check_type,
        incoming_punch_time, incoming_work_date
      ) do nothing
      returning id into current_anomaly_id;

      if current_anomaly_id is null then
        select observed.id into current_anomaly_id
        from private.attendance_dingtalk_punch_anomalies as observed
        where observed.existing_raw_punch_id = existing.id
          and observed.kind = anomaly_kind
          and observed.incoming_source_record_key = incoming.source_record_key
          and observed.incoming_person_id = incoming.person_id
          and observed.incoming_dingtalk_user_id = incoming.dingtalk_user_id
          and observed.incoming_check_type = incoming.check_type
          and observed.incoming_punch_time = incoming.punch_time
          and observed.incoming_work_date = incoming.work_date;
      end if;

      if not exists (
        select 1 from private.attendance_dingtalk_punch_anomaly_resolutions as resolution
        where resolution.anomaly_id = current_anomaly_id
      ) then
        has_open_anomaly := true;
        perform private.reset_attendance_confirmations_for_range(
          existing.person_id, existing.work_date, existing.work_date
        );
        perform private.reset_attendance_confirmations_for_range(
          incoming.person_id, incoming.work_date, incoming.work_date
        );
      end if;
      current_anomaly_id := null;
    end loop;

    if has_open_anomaly then
      anomaly_count := anomaly_count + 1;
      continue;
    end if;

    -- An exact duplicate must stay a no-op. A reviewed source correction also
    -- stays out of raw punches: its manual override is the counted evidence.
    if exists (
      select 1 from public.attendance_raw_punches
      where source_record_key = incoming.source_record_key
        or (incoming.source_record_id is not null
          and source_record_id = incoming.source_record_id
          and dingtalk_user_id <> incoming.dingtalk_user_id)
    ) then
      continue;
    end if;

    insert into public.attendance_raw_punches (
      person_id, source_record_key, source_record_id, dingtalk_user_id,
      check_type, punch_time, work_date, source_type, device_sn,
      time_result, location_result, raw_payload
    ) values (
      incoming.person_id, incoming.source_record_key,
      incoming.source_record_id, incoming.dingtalk_user_id,
      incoming.check_type, incoming.punch_time, incoming.work_date,
      incoming.source_type, incoming.device_sn, incoming.time_result,
      incoming.location_result, incoming.raw_payload
    );
    inserted_count := inserted_count + 1;
  end loop;

  return jsonb_build_object(
    'inserted_count', inserted_count,
    'anomaly_count', anomaly_count
  );
end;
$$;
revoke all on function public.insert_attendance_raw_punches_checked(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.insert_attendance_raw_punches_checked(jsonb)
  to service_role;

-- Keep an older deployed sync caller on the protected path during rollout.
-- Its integer result remains compatible; the persistent anomaly still reopens
-- the month and blocks later automatic confirmation.
create or replace function public.insert_attendance_raw_punches(p_rows jsonb)
returns integer
language sql
security definer
set search_path = pg_catalog, pg_temp
as $$
  select (public.insert_attendance_raw_punches_checked(p_rows)->>'inserted_count')::integer;
$$;
revoke all on function public.insert_attendance_raw_punches(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.insert_attendance_raw_punches(jsonb)
  to service_role;

-- Invoke only after the exact DingTalk batch returned successfully and every
-- returned record normalized. The database cannot infer API completeness; the
-- p_complete assertion makes an accidental partial-call fail closed.
create or replace function public.reconcile_attendance_dingtalk_punch_window(
  p_requested_users jsonb,
  p_window_from timestamptz,
  p_window_to timestamptz,
  p_returned_source_keys text[],
  p_complete boolean
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  requested record;
  old_punch public.attendance_raw_punches%rowtype;
  current_anomaly_id uuid;
  seen_person_ids uuid[] := array[]::uuid[];
  seen_user_ids text[] := array[]::text[];
  missing_count integer := 0;
begin
  if p_complete is distinct from true
    or p_requested_users is null
    or jsonb_typeof(p_requested_users) <> 'array'
    or jsonb_array_length(p_requested_users) not between 1 and 50
    or p_window_from is null or p_window_to is null
    or p_window_from > p_window_to
    or p_window_to - p_window_from > interval '7 days'
    or p_returned_source_keys is null
    or exists (
      select 1 from unnest(p_returned_source_keys) as key(value)
      where key.value is null or key.value !~ '^[0-9a-f]{64}$'
    )
  then
    raise exception 'A complete DingTalk batch, exact users, window and source keys are required.';
  end if;

  -- This lock serializes omission detection with checked inserts and monthly
  -- confirmation writes. Even a zero-omission observation invalidates a
  -- previously loaded attendance snapshot.
  perform private.bump_attendance_source_revision();

  for requested in
    select * from jsonb_to_recordset(p_requested_users) as item(
      person_id uuid, dingtalk_user_id text
    )
  loop
    if requested.person_id is null
      or nullif(btrim(requested.dingtalk_user_id), '') is null
      or requested.person_id = any(seen_person_ids)
      or requested.dingtalk_user_id = any(seen_user_ids)
      or not exists (
        select 1 from public.attendance_people as person
        where person.id = requested.person_id
          and person.dingtalk_user_id = requested.dingtalk_user_id
      )
    then
      raise exception 'DingTalk requested-user manifest does not match current attendance linkage.';
    end if;
    seen_person_ids := array_append(seen_person_ids, requested.person_id);
    seen_user_ids := array_append(seen_user_ids, requested.dingtalk_user_id);

    for old_punch in
      select * from public.attendance_raw_punches as raw
      where raw.person_id = requested.person_id
        and raw.dingtalk_user_id = requested.dingtalk_user_id
        -- Historical spreadsheet rows sometimes retained the person's live
        -- DingTalk ID. They were never returned by this API and cannot be
        -- evidence of a deleted DingTalk record.
        and raw.source_type is distinct from 'LEGACY_XLS'
        and (raw.source_record_id is null
          or raw.source_record_id not like 'legacy-xls:%')
        and raw.dingtalk_user_id not like 'legacy-xls:%'
        and raw.punch_time >= p_window_from
        -- Adjacent month-requery windows share an endpoint. Assign it to the
        -- next window regardless of the upstream end-boundary convention.
        and raw.punch_time < p_window_to
        and raw.source_record_key <> all(p_returned_source_keys)
      order by raw.punch_time, raw.id
    loop
      insert into private.attendance_dingtalk_missing_punch_anomalies (
        existing_raw_punch_id, observed_window_from, observed_window_to
      ) values (old_punch.id, p_window_from, p_window_to)
      on conflict (existing_raw_punch_id) do nothing
      returning id into current_anomaly_id;

      if current_anomaly_id is null then
        select missing.id into current_anomaly_id
        from private.attendance_dingtalk_missing_punch_anomalies as missing
        where missing.existing_raw_punch_id = old_punch.id;
      end if;

      if not exists (
        select 1 from private.attendance_dingtalk_missing_punch_resolutions as resolution
        where resolution.anomaly_id = current_anomaly_id
      ) then
        missing_count := missing_count + 1;
        perform private.reset_attendance_confirmations_for_range(
          old_punch.person_id, old_punch.work_date, old_punch.work_date
        );
      end if;
      current_anomaly_id := null;
    end loop;
  end loop;

  return jsonb_build_object('missing_count', missing_count);
end;
$$;
revoke all on function public.reconcile_attendance_dingtalk_punch_window(
  jsonb, timestamptz, timestamptz, text[], boolean
) from public, anon, authenticated, service_role;
grant execute on function public.reconcile_attendance_dingtalk_punch_window(
  jsonb, timestamptz, timestamptz, text[], boolean
) to service_role;

create or replace function public.attendance_open_dingtalk_punch_anomaly_count(
  p_person_id uuid, p_year integer, p_month integer
)
returns integer
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  month_from date;
  month_to date;
  open_count integer;
begin
  if p_person_id is null or p_year is null or p_year not between 2000 and 2200
    or p_month is null or p_month not between 1 and 12
  then
    raise exception 'Invalid attendance anomaly period.';
  end if;
  month_from := make_date(p_year, p_month, 1);
  month_to := (month_from + interval '1 month')::date;
  select count(*)::integer into open_count from (
    select anomaly.id
    from private.attendance_dingtalk_punch_anomalies as anomaly
    join public.attendance_raw_punches as raw
      on raw.id = anomaly.existing_raw_punch_id
    left join private.attendance_dingtalk_punch_anomaly_resolutions as resolution
      on resolution.anomaly_id = anomaly.id
    where resolution.anomaly_id is null
      and ((raw.person_id = p_person_id
        and raw.work_date >= month_from and raw.work_date < month_to)
        or (anomaly.incoming_person_id = p_person_id
          and anomaly.incoming_work_date >= month_from
          and anomaly.incoming_work_date < month_to))
    union all
    select missing.id
    from private.attendance_dingtalk_missing_punch_anomalies as missing
    join public.attendance_raw_punches as raw
      on raw.id = missing.existing_raw_punch_id
    left join private.attendance_dingtalk_missing_punch_resolutions as resolution
      on resolution.anomaly_id = missing.id
    where resolution.anomaly_id is null
      and raw.person_id = p_person_id
      and raw.work_date >= month_from and raw.work_date < month_to
  ) as open_anomalies;
  return open_count;
end;
$$;
revoke all on function public.attendance_open_dingtalk_punch_anomaly_count(
  uuid, integer, integer
) from public, anon, authenticated, service_role;
grant execute on function public.attendance_open_dingtalk_punch_anomaly_count(
  uuid, integer, integer
) to service_role;

-- Manual confirmation must obey the same evidence block as unattended
-- confirmation. Pending resets continue to work while a source anomaly is
-- open. The row lock serializes this check with anomaly insertion.
create or replace function private.block_open_dingtalk_punch_confirmation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if new.status <> 'confirmed' then return new; end if;
  perform 1 from private.attendance_source_revision_state where singleton for update;
  if not found then
    raise exception 'Attendance source revision is unavailable.';
  end if;
  -- A December annual-summary confirmation approves the entire year. An
  -- unresolved punch in any of its months must block that approval, while an
  -- ordinary monthly confirmation checks only its own month.
  if exists (
    select 1
    from generate_series(
      case when new.month = 12 and new.note = 'annual-summary'
        then 1 else new.month end,
      new.month
    ) as checked_month(month_number)
    where public.attendance_open_dingtalk_punch_anomaly_count(
      new.person_id, new.year, checked_month.month_number
    ) > 0
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'ATTENDANCE_DINGTALK_ANOMALY_OPEN: Review the source punch discrepancy before confirming.';
  end if;
  return new;
end;
$$;
revoke all on function private.block_open_dingtalk_punch_confirmation()
  from public, anon, authenticated, service_role;
create trigger zz_block_open_dingtalk_punch_confirmation
before insert or update on public.attendance_monthly_confirmations
for each row execute function private.block_open_dingtalk_punch_confirmation();

create or replace function public.resolve_attendance_dingtalk_punch_anomaly(
  p_anomaly_id uuid, p_actor text, p_resolution_note text
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if p_anomaly_id is null or nullif(btrim(p_actor), '') is null
    or nullif(btrim(p_resolution_note), '') is null
  then
    raise exception 'An anomaly, reviewer and resolution note are required.';
  end if;
  perform private.bump_attendance_source_revision();
  insert into private.attendance_dingtalk_punch_anomaly_resolutions (
    anomaly_id, resolved_by, resolution_note
  ) values (p_anomaly_id, p_actor, p_resolution_note)
  on conflict (anomaly_id) do nothing;
  return found;
end;
$$;
revoke all on function public.resolve_attendance_dingtalk_punch_anomaly(
  uuid, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.resolve_attendance_dingtalk_punch_anomaly(
  uuid, text, text
) to service_role;

create or replace function public.resolve_attendance_dingtalk_missing_punch_anomaly(
  p_anomaly_id uuid, p_actor text, p_resolution_note text
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if p_anomaly_id is null or nullif(btrim(p_actor), '') is null
    or nullif(btrim(p_resolution_note), '') is null
  then
    raise exception 'An anomaly, reviewer and resolution note are required.';
  end if;
  perform private.bump_attendance_source_revision();
  insert into private.attendance_dingtalk_missing_punch_resolutions (
    anomaly_id, resolved_by, resolution_note
  ) values (p_anomaly_id, p_actor, p_resolution_note)
  on conflict (anomaly_id) do nothing;
  return found;
end;
$$;
revoke all on function public.resolve_attendance_dingtalk_missing_punch_anomaly(
  uuid, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.resolve_attendance_dingtalk_missing_punch_anomaly(
  uuid, text, text
) to service_role;
