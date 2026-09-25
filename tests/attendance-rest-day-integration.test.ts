import assert from "node:assert/strict"
import { afterEach, beforeEach, mock, test } from "node:test"
import {
  buildAttendanceRecord,
  type AttendanceLeaveEntry,
  type AttendanceManualOverride,
  type AttendancePerson,
  type AttendancePunch,
} from "../lib/attendanceData"
import { hktTimestampForDateAndTime } from "../lib/attendanceRules"
import { normalizeDingTalkPunch } from "../lib/attendanceSyncRecords"

// Exercise the actual server-side daily builder without a database or real staff.
// Run with NODE_OPTIONS=--conditions=react-server to load its server-only marker.
const WORK_DATE = "2026-09-25"
const PERSON_ID = "11111111-1111-4111-8111-111111111111"
const person: AttendancePerson = {
  id: PERSON_ID,
  adminUserId: null,
  adminUsername: null,
  username: null,
  staffCode: "TEST",
  displayName: "Fictional attendance person",
  dingTalkUserId: "fictional-dingtalk-user",
  team: "BT",
  isActive: true,
  employmentStartDate: "2026-01-01",
  employmentEndDate: null,
  rosterOrder: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
}

beforeEach(() => {
  mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-02T04:00:00.000Z") })
})
afterEach(() => mock.timers.reset())

function time(clock: string, workDate = WORK_DATE) {
  return hktTimestampForDateAndTime(workDate, clock)!.toISOString()
}

function punch(
  id: string,
  clock: string,
  checkType: AttendancePunch["checkType"] = "Unclassified",
  workDate = WORK_DATE,
) {
  return {
    personId: PERSON_ID,
    workDate,
    punch: {
      id, checkType, punchTime: time(clock, workDate),
      sourceType: "ATM", deviceSn: "FICTIONAL-DEVICE",
      timeResult: null, locationResult: null,
      legacyAssumedOnTime: false, legacyHolidayAttendance: false,
    } satisfies AttendancePunch,
  }
}

type BuilderArguments = Parameters<typeof buildAttendanceRecord>

function build(
  punches: BuilderArguments[2],
  options: {
    person?: AttendancePerson
    workDate?: string
    overrides?: BuilderArguments[3]
    leaves?: BuilderArguments[4]
    assignments?: BuilderArguments[5]
    policies?: BuilderArguments[6]
    workModeOverrides?: BuilderArguments[7]
    holiday?: BuilderArguments[8]
  } = {},
) {
  return buildAttendanceRecord(
    options.person || person,
    options.workDate || WORK_DATE,
    punches,
    options.overrides || [],
    options.leaves || [],
    options.assignments || [],
    options.policies || [],
    options.workModeOverrides || [],
    options.holiday || null,
  )
}

function leave(portion: AttendanceLeaveEntry["portion"], workDate = WORK_DATE): AttendanceLeaveEntry {
  return {
    id: "fictional-leave", groupId: "fictional-leave-group", personId: PERSON_ID,
    leaveDate: workDate, portion, code: "ALS", units: portion === "full" ? 1 : 0.5,
    note: "Fictional fixture", createdBy: "fixture", updatedBy: "fixture",
    createdAt: time("08:00", workDate), updatedAt: time("08:00", workDate),
  }
}

function override(
  patch: Partial<AttendanceManualOverride>,
): AttendanceManualOverride {
  return {
    id: "fictional-override", personId: PERSON_ID, workDate: WORK_DATE,
    action: "replace", checkType: "OnDuty", punchTime: time("09:50"), rawPunchId: null,
    reason: "Fictional manual correction", createdBy: "fixture", updatedBy: "fixture",
    createdAt: time("12:00"), updatedAt: time("12:00"), ...patch,
  }
}

test("a DingTalk rest-day rejection imports into a working FCUNO day without fabricating OUT", () => {
  const normalized = normalizeDingTalkPunch({
    id: "fictional-source-record", userId: person.dingTalkUserId,
    userCheckTime: Date.parse(time("10:06:38")), sourceType: "ATM",
    invalidRecordType: "Other", invalidRecordMsg: "今日休息，打卡需申请",
  }, new Map([[person.dingTalkUserId!, { id: PERSON_ID, dingtalkUserId: person.dingTalkUserId! }]]))
  assert.ok(normalized)
  const row = punch("imported", "10:06:38", normalized.check_type, normalized.work_date)
  row.punch.punchTime = normalized.punch_time
  const record = build([row])
  assert.equal(normalized.raw_payload.checkType, null)
  assert.equal(normalized.raw_payload.normalizationReason, "dingtalk-rest-day")
  assert.equal(record.required, true)
  assert.equal(record.holiday, null)
  assert.equal(record.status, "incomplete")
  assert.equal(record.late, true)
  assert.equal(record.effectiveSignIn, time("10:06:38"))
  assert.equal(record.effectiveSignOut, null)
  assert.equal(record.punches[0].checkType, "Unclassified")
})

