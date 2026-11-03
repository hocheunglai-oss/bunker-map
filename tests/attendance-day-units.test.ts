import assert from "node:assert/strict"
import test from "node:test"
import { attendanceDayUnits, type AttendanceDayUnitsRecord } from "../lib/attendanceDayUnits"
import type { AttendanceLeaveCode, AttendanceLeavePortion } from "../lib/attendanceRules"

const today = "2026-11-03"
const base: AttendanceDayUnitsRecord = {
  date: "2026-11-02", required: true, status: "present", leave: [],
  effectiveSignIn: "2026-11-02T02:00:00Z", workMode: "office", workModeSource: null,
}
const entry = (code: AttendanceLeaveCode, portion: AttendanceLeavePortion) => ({ code, portion })
const count = (overrides: Partial<AttendanceDayUnitsRecord> = {}) => attendanceDayUnits({ ...base, ...overrides }, today)

test("one normal office day plus AM home office and PM annual leave totals 1.5 days", () => {
  assert.equal(count(), 1)
  for (const code of ["ALS", "ALU"] as const) {
    assert.equal(count({ effectiveSignIn: null, status: "home-office", workMode: "home-office", workModeSource: "leave",
      leave: [entry("HO", "am"), entry(code, "pm")] }), 0.5)
    assert.equal(count() + count({ effectiveSignIn: null, status: "home-office", workMode: "home-office", workModeSource: "leave",
      leave: [entry("HO", "am"), entry(code, "pm")] }), 1.5)
  }
})

test("every absence code removes only its recorded working half", () => {
  for (const code of ["ALS", "ALU", "SLM", "SLR", "SLX", "SPL", "MTL", "NPL"] as const) {
    for (const portion of ["am", "pm"] as const) assert.equal(count({ leave: [entry(code, portion)] }), 0.5)
    assert.equal(count({ leave: [entry(code, "full")] }), 0)
  }
  assert.equal(count({ leave: [entry("ALS", "am"), entry("SLM", "pm")] }), 0)
  assert.equal(count({ leave: [entry("ALS", "am"), entry("ALS", "am")] }), 0.5, "duplicate halves cannot double-deduct")
})

test("recorded work halves count exactly their supported portions without inventing office attendance", () => {
  for (const code of ["HO", "OS"] as const) {
    for (const portion of ["am", "pm"] as const) {
      const work = { status: code === "HO" ? "home-office" : "business-trip", workMode: code === "HO" ? "home-office" as const : "business-trip" as const,
        workModeSource: "leave" as const, effectiveSignIn: null, leave: [entry(code, portion)] }
      assert.equal(count(work), 0.5)
      assert.equal(count({ ...work, effectiveSignIn: base.effectiveSignIn }), 1, "existing office-IN evidence supports the other working half")
    }
    assert.equal(count({ effectiveSignIn: null, leave: [entry(code, "full")] }), 1)
  }
  assert.equal(count({ effectiveSignIn: null, leave: [entry("HO", "am"), entry("OS", "pm")] }), 1)
  assert.equal(count({ effectiveSignIn: null, leave: [entry("HO", "am"), entry("OS", "am")] }), 0.5)
})

test("legacy manual and policy whole-day work modes retain fractional absence accounting", () => {
  for (const workMode of ["home-office", "business-trip"] as const) {
    for (const workModeSource of ["manual", "default", null] as const) {
      assert.equal(count({ workMode, workModeSource, effectiveSignIn: null }), 1)
      assert.equal(count({ workMode, workModeSource, effectiveSignIn: null, leave: [entry("ALU", "pm")] }), 0.5)
      assert.equal(count({ workMode, workModeSource, effectiveSignIn: null, leave: [entry("ALS", "am"), entry("ALU", "pm")] }), 0)
    }
  }
  assert.equal(count({ effectiveSignIn: null, workMode: "home-office", workModeSource: undefined, leave: entry("HO", "am") }), 0.5)
})

test("office absence without a qualifying IN punch earns no attendance", () => {
  assert.equal(count({ effectiveSignIn: null, status: "missing" }), 0)
  assert.equal(count({ effectiveSignIn: null, status: "partial-leave", leave: [entry("ALU", "pm")] }), 0)
  assert.equal(count({ effectiveSignIn: null, status: "incomplete", leave: [entry("ALS", "am")] }), 0)
})

test("automatic AM absence is half a day and cannot double-deduct an explicit AM absence", () => {
  assert.equal(count({ automaticAmLeave: true }), 0.5)
  assert.equal(count({ automaticAmLeave: true, leave: [entry("ALS", "am")] }), 0.5)
  assert.equal(count({ automaticAmLeave: true, leave: [entry("ALU", "pm")] }), 0)
  assert.equal(count({ automaticAmLeave: true, leave: [entry("HO", "am")] }), 1, "approved AM HOME precedes a stale automatic absence flag")
  assert.equal(count({ automaticAmLeave: true, leave: [entry("HO", "am"), entry("ALU", "pm")] }), 0.5)
  assert.equal(count({ automaticAmLeave: true, leave: [entry("HO", "am"), entry("ALS", "am")] }), 0.5, "an explicit absence remains authoritative")
})

test("holiday attendance keeps its existing qualification but excludes an actual absent half", () => {
  assert.equal(count({ required: false, status: "holiday", effectiveSignIn: null }), 0)
  assert.equal(count({ required: true, status: "holiday-attendance-missing", holidayAttendance: true, effectiveSignIn: null }), 1)
  assert.equal(count({ status: "holiday-attendance-partial-leave", holidayAttendance: true, effectiveSignIn: null, leave: [entry("ALU", "pm")] }), 0.5)
  assert.equal(count({ holidayAttendance: true, leave: [entry("ALS", "full")] }), 0)
})

test("future, non-required, pending and fully absent records never earn days", () => {
  for (const record of [
    { date: "2026-11-04" }, { date: "2026-11-04", holidayAttendance: true },
    { required: false }, { required: false, workMode: "home-office" as const },
    { status: "pending" }, { status: "leave" }, { date: "invalid" },
  ]) assert.equal(count(record), 0)
  assert.equal(attendanceDayUnits(base, "invalid"), 0)
})

test("older response eligibility is inferred only from known working status and still needs evidence", () => {
  for (const status of ["present", "partial-leave", "incomplete", "late", "early", "late-and-early", "home-office", "business-trip"]) {
    assert.equal(count({ required: undefined, status, leave: [entry("ALU", "pm")] }), 0.5)
  }
  for (const status of ["rest-day", "holiday", "pending", "leave", "unknown", ""]) assert.equal(count({ required: undefined, status }), 0)
  assert.equal(count({ date: undefined, workDate: base.date }), 1)
})
