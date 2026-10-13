import assert from "node:assert/strict"
import test from "node:test"
import { autoConfirmOverdueAttendance } from "../lib/attendanceData"

// Invoke the actual scheduling helper, but replace only the database boundary.
// No cron route, jobs, mail transport or hosted services are invoked.
const personId = "11111111-1111-4111-8111-111111111111"
function harness(holidays: string[] = [], existingStatus: "pending" | "confirmed" | null = null) {
  const writes: Array<{ table: string; values: Record<string, unknown>; filters: Record<string, unknown> }> = []
  const reads: string[] = []
  let storedStatus = existingStatus
  const client = {
    from(table: string) {
      const filters: Record<string, unknown> = {}
      let values: Record<string, unknown> | null = null
      const query = {
        select() { return query },
        eq(key: string, value: unknown) { filters[key] = value; return query },
        insert(value: Record<string, unknown>) { values = value; return query },
        update(value: Record<string, unknown>) { values = value; return query },
        async maybeSingle() {
          assert.equal(table, "office_calendar_store")
          return { data: { payload: { people: [], events: holidays.map((date) => ({
            startDate: date, endDate: date, title: "PUBLIC HOLIDAY - HONG KONG", tags: ["PUBLIC-HOLIDAY", "HK"], people: [],
          })) } }, error: null }
        },
        then(resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) {
          if (values) {
            writes.push({ table, values: { ...values }, filters: { ...filters } })
            storedStatus = values.status as "pending" | "confirmed"
            return Promise.resolve({ data: [{ id: "synthetic-confirmation" }], error: null }).then(resolve, reject)
          }
          reads.push(table)
          const data = table === "attendance_reminder_dispatches" ? [{ person_id: personId }]
            : table === "attendance_monthly_confirmations" && storedStatus ? [{ id: "synthetic-confirmation", person_id: personId, status: storedStatus }] : []
          assert.ok(["attendance_reminder_dispatches", "attendance_monthly_confirmations"].includes(table))
          return Promise.resolve({ data, error: null }).then(resolve, reject)
        },
      }
      return query
    },
  }
  return { writes, reads, run: (iso: string) => autoConfirmOverdueAttendance(client as never, new Date(iso)) }
}

test("automatic confirmation must not write before 18:00 on the third Hong Kong working day", async () => {
  for (const time of ["2026-11-03T16:00:00.000Z", "2026-11-04T09:59:59.999Z"]) {
    const app = harness()
    const result = await app.run(time)
    assert.equal(result.skipped, true, time)
    assert.deepEqual(app.writes, [], time)
    assert.deepEqual(app.reads, [], "before cutoff only the persisted holiday calendar may be read")
  }
})

test("18:00 HKT is inclusive; persisted holidays postpone the third working day", async () => {
  const ready = harness()
  assert.equal((await ready.run("2026-11-04T10:00:00.000Z")).systemConfirmed, 1)
  assert.equal(ready.writes[0].values.confirmed_at, "2026-11-04T10:00:00.000Z")
  assert.equal(ready.writes[0].values.confirmed_by, "system:attendance-auto-confirm")
  const holiday = harness(["2026-11-02"])
  assert.equal((await holiday.run("2026-11-04T10:00:00.000Z")).skipped, true)
  assert.deepEqual(holiday.writes, [])
  assert.equal((await holiday.run("2026-11-05T10:00:00.000Z")).systemConfirmed, 1)
})

test("automatic confirmation preserves individual confirmation and fences an existing pending-row update", async () => {
  const individual = harness([], "confirmed")
  assert.equal((await individual.run("2026-11-04T10:00:00.000Z")).systemConfirmed, 0)
  assert.deepEqual(individual.writes, [])
  const pending = harness([], "pending")
  assert.equal((await pending.run("2026-11-04T10:00:00.000Z")).systemConfirmed, 1)
  assert.deepEqual(pending.writes[0].filters, { id: "synthetic-confirmation", status: "pending" })
  assert.match(String(pending.writes[0].values.note), /may dispute the record directly with an administrator/)
})

test("a repeated run after the 18:00 cutoff leaves the first system confirmation unchanged", async () => {
  const app = harness()
  assert.equal((await app.run("2026-11-04T10:00:00.000Z")).systemConfirmed, 1)
  const first = structuredClone(app.writes)
  assert.equal((await app.run("2026-11-04T10:15:00.000Z")).systemConfirmed, 0)
  assert.deepEqual(app.writes, first, "repeat must not replace the first confirmation timestamp or actor")
})
