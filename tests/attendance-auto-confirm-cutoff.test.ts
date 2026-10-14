import assert from "node:assert/strict"
import test from "node:test"
import type { SupabaseClient } from "@supabase/supabase-js"
import {
  attendanceAutoConfirmCutoff,
  autoConfirmOverdueAttendance,
  loadAttendancePeopleForPeriod,
} from "../lib/attendanceData"

type Row = Record<string, unknown>

const now = new Date("2026-11-04T10:00:29.000Z") // Third working day, 18:00:29 HKT.
const person = {
  id: "person-1", staff_code: "SC", display_name: "SC", team: "BT",
  admin_user_id: "user-1", dingtalk_user_id: "ding-person-1", is_active: true,
  employment_start_date: "2026-01-01", employment_end_date: null,
}
const assignment = {
  id: "assignment-1", person_id: "person-1", team: "BT",
  effective_from: "2026-01-01", effective_to: null,
}
const reminder = {
  person_id: "person-1", year: 2026, month: 10,
  dispatch_kind: "second_reminder", status: "sent",
}
const pending = {
  id: "confirmation-1", person_id: "person-1", year: 2026, month: 10,
  status: "pending", updated_at: "2026-11-04T09:00:00.000Z",
}
const successfulSync = {
  id: "latest", status: "succeeded", started_at: "2026-11-04T10:00:20.000Z",
  completed_at: "2026-11-04T10:00:25.000Z",
  window_from: "2026-10-29T16:00:00.000Z",
  window_to: "2026-11-04T10:00:24.000Z",
  people_requested: 1, batches_attempted: 1,
  requested_people: { "person-1": "ding-person-1" },
}
const coverageBoundaries = [
  "2026-09-30T16:00:00.000Z", // October 1, 00:00 HKT.
  "2026-10-06T16:00:00.000Z",
  "2026-10-12T16:00:00.000Z",
  "2026-10-18T16:00:00.000Z",
  "2026-10-24T16:00:00.000Z",
  "2026-10-31T16:00:00.000Z", // November 1, 00:00 HKT.
]
const historicalSyncs = coverageBoundaries.slice(0, -1).map((from, index) => {
  const to = coverageBoundaries[index + 1]
  return {
    ...successfulSync, id: `historical-${index}`,
    started_at: new Date(Date.parse("2026-11-04T10:00:01.000Z") + index * 2_000).toISOString(),
    completed_at: new Date(Date.parse("2026-11-04T10:00:02.000Z") + index * 2_000).toISOString(),
    window_from: from, window_to: to,
  }
})

