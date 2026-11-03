import assert from "node:assert/strict"
import { afterEach, beforeEach, mock, test } from "node:test"
import type { SupabaseClient } from "@supabase/supabase-js"
import {
  buildAttendanceRecord,
  saveAttendanceDayEdit,
  type AttendanceLeaveEntry,
  type AttendancePerson,
} from "../lib/attendanceData"

const PERSON = "11111111-1111-4111-8111-111111111111"
const WORK_DATE = "2026-11-02"
const person: AttendancePerson = {
  id: PERSON, adminUserId: null, adminUsername: null, username: null,
  staffCode: "TEST", displayName: "Synthetic Test", dingTalkUserId: null,
  team: "BT", isActive: true, employmentStartDate: "2026-01-01",
  employmentEndDate: null, rosterOrder: 1,
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
}

beforeEach(() => mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-03T04:00:00Z") }))
afterEach(() => mock.timers.reset())

function leave(code: AttendanceLeaveEntry["code"], portion: "am" | "pm"): AttendanceLeaveEntry {
  return { id: `synthetic-${code}`, groupId: `synthetic-group-${code}`, personId: PERSON,
    leaveDate: WORK_DATE, code, portion, units: 0.5, note: "Synthetic entry",
    createdBy: "test", updatedBy: "test", createdAt: "2026-11-02T00:00:00Z", updatedAt: "2026-11-02T00:00:00Z" }
}

for (const homePortion of ["am", "pm"] as const) {
  test(`${homePortion.toUpperCase()} home office with opposite annual leave is attended without missing punches or double HO units`, () => {
    const leaves = [leave("HO", homePortion), leave("ALS", homePortion === "am" ? "pm" : "am")]
    const record = buildAttendanceRecord(person, WORK_DATE, [], [], leaves, [], [], [], null)
    assert.equal(record.status, "home-office")
    assert.equal(record.workModeSource, "leave")
    assert.equal(record.required, true)
    assert.equal(record.late, false)
    assert.equal(record.early, false)
    assert.equal(record.automaticAmLeave, false)
    assert.equal(record.derivedHomeOfficeUnits, 0, "stored half-day HO already contributes exactly 0.5")
    assert.equal(record.derivedBusinessTripUnits, 0)
    assert.deepEqual(record.leave, leaves)
    assert.equal(record.effectiveSignIn, null)
    assert.equal(record.effectiveSignOut, null)
  })
}

for (const leavePortion of ["am", "pm"] as const) {
  test(`legacy manual HOME with ${leavePortion.toUpperCase()} annual leave derives HOME only for the working half`, () => {
    const record = buildAttendanceRecord(person, WORK_DATE, [], [], [leave("ALS", leavePortion)], [], [], [{
      id: "synthetic-manual-home", personId: PERSON, workDate: WORK_DATE,
      mode: "home-office", note: "Existing manual arrangement", createdBy: "test", updatedBy: "test",
      createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z",
    }], null)
    assert.equal(record.status, "home-office")
    assert.equal(record.workModeSource, "manual")
    assert.equal(record.derivedHomeOfficeUnits, 0.5)
    assert.equal(record.leave.length, 1, "no extra explicit HOME entry is needed")
    assert.equal(record.leave[0].code, "ALS")
    assert.equal(record.leave[0].units, 0.5)
    assert.equal(record.late, false)
    assert.equal(record.early, false)
    assert.equal(record.effectiveSignIn, null)
    assert.equal(record.effectiveSignOut, null)
  })
}

test("default HOME policy with PM annual leave counts only the morning without creating a manual override", () => {
  const record = buildAttendanceRecord(person, WORK_DATE, [], [], [leave("ALS", "pm")], [], [{
    id: "synthetic-home-policy", personId: PERSON, mode: "home-office",
    effectiveFrom: "2026-01-01", effectiveTo: null, source: "synthetic-policy",
  }], [], null)
  assert.equal(record.workMode, "home-office")
  assert.equal(record.workModeSource, "default")
  assert.equal(record.workModeOverride, null)
  assert.equal(record.derivedHomeOfficeUnits, 0.5)
  assert.equal(record.leave[0].units, 0.5)
})

test("day-edit API sends a new opposite-half entry without reusing an existing row ID", async () => {
  const calls: Array<Record<string, unknown>> = []
  const client = { async rpc(name: string, args: Record<string, unknown>) {
    assert.equal(name, "save_attendance_day_edit")
    calls.push(args)
    return { data: { leave_entries: [], overrides: [], work_mode_override: null }, error: null }
  } } as unknown as SupabaseClient
  for (const [leaveCode, leavePortion] of [["HO", "am"], ["ALS", "pm"]]) {
    await saveAttendanceDayEdit(client, {
      personId: PERSON, workDate: WORK_DATE, workMode: "default",
      leaveEnabled: true, leavePortion, leaveCode,
      updateSignIn: false, signInTime: "10:00",
      updateSignOut: false, signOutTime: "13:00",
    }, "synthetic-editor")
  }
  assert.deepEqual(calls.map(call => [call.p_leave_code, call.p_leave_portion, call.p_existing_leave_entry_id]),
    [["HO", "am", null], ["ALS", "pm", null]])
  for (const call of calls) {
    assert.equal(call.p_update_sign_in, false)
    assert.equal(call.p_sign_in_time, null)
    assert.equal(call.p_update_sign_out, false)
    assert.equal(call.p_sign_out_time, null, "unchanged early OUT is not rewritten or revalidated")
  }
})

test("day-edit API still validates changed early punches and permits them while editing PM absence", async () => {
  let calls = 0
  const client = { async rpc() { calls += 1; return { data: {}, error: null } } } as unknown as SupabaseClient
  const common = { personId: PERSON, workDate: WORK_DATE, workMode: "default", leaveEnabled: true,
    updateSignOut: true, signOutTime: "13:00" }
  await assert.rejects(saveAttendanceDayEdit(client, { ...common, leavePortion: "am", leaveCode: "HO" }, "test"),
    /Official sign-out time cannot be earlier than 17:00/)
  assert.equal(calls, 0)
  await saveAttendanceDayEdit(client, { ...common, leavePortion: "pm", leaveCode: "ALS" }, "test")
  assert.equal(calls, 1)
})

test("day-edit API preserves a manual HOME arrangement when adding PM annual leave", async () => {
  const client = { async rpc(name: string, args: Record<string, unknown>) {
    assert.equal(name, "save_attendance_day_edit")
    assert.equal(args.p_work_mode, "home-office")
    assert.equal(args.p_leave_enabled, true)
    assert.equal(args.p_leave_portion, "pm")
    assert.equal(args.p_leave_code, "ALS")
    assert.equal(args.p_existing_leave_entry_id, null)
    return { data: {}, error: null }
  } } as unknown as SupabaseClient
  await saveAttendanceDayEdit(client, {
    personId: PERSON, workDate: WORK_DATE, workMode: "home-office",
    leaveEnabled: true, leavePortion: "pm", leaveCode: "ALS",
  }, "synthetic-editor")
})
