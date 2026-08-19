import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const healthSource = readFileSync(
  new URL("../lib/systemHealth.ts", import.meta.url),
  "utf8"
)
const pageRouteSource = readFileSync(
  new URL("../app/api/admin/system-health/route.ts", import.meta.url),
  "utf8"
)
const noticeRouteSource = readFileSync(
  new URL("../app/api/admin/system-health/notify/route.ts", import.meta.url),
  "utf8"
)
const backupRouteSource = readFileSync(
  new URL("../app/api/backups/bunker-map-drive/route.ts", import.meta.url),
  "utf8"
)
const systemHealthPageSource = readFileSync(
  new URL("../app/admin/systemhealth/page.tsx", import.meta.url),
  "utf8",
)
const backupMaintenanceSource = readFileSync(
  new URL("../lib/backupMaintenance.ts", import.meta.url),
  "utf8",
)

function source(path: string) {
  return readFileSync(new URL(path, import.meta.url), "utf8")
}

function numericConstant(source: string, name: string) {
  const match = source.match(new RegExp(`const ${name} = (\\d[\\d_]*)`))
  assert.ok(match, `${name} must remain an explicit numeric constant`)
  return Number(match[1].replaceAll("_", ""))
}

test("System Health keeps enough runtime for full backup-chain byte verification", () => {
  const backupTimeoutMs = numericConstant(
    healthSource,
    "BACKUP_CHECK_TIMEOUT_MS"
  )
  const pageDurationSeconds = numericConstant(pageRouteSource, "maxDuration")
  const noticeDurationSeconds = numericConstant(noticeRouteSource, "maxDuration")

  assert.ok(backupTimeoutMs >= 180_000)
  assert.ok(pageDurationSeconds * 1_000 >= backupTimeoutMs + 30_000)
  assert.ok(noticeDurationSeconds * 1_000 >= backupTimeoutMs + 30_000)
})

test("Attendance Sync remains visible in System Health without sending email notices", () => {
  assert.match(
    healthSource,
    /runCheck\("attendance-sync", "Attendance Sync", checkAttendanceSync\)/,
  )
  assert.match(
    noticeRouteSource,
    /NON_ALERTING_CHECK_IDS = new Set\(\[[\s\S]*"attendance-sync"[\s\S]*\]\)/,
  )
  assert.match(
    noticeRouteSource,
    /check\.status !== "ok" && !isNonAlertingCheck\(check\)/,
  )
})

test("recent schema drift remains visible without sending a daily warning email", () => {
  assert.match(
    noticeRouteSource,
    /check\.id === "backup"[\s\S]*check\.status === "warning"[\s\S]*predates the live database schema[\s\S]*ageHours <= 36[\s\S]*unverifiedBackupFiles === 0/,
  )
})

test("daily backup has bounded retries that skip after a recent schema-current success", () => {
  const vercelConfig = readFileSync(new URL("../vercel.json", import.meta.url), "utf8")
  assert.match(vercelConfig, /"schedule": "2 19 \* \* \*"/)
  assert.match(vercelConfig, /"schedule": "2 20 \* \* \*"/)
  assert.match(vercelConfig, /"schedule": "2 21 \* \* \*"/)
  assert.match(backupRouteSource, /const CRON_RETRY_COVERAGE_HOURS = 6/)
  assert.match(backupRouteSource, /provenance\.source === "vercel-cron"/)
  assert.match(backupRouteSource, /previousAgeHours <= CRON_RETRY_COVERAGE_HOURS/)
  assert.match(backupRouteSource, /skipped: true/)
})