function fakeClient(input: {
  people?: Row[]
  assignments?: Row[]
  reminders?: Row[]
  confirmations?: Row[]
  sync?: Row | null
  syncHistory?: Row[]
  rawPunches?: Row[]
  openAnomalyCount?: number | null
  calendarEvents?: Row[]
  expectedCutoff?: string
  beforeConfirmationWrite?: (confirmations: Row[]) => void
  onRead?: (table: string) => void
} = {}) {
  const tables: Record<string, Row[]> = {
    office_calendar_store: [{ key: "event-calendar", payload: { events: input.calendarEvents || [] } }],
    attendance_people: input.people || [{ ...person }],
    attendance_team_assignments: input.assignments || [{ ...assignment }],
    attendance_reminder_dispatches: input.reminders || [{ ...reminder }],
    attendance_monthly_confirmations: input.confirmations || [{ ...pending }],
    attendance_sync_runs: [
      ...(input.syncHistory || historicalSyncs).map((run) => ({ ...run })),
      ...(input.sync === null ? [] : [{ ...(input.sync || successfulSync) }]),
    ],
    attendance_raw_punches: input.rawPunches || [],
  }
  const writes: Row[] = []
  const readTables: string[] = []
  let sourceRevision = 1
  const client = {
    async rpc(name: string, args?: Row) {
      if (name === "attendance_source_revision") return { data: sourceRevision, error: null }
      if (name === "attendance_open_dingtalk_punch_anomaly_count") {
        return { data: input.openAnomalyCount === undefined ? 0 : input.openAnomalyCount, error: null }
      }
      assert.equal(name, "save_attendance_monthly_confirmation_checked")
      assert.equal(args?.p_auto_cutoff, input.expectedCutoff || (args?.p_month === 9
        ? "2026-10-05T10:00:00.000Z"
        : "2026-11-04T10:00:00.000Z"))
      const rows = tables.attendance_monthly_confirmations
      input.beforeConfirmationWrite?.(rows)
      if (args?.p_expected_revision !== sourceRevision) {
        return { data: null, error: { message: "ATTENDANCE_SOURCE_CHANGED: revision changed" } }
      }
      const existing = rows.find((row) => row.person_id === args?.p_person_id &&
        row.year === args?.p_year && row.month === args?.p_month)
      if (existing?.status === "confirmed" ||
          existing?.updated_at && Date.parse(String(existing.updated_at)) >=
            Date.parse(String(args?.p_auto_cutoff))) {
        return { data: [], error: null }
      }
      const updated = {
        ...existing,
        person_id: args?.p_person_id,
        year: args?.p_year,
        month: args?.p_month,
        status: "confirmed",
        confirmed_by: args?.p_actor,
        note: args?.p_note,
      }
      writes.push(updated)
      if (existing) Object.assign(existing, updated)
      else rows.push(updated)
      return { data: [updated], error: null }
    },
    from(table: string) {
      assert.ok(table in tables, `Unexpected table ${table}`)
      readTables.push(table)
      input.onRead?.(table)
      const filters: Array<[string, unknown]> = []
      const exclusions: Array<[string, unknown]> = []
      const bounds: Array<["gte" | "lte", string, unknown]> = []
      let writeKind: "insert" | "update" | null = null
      let writeValues: Row = {}
      let limit: number | null = null
      const orders: Array<{ key: string; ascending: boolean }> = []
      let range: [number, number] | null = null
      const execute = () => {
        if (writeKind) {
          assert.equal(table, "attendance_monthly_confirmations")
          input.beforeConfirmationWrite?.(tables[table])
          const matching = tables[table].filter((row) =>
            filters.every(([key, value]) => row[key] === value))
          if (writeKind === "update") {
            for (const row of matching) {
              Object.assign(row, writeValues)
              writes.push({ ...writeValues })
            }
            return { data: matching.map((row) => ({ id: row.id })), error: null }
          }
          const row: Row = { ...writeValues, id: "new-confirmation" }
          if (tables[table].some((existing) => existing.person_id === row.person_id &&
            existing.year === row.year && existing.month === row.month)) {
            return { data: null, error: { code: "23505", message: "duplicate" } }
          }
          tables[table].push(row)
          writes.push({ ...writeValues })
          return { data: [{ id: row.id }], error: null }
        }
        let rows = tables[table].filter((row) =>
          filters.every(([key, value]) => row[key] === value) &&
          exclusions.every(([key, value]) => row[key] !== value) &&
          bounds.every(([kind, key, value]) => kind === "gte"
            ? String(row[key]) >= String(value)
            : String(row[key]) <= String(value)))
        if (orders.length) rows = [...rows].sort((left, right) => {
          for (const order of orders) {
            const comparison = String(left[order.key]).localeCompare(String(right[order.key]))
            if (comparison) return order.ascending ? comparison : -comparison
          }
          return 0
        })
        if (range) rows = rows.slice(range[0], range[1] + 1)
        if (limit !== null) rows = rows.slice(0, limit)
        return { data: rows.map((row) => ({ ...row })), error: null }
      }
      const query = {
        select() { return query },
        eq(key: string, value: unknown) { filters.push([key, value]); return query },
        neq(key: string, value: unknown) { exclusions.push([key, value]); return query },
        gte(key: string, value: unknown) { bounds.push(["gte", key, value]); return query },
        lte(key: string, value: unknown) { bounds.push(["lte", key, value]); return query },
        order(key: string, options?: { ascending?: boolean }) {
          orders.push({ key, ascending: options?.ascending !== false }); return query
        },
        limit(value: number) { limit = value; return query },
        range(from: number, to: number) { range = [from, to]; return query },
        update(values: Row) { writeKind = "update"; writeValues = values; return query },
        insert(values: Row) { writeKind = "insert"; writeValues = values; return query },
        async maybeSingle() {
          const result = execute()
          return { data: result.data?.[0] || null, error: result.error }
        },
        then: (resolve: (value: ReturnType<typeof execute>) => unknown,
          reject?: (reason: unknown) => unknown) => Promise.resolve(execute()).then(resolve, reject),
      }
      return query
    },
  } as unknown as SupabaseClient
  return { client, writes, readTables, tables, bumpRevision() { sourceRevision += 1 } }
}

