import assert from "node:assert/strict"
import test from "node:test"
import { getAdminPageByPath, getAdminPagesByGroup } from "../lib/adminPages"
import { defaultEventCalendarPeople } from "../lib/eventCalendarPeople"
import { compareOfficeStaff, officeStaffOrder } from "../lib/officeStaffOrder"
import {
  applyTaskAllocationMutation,
  parseTaskAllocationMutation,
  parseTaskAllocationSchedule,
  resolveTaskAllocation,
  saveTaskAllocation,
  TaskAllocationConflictError,
  TaskAllocationValidationError,
} from "../lib/taskAllocation"

const schedule = parseTaskAllocationSchedule({
  effectiveDate: "2026-04-20",
  tasks: [
    { id: 4, category: "Sales", title: "REGIONAL SALES", region: "ASIA", assignees: ["LONG", "OL"] },
    { id: 5, category: "Support", title: "SHARED TASK", assignees: ["SC/VL", "vl / LONG"] },
    { id: 6, category: "Support", title: "GROUP TASK", assignees: ["BT/SC", "KZ"] },
    { id: 7, category: "Support", title: "OPEN TASK", assignees: [] },
  ],
})

test("Task Allocation is registered under Office Tools", () => {
  const page = getAdminPageByPath("/admin/taskallocation")
  assert.equal(page?.id, "task-allocation")
  assert.equal(page?.label, "TASK ALLOCATION")
  assert.ok(page && getAdminPagesByGroup("office").includes(page))
})

test("uses the office order, keeps the calendar roster, and resolves individual assignees", () => {
  const result = resolveTaskAllocation(schedule, ["VL", "SC", " unassigned ", "LV", "LONG", "??"], ["NN", "KZ"])
  assert.deepEqual(result.people, ["VL", "SC", "OL", "KZ", "LV", "NN", "UNASSIGNED"])
  assert.deepEqual(result.tasks.map((task) => task.assignees), [
    ["OL", "LV"],
    ["VL", "SC", "LV"],
    ["SC", "KZ", "NN"],
    [],
  ])
  assert.deepEqual(resolveTaskAllocation(schedule, [], ["JZ"]).tasks[2].assignees, ["SC", "KZ", "JZ"])
  assert.deepEqual(resolveTaskAllocation(schedule, [], []).tasks[2].assignees, ["SC", "KZ"])
})

test("uses the configured BT members and appends unlisted staff in their existing order", () => {
  const source = { ...schedule, btPeople: ["KI", "VL"], notes: "keep" }
  const result = resolveTaskAllocation(source, ["EXTRA2", ...[...officeStaffOrder].reverse(), "EXTRA1"], ["CY", "JZ"])
  assert.deepEqual(result.people, [...officeStaffOrder, "EXTRA2", "EXTRA1"])
  assert.deepEqual(result.btPeople, ["VL", "KI"])
  assert.deepEqual(result.tasks[2].assignees, ["VL", "SC", "KZ", "KI"])
  assert.deepEqual(result.tasks[2].directAssignees, ["SC", "KZ"])
  assert.equal(result.tasks[2].assignedToBt, true)
  assert.deepEqual(["LL", "DT", "ML"].sort(compareOfficeStaff), ["ML", "DT", "LL"])
})

test("uses the Event Calendar defaults only when the saved roster is absent", () => {
  const emptySchedule = { ...schedule, tasks: [] }
  assert.deepEqual(resolveTaskAllocation(emptySchedule, null, []).people, defaultEventCalendarPeople)
  assert.deepEqual(resolveTaskAllocation(emptySchedule, [], []).people, [])
})

