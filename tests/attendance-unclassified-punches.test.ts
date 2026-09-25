import assert from "node:assert/strict"
import test from "node:test"
import {
  deriveAttendanceExpectation,
  hktTimestampForDateAndTime,
  type AttendanceCheckType,
  type AttendanceTeam,
} from "../lib/attendanceRules"
import { inferUnclassifiedAttendanceDirections } from "../lib/attendanceUnclassifiedPunches"

const WORK_DATE = "2026-09-25"

function time(value: string, workDate = WORK_DATE) {
  return hktTimestampForDateAndTime(workDate, value)!.toISOString()
}

function punch(
  id: string,
  clock: string,
  checkType: AttendanceCheckType | "Unclassified" = "Unclassified",
) {
  return { id, checkType, punchTime: time(clock) }
}

function infer(
  punches: Parameters<typeof inferUnclassifiedAttendanceDirections>[0]["punches"],
  options: Partial<Omit<Parameters<typeof inferUnclassifiedAttendanceDirections>[0], "punches">> = {},
) {
  return inferUnclassifiedAttendanceDirections({
    workDate: WORK_DATE,
    team: "BT",
    hasAfternoonLeave: false,
    ...options,
    punches,
  })
}

test("a single morning rest-day punch supplies only IN, retaining its exact time", () => {
  const punches = [punch("morning", "10:03:27")]
  const original = structuredClone(punches)
  assert.deepEqual([...infer(punches)], [["morning", "OnDuty"]])
  assert.deepEqual(punches, original)
})

test("normal days use earliest arrival and latest official departure", () => {
  assert.deepEqual([...infer([
    punch("late-out", "19:19:52"),
    punch("lunch", "12:45"),
    punch("first-in", "09:59:31"),
    punch("first-out", "17:01"),
    punch("later-in", "10:20"),
  ])], [["first-in", "OnDuty"], ["late-out", "OffDuty"]])
})

test("17:00 boundary is precise and a single evening scan never supplies IN", () => {
  assert.deepEqual([...infer([punch("before", "16:59:59")])], [["before", "OnDuty"]])
  assert.deepEqual([...infer([punch("at", "17:00:00")])], [["at", "OffDuty"]])
  assert.deepEqual([...infer([punch("after", "19:00")])], [["after", "OffDuty"]])
})

test("late afternoon arrival remains usable for an AM-leave working session", () => {
  const punches = [punch("afternoon-in", "15:44:53"), punch("evening-out", "17:31:17")]
  assert.deepEqual([...infer(punches, { team: "AC" })], [
    ["afternoon-in", "OnDuty"], ["evening-out", "OffDuty"],
  ])
  const expectation = deriveAttendanceExpectation({
    workDate: WORK_DATE,
    team: "AC",
    leavePortions: ["am"],
    effectiveSignIn: punches[0].punchTime,
    effectiveSignOut: punches[1].punchTime,
    required: true,
  })
  assert.equal(expectation.late, false)
  assert.equal(expectation.early, false)
})

test("normal-day late arrivals are not silently moved to the schedule start", () => {
  const arriving = punch("late", "10:06:38")
  assert.equal(infer([arriving]).get("late"), "OnDuty")
  assert.equal(deriveAttendanceExpectation({
    workDate: WORK_DATE,
    team: "BT",
    leavePortions: [],
    effectiveSignIn: arriving.punchTime,
    effectiveSignOut: null,
    required: true,
  }).late, true)
})

test("PM leave uses the historical team's AM cutoff, with separate arrival evidence", () => {
  for (const [team, cutoff] of [["BT", "11:30"], ["BS", "11:30"], ["AC", "11:00"]] as const) {
    assert.deepEqual([...infer([punch("in", "09:00"), punch("out", cutoff)], {
      team, hasAfternoonLeave: true,
    })], [["in", "OnDuty"], ["out", "OffDuty"]])
  }
})

test("one PM-leave scan at or after the cutoff remains unclassified", () => {
  for (const team of ["AC", "BT", "BS"] as AttendanceTeam[]) {
    for (const clock of ["11:30", "12:00", "17:00", "19:00"]) {
      assert.deepEqual([...infer([punch("single", clock)], {
        team, hasAfternoonLeave: true,
      })], [])
    }
  }
})

test("multiple scans after the PM-leave cutoff do not invent an earlier arrival", () => {
  assert.deepEqual([...infer([punch("first", "12:00"), punch("last", "12:15")], {
    hasAfternoonLeave: true,
  })], [])
})