test("third working-day cutoff stays at 18:00 HKT across holidays and catch-up days", () => {
  assert.equal(attendanceAutoConfirmCutoff(now, new Set())?.toISOString(),
    "2026-11-04T10:00:00.000Z")
  assert.equal(attendanceAutoConfirmCutoff(now, new Set(["2026-11-02"]))?.toISOString(),
    "2026-11-05T10:00:00.000Z")
  assert.equal(attendanceAutoConfirmCutoff(new Date("2026-11-07T12:00:00.000Z"), new Set())?.toISOString(),
    "2026-11-04T10:00:00.000Z")
})

test("auto-confirm waits until the original cutoff, then accepts post-cutoff full-month sync coverage", async () => {
  const early = fakeClient()
  assert.deepEqual(await autoConfirmOverdueAttendance(early.client, new Date("2026-11-04T09:59:59.000Z")),
    { skipped: true, year: 2026, month: 10, systemConfirmed: 0 })
  assert.equal(early.readTables.includes("attendance_sync_runs"), false)

  const ready = fakeClient()
  assert.deepEqual(await autoConfirmOverdueAttendance(ready.client, now),
    { skipped: false, year: 2026, month: 10, systemConfirmed: 1 })
  assert.equal(ready.writes.length, 1)
  assert.equal(ready.writes[0].confirmed_by, "system:attendance-auto-confirm")
})

test("unreconciled partial or running sync blocks system confirmation", async () => {
  for (const sync of [
    { ...successfulSync, status: "partial" },
    { ...successfulSync, status: "running", completed_at: null },
  ]) {
    const app = fakeClient({ sync })
    await assert.rejects(autoConfirmOverdueAttendance(app.client, now),
      /incomplete attendance synchronization window has not been rechecked/)
    assert.deepEqual(app.writes, [])
  }
})

test("a later unrelated success does not invalidate valid person-specific requery coverage", async () => {
  for (const sync of [
    { sync: { ...successfulSync, people_requested: 0, batches_attempted: 0, requested_people: {} } },
    { sync: { ...successfulSync, requested_people: { other: "ding-other" } } },
    { sync: { ...successfulSync, requested_people: { "person-1": "old-ding-id" } } },
  ]) {
    const app = fakeClient(sync)
    assert.equal((await autoConfirmOverdueAttendance(app.client, now)).systemConfirmed, 1)
  }

  const missingIdentity = fakeClient({ people: [{ ...person, dingtalk_user_id: null }] })
  await assert.rejects(autoConfirmOverdueAttendance(missingIdentity.client, now), /no DingTalk identity/)
  assert.deepEqual(missingIdentity.writes, [])
})

test("a missing sync identity blocks all candidates before any confirmation is written", async () => {
  const second = { ...person, id: "person-2", staff_code: "SC2", dingtalk_user_id: "ding-person-2" }
  const app = fakeClient({
    people: [{ ...person }, second],
    assignments: [{ ...assignment }, { ...assignment, id: "assignment-2", person_id: second.id }],
    reminders: [{ ...reminder }, { ...reminder, person_id: second.id }],
    confirmations: [{ ...pending }, { ...pending, id: "confirmation-2", person_id: second.id }],
    sync: { ...successfulSync, requested_people: { "person-1": "ding-person-1" } },
  })
  await assert.rejects(autoConfirmOverdueAttendance(app.client, now),
    /incomplete full-month synchronization coverage/)
  assert.deepEqual(app.writes, [])
})

test("auto-confirm requires gap-free successful syncs covering the whole Hong Kong month", async () => {
  const cases = [
    historicalSyncs.filter((_, index) => index !== 2),
    historicalSyncs.map((run, index) => index === 2 ? { ...run, status: "partial" } : run),
    historicalSyncs.map((run, index) => index === 2 ? { ...run, status: "failed" } : run),
    historicalSyncs.map((run, index) => index === 2
      ? { ...run, requested_people: { "other-person": "ding-other" } } : run),
    historicalSyncs.map((run, index) => index === 0
      ? { ...run, window_from: "2026-09-30T16:00:00.001Z" } : run),
    historicalSyncs.map((run, index) => index === 4
      ? { ...run, window_to: "2026-10-29T15:59:59.999Z" } : run),
  ]
  for (const syncHistory of cases) {
    const app = fakeClient({ syncHistory })
    await assert.rejects(autoConfirmOverdueAttendance(app.client, now),
      /incomplete full-month synchronization coverage/)
    assert.deepEqual(app.writes, [])
  }
})

