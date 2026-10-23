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
  assert.match(pageSource, /DATED RECORD, NOT A LIVE AZURE QUERY/)
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
  const publication = JSON.parse(readFileSync(new URL("../scripts/azure-automation/exchange-publication-baseline.json", import.meta.url), "utf8"))
  assert.equal(publication.workerVersion, version, "Repository worker version has drifted from the published-source register")
  assert.match(pageSource, /import exchangePublicationBaseline from "@\/scripts\/azure-automation\/exchange-publication-baseline\.json"/)
  assert.match(pageSource, /exchangePublicationBaseline\.workerVersion\.toUpperCase\(\)/)
  assert.match(pageSource, /EXCHANGE DATED LIVE CHECK — \{exchangePublicationBaseline\.verifiedAt\}/)
  assert.match(pageSource, /NOT A SUBSEQUENT LIVE FULL EXCHANGE VERIFICATION/)
  assert.match(pageSource, /HOURLY INCREMENTAL RUNS REQUEST GENUINE FULL READ-ONLY VERIFICATION AT 24 HOURS, BEFORE THE UNCHANGED 36-HOUR ACCEPTANCE LIMIT/)
  const renewalSql = readFileSync(new URL("../supabase/migrations/20261023041904_refresh_outlook_certification_before_expiry.sql", import.meta.url), "utf8")
  assert.match(renewalSql, /certification\.certified_at <= clock_timestamp\(\) - interval '24 hours'/)
  assert.match(renewalSql, /certification\.certified_at >= clock_timestamp\(\) - interval '36 hours'/)
  assert.match(pageSource, /DAILY 06:10 HKT \+ ON DEMAND/)
  assert.match(pageSource, /THIS PAGE DOES NOT RECHECK AZURE AT LOAD TIME/)
  assert.match(pageSource, /HEALTHY RUNS, INCLUDING SUCCESSFUL CHANGES, AND VERIFIED RECOVERY ARE SILENT/)
  assert.match(pageSource, /ACCESS\/TERMINAL ISSUES AND GENUINE FULL-VERIFICATION FAILURES CAN ALERT IMMEDIATELY/)
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

