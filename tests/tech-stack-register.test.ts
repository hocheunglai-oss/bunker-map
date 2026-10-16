import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import vm from "node:vm"
import ts from "typescript"
import { fcunoConnectionPolicy } from "../config/fcunoConnections"
import { isTechStackResponse } from "../lib/techStackClient"
import { evaluateDatabaseBackupProtection } from "../lib/backupProtectionPolicy"

const routeSource = readFileSync(new URL("../app/api/admin/tech-stack/route.ts", import.meta.url), "utf8")
const pageSource = readFileSync(new URL("../app/admin/techstack/page.tsx", import.meta.url), "utf8")
const vercelConfiguration = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"))

type Secret = { name: string; configured: boolean | null; status: string; value: string; storage: string }
type TestResponse = { body: { secrets: Secret[]; [key: string]: unknown }; init?: ResponseInit }

function loadRoute(environment: Record<string, string> = {}, authorized = true) {
  const output = ts.transpileModule(routeSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText
  const exports: { GET?: () => Promise<TestResponse> } = {}
  const dependencies: Record<string, unknown> = {
    "next/server": { NextResponse: { json: (body: unknown, init?: ResponseInit) => ({ body, init }) } },
    "@/lib/adminAuth": { requireAdminPagePermission: async (page: string, permission: string) => {
      assert.equal(page, "tech-stack")
      assert.equal(permission, "view")
      if (!authorized) throw new Error("Forbidden")
    } },
    "@/config/fcunoConnections": { fcunoConnectionPolicy },
    "@/vercel.json": vercelConfiguration,
    "@supabase/supabase-js": { createClient: () => ({ rpc: async (name: string) => {
      assert.equal(name, "get_bunker_map_backup_inventory")
      return { data: { schema: "bunker-map.backup-inventory/v1", migrationHead: "20260924022019", tables: ["spc_users", "admin_users"] }, error: null }
    } }) },
  }
  vm.runInNewContext(output, {
    exports,
    Error,
    process: { env: { NEXT_PUBLIC_SUPABASE_URL: "https://example.invalid", SUPABASE_SERVICE_ROLE_KEY: "test-only", ...environment } },
    require: (name: string) => {
      assert.ok(name in dependencies, `Unexpected dependency: ${name}`)
      return dependencies[name]
    },
  })
  assert.ok(exports.GET)
  return exports.GET
}

test("Tech Stack exposes canonical deployment identity and the exact repository cron configuration", async () => {
  const result = await loadRoute()()
  const body = JSON.parse(JSON.stringify(result.body))
  assert.equal(body.deployment.project, fcunoConnectionPolicy.vercel.project)
  assert.equal(body.deployment.productionUrl, fcunoConnectionPolicy.vercel.productionOrigins[0])
  assert.equal(body.deployment.gitRepository, fcunoConnectionPolicy.github.repository)
  assert.deepEqual(body.schedules, vercelConfiguration.crons)
  assert.deepEqual(body.deployment.configuredRegions, vercelConfiguration.regions)
  assert.equal(body.deployment.functionRegion, "unknown")
  assert.equal(body.deployment.branch, "unknown")
  assert.equal(body.deployment.environment, "unknown")
  assert.equal(body.verification.responseTimeOnly, true)
  assert.ok(Date.parse(body.databaseInventory.checkedAt))
  assert.deepEqual(body.databaseInventory.tables, ["admin_users", "spc_users"])
  assert.equal((result.init?.headers as Record<string, string>)["Cache-Control"], "private, no-store, max-age=0")
  assert.equal(isTechStackResponse(result.body), true, "The real API response satisfies the client contract.")
})

test("Tech Stack presence never certifies credentials or exposes secret values", async () => {
  const secretValue = "example-secret-never-return-this"
  const { body } = await loadRoute({ OPENAI_API_KEY: secretValue, GEMINI_API_KEY: " [redacted] ", WHATSAPP_ACCESS_TOKEN: "your_access_token", ADMIN_PASSWORD: "   " })()
  const get = (name: string) => body.secrets.find((item) => item.name === name)!
  assert.equal(get("OPENAI_API_KEY").status, "PRESENT — NOT VALIDATED")
  assert.equal(get("GEMINI_API_KEY").configured, false)
  assert.equal(get("GEMINI_API_KEY").status, "PLACEHOLDER — NOT VALIDATED")
  assert.equal(get("WHATSAPP_ACCESS_TOKEN").configured, false)
  assert.equal(get("ADMIN_PASSWORD").status, "NOT PRESENT")
  assert.equal(get("EXCHANGE_SMTP_HOST").status, "APP DEFAULT — NOT VALIDATED")
  assert.ok(body.secrets.every((item) => item.value === "MASKED"))
  assert.ok(!JSON.stringify(body).includes(secretValue))
  const domain = get("EXCHANGE_ADDRESSBOOK_DOMAIN")
  assert.equal(domain.configured, null)
  assert.equal(domain.status, "VERIFY IN AZURE")
  for (const name of ["GEMINI_ADMIN_MODEL", "OPENAI_IMO_LOOKUP_MODEL", "FCUNO_OIDC_ENABLED", "FCUNO_FCOS_IDENTITY_SYNC_ENABLED", "FCUNO_OIDC_ES256_CURRENT_PRIVATE_KEY", "SPC_WHATSAPP_LOGIN_MFA_SECRET"]) {
    assert.ok(get(name), `Missing register key ${name}`)
  }
})

test("Tech Stack still requires the admin page permission", async () => {
  const result = await loadRoute({}, false)()
  assert.equal(result.init?.status, 403)
  assert.equal(result.body.message, "Forbidden")
  assert.equal(result.body.secrets, undefined)
})

test("Tech Stack documents recovery limits and separates dated external checks from source configuration", () => {
  assert.doesNotMatch(pageSource, /35 DAYS|2026-08-03\.1|SHEET-BACKED EDITS/)
  assert.match(pageSource, /LATEST TWO VERIFIED V2 ARTIFACTS/)
  assert.match(pageSource, /NOT A FULL-DATABASE RESTORE IMAGE/)
  assert.match(pageSource, /NOT A NEW-ARTIFACT READBACK BEFORE PRUNING/)
  assert.match(pageSource, /THIS DOES NOT GUARANTEE 30 DAYS OF ROLLBACK HISTORY/)
  assert.match(pageSource, /PUBLISHED AZURE VERSION NOT VERIFIED/)
  assert.match(pageSource, /THIS IS NOT AN INFRASTRUCTURE VERIFICATION TIME/)
  assert.match(pageSource, /THIS PAGE DOES NOT CERTIFY ROLLOUT COMPLETION/)
  assert.match(pageSource, /A CLOUD RUN SPEND CAP DOES NOT CAP STORAGE CHARGES/)
  assert.match(pageSource, /CLOUD RUN MONTHLY SPEND CAP HKD77\.50: CONFIGURED, NOT CURRENTLY ENFORCED/)
  assert.match(pageSource, /MAY PAUSE NEW BACKUP JOBS UNTIL MANUALLY LIFTED/)
  assert.match(pageSource, /EIGHT PHYSICAL RESTORE POINTS LISTED FOR OCTOBER 7–14/)
  assert.match(pageSource, /PITR IS NOT ENABLED/)
  assert.match(pageSource, /MANAGED DATABASE BACKUPS EXCLUDE STORAGE OBJECT BYTES/)
  assert.match(pageSource, /NO RESTORE WAS RUN/)
  assert.doesNotMatch(pageSource, /CAP IS NOT YET ACTIVATED/)
  assert.match(pageSource, /02:00 HKT; RETRIES 03:00 \/ 04:00 \/ 05:00; STOP 06:00/)
  const runbook = readFileSync(new URL("../scripts/azure-automation/sync-fcuno-outlook-addressbook.ps1", import.meta.url), "utf8")
  const version = /\$ExchangeTruthWorkerVersion = "([^"]+)"/.exec(runbook)?.[1]
  assert.ok(version)
  assert.ok(pageSource.includes(version.toUpperCase()), "Repository worker version has drifted from the Tech Stack register")
  assert.match(pageSource, /EXCHANGE DATED LIVE CHECK — 2026-10-14/)
  assert.match(pageSource, /DAILY 06:10 HKT \+ ON DEMAND/)
  assert.match(pageSource, /THIS PAGE DOES NOT RECHECK AZURE AT LOAD TIME/)
  assert.match(pageSource, /HEALTHY RUNS, INCLUDING SUCCESSFUL CHANGES, AND VERIFIED RECOVERY ARE SILENT/)
  assert.match(pageSource, /ACCESS\/TERMINAL ISSUES AND FULL-VERIFICATION FAILURES CAN ALERT IMMEDIATELY/)
  assert.doesNotMatch(pageSource, /ALL FAILURES SEND DETAILED NOTICES/)
  assert.match(pageSource, /NOT A HOSTED-ARTIFACT OR RESTORE PROOF/)
  assert.doesNotMatch(pageSource, /ALL WARNING-LEVEL RESULTS ARE CURRENTLY MUTED/)
  assert.match(pageSource, /A MISSING OR OVERDUE VERIFIED BACKUP/)
  assert.match(pageSource, /PERSISTENT PROTECTION GAPS ESCALATE AFTER 48 HOURS/)
  assert.match(pageSource, /08:15 \/ 08:30 RETRIES USE THE SAME OCCURRENCE RECEIPT/)
  assert.match(pageSource, /18:10 HKT DAILY CHECK AFTER THE 18:00 DEADLINE/)
  assert.ok(vercelConfiguration.crons.some((row: { path: string; schedule: string }) =>
    row.path === "/api/cron/attendance-auto-confirm" && row.schedule === "10 10 * * *"))
  for (const { path } of vercelConfiguration.crons) {
    assert.ok(pageSource.includes(`"${path}"`), `Missing readable cron description for ${path}`)
  }
})