test("rejects invalid dates, rows and duplicate source IDs", () => {
  assert.throws(() => parseTaskAllocationSchedule({ ...schedule, effectiveDate: "2026-02-30" }), /Invalid task allocation/)
  assert.throws(() => parseTaskAllocationSchedule({ ...schedule, tasks: [{ ...schedule.tasks[0], assignees: [42] }] }), /Invalid task allocation/)
  assert.throws(() => parseTaskAllocationSchedule({ ...schedule, tasks: [schedule.tasks[0], schedule.tasks[0]] }), /Invalid task allocation/)
  assert.throws(() => parseTaskAllocationMutation({ id: 4, version: "stale", assignees: [] }), TaskAllocationValidationError)
})

test("only updates the selected task and rejects a stale or out-of-roster assignment", () => {
  const current = { ...schedule, btPeople: ["VL", "KI"], notes: "keep" }
  const roster = resolveTaskAllocation(current, ["VL", "SC", "KI"], [])
  const task = roster.tasks[2]
  assert.throws(() => applyTaskAllocationMutation(current, roster, {
    id: task.id, version: task.version, assignees: ["UNLISTED"],
  }), TaskAllocationValidationError)
  const mutation = { id: task.id, version: task.version, assignees: ["BT", "KI"] }
  const next = applyTaskAllocationMutation(current, roster, mutation)
  assert.deepEqual(next.tasks[2], { ...schedule.tasks[2], assignees: ["BT", "KI"] })
  assert.deepEqual(next.tasks[3], schedule.tasks[3])
  assert.equal("notes" in next && next.notes, "keep")
  const latest = resolveTaskAllocation(next, ["VL", "SC", "KI"], [])
  assert.equal(applyTaskAllocationMutation(next, latest, mutation), next)
  assert.throws(() => applyTaskAllocationMutation(next, latest, { ...mutation, assignees: [] }), TaskAllocationConflictError)
})

test("concurrent saves on different tasks merge and a stale edit keeps the saved assignment", async () => {
  let row = { payload: { ...schedule, btPeople: ["VL", "KI"] }, updated_at: "2026-11-23T02:00:00.000Z" }
  const calendarPeople = ["LV", "SC", "KI"]
  const client = {
    from(table: string) {
      assert.equal(table, "office_calendar_store")
      let key: string, version: string, update: typeof row | undefined, columns: string
      const query = {
        select(value: string) { columns = value; return query },
        eq(column: string, value: string) {
          if (column === "key") key = value
          else if (column === "updated_at") version = value
          else assert.fail(column)
          return query
        },
        update(value: typeof row) { update = value; return query },
        async maybeSingle() {
          await new Promise<void>((done) => setImmediate(done))
          if (key === "event-calendar") return { data: { people: calendarPeople }, error: null }
          assert.equal(key, "task-allocation")
          if (update) {
            if (version !== row.updated_at) return { data: null, error: null }
            assert.ok(columns.split(",").includes("updated_at"))
            row = structuredClone(update)
          }
          return { data: structuredClone(row), error: null }
        },
      }
      return query
    },
  }
  const original = resolveTaskAllocation(row.payload, calendarPeople, [])
  const first = { id: 4, version: original.tasks[0].version, assignees: ["KI"] }
  const second = { id: 5, version: original.tasks[1].version, assignees: [] }
  const saves = await Promise.all([saveTaskAllocation(client as never, first), saveTaskAllocation(client as never, second)])
  assert.deepEqual(row.payload.tasks.map((task) => task.assignees), [
    ["KI"], [], schedule.tasks[2].assignees, schedule.tasks[3].assignees,
  ])
  assert.equal(saves.map((allocation) => allocation.updatedAt).sort().at(-1), row.updated_at)
  assert.equal(new Set(saves.map((allocation) => allocation.updatedAt)).size, 2)
  assert.equal((await saveTaskAllocation(client as never, first)).updatedAt, row.updated_at)
  await assert.rejects(saveTaskAllocation(client as never, { ...first, assignees: ["LV"] }), (error) =>
    error instanceof TaskAllocationConflictError && error.allocation?.updatedAt === row.updated_at,
  )
})
