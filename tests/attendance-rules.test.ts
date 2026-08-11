import assert from "node:assert/strict"
import test from "node:test"
import {
  ATTENDANCE_SCHEDULES,
  deriveAttendanceExpectation,
  hktTimeFromTimestamp,
  hktTimestampForDateAndTime,
  hktYearMonth,
  isAfterAttendanceAmCutoff,
  isPersonEmployedOnDate,
  isPersonExpectedOnDate,
} from "../lib/attendanceRules"

test("uses the agreed BT, BS, and AC schedules", () => {
  assert.deepEqual(ATTENDANCE_SCHEDULES.BT, {
    team: "BT",
    workStart: "10:00",
    workEnd: "19:00",
    amCutoff: "11:30",
    pmCutoff: "16:30",
  })
  assert.deepEqual(ATTENDANCE_SCHEDULES.BS, {
    team: "BS",
    workStart: "10:00",
    workEnd: "19:00",
    amCutoff: "11:30",
    pmCutoff: "16:30",
  })
  assert.deepEqual(ATTENDANCE_SCHEDULES.AC, {
    team: "AC",
    workStart: "09:00",
    workEnd: "17:30",
    amCutoff: "11:00",
    pmCutoff: "15:45",
  })
})

test("AM cutoffs convert only later punches to automatic AM leave", () => {
  assert.equal(isAfterAttendanceAmCutoff("2026-09-01", "BT", "2026-09-01T03:30:00.000Z"), false)
  assert.equal(isAfterAttendanceAmCutoff("2026-09-01", "BT", "2026-09-01T03:31:00.000Z"), true)
  assert.equal(isAfterAttendanceAmCutoff("2026-09-01", "AC", "2026-09-01T03:00:00.000Z"), false)
  assert.equal(isAfterAttendanceAmCutoff("2026-09-01", "AC", "2026-09-01T03:01:00.000Z"), true)
})

test("a PM leave day requires sign-out at or after the team AM cutoff", () => {
  const workDate = "2026-08-07"
  const beforeCutoff = hktTimestampForDateAndTime(workDate, "11:29")!.toISOString()
  const afterCutoff = hktTimestampForDateAndTime(workDate, "11:31")!.toISOString()

  assert.equal(
    deriveAttendanceExpectation({
      workDate,
      team: "BT",
      leavePortions: ["pm"],
      effectiveSignIn: hktTimestampForDateAndTime(workDate, "10:00")!.toISOString(),
      effectiveSignOut: beforeCutoff,
      required: true,
    }).early,
    true,
  )
  assert.equal(
    deriveAttendanceExpectation({
      workDate,
      team: "BT",
      leavePortions: ["pm"],
      effectiveSignIn: hktTimestampForDateAndTime(workDate, "10:00")!.toISOString(),
      effectiveSignOut: afterCutoff,
      required: true,
    }).early,
    false,
  )
})

test("an AM leave day uses the team PM sign-in cutoff", () => {
  const workDate = "2026-08-07"
  const result = deriveAttendanceExpectation({
    workDate,
    team: "AC",
    leavePortions: ["am"],
    effectiveSignIn: hktTimestampForDateAndTime(workDate, "15:46")!.toISOString(),
    effectiveSignOut: hktTimestampForDateAndTime(workDate, "17:30")!.toISOString(),
    required: true,
  })
  assert.equal(result.late, true)
  assert.equal(
    result.signInDeadline,
    hktTimestampForDateAndTime(workDate, "15:45")!.toISOString(),
  )
})

test("weekends are rest days and never missing", () => {
  const person = {
    isActive: true,
    employmentStartDate: null,
    employmentEndDate: null,
  }
  assert.equal(isPersonEmployedOnDate("2026-08-08", person), true)
  assert.equal(isPersonExpectedOnDate("2026-08-08", person), false)
  const result = deriveAttendanceExpectation({
    workDate: "2026-08-08",
    team: "BT",
    leavePortions: [],
    effectiveSignIn: null,
    effectiveSignOut: null,
    required: false,
  })
  assert.equal(result.status, "rest-day")
  assert.equal(result.late, false)
  assert.equal(result.early, false)
})

test("employment dates determine whether a person is expected", () => {
  const person = {
    isActive: false,
    employmentStartDate: "2026-02-01",
    employmentEndDate: "2026-06-30",
  }
  assert.equal(isPersonExpectedOnDate("2026-01-30", person), false)
  assert.equal(isPersonExpectedOnDate("2026-03-02", person), true)
  assert.equal(isPersonExpectedOnDate("2026-07-01", person), false)
})

test("default period helpers use Hong Kong date boundaries", () => {
  assert.deepEqual(hktYearMonth(new Date("2025-12-31T16:30:00.000Z")), {
    year: 2026,
    month: 1,
  })
})

test("displays stored UTC punches in Hong Kong time", () => {
  assert.equal(hktTimeFromTimestamp("2026-08-07T04:32:00.000Z"), "12:32")
  assert.equal(hktTimeFromTimestamp("not-a-time"), null)
})