test("daily display derives an exact IN/OUT pair without relabelling raw punches", () => {
  const rows = [punch("out", "19:12:34"), punch("lunch", "12:15"), punch("in", "09:59:42")]
  const original = structuredClone(rows)
  const record = build(rows)
  assert.equal(record.effectiveSignIn, time("09:59:42"))
  assert.equal(record.effectiveSignOut, time("19:12:34"))
  assert.equal(record.status, "present")
  assert.equal(record.late, false)
  assert.equal(record.early, false)
  assert.deepEqual(record.punches.map((entry) => entry.checkType), ["Unclassified", "Unclassified", "Unclassified"])
  assert.deepEqual(rows, original)
})

test("normal typed punches retain earliest IN, latest official OUT and the 17:00 cutoff", () => {
  const rows = [
    punch("in", "09:58", "OnDuty"), punch("later-in", "10:10", "OnDuty"),
    punch("too-early-out", "16:59:59", "OffDuty"), punch("out", "19:05", "OffDuty"),
  ]
  const record = build(rows)
  assert.equal(record.effectiveSignIn, time("09:58"))
  assert.equal(record.effectiveSignOut, time("19:05"))
  assert.equal(record.status, "present")
  assert.equal(record.signInDeadline, time("10:01"))
  assert.equal(record.signOutDeadline, time("19:00"))
  assert.deepEqual(record.punches, rows.map((row) => row.punch))
  assert.equal(build(rows.slice(0, 3)).effectiveSignOut, null)
})

test("typed and unclassified scans combine without overriding explicit source directions", () => {
  const record = build([
    punch("raw-in", "09:56"), punch("typed-in", "10:00", "OnDuty"),
    punch("typed-out", "19:10", "OffDuty"), punch("raw-out", "19:05"),
  ])
  assert.equal(record.effectiveSignIn, time("09:56"))
  assert.equal(record.effectiveSignOut, time("19:10"))
  assert.equal(record.punches.find((entry) => entry.id === "typed-out")?.checkType, "OffDuty")
})

test("PM leave resolves the historical AC 11:00 cutoff instead of the current BT 11:30 cutoff", () => {
  const historicalDate = "2026-09-24"
  const assignments: BuilderArguments[5] = [
    { id: "old-ac", personId: PERSON_ID, team: "AC", effectiveFrom: "2026-01-01", effectiveTo: historicalDate, sourceAdminUserId: null },
    { id: "current-bt", personId: PERSON_ID, team: "BT", effectiveFrom: WORK_DATE, effectiveTo: null, sourceAdminUserId: null },
  ]
  const oldRecord = build([
    punch("in", "08:59", "Unclassified", historicalDate),
    punch("out", "11:00", "Unclassified", historicalDate),
  ], { workDate: historicalDate, leaves: [leave("pm", historicalDate)], assignments })
  assert.equal(oldRecord.person.team, "AC")
  assert.equal(oldRecord.effectiveSignOut, time("11:00", historicalDate))
  assert.equal(oldRecord.signOutDeadline, time("11:00", historicalDate))
  assert.equal(oldRecord.status, "partial-leave")

  const currentRows = [punch("in", "09:59"), punch("before-cutoff", "11:00")]
  const currentRecord = build(currentRows, { leaves: [leave("pm")], assignments })
  assert.equal(currentRecord.person.team, "BT")
  assert.equal(currentRecord.signOutDeadline, time("11:30"))
  assert.equal(currentRecord.effectiveSignOut, null)
  assert.equal(build([...currentRows, punch("out", "11:30")], {
    leaves: [leave("pm")], assignments,
  }).effectiveSignOut, time("11:30"))
})

test("manual replacement times remain authoritative over derived IN and OUT", () => {
  const rows = [punch("raw-in", "10:06"), punch("raw-out", "19:20")]
  const record = build(rows, { overrides: [
    override({ punchTime: time("09:50") }),
    override({ id: "out-correction", checkType: "OffDuty", punchTime: time("19:00") }),
  ] })
  assert.equal(record.effectiveSignIn, time("09:50"))
  assert.equal(record.effectiveSignOut, time("19:00"))
  assert.equal(record.status, "present")
  assert.equal(record.punches[0].punchTime, time("10:06"))
  assert.equal(record.punches[0].checkType, "Unclassified")
})

