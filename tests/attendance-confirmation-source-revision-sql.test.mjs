import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const { PGlite } = await import(process.env.PGLITE_MODULE_PATH || "@electric-sql/pglite")
const migration = readFileSync(new URL(
  "../supabase/migrations/20261014043954_attendance_confirmation_source_revision.sql",
  import.meta.url,
), "utf8")
const legacyWrapperMigration = readFileSync(new URL(
  "../supabase/migrations/20260807095700_harden_attendance_import_replacement.sql",
  import.meta.url,
), "utf8")
const wrapperStart = legacyWrapperMigration.indexOf("create or replace function public.apply_attendance_legacy_import(")
const legacyWrapper = legacyWrapperMigration.slice(wrapperStart)
const person = "11111111-1111-4111-8111-111111111111"

test("auto upsert rechecks a conflicting pending row after the initial read", () => {
  assert.match(migration, /on conflict \(person_id, year, month\) do update[\s\S]*?where p_auto_cutoff is null or \([\s\S]*?attendance_monthly_confirmations\.status = 'pending'[\s\S]*?attendance_monthly_confirmations\.updated_at < p_auto_cutoff/)
  assert.match(migration, /if saved\.id is not null then\s+return next saved;/)
})

async function setup({ existingConfirmed = false } = {}) {
  const db = new PGlite()
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create schema private;
    create table public.attendance_people (
      id uuid primary key, staff_code text not null, team text not null,
      is_active boolean not null, employment_start_date date, employment_end_date date,
      dingtalk_user_id text, updated_at timestamptz
    );
    create table public.attendance_raw_punches (
      id uuid primary key default gen_random_uuid(), person_id uuid, work_date date,
      source_record_key text, source_record_id text, dingtalk_user_id text,
      check_type text, punch_time timestamptz, source_type text, time_result text,
      location_result text, raw_payload jsonb
    );
    create table public.attendance_leave_entries (
      id uuid primary key default gen_random_uuid(), person_id uuid, leave_date date,
      portion text, code text, source text, note text, created_by text,
      updated_by text, units numeric
    );
    create table public.attendance_manual_overrides (id uuid primary key, person_id uuid, work_date date);
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
    create table public.attendance_sync_runs (id uuid primary key, status text);
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
    insert into public.attendance_people(id,staff_code,team,is_active,employment_start_date)
    values ('${person}','VL','BT',true,'2026-09-01');
  `)
  if (existingConfirmed) {
    await db.query(`insert into public.attendance_monthly_confirmations
      (person_id,year,month,status,confirmed_at,confirmed_by,created_by,updated_by)
      values ($1,2026,8,'confirmed',clock_timestamp(),'actor','actor','actor')`, [person])
  }
  await db.exec(migration)
  const revision = async () => Number((await db.query(
    "select public.attendance_source_revision() as value",
  )).rows[0].value)
  const save = async (expected, { month = 9, cutoff = null, status = "confirmed" } = {}) => cutoff === null
    ? db.query(
      "select * from public.save_attendance_monthly_confirmation_checked($1,$2,$3,$4,$5,$6,$7)",
      [person, 2026, month, status, "note", "actor", expected],
    )
    : db.query(
      "select * from public.save_attendance_monthly_confirmation_checked($1,$2,$3,$4,$5,$6,$7,$8)",
      [person, 2026, month, status, "note", "actor", expected, cutoff],
    )
  return { db, revision, save }
}

test("existing confirmed rows survive schema change; fresh confirmation is source checked", async () => {
  const app = await setup({ existingConfirmed: true })
  try {
    const existing = (await app.db.query(`select status,confirmed_source_revision
      from public.attendance_monthly_confirmations where month=8`)).rows[0]
    assert.equal(existing.status, "confirmed")
    assert.equal(existing.confirmed_source_revision, null)
    assert.equal(await app.revision(), 0)
    await assert.rejects(app.save(-1), /ATTENDANCE_SOURCE_CHANGED/)
    assert.equal((await app.save(0)).rows[0].status, "confirmed")
    const firstConfirmation = (await app.db.query(`select to_jsonb(c) as row
      from public.attendance_monthly_confirmations c where month=9`)).rows[0].row
    assert.equal((await app.save(0)).rows[0].id, firstConfirmation.id)
    assert.deepEqual((await app.db.query(`select to_jsonb(c) as row
      from public.attendance_monthly_confirmations c where month=9`)).rows[0].row, firstConfirmation)
    await assert.rejects(app.db.query(`select * from public.save_attendance_monthly_confirmation_checked
      ($1,2026,9,'confirmed','different note','actor',0)`, [person]),
    /ATTENDANCE_ALREADY_CONFIRMED/)
    await app.db.exec("set role service_role")
    await app.db.query(`insert into public.attendance_leave_entries(id,person_id,leave_date)
      values ('22222222-2222-4222-8222-222222222222',$1,'2026-09-10')`, [person])
    await app.db.exec("reset role")
    assert.equal(await app.revision(), 1)
    assert.equal((await app.db.query(`select status from public.attendance_monthly_confirmations
      where month=9`)).rows[0].status, "pending")
    await assert.rejects(app.save(0), /ATTENDANCE_SOURCE_CHANGED/)
    assert.equal(Number((await app.save(1)).rows[0].confirmed_source_revision), 1)
    await app.db.exec("set role service_role")
    await app.db.query(`insert into public.attendance_work_mode_overrides(id,person_id,work_date)
      values ('77777777-7777-4777-8777-777777777777',$1,'2026-09-11')`, [person])
    await app.db.exec("reset role")
    assert.equal((await app.db.query(`select status from public.attendance_monthly_confirmations
      where month=9`)).rows[0].status, "pending")
    assert.equal(await app.revision(), 2)
    assert.equal(Number((await app.save(2)).rows[0].confirmed_source_revision), 2)
    await app.db.query(`update public.attendance_people set employment_start_date='2026-09-16'
      where id=$1`, [person])
    assert.equal((await app.db.query(`select status from public.attendance_monthly_confirmations
      where month=9`)).rows[0].status, "pending")
    assert.equal(await app.revision(), 3)
    await app.save(3)
    await app.db.query("update public.attendance_people set staff_code='VX' where id=$1", [person])
    assert.equal((await app.db.query(`select status from public.attendance_monthly_confirmations
      where month=9`)).rows[0].status, "pending")
    assert.equal(await app.revision(), 4)
  } finally {
    await app.db.close()
  }
})

test("December annual summary can upgrade monthly confirmation but cannot be overwritten", async () => {
  const app = await setup()
  try {
    await app.db.query(`select * from public.save_attendance_monthly_confirmation_checked
      ($1,2025,12,'confirmed','','monthly-actor',0)`, [person])
    const upgraded = (await app.db.query(`select * from public.save_attendance_monthly_confirmation_checked
      ($1,2025,12,'confirmed','annual-summary','annual-actor',0)`, [person])).rows[0]
    assert.equal(upgraded.note, "annual-summary")
    assert.equal(upgraded.confirmed_by, "annual-actor")
    const replay = (await app.db.query(`select * from public.save_attendance_monthly_confirmation_checked
      ($1,2025,12,'confirmed','annual-summary','second-actor',0)`, [person])).rows[0]
    assert.equal(replay.confirmed_by, "annual-actor")
    await assert.rejects(app.db.query(`select * from public.save_attendance_monthly_confirmation_checked
      ($1,2025,12,'confirmed','','monthly-actor',0)`, [person]),
    /ATTENDANCE_ALREADY_CONFIRMED/)
  } finally {
    await app.db.close()
  }
})

test("auto cutoff and calendar effects are checked with the current revision", async () => {
  const app = await setup()
  try {
    await app.save(0, { status: "pending" })
    assert.equal((await app.save(0, { cutoff: "2026-10-01T00:00:00Z" })).rows.length, 0)
    await app.db.query("insert into public.office_calendar_store(key,payload) values ('event-calendar',$1::jsonb)", [JSON.stringify({ effects: [] })])
    assert.equal(await app.revision(), 1)
    await app.db.query("update public.office_calendar_store set payload=$1::jsonb where key='event-calendar'", [JSON.stringify({ effects: [], label: "renamed" })])
    assert.equal(await app.revision(), 1)
    await app.db.query("update public.office_calendar_store set payload=$1::jsonb where key='event-calendar'", [JSON.stringify({ effects: [{ date: "2026-09-15", people: ["VL"] }] })])
    assert.equal(await app.revision(), 2)
    await assert.rejects(app.save(1), /ATTENDANCE_SOURCE_CHANGED/)
    await app.db.query(`insert into public.attendance_sync_runs(id,status)
      values ('33333333-3333-4333-8333-333333333333','failed')`)
    assert.equal(await app.revision(), 3)
    await assert.rejects(app.save(2), /ATTENDANCE_SOURCE_CHANGED/)
    await app.db.query(`insert into public.attendance_reminder_dispatches(id,status)
      values ('44444444-4444-4444-8444-444444444444','sent')`)
    assert.equal(await app.revision(), 4)
    await assert.rejects(app.save(3), /ATTENDANCE_SOURCE_CHANGED/)
    assert.equal((await app.save(4, { month: 8, cutoff: "2026-10-01T00:00:00Z" })).rows[0].status, "confirmed")
  } finally {
    await app.db.close()
  }
})

test("first calendar persistence and seed fallback transitions reopen affected months", async () => {
  const app = await setup({ existingConfirmed: true })
  try {
    await app.save(0)
    await app.db.query("insert into public.office_calendar_store(key,payload) values ('event-calendar',$1::jsonb)", [JSON.stringify({ events: [] })])
    assert.equal(await app.revision(), 1)
    assert.deepEqual((await app.db.query(`select month,status from public.attendance_monthly_confirmations
      order by month`)).rows.map((row) => [row.month, row.status]), [
      [8, "confirmed"], [9, "pending"],
    ])
    await app.save(1)
    await app.db.query("update public.office_calendar_store set payload='{}'::jsonb where key='event-calendar'")
    assert.equal(await app.revision(), 2)
    assert.equal((await app.db.query(`select status from public.attendance_monthly_confirmations
      where month=9`)).rows[0].status, "pending")
    await app.save(2)
    await app.db.query("update public.office_calendar_store set payload=$1::jsonb where key='event-calendar'", [JSON.stringify({ events: [] })])
    assert.equal(await app.revision(), 3)
    assert.equal((await app.db.query(`select status from public.attendance_monthly_confirmations
      where month=9`)).rows[0].status, "pending")
  } finally {
    await app.db.close()
  }
})

test("service-only legacy import stamps confirmed rows; direct unstamped writes fail", async () => {
  const app = await setup()
  try {
    await app.db.exec(legacyWrapper)
    await app.db.exec("set role anon")
    await assert.rejects(app.db.query("select public.attendance_source_revision()"), error => error.code === "42501")
    await app.db.exec("reset role")
    await app.db.exec("set role authenticated")
    await assert.rejects(app.save(0), error => error.code === "42501")
    await app.db.exec("reset role")
    await app.db.exec("set role service_role")
    const payload = JSON.stringify({ openings: [], monthly: [{
      person_id: person, year: 2026, month: 8,
      source_key: "legacy-monthly:2026-08", statement_date: "2026-09-01",
      categories: { HOL: 1 }, is_confirmed: true,
    }] })
    await app.db.query("select public.apply_attendance_legacy_import($1::jsonb,$2,$3)", [
      payload, "a".repeat(64), "legacy-import",
    ])
    await app.db.exec("reset role")
    const imported = (await app.db.query(`select status,confirmed_source_revision
      from public.attendance_monthly_confirmations where month=8`)).rows[0]
    assert.equal(imported.status, "confirmed")
    assert.equal(Number(imported.confirmed_source_revision), await app.revision())
    await assert.rejects(app.db.query(`insert into public.attendance_monthly_confirmations
      (person_id,year,month,status,confirmed_at,confirmed_by,created_by,updated_by)
      values ($1,2026,7,'confirmed',clock_timestamp(),'actor','actor','actor')`, [person]),
    /ATTENDANCE_SOURCE_CHANGED/)
  } finally {
    await app.db.close()
  }
})

test("one-time legacy detail importer restores confirmed snapshots at its new revision", async () => {
  const app = await setup()
  try {
    await app.save(0, { month: 1 })
    await app.db.exec("set role service_role")
    await app.db.query(`select public.import_attendance_legacy_detail(
      '[]'::jsonb,'[]'::jsonb,'[]'::jsonb,'[]'::jsonb,
      'legacy-detail','2026-04-01'::date
    )`)
    await app.db.exec("reset role")
    const restored = (await app.db.query(`select status,confirmed_source_revision
      from public.attendance_monthly_confirmations where month=1`)).rows[0]
    assert.equal(restored.status, "confirmed")
    assert.equal(Number(restored.confirmed_source_revision), await app.revision())
  } finally {
    await app.db.close()
  }
})
