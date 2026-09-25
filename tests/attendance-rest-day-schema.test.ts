import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import test from "node:test"

test("rest-day scans require provenance without widening manual or public writes", () => {
  const directory = new URL("../supabase/migrations/", import.meta.url)
  const filename = readdirSync(directory).find((name) => name.endsWith("_allow_attendance_rest_day_machine_punches.sql"))!
  const migration = readFileSync(new URL(filename, directory), "utf8")
  assert.match(migration, /check_type in \('OnDuty', 'OffDuty'\)/)
  assert.match(migration, /check_type = 'Unclassified'/)
  assert.match(migration, /coalesce\(/)
  assert.match(migration, /source_type = 'ATM'/)
  assert.match(migration, /invalidRecordType' = 'Other'/)
  assert.match(migration, /invalidRecordMsg' = '今日休息，打卡需申请'/)
  assert.match(migration, /raw_payload->>'checkType' is null/)
  assert.match(migration, /lock_timeout = '3s'/)
  assert.doesNotMatch(migration, /grant |disable row level security|disable trigger|delete from|update public\./i)
  assert.doesNotMatch(migration, /alter table public\.attendance_manual_overrides/)
})
