import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { literal, setupNativeCcinfo } from "./fixtures/native-postgres-ccinfo.mjs"

const source = name => readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), "utf8")
const foundation = source("20260807091428_create_attendance_record_foundation.sql")
const modes = source("20260810082031_attendance_work_modes_and_calendar.sql")
const dayEdit = source("20260818023111_support_half_day_attendance_punches.sql")
const person = "11111111-1111-4111-8111-111111111111"
const otherPerson = "22222222-2222-4222-8222-222222222222"
const workDate = "2026-11-02"

function exactTable(sql, name) {
  const start = sql.indexOf(`create table public.${name} (`)
  assert.ok(start >= 0, `Missing actual ${name} table`)
  const end = sql.indexOf("\n);", start)
  assert.ok(end > start)
  return sql.slice(start, end + 3)
}

function exactFunction(sql, name) {
  const start = sql.indexOf(`create or replace function ${name}(`)
  assert.ok(start >= 0, `Missing actual ${name} function`)
  const end = sql.indexOf("\n$$;", start)
  assert.ok(end > start)
  return sql.slice(start, end + 4)
}

// Exercise the real saved-status schema, generated units, overlap trigger and
// atomic day-edit RPC in an isolated native PostgreSQL cluster. No remote data,
// credentials, .env, HTTP requests or production writes are involved.
async function use(run) {
  const fixture = await setupNativeCcinfo(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create schema private;
    ${["attendance_people", "attendance_raw_punches", "attendance_leave_entries", "attendance_manual_overrides"]
      .map(name => exactTable(foundation, name)).join("\n")}
    ${exactTable(modes, "attendance_work_mode_overrides")}
    create unique index attendance_manual_overrides_replace_key
      on public.attendance_manual_overrides(person_id, work_date, check_type)
      where action = 'replace';
    ${exactFunction(foundation, "private.enforce_attendance_leave_no_overlap")}
    create trigger enforce_attendance_leave_no_overlap
      before insert or update of person_id, leave_date, portion
      on public.attendance_leave_entries
      for each row execute function private.enforce_attendance_leave_no_overlap();
    ${dayEdit}
    grant usage on schema public to service_role;
    insert into public.attendance_people(id,staff_code,display_name,team,employment_start_date)
      values ('${person}','TEST','Synthetic Test','BT','2026-01-01'),
        ('${otherPerson}','OTHER','Synthetic Other','BT','2026-01-01');
  `)
  let serial = 0
  const sql = ({ portion = "am", code = "HO", entryId = null, enabled = true,
    personId = person, date = workDate, updateOut = false, out = null, workMode = "default" } = {}) =>
    `select public.save_attendance_day_edit(
      ${literal(personId)},${literal(date)},${literal(workMode)},'',${enabled},
      ${entryId ? literal(entryId) : "null"},${literal(portion)},${literal(code)},'Synthetic entry',
      false,null,${updateOut},${out ? literal(out) : "null"},'synthetic-editor');`
  async function save(input) {
    const client = await fixture.session(`halfday-save-${++serial}`)
    try { return await client.one(sql(input)) } finally { await client.close() }
  }
  const rows = () => fixture.owner.one("select coalesce(jsonb_agg(to_jsonb(t) order by person_id, leave_date, portion),'[]') from public.attendance_leave_entries t;")
  const punches = () => fixture.owner.one("select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.attendance_manual_overrides t;")
  try { await run({ ...fixture, save, rows, punches }) } finally { await fixture.close() }
}

for (const order of ["home-first", "leave-first"]) {
  test(`AM home office and PM annual leave coexist without replacement (${order})`, () => use(async f => {
    const home = { portion: "am", code: "HO" }
    const leave = { portion: "pm", code: "ALS" }
    await f.save(order === "home-first" ? home : leave)
    const first = (await f.rows())[0]
    await f.save(order === "home-first" ? leave : home)
    const rows = await f.rows()
    assert.equal(rows.length, 2)
    assert.deepEqual(rows.find(row => row.id === first.id), first, "opposite half is byte-for-byte unchanged")
    assert.deepEqual(rows.map(row => [row.portion, row.code, row.units]), [["am", "HO", 0.5], ["pm", "ALS", 0.5]])
    assert.equal(rows.filter(row => ["ALS", "ALU"].includes(row.code)).reduce((n, row) => n + row.units, 0), 0.5)
    assert.equal(rows.filter(row => row.code === "HO").reduce((n, row) => n + row.units, 0), 0.5)
  }))
}

test("AM annual leave and PM home office use the same half-day contract", () => use(async f => {
  await f.save({ portion: "am", code: "ALS" })
  await f.save({ portion: "pm", code: "HO" })
  assert.deepEqual((await f.rows()).map(row => [row.portion, row.code, row.units]), [["am", "ALS", 0.5], ["pm", "HO", 0.5]])
}))

test("adding PM annual leave preserves the legacy manual HOME mode in the atomic day edit", () => use(async f => {
  await f.save({ enabled: false, workMode: "home-office" })
  const before = await f.owner.one(`select to_jsonb(t) from public.attendance_work_mode_overrides t where person_id='${person}';`)
  await f.save({ portion: "pm", code: "ALS", workMode: "home-office" })
  const after = await f.owner.one(`select to_jsonb(t) from public.attendance_work_mode_overrides t where person_id='${person}';`)
  assert.equal(after.id, before.id, "the existing manual mode is updated in place, not deleted")
  assert.equal(after.mode, "home-office")
  assert.deepEqual((await f.rows()).map(row => [row.portion, row.code, row.units]), [["pm", "ALS", 0.5]])
}))

test("editing or removing one half preserves the opposite half and other people/dates", () => use(async f => {
  await f.save({ portion: "am", code: "HO" })
  await f.save({ portion: "pm", code: "ALS" })
  await f.save({ personId: otherPerson, portion: "full", code: "ALS" })
  await f.save({ date: "2026-11-03", portion: "am", code: "HO" })
  const before = await f.rows()
  const home = before.find(row => row.person_id === person && row.leave_date === workDate && row.portion === "am")
  const preserved = before.filter(row => row.id !== home.id)
  const changed = await f.save({ entryId: home.id, portion: "am", code: "OS" })
  assert.deepEqual((await f.rows()).filter(row => row.id !== changed.leave_entries[0].id), preserved)
  await f.save({ entryId: changed.leave_entries[0].id, enabled: false })
  assert.deepEqual(await f.rows(), preserved)
}))

test("same-half and full-day collisions fail atomically instead of deleting either saved half", () => use(async f => {
  const home = (await f.save()).leave_entries[0]
  await f.save({ portion: "pm", code: "ALS" })
  const before = await f.rows()
  for (const input of [
    { portion: "am", code: "ALU" },
    { portion: "full", code: "HO" },
    { entryId: home.id, portion: "full", code: "HO" },
    { entryId: home.id, portion: "pm", code: "HO" },
  ]) {
    await assert.rejects(f.save(input), /overlaps an existing leave entry/)
    assert.deepEqual(await f.rows(), before)
  }
}))

test("adding AM home office preserves an existing 13:00 sign-out and PM annual leave", () => use(async f => {
  await f.save({ portion: "pm", code: "ALS", updateOut: true, out: "2026-11-02T05:00:00Z" })
  const leaveBefore = await f.rows()
  const punchBefore = await f.punches()
  await f.save({ portion: "am", code: "HO", updateOut: false, out: "2026-11-02T05:00:00Z" })
  assert.deepEqual((await f.rows()).filter(row => row.portion === "pm"), leaveBefore)
  assert.deepEqual(await f.punches(), punchBefore)
  assert.equal((await f.rows()).length, 2)
}))

test("changed early sign-out still requires the selected PM absence and keeps atomic failure", () => use(async f => {
  await f.save({ portion: "pm", code: "ALS" })
  const before = await f.rows()
  await assert.rejects(f.save({ portion: "am", code: "HO", updateOut: true, out: "2026-11-02T05:00:00Z" }), /Sign-out before 17:00 requires PM leave/)
  assert.deepEqual(await f.rows(), before)
  assert.deepEqual(await f.punches(), [])
}))
