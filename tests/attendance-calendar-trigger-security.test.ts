import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import test from "node:test"

const migration = readFileSync(
  fileURLToPath(
    new URL(
      "../supabase/migrations/20260810084642_fix_attendance_calendar_trigger_privileges.sql",
      import.meta.url,
    ),
  ),
  "utf8",
)
const effectMigration = readFileSync(
  fileURLToPath(new URL(
    "../supabase/migrations/20261014032639_attendance_calendar_effective_change_invalidation.sql",
    import.meta.url,
  )),
  "utf8",
)

test("calendar invalidation trigger can use private helpers without exposing them", () => {
  assert.match(
    migration,
    /alter function private\.invalidate_attendance_calendar_confirmations\(\)[\s\S]*?security definer;/,
  )
  assert.match(
    migration,
    /alter function private\.invalidate_attendance_calendar_confirmations\(\)[\s\S]*?set search_path = pg_catalog, pg_temp;/,
  )
  assert.match(
    migration,
    /revoke all on function private\.invalidate_attendance_calendar_confirmations\(\)[\s\S]*?from public, anon, authenticated, service_role;/,
  )
  assert.doesNotMatch(
    migration,
    /grant execute on function private\.invalidate_attendance_calendar_confirmations/,
  )
  assert.doesNotMatch(
    migration,
    /grant execute on function private\.attendance_(?:hk_holiday_projection|safe_iso_date)/,
  )
})

test("effective-calendar trigger retains definer privileges and keeps helpers private", () => {
  assert.match(effectMigration, /create or replace function private\.invalidate_attendance_calendar_confirmations\(\)[\s\S]*?security definer/)
  assert.match(effectMigration, /revoke all on function private\.attendance_hk_holiday_effects\(jsonb\)/)
  assert.doesNotMatch(effectMigration, /grant execute on function private\.attendance_hk_holiday_effects/)
})
