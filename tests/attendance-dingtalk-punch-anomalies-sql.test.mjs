import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const { PGlite } = await import(process.env.PGLITE_MODULE_PATH || "@electric-sql/pglite")
const migration = readFileSync(new URL(
  "../supabase/migrations/20261014044009_attendance_dingtalk_punch_anomalies.sql",
  import.meta.url,
), "utf8")

const personA = "11111111-1111-4111-8111-111111111111"
const personB = "22222222-2222-4222-8222-222222222222"
const key = (letter) => letter.repeat(64)
const punch = (overrides = {}) => ({
  person_id: personA,
  source_record_key: key("a"),
  source_record_id: "source-1",
  dingtalk_user_id: "ding-a",
  check_type: "OnDuty",
  punch_time: "2026-09-10T02:00:00Z",
  work_date: "2026-09-10",
  source_type: "ATM",
  device_sn: "device-1",
  time_result: "Normal",
  location_result: "Inside",
  raw_payload: { id: "source-1" },
  ...overrides,
})

async function setup() {
  const db = new PGlite()
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create schema private;
    create table public.attendance_people (
      id uuid primary key, dingtalk_user_id text unique
    );
    create table public.attendance_raw_punches (
      id uuid primary key default gen_random_uuid(),
      person_id uuid not null references public.attendance_people(id),
      source_record_key text not null unique,
      source_record_id text,
      dingtalk_user_id text not null,
      check_type text not null,
      punch_time timestamptz not null,
      work_date date not null,
      source_type text,
      device_sn text,
      time_result text,
      location_result text,
      raw_payload jsonb not null,
      first_seen_at timestamptz not null default clock_timestamp()
    );
    create table public.attendance_monthly_confirmations (
      person_id uuid not null, year integer not null, month integer not null,
      status text not null, note text not null default '',
      confirmed_at timestamptz, confirmed_by text,
      updated_by text, primary key(person_id,year,month)
    );
    create table private.attendance_source_revision_state (
      singleton boolean primary key, revision bigint not null
    );
    insert into private.attendance_source_revision_state values (true,0);
    create function private.bump_attendance_source_revision() returns void
    language plpgsql security definer as $$
    begin
      update private.attendance_source_revision_state
      set revision=revision+1 where singleton;
    end $$;
    create function private.reset_attendance_confirmations_for_range(
      p_person_id uuid,p_from date,p_to date
    ) returns void language plpgsql security definer as $$
    begin
      update public.attendance_monthly_confirmations
      set status='pending',confirmed_at=null,confirmed_by=null,updated_by='source'
      where person_id=p_person_id and status='confirmed'
        and make_date(year,month,1)<=p_to
        and (make_date(year,month,1)+interval '1 month - 1 day')::date>=p_from;
    end $$;
    revoke all on function private.bump_attendance_source_revision() from public;
    revoke all on function private.reset_attendance_confirmations_for_range(uuid,date,date) from public;
    create function private.protect_raw() returns trigger language plpgsql as $$
    begin raise exception 'Raw punches are immutable.'; end $$;
    create trigger protect_raw before update or delete on public.attendance_raw_punches
    for each row execute function private.protect_raw();
    insert into public.attendance_people values
      ('${personA}','ding-a'),('${personB}','ding-b');
  `)
  await db.exec(migration)
  const insert = async (rows) => (await db.query(
    "select public.insert_attendance_raw_punches_checked($1::jsonb) as result",
    [JSON.stringify(rows)],
  )).rows[0].result
  const reconcile = async ({ users = [{ person_id: personA, dingtalk_user_id: "ding-a" }],
    from = "2026-09-01T00:00:00Z", to = "2026-09-30T23:59:59Z",
    keys = [], complete = true } = {}) => (await db.query(
    `select public.reconcile_attendance_dingtalk_punch_window(
      $1::jsonb,$2::timestamptz,$3::timestamptz,$4::text[],$5::boolean
    ) as result`,
    [JSON.stringify(users), from, to, keys, complete],
  )).rows[0].result
  const openCount = async (person, month) => Number((await db.query(
    "select public.attendance_open_dingtalk_punch_anomaly_count($1,2026,$2) as count",
    [person, month],
  )).rows[0].count)
  const revision = async () => Number((await db.query(
    "select revision from private.attendance_source_revision_state",
  )).rows[0].revision)
  return { db, insert, reconcile, openCount, revision }
}

test("changed punch fields remain append-only, reopen both months, and block repeat confirmation", async () => {
  const app = await setup()
  try {
    assert.deepEqual(await app.insert([punch()]), { inserted_count: 1, anomaly_count: 0 })
    const original = (await app.db.query(
      "select to_jsonb(raw) as row from public.attendance_raw_punches as raw",
    )).rows[0].row
    await app.db.query(`insert into public.attendance_monthly_confirmations
      (person_id,year,month,status,note,confirmed_at,confirmed_by,updated_by)
      values ($1,2026,9,'confirmed','monthly',now(),'manager','manager'),
        ($1,2026,10,'confirmed','monthly',now(),'manager','manager'),
        ($1,2026,12,'confirmed','annual-summary',now(),'manager','manager')`, [personA])

    // Non-counting metadata is harmless and preserves the initial snapshot.
    assert.deepEqual(await app.insert([punch({ device_sn: "new-device", raw_payload: { id: "source-1", changed: true } })]),
      { inserted_count: 0, anomaly_count: 0 })
    assert.equal(await app.openCount(personA, 9), 0)

    const correction = punch({
      check_type: "OffDuty", punch_time: "2026-10-01T02:00:00Z", work_date: "2026-10-01",
    })
    assert.deepEqual(await app.insert([correction]), { inserted_count: 0, anomaly_count: 1 })
    assert.deepEqual(await app.insert([correction]), { inserted_count: 0, anomaly_count: 1 })
    assert.deepEqual((await app.db.query(`select month,status from public.attendance_monthly_confirmations
      order by month`)).rows.map((row) => [row.month, row.status]), [
      [9, "pending"], [10, "pending"], [12, "pending"],
    ])
    assert.deepEqual((await app.db.query(
      "select to_jsonb(raw) as row from public.attendance_raw_punches as raw",
    )).rows[0].row, original)
    assert.equal((await app.db.query(
      "select count(*)::integer as count from private.attendance_dingtalk_punch_anomalies",
    )).rows[0].count, 1)
    assert.equal((await app.db.query(
      "select public.insert_attendance_raw_punches($1::jsonb) as inserted",
      [JSON.stringify([correction])],
    )).rows[0].inserted, 0)
    await assert.rejects(app.db.query(`update private.attendance_dingtalk_punch_anomalies
      set incoming_check_type='OnDuty'`), /append-only/)
    assert.equal(await app.openCount(personA, 9), 1)
    assert.equal(await app.openCount(personA, 10), 1)
    assert.ok(await app.revision() >= 3)
    await assert.rejects(app.db.query(`update public.attendance_monthly_confirmations
      set status='confirmed',confirmed_at=now(),confirmed_by='manager'
      where person_id=$1 and month=9`, [personA]), /ATTENDANCE_DINGTALK_ANOMALY_OPEN/)

    const anomalyId = (await app.db.query(
      "select id from private.attendance_dingtalk_punch_anomalies",
    )).rows[0].id
    assert.equal((await app.db.query(
      "select public.resolve_attendance_dingtalk_punch_anomaly($1,'reviewer','manual override reviewed') as resolved",
      [anomalyId],
    )).rows[0].resolved, true)
    assert.equal(await app.openCount(personA, 9), 0)
    assert.deepEqual(await app.insert([correction]), { inserted_count: 0, anomaly_count: 0 })
    await app.db.query(`update public.attendance_monthly_confirmations
      set status='confirmed',confirmed_at=now(),confirmed_by='manager'
      where person_id=$1 and month=9`, [personA])
    assert.equal((await app.db.query(`select status from public.attendance_monthly_confirmations
      where person_id=$1 and month=9`, [personA])).rows[0].status, "confirmed")
  } finally {
    await app.db.close()
  }
})

test("same source ID with changed user is quarantined for both staff members", async () => {
  const app = await setup()
  try {
    await app.insert([punch()])
    await app.db.query(`insert into public.attendance_monthly_confirmations
      (person_id,year,month,status,confirmed_at,confirmed_by,updated_by)
      values ($1,2026,9,'confirmed',now(),'manager','manager'),
        ($2,2026,9,'confirmed',now(),'manager','manager')`, [personA, personB])
    const reassigned = punch({
      person_id: personB, dingtalk_user_id: "ding-b", source_record_key: key("b"),
    })
    assert.deepEqual(await app.insert([reassigned]), { inserted_count: 0, anomaly_count: 1 })
    assert.equal(await app.openCount(personA, 9), 1)
    assert.equal(await app.openCount(personB, 9), 1)
    assert.deepEqual((await app.db.query(`select person_id,status
      from public.attendance_monthly_confirmations order by person_id`)).rows.map((row) => row.status),
      ["pending", "pending"])
    assert.equal((await app.db.query(
      "select count(*)::integer as count from public.attendance_raw_punches",
    )).rows[0].count, 1)
  } finally {
    await app.db.close()
  }
})

test("December annual-summary approval is blocked by an unresolved anomaly in any month", async () => {
  const app = await setup()
  try {
    await app.insert([punch()])
    assert.deepEqual(await app.insert([punch({ check_type: "OffDuty" })]),
      { inserted_count: 0, anomaly_count: 1 })
    assert.equal(await app.openCount(personA, 9), 1)
    await assert.rejects(app.db.query(`insert into public.attendance_monthly_confirmations
      (person_id,year,month,status,note,confirmed_at,confirmed_by)
      values ($1,2026,12,'confirmed','annual-summary',now(),'manager')`, [personA]),
    /ATTENDANCE_DINGTALK_ANOMALY_OPEN/)

    // December's monthly record remains independently confirmable.
    await app.db.query(`insert into public.attendance_monthly_confirmations
      (person_id,year,month,status,note,confirmed_at,confirmed_by)
      values ($1,2026,12,'confirmed','monthly',now(),'manager')`, [personA])
    await assert.rejects(app.db.query(`update public.attendance_monthly_confirmations
      set note='annual-summary' where person_id=$1 and year=2026 and month=12`, [personA]),
    /ATTENDANCE_DINGTALK_ANOMALY_OPEN/)

    const anomalyId = (await app.db.query(
      "select id from private.attendance_dingtalk_punch_anomalies",
    )).rows[0].id
    await app.db.query(`select public.resolve_attendance_dingtalk_punch_anomaly(
      $1,'reviewer','source correction reviewed')`, [anomalyId])
    await app.db.query(`update public.attendance_monthly_confirmations
      set note='annual-summary' where person_id=$1 and year=2026 and month=12`, [personA])
    assert.equal((await app.db.query(`select note from public.attendance_monthly_confirmations
      where person_id=$1 and year=2026 and month=12`, [personA])).rows[0].note,
    "annual-summary")
  } finally {
    await app.db.close()
  }
})

test("an earlier source change reopens a confirmed annual summary without reopening unrelated December monthly records", async () => {
  const app = await setup()
  try {
    await app.db.query(`insert into public.attendance_monthly_confirmations
      (person_id,year,month,status,note,confirmed_at,confirmed_by)
      values ($1,2026,12,'confirmed','annual-summary',now(),'manager'),
        ($2,2026,12,'confirmed','monthly',now(),'manager')`, [personA, personB])
    await app.db.query(`select private.reset_attendance_confirmations_for_range(
      $1,'2026-04-12'::date,'2026-04-12'::date)`, [personA])
    const rows = (await app.db.query(`select person_id,status,confirmed_at
      from public.attendance_monthly_confirmations order by person_id`)).rows
    assert.equal(rows[0].person_id, personA)
    assert.equal(rows[0].status, "pending")
    assert.equal(rows[0].confirmed_at, null)
    assert.equal(rows[1].person_id, personB)
    assert.equal(rows[1].status, "confirmed")
    assert.notEqual(rows[1].confirmed_at, null)
  } finally {
    await app.db.close()
  }
})

test("shared requery endpoint belongs to the following half-open window", async () => {
  const app = await setup()
  try {
    await app.insert([punch({
      punch_time: "2026-09-10T00:00:00Z", work_date: "2026-09-10",
    })])
    assert.deepEqual(await app.reconcile({
      from: "2026-09-09T00:00:00Z", to: "2026-09-10T00:00:00Z",
    }), { missing_count: 0 })
    assert.deepEqual(await app.reconcile({
      from: "2026-09-10T00:00:00Z", to: "2026-09-11T00:00:00Z",
    }), { missing_count: 1 })
  } finally {
    await app.db.close()
  }
})

test("a complete window detects vanished punches but excludes legacy IDs and rejects partial batches", async () => {
  const app = await setup()
  try {
    await app.insert([
      punch(),
      punch({ source_record_key: key("b"), source_record_id: "source-2",
        punch_time: "2026-09-11T02:00:00Z", work_date: "2026-09-11" }),
    ])
    // Legacy imports can belong to the same person but are not DingTalk API evidence.
    await app.db.query(`insert into public.attendance_raw_punches
      (person_id,source_record_key,source_record_id,dingtalk_user_id,check_type,
        punch_time,work_date,raw_payload)
      values ($1,$2,'legacy-1','legacy-xls:VL','OnDuty',
        '2026-09-12T02:00:00Z','2026-09-12','{}')`, [personA, key("c")])
    await app.db.query(`insert into public.attendance_raw_punches
      (person_id,source_record_key,source_record_id,dingtalk_user_id,check_type,
        punch_time,work_date,source_type,raw_payload)
      values ($1,$2,'legacy-xls:row-2','ding-a','OnDuty',
        '2026-09-12T03:00:00Z','2026-09-12','LEGACY_XLS','{}')`, [personA, key("d")])
    await app.db.query(`insert into public.attendance_monthly_confirmations
      (person_id,year,month,status,confirmed_at,confirmed_by,updated_by)
      values ($1,2026,9,'confirmed',now(),'manager','manager')`, [personA])
    const window = { from: "2026-09-10T00:00:00Z", to: "2026-09-13T00:00:00Z",
      keys: [key("a")] }
    const before = await app.revision()
    await assert.rejects(app.reconcile({ ...window, complete: false }), /complete DingTalk batch/)
    assert.equal(await app.revision(), before)
    assert.equal(await app.openCount(personA, 9), 0)
    await assert.rejects(app.reconcile({ ...window,
      users: [{ person_id: personA, dingtalk_user_id: "wrong-user" }] }), /does not match current/)
    assert.deepEqual(await app.reconcile(window), { missing_count: 1 })
    assert.deepEqual(await app.reconcile(window), { missing_count: 1 })
    assert.equal(await app.openCount(personA, 9), 1)
    assert.equal((await app.db.query(`select status from public.attendance_monthly_confirmations
      where person_id=$1 and year=2026 and month=9`, [personA])).rows[0].status, "pending")
    await assert.rejects(app.db.query(`update public.attendance_monthly_confirmations
      set status='confirmed',confirmed_at=now(),confirmed_by='manager'
      where person_id=$1 and month=9`, [personA]), /ATTENDANCE_DINGTALK_ANOMALY_OPEN/)
    assert.equal((await app.db.query(
      "select count(*)::integer as count from private.attendance_dingtalk_missing_punch_anomalies",
    )).rows[0].count, 1)
    assert.equal((await app.db.query(
      "select count(*)::integer as count from public.attendance_raw_punches",
    )).rows[0].count, 4)
    const anomalyId = (await app.db.query(
      "select id from private.attendance_dingtalk_missing_punch_anomalies",
    )).rows[0].id
    assert.equal((await app.db.query(`select public.resolve_attendance_dingtalk_missing_punch_anomaly(
      $1,'reviewer','confirmed manual override') as resolved`, [anomalyId])).rows[0].resolved, true)
    assert.equal(await app.openCount(personA, 9), 0)
    assert.deepEqual(await app.reconcile(window), { missing_count: 0 })
  } finally {
    await app.db.close()
  }
})

test("browser roles cannot execute service-only evidence RPCs", async () => {
  const app = await setup()
  try {
    await app.db.exec("set role anon")
    await assert.rejects(app.db.query(
      "select public.insert_attendance_raw_punches_checked('[]'::jsonb)",
    ), /permission denied/)
    await assert.rejects(app.db.query(
      `select public.reconcile_attendance_dingtalk_punch_window(
        '[]'::jsonb,now(),now(),array[]::text[],true)`,
    ), /permission denied/)
  } finally {
    await app.db.close()
  }
})
