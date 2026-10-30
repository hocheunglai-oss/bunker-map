import assert from "node:assert/strict"
import test from "node:test"
import {
  hasManualEntryOnlyAttendancePolicy,
  hasManualEntryOnlyAttendancePolicyForPeriod,
} from "../lib/attendanceManualEntryPolicy"
import { hktDateFromTimestamp } from "../lib/attendanceRules"

const nn = {
  id: "4c5d73e6-63a9-4b05-93a7-7354b3e668ad",
  adminUserId: "84bb808c-e188-43ce-9ddf-e7e2fe2e997d",
  staffCode: "NN", dingTalkUserId: null, team: "BT", employmentStartDate: "2026-11-02",
}
const ml = {
  ...nn, id: "96142f45-373f-47e2-9104-e33804f2fb1e",
  adminUserId: "7c2f5a90-09ae-4d3b-9996-d189f0154d53", staffCode: "ML",
}

test("manual-entry health policy starts at the exact 2 November Hong Kong boundary", () => {
  for (const person of [nn, ml]) {
    assert.equal(hasManualEntryOnlyAttendancePolicy(person,
      hktDateFromTimestamp(new Date("2026-11-01T15:59:59.999Z"))), false)
    assert.equal(hasManualEntryOnlyAttendancePolicy(person,
      hktDateFromTimestamp(new Date("2026-11-01T16:00:00.000Z"))), true)
  }
})

test("manual-entry policy rejects invalid dates, earlier months and malformed periods", () => {
  for (const date of ["2026-11-01", "2026-11-32", "2026-11-2", "2026-02-30", "not-a-date", ""]) {
    assert.equal(hasManualEntryOnlyAttendancePolicy(nn, date), false)
  }
  for (const period of [{ year: 2026, month: 10 }, { year: 2026, month: 0 },
    { year: 2026, month: 13 }, { year: 2026, month: 11.5 },
    { year: Number.NaN, month: 11 }, { year: 2201, month: 11 }]) {
    assert.equal(hasManualEntryOnlyAttendancePolicyForPeriod(nn, period), false)
  }
  assert.equal(hasManualEntryOnlyAttendancePolicyForPeriod(nn, { year: 2026, month: 11 }), true)
})

test("both precise identities require their own account, staff code, BT group and join date", () => {
  for (const person of [nn, ml]) {
    for (const replacement of [
      { id: "different-person" }, { adminUserId: "different-account" }, { adminUserId: null },
      { staffCode: "OTHER" }, { staffCode: person.staffCode.toLowerCase() },
      { team: "AC" }, { team: "BS" }, { employmentStartDate: "2026-11-01" }, { employmentStartDate: null },
    ]) {
      const changed = { ...person, ...replacement }
      assert.equal(hasManualEntryOnlyAttendancePolicy(changed, "2026-11-02"), false)
      assert.equal(hasManualEntryOnlyAttendancePolicyForPeriod(changed, { year: 2026, month: 11 }), false)
    }
  }
  assert.equal(hasManualEntryOnlyAttendancePolicy({ ...nn, adminUserId: ml.adminUserId }, "2026-11-02"), false)
})

test("linking DingTalk changes health classification but never retroactively auto-approves manual periods", () => {
  for (const person of [nn, ml]) {
    for (const dingTalkUserId of [null, "", "   "]) {
      assert.equal(hasManualEntryOnlyAttendancePolicy({ ...person, dingTalkUserId }, "2026-11-02"), true)
    }
    const linked = { ...person, dingTalkUserId: "new-real-dingtalk-link" }
    assert.equal(hasManualEntryOnlyAttendancePolicy(linked, "2026-12-01"), false)
    assert.equal(hasManualEntryOnlyAttendancePolicyForPeriod(linked, { year: 2026, month: 11 }), true)
    assert.equal(hasManualEntryOnlyAttendancePolicyForPeriod(linked, { year: 2027, month: 1 }), true)
  }
})

test("renamed ML retains manual-only policy and obsolete TL does not match", () => {
  assert.equal(hasManualEntryOnlyAttendancePolicy(ml, "2026-11-02"), true)
  assert.equal(hasManualEntryOnlyAttendancePolicyForPeriod(ml, { year: 2026, month: 11 }), true)
  const previous = { ...ml, staffCode: "TL" }
  assert.equal(hasManualEntryOnlyAttendancePolicy(previous, "2026-11-02"), false)
  assert.equal(hasManualEntryOnlyAttendancePolicyForPeriod(previous, { year: 2026, month: 11 }), false)
})
