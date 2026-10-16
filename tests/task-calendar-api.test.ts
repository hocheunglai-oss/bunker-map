import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { transformSync } from "esbuild"
import * as taskData from "../data/taskCalendar"
import * as taskStore from "../lib/taskCalendarStore"
import * as calendarResponse from "../lib/eventCalendarResponse"
import { resolveCalendarStaffRecipients, type CalendarStaff } from "../lib/calendarStaff"

const task = (id = "a") => ({ id, sourceRow: 0, scheduleType: "Monthly", daysOfMonth: Array.from({ length: 31 }, (_, i) => i + 1), months: [], notify: ["DT", "JZ"], cc: ["DT"], task: "Synthetic task", remark: "Synthetic only" })
type Handler = (request: Request, context?: { params: Promise<{ key: string }> }) => Promise<Response>
function harness(options: { permission?: "view" | "edit" | "none"; signedIn?: boolean; tasks?: unknown[]; readError?: boolean; unresolved?: string[]; holdFirstDelivery?: Promise<void> } = {}) {
  const permission = options.permission ?? "edit"
  const session = { authenticated: options.signedIn !== false }
  let row = { payload: { tasks: options.tasks ?? [task()], deletedTaskIds: [] }, updated_at: "2026-10-07T00:00:00.000Z" }
  let writes = 0
  let failReads = options.readError ?? false
  let failStaffReads = false, staffReads = 0
  const deliveries: Record<string, unknown>[] = []
  const deliveredIds = new Set<string>()
  const client = { from(table: string) {
    assert.equal(table, "office_calendar_store")
    let changed: Record<string, unknown> | null = null
    let expected = ""
    const query = {
      select() { return query }, eq(field: string, value: unknown) { if (field === "key") assert.equal(value, "task-calendar"); if (field === "updated_at") expected = String(value); return query },
      update(value: Record<string, unknown>) { changed = value; return query },
      async maybeSingle() {
        if (failReads) return { data: null, error: new Error("Synthetic database unavailable") }
        if (!changed) return { data: structuredClone(row), error: null }
        if (expected !== row.updated_at) return { data: null, error: null }
        writes += 1
        row = structuredClone(changed) as typeof row
        return { data: { payload: row.payload }, error: null }
      },
    }
    return query
  } }
  let staff: CalendarStaff[] = ["DT", "JZ", "OL"].map((code) => ({ code, name: `${code} synthetic`, email: (options.unresolved || []).includes(code) ? null : `${code.toLowerCase()}@example.test` }))
  const modules: Record<string, unknown> = {
    "next/server": { NextResponse: { json: Response.json.bind(Response) } },
    "@supabase/supabase-js": { createClient: () => client },
    "@/lib/adminAuth": {
      getAdminSession: async () => session,
      hasAdminPagePermission: (_session: unknown, page: string, access: string) => { assert.equal(page, "task-calendar"); return permission === "edit" || permission === "view" && access === "view" },
      requireAdminPagePermission: async (page: string, access: string) => { assert.equal(page, "task-calendar"); assert.equal(access, "edit"); if (!session.authenticated) throw new Error("Unauthorized"); if (permission !== "edit") throw new Error("Forbidden"); return session },
    },
    "@/lib/adminAudit": { createAdminAuditContext: () => ({}), createAdminAuditedSupabaseClient: () => client },
    "@/lib/eventCalendarStore": {},
    "@/lib/eventCalendarProtocol": { EVENT_CALENDAR_PROTOCOL_VERSION: 2 },
    "@/lib/eventCalendarResponse": calendarResponse,
    "@/data/taskCalendar": taskData,
    "@/lib/taskCalendarStore": taskStore,
    "@/lib/calendarStaff": {
      loadCalendarStaffDirectory: async () => { staffReads += 1; if (failStaffReads) throw new Error("The staff directory is unavailable. No recipient addresses were guessed."); return structuredClone(staff) },
      resolveCalendarStaffRecipients,
    },
    "@/lib/calendarDelivery": { getCalendarReminderDelivery: async (value: { recordId: string }) => deliveredIds.has(value.recordId) ? { status: "already_delivered", sent: 1 } : null, deliverCalendarReminder: async (value: Record<string, unknown>) => {
      if (deliveredIds.has(String(value.recordId))) return { status: "already_delivered", sent: 0 }
      deliveredIds.add(String(value.recordId)); deliveries.push(value)
      if (deliveries.length === 1) await options.holdFirstDelivery
      return { status: "delivered", sent: 1 }
    } },
  }
  function load(path: string) {
    const code = transformSync(readFileSync(new URL(path, import.meta.url), "utf8"), { loader: "ts", format: "cjs", target: "node24" }).code
    const loaded: { exports: Record<string, Handler> } = { exports: {} }
    new Function("require", "module", "exports", "process", code)((name: string) => {
      assert.ok(Object.hasOwn(modules, name), `Unexpected route dependency ${name}`)
      return modules[name]
    }, loaded, loaded.exports, { env: { NEXT_PUBLIC_SUPABASE_URL: "https://example.test", SUPABASE_SERVICE_ROLE_KEY: "synthetic-only" } })
    return loaded.exports
  }
  const store = load("../app/api/office-calendar-store/[key]/route.ts")
  const reminder = load("../app/api/task-calendar/daily-reminder/route.ts")
  return {
    writes: () => writes, deliveries, payload: () => row.payload,
    failReads() { failReads = true },
    failStaffReads() { failStaffReads = true },
    staffReads: () => staffReads,
    changeStaff(change: (value: CalendarStaff[]) => CalendarStaff[]) { staff = change(structuredClone(staff)) },
    async request(method: string, body?: unknown) {
      const response = await store[method](new Request("https://example.test/api/office-calendar-store/task-calendar", { method, ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) }), { params: Promise.resolve({ key: "task-calendar" }) })
      return { status: response.status, body: await response.json() }
    },
    async remind(dryRun = false) {
      const response = await reminder.GET(new Request(`https://example.test/api/task-calendar/daily-reminder${dryRun ? "?dryRun=1" : ""}`))
      return { status: response.status, body: await response.json() }
    },
  }
}

