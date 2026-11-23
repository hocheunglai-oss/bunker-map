import assert from "node:assert/strict"
import test from "node:test"
import { getAdminPageByPath, getAdminPagesByGroup } from "../lib/adminPages"
import { defaultEventCalendarPeople } from "../lib/eventCalendarPeople"
import { parseTaskAllocationSchedule, resolveTaskAllocation } from "../lib/taskAllocation"

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

test("keeps Event Calendar roster order, expands BT, and resolves individual assignees", () => {
  const result = resolveTaskAllocation(schedule, ["VL", "SC", " unassigned ", "LV", "LONG", "??"], ["NN", "KZ"])
  assert.deepEqual(result.people, ["VL", "SC", "UNASSIGNED", "LV", "OL", "KZ", "NN"])
  assert.deepEqual(result.tasks.map((task) => task.assignees), [
    ["LV", "OL"],
    ["SC", "VL", "LV"],
    ["KZ", "NN", "SC"],
    [],
  ])
  assert.deepEqual(resolveTaskAllocation(schedule, [], ["JZ"]).tasks[2].assignees, ["JZ", "SC", "KZ"])
  assert.deepEqual(resolveTaskAllocation(schedule, [], []).tasks[2].assignees, ["SC", "KZ"])
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
})
