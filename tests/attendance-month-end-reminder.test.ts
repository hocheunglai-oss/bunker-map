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
const migration = source(
  "../supabase/migrations/20260810092214_add_attendance_month_end_reminder_idempotency.sql",
)
const vercel = source("../vercel.json")
const client = source("../app/admin/attendancerecord/AttendanceRecordClient.tsx")
const autoRoute = source("../app/api/cron/attendance-auto-confirm/route.ts")
const workflowMigration = source("../supabase/migrations/20260810101816_extend_attendance_confirmation_workflow.sql")

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

test("month-end reminder is authenticated, daily scheduled at 08:00 HKT, and retry-safe", () => {
  assert.match(route, /timingSafeEqual/)
  assert.match(route, /CRON_SECRET/)
  assert.match(vercel, /attendance-month-end-reminder[\s\S]*?"schedule": "0 0 \* \* \*"/)
  assert.match(data, /loadAttendanceCalendarContext/)
  assert.match(data, /system:attendance-month-end-cron/)
  assert.match(data, /dispatch_kind: "month_end_review"/)
  assert.match(data, /pending\.error\?\.code === "23505"/)
  assert.match(migration, /dispatch_kind in \('manual', 'month_end_review'\)/)
  assert.match(
    migration,
    /create unique index if not exists attendance_reminder_dispatches_month_end_once[\s\S]*?where dispatch_kind = 'month_end_review'[\s\S]*?status in \('pending', 'sent'\)/,
  )
})

test("automatic email asks for review now and confirmation only after close", () => {
  assert.match(data, /last Hong Kong working day/)
  assert.match(data, /month is still in progress/)
  assert.match(data, /confirm the monthly record after the month has closed/)
  assert.match(data, /Open Attendance Record/)
  assert.match(data, /second and final reminder/)
  assert.match(data, /SYSTEM CONFIRMED/)
  assert.match(data, /contact an administrator directly/)
})

test("second reminder and system confirmation are scheduled, audited, and visibly distinct", () => {
  assert.match(vercel, /attendance-auto-confirm[\s\S]*?"schedule": "0 10 \* \* \*"/)
  assert.match(autoRoute, /timingSafeEqual/)
  assert.match(autoRoute, /CRON_SECRET/)
  assert.match(data, /dispatch_kind: "second_reminder"/)
  assert.match(data, /confirmed_by: "system:attendance-auto-confirm"/)
  assert.match(data, /The employee may dispute the record directly with an administrator/)
  assert.match(client, /SYSTEM CONFIRMED/)
  assert.match(workflowMigration, /'second_reminder'/)
  assert.match(workflowMigration, /attendance_reminder_dispatches_second_once/)
})
