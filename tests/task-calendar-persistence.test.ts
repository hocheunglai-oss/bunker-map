import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import {
  applyTaskCalendarMutation, getTaskCalendarVersions, mutateTaskCalendarStore, TaskCalendarConflictError,
} from "../lib/taskCalendarStore"
import {
  getDueTaskCalendarTasks, getHongKongTaskDate, isTaskDueOnDate, parseTaskDays, readTaskCalendarTasks,
  TaskCalendarValidationError, validateTaskCalendarTask, type TaskCalendarTask,
} from "../data/taskCalendar"

function task(id = "a", title = "Task A"): TaskCalendarTask {
  return { id, sourceRow: 0, scheduleType: "Monthly", daysOfMonth: [1, 16], months: [], notify: ["OL"], cc: [], task: title, remark: "" }
}
function fakeSupabase(initial: Record<string, unknown> | null) {
  let row: { payload: Record<string, unknown>; updated_at: string } | null = initial ? { payload: structuredClone(initial), updated_at: "2026-10-07T00:00:00.000Z" } : null
  const client = { from(table: string) {
    assert.equal(table, "office_calendar_store")
    let mode = "read", expected = "", values: Record<string, unknown> = {}
    const query = {
      select() { return query },
      eq(key: string, value: unknown) { if (key === "key") assert.equal(value, "task-calendar"); if (key === "updated_at") expected = String(value); return query },
      insert(next: Record<string, unknown>) { mode = "insert"; values = next; return query },
      update(next: Record<string, unknown>) { mode = "update"; values = next; return query },
      async maybeSingle() {
        await new Promise<void>((resolve) => setImmediate(resolve))
        if (mode === "read") return { data: structuredClone(row), error: null }
        if (mode === "insert" && row) return { data: null, error: { code: "23505" } }
        if (mode === "update" && expected !== row?.updated_at) return { data: null, error: null }
        row = { payload: structuredClone(values.payload as Record<string, unknown>), updated_at: String(values.updated_at) }
        return { data: { payload: structuredClone(row.payload) }, error: null }
      },
    }
    return query
  } }
  return { client, payload: () => structuredClone(row?.payload) }
}

test("stale edits to different tasks merge but same-task edits conflict", () => {
  const current = { tasks: [task(), task("b", "Task B")], deletedTaskIds: ["old"], metadata: "keep" }
  const versions = getTaskCalendarVersions(current)
  const first = applyTaskCalendarMutation(current, { operation: "update", task: task("a", "Updated A"), expectedTaskVersion: versions.a })
  const second = applyTaskCalendarMutation(first, { operation: "update", task: task("b", "Updated B"), expectedTaskVersion: versions.b })
  assert.deepEqual((second.tasks as TaskCalendarTask[]).map((item) => item.task), ["Updated A", "Updated B"])
  assert.equal(second.metadata, "keep")
  assert.deepEqual(second.deletedTaskIds, ["old"])
  assert.throws(() => applyTaskCalendarMutation(second, { operation: "update", task: task("a", "Stale A"), expectedTaskVersion: versions.a }), TaskCalendarConflictError)
})

test("edit/delete races cannot overwrite a newer edit or resurrect a deleted task", () => {
  const initial = { tasks: [task()], deletedTaskIds: [] }
  const expectedTaskVersion = getTaskCalendarVersions(initial).a
  const updated = applyTaskCalendarMutation(initial, { operation: "update", task: task("a", "Changed"), expectedTaskVersion })
  assert.throws(() => applyTaskCalendarMutation(updated, { operation: "delete", taskId: "a", expectedTaskVersion }), TaskCalendarConflictError)
  const deleted = applyTaskCalendarMutation(initial, { operation: "delete", taskId: "a", expectedTaskVersion })
  assert.deepEqual(deleted.tasks, [])
  assert.deepEqual(deleted.deletedTaskIds, ["a"])
  assert.throws(() => applyTaskCalendarMutation(deleted, { operation: "update", task: task(), expectedTaskVersion }), TaskCalendarConflictError)
  assert.throws(() => applyTaskCalendarMutation(deleted, { operation: "create", task: task() }), TaskCalendarConflictError)
  assert.deepEqual(applyTaskCalendarMutation(deleted, { operation: "delete", taskId: "a", expectedTaskVersion }), deleted)
})

test("lost-response retries are idempotent but ID collisions cannot overwrite", () => {
  const created = applyTaskCalendarMutation(null, { operation: "create", task: task() })
  assert.deepEqual(applyTaskCalendarMutation(created, { operation: "create", task: task() }), created)
  assert.throws(() => applyTaskCalendarMutation(created, { operation: "create", task: task("a", "Different") }), TaskCalendarConflictError)
  const expectedTaskVersion = getTaskCalendarVersions(created).a
  const updated = applyTaskCalendarMutation(created, { operation: "update", task: task("a", "Changed"), expectedTaskVersion })
  assert.deepEqual(applyTaskCalendarMutation(updated, { operation: "update", task: task("a", "Changed"), expectedTaskVersion }), updated)
})

test("twenty simultaneous creators preserve every task, including first-row creation races", async () => {
  for (const initial of [null, { tasks: [], deletedTaskIds: [] }]) {
    const db = fakeSupabase(initial)
    await Promise.all(Array.from({ length: 20 }, (_, index) => mutateTaskCalendarStore(db.client as never, { operation: "create", task: task(`new-${index}`) })))
    const tasks = db.payload()?.tasks as TaskCalendarTask[]
    assert.equal(tasks.length, 20)
    assert.equal(new Set(tasks.map((item) => item.id)).size, 20)
  }
})

