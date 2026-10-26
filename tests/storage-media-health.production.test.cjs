// Read the actual Next/Webpack output with synthetic, credential-free settings.
// No Next source transpilation or replacement health implementation is used.
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

async function main() {
  for (const key of Object.keys(process.env)) {
    if (/(?:SUPABASE_SERVICE_ROLE|GOOGLE_|CRON_SECRET|MAIL_|SMTP_|OUTLOOK_|DINGTALK_)/.test(key)) {
      assert.equal(process.env[key], undefined, `Production-test credentials must be absent: ${key}`)
    }
  }
  delete process.env.STORAGE_MEDIA_BACKUP_RECURRING_ENABLED
  delete process.env.STORAGE_MEDIA_BACKUP_RECURRING_ACTIVATED_AT
  let networkAttempts = 0
  const blocked = () => { networkAttempts++; throw Error("Network disabled in compiled-health verification") }
  globalThis.fetch = blocked
  for (const [module, methods] of [["node:http", ["request", "get"]], ["node:https", ["request", "get"]], ["node:net", ["connect", "createConnection"]]]) {
    for (const method of methods) require(module)[method] = blocked
  }
  const root = path.resolve(__dirname, ".."), built = path.join(root, ".next/server")
  assert.ok(fs.existsSync(path.join(built, "app/api/admin/system-health/route.js")), "Build the production route first")
  require(path.join(built, "app/api/admin/system-health/route.js"))
  const webpack = require(path.join(built, "webpack-runtime.js"))
  const candidates = []
  for (const [id, factory] of Object.entries(webpack.m)) {
    if (!factory.toString().includes("storage-media-backup")) continue
    for (const exported of Object.values(webpack(id))) {
      if (typeof exported === "function" && exported.toString().includes("storage-media-backup")) candidates.push(exported)
    }
  }
  assert.equal(candidates.length, 1, "Resolve exactly the production getSystemHealth export, not a guessed module ID")
  const result = await candidates[0]()
  const check = result.checks.find(value => value.id === "storage-media-backup")
  assert.ok(check)
  assert.equal(check.status, "warning")
  assert.equal(check.message, "Recurring uploaded-file backups are not activated.")
  assert.equal(check.details.recurringActivated, false)
  assert.equal(check.details.notificationEligible, false)
  assert.equal(check.details.incidentResolved, false)
  assert.equal(networkAttempts, 0, "Missing credentials and inactive protection must not cause outbound requests")
  console.log(JSON.stringify({ passed: true, actualCompiledRoute: true, sourceMocks: false,
    checkCount: result.checks.length, mediaMessage: check.message, networkAttempts,
    limitation: "Unactivated compiled service path only; authenticated receipt and inventory logic is verified separately with synthetic transports." }))
}
main().catch(error => { console.error(error); process.exitCode = 1 })