test("full-month coverage begun before the review cutoff cannot system-confirm", async () => {
  const tooEarly = historicalSyncs.map((run, index) => ({
    ...run,
    started_at: new Date(Date.parse("2026-11-04T09:50:00.000Z") + index * 2_000).toISOString(),
    completed_at: new Date(Date.parse("2026-11-04T09:50:01.000Z") + index * 2_000).toISOString(),
  }))
  const app = fakeClient({ syncHistory: tooEarly })
  await assert.rejects(autoConfirmOverdueAttendance(app.client, now),
    /incomplete full-month synchronization coverage/)
  assert.deepEqual(app.writes, [])
})

test("historical identity mismatches and open DingTalk anomalies block confirmation", async () => {
  const wrongIdentity = fakeClient({ rawPunches: [{
    id: "old-punch", person_id: person.id, dingtalk_user_id: "old-ding-id",
    work_date: "2026-10-12",
  }] })
  await assert.rejects(autoConfirmOverdueAttendance(wrongIdentity.client, now),
    /punches from another DingTalk identity/)
  assert.deepEqual(wrongIdentity.writes, [])

  for (const openAnomalyCount of [1, null]) {
    const app = fakeClient({ openAnomalyCount })
    await assert.rejects(autoConfirmOverdueAttendance(app.client, now),
      /DingTalk punch correction requires review/)
    assert.deepEqual(app.writes, [])
  }
})

test("a month beginning before the DingTalk import cutoff cannot auto-confirm", async () => {
  const app = fakeClient({
    reminders: [{ ...reminder, month: 8 }],
    confirmations: [{ ...pending, month: 8, updated_at: "2026-09-02T09:00:00.000Z" }],
  })
  await assert.rejects(autoConfirmOverdueAttendance(
    app.client, new Date("2026-09-04T10:00:29.000Z")), /before the DingTalk import cutoff/)
  assert.deepEqual(app.writes, [])
})

test("overlapping successful windows and runs beyond the first database page preserve full-month coverage", async () => {
  const overlapping = historicalSyncs.map((run, index) => index === 1
    ? { ...run, window_from: "2026-10-06T15:00:00.000Z" } : run)
  const redundant = Array.from({ length: 1_000 }, (_, index) => ({
    ...historicalSyncs[0], id: `redundant-${String(index).padStart(4, "0")}`,
  }))
  const app = fakeClient({ syncHistory: [...overlapping, ...redundant] })
  assert.equal((await autoConfirmOverdueAttendance(app.client, now)).systemConfirmed, 1)
  assert.ok(app.readTables.filter((table) => table === "attendance_sync_runs").length >= 2)
})

test("September catch-up ignores a later October-only partial sync", async () => {
  const septemberBoundaries = [
    "2026-08-31T16:00:00.000Z",
    "2026-09-06T16:00:00.000Z",
    "2026-09-12T16:00:00.000Z",
    "2026-09-18T16:00:00.000Z",
    "2026-09-24T16:00:00.000Z",
    "2026-09-29T16:00:00.000Z",
  ]
  const septemberHistory = septemberBoundaries.slice(0, -1).map((from, index) => {
    const to = septemberBoundaries[index + 1]
    return {
      ...successfulSync, id: `september-${index}`,
      started_at: new Date(Date.parse("2026-10-14T10:00:01.000Z") + index * 2_000).toISOString(),
      completed_at: new Date(Date.parse("2026-10-14T10:00:02.000Z") + index * 2_000).toISOString(),
      window_from: from, window_to: to,
    }
  })
  septemberHistory.push({
    ...successfulSync, id: "september-after-cutoff",
    started_at: "2026-10-14T10:00:11.000Z",
    completed_at: "2026-10-14T10:00:12.000Z",
    window_from: septemberBoundaries.at(-1)!,
    window_to: "2026-10-05T10:05:00.000Z",
  })
  const octoberPartial = {
    ...successfulSync, id: "october-partial", status: "partial",
    started_at: "2026-10-14T10:08:00.000Z",
    completed_at: "2026-10-14T10:09:00.000Z",
    window_from: "2026-10-08T16:00:00.000Z",
    window_to: "2026-10-14T10:08:00.000Z",
  }
  const app = fakeClient({
    syncHistory: septemberHistory,
    sync: octoberPartial,
    reminders: [{ ...reminder, month: 9 }],
    confirmations: [{ ...pending, month: 9, updated_at: "2026-10-05T09:00:00.000Z" }],
  })
  assert.equal((await autoConfirmOverdueAttendance(
    app.client, new Date("2026-10-14T10:10:00.000Z"))).systemConfirmed, 1)
})

