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
const confirmationGuardMigration = readFileSync(new URL(
  "../supabase/migrations/20261014052239_attendance_unresolved_sync_confirmation_guard.sql",
  import.meta.url,
), "utf8")

const personA = "11111111-1111-4111-8111-111111111111"
const personB = "22222222-2222-4222-8222-222222222222"
const personC = "33333333-3333-4333-8333-333333333333"

async function setup({ legacyRuns = [], legacyRaw = [], preGuardConfirmations = [] } = {}) {
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
  for (const run of legacyRuns) {
    await db.query(`insert into public.attendance_sync_runs
      (window_from,window_to,status,started_at,completed_at,
       requested_people,people_requested,failure_scope)
      values ($1,$2,$3,'2026-10-14T09:00:00Z',$4,
        $5::jsonb,$6,$7::jsonb)`, [run.from, run.to, run.status ?? 'partial',
      run.status === 'running' ? null : '2026-10-14T10:00:00Z',
      JSON.stringify(run.manifest ?? {}), run.count ?? 0,
      JSON.stringify(run.scope ?? { unknown: true, affected: [] })])
  }
  for (const raw of legacyRaw) {
    const rawId = (await db.query(`insert into public.attendance_raw_punches
      (person_id,work_date,dingtalk_user_id,source_type)
      values ($1,$2,$3,$4) returning id`,
    [raw.person, raw.date, raw.userId, raw.sourceType])).rows[0].id
    if (raw.overrideAction) {
      await db.query(`insert into public.attendance_manual_overrides
        (person_id,work_date,action,raw_punch_id,check_type,punch_time,
         reason,created_by,updated_by)
        values ($1,$2,$3,$4,$5,$6,'Reviewed identity rotation','manager','manager')`,
      [raw.person, raw.date, raw.overrideAction,
        raw.overrideAction === "exclude" ? rawId : null,
        raw.overrideAction === "replace" ? "OnDuty" : null,
        raw.overrideAction === "replace" ? "2026-09-15T01:00:00Z" : null])
    }
  }
  for (const confirmation of preGuardConfirmations) {
    const revision = Number((await db.query(
      "select revision from private.attendance_source_revision_state",
    )).rows[0].revision)
    await db.query(`insert into public.attendance_monthly_confirmations
      (person_id,year,month,status,confirmed_at,confirmed_by,
       confirmed_source_revision,note,created_by,updated_by)
      values ($1,$2,$3,'confirmed',clock_timestamp(),'manager',$4,$5,'manager','manager')`,
    [confirmation.person, confirmation.year, confirmation.month, revision,
      confirmation.note ?? ''])
  }
  await db.exec(confirmationGuardMigration)
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
    scope = { unknown: true, affected: [] },
    startedAt = "2026-10-14T09:00:00Z", completedAt = "2026-10-14T10:00:00Z",
    attempted = status === "succeeded" ? 1 : 0 }) => {
    const completed = status === "running" ? null : completedAt
    return (await db.query(`insert into public.attendance_sync_runs
      (window_from,window_to,status,started_at,completed_at,
       requested_people,people_requested,batches_attempted,failure_scope)
      values ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9::jsonb) returning id`,
    [from, to, status, startedAt, completed, JSON.stringify(manifest), count,
      attempted, JSON.stringify(scope)])).rows[0].id
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
    await assert.rejects(app.confirm(personA, 9), /ATTENDANCE_SYNC_INCOMPLETE/)
    await app.run({
      from: "2026-09-10T00:00:00Z", to: "2026-09-11T00:00:00Z",
      status: "succeeded", manifest: { [personA]: "ding-a" }, count: 1,
      startedAt: "2026-10-14T11:00:00Z", completedAt: "2026-10-14T12:00:00Z",
    })
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

test("a malformed punch blocks only the affected person's month until that day is rechecked", async () => {
  const app = await setup()
  try {
    await app.run({
      from: "2026-09-10T16:00:00Z", to: "2026-09-11T16:00:00Z",
      status: "partial", manifest: { [personA]: "ding-a" }, count: 1,
      scope: { unknown: false, affected: [{ person_id: personA, work_date: "2026-09-11" }] },
    })
    await assert.rejects(app.confirm(personA, 9), /ATTENDANCE_SYNC_INCOMPLETE/)
    await app.confirm(personB, 9)
    await app.run({
      from: "2026-09-10T16:00:00Z", to: "2026-09-11T16:00:00Z",
      status: "succeeded", manifest: { [personA]: "old-ding-a" }, count: 1,
      startedAt: "2026-10-14T11:00:00Z", completedAt: "2026-10-14T12:00:00Z",
    })
    await assert.rejects(app.confirm(personA, 9), /ATTENDANCE_SYNC_INCOMPLETE/)
    await app.run({
      from: "2026-09-10T16:00:00Z", to: "2026-09-11T16:00:00Z",
      status: "succeeded", manifest: { [personA]: "ding-a" }, count: 1,
      startedAt: "2026-10-14T11:00:00Z", completedAt: "2026-10-14T12:00:00Z",
    })
    await app.confirm(personA, 9)
    assert.deepEqual(await app.statuses(), [
      [personA, 9, "confirmed"], [personB, 9, "confirmed"],
    ])
  } finally {
    await app.db.close()
  }
})

test("an unknown failed window needs later complete coverage; an earlier success cannot clear it", async () => {
  const app = await setup()
  try {
    const manifest = { [personA]: "ding-a" }
    await app.run({
      from: "2026-09-10T16:00:00Z", to: "2026-09-12T16:00:00Z",
      status: "succeeded", manifest, count: 1,
      startedAt: "2026-10-14T07:00:00Z", completedAt: "2026-10-14T08:00:00Z",
    })
    await app.run({
      from: "2026-09-10T16:00:00Z", to: "2026-09-12T16:00:00Z",
      status: "failed", manifest, count: 1,
    })
    await assert.rejects(app.confirm(personA, 9), /ATTENDANCE_SYNC_INCOMPLETE/)
    await app.confirm(personB, 9)
    await app.run({
      from: "2026-09-10T16:00:00Z", to: "2026-09-11T16:00:00Z",
      status: "succeeded", manifest, count: 1,
      startedAt: "2026-10-14T11:00:00Z", completedAt: "2026-10-14T12:00:00Z",
    })
    await assert.rejects(app.confirm(personA, 9), /ATTENDANCE_SYNC_INCOMPLETE/)
    await app.run({
      from: "2026-09-11T16:00:00Z", to: "2026-09-12T16:00:00Z",
      status: "succeeded", manifest, count: 1,
      startedAt: "2026-10-14T11:00:00Z", completedAt: "2026-10-14T12:00:00Z",
    })
    await app.confirm(personA, 9)
    assert.deepEqual(await app.statuses(), [
      [personA, 9, "confirmed"], [personB, 9, "confirmed"],
    ])
  } finally {
    await app.db.close()
  }
})

test("a September sync failure blocks December annual approval but not December monthly approval", async () => {
  const app = await setup()
  try {
    const revision = async () => app.revision()
    const save = async (person, note) => app.db.query(`select * from
      public.save_attendance_monthly_confirmation_checked(
        $1,2025,12,'confirmed',$2,'manager',$3)`,
    [person, note, await revision()])
    await app.run({
      from: "2025-09-10T16:00:00Z", to: "2025-09-11T16:00:00Z",
      status: "partial", manifest: { [personA]: "ding-a" }, count: 1,
      scope: { unknown: false, affected: [{ person_id: personA, work_date: "2025-09-11" }] },
    })
    assert.equal((await save(personA, "")).rows[0].status, "confirmed")
    await assert.rejects(save(personA, "annual-summary"), /ATTENDANCE_SYNC_INCOMPLETE/)
    assert.equal((await save(personB, "annual-summary")).rows[0].status, "confirmed")
    await app.run({
      from: "2025-09-10T16:00:00Z", to: "2025-09-11T16:00:00Z",
      status: "succeeded", manifest: { [personA]: "ding-a" }, count: 1,
      startedAt: "2026-10-14T11:00:00Z", completedAt: "2026-10-14T12:00:00Z",
    })
    assert.equal((await save(personA, "annual-summary")).rows[0].note, "annual-summary")
  } finally {
    await app.db.close()
  }
})

test("a ledger-only partial sync leaves confirmation to the anomaly guard", async () => {
  const app = await setup()
  try {
    await app.run({
      from: "2026-09-10T16:00:00Z", to: "2026-09-11T16:00:00Z",
      status: "partial", manifest: { [personA]: "ding-a" }, count: 1,
      scope: { unknown: false, affected: [] },
    })
    await app.confirm(personA, 9)
    assert.deepEqual(await app.statuses(), [[personA, 9, "confirmed"]])
  } finally {
    await app.db.close()
  }
})

test("an unknown person on a known date blocks each staff member until their own recheck", async () => {
  const app = await setup()
  try {
    await app.run({
      from: "2026-09-10T16:00:00Z", to: "2026-09-11T16:00:00Z",
      status: "partial", manifest: { [personA]: "ding-a", [personB]: "ding-b" }, count: 2,
      scope: { unknown: false, affected: [{ person_id: null, work_date: "2026-09-11" }] },
    })
    for (const person of [personA, personB]) {
      await assert.rejects(app.confirm(person, 9), /ATTENDANCE_SYNC_INCOMPLETE/)
    }
    await app.run({
      from: "2026-09-10T16:00:00Z", to: "2026-09-11T16:00:00Z",
      status: "succeeded", manifest: { [personA]: "ding-a" }, count: 1,
      startedAt: "2026-10-14T11:00:00Z", completedAt: "2026-10-14T12:00:00Z",
    })
    await app.confirm(personA, 9)
    await assert.rejects(app.confirm(personB, 9), /ATTENDANCE_SYNC_INCOMPLETE/)
    await app.run({
      from: "2026-09-10T16:00:00Z", to: "2026-09-11T16:00:00Z",
      status: "succeeded", manifest: { [personB]: "ding-b" }, count: 1,
      startedAt: "2026-10-14T11:00:00Z", completedAt: "2026-10-14T12:00:00Z",
    })
    await app.confirm(personB, 9)
  } finally {
    await app.db.close()
  }
})

test("known unknown-person scope with a valid manifest excludes an unlinked manual-source person", async () => {
  const app = await setup()
  try {
    await app.db.query(`update public.attendance_people set dingtalk_user_id=null
      where id=$1`, [personC])
    await app.run({
      from: "2026-09-10T16:00:00Z", to: "2026-09-11T16:00:00Z",
      status: "partial", manifest: { [personA]: "ding-a" }, count: 1,
      scope: { unknown: false, affected: [{ person_id: null, work_date: "2026-09-11" }] },
    })
    await assert.rejects(app.confirm(personA, 9), /ATTENDANCE_SYNC_INCOMPLETE/)
    await app.confirm(personB, 9)
    await app.confirm(personC, 9)

    await app.run({
      from: "2025-09-10T16:00:00Z", to: "2025-09-11T16:00:00Z",
      status: "partial", manifest: { [personA]: "ding-a" }, count: 1,
      scope: { unknown: false, affected: [{ person_id: null, work_date: "2025-09-11" }] },
    })
    const annual = async (person) => app.db.query(`select * from
      public.save_attendance_monthly_confirmation_checked(
        $1,2025,12,'confirmed','annual-summary','manager',$2)`,
    [person, await app.revision()])
    await assert.rejects(annual(personA), /ATTENDANCE_SYNC_INCOMPLETE/)
    assert.equal((await annual(personC)).rows[0].status, "confirmed")
  } finally {
    await app.db.close()
  }
})

test("a bad scoped date outside the queried window cannot be silently reconfirmed", async () => {
  const app = await setup()
  try {
    await app.run({
      from: "2026-10-10T16:00:00Z", to: "2026-10-11T16:00:00Z",
      status: "partial", manifest: { [personA]: "ding-a" }, count: 1,
      scope: { unknown: false, affected: [{ person_id: personA, work_date: "2026-09-11" }] },
    })
    await assert.rejects(app.confirm(personA, 9), /ATTENDANCE_SYNC_INCOMPLETE/)
    await app.confirm(personB, 9)
    await app.run({
      from: "2026-09-10T16:00:00Z", to: "2026-09-11T16:00:00Z",
      status: "succeeded", manifest: { [personA]: "ding-a" }, count: 1,
      startedAt: "2026-10-14T11:00:00Z", completedAt: "2026-10-14T12:00:00Z",
    })
    await app.confirm(personA, 9)
  } finally {
    await app.db.close()
  }
})

test("migration skips unidentifiable legacy failures and running rows but opts in known evidence", async () => {
  const app = await setup({ legacyRuns: [
    {
      from: "2026-08-20T16:00:00Z", to: "2026-08-21T16:00:00Z",
    },
    {
      from: "2026-08-21T16:00:00Z", to: "2026-08-22T16:00:00Z",
      status: "running",
    },
    {
      from: "2026-09-10T16:00:00Z", to: "2026-09-11T16:00:00Z",
      scope: { unknown: false, affected: [{ person_id: personA, work_date: "2026-09-11" }] },
    },
    {
      from: "2026-10-10T16:00:00Z", to: "2026-10-11T16:00:00Z",
      manifest: { [personA]: "ding-a" }, count: 1,
    },
  ] })
  try {
    const flags = (await app.db.query(`select confirmation_guard_applies
      from public.attendance_sync_runs order by window_from`)).rows
      .map((row) => row.confirmation_guard_applies)
    assert.deepEqual(flags, [false, false, true, true])
    await app.confirm(personA, 8)
    await assert.rejects(app.confirm(personA, 9), /ATTENDANCE_SYNC_INCOMPLETE/)
    await assert.rejects(app.confirm(personA, 10), /ATTENDANCE_SYNC_INCOMPLETE/)
    await app.confirm(personB, 9)
    await app.confirm(personB, 10)
  } finally {
    await app.db.close()
  }
})

test("a future stuck running sync blocks until later successful rechecks cover each person", async () => {
  const app = await setup()
  try {
    await app.run({
      from: "2026-09-10T16:00:00Z", to: "2026-09-11T16:00:00Z",
      status: "running",
    })
    const flag = (await app.db.query(`select confirmation_guard_applies from
      public.attendance_sync_runs where status='running'`)).rows[0].confirmation_guard_applies
    assert.equal(flag, true)
    for (const person of [personA, personB]) {
      await assert.rejects(app.confirm(person, 9), /ATTENDANCE_SYNC_INCOMPLETE/)
    }
    await app.run({
      from: "2026-09-10T16:00:00Z", to: "2026-09-11T16:00:00Z",
      status: "succeeded", manifest: { [personA]: "ding-a" }, count: 1,
      startedAt: "2026-10-14T11:00:00Z", completedAt: "2026-10-14T12:00:00Z",
    })
    await app.confirm(personA, 9)
    await assert.rejects(app.confirm(personB, 9), /ATTENDANCE_SYNC_INCOMPLETE/)
    await app.run({
      from: "2026-09-10T16:00:00Z", to: "2026-09-11T16:00:00Z",
      status: "succeeded", manifest: { [personB]: "ding-b" }, count: 1,
      startedAt: "2026-10-14T11:00:00Z", completedAt: "2026-10-14T12:00:00Z",
    })
    await app.confirm(personB, 9)
  } finally {
    await app.db.close()
  }
})

test("new empty-manifest failures default to guarded and require each person's later recheck", async () => {
  const app = await setup()
  try {
    await app.run({
      from: "2026-09-10T16:00:00Z", to: "2026-09-11T16:00:00Z",
      status: "failed",
    })
    const flag = (await app.db.query(`select confirmation_guard_applies from
      public.attendance_sync_runs where status='failed'`)).rows[0].confirmation_guard_applies
    assert.equal(flag, true)
    for (const person of [personA, personB]) {
      await assert.rejects(app.confirm(person, 9), /ATTENDANCE_SYNC_INCOMPLETE/)
    }
    await app.run({
      from: "2026-09-10T16:00:00Z", to: "2026-09-11T16:00:00Z",
      status: "succeeded", manifest: { [personA]: "ding-a" }, count: 1,
      startedAt: "2026-10-14T11:00:00Z", completedAt: "2026-10-14T12:00:00Z",
    })
    await app.confirm(personA, 9)
    await assert.rejects(app.confirm(personB, 9), /ATTENDANCE_SYNC_INCOMPLETE/)
  } finally {
    await app.db.close()
  }
})

test("guard date bounds follow running windows, known dates, and completed success", async () => {
  const app = await setup()
  try {
    const id = await app.run({
      from: "2026-09-10T16:00:00Z", to: "2026-09-11T16:00:00Z",
      status: "running",
    })
    const period = async () => (await app.db.query(`select
      lower(confirmation_guard_period)::text as first_date,
      upper(confirmation_guard_period)::text as next_date
      from public.attendance_sync_runs where id=$1`, [id])).rows[0]
    assert.deepEqual(await period(), {
      first_date: "2026-09-11", next_date: "2026-09-12",
    })
    await app.finish(id, {
      status: "partial", manifest: { [personA]: "ding-a" }, count: 1,
      scope: { unknown: false, affected: [{ person_id: personA, work_date: "2026-10-09" }] },
    })
    assert.deepEqual(await period(), {
      first_date: "2026-10-09", next_date: "2026-10-10",
    })
    await app.finish(id, { status: "succeeded", manifest: { [personA]: "ding-a" }, count: 1 })
    assert.deepEqual(await period(), { first_date: null, next_date: null })
    const index = (await app.db.query(`select count(*)::integer as count from pg_indexes
      where schemaname='public' and indexname='attendance_sync_runs_guard_period_idx'`)).rows[0]
    assert.equal(index.count, 1)
  } finally {
    await app.db.close()
  }
})

test("migration reopens only previously confirmed months and annual rows with unresolved evidence", async () => {
  const app = await setup({
    legacyRuns: [
      {
        from: "2026-09-10T16:00:00Z", to: "2026-09-11T16:00:00Z",
        scope: { unknown: false, affected: [{ person_id: personA, work_date: "2026-09-11" }] },
      },
      {
        from: "2025-09-10T16:00:00Z", to: "2025-09-11T16:00:00Z",
        scope: { unknown: false, affected: [{ person_id: personA, work_date: "2025-09-11" }] },
      },
    ],
    preGuardConfirmations: [
      { person: personA, year: 2026, month: 9 },
      { person: personB, year: 2026, month: 9 },
      { person: personA, year: 2025, month: 12, note: "annual-summary" },
    ],
  })
  try {
    const rows = (await app.db.query(`select person_id,year,month,status,updated_by
      from public.attendance_monthly_confirmations order by year,month,person_id`)).rows
    assert.deepEqual(rows.map((row) => [row.person_id, row.year, row.month, row.status]), [
      [personA, 2025, 12, "pending"],
      [personA, 2026, 9, "pending"],
      [personB, 2026, 9, "confirmed"],
    ])
    assert.equal(rows[0].updated_by, "system:attendance-source-review")
    assert.equal(rows[1].updated_by, "system:attendance-source-review")
  } finally {
    await app.db.close()
  }
})

test("DingTalk identity guard reopens later mismatches but preserves legacy XLS history", async () => {
  const app = await setup({
    legacyRaw: [
      { person: personA, date: "2026-08-12", userId: "legacy-id", sourceType: "LEGACY_XLS" },
      { person: personA, date: "2026-09-15", userId: "old-ding-a", sourceType: "DINGTALK" },
    ],
    preGuardConfirmations: [
      { person: personA, year: 2026, month: 8 },
      { person: personA, year: 2026, month: 9 },
      { person: personA, year: 2026, month: 12, note: "annual-summary" },
    ],
  })
  try {
    assert.deepEqual(await app.statuses(), [
      [personA, 8, "confirmed"], [personA, 9, "pending"], [personA, 12, "pending"],
    ])
    await app.confirm(personA, 8)
    await assert.rejects(app.confirm(personA, 9), /ATTENDANCE_DINGTALK_IDENTITY_MISMATCH/)
    await app.db.query(`update public.attendance_people set dingtalk_user_id=null
      where id=$1`, [personA])
    await assert.rejects(app.confirm(personA, 9), /ATTENDANCE_DINGTALK_IDENTITY_MISMATCH/)
  } finally {
    await app.db.close()
  }
})

test("an audited raw exclusion clears an old-ID mismatch, but a replacement alone does not", async () => {
  const app = await setup({
    legacyRaw: [
      { person: personA, date: "2026-09-15", userId: "old-ding-a",
        sourceType: "DINGTALK", overrideAction: "exclude" },
      { person: personB, date: "2026-09-15", userId: "old-ding-b",
        sourceType: "DINGTALK", overrideAction: "replace" },
    ],
    preGuardConfirmations: [
      { person: personA, year: 2026, month: 9 },
      { person: personA, year: 2026, month: 12, note: "annual-summary" },
      { person: personB, year: 2026, month: 9 },
      { person: personB, year: 2026, month: 12, note: "annual-summary" },
    ],
  })
  try {
    assert.deepEqual(await app.statuses(), [
      [personA, 9, "confirmed"], [personA, 12, "confirmed"],
      [personB, 9, "pending"], [personB, 12, "pending"],
    ])
    await app.confirm(personA, 9)
    await app.confirm(personA, 12)
    await assert.rejects(app.confirm(personB, 9), /ATTENDANCE_DINGTALK_IDENTITY_MISMATCH/)
    await assert.rejects(app.confirm(personB, 12), /ATTENDANCE_DINGTALK_IDENTITY_MISMATCH/)
  } finally {
    await app.db.close()
  }
})

test("a failed query for an old DingTalk ID cannot be cleared by a new-ID success", async () => {
  const app = await setup()
  try {
    await app.run({
      from: "2026-09-10T16:00:00Z", to: "2026-09-11T16:00:00Z",
      status: "partial", manifest: { [personA]: "old-ding-a" }, count: 1,
      scope: { unknown: false, affected: [{ person_id: personA, work_date: "2026-09-11" }] },
    })
    await app.run({
      from: "2026-09-10T16:00:00Z", to: "2026-09-11T16:00:00Z",
      status: "succeeded", manifest: { [personA]: "ding-a" }, count: 1,
      startedAt: "2026-10-14T11:00:00Z", completedAt: "2026-10-14T12:00:00Z",
    })
    await assert.rejects(app.confirm(personA, 9), /ATTENDANCE_SYNC_INCOMPLETE/)
    await app.confirm(personB, 9)
  } finally {
    await app.db.close()
  }
})
