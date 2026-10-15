import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { transformSync } from "esbuild"
import * as alerts from "../lib/systemHealthAlerts"
import { BackupProtectionObservationError } from "../lib/backupProtectionPolicy"
import type { HealthCheck } from "../lib/systemHealth"
import * as ccinfo from "../lib/ccinfoSave"
import * as contacts from "../lib/outlookContactValidation"
import * as pricing from "../lib/priceSetterLegacyWrites"
import * as groups from "../lib/outlookGroupWriteGuard"

const warning: HealthCheck = { id: "backup", label: "Database backup", status: "warning", message: "The overnight database backup is missing.", checkedAt: "2026-10-15T00:30:00.000Z",
  details: { notificationEligible: true, incidentResolved: false, alertLevel: 1 } }

function fixture(options: { permissionError?: string; healthError?: Error; checks?: HealthCheck[]; rejectRecipient?: string } = {}) {
  const sequence: string[] = [], sent: Array<{ to: string[]; subject: string; html: string }> = [], claims: unknown[] = []
  const states = new Map<string, { level: number; token?: string; claimedLevel?: number }>()
  const leases = new Map<string, string[]>()
  let rejectRecipient = options.rejectRecipient
  const observer = async () => assert.fail("Only the injected health layer should call this marker")
  const modules: Record<string, unknown> = {
    "next/server": { NextResponse: Object.assign(Response, { json: Response.json }) }, "node:crypto": { randomUUID: () => crypto.randomUUID() },
    "@/lib/adminAuth": { async requireAdminPagePermission(page: string, access: string) { sequence.push(`${page}:${access}`); if (options.permissionError) throw Error(options.permissionError) } },
    "@/lib/eventCalendarEmail": { normalizeEmailList: (value: string) => value.split(","), async sendCalendarEmail(input: typeof sent[number]) {
      sent.push(input); if (input.to[0] === rejectRecipient) throw Error("Synthetic SMTP rejected recipient")
      return { accepted: input.to, rejected: [] }
    } },
    "@/lib/systemHealth": { async getSystemHealth(input: { backupGapObserver?: unknown }) {
      sequence.push("health")
      assert.equal(input.backupGapObserver, observer)
      if (options.healthError) throw options.healthError
      return { checks: options.checks || [warning], status: "warning", checkedAt: warning.checkedAt }
    }, getErrorMessage: (error: Error) => error.message },
    "@/lib/systemHealthAlerts": alerts,
    "@/lib/backupProtectionGapStore": { createBackupProtectionGapObserver() { sequence.push("observer-created"); return observer } },
    "@/lib/systemHealthAlertStore": { createHealthAlertStore(recipient: string): alerts.HealthAlertStore {
      return { async claim(observations, token) {
        claims.push(observations)
        const result: string[] = [], owned: string[] = []
        for (const observation of observations) {
          const key = `${recipient}:${observation.check_id}`
          const state = states.get(key) || { level: 0 }
          states.set(key, state)
          if (observation.alert_level === 0) { state.level = 0; state.token = undefined; continue }
          if (observation.alert_level !== null && observation.alert_level > state.level && !state.token) {
            state.token = token; state.claimedLevel = observation.alert_level; owned.push(key); result.push(observation.check_id)
          }
        }
        leases.set(token, owned)
        return result
      }, async finish(token, delivered) {
        for (const key of leases.get(token) || []) {
          const state = states.get(key)!
          if (state.token !== token) continue
          if (delivered) state.level = Math.max(state.level, state.claimedLevel || 0)
          state.token = undefined
        }
      } }
    } },
  }
  const loaded = { exports: {} as { GET(request: Request): Promise<Response> } }
  const code = transformSync(readFileSync(new URL("../app/api/admin/system-health/notify/route.ts", import.meta.url), "utf8"), { loader: "ts", format: "cjs", target: "node24" }).code
  new Function("require", "module", "exports", "process", "fetch", code)((name: string) => { assert.ok(name in modules, name); return modules[name] }, loaded, loaded.exports,
    { env: { CRON_SECRET: "synthetic-only-cron", SYSTEM_HEALTH_EMAIL_RECIPIENTS: "a@example.invalid,b@example.invalid" } }, () => assert.fail("No live network in route fixture"))
  return { sequence, sent, claims, allowAllRecipients() { rejectRecipient = undefined },
    request(cron = true) { return loaded.exports.GET(new Request("https://fixture.invalid/api/admin/system-health/notify", { headers: cron ? { authorization: "Bearer synthetic-only-cron" } : {} })) } }
}

