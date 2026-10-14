import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const { PGlite } = await import(process.env.PGLITE_MODULE_PATH || "@electric-sql/pglite")
const sourceRevisionMigration = readFileSync(new URL(
  "../supabase/migrations/20261014043954_attendance_confirmation_source_revision.sql",
  import.meta.url,
), "utf8")
const manifestMigration = readFileSync(new URL(
  "../supabase/migrations/20261014044001_attendance_sync_requested_people.sql",
  import.meta.url,
), "utf8")
const anomalyMigration = readFileSync(new URL(
  "../supabase/migrations/20261014044009_attendance_dingtalk_punch_anomalies.sql",
  import.meta.url,
), "utf8")
const migration = readFileSync(new URL(
  "../supabase/migrations/20261014044017_attendance_failed_sync_invalidation.sql",
  import.meta.url,
), "utf8")

const personA = "11111111-1111-4111-8111-111111111111"
const personB = "22222222-2222-4222-8222-222222222222"
const personC = "33333333-3333-4333-8333-333333333333"

async function setup() {
  const db = new PGlite()
  await db.exec(`
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
    values ('${personA}','VL','BT',true,'2026-09-01','ding-a');
  `)
  await db.exec(sourceRevisionMigration)
  await db.exec(manifestMigration)
  await db.exec(anomalyMigration)
  await db.exec(migration)
  await db.query(`insert into public.attendance_people
    (id,staff_code,team,is_active,employment_start_date,dingtalk_user_id)
    values ($1,'B','BT',true,'2026-09-01','ding-b'),
      ($2,'C','BT',true,'2026-09-01','ding-c')`, [personB, personC])
  const confirm = async (person, month) => {
    const revision = Number((await db.query(
      "select revision from private.attendance_source_revision_state",
    )).rows[0].revision)
    await db.query(`insert into public.attendance_monthly_confirmations
      (person_id,year,month,status,confirmed_at,confirmed_by,
       confirmed_source_revision,created_by,updated_by)
      values ($1,2026,$2,'confirmed',clock_timestamp(),'manager',$3,'manager','manager')
      on conflict(person_id,year,month) do update
      set status='confirmed',confirmed_at=clock_timestamp(),confirmed_by='manager',
        confirmed_source_revision=$3,updated_by='manager'`,
    [person, month, revision])
  }
  const run = async ({ from, to, status = "running", manifest = {}, count = 0,
    scope = { unknown: true, affected: [] } }) => {
    const completed = status === "running" ? null : "2026-10-14T10:00:00Z"
    return (await db.query(`insert into public.attendance_sync_runs
      (window_from,window_to,status,completed_at,requested_people,people_requested,failure_scope)
      values ($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb) returning id`,
    [from, to, status, completed, JSON.stringify(manifest), count,
      JSON.stringify(scope)])).rows[0].id
  }
  const finish = async (id, { status = "partial", manifest = {}, count = 0,
    scope = { unknown: true, affected: [] } } = {}) => {
    await db.query(`update public.attendance_sync_runs
      set status=$2,completed_at='2026-10-14T10:00:00Z',
        requested_people=$3::jsonb,people_requested=$4,failure_scope=$5::jsonb
      where id=$1`, [id, status, JSON.stringify(manifest), count,
        JSON.stringify(scope)])
  }
  const statuses = async () => (await db.query(`select person_id,month,status
    from public.attendance_monthly_confirmations order by person_id,month`)).rows
    .map((row) => [row.person_id, row.month, row.status])
  const revision = async () => Number((await db.query(
    "select revision from private.attendance_source_revision_state",
  )).rows[0].revision)
  return { db, confirm, run, finish, statuses, revision }
}

test("a partial sync reopens only manifested staff and overlapping Hong Kong months", async () => {
  const app = await setup()
  try {
    for (const person of [personA, personB]) {
      for (const month of [8, 9, 10]) await app.confirm(person, month)
    }
    const runId = await app.run({
      from: "2026-09-10T16:00:00Z", to: "2026-09-11T16:00:00Z",
    })
    const startedRevision = await app.revision()
    assert.ok(startedRevision > 0)
    assert.equal((await app.statuses()).filter(([, , status]) => status === "confirmed").length, 6)
    await app.finish(runId, {
      manifest: { [personA]: "ding-a" }, count: 1,
    })
    assert.ok((await app.revision()) > startedRevision)
    await assert.rejects(app.db.query(`select * from
      public.save_attendance_monthly_confirmation_checked(
        $1,2026,9,'confirmed','reviewed','manager',$2)`,
    [personA, startedRevision]), /ATTENDANCE_SOURCE_CHANGED/)
    assert.deepEqual(await app.statuses(), [
      [personA, 8, "confirmed"], [personA, 9, "pending"], [personA, 10, "confirmed"],
      [personB, 8, "confirmed"], [personB, 9, "confirmed"], [personB, 10, "confirmed"],
    ])
    assert.equal((await app.db.query(`select count(*)::integer as count
      from private.attendance_dingtalk_punch_anomalies`)).rows[0].count, 0)
  } finally {
    await app.db.close()
  }
})

