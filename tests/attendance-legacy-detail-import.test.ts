import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"

const root = process.cwd()
const migration = fs.readFileSync(
  path.join(
    root,
    "supabase/migrations/20260812022935_import_legacy_attendance_detail.sql",
  ),
  "utf8",
)
const stagingMigration = fs.readFileSync(
  path.join(
    root,
    "supabase/migrations/20260812023335_stage_legacy_attendance_import_payload.sql",
  ),
  "utf8",
)

test("legacy attendance detail import is service-role only and transactional", () => {
  assert.match(migration, /create or replace function public\.import_attendance_legacy_detail/)
  assert.match(migration, /security invoker/)
  assert.match(migration, /set search_path = pg_catalog, pg_temp/)
  assert.match(
    migration,
    /revoke all on function public\.import_attendance_legacy_detail[\s\S]*?from public, anon, authenticated/,
  )
  assert.match(
    migration,
    /grant execute on function public\.import_attendance_legacy_detail[\s\S]*?to service_role/,
  )
})

test("legacy attendance detail import fails closed on mapping and total mismatches", () => {
  assert.match(migration, /Jan-Jun detailed attendance data already exists; import aborted/)
  assert.match(migration, /did not map to the current attendance roster/)
  assert.match(migration, /Imported detail totals do not match the reconciled workbook totals/)
  assert.match(migration, /full join actual using\(staff_code, month_number, code\)/)
})

test("legacy attendance detail import preserves confirmations after an equal-detail replacement", () => {
  assert.match(migration, /create temp table import_confirmation_snapshot/)
  assert.match(migration, /delete from public\.attendance_monthly_adjustments/)
  assert.match(migration, /adjustment\.source like 'legacy-monthly:%'/)
  assert.match(
    migration,
    /update public\.attendance_monthly_confirmations[\s\S]*?status = snapshot\.status[\s\S]*?confirmed_by = snapshot\.confirmed_by/,
  )
})

test("DT history starts in April and non-roster rows cannot import", () => {
  assert.match(migration, /p_dt_start date default date '2026-04-01'/)
  assert.match(migration, /person\.staff_code = 'DT'/)
  assert.match(migration, /person\.staff_code = upper\(btrim\(value\.staff_code\)\) and person\.is_active/)
})

test("oversized import payload staging remains private and temporary", () => {
  assert.match(stagingMigration, /create table private\.attendance_legacy_import_staging/)
  assert.match(stagingMigration, /jsonb_typeof\(payload\) = 'array'/)
  assert.match(
    stagingMigration,
    /revoke all on table private\.attendance_legacy_import_staging[\s\S]*?from public, anon, authenticated, service_role/,
  )
})

test("blank legacy punches retain 09:30 display while being treated as on-time", () => {
  const attendanceData = fs.readFileSync(
    path.join(root, "lib/attendanceData.ts"),
    "utf8",
  )
  assert.match(attendanceData, /rawPayload\.originalMark === "blank"/)
  assert.match(attendanceData, /legacyAssumedOnTime/)
  assert.match(
    attendanceData,
    /hktTimestampForDateAndTime\(workDate, schedule\.workStart\)/,
  )
  assert.match(
    attendanceData,
    /effectiveSignIn: expectationSignIn/,
  )
})

test("legacy Y punches remain traceable holiday-attendance evidence", () => {
  const attendanceData = fs.readFileSync(
    path.join(root, "lib/attendanceData.ts"),
    "utf8",
  )
  assert.match(attendanceData, /legacyHolidayAttendance: boolean/)
  assert.match(
    attendanceData,
    /row\.source_type === "LEGACY_XLS"[\s\S]*?originalMark[\s\S]*?toUpperCase\(\) === "Y"/,
  )
  assert.match(
    attendanceData,
    /legacyHolidayAttendance[\s\S]*?punches\.some\(\(punch\) => punch\.legacyHolidayAttendance\)/,
  )
})