test("twenty stale clients editing different tasks all survive the real CAS retry loop", async () => {
  const tasks = Array.from({ length: 20 }, (_, index) => task(`task-${index}`, `Old ${index}`))
  const payload = { tasks, deletedTaskIds: ["preserve"] }
  const versions = getTaskCalendarVersions(payload)
  const db = fakeSupabase(payload)
  await Promise.all(tasks.map((item, index) => mutateTaskCalendarStore(db.client as never, { operation: "update", task: { ...item, task: `New ${index}` }, expectedTaskVersion: versions[item.id] })))
  assert.deepEqual((db.payload()?.tasks as TaskCalendarTask[]).map((item) => item.task), tasks.map((_, index) => `New ${index}`))
  assert.deepEqual(db.payload()?.deletedTaskIds, ["preserve"])
})

test("concurrent edits to the same task produce one winner and one conflict", async () => {
  const payload = { tasks: [task()], deletedTaskIds: [] }
  const db = fakeSupabase(payload)
  const expectedTaskVersion = getTaskCalendarVersions(payload).a
  const results = await Promise.allSettled(["Winner 1", "Winner 2"].map((name) => mutateTaskCalendarStore(db.client as never, { operation: "update", task: task("a", name), expectedTaskVersion })))
  assert.equal(results.filter((item) => item.status === "fulfilled").length, 1)
  const rejected = results.find((item) => item.status === "rejected") as PromiseRejectedResult
  assert.ok(rejected.reason instanceof TaskCalendarConflictError)
})

test("authoritative empty or missing storage never revives bundled tasks", () => {
  assert.deepEqual(readTaskCalendarTasks({ tasks: [], deletedTaskIds: ["deleted"] }), [])
  assert.deepEqual(readTaskCalendarTasks(null), [])
  assert.deepEqual(getDueTaskCalendarTasks("2026-10-01"), [])
  assert.throws(() => readTaskCalendarTasks({}), TaskCalendarValidationError)
  assert.throws(() => readTaskCalendarTasks({ tasks: [{ ...task(), notify: null }] }), TaskCalendarValidationError)
  assert.throws(() => readTaskCalendarTasks({ tasks: [task(), task()] }), TaskCalendarValidationError)
})

test("strict schedule, day-list, text and recipient validation never invents defaults", () => {
  for (const invalid of [
    { scheduleType: "Weekly", dayOfWeek: undefined }, { scheduleType: "Weekly", dayOfWeek: 7 },
    { scheduleType: "Yearly", months: [] }, { daysOfMonth: [] }, { daysOfMonth: [0, 32] },
    { daysOfMonth: [1.5] }, { scheduleType: "Daily" }, { notify: [] }, { notify: [""] },
    { cc: "OL" }, { task: "  " }, { remark: null }, { id: " a " },
  ]) assert.throws(() => validateTaskCalendarTask({ ...task(), ...invalid }), TaskCalendarValidationError)
  for (const invalid of ["", "32", "1, wrong", "1.5", "-1", "0", "1, 2e1"]) assert.throws(() => parseTaskDays(invalid), TaskCalendarValidationError)
  assert.deepEqual(parseTaskDays("31, 1; 15 1"), [1, 15, 31])
  assert.equal(validateTaskCalendarTask({ ...task(), scheduleType: "Weekly", dayOfWeek: 0 }).dayOfWeek, 0)
})

test("Hong Kong day boundaries and month-end recurrences are deterministic", () => {
  assert.equal(getHongKongTaskDate(new Date("2026-10-07T15:59:59Z")), "2026-10-07")
  assert.equal(getHongKongTaskDate(new Date("2026-10-07T16:00:00Z")), "2026-10-08")
  const thursday = { ...task(), scheduleType: "Weekly" as const, dayOfWeek: 4, daysOfMonth: [] }
  assert.equal(isTaskDueOnDate(thursday, new Date("2026-10-07T16:00:00Z")), true)
  assert.equal(isTaskDueOnDate(thursday, new Date("2026-10-07T15:59:59Z")), false)
  for (const day of ["2026-02-28", "2028-02-29", "2026-04-30"]) assert.equal(isTaskDueOnDate({ ...task(), daysOfMonth: [31] }, day), true)
  assert.equal(isTaskDueOnDate({ ...task(), scheduleType: "Yearly", daysOfMonth: [31], months: [2] }, "2028-02-29"), true)
  assert.equal(isTaskDueOnDate({ ...task(), scheduleType: "Yearly", daysOfMonth: [31], months: [3] }, "2028-02-29"), false)
  assert.throws(() => isTaskDueOnDate(task(), "2026-02-30"), TaskCalendarValidationError)
})

test("old whole-list clients are rejected and current UI cannot autosave snapshots", () => {
  const route = readFileSync(new URL("../app/api/office-calendar-store/[key]/route.ts", import.meta.url), "utf8")
  assert.match(route, /TASK_CALENDAR_CLIENT_OUTDATED/)
  assert.match(route, /mutateTaskCalendarStore/)
  assert.doesNotMatch(route, /mergeTaskCalendarPayload/)
  const page = readFileSync(new URL("../app/admin/taskcalendar/page.tsx", import.meta.url), "utf8")
  assert.match(page, /method: "PATCH"/)
  assert.doesNotMatch(page, /method: "PUT"|localStorage|remoteSaveTimerRef|setTimeout/)
  const reminder = readFileSync(new URL("../app/api/task-calendar/daily-reminder/route.ts", import.meta.url), "utf8")
  assert.match(reminder, /deliverCalendarReminder/)
  assert.doesNotMatch(reminder, /taskCalendarTasks|resolveTaskRecipients|sendCalendarEmail/)
})
