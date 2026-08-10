-- Link the attendance roster to User Management, retain historical people when
-- they leave the roster, and audit monthly confirmation reminder delivery.

alter table public.attendance_people
  add column if not exists admin_user_id uuid
    references public.admin_users(id) on delete restrict;

create unique index if not exists attendance_people_admin_user_id_key
  on public.attendance_people (admin_user_id)
  where admin_user_id is not null;

-- Preserve the existing attendance group for User Management accounts that
-- previously used the ADMIN permission group. User Management owns this
-- metadata from this migration onward.
update public.admin_users as users
set
  permissions = jsonb_set(
    coalesce(users.permissions, '{}'::jsonb),
    '{__attendanceGroup}',
    to_jsonb(people.team::text),
    true
  ),
  updated_at = clock_timestamp()
from public.attendance_people as people
where people.staff_code not in ('SY', 'CD', 'HC')
  and upper(btrim(coalesce(users.display_name, ''))) = people.staff_code
  and not (coalesce(users.permissions, '{}'::jsonb) ? '__attendanceGroup');

-- Link legacy attendance identities only by the exact initials maintained in
-- User Management. Ambiguous matches are deliberately left for the ALL TIME
-- roster editor instead of guessing.
with user_candidates as (
  select
    users.id as admin_user_id,
    users.display_name,
    upper(
      case
        when coalesce(users.permissions, '{}'::jsonb) ? '__attendanceGroup'
          then case
            when users.permissions ->> '__attendanceGroup' in ('BT', 'BS', 'AC')
              then users.permissions ->> '__attendanceGroup'
            else null
          end
        when upper(users.role) in ('BT', 'BS', 'AC') then users.role
        else null
      end
    ) as attendance_team,
    upper(btrim(coalesce(users.display_name, ''))) as staff_code
  from public.admin_users as users
  where users.is_active
), unique_candidates as (
  select
    people.id as person_id,
    min(user_candidates.admin_user_id::text)::uuid as admin_user_id,
    min(user_candidates.display_name) as display_name,
    min(user_candidates.attendance_team) as attendance_team
  from public.attendance_people as people
  join user_candidates
    on user_candidates.staff_code = people.staff_code
  where people.admin_user_id is null
    and user_candidates.attendance_team in ('BT', 'BS', 'AC')
  group by people.id
  having count(*) = 1
)
update public.attendance_people as people
set
  admin_user_id = unique_candidates.admin_user_id,
  display_name = coalesce(
    nullif(btrim(unique_candidates.display_name), ''),
    people.display_name
  ),
  team = unique_candidates.attendance_team,
  updated_at = clock_timestamp()
from unique_candidates
where people.id = unique_candidates.person_id;

-- These legacy identities are no longer part of the attendance roster. Their
-- existing annual/imported history remains available in the database.
update public.attendance_people
set
  is_active = false,
  employment_end_date = least(
    coalesce(
      employment_end_date,
      date_trunc(
        'month',
        clock_timestamp() at time zone 'Asia/Hong_Kong'
      )::date - 1
    ),
    date_trunc(
      'month',
      clock_timestamp() at time zone 'Asia/Hong_Kong'
    )::date - 1
  ),
  updated_at = clock_timestamp()
where staff_code in ('SY', 'CD', 'HC')
  and (
    is_active
    or employment_end_date is null
    or employment_end_date >= date_trunc(
      'month',
      clock_timestamp() at time zone 'Asia/Hong_Kong'
    )::date
  );

-- Keep the work group that applied on each attendance date. The current value
-- on attendance_people remains a cache for roster display and DingTalk sync;
-- calculations use this effective-dated history instead.
create table if not exists public.attendance_team_assignments (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null
    references public.attendance_people(id) on delete restrict,
  team text not null,
  effective_from date not null,
  effective_to date,
  source_admin_user_id uuid
    references public.admin_users(id) on delete set null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint attendance_team_assignments_team
    check (team in ('BT', 'BS', 'AC')),
  constraint attendance_team_assignments_dates
    check (effective_to is null or effective_to >= effective_from)
);

