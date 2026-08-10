import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

function source(path: string) {
  return readFileSync(new URL(path, import.meta.url), "utf8")
}

const migration = source(
  "../supabase/migrations/20260810034059_attendance_monthly_roster_and_reminders.sql",
)
const route = source("../app/api/admin/attendance/route.ts")
const data = source("../lib/attendanceData.ts")
const adminAuth = source("../lib/adminAuth.ts")
const adminUsers = source("../lib/adminUsers.ts")
const backupRoute = source("../app/api/backups/bunker-map-drive/route.ts")
const backupValidator = source("../scripts/validate-backup.mjs")
const systemHealth = source("../lib/systemHealth.ts")
const auditLog = source("../lib/auditLog.ts")
const auditRoute = source("../app/api/admin/audit-logs/route.ts")

test("attendance roster identities are linked to User Management without deleting history", () => {
  assert.match(
    migration,
    /add column if not exists admin_user_id uuid\s+references public\.admin_users\(id\) on delete restrict/,
  )
  assert.match(migration, /attendance_people_admin_user_id_key/)
  assert.match(migration, /permissions ->> '__attendanceGroup'/)
  assert.match(migration, /upper\(users\.role\) in \('BT', 'BS', 'AC'\)/)
  assert.match(migration, /upper\(btrim\(coalesce\(users\.display_name, ''\)\)\)/)
  assert.match(migration, /staff_code in \('SY', 'CD', 'HC'\)/)
  assert.match(migration, /is_active = false/)
  assert.doesNotMatch(migration, /delete from public\.attendance_people/)
})

test("monthly confirmation allows view-only self confirmation but keeps every other action edit-only", () => {
  assert.match(adminAuth, /adminUserId: resolved\.adminUserId/)
  assert.match(
    route,
    /requireAdminPagePermissionForRequest\(\s*request,\s*ATTENDANCE_PAGE_ID,\s*"view"/,
  )
  assert.match(route, /action === "save-confirmation"/)
  assert.match(
    route,
    /if \(confirmationRow\.status !== "confirmed"\) \{\s*throw new Error\("Forbidden"\)/,
  )
  assert.match(route, /attendancePersonBelongsToAdminUser/)
  assert.match(route, /if \(!ownsPerson\) throw new Error\("Forbidden"\)/)
  assert.match(route, /if \(!canEdit\) throw new Error\("Forbidden"\)/)
  assert.ok(
    route.indexOf('if (!canEdit) throw new Error("Forbidden")') <
      route.indexOf('action === "send-reminder"'),
  )
})

test("monthly API returns weekday grid, HKT-effective records, totals, and confirmation history", () => {
  assert.match(data, /calendarDays = calendarDates/)
  assert.match(data, /filter\(\(day\) => !day\.isWeekend\)/)
  assert.match(
    data,
    /buildAttendanceRecord\(\s*person,\s*date,\s*punches,\s*overrides,\s*leaveEntries,\s*teamAssignments/,
  )
  assert.match(data, /dailyRecords: summaries\.flatMap/)
  assert.match(data, /yearToDateAttendedDays/)
  assert.match(data, /yearToDateLateDays/)
  assert.match(data, /confirmations: Array\.from\(\{ length: 12 \}/)
  assert.match(data, /isCurrentUser:/)
  assert.match(data, /canConfirm:/)
})

test("roster add/remove trusts User Management identity and group only", () => {
  assert.match(data, /listManagedAdminUsers\(\)/)
  assert.match(data, /attendanceTeamFromManagedUser\(managedUser\)/)
  assert.match(data, /admin_user_id: adminUserId/)
  assert.match(data, /display_name: managedUser\.displayName/)
  assert.match(data, /team: attendanceTeam/)
  assert.match(data, /export async function removeAttendancePerson/)
  assert.match(
    data,
    /export async function removeAttendancePerson[\s\S]*?\.from\("attendance_people"\)[\s\S]*?admin_user_id: null[\s\S]*?is_active: false[\s\S]*?employment_end_date: yesterday/,
  )
  assert.match(
    adminUsers,
    /deleteManagedAdminUser[\s\S]*?\.from\("attendance_people"\)[\s\S]*?cannot be deleted while included in Attendance Record/,
  )
})

test("reminders use individual validated User Management emails and an audited dispatch table", () => {
  assert.match(data, /normalizeEmailList\(user\?\.username \|\| ""\)/)
  assert.match(data, /Remove staff who already confirmed this month/)
  assert.match(data, /sendNoticeEmail\(\{\s*to: \[target\.email\]/)
  assert.match(data, /from\("attendance_reminder_dispatches"\)/)
  assert.match(migration, /create table if not exists public\.attendance_reminder_dispatches/)
  assert.match(migration, /alter table public\.attendance_reminder_dispatches enable row level security/)
  assert.match(migration, /audit_enable_table\(\s*'public\.attendance_reminder_dispatches'/)
  assert.doesNotMatch(migration, /recipient_email|email_address/)
  assert.match(backupRoute, /attendanceReminderDispatches/)
  assert.match(backupValidator, /attendanceReminderDispatches/)
  assert.match(systemHealth, /attendanceReminderDispatches/)
  assert.match(auditLog, /attendance_reminder_dispatches: "attendance-record"/)
  assert.match(auditRoute, /"attendance_reminder_dispatches"/)
  assert.match(route, /reminder\.failed > 0/)
  assert.match(route, /\{ status: 502 \}/)
})