test("high-frequency cron writers defer while a verified backup owns the lease", () => {
  const guardedCronSources = [
    source("../app/api/event-calendar/google-sync/route.ts"),
    source("../app/api/cron/attendance-sync/route.ts"),
    source("../app/api/cron/spc-mobile-deliveries/route.ts"),
  ]
  for (const cronSource of guardedCronSources) {
    assert.match(cronSource, /await isVerifiedBackupActive\(\)/)
    assert.match(cronSource, /deferred: true/)
    assert.match(cronSource, /Verified daily backup in progress/)
  }
  assert.match(
    backupMaintenanceSource,
    /rpc\([\s\S]*"is_bunker_map_verified_backup_active"/,
  )
  const migration = source(
    "../supabase/migrations/20260817030551_defer_crons_during_verified_backup.sql",
  )
  assert.match(migration, /backup_lock\.expires_at > clock_timestamp\(\)/)
  const lockNameMigration = source(
    "../supabase/migrations/20260817032829_align_verified_backup_lock_name.sql",
  )
  assert.match(lockNameMigration, /daily-supabase-drive-v2/)
  assert.match(migration, /grant execute[\s\S]*to service_role/)
  assert.match(migration, /revoke all[\s\S]*from public, anon, authenticated/)
})

test("backup truth rechecks retry transient Supabase edge failures", () => {
  const attempts = numericConstant(
    backupRouteSource,
    "SUPABASE_TRUTH_RPC_ATTEMPTS",
  )

  assert.ok(attempts >= 3)
  assert.match(backupRouteSource, /\b521\b/)
  assert.match(backupRouteSource, /message\.includes\("web server is down"\)/)
  assert.match(
    backupRouteSource,
    /setTimeout\(resolve, SUPABASE_TRUTH_RPC_RETRY_DELAY_MS \* attempt\)/,
  )
})

test("SPC mobile delivery state is registered and mutation-fenced for daily backup", () => {
  const contractSources = [backupRouteSource, healthSource]
  for (const source of contractSources) {
    assert.match(source, /table: "spc_mobile_modes"/)
    assert.match(source, /table: "spc_mobile_enquiry_deliveries"/)
  }
  const validator = readFileSync(new URL("../scripts/validate-backup.mjs", import.meta.url), "utf8")
  assert.match(validator, /table: "spc_mobile_modes"/)
  assert.match(validator, /table: "spc_mobile_enquiry_deliveries"/)
  const fenceMigration = readFileSync(
    new URL("../supabase/migrations/20260813070942_fence_spc_mobile_backup_tables.sql", import.meta.url),
    "utf8",
  )
  assert.match(fenceMigration, /on public\.spc_mobile_modes/)
  assert.match(fenceMigration, /on public\.spc_mobile_enquiry_deliveries/)
})

test("SPC group dispatcher state is registered for daily backup", () => {
  const route = source("../app/api/backups/bunker-map-drive/route.ts")
  const health = source("../lib/systemHealth.ts")
  const routeFence = source("../supabase/migrations/20260819032149_fence_spc_delivery_routes_backup_table.sql")
  for (const table of [
    "spc_enquiry_revisions",
    "spc_group_dispatchers",
    "spc_group_delivery_jobs",
    "spc_delivery_routes",
  ]) {
    assert.match(route, new RegExp(`table: "${table}"`))
    assert.match(health, new RegExp(`table: "${table}"`))
  }
  assert.match(routeFence, /bunker_map_backup_epoch_fence/)
  assert.match(routeFence, /public\.spc_delivery_routes/)
})

test("daily backup keeps only the latest verified artifact and its predecessor", () => {
  assert.match(backupRouteSource, /const RETAINED_VERIFIED_BACKUP_COUNT = 2/)
  assert.match(
    backupRouteSource,
    /verifiedBackups\.slice\(RETAINED_VERIFIED_BACKUP_COUNT\)/,
  )
  assert.match(backupRouteSource, /await drive\.files\.delete\(/)
  assert.match(
    systemHealthPageSource,
    /OLDER VERIFIED FILES PERMANENTLY DELETED/,
  )
})

test("daily backup uses the Drive upload checksum receipt before full health verification", () => {
  const route = source("../app/api/backups/bunker-map-drive/route.ts")
  assert.match(route, /md5Checksum,size/)
  assert.match(route, /uploaded\.md5Checksum !== streamed\.uploadedFileMd5/)
})
