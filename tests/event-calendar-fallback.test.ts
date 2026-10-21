import assert from "node:assert/strict"
import test from "node:test"
import {
  applyEventCalendarMutation,
  EventCalendarConflictError,
  EventCalendarValidationError,
  getEventCalendarEventVersions,
  getEventCalendarSettingVersions,
  mutateEventCalendarStore,
  type CalendarMutation,
} from "../lib/eventCalendarStore"

function event(id: string, title = "SYNTHETIC FALLBACK") {
  return { id, title, startDate: "2026-06-01", endDate: "2026-06-30", people: ["OL"], tags: [], eventType: "Unclassified" as const }
}
function original() {
  return { events: [event("keep", "KEEP")], people: ["OL", "CY"], emailRecipientsText: "keep@example.test", deletedEventIds: ["old-general"], deletedRequiredSeedIds: ["old-required"], unrelated: { keep: true } }
}
function absentDelete(id = "fallback", extra: Partial<CalendarMutation> = {}): CalendarMutation {
  return { operation: "delete", eventIds: [id], expectedAbsentEventIds: [id], ...extra }
}

test("an explicit missing fallback deletion tombstones only its target and preserves canonical settings", () => {
  const current = original()
  const next = applyEventCalendarMutation(current, absentDelete())
  assert.deepEqual(next, { ...current, deletedEventIds: ["old-general", "fallback"] })
  assert.deepEqual(current, original())
  assert.deepEqual(applyEventCalendarMutation(next, absentDelete()), next)
})

test("absent/null and legacy empty stores accept explicit one-target fallback deletion without importing defaults", () => {
  for (const current of [null, {}]) {
    assert.deepEqual(applyEventCalendarMutation(current, absentDelete()), { events: [], deletedEventIds: ["fallback"] })
    const next = applyEventCalendarMutation(current, absentDelete("fc-2026-024", { settings: { deletedRequiredSeedIds: ["fc-2026-024"] } }))
    assert.deepEqual(next, { events: [], deletedEventIds: ["fc-2026-024"], deletedRequiredSeedIds: ["fc-2026-024"] })
    assert.equal(Object.hasOwn(next, "people"), false)
    assert.equal(Object.hasOwn(next, "emailRecipientsText"), false)
  }
})

test("missing preconditions never delete a concurrently created record, even an identical fallback", () => {
  const current = { ...original(), events: [event("fallback")] }
  assert.throws(() => applyEventCalendarMutation(current, absentDelete()), EventCalendarConflictError)
  assert.deepEqual(current.events, [event("fallback")])
})

test("ordinary missing and stale record update/delete remain strict", () => {
  const current = original()
  for (const operation of ["update", "delete"] as const) {
    assert.throws(() => applyEventCalendarMutation(current, { operation, events: operation === "update" ? [event("missing")] : [], eventIds: ["missing"], expectedEventVersions: { missing: "a".repeat(64) } }), EventCalendarConflictError)
    assert.throws(() => applyEventCalendarMutation(current, { operation, events: operation === "update" ? [event("keep", "STALE")] : [], eventIds: ["keep"], expectedEventVersions: { keep: "a".repeat(64) } }), EventCalendarConflictError)
  }
  assert.throws(() => applyEventCalendarMutation(current, { operation: "delete", eventIds: ["missing"] }), EventCalendarConflictError)
  const version = getEventCalendarEventVersions(current).keep
  const next = applyEventCalendarMutation(current, { operation: "delete", eventIds: ["keep"], expectedEventVersions: { keep: version } })
  assert.deepEqual(next.events, [])
})

test("an absent precondition rejects every expected-version entry, including empty or malformed values", () => {
  for (const version of ["", "invalid", "a".repeat(64), null, 0]) {
    assert.throws(() => applyEventCalendarMutation(original(), absentDelete("fallback", { expectedEventVersions: { fallback: version } })), EventCalendarValidationError)
  }
})

test("an absent precondition rejects normalized version-key aliases regardless of raw value", () => {
  const observed: { state: number; key: string; version: unknown; rejected: boolean }[] = []
  for (const [state, current] of [null, {}, original()].entries()) {
    for (const key of [" fallback", "fallback ", "\t fallback \n"]) {
      for (const version of ["a".repeat(64), "", "invalid", null, 0]) {
        const before = structuredClone(current)
        let rejected = false
        try {
          applyEventCalendarMutation(current, absentDelete("fallback", { expectedEventVersions: { [key]: version } }))
        } catch (error) {
          assert.ok(error instanceof EventCalendarValidationError)
          rejected = true
        }
        observed.push({ state, key, version, rejected })
        assert.deepEqual(current, before)
      }
    }
  }
  assert.deepEqual(observed, observed.map(row => ({ ...row, rejected: true })))
})

test("missing-ID preconditions reject malformed, duplicate, unknown and oversized targets", () => {
  for (const value of [null, false, "fallback", {}, [1], [null], [""], [" fallback "], ["x".repeat(201)], ["fallback", "fallback"], ["another"], Array.from({ length: 501 }, (_, i) => `id-${i}`)]) {
    assert.throws(() => applyEventCalendarMutation(original(), absentDelete("fallback", { expectedAbsentEventIds: value })), EventCalendarValidationError)
  }
  assert.throws(() => applyEventCalendarMutation(original(), { operation: "delete", eventIds: [], expectedAbsentEventIds: ["fallback"] }), EventCalendarValidationError)
})