test("actual notify route authenticates before creating an observer or performing health/delivery work", async () => {
  const f = fixture({ permissionError: "Unauthorized" })
  assert.equal((await f.request(false)).status, 401)
  assert.deepEqual(f.sequence, ["system-health:view"])
  assert.deepEqual(f.sent, [])
})

test("durable gap state failure aborts actual notification route before any alert claim or email", async () => {
  const f = fixture({ healthError: new BackupProtectionObservationError() })
  assert.equal((await f.request()).status, 500)
  assert.deepEqual(f.sequence, ["observer-created", "health"])
  assert.deepEqual(f.claims, [])
  assert.deepEqual(f.sent, [])
})

test("actionable database warnings are not muted; concurrent runs share one delivery per recipient", async () => {
  const f = fixture()
  const result = await Promise.all([f.request(), f.request()])
  assert.ok(result.every((response) => response.status === 200))
  assert.equal(f.sent.length, 2)
  assert.deepEqual(f.sent.map((item) => item.to[0]).sort(), ["a@example.invalid", "b@example.invalid"])
  assert.equal(f.sent[0].subject, "FC Uno: action needed")
  assert.equal((await f.request()).status, 200)
  assert.equal(f.sent.length, 2)
})

test("one rejected mailbox can retry without repeating successful colleagues' emails", async () => {
  const f = fixture({ rejectRecipient: "b@example.invalid" })
  assert.equal((await f.request()).status, 500)
  f.allowAllRecipients()
  assert.equal((await f.request()).status, 200)
  assert.deepEqual(f.sent.map((item) => item.to[0]), ["a@example.invalid", "b@example.invalid", "b@example.invalid"])
})

test("capacity-only warnings and unknown backup reads do not send or re-arm protection incidents", async () => {
  const f = fixture({ checks: [
    { ...warning, id: "drive-file-content-backup", details: { notificationEligible: false, incidentResolved: true, storageAdvice: true } },
    { ...warning, details: { notificationEligible: false, incidentResolved: false, protectionUnknown: true } },
  ] })
  assert.equal((await f.request()).status, 200)
  assert.deepEqual(f.sent, [])
  const observations = f.claims[0] as alerts.HealthAlertObservation[]
  assert.deepEqual(observations.map((item) => [item.check_id, item.alert_level]), [["drive-file-content-protection", 0], ["backup", null]])
})

test("generic admin service-role proxy cannot invoke the private gap-observer RPC", async () => {
  const forwarded: unknown[] = []
  const modules: Record<string, unknown> = {
    "next/server": { NextResponse: Object.assign(Response, { json: Response.json }) }, "@supabase/supabase-js": { createClient() { assert.fail("No database client allowed") } },
    "@/lib/adminAuth": { async requireAdminPagePermission() { assert.fail("RPC must be denied by target allowlist first") } },
    "@/lib/ccinfoSave": ccinfo, "@/lib/outlookContactValidation": contacts, "@/lib/priceSetterLegacyWrites": pricing, "@/lib/outlookGroupWriteGuard": groups,
  }
  const loaded = { exports: {} as Record<string, (request: Request) => Promise<Response>> }
  const code = transformSync(readFileSync(new URL("../app/api/admin/supabase/route.ts", import.meta.url), "utf8"), { loader: "ts", format: "cjs", target: "node24" }).code
  new Function("require", "module", "exports", "process", "fetch", code)((name: string) => { assert.ok(name in modules, name); return modules[name] }, loaded, loaded.exports,
    { env: { NEXT_PUBLIC_SUPABASE_URL: "https://fixture.invalid", SUPABASE_SERVICE_ROLE_KEY: "synthetic-only" } }, (...args: unknown[]) => { forwarded.push(args); assert.fail("RPC forwarded") })
  for (const page of ["pricesetter", "hongkong-price-history", "taiwan-price-history", "taiwan-remarks", "ccinfo", "phonebook", "outlook-addressbook", "system-health", "email-templates"]) for (const rpc of ["reconcile_backup_protection_gaps", "preview_backup_protection_gaps"]) {
    const target = `https://fixture.invalid/rest/v1/rpc/${rpc}`
    const response = await loaded.exports.POST(new Request(`https://app.invalid/api/admin/supabase?target=${encodeURIComponent(target)}`, { method: "POST", headers: { "x-bunker-admin-page-id": page, "content-type": "application/json" }, body: "{}" }))
    assert.equal(response.status, 403, page)
  }
  assert.deepEqual(forwarded, [])
})
