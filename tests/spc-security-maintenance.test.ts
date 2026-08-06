import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { GET } from "../app/api/spc/security-maintenance/route"
import { hasSpcSecurityMaintenanceAccess } from "../lib/spcSecurityMaintenance"

test("SPC security maintenance requires the configured cron bearer secret", async () => {
  const secret = "test-cron-secret"
  const authorized = new Request("https://spc.fcuno.com/api/spc/security-maintenance", {
    headers: { authorization: `Bearer ${secret}` },
  })
  const unauthorized = new Request("https://spc.fcuno.com/api/spc/security-maintenance", {
    headers: { authorization: "Bearer wrong-secret" },
  })

  assert.equal(hasSpcSecurityMaintenanceAccess(authorized, secret), true)
  assert.equal(hasSpcSecurityMaintenanceAccess(unauthorized, secret), false)
  assert.equal(hasSpcSecurityMaintenanceAccess(authorized, ""), false)

  const previousSecret = process.env.CRON_SECRET
  process.env.CRON_SECRET = secret
  try {
    const response = await GET(unauthorized)
    assert.equal(response.status, 401)
    assert.equal(response.headers.get("cache-control"), "private, no-store")
    assert.deepEqual(await response.json(), { message: "Unauthorized" })
  } finally {
    if (previousSecret === undefined) delete process.env.CRON_SECRET
    else process.env.CRON_SECRET = previousSecret
  }
})

test("Vercel runs SPC login-evidence retention every day", async () => {
  const config = JSON.parse(
    await readFile(new URL("../vercel.json", import.meta.url), "utf8"),
  ) as { crons?: Array<{ path: string; schedule: string }> }

  assert.deepEqual(
    config.crons?.filter(
      (job) => job.path === "/api/spc/security-maintenance",
    ),
    [{ path: "/api/spc/security-maintenance", schedule: "17 18 * * *" }],
  )
})