test("actual API GET is read-only, supplies staff and versions, and permits View access", async () => {
  const app = harness({ permission: "view" })
  const result = await app.request("GET")
  assert.equal(result.status, 200)
  assert.equal(result.body.protocolVersion, 1)
  assert.match(result.body.taskVersions.a, /^[a-f0-9]{64}$/)
  assert.deepEqual(result.body.staff.map((entry: { code: string }) => entry.code), ["DT", "JZ", "OL"])
  assert.equal(app.writes(), 0)
  assert.equal((await app.request("PATCH", { protocolVersion: 1, operation: "create", task: task("new") })).status, 403)
  assert.equal((await app.remind()).status, 403)
  assert.equal(app.writes(), 0)
  assert.deepEqual(app.deliveries, [])
})

test("actual API rejects anonymous/no-access users and outdated whole-list clients", async () => {
  assert.equal((await harness({ signedIn: false }).request("GET")).status, 401)
  assert.equal((await harness({ permission: "none" }).request("GET")).status, 403)
  const app = harness()
  assert.equal((await app.request("PUT", { tasks: [] })).status, 409)
  assert.equal((await app.request("PATCH", { operation: "delete", taskId: "a" })).status, 409)
  assert.equal(app.writes(), 0)
})

test("actual API validates recurrence and recipient resolution before writing", async () => {
  for (const invalid of [{ ...task(), scheduleType: "Weekly" }, { ...task(), scheduleType: "Yearly" }, { ...task(), notify: [] }]) {
    const app = harness()
    assert.equal((await app.request("PATCH", { protocolVersion: 1, operation: "create", task: invalid })).status, 400)
    assert.equal(app.writes(), 0)
  }
  const unresolved = harness({ unresolved: ["JZ"] })
  const response = await unresolved.request("PATCH", { protocolVersion: 1, operation: "create", task: task("new") })
  assert.equal(response.status, 400)
  assert.match(response.body.message, /JZ/)
  assert.equal(unresolved.writes(), 0)
})

test("actual API applies confirmed CAS edits and rejects stale delete", async () => {
  const app = harness()
  const before = await app.request("GET")
  const edited = await app.request("PATCH", { protocolVersion: 1, operation: "update", task: { ...task(), task: "New title" }, expectedTaskVersion: before.body.taskVersions.a })
  assert.equal(edited.status, 200)
  assert.equal(edited.body.payload.tasks[0].task, "New title")
  assert.equal(app.writes(), 1)
  const conflict = await app.request("PATCH", { protocolVersion: 1, operation: "delete", taskId: "a", expectedTaskVersion: before.body.taskVersions.a })
  assert.equal(conflict.status, 409)
  assert.equal(conflict.body.code, "TASK_CALENDAR_CONFLICT")
  assert.equal(app.writes(), 1)
})