test("excluded raw scans cannot supply inferred arrivals or departures", () => {
  const record = build([
    punch("excluded-in", "09:50"), punch("in", "10:06"),
    punch("out", "19:00"), punch("excluded-out", "19:20"),
  ], { overrides: [
    override({ action: "exclude", checkType: null, punchTime: null, rawPunchId: "excluded-in" }),
    override({ id: "exclude-out", action: "exclude", checkType: null, punchTime: null, rawPunchId: "excluded-out" }),
  ] })
  assert.equal(record.effectiveSignIn, time("10:06"))
  assert.equal(record.effectiveSignOut, time("19:00"))
  assert.equal(record.status, "late")
  assert.deepEqual(record.punches.map((entry) => entry.id), ["in", "out"])
})

test("PM leave cannot reuse an excluded arrival to classify a lone lunchtime scan", () => {
  const rows = [punch("excluded-in", "09:59"), punch("lone-scan", "11:30")]
  const record = build(rows, {
    leaves: [leave("pm")],
    overrides: [override({ action: "exclude", checkType: null, punchTime: null, rawPunchId: "excluded-in" })],
  })
  assert.equal(record.effectiveSignIn, null)
  assert.equal(record.effectiveSignOut, null)
  assert.equal(record.status, "partial-leave")
})

test("a manual arrival supplies evidence for PM-leave departure inference", () => {
  const record = build([punch("lunchtime", "11:30")], {
    leaves: [leave("pm")], overrides: [override({ punchTime: time("10:00") })],
  })
  assert.equal(record.effectiveSignIn, time("10:00"))
  assert.equal(record.effectiveSignOut, time("11:30"))
  assert.equal(record.status, "partial-leave")
})

test("FCUNO weekends remain rest days even when physical scans are present", () => {
  const workDate = "2026-09-26"
  const record = build([
    punch("in", "10:00", "Unclassified", workDate),
    punch("out", "19:00", "Unclassified", workDate),
  ], { workDate })
  assert.equal(record.required, false)
  assert.equal(record.status, "rest-day")
  assert.equal(record.signInDeadline, null)
  assert.equal(record.signOutDeadline, null)
  assert.equal(record.effectiveSignIn, time("10:00", workDate))
  assert.equal(record.effectiveSignOut, time("19:00", workDate))
})

test("FCUNO holiday policy remains authoritative, including the AC no-holiday-credit rule", () => {
  const holiday: NonNullable<BuilderArguments[8]> = {
    eventId: "fictional-fcuno-holiday", title: "PUBLIC HOLIDAY - HONG KONG",
    name: "Fictional configured holiday", attendeeStaffCodes: [], people: [],
  }
  const rows = [punch("in", "08:59"), punch("out", "19:00")]
  const btRecord = build(rows, { holiday })
  assert.equal(btRecord.holidayAttendance, true)
  assert.equal(btRecord.status, "holiday-attendance")
  const acRecord = build(rows, { person: { ...person, team: "AC" }, holiday })
  assert.equal(acRecord.required, false)
  assert.equal(acRecord.holidayAttendance, false)
  assert.equal(acRecord.status, "holiday")
  assert.equal(build([], { holiday }).status, "holiday")
})

test("scans from other people or work dates cannot fill the current person's attendance", () => {
  const record = build([
    { ...punch("other-person", "09:00"), personId: "another-fictional-person" },
    punch("other-date", "19:00", "Unclassified", "2026-09-24"),
    punch("current-in", "09:59"),
  ])
  assert.deepEqual(record.punches.map((entry) => entry.id), ["current-in"])
  assert.equal(record.effectiveSignIn, time("09:59"))
  assert.equal(record.effectiveSignOut, null)
})

test("full-day FCUNO leave stays leave when rest-day machine scans are recovered", () => {
  const record = build([punch("in", "10:00"), punch("out", "19:00")], {
    leaves: [leave("full")],
  })
  assert.equal(record.status, "leave")
  assert.equal(record.late, false)
  assert.equal(record.early, false)
  assert.equal(record.signInDeadline, null)
  assert.equal(record.signOutDeadline, null)
})

test("recovered physical attendance replaces default HOME without erasing a manual HOME decision", () => {
  const policies: BuilderArguments[6] = [{
    id: "default-home", personId: PERSON_ID, mode: "home-office",
    effectiveFrom: "2026-09-01", effectiveTo: null, source: "fictional-policy",
  }]
  const rows = [punch("in", "10:06"), punch("out", "19:00")]
  const officeRecord = build(rows, { policies })
  assert.equal(officeRecord.workMode, "office")
  assert.equal(officeRecord.status, "late")
  assert.equal(officeRecord.derivedHomeOfficeUnits, 0)
  const manualHome = build(rows, { policies, workModeOverrides: [{
    id: "manual-home", personId: PERSON_ID, workDate: WORK_DATE, mode: "home-office",
    note: "Fictional manual decision", createdBy: "fixture", updatedBy: "fixture",
    createdAt: time("08:00"), updatedAt: time("08:00"),
  }] })
  assert.equal(manualHome.workMode, "home-office")
  assert.equal(manualHome.status, "home-office")
  assert.equal(manualHome.late, false)
})