test("Tech Stack never accepts an incomplete inventory or unmasked credential response", async () => {
  const body = JSON.parse(JSON.stringify((await loadRoute()()).body))
  for (const patch of [
    { deployment: null },
    { databaseInventory: { ...body.databaseInventory, tables: [null] } },
    { schedules: [{ path: "/synthetic" }] },
    { verification: null },
    { generatedAt: "not-a-date" },
    { secrets: [{ ...body.secrets[0], value: "a-secret-must-not-be-rendered" }] },
    { secrets: [{ ...body.secrets[0], configured: "true" }] },
  ]) assert.equal(isTechStackResponse({ ...body, ...patch }), false)
  assert.equal(isTechStackResponse(null), false)
  assert.equal(isTechStackResponse([]), false)
})

test("Tech Stack alert guidance matches the executable backup policy rather than blanket-muting warnings", () => {
  const now = Date.parse("2026-10-16T03:00:00.000Z")
  const waiting = evaluateDatabaseBackupProtection({
    now, receiptCreatedAt: "2026-10-15T19:13:00.000Z", generatedAt: "2026-10-15T19:03:00.000Z", inventoryCurrent: false,
  })
  assert.equal(waiting.details.notificationEligible, false)
  assert.equal(waiting.details.incidentResolved, false)
  const missing = evaluateDatabaseBackupProtection({ now, receiptCreatedAt: null, inventoryCurrent: null })
  assert.equal(missing.status, "warning")
  assert.equal(missing.details.notificationEligible, true)
  const persistent = evaluateDatabaseBackupProtection({
    now: now + 72 * 3_600_000, receiptCreatedAt: null, inventoryCurrent: null,
    gaps: [{ key: "availability", firstDueAt: new Date(now).toISOString(), firstUncoveredAt: new Date(now).toISOString() }],
  })
  assert.equal(persistent.status, "error")
  assert.equal(persistent.details.alertLevel, 2)
})
