import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import vm from "node:vm"
import ts from "typescript"
import { fcunoConnectionPolicy } from "../config/fcunoConnections"
import { isTechStackResponse, isPhonebookServerConfiguration } from "../lib/techStackClient"
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
  assert.match(pageSource, /THAT OLD RULE DID NOT GUARANTEE 30 DAYS OF ROLLBACK HISTORY/)
  assert.match(pageSource, /GCS HISTORICAL POLICY — VERIFIED 2026-09-23:[\s\S]*AT THAT DATE THE DELETE RULE USED AGE 30 DAYS AND NONCURRENT STATUS/)
  assert.match(pageSource, /GCS RETENTION CONFIGURATION — RECHECKED 2026-10-26: NO AUTOMATIC LIFECYCLE DELETION; THE PREVIOUS DELETE RULE WAS REMOVED/)
  assert.match(pageSource, /VERSIONING, ENFORCED PUBLIC-ACCESS PREVENTION, UNIFORM BUCKET-LEVEL ACCESS AND SEVEN-DAY SOFT DELETE WERE PRESERVED/)
  assert.match(pageSource, /DATED BUCKET-METADATA EVIDENCE, NOT A LIVE BUCKET QUERY, A NEW FILE-BYTE CHECK OR A SUCCESSFUL BACKUP RUN/)
  assert.doesNotMatch(pageSource, /DELETE RULE IS AGE 30 DAYS AND NONCURRENT/)
  assert.match(pageSource, /DATED RECORD, NOT A LIVE AZURE QUERY/)
  assert.match(pageSource, /THIS IS NOT AN INFRASTRUCTURE VERIFICATION TIME/)
  assert.match(pageSource, /THIS PAGE DOES NOT CERTIFY ROLLOUT COMPLETION/)
  assert.match(pageSource, /A CLOUD RUN SPEND CAP DOES NOT CAP STORAGE CHARGES/)
  assert.match(pageSource, /AT THAT DATE, THE SEPARATE CLOUD RUN MONTHLY SPEND CAP HKD77\.50 WAS CONFIGURED, NOT ENFORCED/)
  assert.match(pageSource, /THIS DATED CAP CHECK IS SEPARATE FROM THE NEW OPTIONAL-WORK BUDGET GUARD ABOVE/)
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

const serverConfiguration = () => ({
  hostname: "server.example.test",
  deployment: { environment: "production", commit: "a".repeat(40) },
  connectivity: "not_checked", checkedAt: "2026-10-26T06:00:00.000Z",
})

test("Phonebook configuration parser accepts only hostname and explicit unchecked provenance", () => {
  for (const hostname of ["server.example.test", "192.0.2.1", "[2001:db8::1]", "xn--bcher-kva.example", "server.example.test."]) {
    for (const environment of ["production", "preview", "development", null]) {
      assert.equal(isPhonebookServerConfiguration({ ...serverConfiguration(), hostname,
        deployment: { environment, commit: null } }), true, hostname)
    }
  }
  assert.equal(isPhonebookServerConfiguration(serverConfiguration()), true)
})

test("Phonebook configuration parser rejects raw URLs, paths, ports, credentials and malformed hosts", () => {
  for (const hostname of ["https://server.example.test/addressbook", "name:password@server.example.test", "server.example.test:443",
    "server.example.test/path", "server.example.test?secret=value", "server.example.test#fragment", "server.example.test\n",
    "SERVER.example.test", "bücher.example", ".", "-server.example.test", "server..example.test", "server.example.test/", "[::1]:443", "x".repeat(254)]) {
    assert.equal(isPhonebookServerConfiguration({ ...serverConfiguration(), hostname }), false, hostname)
  }
})

test("Phonebook configuration parser fails closed on extra fields and invalid deployment or timestamps", () => {
  for (const value of [null, [], {}, { ...serverConfiguration(), password: "never-render-this" },
    { ...serverConfiguration(), deployment: { environment: "production", commit: "a".repeat(40), url: "never-render-this" } },
    ...[undefined, "Production", "unknown", 1, {}].map(environment => ({ ...serverConfiguration(), deployment: { environment, commit: null } })),
    ...[undefined, "a".repeat(7), "A".repeat(40), 1, {}].map(commit => ({ ...serverConfiguration(), deployment: { environment: null, commit } })),
    ...["checked", "healthy", null, true].map(connectivity => ({ ...serverConfiguration(), connectivity })),
    ...["not-a-date", "2026-02-31T06:00:00.000Z", "2026-10-26", "2026-10-26T06:00:00Z", "2026-10-26T06:00:00.000+00:00", null].map(checkedAt => ({ ...serverConfiguration(), checkedAt })),
  ]) assert.equal(isPhonebookServerConfiguration(value), false, JSON.stringify(value))
})

