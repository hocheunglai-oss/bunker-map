import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import {
  attendanceTeamAssignmentForDate,
  attendanceTeamAssignmentOverlapsPeriod,
  hasAttendanceTeamHistory,
  resolveAttendanceTeamForDate,
  type AttendanceTeamAssignment,
} from "../lib/attendanceTeamHistory"

function source(path: string) {
  return readFileSync(new URL(path, import.meta.url), "utf8")
}

const migration = source(
  "../supabase/migrations/20260810034059_attendance_monthly_roster_and_reminders.sql",
)
const serviceRoleGrantMigration = source(
  "../supabase/migrations/20260812083825_grant_attendance_group_helper_to_service_role.sql",
)
const attendanceData = source("../lib/attendanceData.ts")
const backupRoute = source("../app/api/backups/bunker-map-drive/route.ts")
const backupValidator = source("../scripts/validate-backup.mjs")
const systemHealth = source("../lib/systemHealth.ts")
const auditLog = source("../lib/auditLog.ts")
const auditRoute = source("../app/api/admin/audit-logs/route.ts")
const techStack = source("../app/admin/techstack/page.tsx")

const assignments: AttendanceTeamAssignment[] = [
  {
    id: "old",
    personId: "person-1",
    team: "BT",
    effectiveFrom: "2026-01-01",
    effectiveTo: "2026-06-30",
    sourceAdminUserId: "user-1",
  },
  {
    id: "current",
    personId: "person-1",
    team: "AC",
    effectiveFrom: "2026-07-01",
    effectiveTo: null,
    sourceAdminUserId: "user-1",
  },
]

test("User Management can resolve attendance groups without exposing the helper to browser roles", () => {
  assert.match(serviceRoleGrantMigration, /grant usage on schema private to service_role/i)
  assert.match(
    serviceRoleGrantMigration,
    /grant execute on function private\.admin_attendance_group\(jsonb, text\)[\s\S]*to service_role/i,
  )
  assert.match(serviceRoleGrantMigration, /revoke all[\s\S]*from public, anon, authenticated/i)
})

test("attendance group resolution preserves the schedule used on each work date", () => {
  assert.equal(
    resolveAttendanceTeamForDate("person-1", "2026-06-30", "AC", assignments),
    "BT",
  )
  assert.equal(
    resolveAttendanceTeamForDate("person-1", "2026-07-01", "BT", assignments),
    "AC",
  )
  assert.equal(
    resolveAttendanceTeamForDate("legacy", "2026-07-01", "BS", assignments),
    "BS",
  )
})

test("assignment history preserves an employment gap when a person rejoins", () => {
  const rejoinedAssignments: AttendanceTeamAssignment[] = [
    {
      id: "before-leaving",
      personId: "person-2",
      team: "BT",
      effectiveFrom: "2026-01-01",
      effectiveTo: "2026-03-31",
      sourceAdminUserId: null,
    },
    {
      id: "after-rejoining",
      personId: "person-2",
      team: "BS",
      effectiveFrom: "2026-06-01",
      effectiveTo: null,
      sourceAdminUserId: "user-2",
    },
  ]

  assert.equal(hasAttendanceTeamHistory("person-2", rejoinedAssignments), true)
  assert.equal(
    attendanceTeamAssignmentForDate(
      "person-2",
      "2026-04-15",
      rejoinedAssignments,
    ),
    undefined,
  )
  assert.equal(
    attendanceTeamAssignmentOverlapsPeriod(
      "person-2",
      "2026-04-01",
      "2026-05-31",
      rejoinedAssignments,
    ),
    false,
  )
  assert.equal(
    attendanceTeamAssignmentOverlapsPeriod(
      "person-2",
      "2026-06-01",
      "2026-06-30",
      rejoinedAssignments,
    ),
    true,
  )
})

test("User Management changes create effective history without retaining deletion blockers", () => {
  assert.match(migration, /create table if not exists public\.attendance_team_assignments/)
  assert.match(migration, /references public\.admin_users\(id\) on delete set null/)
  assert.match(migration, /Attendance group assignments cannot overlap/)
  assert.match(migration, /pg_advisory_xact_lock/)
  assert.match(migration, /after update of permissions, role, display_name, is_active/)
  assert.match(
    migration,
    /if not new\.is_active or new_group is null then[\s\S]*?admin_user_id = null,[\s\S]*?is_active = false/,
  )
  assert.match(migration, /set effective_to = hkt_today - 1/)
  assert.match(migration, /effective_from,[\s\S]*?hkt_today,/)
  assert.match(
    migration,
    /if current_assignment\.effective_from >= hkt_today then[\s\S]*?delete from public\.attendance_team_assignments/,
  )
})

test("only source-affected confirmation periods return to pending", () => {
  assert.match(migration, /changed_from := new\.effective_to \+ 1/)
  assert.match(migration, /changed_from := old\.effective_to \+ 1/)
  assert.match(migration, /confirmations\.status = 'confirmed'/)
  assert.match(migration, /status = 'pending'/)
  for (const table of [
    "attendance_raw_punches",
    "attendance_leave_entries",
    "attendance_manual_overrides",
    "attendance_monthly_adjustments",
  ]) {
    assert.match(
      migration,
      new RegExp(`invalidate_attendance_confirmation[\\s\\S]*?on public\\.${table}`),
    )
  }
})

test("daily, monthly, and all-time calculations load effective group history", () => {
  assert.equal(
    attendanceData.match(/from\("attendance_team_assignments"\)/g)?.length,
    3,
  )
  assert.match(attendanceData, /resolveAttendanceTeamForDate\(/)
  assert.match(attendanceData, /attendanceTeamAssignmentOverlapsPeriod\(/)
  assert.match(attendanceData, /hasAttendanceTeamHistory\(/)
  assert.match(attendanceData, /const schedule = ATTENDANCE_SCHEDULES\[team\]/)
  assert.match(attendanceData, /team === person\.team \? person : \{ \.\.\.person, team \}/)
})

test("group history is RLS-restricted, audited, backed up, health-checked, and documented", () => {
  assert.match(migration, /alter table public\.attendance_team_assignments enable row level security/)
  assert.match(migration, /revoke all privileges on table public\.attendance_team_assignments/)
  assert.match(migration, /audit_enable_table\([\s\S]*?'public\.attendance_team_assignments'/)
  assert.match(backupRoute, /attendanceTeamAssignments/)
  assert.match(backupValidator, /attendanceTeamAssignments/)
  assert.match(systemHealth, /attendanceTeamAssignments/)
  assert.match(systemHealth, /active attendance people and current group history do not match/)
  assert.match(auditLog, /attendance_team_assignments: "attendance-record"/)
  assert.match(auditRoute, /"attendance_team_assignments"/)
  assert.match(techStack, /attendance_team_assignments/)
})