test("Tech Stack and recovery docs distinguish the verified one-time media snapshot from recurring backup and full recovery", () => {
  const implementation = readFileSync(new URL("../docs/storage-media-backup-source-implementation.md", import.meta.url), "utf8")
  const restoreRunbook = readFileSync(new URL("../docs/backup-restore-runbook.md", import.meta.url), "utf8")
  assert.match(pageSource, /PRESENTATION MEDIA — VERIFIED 2026-10-21/)
  assert.match(pageSource, /ONE-TIME PRIVATE GOOGLE CLOUD STORAGE COPY OF ALL 15 FILES \(224,309,367 BYTES\)/)
  assert.match(pageSource, /TWO READ-BACK CHECKS MATCHED THE COPIED BYTES/)
  assert.match(pageSource, /TEMPORARY SOURCE ACCESS IS OFF; NO RECURRING MEDIA BACKUP IS SCHEDULED/)
  assert.match(pageSource, /DATABASE-TO-FILE BYTE MATCHING AND HISTORICAL FILE-VERSION RECOVERY REMAIN UNPROVED/)
  assert.doesNotMatch(pageSource, /WHOLE-DATABASE RESTORE AND HISTORICAL FILE-VERSION MATCHING REMAIN UNPROVED/)
  assert.match(pageSource, /SYSTEM HEALTH DOES NOT MONITOR THIS MEDIA SNAPSHOT/)
  assert.doesNotMatch(pageSource, /INDEPENDENT RECOVERY COVERAGE HAS NOT BEEN ESTABLISHED/)
  assert.match(implementation, /## Verified one-time rollout — 2026-10-21/)
  assert.match(implementation, /At the preparation stage, no activation values had been set/)
  assert.match(implementation, /2026-10-21T11:14:20\.572Z/)
  assert.match(implementation, /3bc8ed980232559f2a3d0832d09677b582b2f8f064918d150d5b1d161744bc04/)
  assert.match(implementation, /`historicalByteCorrespondence` remains `"unproved"`/)
  assert.match(restoreRunbook, /\*\*2026-10-21 follow-up:\*\*/)
  assert.match(restoreRunbook, /no recurring media backup is\nscheduled/)
  assert.match(restoreRunbook, /not a whole-database restore or a timed recovery rehearsal/)
  assert.match(pageSource, /PRIVATE LOGICAL DATABASE REHEARSAL — COMPLETED 2026-10-23/)
  assert.match(pageSource, /126 FULL-TABLE FINGERPRINTS, ORIGINAL METADATA AND EIGHT SEQUENCE STATES MATCHED/)
  assert.match(pageSource, /NATIVE TLS ON BOTH SOURCE CONNECTION HOPS WAS VERIFIED/)
  assert.match(pageSource, /SOURCE ROLE COPIES REMAINED NOLOGIN; LOCAL POSTGRESQL 17\.11 WAS NOT A PRODUCTION UPGRADE/)
  assert.match(pageSource, /NOT A RECURRING POSTGRESQL BACKUP, MANAGED PHYSICAL\/PITR RESTORE, WHOLE HOSTED SUPABASE RECOVERY OR STORAGE-FILE RECOVERY/)
  assert.match(restoreRunbook, /## One-time private logical database rehearsal — 2026-10-23/)
  assert.match(restoreRunbook, /not a recurring\s+PostgreSQL backup/)
  assert.match(restoreRunbook, /not a production recovery-time guarantee/)
  const evidenceText = readFileSync(new URL("../docs/private-logical-recovery-rehearsal-2026-10-23.json", import.meta.url), "utf8")
  const evidence = JSON.parse(evidenceText)
  assert.equal(evidence.schema, "fcuno.private-logical-recovery-public-evidence/v1")
  assert.equal(evidence.result, "passed")
  assert.equal(evidence.completedAt, "2026-10-23T05:07:13.579Z")
  assert.equal(evidence.archive.bytes, 2_895_330_862)
  assert.equal(evidence.archive.sha256, "d9fc47f312926a10638c656369c4482fade3a5b74038918750814c7c983111bf")
  assert.deepEqual(evidence.verified, {
    fullTableFingerprints: 126, originalMetadataSections: 12, originalRoleCopiesNoLogin: 17,
    archivedSequenceStates: 8, archiveTocEntries: 2155, unaccountedTocEntries: 0,
    sourceClientVerifyFullTls: true, sourceBackendTls: true, ownedClientsAndServerClosed: true, passwordFileAbsent: true,
  })
  assert.equal(evidence.scope.oneTimePrivateLogicalDatabaseRehearsal, true)
  for (const field of ["recurringPostgresqlBackup", "managedPhysicalOrPitrRecovery", "wholeHostedSupabaseRecovery", "storageFileRecovery", "historicalFileVersionRecovery", "productionEngineUpgrade", "productionRecoveryTimeGuarantee"]) {
    assert.equal(evidence.scope[field], false, field)
  }
  assert.equal(evidence.engines.source, "17.6 managed Supabase")
  assert.equal(evidence.engines.restored, "17.11 isolated local")
  assert.match(evidence.fingerprintMethod, /not a cryptographic multiset proof/)
  assert.doesNotMatch(evidenceText, /\/private\/|\/Users\/|postgres(?:ql)?:\/\/|password\s*[:=]|snapshotId|\b(?:\d{1,3}\.){3}\d{1,3}\b/i)
  assert.deepEqual(evidence.privateEvidenceReceiptSha256, {
    sourceExport: "bcadda0b41d989f58bc2286cf3b6621e79455171893cbef6f99b5b58766cd287",
    offlineCompletion: "848caa2928e191f0beec928145141ec25be9b561d34efa1f9cde1e3b9cef8a8b",
  })
})

test("Tech Stack dates the Oct22 database setting check without claiming native TLS or completed recovery", () => {
  assert.match(pageSource, /POSTGRESQL 17 \(17\.6\.1\.084 VERIFIED 2026-10-22\)/)
  assert.match(pageSource, /DATABASE SSL — DASHBOARD SETTING ENABLED AND PERSISTED 2026-10-22 AT 20:03:56 HKT \(12:03:56 UTC\)/)
  assert.match(pageSource, /PROJECT RETURNED ACTIVE_HEALTHY; 18 LIVE APPLICATION CHECKS PASSED/)
  assert.match(pageSource, /NATIVE CLIENT TLS ON BOTH CONNECTION HOPS AND A WHOLE-DATABASE RESTORE ARE NOT CERTIFIED BY THIS SETTING CHECK/)
  assert.match(pageSource, /ENGINE RECHECKED 2026-10-22; COMPATIBILITY INVENTORY CHECKED 2026-10-16/)
  assert.doesNotMatch(pageSource, /17\.6\.1\.084 VERIFIED 2026-10-16|DATABASE MAINTENANCE — READ-ONLY CHECK 2026-10-16/)
})

test("Tech Stack service summary separates recurring Drive backup, one-time uploaded-media snapshot, and optional role-default storage", () => {
  assert.match(pageSource, /\["DRIVE FILE BACKUP", "GOOGLE CLOUD STORAGE"/)
  assert.match(pageSource, /\["UPLOADED MEDIA SNAPSHOT", "ONE-TIME SUPABASE STORAGE BYTE COPY", "GOOGLE CLOUD STORAGE", "VERIFIED 2026-10-21; 15 FILES \/ 224,309,367 BYTES; NOT RECURRING OR MONITORED BY SYSTEM HEALTH"\]/)
  assert.match(pageSource, /admin_role_defaults \(optional; office_calendar_store fallback\)/)
  const source = readFileSync(new URL("../lib/adminUsers.ts", import.meta.url), "utf8")
  assert.match(source, /supabase\.rpc\("read_admin_permission_groups"\)/)
  const groupSql = readFileSync(new URL("../supabase/migrations/20261022113511_atomic_admin_permission_groups.sql", import.meta.url), "utf8")
  assert.match(groupSql, /if pg_catalog\.to_regclass\('public\.admin_role_defaults'\) is not null then[\s\S]*?from public\.admin_role_defaults[\s\S]*?else[\s\S]*?from public\.office_calendar_store where key='admin-permission-groups'/)
  assert.match(groupSql, /'storage',case when pg_catalog\.to_regclass\('public\.admin_role_defaults'\) is null then 'shared-store' else 'table' end/)
})

test("Tech Stack staging codec matches the active compressor and decompression path, not just a receipt label", () => {
  const stageSource = readFileSync(new URL("../lib/compressedBackupStage.ts", import.meta.url), "utf8")
  const exportSource = readFileSync(new URL("../app/api/backups/bunker-map-drive/route.ts", import.meta.url), "utf8")
  assert.match(stageSource, /const writable = createBrotliCompress\(/)
  assert.match(stageSource, /const brotli = createBrotliDecompress\(\)/)
  assert.match(stageSource, /return source\.pipe\(brotli\)/)
  assert.match(exportSource, /const stage = createCompressedBackupStage\(\s*filePath,\s*MAX_COMPRESSED_STAGING_BYTES\s*\)/)
  assert.match(exportSource, /createCompressedBackupStageReadStream\(\s*prepared\.dataPath\s*\)/)
  assert.match(pageSource, /BROTLI-BOUNDED TEMP STAGING \/ STREAMED JSON UPLOAD/)
  assert.doesNotMatch(pageSource, /GZIP-BOUNDED TEMP STAGING/)
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