create unique index if not exists attendance_team_assignments_open_person_key
  on public.attendance_team_assignments (person_id)
  where effective_to is null;
create index if not exists attendance_team_assignments_person_dates_idx
  on public.attendance_team_assignments (
    person_id,
    effective_from,
    effective_to
  );

-- Establish the historical baseline before enabling invalidation triggers, so
-- the migration itself does not reset imported monthly confirmations.
insert into public.attendance_team_assignments (
  person_id,
  team,
  effective_from,
  effective_to,
  source_admin_user_id
)
select
  people.id,
  people.team,
  coalesce(people.employment_start_date, date '2000-01-01'),
  people.employment_end_date,
  people.admin_user_id
from public.attendance_people as people
where not exists (
  select 1
  from public.attendance_team_assignments as assignments
  where assignments.person_id = people.id
);

create or replace function private.admin_attendance_group(
  p_permissions jsonb,
  p_role text
)
returns text
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select case
    when coalesce(p_permissions, '{}'::jsonb) ? '__attendanceGroup'
      then case
        when upper(p_permissions ->> '__attendanceGroup') in ('BT', 'BS', 'AC')
          then upper(p_permissions ->> '__attendanceGroup')
        else null
      end
    when upper(p_role) in ('BT', 'BS', 'AC') then upper(p_role)
    else null
  end;
$$;

revoke all on function private.admin_attendance_group(jsonb, text)
  from public, anon, authenticated, service_role;

create or replace function private.enforce_attendance_team_assignment()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if tg_op = 'UPDATE' then
    if new.person_id is distinct from old.person_id then
      raise exception 'An attendance group assignment cannot be moved to another person.';
    end if;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(new.person_id::text, 0)
  );

  if exists (
    select 1
    from public.attendance_team_assignments as existing
    where existing.person_id = new.person_id
      and existing.id <> new.id
      and daterange(
        existing.effective_from,
        existing.effective_to,
        '[]'
      ) && daterange(new.effective_from, new.effective_to, '[]')
  ) then
    raise exception 'Attendance group assignments cannot overlap for one person.';
  end if;

  return new;
end;
$$;

revoke all on function private.enforce_attendance_team_assignment()
  from public, anon, authenticated, service_role;

create or replace function private.enforce_attendance_person_admin_group()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
  managed_group text;
  managed_display_name text;
begin
  if new.admin_user_id is null then
    if tg_op = 'UPDATE' then
      if old.admin_user_id is not null and new.is_active then
        raise exception 'An active attendance person cannot be unlinked from User Management.';
      end if;
    end if;
    return new;
  end if;

  select
    private.admin_attendance_group(users.permissions, users.role),
    nullif(btrim(users.display_name), '')
  into managed_group, managed_display_name
  from public.admin_users as users
  where users.id = new.admin_user_id
    and users.is_active;

  if new.is_active and managed_group is null then
    raise exception 'An active attendance person requires a BT, BS, or AC User Management group.';
  end if;

  if managed_group is not null then
    new.team := managed_group;
  end if;
  if managed_display_name is not null then
    new.display_name := managed_display_name;
  end if;
  return new;
end;
$$;

revoke all on function private.enforce_attendance_person_admin_group()
  from public, anon, authenticated, service_role;

create or replace function private.sync_attendance_person_team_assignment()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
  hkt_today date := (clock_timestamp() at time zone 'Asia/Hong_Kong')::date;
  current_assignment public.attendance_team_assignments%rowtype;
  close_on date;
  start_on date;
