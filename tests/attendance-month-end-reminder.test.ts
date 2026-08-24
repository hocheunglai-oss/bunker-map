import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import {
  hongKongWorkingDayNumber,
  isLastHongKongWorkingDay,
  previousMonthPeriod,
} from "../lib/attendanceMonthEnd"

function source(path: string) {
  return readFileSync(new URL(path, import.meta.url), "utf8")
}

const route = source("../app/api/cron/attendance-month-end-reminder/route.ts")
const data = source("../lib/attendanceData.ts")
const vercel = source("../vercel.json")
const client = source("../app/admin/attendancerecord/AttendanceRecordClient.tsx")
const autoRoute = source("../app/api/cron/attendance-auto-confirm/route.ts")
const workflowMigration = source("../supabase/migrations/20260810101816_extend_attendance_confirmation_workflow.sql")
const annualMigration = source("../supabase/migrations/20260811102410_add_attendance_annual_summary_reminders.sql")

test("last Hong Kong working day excludes later weekdays, weekends, and persisted holidays", () => {
  assert.equal(
    isLastHongKongWorkingDay(new Date("2026-09-30T08:00:00.000Z")),
    true,
  )
  assert.equal(
    isLastHongKongWorkingDay(new Date("2026-09-29T08:00:00.000Z")),
    false,
  )
  assert.equal(
    isLastHongKongWorkingDay(
      new Date("2026-10-29T08:00:00.000Z"),
      new Set(["2026-10-30"]),
    ),
    true,
  )
  assert.equal(
    isLastHongKongWorkingDay(
      new Date("2026-10-30T08:00:00.000Z"),
      new Set(["2026-10-30"]),
    ),
    false,
  )
})

test("working-day workflow respects Hong Kong holidays and crosses the year boundary", () => {
  assert.equal(hongKongWorkingDayNumber(new Date("2026-10-01T00:00:00Z"), new Set(["2026-10-01"])), 0)
  assert.equal(hongKongWorkingDayNumber(new Date("2026-10-02T00:00:00Z"), new Set(["2026-10-01"])), 1)
  assert.deepEqual(previousMonthPeriod(new Date("2027-01-04T00:00:00Z")), { year: 2026, month: 12 })
})

test("single confirmation reminder is authenticated, scheduled at 08:00 HKT, and retry-safe", () => {
  assert.match(route, /timingSafeEqual/)
  assert.match(route, /CRON_SECRET/)
  assert.match(vercel, /attendance-month-end-reminder[\s\S]*?"schedule": "0 0 \* \* \*"/)
  assert.match(data, /loadAttendanceCalendarContext/)
  assert.match(data, /system:attendance-second-reminder-cron/)
  assert.match(data, /dispatch_kind: "second_reminder"/)
  assert.match(data, /pending\.error\?\.code === "23505"/)
  assert.doesNotMatch(route, /sendAttendanceMonthEndReviewReminders/)
})

test("single email gives confirmation instructions, deadline, and dispute rights", () => {
  assert.match(data, /select <strong>MONTHLY STATEMENT<\/strong>/)
  assert.match(data, /click <strong>CONFIRM<\/strong>/)
  assert.match(data, /Open Attendance Record/)
  assert.match(data, /18:00 HKT on the third Hong Kong working day/)
  assert.match(data, /No further reminder will be sent/)
  assert.match(data, /SYSTEM CONFIRMED/)
  assert.match(data, /contact an administrator directly/)
})

test("all eligible users receive the reminder and system confirmation remains distinct", () => {
  assert.match(vercel, /attendance-auto-confirm[\s\S]*?"schedule": "0 10 \* \* \*"/)
  assert.match(autoRoute, /timingSafeEqual/)
  assert.match(autoRoute, /CRON_SECRET/)
  assert.match(data, /dispatch_kind: "second_reminder"/)
  assert.doesNotMatch(data, /confirmedIds\.has\(personId\)/)
  assert.match(data, /confirmed_by: "system:attendance-auto-confirm"/)
  assert.match(data, /The employee may dispute the record directly with an administrator/)
  assert.match(client, /SYSTEM CONFIRMED/)
  assert.match(workflowMigration, /'second_reminder'/)
  assert.match(workflowMigration, /attendance_reminder_dispatches_second_once/)
})

test("first working day of January sends an idempotent year-end balance summary", () => {
  assert.match(route, /sendAttendanceAnnualSummaryReminders/)
  assert.match(data, /period\.month !== 1/)
  assert.match(data, /hongKongWorkingDayNumber\(now, holidayDates\) !== 1/)
  assert.match(data, /dispatch_kind: "annual_summary"/)
  assert.match(data, /Balance B\/F at 31 Dec/)
  assert.match(data, /Balance C\/F at 31 Dec/)
  assert.match(data, /CONFIRM YEAR/)
  assert.match(data, /contacting an administrator directly/)
  assert.match(annualMigration, /'annual_summary'/)
  assert.match(annualMigration, /attendance_reminder_dispatches_annual_summary_once/)
})
