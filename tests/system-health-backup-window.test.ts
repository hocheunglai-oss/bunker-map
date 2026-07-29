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
