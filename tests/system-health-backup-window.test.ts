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