test("reminder respects empty storage and fails closed on read failure without default emails", async () => {
  const empty = harness({ tasks: [] })
  const emptyResult = await empty.remind()
  assert.equal(emptyResult.status, 200)
  assert.equal(emptyResult.body.due, 0)
  assert.deepEqual(empty.deliveries, [])
  const broken = harness({ readError: true })
  assert.equal((await broken.remind()).status, 500)
  assert.deepEqual(broken.deliveries, [])
})

test("reminder resolves DT/JZ, removes duplicate CC, is dry-run-safe and respects durable duplicate result", async () => {
  const app = harness()
  const preview = await app.remind(true)
  assert.equal(preview.status, 200)
  assert.equal(app.deliveries.length, 0)
  const first = await app.remind()
  assert.equal(first.status, 200)
  assert.equal(app.deliveries.length, 1)
  assert.equal(app.deliveries[0].kind, "task")
  assert.equal(app.deliveries[0].occurrenceDate, taskData.getHongKongTaskDate())
  assert.deepEqual(app.deliveries[0].to, ["dt@example.test", "jz@example.test"])
  assert.deepEqual(app.deliveries[0].cc, [])
  const second = await app.remind()
  assert.equal(second.status, 200)
  assert.equal(second.body.sent.length, 0)
  assert.equal(second.body.skipped[0].reason, "Already sent for this date.")
  assert.equal(app.deliveries.length, 1)
})

test("unresolved recipients do not silently get omitted or permit partial task delivery", async () => {
  const app = harness({ unresolved: ["JZ"] })
  const response = await app.remind()
  assert.equal(response.status, 500)
  assert.match(response.body.failed[0].reason, /JZ/)
  assert.deepEqual(app.deliveries, [])
})

test("a task deleted during an earlier reminder delivery is not emailed from the old snapshot", async () => {
  let release!: () => void
  const app = harness({ tasks: [task("a"), task("b")], holdFirstDelivery: new Promise<void>((resolve) => { release = resolve }) })
  const before = await app.request("GET")
  const pending = app.remind()
  while (!app.deliveries.length) await new Promise<void>((resolve) => setImmediate(resolve))
  try {
    assert.equal((await app.request("PATCH", { protocolVersion: 1, operation: "delete", taskId: "b", expectedTaskVersion: before.body.taskVersions.b })).status, 200)
  } finally { release() }
  const result = await pending
  assert.equal(result.status, 200)
  assert.deepEqual(app.deliveries.map((delivery) => delivery.recordId), ["a"])
  assert.deepEqual(result.body.skipped, [{ id: "b", reason: "Task was deleted before this reminder was sent." }])
})

test("a task edited during delivery uses its current recipients and content", async () => {
  let release!: () => void
  const app = harness({ tasks: [task("a"), task("b")], holdFirstDelivery: new Promise<void>((resolve) => { release = resolve }) })
  const before = await app.request("GET")
  const pending = app.remind()
  while (!app.deliveries.length) await new Promise<void>((resolve) => setImmediate(resolve))
  try {
    assert.equal((await app.request("PATCH", { protocolVersion: 1, operation: "update", task: { ...task("b"), notify: ["OL"], cc: ["JZ"], task: "Current task", remark: "Current remark" }, expectedTaskVersion: before.body.taskVersions.b })).status, 200)
  } finally { release() }
  const result = await pending
  assert.equal(result.status, 200)
  assert.equal(app.deliveries.length, 2)
  assert.equal(app.deliveries[1].recordId, "b")
  assert.deepEqual(app.deliveries[1].to, ["ol@example.test"])
  assert.deepEqual(app.deliveries[1].cc, ["jz@example.test"])
  assert.equal(app.deliveries[1].subject, "***** Current task")
  assert.match(String(app.deliveries[1].html), /Current remark/)
})

test("a task rescheduled during delivery is checked again for today's occurrence", async () => {
  let release!: () => void
  const app = harness({ tasks: [task("a"), task("b")], holdFirstDelivery: new Promise<void>((resolve) => { release = resolve }) })
  const before = await app.request("GET")
  const pending = app.remind()
  while (!app.deliveries.length) await new Promise<void>((resolve) => setImmediate(resolve))
  const otherWeekday = (new Date(`${taskData.getHongKongTaskDate()}T00:00:00Z`).getUTCDay() + 1) % 7
  try {
    assert.equal((await app.request("PATCH", { protocolVersion: 1, operation: "update", task: { ...task("b"), scheduleType: "Weekly", dayOfWeek: otherWeekday, daysOfMonth: [] }, expectedTaskVersion: before.body.taskVersions.b })).status, 200)
  } finally { release() }
  const result = await pending
  assert.equal(result.status, 200)
  assert.deepEqual(app.deliveries.map((delivery) => delivery.recordId), ["a"])
  assert.deepEqual(result.body.skipped, [{ id: "b", reason: "Task schedule changed; no reminder is due for this date." }])
})

