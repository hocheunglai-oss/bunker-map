import assert from "node:assert/strict"
import test from "node:test"
import {
  EventCalendarConflictError, EventCalendarValidationError, getEventCalendarEventVersions,
  getEventCalendarStoreVersion, mutateEventCalendarStoreBatch, type CalendarMutation,
} from "../lib/eventCalendarStore"

const event = (id: string, title = id) => ({ id, title, startDate: "2026-10-07", endDate: "2026-10-07", tags: [], people: [], uncertainPeople: [], eventType: "Unclassified" })

function database(initial: Record<string, unknown>, options: { race?: boolean; failWrite?: boolean } = {}) {
  let row = { payload: structuredClone(initial), updated_at: "2026-10-07T00:00:00.000Z" }
  let commits = 0, attempts = 0
  const client = { from(table: string) {
    assert.equal(table, "office_calendar_store")
    let write: Record<string, unknown> | null = null, expected = ""
    const query = {
      select() { return query },
      eq(field: string, value: unknown) { if (field === "key") assert.equal(value, "event-calendar"); if (field === "updated_at") expected = String(value); return query },
      update(value: Record<string, unknown>) { write = value; return query },
      async maybeSingle() {
        if (!write) return { data: structuredClone(row), error: null }
        attempts += 1
        if (options.failWrite) return { data: null, error: new Error("Synthetic DB write failure") }
        if (options.race && attempts === 1) row = { payload: { ...row.payload, people: ["SC", "LATER USER"] }, updated_at: "2026-10-07T00:00:01.000Z" }
        if (expected !== row.updated_at) return { data: null, error: null }
        row = { payload: structuredClone(write.payload as Record<string, unknown>), updated_at: String(write.updated_at) }
        commits += 1
        return { data: { payload: structuredClone(row.payload) }, error: null }
      },
    }
    return query
  } }
  return { client, payload: () => structuredClone(row.payload), commits: () => commits, attempts: () => attempts }
}

const original = () => ({ events: [event("edit", "Old label"), event("remove", "Obsolete pristine import"), { ...event("manual", "Assigned HK holiday"), people: ["SC"] }], people: ["SC"], emailRecipientsText: "synthetic@example.test", deletedEventIds: ["old-deletion"] })
function mutations(payload: ReturnType<typeof original>): CalendarMutation[] {
  const versions = getEventCalendarEventVersions(payload)
  return [
    { operation: "update", events: [event("edit", "Corrected label")], expectedEventVersions: versions },
    { operation: "delete", eventIds: ["remove"], expectedEventVersions: versions },
    { operation: "insert", events: [event("new", "New verified holiday")] },
  ]
}

test("holiday update/delete/add batch commits once and preserves manual assignments and unrelated settings", async () => {
  const initial = original(), db = database(initial)
  const saved = await mutateEventCalendarStoreBatch(db.client as never, mutations(initial), getEventCalendarStoreVersion(initial))
  assert.equal(db.commits(), 1)
  assert.deepEqual(saved.events, [event("edit", "Corrected label"), initial.events[2], event("new", "New verified holiday")])
  assert.deepEqual(saved.people, ["SC"])
  assert.equal(saved.emailRecipientsText, "synthetic@example.test")
  assert.deepEqual(saved.deletedEventIds, ["old-deletion", "remove"])
})

test("a later invalid batch operation prevents all earlier changes from reaching storage", async () => {
  const initial = original(), db = database(initial)
  const changes = [...mutations(initial), { operation: "create" as const, events: [{ ...event("bad"), startDate: "2026-02-30" }] }]
  await assert.rejects(mutateEventCalendarStoreBatch(db.client as never, changes, getEventCalendarStoreVersion(initial)), EventCalendarValidationError)
  assert.equal(db.commits(), 0)
  assert.equal(db.attempts(), 0)
  assert.deepEqual(db.payload(), initial)
})

test("DB failure leaves the whole holiday batch unapplied", async () => {
  const initial = original(), db = database(initial, { failWrite: true })
  await assert.rejects(mutateEventCalendarStoreBatch(db.client as never, mutations(initial), getEventCalendarStoreVersion(initial)), /Synthetic DB write failure/)
  assert.equal(db.commits(), 0)
  assert.deepEqual(db.payload(), initial)
})

test("a concurrent change after preview makes the CAS retry reject without partial holiday changes", async () => {
  const initial = original(), db = database(initial, { race: true })
  await assert.rejects(mutateEventCalendarStoreBatch(db.client as never, mutations(initial), getEventCalendarStoreVersion(initial)), EventCalendarConflictError)
  assert.equal(db.attempts(), 1)
  assert.equal(db.commits(), 0)
  assert.deepEqual(db.payload(), { ...initial, people: ["SC", "LATER USER"] })
})

test("stale initial preview and missing task/event versions cannot partially apply", async () => {
  const initial = original(), db = database(initial)
  await assert.rejects(mutateEventCalendarStoreBatch(db.client as never, mutations(initial), "0".repeat(64)), EventCalendarConflictError)
  await assert.rejects(mutateEventCalendarStoreBatch(db.client as never, [mutations(initial)[0], { operation: "delete", eventIds: ["remove"] }], getEventCalendarStoreVersion(initial)), EventCalendarConflictError)
  assert.equal(db.attempts(), 0)
  assert.deepEqual(db.payload(), initial)
})

test("existing deliberate deletions remain fenced inside a batch", async () => {
  const initial = original(), db = database(initial)
  const saved = await mutateEventCalendarStoreBatch(db.client as never, [{ operation: "insert", events: [event("old-deletion")] }], getEventCalendarStoreVersion(initial))
  assert.deepEqual(saved, initial)
  assert.equal(db.commits(), 0)
})