begin
  select *
  into current_assignment
  from public.attendance_team_assignments as assignments
  where assignments.person_id = new.id
    and assignments.effective_to is null
  for update;

  if new.is_active then
    if current_assignment.id is null then
      start_on := case
        when tg_op = 'INSERT'
          then coalesce(new.employment_start_date, hkt_today)
        else hkt_today
      end;
      insert into public.attendance_team_assignments (
        person_id,
        team,
        effective_from,
        source_admin_user_id
      ) values (
        new.id,
        new.team,
        start_on,
        new.admin_user_id
      );
    elsif current_assignment.team is distinct from new.team then
      if current_assignment.effective_from > hkt_today then
        raise exception 'A future attendance group assignment must be corrected before changing the current group.';
      elsif current_assignment.effective_from = hkt_today then
        update public.attendance_team_assignments
        set
          team = new.team,
          source_admin_user_id = new.admin_user_id
        where id = current_assignment.id;
      else
        update public.attendance_team_assignments
        set effective_to = hkt_today - 1
        where id = current_assignment.id;

        insert into public.attendance_team_assignments (
          person_id,
          team,
          effective_from,
          source_admin_user_id
        ) values (
          new.id,
          new.team,
          hkt_today,
          new.admin_user_id
        );
      end if;
    end if;
  elsif current_assignment.id is not null then
    close_on := least(
      coalesce(new.employment_end_date, hkt_today - 1),
      hkt_today - 1
    );
    if current_assignment.effective_from >= hkt_today then
      delete from public.attendance_team_assignments
      where id = current_assignment.id;
    else
      update public.attendance_team_assignments
      set effective_to = greatest(current_assignment.effective_from, close_on)
      where id = current_assignment.id;
    end if;
  end if;

  return new;
end;
$$;

revoke all on function private.sync_attendance_person_team_assignment()
  from public, anon, authenticated, service_role;

create or replace function private.sync_attendance_person_from_admin_user()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
  old_group text;
  new_group text;
  hkt_yesterday date :=
    (clock_timestamp() at time zone 'Asia/Hong_Kong')::date - 1;
begin
  old_group := private.admin_attendance_group(old.permissions, old.role);
  new_group := private.admin_attendance_group(new.permissions, new.role);

  if not new.is_active or new_group is null then
    update public.attendance_people
    set
      admin_user_id = null,
      is_active = false,
      employment_end_date = least(
        coalesce(employment_end_date, hkt_yesterday),
        hkt_yesterday
      )
    where admin_user_id = new.id;
  elsif old_group is distinct from new_group
    or old.is_active is distinct from new.is_active
  then
    update public.attendance_people
    set
      team = new_group,
      display_name = coalesce(nullif(btrim(new.display_name), ''), display_name),
      is_active = true,
      employment_end_date = null
    where admin_user_id = new.id;
  elsif old.display_name is distinct from new.display_name
  then
    update public.attendance_people
    set display_name = coalesce(nullif(btrim(new.display_name), ''), display_name)
    where admin_user_id = new.id;
  end if;

  return new;
end;
$$;

revoke all on function private.sync_attendance_person_from_admin_user()
  from public, anon, authenticated, service_role;

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
  if p_person_id is null or p_from is null then
    return;
  end if;

  update public.attendance_monthly_confirmations as confirmations
  set
    status = 'pending',
    confirmed_at = null,
    confirmed_by = null,
    updated_by = actor
  where confirmations.person_id = p_person_id
    and confirmations.status = 'confirmed'
    and make_date(confirmations.year, confirmations.month, 1)
      <= coalesce(p_to, date '2200-12-31')
    and (
      make_date(confirmations.year, confirmations.month, 1)
        + interval '1 month - 1 day'
    )::date >= p_from;
end;
$$;

revoke all on function private.reset_attendance_confirmations_for_range(
  uuid,
  date,
  date
) from public, anon, authenticated, service_role;

create or replace function private.invalidate_attendance_confirmation()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
  changed_from date;
  changed_to date;