test("PM-leave departure can rely on an earlier typed or manual arrival", () => {
  assert.deepEqual([...infer([
    punch("typed", "09:59", "OnDuty"), punch("unknown-out", "11:30"),
  ], { hasAfternoonLeave: true })], [["unknown-out", "OffDuty"]])
  assert.deepEqual([...infer([punch("unknown-out", "11:31")], {
    hasAfternoonLeave: true, manualSignIn: time("10:00"),
  })], [["unknown-out", "OffDuty"]])
})

test("a typed sign-out, invalid manual time, or manual arrival at cutoff is not PM arrival evidence", () => {
  assert.deepEqual([...infer([
    punch("typed-out", "10:00", "OffDuty"), punch("unknown", "11:31"),
  ], { hasAfternoonLeave: true })], [])
  for (const manualSignIn of ["invalid", time("09:00", "2026-09-24"), time("11:30"), time("12:00")]) {
    assert.deepEqual([...infer([punch("unknown", "12:05")], {
      hasAfternoonLeave: true, manualSignIn,
    })], [])
  }
})

test("scans before the PM cutoff never manufacture an early sign-out", () => {
  assert.deepEqual([...infer([punch("first", "09:00"), punch("last", "10:59")], {
    hasAfternoonLeave: true, team: "AC",
  })], [["first", "OnDuty"]])
})

test("typed punches retain their directions and are absent from the inferred map", () => {
  const typed = [punch("in", "10:00", "OnDuty"), punch("out", "19:00", "OffDuty")]
  assert.deepEqual([...infer(typed)], [])
  assert.deepEqual([...infer([...typed, punch("extra", "09:58")])], [["extra", "OnDuty"]])
})

test("inference ignores invalid timestamps and punches outside the same Hong Kong date", () => {
  assert.deepEqual([...infer([
    { ...punch("invalid", "10:00"), punchTime: "not-a-time" },
    { ...punch("yesterday", "10:00"), punchTime: "2026-09-24T15:59:59.999Z" },
    { ...punch("tomorrow", "10:00"), punchTime: "2026-09-25T16:00:00.000Z" },
    { ...punch("empty-id", "10:00"), id: "" },
    punch("today", "10:00"),
  ])], [["today", "OnDuty"]])
  assert.deepEqual([...infer([punch("today", "10:00")], { workDate: "2026-02-30" })], [])
})

test("Hong Kong midnight boundaries are used rather than UTC dates", () => {
  assert.deepEqual([...infer([
    { id: "start", checkType: "Unclassified", punchTime: "2026-09-24T16:00:00.000Z" },
    { id: "end", checkType: "Unclassified", punchTime: "2026-09-25T15:59:59.999Z" },
  ])], [["start", "OnDuty"], ["end", "OffDuty"]])
})

test("duplicate timestamps and input permutations produce stable directions", () => {
  const punches = [
    punch("b-in", "10:00"), punch("a-in", "10:00"),
    punch("b-out", "19:00"), punch("a-out", "19:00"),
  ]
  const expected = [["a-in", "OnDuty"], ["b-out", "OffDuty"]]
  for (let index = 0; index < punches.length; index += 1) {
    const rotated = [...punches.slice(index), ...punches.slice(0, index)]
    assert.deepEqual([...infer(rotated)], expected)
    assert.deepEqual([...infer(rotated.reverse())], expected)
  }
  assert.deepEqual([...infer([punch("b", "11:30"), punch("a", "11:30")], {
    hasAfternoonLeave: true,
  })], [])
})

test("a pre-excluded arrival cannot be reused to infer a PM-leave sign-out", () => {
  const punches = [punch("excluded-in", "10:00"), punch("out", "11:30")]
  assert.deepEqual([...infer(punches.filter((row) => row.id !== "excluded-in"), {
    hasAfternoonLeave: true,
  })], [])
})

test("physical punch inference does not declare weekends to be working days", () => {
  const saturday = "2026-09-26"
  const punches = [
    { id: "in", checkType: "Unclassified" as const, punchTime: time("10:00", saturday) },
    { id: "out", checkType: "Unclassified" as const, punchTime: time("19:00", saturday) },
  ]
  assert.deepEqual([...infer(punches, { workDate: saturday })], [["in", "OnDuty"], ["out", "OffDuty"]])
  const expectation = deriveAttendanceExpectation({
    workDate: saturday, team: "BT", leavePortions: [],
    effectiveSignIn: punches[0].punchTime, effectiveSignOut: punches[1].punchTime,
    required: false,
  })
  assert.equal(expectation.status, "rest-day")
  assert.equal(expectation.required, false)
})
