import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import {
  attendanceHolidayEvents,
  sortAttendancePeople,
} from "../lib/attendanceCalendar"
import {
  derivedBusinessTripUnits,
  derivedHomeOfficeUnits,
  resolveAttendanceWorkMode,
  type AttendanceWorkModePolicy,
} from "../lib/attendanceWorkModes"

function source(path: string) {
  return readFileSync(new URL(path, import.meta.url), "utf8")
}

const migration = source(
  "../supabase/migrations/20260810082031_attendance_work_modes_and_calendar.sql",
)
const attendanceData = source("../lib/attendanceData.ts")
const attendanceRoute = source("../app/api/admin/attendance/route.ts")

test("Event Calendar order is authoritative and unknown staff append stably", () => {
  const people = ["ZZ", "CY", "VL", "AA", "SC"].map((staffCode) => ({
    staffCode,
  }))
  assert.deepEqual(
    sortAttendancePeople(people, ["VL", "SC", "CY"]).map(
      (person) => person.staffCode,
    ),
    ["VL", "SC", "CY", "AA", "ZZ"],
  )
})

test("only Hong Kong Event Calendar holidays expose attendance nominees", () => {
  const events = attendanceHolidayEvents([
    {
      id: "hk-title",
      startDate: "2026-10-01",
      endDate: "2026-10-01",
      title: "HOLIDAY ATTENDANCE - NATIONAL DAY",
      people: ["vl", "KZ", "VL"],
      tags: [],
    },
    {
      id: "hk-tag",
      startDate: "2027-01-01",
      endDate: "2027-01-01",
      title: "PUBLIC HOLIDAY - HONG KONG",
      people: [],
      tags: ["public-holiday", "HK"],
    },
    {
      id: "us",
      startDate: "2026-07-03",
      endDate: "2026-07-03",
      title: "PUBLIC HOLIDAY - USA",
      people: ["VL"],
      tags: ["public-holiday", "US"],
    },
  ])
  assert.deepEqual(
    events.map((entry) => [entry.date, entry.holiday.attendeeStaffCodes]),
    [
      ["2026-10-01", ["VL", "KZ"]],
      ["2027-01-01", []],
    ],
  )
})

test("KZ-style default home office starts on 1 September and a day override wins", () => {
  const policies: AttendanceWorkModePolicy[] = [
    {
      id: "policy",
      personId: "person-kz",
      mode: "home-office",
      effectiveFrom: "2026-09-01",
      effectiveTo: null,
      source: "system",
    },
  ]
  assert.equal(
    resolveAttendanceWorkMode({
      personId: "person-kz",
      workDate: "2026-08-31",
      policies,
      overrides: [],
    }).workMode,
    "office",
  )
  assert.equal(
    resolveAttendanceWorkMode({
      personId: "person-kz",
      workDate: "2026-09-01",
      policies,
      overrides: [],
    }).workMode,
    "home-office",
  )
  assert.equal(
    resolveAttendanceWorkMode({
      personId: "person-kz",
      workDate: "2026-09-02",
      policies,
      overrides: [
        {
          id: "override",
          personId: "person-kz",
          workDate: "2026-09-02",
          mode: "office",
          note: "Office today",
          createdBy: "admin",
          updatedBy: "admin",
          createdAt: "2026-09-01T00:00:00Z",
          updatedAt: "2026-09-01T00:00:00Z",
        },
      ],
    }).workMode,
    "office",
  )
})

test("default home office counts as attendance without a punch and respects exclusions", () => {
  const common = {
    workMode: "home-office" as const,
    workModeSource: "default" as const,
    required: true,
    holiday: false,
    future: false,
  }
  assert.equal(derivedHomeOfficeUnits({ ...common, absenceUnits: 0 }), 1)
  assert.equal(derivedHomeOfficeUnits({ ...common, absenceUnits: 0.5 }), 0.5)
  assert.equal(
    derivedHomeOfficeUnits({ ...common, absenceUnits: 0, holiday: true }),
    0,
  )
  assert.equal(
    derivedHomeOfficeUnits({ ...common, absenceUnits: 0, future: true }),
    0,
  )
  assert.equal(
    derivedHomeOfficeUnits({
      ...common,
      absenceUnits: 0,
      workModeSource: "leave",
    }),
    0,
  )
})

test("manual business trips derive OS attendance units like home office", () => {
  const common = {
    workMode: "business-trip" as const,
    workModeSource: "manual" as const,
    required: true,
    holiday: false,
    future: false,
  }
  assert.equal(derivedBusinessTripUnits({ ...common, absenceUnits: 0 }), 1)
  assert.equal(derivedBusinessTripUnits({ ...common, absenceUnits: 0.5 }), 0.5)
  assert.equal(
    derivedBusinessTripUnits({ ...common, absenceUnits: 0, holiday: true }),
    0,
  )
  assert.equal(
    derivedBusinessTripUnits({
      ...common,
      absenceUnits: 0,
      workModeSource: "leave",
    }),
    0,
  )
})