begin
  if tg_table_name = 'attendance_team_assignments' then
    if tg_op = 'INSERT' then
      perform private.reset_attendance_confirmations_for_range(
        new.person_id,
        new.effective_from,
        new.effective_to
      );
    elsif tg_op = 'DELETE' then
      perform private.reset_attendance_confirmations_for_range(
        old.person_id,
        old.effective_from,
        old.effective_to
      );
    elsif old.team is distinct from new.team then
      perform private.reset_attendance_confirmations_for_range(
        old.person_id,
        old.effective_from,
        old.effective_to
      );
      perform private.reset_attendance_confirmations_for_range(
        new.person_id,
        new.effective_from,
        new.effective_to
      );
    else
      if old.effective_from is distinct from new.effective_from then
        changed_from := least(old.effective_from, new.effective_from);
        changed_to := greatest(old.effective_from, new.effective_from) - 1;
        if changed_to >= changed_from then
          perform private.reset_attendance_confirmations_for_range(
            new.person_id,
            changed_from,
            changed_to
          );
        end if;
      end if;

      if old.effective_to is distinct from new.effective_to then
        if old.effective_to is null then
          changed_from := new.effective_to + 1;
          changed_to := null;
        elsif new.effective_to is null then
          changed_from := old.effective_to + 1;
          changed_to := null;
        else
          changed_from := least(old.effective_to, new.effective_to) + 1;
          changed_to := greatest(old.effective_to, new.effective_to);
        end if;
        perform private.reset_attendance_confirmations_for_range(
          new.person_id,
          changed_from,
          changed_to
        );
      end if;
    end if;
  elsif tg_table_name = 'attendance_raw_punches' then
    perform private.reset_attendance_confirmations_for_range(
      new.person_id,
      new.work_date,
      new.work_date
    );
  elsif tg_table_name = 'attendance_leave_entries' then
    if tg_op in ('UPDATE', 'DELETE') then
      perform private.reset_attendance_confirmations_for_range(
        old.person_id,
        old.leave_date,
        old.leave_date
      );
    end if;
    if tg_op in ('INSERT', 'UPDATE') then
      perform private.reset_attendance_confirmations_for_range(
        new.person_id,
        new.leave_date,
        new.leave_date
      );
    end if;
  elsif tg_table_name = 'attendance_manual_overrides' then
    if tg_op in ('UPDATE', 'DELETE') then
      perform private.reset_attendance_confirmations_for_range(
        old.person_id,
        old.work_date,
        old.work_date
      );
    end if;
    if tg_op in ('INSERT', 'UPDATE') then
      perform private.reset_attendance_confirmations_for_range(
        new.person_id,
        new.work_date,
        new.work_date
      );
    end if;
  elsif tg_table_name = 'attendance_monthly_adjustments' then
    if tg_op in ('UPDATE', 'DELETE') then
      perform private.reset_attendance_confirmations_for_range(
        old.person_id,
        make_date(old.year, old.month, 1),
        (make_date(old.year, old.month, 1) + interval '1 month - 1 day')::date
      );
    end if;
    if tg_op in ('INSERT', 'UPDATE') then
      perform private.reset_attendance_confirmations_for_range(
        new.person_id,
        make_date(new.year, new.month, 1),
        (make_date(new.year, new.month, 1) + interval '1 month - 1 day')::date
      );
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function private.invalidate_attendance_confirmation()
  from public, anon, authenticated, service_role;

drop trigger if exists enforce_attendance_team_assignment
  on public.attendance_team_assignments;
create trigger enforce_attendance_team_assignment
before insert or update on public.attendance_team_assignments
for each row execute function private.enforce_attendance_team_assignment();
drop trigger if exists set_attendance_team_assignments_updated_at
  on public.attendance_team_assignments;
create trigger set_attendance_team_assignments_updated_at
before update on public.attendance_team_assignments
for each row execute function private.set_attendance_updated_at();

drop trigger if exists enforce_attendance_person_admin_group
  on public.attendance_people;
create trigger enforce_attendance_person_admin_group
before insert or update of admin_user_id, team, is_active
on public.attendance_people
for each row execute function private.enforce_attendance_person_admin_group();
drop trigger if exists sync_attendance_person_team_assignment
  on public.attendance_people;
create trigger sync_attendance_person_team_assignment
after insert or update of admin_user_id, team, is_active,
  employment_start_date, employment_end_date
on public.attendance_people
for each row execute function private.sync_attendance_person_team_assignment();

drop trigger if exists sync_attendance_person_from_admin_user
  on public.admin_users;
create trigger sync_attendance_person_from_admin_user
after update of permissions, role, display_name, is_active
on public.admin_users
for each row execute function private.sync_attendance_person_from_admin_user();

drop trigger if exists invalidate_attendance_confirmation
  on public.attendance_team_assignments;
