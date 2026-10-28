import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { transformSync } from "esbuild"
import { createClient } from "@supabase/supabase-js"
import { createHash } from "node:crypto"
import * as recoveryAcceptance from "../lib/postgresRecoveryAcceptance.mjs"
import * as backupReceipt from "../lib/postgresBackupReceipt.mjs"
import * as recoveryEvidence from "../lib/postgresRecoveryEvidence.mjs"

function load(relative, modules = {}, environment = {}) {
  const loaded = { exports: {} }
  const code = transformSync(readFileSync(new URL(`../${relative}`, import.meta.url), "utf8"), { loader: "ts", format: "cjs", target: "node24" }).code
  new Function("require", "module", "exports", "process", "fetch", code)(name => {
    assert.ok(Object.hasOwn(modules, name), name); return modules[name]
  }, loaded, loaded.exports, { env: environment }, () => assert.fail("No live fetch is allowed in the callback/notification fixture"))
  return loaded.exports
}
const config = load("config/fcunoConnections.ts")
const backupMaintenance = load("lib/postgresBackupMaintenance.ts", {
  "node:crypto": { createHash }, "@/lib/postgresRecoveryAcceptance.mjs": recoveryAcceptance,
  "@/lib/postgresBackupReceipt.mjs": backupReceipt, "@/lib/postgresRecoveryEvidence.mjs": recoveryEvidence,
  "@/config/fcunoConnections": config, "@/lib/adminPages": load("lib/adminPages.ts"),
  "@/lib/emailAddress": load("lib/emailAddress.ts"),
  "@/lib/systemHealthAlerts": load("lib/systemHealthAlerts.ts", { "@/config/fcunoConnections": config }),
})
const policy = load("lib/backupProtectionPolicy.ts")
const input = { domain: "drive-file", observedAt: "2026-10-14T01:00:00Z", complete: true,
  gaps: [{ key: "opaque-file", dueAt: "2026-10-13T18:00:00Z", requiredSinceAt: "2026-10-14T00:00:00Z" }] }
const good = { schema: "fcuno.backup-protection-gaps/v1", domain: input.domain, observedAt: input.observedAt, accepted: true,
  gaps: [{ key: "opaque-file", firstUncoveredAt: input.observedAt, firstDueAt: input.gaps[0].dueAt }] }
function fixture(error, reply = good) {
  const requests = [], accepted = [], alerts = [], emails = []
  const store = load("lib/backupProtectionGapStore.ts", {
    "server-only": {}, "@/config/fcunoConnections": config, "@/lib/backupProtectionPolicy": policy,
    "@supabase/supabase-js": { createClient(url, key, options) {
      assert.equal(url, `https://${config.fcunoConnectionPolicy.supabase.projectRef}.supabase.co`)
      assert.equal(key, "synthetic-key")
      return createClient(url, key, { ...options, global: { fetch: async (target, init) => {
        const parsed = new URL(target)
        assert.equal(parsed.origin, url)
        assert.equal(parsed.pathname, "/rest/v1/rpc/reconcile_backup_protection_gaps")
        assert.equal(init.method, "POST")
        assert.equal(init.signal.aborted, false)
        requests.push({ path: parsed.pathname, body: JSON.parse(init.body) })
        return new Response(JSON.stringify(error ? { ...error, details: error.details ?? "PRIVATE_DIAGNOSTIC", hint: "PRIVATE_HINT" } : reply), {
          status: error ? error.code === "P0001" ? 400 : error.code === "40001" ? 409 : 500 : 200,
          headers: { "content-type": "application/json" },
        })
      } } })
    } },
  }, { NEXT_PUBLIC_SUPABASE_URL: `https://${config.fcunoConnectionPolicy.supabase.projectRef}.supabase.co`, SUPABASE_SERVICE_ROLE_KEY: "synthetic-key" })
  const route = load("app/api/admin/system-health/notify/route.ts", {
    "next/server": { NextResponse: { json: Response.json } }, "node:crypto": { randomUUID: () => "00000000-0000-4000-8000-000000000001" },
    "@/lib/adminAuth": { requireAdminPagePermission: () => assert.fail("Synthetic cron request must not invoke user auth") },
    "@/lib/eventCalendarEmail": { normalizeEmailList: () => ["test@example.invalid"], sendCalendarEmail: async value => { emails.push(value); assert.fail("No email may be sent from an unaccepted observation") } },
    "@/lib/systemHealth": { getErrorMessage: value => value.message, async getSystemHealth({ backupGapObserver }) {
      const result = await backupGapObserver(input); accepted.push(result)
      return { checks: [], status: "ok", checkedAt: input.observedAt }
    } },
    "@/lib/systemHealthAlerts": { buildHealthAlertHtml: () => assert.fail("No error may become an email"), deliverHealthAlerts: async value => { alerts.push(value); assert.fail("No alert may be claimed from an unaccepted observation") } },
    "@/lib/systemHealthAlertStore": { createHealthAlertStore: () => assert.fail("No alert store may be created from an unaccepted observation") },
    "@/lib/backupProtectionGapStore": store,
    "@/lib/postgresBackupMaintenance": backupMaintenance,
    "@/lib/adminUsers": { listManagedAdminUsers: () => assert.fail("Disabled maintenance must not read the directory") },
  }, { CRON_SECRET: "synthetic-cron" })
  return { requests, accepted, alerts, emails, observe: () => store.createBackupProtectionGapObserver()(input),
    notify: () => route.GET(new Request("https://fixture.invalid/api/admin/system-health/notify", { headers: { authorization: "Bearer synthetic-cron" } })) }
}