test("a late partial sync blocks confirmation even when older successful runs covered its window", async () => {
  const lateMalformedRecord = {
    ...successfulSync, id: "late-malformed-record", status: "partial",
    started_at: "2026-11-04T10:00:16.000Z",
    completed_at: "2026-11-04T10:00:17.000Z",
    window_from: "2026-10-02T16:00:00.000Z",
    window_to: "2026-10-09T16:00:00.000Z",
  }
  const app = fakeClient({ syncHistory: [...historicalSyncs, lateMalformedRecord] })
  await assert.rejects(autoConfirmOverdueAttendance(app.client, now),
    /incomplete attendance synchronization window has not been rechecked/)
  assert.deepEqual(app.writes, [])
})

test("later successful syncs with the same identity can jointly reconcile a partial window", async () => {
  const partial = {
    ...successfulSync, id: "partial-history", status: "partial",
    started_at: "2026-11-04T10:00:13.000Z",
    completed_at: "2026-11-04T10:00:14.000Z",
    window_from: "2026-10-09T16:00:00.000Z",
    window_to: "2026-10-13T16:00:00.000Z",
  }
  const firstRecheck = {
    ...successfulSync, id: "first-recheck",
    started_at: "2026-11-04T10:00:16.000Z",
    completed_at: "2026-11-04T10:00:17.000Z",
    window_from: partial.window_from,
    window_to: "2026-10-11T16:00:00.000Z",
  }
  const secondRecheck = {
    ...successfulSync, id: "second-recheck",
    started_at: "2026-11-04T10:00:18.000Z",
    completed_at: "2026-11-04T10:00:19.000Z",
    window_from: firstRecheck.window_to,
    window_to: partial.window_to,
  }
  const wrongIdentity = fakeClient({ syncHistory: [
    ...historicalSyncs, partial, firstRecheck,
    { ...secondRecheck, requested_people: { "person-1": "old-ding-id" } },
  ] })
  await assert.rejects(autoConfirmOverdueAttendance(wrongIdentity.client, now),
    /incomplete attendance synchronization window has not been rechecked/)
  assert.deepEqual(wrongIdentity.writes, [])

  const reconciled = fakeClient({ syncHistory: [
    ...historicalSyncs, partial, firstRecheck, secondRecheck,
  ] })
  assert.equal((await autoConfirmOverdueAttendance(reconciled.client, now)).systemConfirmed, 1)
})

test("failed or running historical windows require a recheck started after the anomaly", async () => {
  for (const status of ["failed", "running"]) {
    const anomaly = {
      ...successfulSync, id: `historical-${status}`, status,
      started_at: "2026-11-04T10:00:16.000Z",
      completed_at: status === "running" ? null : "2026-11-04T10:00:17.000Z",
      window_from: "2026-10-10T16:00:00.000Z",
      window_to: "2026-10-12T16:00:00.000Z",
    }
    const overlappingButTooEarly = {
      ...successfulSync, id: `early-recheck-${status}`,
      started_at: "2026-11-04T10:00:15.000Z",
      completed_at: "2026-11-04T10:00:18.000Z",
      window_from: anomaly.window_from,
      window_to: anomaly.window_to,
    }
    const app = fakeClient({ syncHistory: [
      ...historicalSyncs, anomaly, overlappingButTooEarly,
    ] })
    await assert.rejects(autoConfirmOverdueAttendance(app.client, now),
      /incomplete attendance synchronization window has not been rechecked/)
    assert.deepEqual(app.writes, [])
  }
})

test("catch-up preserves a post-cutoff reopened review and uses exact row version for races", async () => {
  const later = new Date("2026-11-05T10:00:29.000Z")
  const laterSync = {
    ...successfulSync, completed_at: "2026-11-05T09:59:30.000Z",
    window_to: "2026-11-05T09:59:00.000Z",
  }
  const reopened = fakeClient({
    sync: laterSync,
    confirmations: [{ ...pending, updated_at: "2026-11-04T10:30:00.000Z" }],
  })
  assert.equal((await autoConfirmOverdueAttendance(reopened.client, later)).systemConfirmed, 0)
  assert.deepEqual(reopened.writes, [])

  const racing = fakeClient({
    sync: laterSync,
    beforeConfirmationWrite(rows) { rows[0].updated_at = "2026-11-05T09:58:00.000Z" },
  })
  assert.equal((await autoConfirmOverdueAttendance(racing.client, later)).systemConfirmed, 0)
  assert.deepEqual(racing.writes, [])
})

