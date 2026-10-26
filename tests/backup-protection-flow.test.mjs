import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import test from "node:test"
import { transformSync } from "esbuild"
import { gapFixtureSql, h1, h2, c1, c2 } from "./fixtures/backup-protection-gaps-sql.mjs"
import * as pricing from "../lib/backupPricingSchema.mjs"
import * as mediaHealth from "../lib/storageMediaBackupHealthService.ts"
import * as mediaSource from "../lib/storageMediaBackupSource.ts"
import * as attendanceExceptions from "../lib/attendanceAutoConfirmPolicy.ts"
import * as attendanceRules from "../lib/attendanceRules.ts"

// Required local PostgreSQL runtime: fail clearly if missing, never contact a
// hosted database or quietly skip the notification/clock integration boundary.
const { PGlite } = await import(process.env.PGLITE_MODULE_PATH || "@electric-sql/pglite")
function load(relative, modules = {}, environment = {}) {
  const loaded = { exports: {} }
  const code = transformSync(readFileSync(new URL(`../${relative}`, import.meta.url), "utf8"), { loader: "ts", format: "cjs", target: "node24" }).code
  new Function("require", "module", "exports", "process", code)(name => { assert.ok(name in modules, name); return modules[name] }, loaded, loaded.exports, { env: environment })
  return loaded.exports
}
const policy = load("lib/backupProtectionPolicy.ts")
const files = load("lib/driveFileBackupHealth.ts", { "./backupProtectionPolicy": policy })
const config = load("config/fcunoConnections.ts")
const alerts = load("lib/systemHealthAlerts.ts", { "@/config/fcunoConnections": config })
const key = id => createHash("sha256").update(id).digest("hex")
const day = 86_400_000
const at = value => Date.parse(value)
const original = { id: "synthetic-existing", name: "Original.png", createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" }
function manifest(date, ids = [original.id], status = "succeeded") {
  const generatedAt = `${date}T02:00:00+08:00`, finishedAt = `${date}T02:10:00+08:00`
  return { schemaVersion: 2, status, generatedAt, finishedAt,
    verification: { status: "verified", checkedFiles: ids.length, completedAt: finishedAt },
    counts: { totalFiles: ids.length, uploaded: 0, skipped: ids.length, failed: 0, estimatedCurrentStorageBytes: 4.25 * 1024 ** 3 },
    files: ids.map(id => ({ id, status: "skipped", reason: "Unchanged", objectName: `synthetic/${id}`, generation: "123" })), failures: [],
    gcs: { location: "US-CENTRAL1", freeTierStorageLimitBytes: 5 * 1024 ** 3 } }
}

// Execute the ACTUAL health evidence-fetch and policy assembly, not a second
// copy of its orchestration. Google/Supabase data transports are synthetic;
// the injected preview/reconcile callback below executes real isolated SQL.
function actualFileHealth(activeFiles, manifests, now, observer) {
  const downloads = []
  const drive = { files: {
    async list(input) {
      if (input.q.includes("mimeType = 'application/vnd.google-apps.folder'")) return { data: { files: [{ id: "synthetic-folder" }] } }
      assert.equal(input.pageSize, 10)
      return { data: { files: manifests.slice(0, 10).map((_manifest, index) => ({ id: `manifest-${index}`, name: `manifest-${index}.json`, createdTime: new Date(now - index).toISOString() })) } }
    },
    async get(input) {
      downloads.push(input.fileId)
      const index = Number(input.fileId.replace("manifest-", ""))
      if (manifests[index]?.syntheticReadFailure) throw Error("Synthetic historical manifest transport outage")
      const bytes = Buffer.from(JSON.stringify(manifests[index]))
      return { data: (async function* () { yield bytes })() }
    },
  } }
  const query = table => {
    const rows = table === "cc_company_files" ? activeFiles.map((file, index) => ({ id: `synthetic-row-${index}`, drive_file_id: file.id, file_name: file.name, created_at: file.createdAt, updated_at: file.updatedAt })) : []
    const result = Promise.resolve({ data: rows, error: null })
    const chain = new Proxy({}, { get(_target, property) { return property === "then" ? result.then.bind(result) : () => chain } })
    return chain
  }
  const modules = {
    "node:crypto": { createHash }, "@supabase/supabase-js": { createClient: () => ({ from: query }) },
    "@/lib/emailNotice": { getEmailNoticeConfigStatus: () => ({ missing: [] }) },
    "@/lib/googleApis": { loadGoogleApis: async () => ({ google: { drive: () => drive, auth: { OAuth2: class { setCredentials() {} } } } }) },
    "@/lib/driveFileBackupHealth": files, "@/lib/backupProtectionPolicy": policy, "@/lib/backupPricingSchema.mjs": pricing,
    "@/lib/storageMediaBackupHealthService": mediaHealth, "@/lib/storageMediaBackupSource": mediaSource,
    "@/config/fcunoConnections": config,
    "@/lib/attendanceAutoConfirmPolicy": attendanceExceptions, "@/lib/attendanceRules": attendanceRules,
  }
  const loaded = { exports: {} }
  const code = transformSync(readFileSync(new URL("../lib/systemHealth.ts", import.meta.url), "utf8"), { loader: "ts", format: "cjs", target: "node24" }).code
    + "\nmodule.exports.fileCheck = checkDriveFileContentBackup;"
  class FixtureDate extends Date { constructor(value) { super(value === undefined ? now : value) } static now() { return now } }
  new Function("require", "module", "exports", "process", "Date", "fetch", code)(name => { assert.ok(name in modules, name); return modules[name] }, loaded, loaded.exports,
    { env: { NEXT_PUBLIC_SUPABASE_URL: "https://fixture.invalid", SUPABASE_SERVICE_ROLE_KEY: "synthetic-only", GOOGLE_OAUTH_CLIENT_ID: "synthetic-only", GOOGLE_OAUTH_CLIENT_SECRET: "synthetic-only", GOOGLE_DRIVE_REFRESH_TOKEN: "synthetic-only", GOOGLE_DRIVE_COMPANY_FOLDER_ID: "synthetic-only" } }, FixtureDate, () => assert.fail("No live network in actual-health fixture"))
  return { downloads, run: () => loaded.exports.fileCheck(observer) }
}

test("actual protection policy, validated gap observer and SQL alert delivery work together", async t => {
  const db = new PGlite()
  try {
    await db.exec(gapFixtureSql())
    await db.exec(readFileSync(new URL("../supabase/migrations/20260924022019_system_health_alert_incidents.sql", import.meta.url), "utf8"))
    await db.exec("set role service_role")
    const gapFactories = load("lib/backupProtectionGapStore.ts", {
      "server-only": {}, "@/config/fcunoConnections": config, "@/lib/backupProtectionPolicy": policy,
      "@supabase/supabase-js": { createClient: () => ({ rpc(name, args) {
        assert.ok(["reconcile_backup_protection_gaps", "preview_backup_protection_gaps"].includes(name))
        return { async abortSignal() {
          try {
            const result = await db.query(`select public.${name}($1,$2::timestamptz,$3::jsonb,$4::boolean) as result`, [args.p_domain, args.p_observed_at, JSON.stringify(args.p_gaps), args.p_complete])
            return { data: result.rows[0].result, error: null }
          } catch (error) { return { data: null, error } }
        } }
      } }) },
    }, { NEXT_PUBLIC_SUPABASE_URL: `https://${config.fcunoConnectionPolicy.supabase.projectRef}.supabase.co`, SUPABASE_SERVICE_ROLE_KEY: "synthetic-only-key" })
    const store = gapFactories.createBackupProtectionGapObserver()
    const preview = gapFactories.createBackupProtectionGapPreviewObserver()
    const reset = async () => { await db.exec("reset role; truncate private.backup_protection_gaps, private.backup_protection_observations, private.system_health_alert_incidents; set role service_role") }
    const stateSnapshot = async () => (await db.query(`select jsonb_build_object(
      'observations',(select coalesce(jsonb_agg(to_jsonb(t) order by domain),'[]'::jsonb) from private.backup_protection_observations t),
      'gaps',(select coalesce(jsonb_agg(to_jsonb(t) order by domain,gap_key),'[]'::jsonb) from private.backup_protection_gaps t),
      'incidents',(select coalesce(jsonb_agg(to_jsonb(t) order by check_id,recipient_key),'[]'::jsonb) from private.system_health_alert_incidents t)
    ) as state`)).rows[0].state
    const observedFiles = async (activeFiles, manifests, now) => {
      const gaps = files.getDriveFileBackupGaps({ activeFiles, manifests, now })
      const saved = await store({ domain: "drive-file", observedAt: new Date(now).toISOString(), complete: true,
        gaps: gaps.map(({ fileId, ...gap }) => ({ ...gap, key: fileId === null ? "schedule" : key(fileId) })) })
      const byKey = new Map(saved.gaps.map(gap => [gap.key, at(gap.firstDueAt)]))
      return files.evaluateDriveFileBackupHealth({ activeFiles, manifests, now, firstScheduleDueAt: byKey.get("schedule"),
        firstDueByFileId: new Map(activeFiles.flatMap(file => byKey.has(key(file.id)) ? [[file.id, byKey.get(key(file.id))]] : [])) })
    }
    const recipient = "a".repeat(64)
    const deliveryStore = {
      async claim(observations, token) { return (await db.query("select public.claim_system_health_alerts($1::jsonb,$2::uuid,$3) as result", [JSON.stringify(observations), token, recipient])).rows[0].result },
      async finish(token, delivered) { await db.query("select public.finish_system_health_alerts($1::uuid,$2::boolean)", [token, delivered]) },
    }

    await t.test("legacy capacity notice cannot hide new file protection warning or its own48h escalation", async () => {
      await reset()
      const base = at("2026-09-23T08:30:00+08:00")
      const token = randomUUID()
      await deliveryStore.claim([{ check_id: "drive-file-content-backup", alert_level: 1, observed_at: new Date(base - 60_000).toISOString() }], token)
      await deliveryStore.finish(token, true)
      let sends = 0
      const send = async result => alerts.deliverHealthAlerts({ checks: [{ id: "drive-file-content-backup", label: "File backups", checkedAt: new Date(result.now).toISOString(), ...result.health }],
        muted: () => false, token: randomUUID(), store: deliveryStore, send: async () => { sends++ } })
      const healthy = await observedFiles([original], [manifest("2026-09-23")], base)
      assert.equal(healthy.details.storageAdvice, true)
      await send({ now: base, health: healthy })
      assert.equal(sends, 0)
      const missing = { ...original, id: "synthetic-missing", createdAt: "2026-09-22T07:00:00+08:00", updatedAt: "2026-09-22T07:00:00+08:00" }
      const warning = await observedFiles([original, missing], [manifest("2026-09-23")], base + 60_000)
      assert.equal(warning.details.alertLevel, 1)
      await send({ now: base + 60_000, health: warning })
      assert.equal(sends, 1)
      const again = await observedFiles([original, missing], [manifest("2026-09-24")], base + day)
      await send({ now: base + day, health: again })
      assert.equal(sends, 1)
      const edited = { ...missing, updatedAt: "2026-09-25T07:00:00+08:00" }
      const escalated = await observedFiles([original, edited], [manifest("2026-09-25")], base + 2 * day)
      assert.equal(escalated.details.alertLevel, 2)
      await send({ now: base + 2 * day, health: escalated })
      assert.equal(sends, 2)
    })

    await t.test("failed legacy references cannot clear clocks or re-arm delivery; supported v2 individual proof can recover", async () => {
      await reset()
      const base = at("2026-09-23T08:30:00+08:00")
      const missing = { ...original, id: "synthetic-missing", createdAt: "2026-09-22T07:00:00+08:00", updatedAt: "2026-09-22T07:00:00+08:00" }
      const current = manifest("2026-09-23")
      let sends = 0
      const send = async (health, now) => alerts.deliverHealthAlerts({ checks: [{ id: "drive-file-content-backup", label: "File backups", checkedAt: new Date(now).toISOString(), ...health }],
        muted: () => false, token: randomUUID(), store: deliveryStore, send: async () => { sends++ } })
      const incidentState = async () => (await db.query("select incident_open,notified_level from private.system_health_alert_incidents where check_id='drive-file-content-protection' and recipient_key=$1", [recipient])).rows[0]
      const gapState = async () => (await db.query("select first_due_at,first_uncovered_at from private.backup_protection_gaps where domain='drive-file' and gap_key=$1", [key(missing.id)])).rows
      const initial = await observedFiles([original, missing], [current], base)
      assert.equal(initial.details.notificationEligible, true)
      await send(initial, base)
      assert.equal(sends, 1)
      const originalClock = await gapState()

      const failedLegacy = { ...manifest("2026-09-23", [original.id, missing.id], "failed"),
        generatedAt: "2026-09-23T07:00:00+08:00", finishedAt: "2026-09-23T07:10:00+08:00",
        counts: { totalFiles: 2, uploaded: 0, skipped: 2, failed: 1 }, failures: [{ error: "Synthetic legacy failure" }] }
      delete failedLegacy.schemaVersion
      const legacy = await observedFiles([original, missing], [failedLegacy, current], base + 60_000)
      assert.equal(legacy.details.missingFiles, 1)
      assert.equal(legacy.details.incidentResolved, false)
      await send(legacy, base + 60_000)
      assert.equal(sends, 1, "legacy failure cannot close and re-arm a fresh duplicate warning")
      assert.deepEqual(await gapState(), originalClock)
      assert.deepEqual(await incidentState(), { incident_open: true, notified_level: 1 })

      const modernPartial = { ...failedLegacy, schemaVersion: 2, counts: { totalFiles: 3, uploaded: 0, skipped: 2, failed: 1 } }
      const modern = await observedFiles([original, missing], [modernPartial, current], base + 120_000)
      assert.equal(modern.details.missingFiles, 0)
      assert.equal(modern.details.incidentResolved, true)
      await send(modern, base + 120_000)
      assert.equal(sends, 1)
      assert.deepEqual(await gapState(), [])
      assert.deepEqual(await incidentState(), { incident_open: false, notified_level: 0 })

      const nextVersion = { ...missing, updatedAt: "2026-09-23T07:30:00+08:00" }
      const nextMissing = await observedFiles([original, nextVersion], [manifest("2026-09-24"), modernPartial], base + day)
      assert.equal(nextMissing.details.missingFiles, 1)
      await send(nextMissing, base + day)
      assert.equal(sends, 2, "only genuine verified recovery permits a later new incident notice")
    })

    await t.test("late-published proof retires the old file version before a legitimately pending new edit", async () => {
      await reset()
      const firstTime = at("2026-09-23T08:30:00+08:00")
      const edited = { ...original, updatedAt: "2026-09-23T07:00:00+08:00" }
      await observedFiles([edited], [manifest("2026-09-23")], firstTime)
      // This verified manual snapshot existed before first observation but its
      // publication/read visibility was delayed. It covers the07:00 version.
      const late = { ...manifest("2026-09-23"), generatedAt: "2026-09-23T08:00:00+08:00", finishedAt: "2026-09-23T08:10:00+08:00",
        verification: { status: "verified", checkedFiles: 1, completedAt: "2026-09-23T08:10:00+08:00" } }
      const newEdit = { ...edited, updatedAt: "2026-09-24T08:00:00+08:00" }
      const result = await observedFiles([newEdit], [manifest("2026-09-24", []), late], firstTime + day)
      assert.equal(result.details.pendingFiles, 1)
      assert.equal(result.details.missingFiles, 0)
      assert.equal(result.details.notificationEligible, false)
      assert.equal(result.details.incidentResolved, true)
      const clock = (await db.query("select first_due_at from private.backup_protection_gaps where gap_key=$1", [key(original.id)])).rows[0]
      assert.equal(at(clock.first_due_at), at("2026-09-25T06:15:00+08:00"))
    })

    await t.test("late schema1 proof allows a new schema2 grace period; merely newer old-catalog proof does not", async () => {
      for (const covers of [true, false]) {
        await reset()
        const first = at("2026-09-23T08:30:00+08:00")
        await store({ domain: "database", observedAt: new Date(first).toISOString(), complete: true,
          gaps: [{ key: "inventory", dueAt: "2026-09-24T06:15:00+08:00", requiredVersion: h1, requiredFingerprint: c1 }] })
        const observation = { domain: "database", observedAt: new Date(first + day).toISOString(), complete: true,
          gaps: [{ key: "inventory", dueAt: "2026-09-25T06:15:00+08:00", requiredVersion: h2, requiredFingerprint: c2,
            coveredThroughAt: "2026-09-23T08:00:00+08:00", coveredVersion: h1, coveredFingerprint: covers ? c1 : "d".repeat(64) }] }
        const before = await stateSnapshot()
        const projection = await preview(observation)
        assert.deepEqual(await stateSnapshot(), before)
        const proof = await store(observation)
        assert.deepEqual(projection, proof)
        const result = policy.evaluateDatabaseBackupProtection({ now: first + day, receiptCreatedAt: "2026-09-24T03:10:00+08:00", inventoryCurrent: false, gaps: proof.gaps })
        assert.equal(result.details.notificationEligible, !covers)
        assert.equal(result.details.incidentResolved, false)
        assert.equal(at(proof.gaps[0].firstDueAt), at(covers ? "2026-09-25T06:15:00+08:00" : "2026-09-24T06:15:00+08:00"))
      }
    })

    await t.test("actual health pipeline shows persisted overdue file status equally under preview and notify", async () => {
      await reset()
      const first = at("2026-09-23T08:30:00+08:00")
      const missing = { ...original, id: "synthetic-missing", createdAt: "2026-09-22T07:00:00+08:00", updatedAt: "2026-09-22T07:00:00+08:00" }
      await observedFiles([original, missing], [manifest("2026-09-23")], first)
      const edited = { ...missing, updatedAt: "2026-09-25T07:00:00+08:00" }
      const now = first + 2 * day
      const input = [[original, edited], [manifest("2026-09-25")], now]
      const before = await stateSnapshot()
      const dashboard = await actualFileHealth(...input, preview).run()
      assert.deepEqual(await stateSnapshot(), before)
      assert.equal(dashboard.status, "error")
      assert.equal(dashboard.details.missingFiles, 1)
      assert.equal(dashboard.details.pendingFiles, 0)
      const notification = await actualFileHealth(...input, store).run()
      assert.deepEqual(dashboard, notification)
      assert.doesNotMatch(JSON.stringify(dashboard), /requiredSinceAt|firstUncoveredAt|firstDueAt|synthetic-missing/)
    })

    await t.test("actual health fetches older late-published proof and projects a new edit as pending without writes", async () => {
      await reset()
      const first = at("2026-09-23T08:30:00+08:00")
      const changed = { ...original, updatedAt: "2026-09-23T07:00:00+08:00" }
      await observedFiles([changed], [manifest("2026-09-23")], first)
      const late = { ...manifest("2026-09-23"), generatedAt: "2026-09-23T08:00:00+08:00", finishedAt: "2026-09-23T08:10:00+08:00",
        verification: { status: "verified", checkedFiles: 1, completedAt: "2026-09-23T08:10:00+08:00" } }
      const edited = { ...changed, updatedAt: "2026-09-24T08:00:00+08:00" }
      const input = [[edited], [manifest("2026-09-24", []), late], first + day]
      const before = await stateSnapshot()
      const dashboardFixture = actualFileHealth(...input, preview)
      const dashboard = await dashboardFixture.run()
      assert.deepEqual(dashboardFixture.downloads, ["manifest-0", "manifest-1"], "must not stop on global verification before finding needed per-file proof")
      assert.deepEqual(await stateSnapshot(), before)
      assert.equal(dashboard.details.pendingFiles, 1)
      assert.equal(dashboard.details.missingFiles, 0)
      assert.equal(dashboard.details.notificationEligible, false)
      assert.equal(dashboard.details.incidentResolved, true)
      assert.deepEqual(await actualFileHealth(...input, store).run(), dashboard)
    })

    await t.test("actual read-only healthy path downloads one manifest; missing proof reads at most ten", async () => {
      await reset()
      const now = at("2026-09-25T08:30:00+08:00")
      const before = await stateSnapshot()
      const healthy = actualFileHealth([original], Array.from({ length: 13 }, () => manifest("2026-09-25")), now, preview)
      assert.equal((await healthy.run()).details.incidentResolved, true)
      assert.deepEqual(healthy.downloads, ["manifest-0"])
      assert.deepEqual(await stateSnapshot(), before, "healthy GET must not even create an operational parent")
      const missing = { ...original, id: "synthetic-missing" }
      const limited = actualFileHealth([original, missing], Array.from({ length: 13 }, () => manifest("2026-09-25")), now, preview)
      assert.equal((await limited.run()).details.missingFiles, 1)
      assert.equal(limited.downloads.length, 10)
      assert.equal(new Set(limited.downloads).size, 10)
      assert.deepEqual(await stateSnapshot(), before)
      const unnamed = actualFileHealth([{ ...missing, name: "" }], [manifest("2026-09-25")], now, preview)
      const unnamedResult = await unnamed.run()
      assert.equal(unnamedResult.details.missingFileNames, "Unnamed file")
      assert.doesNotMatch(JSON.stringify(unnamedResult), /synthetic-missing/)
      assert.deepEqual(await stateSnapshot(), before)
    })

    await t.test("required older-proof read outage is unknown, preserves clocks and cannot send a missing-backup alert", async () => {
      await reset()
      const first = at("2026-09-24T08:30:00+08:00")
      const changed = { ...original, updatedAt: "2026-09-23T07:00:00+08:00" }
      await observedFiles([changed], [manifest("2026-09-24", [])], first)
      const input = [[changed], [manifest("2026-09-25", []), { ...manifest("2026-09-24"), syntheticReadFailure: true }], first + day]
      const before = await stateSnapshot()
      const dashboard = await actualFileHealth(...input, preview).run()
      assert.equal(dashboard.details.protectionUnknown, true)
      assert.equal(dashboard.details.notificationEligible, false)
      assert.equal(dashboard.details.incidentResolved, false)
      assert.equal(dashboard.details.manifestReadErrors, 1)
      assert.doesNotMatch(dashboard.message, /failed|missing|lost|corrupt/i)
      assert.deepEqual(await stateSnapshot(), before, "read-only unknown projection does not change private state")
      const observations = []
      const recordingObserver = async observation => { observations.push(observation); return store(observation) }
      const notification = await actualFileHealth(...input, recordingObserver).run()
      assert.deepEqual(notification, dashboard)
      assert.equal(observations.length, 1)
      assert.equal(observations[0].complete, false)
      assert.deepEqual(observations[0].gaps, [])
      assert.deepEqual((await stateSnapshot()).gaps, before.gaps, "unknown history cannot retire or postpone an established clock")
      await alerts.deliverHealthAlerts({ checks: [{ id: "drive-file-content-backup", label: "File backups", checkedAt: new Date(first + day).toISOString(), ...notification }],
        muted: () => false, token: randomUUID(), store: deliveryStore, send: async () => assert.fail("Unreadable required history is not a missing-backup email") })
    })

    await t.test("irrelevant older read outage does not invalidate sufficient verified due-cycle protection", async () => {
      await reset()
      const now = at("2026-09-25T08:30:00+08:00")
      const laterPartial = { ...manifest("2026-09-25", [original.id], "failed"), generatedAt: "2026-09-25T05:00:00+08:00", finishedAt: "2026-09-25T05:10:00+08:00" }
      const evidence = [laterPartial, manifest("2026-09-25"), { ...manifest("2026-09-24"), syntheticReadFailure: true }]
      const before = await stateSnapshot()
      const dashboard = await actualFileHealth([original], evidence, now, preview).run()
      assert.equal(dashboard.details.manifestReadErrors, 1)
      assert.equal(dashboard.details.notificationEligible, false)
      assert.equal(dashboard.details.incidentResolved, true)
      assert.notEqual(dashboard.details.protectionUnknown, true)
      assert.deepEqual(await stateSnapshot(), before)
      assert.deepEqual(await actualFileHealth([original], evidence, now, store).run(), dashboard)
    })
  } finally { await db.close() }
})
