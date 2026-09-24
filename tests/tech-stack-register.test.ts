import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import vm from "node:vm"
import ts from "typescript"
import { fcunoConnectionPolicy } from "../config/fcunoConnections"

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
  assert.match(pageSource, /02:00 HKT; RETRIES 03:00 \/ 04:00 \/ 05:00; STOP 06:00/)
  const runbook = readFileSync(new URL("../scripts/azure-automation/sync-fcuno-outlook-addressbook.ps1", import.meta.url), "utf8")
  const version = /\$ExchangeTruthWorkerVersion = "([^"]+)"/.exec(runbook)?.[1]
  assert.ok(version)
  assert.ok(pageSource.includes(version.toUpperCase()), "Repository worker version has drifted from the Tech Stack register")
  for (const { path } of vercelConfiguration.crons) {
    assert.ok(pageSource.includes(`"${path}"`), `Missing readable cron description for ${path}`)
  }
})