test("missing-ID preconditions are delete-only, even when the provided list is empty", () => {
  for (const operation of ["create", "update", "upsert", "insert", "settings", "people"] as const) {
    for (const expectedAbsentEventIds of [[], ["fallback"]]) {
      assert.throws(() => applyEventCalendarMutation(original(), { operation, events: [event("fallback")], settings: operation === "people" ? { people: ["OL"] } : {}, expectedAbsentEventIds }), EventCalendarValidationError)
    }
  }
})

test("either deletion marker prevents fallback creation, legacy upsert and additive import resurrection", () => {
  for (const marker of ["deletedEventIds", "deletedRequiredSeedIds"] as const) {
    const current = original()
    current[marker].push("fallback")
    for (const operation of ["create", "upsert"] as const) {
      assert.throws(() => applyEventCalendarMutation(current, { operation, events: [event("fallback")] }), EventCalendarConflictError)
    }
    const next = applyEventCalendarMutation(current, { operation: "insert", events: [event("fallback"), event("new")] })
    assert.deepEqual(next.events, [...current.events, event("new")])
    assert.deepEqual(next.deletedEventIds, current.deletedEventIds)
    assert.deepEqual((next as ReturnType<typeof original>).deletedRequiredSeedIds, current.deletedRequiredSeedIds)
  }
})

test("fallback creation persists exactly one selected record and keeps identical retries read-only", () => {
  for (const current of [null, {}, original()]) {
    const next = applyEventCalendarMutation(current, { operation: "create", events: [event("custom-cache-id")] })
    const existingEvents = (current as Partial<ReturnType<typeof original>> | null)?.events ?? []
    assert.deepEqual(next.events, [...existingEvents, event("custom-cache-id")])
    assert.deepEqual(applyEventCalendarMutation(next, { operation: "create", events: [event("custom-cache-id")] }), next)
    assert.throws(() => applyEventCalendarMutation(next, { operation: "create", events: [event("custom-cache-id", "DIFFERENT CONCURRENT RECORD")] }), EventCalendarConflictError)
  }
})

function database(initial: unknown) {
  let row: { payload: unknown; updated_at: string } | null = initial === null ? null : { payload: structuredClone(initial), updated_at: "2026-10-21T00:00:00.000Z" }
  let writes = 0, beforeWrite: (() => void) | null = null
  const client = { from() {
    let mode = "read", values: { payload: unknown; updated_at: string }, expected = ""
    const q = { select() { return q }, eq(key: string, value: unknown) { if (key === "updated_at") expected = String(value); return q }, update(value: typeof values) { mode = "update"; values = value; return q }, insert(value: typeof values) { mode = "insert"; values = value; return q }, async maybeSingle() {
      await new Promise<void>(resolve => setImmediate(resolve))
      if (mode === "read") return { data: structuredClone(row), error: null }
      if (beforeWrite) { const call = beforeWrite; beforeWrite = null; call() }
      if (mode === "insert" && row) return { data: null, error: { code: "23505" } }
      if (mode === "update" && (!row || row.updated_at !== expected)) return { data: null, error: null }
      row = structuredClone(values); writes += 1; return { data: { payload: row.payload }, error: null }
    } }; return q
  } }
  return { client, payload: () => structuredClone(row?.payload), writes: () => writes, beforeWrite(call: () => void) { beforeWrite = call }, concurrent(mutation: CalendarMutation) { row = { payload: applyEventCalendarMutation(row?.payload, mutation), updated_at: "2026-10-21T00:00:00.001Z" } } }
}

test("actual CAS retry merges unrelated colleague settings without importing fallback defaults", async () => {
  const current = original(), db = database(current), version = getEventCalendarSettingVersions(current).emailRecipientsText
  db.beforeWrite(() => db.concurrent({ operation: "settings", settings: { emailRecipientsText: "colleague@example.test" }, expectedSettingVersions: { emailRecipientsText: version } }))
  const next = await mutateEventCalendarStore(db.client as never, absentDelete())
  assert.equal(next.emailRecipientsText, "colleague@example.test")
  assert.deepEqual(next.events, current.events)
  assert.deepEqual(next.deletedEventIds, ["old-general", "fallback"])
  assert.deepEqual(next.unrelated, { keep: true })
  assert.equal(db.writes(), 1)
})

test("actual CAS retry refuses a concurrent same-ID create instead of deleting its winner", async () => {
  const db = database(original())
  db.beforeWrite(() => db.concurrent({ operation: "create", events: [event("fallback", "CONCURRENT WINNER")] }))
  await assert.rejects(mutateEventCalendarStore(db.client as never, absentDelete()), EventCalendarConflictError)
  assert.equal(db.writes(), 0)
  const payload = db.payload() as ReturnType<typeof original>
  assert.equal(payload.events.find(item => item.id === "fallback")?.title, "CONCURRENT WINNER")
  assert.equal(payload.deletedEventIds.includes("fallback"), false)
})

test("actual storage creates/deletes missing fallback IDs once and identical retries add no write", async () => {
  const db = database(null)
  await mutateEventCalendarStore(db.client as never, { operation: "create", events: [event("selected")] })
  await mutateEventCalendarStore(db.client as never, { operation: "create", events: [event("selected")] })
  assert.equal(db.writes(), 1)
  await mutateEventCalendarStore(db.client as never, absentDelete("other"))
  await mutateEventCalendarStore(db.client as never, absentDelete("other"))
  assert.equal(db.writes(), 2)
})
