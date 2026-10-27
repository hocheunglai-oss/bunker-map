import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import test from "node:test"
import { transformSync } from "esbuild"
import * as policy from "../lib/backupProtectionPolicy"
import * as files from "../lib/driveFileBackupHealth"
import * as pricing from "../lib/backupPricingSchema.mjs"
import * as attendanceSchema from "../lib/backupAttendanceSchema.mjs"
import * as mediaHealth from "../lib/storageMediaBackupHealthService"
import * as mediaSource from "../lib/storageMediaBackupSource"
import * as connections from "../config/fcunoConnections"
import * as attendanceExceptions from "../lib/attendanceAutoConfirmPolicy"
import * as attendanceRules from "../lib/attendanceRules"
import type { HealthCheckResult, SystemHealth } from "../lib/systemHealth"

function fixture(options: { active?: boolean; driveError?: boolean; verified?: Record<string, unknown>; inventory?: Record<string, unknown>; corrupt?: boolean; readFailure?: boolean } = {}) {
  const now = Date.now()
  const createdAt = new Date(now - 60_000).toISOString()
  const migration = "20261015073258"
  const catalog = "c".repeat(64)
  const receipt = { id: "synthetic-receipt", name: "bunker-map-backup-2026-10-15T00-00-00-000Z.json", createdTime: createdAt,
    mimeType: "application/json", appProperties: { backupSchema: "bunker-map-backup/v2", verificationStatus: "complete", verificationContract: "bunker-map-backup-stream-verification/v1" } }
  const verified = { migrationHead: migration, verificationContract: "bunker-map-backup-stream-verification/v1", inventorySha256: createHash("sha256").update("[]").digest("hex"),
    catalogSha256: catalog, liveTableCount: 0, previousVerifiedBackup: null, generatedAt: new Date(now - 120_000).toISOString(), deploymentCommit: "d".repeat(40), ...options.verified }
  const drive = { files: { async list(input: { q: string }) {
    if (options.driveError) throw Error("Synthetic Drive transport outage")
    if (input.q.includes("mimeType = 'application/vnd.google-apps.folder'")) return { data: { files: [{ id: "synthetic-folder" }] } }
    return { data: { files: options.verified ? [receipt] : [] } }
  }, async get() { throw Error("Synthetic transport read failed") } } }
  const query = (table: string) => {
    const result = { data: options.active && table === "cc_company_files" ? [{ id: "source-row", drive_file_id: "private-drive-file-id", file_name: "Synthetic file.png", created_at: new Date(now - 5 * 86_400_000).toISOString(), updated_at: new Date(now - 5 * 86_400_000).toISOString() }] : [], error: null, count: 0 }
    const chain: unknown = new Proxy({}, { get(_target, name) { return name === "then" ? Promise.resolve(result).then.bind(Promise.resolve(result)) : () => chain } })
    return chain
  }
  const modules: Record<string, unknown> = {
    "node:crypto": { createHash }, "@supabase/supabase-js": { createClient: () => ({ from: query, rpc: async () => ({ data: {}, error: null }) }) },
    "@/lib/emailNotice": { getEmailNoticeConfigStatus: () => ({ missing: [] }) },
    "@/lib/googleApis": { loadGoogleApis: async () => ({ google: { drive: () => drive, auth: { OAuth2: class { setCredentials() {} } } } }) },
    "@/lib/driveFileBackupHealth": files, "@/lib/backupProtectionPolicy": policy, "@/lib/backupPricingSchema.mjs": pricing,
    "@/lib/backupAttendanceSchema.mjs": attendanceSchema,
    "@/lib/storageMediaBackupHealthService": mediaHealth, "@/lib/storageMediaBackupSource": mediaSource,
    "@/config/fcunoConnections": connections,
    "@/lib/attendanceAutoConfirmPolicy": attendanceExceptions, "@/lib/attendanceRules": attendanceRules,
  }
  const loaded = { exports: {} as { getSystemHealth(options?: { backupGapObserver?: policy.BackupGapObserver }): Promise<SystemHealth>; fixture: {
    checkDriveBackup(observer?: policy.BackupGapObserver): Promise<HealthCheckResult>
    checkDriveFileContentBackup(observer?: policy.BackupGapObserver): Promise<HealthCheckResult>
    readDriveFileBytes(drive: unknown, id: string): Promise<unknown>
    BackupEvidenceReadError: typeof Error
  } } }
  let code = transformSync(readFileSync(new URL("../lib/systemHealth.ts", import.meta.url), "utf8"), { loader: "ts", format: "cjs", target: "node24" }).code
  code += `\nverifyStreamedBackupFile = async () => { if (fixtureOptions.readFailure) throw new BackupEvidenceReadError(); if (fixtureOptions.corrupt) throw Error('Confirmed checksum mismatch'); return fixtureVerified; };\ngetCurrentBackupInventory = async () => fixtureInventory;\nmodule.exports.fixture = { checkDriveBackup, checkDriveFileContentBackup, readDriveFileBytes, BackupEvidenceReadError };`
  new Function("require", "module", "exports", "process", "fixtureOptions", "fixtureVerified", "fixtureInventory", "fetch", code)(
    (name: string) => { assert.ok(name in modules, name); return modules[name] }, loaded, loaded.exports,
    { env: { NEXT_PUBLIC_SUPABASE_URL: "https://fixture.invalid", SUPABASE_SERVICE_ROLE_KEY: "synthetic-only", GOOGLE_OAUTH_CLIENT_ID: "synthetic-only", GOOGLE_OAUTH_CLIENT_SECRET: "synthetic-only", GOOGLE_DRIVE_REFRESH_TOKEN: "synthetic-only", GOOGLE_DRIVE_COMPANY_FOLDER_ID: "synthetic-only" } },
    options, verified, { migrationHead: migration, catalogSha256: catalog, liveTables: [], ...options.inventory }, () => assert.fail("No live network in health fixture"),
  )
  return loaded.exports
}