test("Tech Stack and recovery docs distinguish the verified one-time media snapshot from recurring backup and full recovery", () => {
  const implementation = readFileSync(new URL("../docs/storage-media-backup-source-implementation.md", import.meta.url), "utf8")
  const restoreRunbook = readFileSync(new URL("../docs/backup-restore-runbook.md", import.meta.url), "utf8")
  assert.match(pageSource, /PRESENTATION MEDIA — VERIFIED 2026-10-21/)
  assert.match(pageSource, /ONE-TIME PRIVATE GOOGLE CLOUD STORAGE COPY OF ALL 15 FILES \(224,309,367 BYTES\)/)
  assert.match(pageSource, /TWO READ-BACK CHECKS MATCHED THE COPIED BYTES/)
  assert.match(pageSource, /AT THAT DATE, TEMPORARY SOURCE ACCESS WAS OFF AND NO RECURRING MEDIA BACKUP WAS SCHEDULED/)
  assert.match(pageSource, /AT THAT DATE, DATABASE-TO-FILE CORRESPONDENCE AND HISTORICAL FILE-VERSION RECOVERY HAD NOT BEEN VERIFIED/)
  assert.doesNotMatch(pageSource, /DATABASE-TO-FILE BYTE MATCHING AND HISTORICAL FILE-VERSION RECOVERY REMAIN UNPROVED/)
  assert.match(pageSource, /DATABASE-TO-FILE CORRESPONDENCE — VERIFIED 2026-10-23 AT 08:16 UTC/)
  assert.match(pageSource, /ALL 15 FILE IDENTITIES, VERSIONS AND SIZES \(224,309,367 BYTES\) RECORDED BY THE V9 LOGICAL DATABASE SNAPSHOT EXACTLY MATCHED THE INVENTORY OF THE IMMUTABLE COPIES BYTE-VERIFIED ON 2026-10-21/)
  assert.match(pageSource, /OFFLINE METADATA COMPARISON, NOT A NEW CLOUD AVAILABILITY CHECK OR STORAGE-BYTE RESTORE/)
  assert.match(pageSource, /OLDER DATABASE SNAPSHOTS, NEW UPLOADS AFTER V9 AND HISTORICAL FILE-VERSION RECOVERY REMAIN UNPROVED/)
  assert.match(pageSource, /THAT METADATA-ONLY CHECK DID NOT ADD RECURRING MEDIA BACKUP OR SYSTEM HEALTH MONITORING/)
  assert.doesNotMatch(pageSource, /WHOLE-DATABASE RESTORE AND HISTORICAL FILE-VERSION MATCHING REMAIN UNPROVED/)
  assert.match(pageSource, /THIS HISTORICAL SNAPSHOT IS NOT THE NEW RECURRING HEALTH RECEIPT/)
  assert.doesNotMatch(pageSource, /INDEPENDENT RECOVERY COVERAGE HAS NOT BEEN ESTABLISHED/)
  assert.match(implementation, /## Verified one-time rollout — 2026-10-21/)
  assert.match(implementation, /At the preparation stage, no activation values had been set/)
  assert.match(implementation, /2026-10-21T11:14:20\.572Z/)
  assert.match(implementation, /3bc8ed980232559f2a3d0832d09677b582b2f8f064918d150d5b1d161744bc04/)
  assert.match(implementation, /`historicalByteCorrespondence` remains `"unproved"`/)
  assert.match(restoreRunbook, /\*\*2026-10-21 follow-up:\*\*/)
  assert.match(restoreRunbook, /At that date, temporary source access was off, no recurring media\nbackup was scheduled/)
  assert.match(restoreRunbook, /not a whole-database restore or a timed recovery rehearsal/)
  assert.match(pageSource, /PRIVATE LOGICAL DATABASE REHEARSAL — COMPLETED 2026-10-23/)
  assert.match(pageSource, /126 FULL-TABLE FINGERPRINTS, ORIGINAL METADATA AND EIGHT SEQUENCE STATES MATCHED/)
  assert.match(pageSource, /NATIVE TLS ON BOTH SOURCE CONNECTION HOPS WAS VERIFIED/)
  assert.match(pageSource, /SOURCE ROLE COPIES REMAINED NOLOGIN; LOCAL POSTGRESQL 17\.11 WAS NOT A PRODUCTION UPGRADE/)
  assert.match(pageSource, /NOT A RECURRING POSTGRESQL BACKUP, MANAGED PHYSICAL\/PITR RESTORE, WHOLE HOSTED SUPABASE RECOVERY OR STORAGE-FILE RECOVERY/)
  assert.match(restoreRunbook, /## One-time private logical database rehearsal — 2026-10-23/)
  assert.match(restoreRunbook, /not a recurring\s+PostgreSQL backup/)
  assert.match(restoreRunbook, /not a production recovery-time guarantee/)
  assert.match(restoreRunbook, /\*\*2026-10-23 correspondence follow-up:\*\* at 08:16:09\.402 UTC/)
  assert.match(restoreRunbook, /all 15 recorded file identities, versions and sizes \(224,309,367 bytes\)\s+exactly matched the inventory/)
  assert.match(restoreRunbook, /not a new cloud-availability check, Storage-byte restoration, proof for older\s+database snapshots or uploads after V9, recurring media backup, managed\s+physical\/PITR recovery or a recovery-time guarantee/)
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
  const correspondence = evidence.followUpFileVersionCorrespondence
  assert.equal(correspondence.completedAt, "2026-10-23T08:16:09.402Z")
  assert.equal(correspondence.result, "exact-recorded-file-version-correspondence-verified")
  assert.equal(correspondence.databaseArchiveSha256, evidence.archive.sha256)
  assert.equal(correspondence.recordedObjects, 15)
  assert.equal(correspondence.recordedTotalBytes, 224_309_367)
  assert.equal(correspondence.recordedIdentitiesVersionsAndSizesMatch, true)
  assert.equal(correspondence.copyBytesVerifiedOn, "2026-10-21")
  assert.deepEqual(correspondence.copyByteChecks, ["SHA-256", "CRC32C"])
  assert.equal(correspondence.privateAcceptanceReceiptSha256, "e74270590e6785c47869872f95aec9c368a5b898113a48d9d1ac0ed6bc0efad1")
  assert.match(correspondence.stateAtLogicalRehearsalCompletion, /At 05:07:13\.579 UTC[\s\S]*follow-up completed later/)
  for (const field of ["newCloudAvailabilityCheck", "storageBytesRestored", "olderDatabaseSnapshotsVerified", "uploadsAfterV9Verified", "recurringMediaBackupEnabled", "managedPhysicalOrPitrRecovery", "productionRecoveryTimeGuarantee"]) {
    assert.equal(correspondence[field], false, field)
  }
  assert.match(evidence.remainingLimits.join(" "), /Historical file-version recovery, older database snapshots and uploads after V9 remain unproved/)
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

test("Tech Stack service summary separates recurring capability, dated uploaded-media snapshot and inactive weekly database copy", () => {
  assert.match(pageSource, /\["DRIVE FILE BACKUP", "GOOGLE CLOUD STORAGE"/)
  assert.match(pageSource, /\["UPLOADED MEDIA SNAPSHOT", "ONE-TIME SUPABASE STORAGE BYTE COPY", "GOOGLE CLOUD STORAGE", "DATED 2026-10-21; 15 FILES \/ 224,309,367 BYTES; HISTORICAL COPY, NOT RECURRING SUCCESS EVIDENCE"\]/)
  assert.match(pageSource, /\["UPLOADED MEDIA VERSION BACKUP", "SEPARATELY GATED OVERNIGHT COPIES \/ EXACT-GENERATION READBACK", "GOOGLE CLOUD STORAGE \/ SYSTEM HEALTH"/)
  assert.match(pageSource, /\["WEEKLY FULL DATABASE COPY", "PLANNED INDEPENDENT FULL POSTGRESQL EXPORT \/ FOUR VERIFIED WEEKS", "NOT ACTIVE"/)
  assert.match(pageSource, /PENDING A BACKUP-ONLY CONNECTION PROVEN UNABLE TO WRITE/)
  assert.match(pageSource, /CURRENT ACTIVATION AND VERIFIED RUN STATUS: \/ADMIN\/SYSTEMHEALTH; THIS REGISTER DOES NOT PROVE A FIRST OVERNIGHT SUCCESS/)
  assert.match(pageSource, /SYSTEM HEALTH CHECKS THE AUTHENTICATED RUN RECEIPT, CURRENT COVERAGE AND DEADLINES/)
  assert.match(pageSource, /UNKNOWN OR STALE BUDGET EVIDENCE, ACTUAL COSTS AT 90% OR A 100% FORECAST THRESHOLD PAUSE OPTIONAL COPYING/)
  assert.match(pageSource, /BILLING IS DELAYED, NOT AN EXACT USD10 SPENDING CAP/)
  assert.match(pageSource, /RETENTION IS DRY-RUN ONLY, WITH NO AUTOMATIC PRUNING/)
  assert.match(pageSource, /FOUR VERIFIED WEEKS ARE THE PLANNED RETENTION POLICY, NOT EXISTING RECOVERY POINTS/)
  assert.doesNotMatch(pageSource, /TEMPORARY SOURCE ACCESS IS OFF; NO RECURRING MEDIA BACKUP IS SCHEDULED|NOT RECURRING OR MONITORED BY SYSTEM HEALTH/)
  assert.match(pageSource, /<a href="\/admin\/systemhealth">SYSTEM HEALTH<\/a>/)
  assert.match(pageSource, /admin_role_defaults \(optional; office_calendar_store fallback\)/)
  const source = readFileSync(new URL("../lib/adminUsers.ts", import.meta.url), "utf8")
  assert.match(source, /supabase\.rpc\("read_admin_permission_groups"\)/)
  const groupSql = readFileSync(new URL("../supabase/migrations/20261022113511_atomic_admin_permission_groups.sql", import.meta.url), "utf8")
  assert.match(groupSql, /if pg_catalog\.to_regclass\('public\.admin_role_defaults'\) is not null then[\s\S]*?from public\.admin_role_defaults[\s\S]*?else[\s\S]*?from public\.office_calendar_store where key='admin-permission-groups'/)
  assert.match(groupSql, /'storage',case when pg_catalog\.to_regclass\('public\.admin_role_defaults'\) is null then 'shared-store' else 'table' end/)
})

test("Restore runbook adds gated recurring configuration without expanding historical recovery proof", () => {
  const runbook = readFileSync(new URL("../docs/backup-restore-runbook.md", import.meta.url), "utf8")
  const recurring = readFileSync(new URL("../docs/recurring-media-backup.md", import.meta.url), "utf8")
  assert.match(runbook, /## Separately gated recurring media capability — 2026-10-26/)
  assert.match(runbook, /additive configured capability, \*\*not proof of a first successful\novernight execution\*\*/)
  assert.match(runbook, /Check the current activation, verified run receipt,\ncurrent file coverage and deadline in System Health/)
  assert.match(runbook, /\[recurring-media-backup\.md\]\(recurring-media-backup\.md\)/)
  assert.match(runbook, /weekly independent full PostgreSQL copy is\n\*\*not active\*\*/)
  assert.match(runbook, /backup-only source connection must first be proven unable to\nwrite database data/)
  assert.match(runbook, /Four verified weeks are the planned retention, not recovery\npoints already available/)
  assert.match(runbook, /Retention remains\ndry-run only; no automatic pruning is enabled/)
  assert.match(runbook, /\*\*2026-10-26 bucket-configuration check\*\* removed the previous\nnoncurrent-object lifecycle Delete rule/)
  assert.match(runbook, /Metadata readback showed no automatic\nlifecycle deletion; versioning, enforced public-access prevention, uniform\nbucket-level access and seven-day soft-delete protection were preserved/)
  assert.match(runbook, /Existing copies were not deleted/)
  assert.match(recurring, /not proof of a first successful|not\*\* evidence of a completed execution|is \*\*not\*\* evidence of a completed execution/)
  assert.match(recurring, /Dated billing-calendar verification — 2026-10-26/)
  assert.match(recurring, /2026-10-26T10:54:15\.528Z/)
  assert.match(recurring, /costIntervalStart=2026-10-01T07:00:00Z/)
  assert.match(recurring, /not permanent\ndaylight-saving correctness or every future billing period/)
  assert.match(recurring, /Each future\nperiod must still match the configured local month boundary exactly/)
  assert.match(recurring, /not a job's durably committed budget control, real-time cost\nevidence, an exact spending cap or proof of an overnight file backup/)
  assert.doesNotMatch(recurring, /is a candidate, \*\*not yet a verified assertion\*\*/)
  assert.match(recurring, /no \*\*direct\*\* bucket, Drive or secret IAM grants/)
  assert.match(recurring, /\*\*trusted\nprivileged execution\*\* and can exercise the job's effective data-access\ncapabilities/)
  assert.match(recurring, /must not be described as unable to access data/)
  assert.match(recurring, /Create no user-managed keys and grant no new impersonation authority to other/)
  assert.match(recurring, /`15 2-5 \* \* \*` in `Asia\/Hong_Kong`: 02:15, 03:15, 04:15 and 05:15/)
  assert.match(recurring, /\*\*2,700 seconds \(45 minutes\) on every media\nattempt\*\*/)
  assert.match(recurring, /Preserve the existing Drive job's \*\*3,300-second default\*\* and its original\nscheduler/)
  assert.doesNotMatch(recurring, /has no bucket, Drive or secret access|`15 2 \* \* \*`/)
  assert.doesNotMatch(runbook, /temporary source access is off, no recurring media backup is\nscheduled/)
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