create trigger invalidate_attendance_confirmation
after insert or update or delete on public.attendance_team_assignments
for each row execute function private.invalidate_attendance_confirmation();
drop trigger if exists invalidate_attendance_confirmation
  on public.attendance_raw_punches;
create trigger invalidate_attendance_confirmation
after insert on public.attendance_raw_punches
for each row execute function private.invalidate_attendance_confirmation();
drop trigger if exists invalidate_attendance_confirmation
  on public.attendance_leave_entries;
create trigger invalidate_attendance_confirmation
after insert or update or delete on public.attendance_leave_entries
for each row execute function private.invalidate_attendance_confirmation();
drop trigger if exists invalidate_attendance_confirmation
  on public.attendance_manual_overrides;
create trigger invalidate_attendance_confirmation
after insert or update or delete on public.attendance_manual_overrides
for each row execute function private.invalidate_attendance_confirmation();
drop trigger if exists invalidate_attendance_confirmation
  on public.attendance_monthly_adjustments;
create trigger invalidate_attendance_confirmation
after insert or update or delete on public.attendance_monthly_adjustments
for each row execute function private.invalidate_attendance_confirmation();

drop trigger if exists bunker_map_backup_epoch_fence
  on public.attendance_team_assignments;
create trigger bunker_map_backup_epoch_fence
after insert or update or delete or truncate
on public.attendance_team_assignments
for each statement execute function private.record_bunker_map_backup_mutation();

alter table public.attendance_team_assignments enable row level security;

revoke all privileges on table public.attendance_team_assignments
  from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.attendance_team_assignments
  to service_role;

create table if not exists public.attendance_reminder_dispatches (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null
    references public.attendance_people(id) on delete restrict,
  year integer not null,
  month integer not null,
  status text not null default 'pending',
  requested_by text not null,
  requested_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  message_id text,
  error_code text,
  updated_at timestamptz not null default clock_timestamp(),
  constraint attendance_reminder_dispatches_year
    check (year between 2000 and 2200),
  constraint attendance_reminder_dispatches_month
    check (month between 1 and 12),
  constraint attendance_reminder_dispatches_status
    check (status in ('pending', 'sent', 'failed')),
  constraint attendance_reminder_dispatches_requested_by
    check (btrim(requested_by) <> ''),
  constraint attendance_reminder_dispatches_shape
    check (
      (
        status = 'pending'
        and completed_at is null
        and message_id is null
        and error_code is null
      )
      or (
        status = 'sent'
        and completed_at is not null
        and btrim(coalesce(message_id, '')) <> ''
        and error_code is null
      )
      or (
        status = 'failed'
        and completed_at is not null
        and message_id is null
        and btrim(coalesce(error_code, '')) <> ''
      )
    )
);

create index if not exists attendance_reminder_dispatches_period_idx
  on public.attendance_reminder_dispatches (year, month, status, requested_at desc);
create index if not exists attendance_reminder_dispatches_person_idx
  on public.attendance_reminder_dispatches (person_id, requested_at desc);

drop trigger if exists set_attendance_reminder_dispatches_updated_at
  on public.attendance_reminder_dispatches;
create trigger set_attendance_reminder_dispatches_updated_at
before update on public.attendance_reminder_dispatches
for each row execute function private.set_attendance_updated_at();

drop trigger if exists bunker_map_backup_epoch_fence
  on public.attendance_reminder_dispatches;
create trigger bunker_map_backup_epoch_fence
after insert or update or delete or truncate
on public.attendance_reminder_dispatches
for each statement execute function private.record_bunker_map_backup_mutation();

alter table public.attendance_reminder_dispatches enable row level security;

revoke all privileges on table public.attendance_reminder_dispatches
  from public, anon, authenticated, service_role;
grant select, insert, update on table public.attendance_reminder_dispatches
  to service_role;

do $$
begin
  if to_regprocedure('public.audit_enable_table(regclass)') is not null then
    perform public.audit_enable_table(
      'public.attendance_team_assignments'::regclass
    );
    perform public.audit_enable_table(
      'public.attendance_reminder_dispatches'::regclass
    );
  end if;
end;
$$;