test("migration secures work modes and reopens only source-affected confirmations", () => {
  for (const table of [
    "attendance_work_mode_policies",
    "attendance_work_mode_overrides",
  ]) {
    assert.match(migration, new RegExp(`create table public\\.${table}`))
    assert.match(
      migration,
      new RegExp(`alter table public\\.${table} enable row level security`),
    )
    assert.match(
      migration,
      new RegExp(`revoke all privileges on table public\\.${table}`),
    )
    assert.match(migration, new RegExp(`audit_enable_table\\([\\s\\S]*?${table}`))
  }
  assert.match(migration, /staff_code in \('KZ', 'CY', 'JZ'\)/)
  assert.match(migration, /date '2026-09-01'/)
  assert.match(migration, /reset_attendance_confirmations_for_range/)
  assert.match(migration, /attendance_hk_holiday_projection/)
  assert.match(migration, /list_attendance_available_years/)
  assert.match(
    migration,
    /create or replace function public\.save_attendance_day_edit\([\s\S]*?security definer[\s\S]*?set search_path = pg_catalog, pg_temp/,
  )
  assert.match(
    migration,
    /revoke all on function public\.save_attendance_day_edit\([\s\S]*?from public, anon, authenticated, service_role;[\s\S]*?grant execute on function public\.save_attendance_day_edit\([\s\S]*?to service_role;/,
  )
  assert.match(migration, /p_leave_code not in \([\s\S]*?'NPL'[\s\S]*?HO and OS are work modes/)
  assert.match(
    migration,
    /attendance_work_mode_overrides_mode[\s\S]*?business-trip/,
  )
  const atomicDayEdit = migration.slice(
    migration.indexOf("create or replace function public.save_attendance_day_edit"),
    migration.indexOf("revoke all on function public.save_attendance_day_edit"),
  )
  assert.match(atomicDayEdit, /p_existing_leave_entry_id uuid/)
  assert.match(atomicDayEdit, /where leaves\.id = p_existing_leave_entry_id/)
  assert.doesNotMatch(atomicDayEdit, /replace_attendance_leave_group/)
  assert.doesNotMatch(atomicDayEdit, /where leaves\.entry_group_id/)
})

test("API contract keeps August visible and prevents legacy HO or HOL double-counting", () => {
  assert.doesNotMatch(attendanceData, /OPERATIONAL_START|attendanceOperationalStart/)
  assert.match(attendanceData, /entry\.source\.startsWith\("legacy-monthly:"\)/)
  assert.match(attendanceData, /hasLegacyMonthlyCode\("HOL"/)
  assert.match(attendanceData, /hasLegacyMonthlyCode\("HO"/)
  assert.match(attendanceData, /staffOrder: calendarContext\.staffOrder/)
  assert.match(attendanceData, /availableYears/)
  assert.match(attendanceData, /annualSummaries/)
  assert.match(attendanceData, /record\.status !== "pending"/)
  assert.match(attendanceData, /explicitHolidayAttendance/)
  assert.match(attendanceData, /workModeOverride\?\.mode === "office"/)
  assert.match(attendanceData, /record\.holidayAttendance \|\|/)
  assert.match(attendanceData, /isOfficialAttendanceSignOut/)
  assert.match(attendanceRoute, /scope !== "year" && scope !== "month"/)
  assert.match(attendanceRoute, /monthOnly: scope === "month"/)
  assert.match(
    attendanceData,
    /const derivedWorkModeSource = recordedWorkMode \? "leave" : workModeSource/,
  )
  assert.match(attendanceRoute, /action === "save-work-mode"/)
  assert.match(attendanceRoute, /payload\.workMode/)
  assert.match(attendanceRoute, /action === "save-day-edit"/)
  assert.match(attendanceRoute, /payload\.dayEdit/)
  assert.match(attendanceData, /client\.rpc\("save_attendance_day_edit"/)
  assert.match(
    attendanceData,
    /requestedLeaveCode === "HO" \|\|[\s\S]*?requestedLeaveCode === "OS"[\s\S]*?cannot be saved as leave/,
  )
  assert.match(attendanceData, /derivedBusinessTripUnits/)
  assert.match(attendanceData, /hasLegacyMonthlyCode\("OS"/)
  assert.match(
    attendanceData,
    /workModeOverride\?\.mode === "business-trip"/,
  )
})

test("Attendance reads only persisted Event Calendar holidays", () => {
  const calendar = source("../lib/attendanceCalendar.ts")
  const holidayRoute = source(
    "../app/api/event-calendar/public-holidays/route.ts",
  )
  assert.doesNotMatch(calendar, /date\.nager\.at|fetchHongKongHolidays/)
  assert.match(holidayRoute, /TW,US,SG,HK/)
  assert.match(holidayRoute, /country\.code === "HK"/)
})

test("Event Calendar holiday semantics start on the official 1 September date", () => {
  assert.match(
    attendanceData,
    /ATTENDANCE_EVENT_CALENDAR_EFFECTIVE_DATE = "2026-09-01"/,
  )
  assert.match(
    attendanceData,
    /const attendanceHoliday =[\s\S]*?workDate >= ATTENDANCE_EVENT_CALENDAR_EFFECTIVE_DATE \|\| explicitHolidayAttendance[\s\S]*?\? holiday[\s\S]*?: null/,
  )
  assert.match(attendanceData, /required: normallyRequired && !attendanceHoliday/)
  assert.match(attendanceData, /if \(attendanceHoliday\)/)
  assert.match(attendanceData, /holiday: Boolean\(attendanceHoliday\)/)
  assert.match(
    attendanceData,
    /return \{[\s\S]*?holiday,[\s\S]*?holidayAttendance/,
  )
  assert.match(
    migration,
    /where projection\.event_date >= date '2026-09-01'/,
  )
})

test("new work-mode data participates in backup, health, audit, and Tech Stack", () => {
  const sources = [
    source("../app/api/backups/bunker-map-drive/route.ts"),
    source("../scripts/validate-backup.mjs"),
    source("../lib/systemHealth.ts"),
    source("../lib/auditLog.ts"),
    source("../app/api/admin/audit-logs/route.ts"),
    source("../app/admin/techstack/page.tsx"),
  ]
  for (const table of [
    "attendance_work_mode_policies",
    "attendance_work_mode_overrides",
  ]) {
    for (const registry of sources) assert.match(registry, new RegExp(table))
  }
})