test("an unknown or invalid manifest reopens all confirmed staff in its window", async () => {
  for (const manifest of [{}, { "not-a-person-id": "ding-a" }, { [personA]: "" }]) {
    const app = await setup()
    try {
      for (const person of [personA, personB]) {
        await app.confirm(person, 9)
        await app.confirm(person, 10)
      }
      await app.run({
        from: "2026-10-08T16:00:00Z", to: "2026-10-14T10:00:00Z",
        status: "failed", manifest, count: Object.keys(manifest).length,
      })
      assert.deepEqual(await app.statuses(), [
        [personA, 9, "confirmed"], [personA, 10, "pending"],
        [personB, 9, "confirmed"], [personB, 10, "pending"],
      ])
    } finally {
      await app.db.close()
    }
  }
})

test("a boundary-only failed window does not reopen the following month", async () => {
  const app = await setup()
  try {
    for (const person of [personA, personB]) {
      await app.confirm(person, 9)
      await app.confirm(person, 10)
    }
    await app.run({
      from: "2026-09-30T15:59:59Z", to: "2026-09-30T16:00:00Z",
      status: "partial", manifest: { [personA]: "ding-a" }, count: 1,
    })
    assert.deepEqual(await app.statuses(), [
      [personA, 9, "pending"], [personA, 10, "confirmed"],
      [personB, 9, "confirmed"], [personB, 10, "confirmed"],
    ])
  } finally {
    await app.db.close()
  }
})

test("an unchanged terminal run cannot reset a later reviewed confirmation", async () => {
  const app = await setup()
  try {
    await app.confirm(personA, 9)
    const runId = await app.run({
      from: "2026-09-10T00:00:00Z", to: "2026-09-11T00:00:00Z",
      status: "failed", manifest: { [personA]: "ding-a" }, count: 1,
    })
    assert.deepEqual(await app.statuses(), [[personA, 9, "pending"]])
    await app.confirm(personA, 9)
    await app.db.query(`update public.attendance_sync_runs set status='failed' where id=$1`, [runId])
    assert.deepEqual(await app.statuses(), [[personA, 9, "confirmed"]])
  } finally {
    await app.db.close()
  }
})

test("a known malformed November punch leaves October confirmations intact", async () => {
  const app = await setup()
  try {
    for (const person of [personA, personB]) {
      await app.confirm(person, 10)
      await app.confirm(person, 11)
    }
    await app.run({
      from: "2026-10-30T16:00:00Z", to: "2026-11-05T10:00:00Z",
      status: "partial", manifest: { [personA]: "ding-a" }, count: 1,
      scope: { unknown: false, affected: [{ person_id: personA, work_date: "2026-11-05" }] },
    })
    assert.deepEqual(await app.statuses(), [
      [personA, 10, "confirmed"], [personA, 11, "pending"],
      [personB, 10, "confirmed"], [personB, 11, "confirmed"],
    ])
  } finally {
    await app.db.close()
  }
})

test("an unknown person on a known date affects that date's month only", async () => {
  const app = await setup()
  try {
    for (const person of [personA, personB]) {
      await app.confirm(person, 10)
      await app.confirm(person, 11)
    }
    await app.run({
      from: "2026-10-30T16:00:00Z", to: "2026-11-05T10:00:00Z",
      status: "partial", manifest: { [personA]: "ding-a" }, count: 1,
      scope: { unknown: false, affected: [{ person_id: null, work_date: "2026-11-05" }] },
    })
    assert.deepEqual(await app.statuses(), [
      [personA, 10, "confirmed"], [personA, 11, "pending"],
      [personB, 10, "confirmed"], [personB, 11, "pending"],
    ])
  } finally {
    await app.db.close()
  }
})

test("ledger-only failures add no broad reset, while malformed scope falls back safely", async () => {
  for (const scope of [
    { unknown: false, affected: [] },
    { unknown: false, affected: [{ person_id: "not-a-uuid", work_date: "2026-11-05" }] },
    { unknown: false, affected: [{ person_id: personA, work_date: "2026-13-05" }] },
  ]) {
    const app = await setup()
    try {
      await app.confirm(personA, 10)
      await app.confirm(personA, 11)
      await app.run({
        from: "2026-10-30T16:00:00Z", to: "2026-11-05T10:00:00Z",
        status: "partial", manifest: { [personA]: "ding-a" }, count: 1, scope,
      })
      assert.deepEqual(await app.statuses(), scope.affected.length
        ? [[personA, 10, "pending"], [personA, 11, "pending"]]
        : [[personA, 10, "confirmed"], [personA, 11, "confirmed"]])
    } finally {
      await app.db.close()
    }
  }
})

test("DingTalk or linked admin identity changes reopen that person's confirmed history", async () => {
  for (const change of [
    { column: "dingtalk_user_id", value: "ding-a-new" },
    { column: "admin_user_id", value: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
  ]) {
    const app = await setup()
    try {
      for (const person of [personA, personB]) {
        await app.confirm(person, 8)
        await app.confirm(person, 9)
      }
      const before = await app.revision()
      await app.db.query(`update public.attendance_people
        set dingtalk_user_id=dingtalk_user_id where id=$1`, [personA])
      assert.deepEqual(await app.statuses(), [
        [personA, 8, "confirmed"], [personA, 9, "confirmed"],
        [personB, 8, "confirmed"], [personB, 9, "confirmed"],
      ])
      await app.db.query(`update public.attendance_people
        set ${change.column}=$2 where id=$1`, [personA, change.value])
      assert.ok((await app.revision()) > before)
      assert.deepEqual(await app.statuses(), [
        [personA, 8, "pending"], [personA, 9, "pending"],
        [personB, 8, "confirmed"], [personB, 9, "confirmed"],
      ])
    } finally {
      await app.db.close()
    }
  }
})