test("actual SDK/callback/notification route never accepts or emails any unconfirmed observation", async t => {
  const cases = [
    ["new observation guard", { code: "P0001", message: "Backup protection observation was not saved.", details: "BACKUP_PROTECTION_OBSERVATION_UNCONFIRMED" }],
    ["new reconciliation guard", { code: "P0001", message: "Backup protection gaps were not reconciled.", details: "BACKUP_PROTECTION_OBSERVATION_UNCONFIRMED" }],
    ["legacy guard during database-first rollout", { code: "40001", message: "Backup protection observation was not saved." }],
    ["actual serialization error", { code: "40001", message: "could not serialize PRIVATE_DATABASE_OPERATION" }],
    ["unknown P0001", { code: "P0001", message: "PRIVATE_UNRELATED_BUSINESS_ERROR" }],
    ["real constraint error", { code: "23514", message: "PRIVATE_CONSTRAINT" }],
    ["real timeout error", { code: "57014", message: "PRIVATE_DATABASE_TIMEOUT" }],
    ["marker in unknown details only", { code: "XX000", message: "PRIVATE_DATABASE_ERROR", details: "BACKUP_PROTECTION_OBSERVATION_UNCONFIRMED" }],
    ["stale nonaccepted success response", null, { ...good, accepted: false, observedAt: "2026-10-14T02:00:00Z" }],
    ["malformed false-success response", null, { ...good, accepted: "true" }],
  ]
  for (const [name, error, reply] of cases) await t.test(name, async () => {
    const f = fixture(error, reply)
    await assert.rejects(f.observe(), rejected => {
      assert.ok(rejected instanceof policy.BackupProtectionObservationError)
      assert.doesNotMatch(rejected.message, /PRIVATE_|P0001|40001|23514|57014|XX000|UNCONFIRMED/)
      return true
    })
    assert.equal(f.requests.length, 1, "the actual SDK must not retry this POST")
    const response = await f.notify()
    assert.equal(response.status, 500)
    const result = await response.json()
    assert.match(result.message, /No alert was sent/)
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|P0001|40001|23514|57014|XX000|UNCONFIRMED/)
    assert.equal(f.requests.length, 2, "the notification attempt performs one bounded RPC, not a retry loop")
    assert.deepEqual(f.accepted, []); assert.deepEqual(f.alerts, []); assert.deepEqual(f.emails, [])
    for (const request of f.requests) assert.deepEqual(request.body, {
      p_domain: input.domain, p_observed_at: input.observedAt, p_gaps: input.gaps, p_complete: true,
    })
  })
  await t.test("positive control accepts only the validated durable response", async () => {
    const f = fixture(null)
    assert.deepEqual(await f.observe(), good)
    assert.equal(f.requests.length, 1)
    assert.deepEqual(f.alerts, []); assert.deepEqual(f.emails, [])
  })
})