test("prior-month eligibility follows employment and effective-dated assignments", async () => {
  const leaver = { ...person, id: "leaver", is_active: false,
    admin_user_id: null, employment_end_date: "2026-10-15" }
  const hire = { ...person, id: "hire", employment_start_date: "2026-11-01" }
  const app = fakeClient({
    people: [{ ...person }, leaver, hire],
    assignments: [
      { ...assignment },
      { ...assignment, id: "assignment-leaver", person_id: "leaver", effective_to: "2026-10-15" },
      { ...assignment, id: "assignment-hire", person_id: "hire", effective_from: "2026-11-01" },
    ],
  })
  const eligible = await loadAttendancePeopleForPeriod(app.client, 2026, 10)
  assert.deepEqual(eligible.map((value) => value.id), ["person-1", "leaver"])

  const spurious = fakeClient({
    people: [hire],
    assignments: [{ ...assignment, person_id: "hire", effective_from: "2026-11-01" }],
    reminders: [{ ...reminder, person_id: "hire" }],
  })
  assert.equal((await autoConfirmOverdueAttendance(spurious.client, now)).systemConfirmed, 0)
  assert.deepEqual(spurious.writes, [])
})

test("post-requery confirmation uses a fresh source revision and full-month coverage", async () => {
  const app = fakeClient({ syncHistory: [], sync: null })
  const result = await autoConfirmOverdueAttendance(app.client, now, async ({ people }) => {
    assert.deepEqual(people, [{ id: person.id, dingTalkUserId: person.dingtalk_user_id }])
    app.tables.attendance_sync_runs.push(...historicalSyncs.map((run) => ({ ...run })))
    app.bumpRevision()
  })
  assert.equal(result.systemConfirmed, 1)
  assert.equal(app.writes.length, 1)
})

test("post-requery snapshot rejects changed candidates, calendar, reminders, or confirmations", async () => {
  const changes: Array<(tables: Record<string, Row[]>) => void> = [
    (tables) => { tables.attendance_people[0].dingtalk_user_id = "new-ding-id" },
    (tables) => { tables.attendance_people[0].employment_start_date = "2026-10-15" },
    (tables) => { tables.attendance_team_assignments[0].effective_from = "2026-10-15" },
    (tables) => { tables.attendance_reminder_dispatches[0].status = "failed" },
    (tables) => { tables.attendance_monthly_confirmations[0].status = "confirmed" },
    (tables) => { tables.office_calendar_store[0].payload = { events: [{
      title: "PUBLIC HOLIDAY - HONG KONG",
      startDate: "2026-11-02", endDate: "2026-11-02",
    }] } },
  ]
  for (const change of changes) {
    const app = fakeClient()
    await assert.rejects(autoConfirmOverdueAttendance(app.client, now, async () => {
      change(app.tables)
      app.bumpRevision()
    }), { name: "AttendanceSourceChangedError" })
    assert.deepEqual(app.writes, [])
  }
})

test("post-requery snapshot and checked write reject intervening source changes", async () => {
  let mutateDuringFreshRead = false
  let app = fakeClient({
    onRead(table) {
      if (mutateDuringFreshRead && table === "attendance_people") {
        mutateDuringFreshRead = false
        app.bumpRevision()
      }
    },
  })
  await assert.rejects(autoConfirmOverdueAttendance(app.client, now, async () => {
    app.bumpRevision()
    mutateDuringFreshRead = true
  }), { name: "AttendanceSourceChangedError" })
  assert.deepEqual(app.writes, [])

  let changedAtWrite = false
  app = fakeClient({
    beforeConfirmationWrite() {
      if (!changedAtWrite) {
        changedAtWrite = true
        app.bumpRevision()
      }
    },
  })
  await assert.rejects(autoConfirmOverdueAttendance(app.client, now),
    { name: "AttendanceSourceChangedError" })
  assert.deepEqual(app.writes, [])
})

test("post-requery historical DingTalk identity changes block confirmation", async () => {
  const app = fakeClient()
  await assert.rejects(autoConfirmOverdueAttendance(app.client, now, async () => {
    app.tables.attendance_raw_punches.push({
      id: "old-punch", person_id: person.id, dingtalk_user_id: "old-ding-id",
      work_date: "2026-10-12",
    })
    app.bumpRevision()
  }), /punches from another DingTalk identity/)
  assert.deepEqual(app.writes, [])
})
