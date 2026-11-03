import assert from "node:assert/strict"
import test from "node:test"
import {
  attendancePortionConflicts,
  attendanceWorkModeForStatus,
  editableAttendanceEntry,
  permitsAttendanceMorningSignOut,
} from "../app/admin/attendancerecord/attendanceDayEditor"
import type { ApiAttendanceDailyItem, ApiAttendanceLeaveEntry } from "../app/admin/attendancerecord/types"

const entry = (id: string, portion: ApiAttendanceLeaveEntry["portion"], code: ApiAttendanceLeaveEntry["code"]): ApiAttendanceLeaveEntry => ({
  id, groupId: id, personId: "synthetic-person", leaveDate: "2026-11-03", portion, code,
  units: portion === "full" ? 1 : 0.5, note: null,
})
const record = (leave: ApiAttendanceDailyItem["leave"]) => ({ leave }) as ApiAttendanceDailyItem

test("adding a half-day absence preserves the remaining manual work mode", () => {
  for (const code of ["ALS", "ALU", "SLM", "SLR", "SLX", "SPL", "MTL", "NPL"] as const) {
    for (const mode of ["office", "home-office", "business-trip"] as const) {
      assert.equal(attendanceWorkModeForStatus(code, mode), mode)
    }
    assert.equal(attendanceWorkModeForStatus(code, undefined), "default")
  }
  for (const code of ["HO", "OS"] as const) {
    for (const mode of ["office", "home-office", "business-trip", undefined] as const) {
      assert.equal(attendanceWorkModeForStatus(code, mode), "default", "a portioned work row replaces the previous whole-day override")
    }
  }
})

test("AM home office remains separate when the PM cell opens for annual leave", () => {
  const morning = entry("morning-home", "am", "HO")
  assert.equal(editableAttendanceEntry(record([morning]), "in"), morning)
  assert.equal(editableAttendanceEntry(record([morning]), "out"), undefined)
  const afternoon = entry("afternoon-leave", "pm", "ALS")
  assert.equal(editableAttendanceEntry(record([morning, afternoon]), "in"), morning)
  assert.equal(editableAttendanceEntry(record([morning, afternoon]), "out"), afternoon)
})

test("PM annual leave remains separate when AM is entered or edited afterwards", () => {
  const afternoon = entry("afternoon-leave", "pm", "ALU")
  assert.equal(editableAttendanceEntry(record([afternoon]), "in"), undefined)
  assert.equal(editableAttendanceEntry(record([afternoon]), "out"), afternoon)
  assert.equal(editableAttendanceEntry(record(afternoon), "in"), undefined)
})

test("reverse halves, business trips and other leave codes use the clicked half", () => {
  for (const code of ["HO", "OS", "ALS", "ALU", "SLM", "SLR", "SLX", "SPL", "MTL", "NPL"] as const) {
    const morning = entry("morning", "am", code)
    const afternoon = entry("afternoon", "pm", code)
    assert.equal(editableAttendanceEntry(record([morning]), "out"), undefined)
    assert.equal(editableAttendanceEntry(record([afternoon]), "in"), undefined)
    assert.equal(editableAttendanceEntry(record([morning, afternoon]), "in"), morning)
    assert.equal(editableAttendanceEntry(record([morning, afternoon]), "out"), afternoon)
  }
})

test("a genuine full-day entry remains editable from either cell", () => {
  const full = entry("full", "full", "HO")
  assert.equal(editableAttendanceEntry(record([full]), "in"), full)
  assert.equal(editableAttendanceEntry(record([full]), "out"), full)
  assert.equal(editableAttendanceEntry(record(null), "in"), undefined)
})

test("portion choices cannot silently replace an existing other-half entry", () => {
  const afternoon = entry("afternoon", "pm", "ALS")
  assert.equal(attendancePortionConflicts("am", [afternoon]), false)
  assert.equal(attendancePortionConflicts("pm", [afternoon]), true)
  assert.equal(attendancePortionConflicts("full", [afternoon]), true)
  assert.equal(attendancePortionConflicts("full", []), false)
  assert.equal(attendancePortionConflicts("pm", [entry("full", "full", "HO")]), true)
})

test("editing a PM absence permits a morning sign-out; work modes do not", () => {
  assert.equal(permitsAttendanceMorningSignOut({ leaveEnabled: true, portion: "pm", code: "ALS" }), true)
  assert.equal(permitsAttendanceMorningSignOut({ leaveEnabled: true, portion: "am", code: "ALS" }), false)
  assert.equal(permitsAttendanceMorningSignOut({ leaveEnabled: true, portion: "pm", code: "HO" }), false)
  assert.equal(permitsAttendanceMorningSignOut({ leaveEnabled: true, portion: "pm", code: "OS" }), false)
  assert.equal(permitsAttendanceMorningSignOut({ leaveEnabled: false, portion: "pm", code: "ALS" }), false)
})
