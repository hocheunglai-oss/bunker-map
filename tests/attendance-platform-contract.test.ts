import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

function source(path: string) {
  return readFileSync(new URL(path, import.meta.url), "utf8")
}

const migration = source(
  "../supabase/migrations/20260807091428_create_attendance_record_foundation.sql",
)
const adminPages = source("../lib/adminPages.ts")
const auditPresentation = source("../lib/auditLog.ts")
const auditRoute = source("../app/api/admin/audit-logs/route.ts")
const backupRoute = source("../app/api/backups/bunker-map-drive/route.ts")
const backupValidator = source("../scripts/validate-backup.mjs")
const systemHealth = source("../lib/systemHealth.ts")
const techStack = source("../app/admin/techstack/page.tsx")
const attendanceRoute = source("../app/api/admin/attendance/route.ts")
const importRoute = source("../app/api/admin/attendance/import/route.ts")
const exportRoute = source("../app/api/admin/attendance/export/route.ts")
const cronRoute = source("../app/api/cron/attendance-sync/route.ts")
const vercelConfig = source("../vercel.json")

const attendanceTables = [
  "attendance_people",
  "attendance_raw_punches",
  "attendance_leave_entries",
  "attendance_manual_overrides",
  "attendance_entitlements",
  "attendance_monthly_adjustments",
  "attendance_monthly_confirmations",
  "attendance_sync_runs",
]

const auditedAttendanceTables = attendanceTables.filter(
  (table) => !["attendance_raw_punches", "attendance_sync_runs"].includes(table),
)

test("Attendance Record follows Task Calendar and is no longer a placeholder", () => {
  const taskIndex = adminPages.indexOf('id: "task-calendar"')
  const attendanceIndex = adminPages.indexOf('id: "attendance-record"')

  assert.ok(taskIndex >= 0)
  assert.ok(attendanceIndex > taskIndex)
  assert.match(adminPages, /label: "ATTENDANCE RECORD"/)
  assert.doesNotMatch(adminPages, /ATTENDANCE RECORD \(UNDER CONSTRUCTION\)/)
})

test("every attendance table is RLS-restricted, mutation-fenced, backed up, and documented", () => {
  for (const table of attendanceTables) {
    assert.match(migration, new RegExp(`create table public\\.${table} \\(`))
    assert.match(
      migration,
      new RegExp(`after insert or update or delete or truncate on public\\.${table}`),
    )
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`))
    assert.match(migration, new RegExp(`revoke all privileges on table public\\.${table}`))
    assert.match(backupRoute, new RegExp(`table: "${table}"`))
    assert.match(systemHealth, new RegExp(`table: "${table}"`))
    assert.match(backupValidator, new RegExp(`table: "${table}"`))
    assert.match(techStack, new RegExp(`"${table}`))
  }

  assert.doesNotMatch(migration, /insert into public\.attendance_people \(staff_code/)
  assert.match(
    migration,
    /grant select, insert on table public\.attendance_raw_punches\s+to service_role/,
  )
  assert.doesNotMatch(
    migration,
    /grant select, insert, update, delete on table public\.attendance_raw_punches/,
  )
})

test("human attendance changes are visible through the page-scoped Audit Log", () => {
  for (const table of auditedAttendanceTables) {
    assert.match(migration, new RegExp(`audit_enable_table\\('public\\.${table}'`))
    assert.match(auditPresentation, new RegExp(`${table}: "attendance-record"`))
    assert.match(auditRoute, new RegExp(`"${table}"`))
  }
})

test("Attendance API, workbook routes, and cron enforce the intended permissions", () => {
  assert.match(
    attendanceRoute,
    /requireAdminPagePermissionForRequest\(request, ATTENDANCE_PAGE_ID, "view"\)/,
  )
  assert.match(
    attendanceRoute,
    /ATTENDANCE_PAGE_ID,\s+"edit",/,
  )
  assert.match(importRoute, /ATTENDANCE_PAGE_ID,\s+"edit",/)
  assert.match(exportRoute, /ATTENDANCE_PAGE_ID,\s+"view",/)
  assert.match(importRoute, /mode === "apply"/)
  assert.match(importRoute, /MAX_WORKBOOK_BYTES = 10 \* 1024 \* 1024/)
  assert.match(cronRoute, /process\.env\.CRON_SECRET/)
  assert.match(cronRoute, /timingSafeEqual/)
  assert.match(vercelConfig, /"path": "\/api\/cron\/attendance-sync"/)
  assert.match(vercelConfig, /"schedule": "\*\/15 \* \* \* \*"/)
})
