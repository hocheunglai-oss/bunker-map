import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { setupNativeCcinfo, literal } from "./native-postgres-ccinfo.mjs"
export { literal, waitForBlock } from "./native-postgres-ccinfo.mjs"
export const personA = "11111111-1111-4111-8111-111111111111"
export const personB = "22222222-2222-4222-8222-222222222222"
export const personC = "33333333-3333-4333-8333-333333333333"
export const migrationPath = "supabase/migrations/20261027023034_separate_attendance_annual_confirmations.sql"
export const source = file => readFileSync(new URL(`../../${file}`, import.meta.url), "utf8")
const migration = file => source(`supabase/migrations/${file}`)
const functionSql = (file, name) => {
  const sql = source(file), start = sql.indexOf(`create or replace function ${name}(`)
  assert.ok(start >= 0, `Missing exact production function ${name}`)
  const end = sql.indexOf("$$;",start)+3
  assert.ok(end > start)
  return sql.slice(start,end)
}
// These are synthetic table declarations, not a whole-production replica.
// All changed guard/invalidation functions and the existing revision/anomaly/
// sync/audit/epoch implementations below are read from their real source.
const base = `
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create schema private;
    create table public.attendance_people (
      id uuid primary key, staff_code text not null, team text not null,
      is_active boolean not null, employment_start_date date, employment_end_date date,
      dingtalk_user_id text, admin_user_id uuid, updated_at timestamptz
    );
    create table public.attendance_raw_punches (
      id uuid primary key default gen_random_uuid(), person_id uuid, work_date date,
      source_record_key text unique, source_record_id text, dingtalk_user_id text,
      check_type text, punch_time timestamptz, source_type text, time_result text,
      location_result text, raw_payload jsonb,
      first_seen_at timestamptz not null default clock_timestamp()
    );
    create table public.attendance_leave_entries (
      id uuid primary key default gen_random_uuid(), person_id uuid, leave_date date,
      portion text, code text, source text, note text, created_by text,
      updated_by text, units numeric
    );
    create table public.attendance_manual_overrides (
      id uuid primary key default gen_random_uuid(), person_id uuid, work_date date,
      action text, raw_punch_id uuid, check_type text, punch_time timestamptz,
      reason text, created_by text, updated_by text
    );
    create table public.attendance_team_assignments (
      id uuid primary key, person_id uuid, effective_from date, effective_to date,
      updated_at timestamptz
    );
    create table public.attendance_work_mode_policies (id uuid primary key, person_id uuid, effective_from date, effective_to date);
    create table public.attendance_work_mode_overrides (
      id uuid primary key default gen_random_uuid(), person_id uuid, work_date date,
      mode text, note text, created_by text, updated_by text
    );
    create table public.attendance_monthly_adjustments (
      id uuid primary key default gen_random_uuid(), person_id uuid, year integer, month integer,
      code text, units numeric, source text, source_file_hash text, is_confirmed boolean,
      note text, created_by text, updated_by text
    );
    create table public.attendance_entitlements (
      id uuid primary key default gen_random_uuid(), person_id uuid, year integer,
      allowance_units numeric, opening_carry_forward_units numeric, source_file_hash text,
      note text, created_by text, updated_by text, unique(person_id, year)
    );
    create table public.attendance_sync_runs (
      id uuid primary key default gen_random_uuid(),
      started_at timestamptz not null default clock_timestamp(),
      completed_at timestamptz,
      window_from timestamptz not null,
      window_to timestamptz not null,
      status text not null default 'running',
      people_requested integer not null default 0,
      batches_attempted integer not null default 0,
      records_fetched integer not null default 0,
      records_inserted integer not null default 0,
      error_summary text,
      check (window_to >= window_from),
      check (status in ('running','succeeded','partial','failed')),
      check ((status='running' and completed_at is null)
        or (status<>'running' and completed_at is not null))
    );
    create table public.attendance_reminder_dispatches (id uuid primary key, status text);
    create table public.office_calendar_store (key text primary key, payload jsonb not null);
    create table public.attendance_monthly_confirmations (
      id uuid primary key default gen_random_uuid(), person_id uuid not null,
      year integer not null, month integer not null, status text not null,
      confirmed_at timestamptz, confirmed_by text, note text not null default '',
      created_by text not null, updated_by text not null,
      created_at timestamptz not null default clock_timestamp(),
      updated_at timestamptz not null default clock_timestamp(),
      unique(person_id, year, month)
    );
    create function private.touch_confirmation() returns trigger language plpgsql as $$
    begin new.updated_at = clock_timestamp(); return new; end $$;
    create trigger touch_confirmation before update on public.attendance_monthly_confirmations
    for each row execute function private.touch_confirmation();
    create function private.reset_attendance_confirmations_for_range(p_person_id uuid,p_from date,p_to date)
    returns void language plpgsql as $$
    begin
      update public.attendance_monthly_confirmations
      set status='pending',confirmed_at=null,confirmed_by=null,updated_by='source'
      where person_id=p_person_id and status='confirmed'
        and make_date(year,month,1)<=p_to
        and (make_date(year,month,1)+interval '1 month - 1 day')::date>=p_from;
    end $$;
    revoke all on function private.reset_attendance_confirmations_for_range(uuid,date,date)
    from public, anon, authenticated, service_role;
    create function private.attendance_hk_holiday_effects(p_payload jsonb)
    returns table(event_date date, attendee_codes jsonb) language sql immutable as $$
      select (entry.value->>'date')::date, coalesce(entry.value->'people','[]'::jsonb)
      from jsonb_array_elements(coalesce(p_payload->'effects','[]'::jsonb)) as entry(value)
      where extract(isodow from (entry.value->>'date')::date) between 1 and 5
    $$;
    create function private.invalidate_attendance_confirmation() returns trigger language plpgsql as $$
    begin
      perform private.reset_attendance_confirmations_for_range(
        new.person_id,new.leave_date,new.leave_date
      );
      return new;
    end $$;
    create trigger invalidate_attendance_confirmation after insert on public.attendance_leave_entries
    for each row execute function private.invalidate_attendance_confirmation();
    create function private.invalidate_attendance_work_mode_confirmation() returns trigger language plpgsql as $$
    begin
      perform private.reset_attendance_confirmations_for_range(
        new.person_id,new.work_date,new.work_date
      );
      return new;
    end $$;
    create trigger invalidate_attendance_work_mode_confirmation
    after insert on public.attendance_work_mode_overrides
    for each row execute function private.invalidate_attendance_work_mode_confirmation();
    grant select, insert, update, delete on all tables in schema public to service_role;
    insert into public.attendance_people
      (id,staff_code,team,is_active,employment_start_date,dingtalk_user_id)
    values ('${personA}','VL','BT',true,'2026-09-01','ding-a');`