const recordObserver = () => {
  const calls: policy.BackupGapObservation[] = []
  const observer: policy.BackupGapObserver = async (input) => { calls.push(input); return { schema: "fcuno.backup-protection-gaps/v1", domain: input.domain, accepted: true, observedAt: input.observedAt,
    gaps: input.gaps.map((gap) => ({ key: gap.key, firstUncoveredAt: input.observedAt, firstDueAt: gap.dueAt })) } }
  return { observer, calls }
}

test("normal System Health get remains read-only without an observer", async () => {
  const f = fixture()
  const health = await f.getSystemHealth()
  assert.equal(health.checks.length, 13)
  assert.equal(health.checks.find((check) => check.id === "storage-media-backup")?.details?.notificationEligible, false)
  assert.equal(health.checks.find((check) => check.id === "backup")?.details?.notificationEligible, true)
  assert.doesNotMatch(JSON.stringify(health), /firstUncoveredAt|firstDueAt|fcuno.backup-protection-gaps/)
})

test("actual file health sends only hashed sparse gaps to the injected observer", async () => {
  const f = fixture({ active: true }), o = recordObserver()
  const result = await f.fixture.checkDriveFileContentBackup(o.observer)
  assert.equal(result.details?.missingFiles, 1)
  assert.equal(o.calls.length, 1)
  assert.equal(o.calls[0].domain, "drive-file")
  assert.equal(o.calls[0].complete, true)
  assert.ok(o.calls[0].gaps.some((gap) => gap.key === createHash("sha256").update("private-drive-file-id").digest("hex")))
  assert.doesNotMatch(JSON.stringify(o.calls), /private-drive-file-id|Synthetic file/)
  assert.doesNotMatch(JSON.stringify(result), /firstUncoveredAt|firstDueAt/)
})

test("missing database evidence records availability without clearing unknown inventory state", async () => {
  const f = fixture(), o = recordObserver()
  await f.fixture.checkDriveBackup(o.observer)
  assert.equal(o.calls[0].domain, "database")
  assert.equal(o.calls[0].complete, false)
  assert.deepEqual(o.calls[0].gaps.map((gap) => gap.key), ["availability"])
})

test("verified schema mismatch records required and covered fingerprints, never a guessed apply date", async () => {
  const f = fixture({ verified: { migrationHead: "20261014082839", catalogSha256: "a".repeat(64) } }), o = recordObserver()
  const result = await f.fixture.checkDriveBackup(o.observer)
  const gap = o.calls[0].gaps.find((item) => item.key === "inventory")!
  assert.equal(gap.requiredVersion, "20261015073258")
  assert.equal(gap.requiredFingerprint, "c".repeat(64))
  assert.equal(gap.coveredVersion, "20261014082839")
  assert.equal(gap.coveredFingerprint, "a".repeat(64))
  assert.equal(result.details?.notificationEligible, false)
  assert.equal(result.details?.incidentResolved, false)
})

test("confirmed checksum failure alerts, transport failure preserves unknown state without claiming corruption", async () => {
  for (const readFailure of [false, true]) {
    const f = fixture({ verified: {}, corrupt: !readFailure, readFailure }), o = recordObserver()
    const result = await f.fixture.checkDriveBackup(o.observer)
    assert.equal(result.status, readFailure ? "warning" : "error")
    assert.equal(result.details?.notificationEligible, !readFailure)
    assert.equal(result.details?.incidentResolved, false)
    assert.equal(o.calls[0].complete, false)
    if (readFailure) assert.doesNotMatch(result.message, /failed|corrupt|lost/i)
  }
  const f = fixture()
  await assert.rejects(() => f.fixture.readDriveFileBytes({ files: { get: async () => { throw Error("Network outage") } } }, "synthetic"), f.fixture.BackupEvidenceReadError)
})

test("typed durable observer failure escapes runCheck and aborts the whole notification health result", async () => {
  const f = fixture()
  await assert.rejects(() => f.getSystemHealth({ backupGapObserver: async () => { throw new policy.BackupProtectionObservationError() } }), policy.BackupProtectionObservationError)
})

test("transport outage observes unknown without clearing clocks; no-hook calls remain compatible", async () => {
  const f = fixture({ active: true, driveError: true }), o = recordObserver()
  const health = await f.getSystemHealth({ backupGapObserver: o.observer })
  for (const domain of ["database", "drive-file"]) assert.ok(o.calls.some((call) => call.domain === domain && !call.complete && call.gaps.length === 0))
  const backup = health.checks.find((check) => check.id === "backup")!
  assert.equal(backup.details?.protectionUnknown, true)
  assert.equal(backup.details?.notificationEligible, false)
})
