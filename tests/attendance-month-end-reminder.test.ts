import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import test from "node:test"
import type { SupabaseClient } from "@supabase/supabase-js"
import {
  buildAttendanceMonthEndReviewEmail,
  buildAttendanceSecondReminderEmail,
  getOpenAnnualAttendancePunchAnomalyCount,
} from "../lib/attendanceData"
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

test("CY-equivalent JZ policy does not change the existing reminder body, cutoff or dispute wording", () => {
  const input = { displayName: "Test User", year: 2026, month: 10 }
  const signature = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
  assert.equal(signature(buildAttendanceMonthEndReviewEmail(input)), "39f9683995e38b8147bb2a7e2ad9ccfcedea05a0e4591ea6ae659bb115c64a1f")
  assert.equal(signature(buildAttendanceSecondReminderEmail(input)), "de51c5346a2cf206cf399333eaf10b7f8ccb215370435d2649f473190978d1cd")
})

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
  assert.match(route, /confirmationReminder\.unavailable/)
  assert.match(route, /failed > 0 \|\| unavailable > 0 \|\| blocked > 0 \? 502 : 200/)
  assert.doesNotMatch(route, /sendAttendanceMonthEndReviewReminders/)
})

test("single email gives confirmation instructions, deadline, and dispute rights", () => {
  assert.match(data, /select <strong>MONTHLY STATEMENT<\/strong>/)
  assert.match(data, /click <strong>CONFIRM<\/strong>/)
  assert.match(data, /Open Attendance Record/)
  assert.match(data, /after the 18:00 HKT deadline on the third Hong Kong working day/)
  assert.match(data, /No further reminder will be sent/)
  assert.match(data, /SYSTEM CONFIRMED/)
  assert.match(data, /contact an administrator directly/)
})

test("month-end review describes next month's deadline without promising exact execution time", () => {
  const email = buildAttendanceMonthEndReviewEmail({ displayName: "Test User", year: 2026, month: 10 })
  assert.equal(email.subject, "***** Attendance Review Reminder - October 2026")
  assert.match(email.html, /A second reminder will be sent on the first Hong Kong working day of the next month/)
  assert.match(email.html, /after the 18:00 HKT deadline on the third Hong Kong working day of that month, once attendance synchronization has been verified/)
  assert.doesNotMatch(email.html, /SYSTEM CONFIRMED<\/strong> at 18:00|18:10|10:10/)
  assert.match(email.html, /SYSTEM CONFIRMED/)
  assert.match(email.html, /does not remove your right to dispute/)
  assert.match(email.html, /contact an administrator directly/)
  assert.match(email.html, /href="https:\/\/fcuno\.com\/admin\/attendancerecord"/)
})

test("confirmation reminder keeps instructions and dispute rights while distinguishing deadline from execution", () => {
  const email = buildAttendanceSecondReminderEmail({ displayName: "Test User", year: 2026, month: 10 })
  assert.equal(email.subject, "***** Attendance Confirmation Reminder - October 2026")
  assert.match(email.html, /after the 18:00 HKT deadline on the third Hong Kong working day of this month, once attendance synchronization has been verified/)
  assert.doesNotMatch(email.html, /SYSTEM CONFIRMED<\/strong> at 18:00|18:10|10:10/)
  assert.match(email.html, /select <strong>MONTHLY STATEMENT<\/strong>/)
  assert.match(email.html, /click <strong>CONFIRM<\/strong>/)
  assert.match(email.html, /No further reminder will be sent/)
  assert.match(email.html, /does not mean that you personally approved every entry/)
  assert.match(email.html, /does not remove your right to dispute/)
  assert.match(email.html, /contact an administrator directly/)
  assert.match(email.html, /href="https:\/\/fcuno\.com\/admin\/attendancerecord"/)
})

test("all eligible users receive the reminder and system confirmation remains distinct", () => {
  assert.match(vercel, /attendance-auto-confirm[\s\S]*?"schedule": "10 10 \* \* \*"/)
  assert.match(autoRoute, /timingSafeEqual/)
  assert.match(autoRoute, /CRON_SECRET/)
  assert.match(data, /dispatch_kind: "second_reminder"/)
  assert.doesNotMatch(data, /confirmedIds\.has\(personId\)/)
  assert.match(data, /p_actor: cyException \? CY_DINGTALK_EXCEPTION_ACTOR\s*: jzException \? JZ_DINGTALK_EXCEPTION_ACTOR : "system:attendance-auto-confirm"/)
  assert.match(autoRoute, /!hasCyDingTalkAutoConfirmException\(person, period\)/)
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

test("year-end email checks all twelve months and blocks dispatch on source anomalies", async () => {
  const months: number[] = []
  const client = {
    async rpc(name: string, args: { p_month: number; p_year: number; p_person_id: string }) {
      assert.equal(name, "attendance_open_dingtalk_punch_anomaly_count")
      assert.equal(args.p_year, 2026)
      assert.equal(args.p_person_id, "person-a")
      months.push(args.p_month)
      return { data: args.p_month === 9 ? 1 : 0, error: null }
    },
  } as unknown as SupabaseClient
  assert.equal(await getOpenAnnualAttendancePunchAnomalyCount(client, "person-a", 2026), 1)
  assert.deepEqual(months.sort((a, b) => a - b), Array.from({ length: 12 }, (_, index) => index + 1))

  const sender = data.slice(
    data.indexOf("export async function sendAttendanceAnnualSummaryReminders"),
    data.indexOf("export async function sendAttendanceSecondReminders"),
  )
  const anomalyCheckPosition = sender.indexOf("getOpenAnnualAttendancePunchAnomalyCount(")
  const dispatchPosition = sender.indexOf('client.from("attendance_reminder_dispatches").insert(')
  assert.ok(anomalyCheckPosition >= 0 && dispatchPosition > anomalyCheckPosition)
  assert.match(sender, /if \(openAnomalies > 0\) \{\s+results\.push\("blocked"\)/)
  assert.match(route, /annualSummary\.blocked/)
  assert.match(route, /blocked > 0 \? 502 : 200/)
})

test("year-end anomaly check fails closed when the database cannot verify a month", async () => {
  const client = {
    async rpc(_name: string, args: { p_month: number }) {
      return args.p_month === 4
        ? { data: null, error: { message: "Anomaly query failed." } }
        : { data: 0, error: null }
    },
  } as unknown as SupabaseClient
  await assert.rejects(
    getOpenAnnualAttendancePunchAnomalyCount(client, "person-a", 2026),
    /Anomaly query failed/,
  )
  const invalidClient = {
    async rpc() { return { data: null, error: null } },
  } as unknown as SupabaseClient
  await assert.rejects(
    getOpenAnnualAttendancePunchAnomalyCount(invalidClient, "person-a", 2026),
    /review count is invalid/,
  )
})