test("a current-task read failure never falls back to the old due-task snapshot", async () => {
  let release!: () => void
  const app = harness({ tasks: [task("a"), task("b")], holdFirstDelivery: new Promise<void>((resolve) => { release = resolve }) })
  const pending = app.remind()
  while (!app.deliveries.length) await new Promise<void>((resolve) => setImmediate(resolve))
  app.failReads()
  release()
  const result = await pending
  assert.equal(result.status, 500)
  assert.deepEqual(app.deliveries.map((delivery) => delivery.recordId), ["a"])
  assert.deepEqual(result.body.failed, [{ id: "b", reason: "The current task could not be checked. This reminder was not sent." }])
})

test("a canonical email changed during an earlier delivery is refreshed before the next reminder", async () => {
  let release!: () => void
  const app = harness({ tasks: [task("a"), { ...task("b"), notify: ["OL"], cc: ["JZ"] }], holdFirstDelivery: new Promise<void>((resolve) => { release = resolve }) })
  const pending = app.remind()
  while (!app.deliveries.length) await new Promise<void>((resolve) => setImmediate(resolve))
  try { app.changeStaff((staff) => staff.map((entry) => ({ ...entry, email: entry.code === "OL" ? "current-ol@example.test" : entry.code === "JZ" ? "current-jz@example.test" : entry.email }))) }
  finally { release() }
  const result = await pending
  assert.equal(result.status, 200)
  assert.equal(app.staffReads(), 2)
  assert.deepEqual(app.deliveries[1].to, ["current-ol@example.test"])
  assert.deepEqual(app.deliveries[1].cc, ["current-jz@example.test"])
})

test("a staff account deactivated during an earlier delivery stops the next reminder without a guessed address", async () => {
  let release!: () => void
  const app = harness({ tasks: [task("a"), { ...task("b"), notify: ["OL"], cc: [] }], holdFirstDelivery: new Promise<void>((resolve) => { release = resolve }) })
  const pending = app.remind()
  while (!app.deliveries.length) await new Promise<void>((resolve) => setImmediate(resolve))
  try { app.changeStaff((staff) => staff.filter((entry) => entry.code !== "OL")) }
  finally { release() }
  const result = await pending
  assert.equal(result.status, 500)
  assert.equal(app.staffReads(), 2)
  assert.deepEqual(app.deliveries.map((delivery) => delivery.recordId), ["a"])
  assert.match(result.body.failed[0].reason, /OL.*not sent/)
  const retry = await app.remind()
  assert.equal(retry.status, 500)
  assert.deepEqual(retry.body.skipped, [{ id: "a", reason: "Already sent for this date." }])
  assert.deepEqual(app.deliveries.map((delivery) => delivery.recordId), ["a"])
})

test("a staff read failure after an earlier delivery never reuses the earlier directory", async () => {
  let release!: () => void
  const app = harness({ tasks: [task("a"), task("b")], holdFirstDelivery: new Promise<void>((resolve) => { release = resolve }) })
  const pending = app.remind()
  while (!app.deliveries.length) await new Promise<void>((resolve) => setImmediate(resolve))
  try { app.failStaffReads() }
  finally { release() }
  const result = await pending
  assert.equal(result.status, 500)
  assert.equal(app.staffReads(), 2)
  assert.deepEqual(app.deliveries.map((delivery) => delivery.recordId), ["a"])
  assert.deepEqual(result.body.failed, [{ id: "b", reason: "The staff directory is unavailable. No recipient addresses were guessed." }])
})

test("already delivered slots skip directory reads and cannot become false staff failures", async () => {
  const app = harness({ tasks: [task("a"), task("b")] })
  assert.equal((await app.remind()).status, 200)
  assert.equal(app.staffReads(), 2)
  app.failStaffReads()
  const retry = await app.remind()
  assert.equal(retry.status, 200)
  assert.equal(app.staffReads(), 2)
  assert.equal(retry.body.failed.length, 0)
  assert.equal(retry.body.skipped.length, 2)
  assert.equal(app.deliveries.length, 2)
})