export async function setupAnnualNative({ apply = true } = {}) {
  const audit = source("supabase/audit_log.sql")
  const auditEnd = audit.indexOf("$$;",audit.indexOf("create or replace function public.audit_enable_table("))+3
  const epoch = migration("20260723101257_add_backup_export_epoch.sql").split("\ndo $$")[0]
  const f = await setupNativeCcinfo(base + `
    create schema extensions;
    alter table public.attendance_raw_punches add column device_sn text;
    create schema supabase_migrations;
    create table supabase_migrations.schema_migrations(version text primary key,name text);
    insert into supabase_migrations.schema_migrations values
      ('20261014082839','attendance_confirmation_audit_context');
    grant usage on schema public,private to service_role;
    create function extensions.digest(bytea,text) returns bytea language sql immutable
      as $$ select case when $2='sha256' then pg_catalog.sha256($1) else null end $$;
    ${audit.slice(audit.indexOf("create table if not exists public.audit_logs ("),auditEnd)}
    ${epoch}
    ${functionSql("supabase/migrations/20260807091428_create_attendance_record_foundation.sql","private.set_attendance_updated_at")}
    ${functionSql("supabase/migrations/20260810034059_attendance_monthly_roster_and_reminders.sql","private.invalidate_attendance_confirmation")}
    ${functionSql("supabase/migrations/20260810082031_attendance_work_modes_and_calendar.sql","private.invalidate_attendance_work_mode_confirmation")}
    ${migration("20261014043954_attendance_confirmation_source_revision.sql")}
    ${migration("20261014044001_attendance_sync_requested_people.sql")}
    ${migration("20261014044009_attendance_dingtalk_punch_anomalies.sql")}
    ${migration("20261014044017_attendance_failed_sync_invalidation.sql")}
    ${migration("20261014052239_attendance_unresolved_sync_confirmation_guard.sql")}
    ${migration("20261014082839_attendance_confirmation_audit_context.sql")}
    ${functionSql("supabase/migrations/20260810082031_attendance_work_modes_and_calendar.sql","private.attendance_safe_iso_date")}
    ${migration("20261014032639_attendance_calendar_effective_change_invalidation.sql")}
    ${functionSql("supabase/migrations/20260806202000_complete_spc_audit_enforcement.sql","public.undo_audit_log_noncredential")}
    create trigger invalidate_attendance_calendar_confirmations after insert or update on public.office_calendar_store
      for each row execute function private.invalidate_attendance_calendar_confirmations();
    create trigger invalidate_raw_insert after insert on public.attendance_raw_punches
      for each row execute function private.invalidate_attendance_confirmation();
    alter table public.attendance_team_assignments add column team text;
    drop trigger invalidate_attendance_confirmation on public.attendance_leave_entries;
    create trigger invalidate_attendance_confirmation after insert or update or delete on public.attendance_leave_entries
      for each row execute function private.invalidate_attendance_confirmation();
    create trigger invalidate_manual_override after insert or update or delete on public.attendance_manual_overrides
      for each row execute function private.invalidate_attendance_confirmation();
    create trigger invalidate_adjustment after insert or update or delete on public.attendance_monthly_adjustments
      for each row execute function private.invalidate_attendance_confirmation();
    create trigger invalidate_assignment after insert or update or delete on public.attendance_team_assignments
      for each row execute function private.invalidate_attendance_confirmation();
    drop trigger invalidate_attendance_work_mode_confirmation on public.attendance_work_mode_overrides;
    create trigger invalidate_attendance_work_mode_confirmation after insert or update or delete on public.attendance_work_mode_overrides
      for each row execute function private.invalidate_attendance_work_mode_confirmation();
    create trigger invalidate_work_policy after insert or update or delete on public.attendance_work_mode_policies
      for each row execute function private.invalidate_attendance_work_mode_confirmation();
    create trigger bunker_map_backup_epoch_fence after insert or update or delete or truncate on public.audit_logs
      for each statement execute function private.record_bunker_map_backup_mutation();
    select public.audit_enable_table('public.attendance_monthly_confirmations');
    insert into public.attendance_people(id,staff_code,team,is_active,employment_start_date,dingtalk_user_id)
      values ('${personB}','B','BT',true,'2026-09-01','ding-b'),
        ('${personC}','C','BT',true,'2026-09-01','ding-c');
  `)
  try {
    f.revision = async () => Number(await f.owner.one("select to_jsonb(public.attendance_source_revision());"))
    f.command = async (sql, { owner = false } = {}) => {
      const session = await f.session("annual-command",!owner)
      try {
        await session.query("begin;")
        const result = await session.query(`${sql};`)
        await session.query("commit;")
        return result.length ? JSON.parse(result.at(-1)) : null
      } finally { await session.close() }
    }
    f.annual = async ({ person = personA,year = 2025,status = "confirmed",note = "",actor = "annual-editor",revision } = {}) => {
      const expected = revision ?? await f.revision()
      return f.command(`select coalesce(jsonb_agg(to_jsonb(saved)),'[]') from public.save_attendance_annual_confirmation_checked(
        ${literal(person)},${year},${literal(status)},${literal(note)},${literal(actor)},${status === "confirmed" ? expected : "null"}) saved;`)
    }
    f.monthly = async ({ person = personA,year = 2025,month = 12,status = "confirmed",note = "",actor = "monthly-editor",revision,cutoff = null } = {}) => {
      const expected = revision ?? await f.revision()
      return f.command(`select coalesce(jsonb_agg(to_jsonb(saved)),'[]') from public.save_attendance_monthly_confirmation_checked(
        ${literal(person)},${year},${month},${literal(status)},${literal(note)},${literal(actor)},${status === "confirmed" ? expected : "null"},
        ${cutoff ? literal(cutoff) : "null"}) saved;`)
    }
    f.snapshot = () => f.owner.one(`select jsonb_build_object(
      'monthly',(select coalesce(jsonb_agg(to_jsonb(t) order by person_id,year,month),'[]') from public.attendance_monthly_confirmations t),
      'annual',(select coalesce(jsonb_agg(to_jsonb(t) order by person_id,year),'[]') from public.attendance_annual_confirmations t),
      'revision',public.attendance_source_revision(),
      'audit',(select coalesce(jsonb_agg(to_jsonb(t) order by occurred_at,id),'[]') from public.audit_logs t),
      'fence',public.get_bunker_map_backup_export_fence());`)
    f.applyAnnual = async () => {
      await f.command(`${source(migrationPath)}
        insert into supabase_migrations.schema_migrations values('20261027023034','separate_attendance_annual_confirmations');`, { owner: true })
    }
    // Explicit trusted-owner synthetic state for future-year invalidation
    // tests. This is NOT a successful 2026 approval through the checked RPC.
    f.seedFutureApproval = async (person = personA, year = 2026) => {
      await f.owner.query(`begin;
        alter table public.attendance_annual_confirmations disable trigger enforce_attendance_annual_confirmation;
        insert into public.attendance_annual_confirmations(person_id,year,status,confirmed_at,confirmed_by,
          confirmed_source_revision,created_by,updated_by)
          values(${literal(person)},${year},'confirmed',clock_timestamp(),'synthetic-future-owner',${await f.revision()},'fixture','fixture')
          on conflict(person_id,year) do update set status='confirmed',confirmed_at=clock_timestamp(),
            confirmed_by='synthetic-future-owner',confirmed_source_revision=excluded.confirmed_source_revision;
        alter table public.attendance_annual_confirmations enable trigger enforce_attendance_annual_confirmation;
        commit;`)
    }
    if (apply) await f.applyAnnual()
    return f
  } catch (error) { await f.close(); throw error }
}
