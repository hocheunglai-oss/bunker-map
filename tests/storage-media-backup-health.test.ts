import assert from "node:assert/strict"
import test from "node:test"
import { createHash } from "node:crypto"
import { Readable } from "node:stream"
import { readFileSync } from "node:fs"
import type { drive_v3 } from "googleapis"
import { fcunoConnectionPolicy } from "../config/fcunoConnections"
import { recurringInventorySha256, recurringMediaScope } from "../lib/storageMediaRecurring.mjs"
import { buildStorageMediaHealthReceipt, encodeStorageMediaHealthReceipt, validateStorageMediaHealthReceipt,
  STORAGE_MEDIA_HEALTH_SCHEMA, STORAGE_MEDIA_HEALTH_PREFIX, STORAGE_MEDIA_HEALTH_MAX_BYTES } from "../lib/storageMediaBackupHealth.mjs"
import { selectStorageMediaHealthFile } from "../lib/storageMediaBackupHealth.mjs"
import { evaluateStorageMediaBackupHealth, readStorageMediaHealthReceipt, type StorageMediaInventoryStatus } from "../lib/storageMediaBackupHealthService"
import { buildHealthAlertHtml, healthAlertObservation } from "../lib/systemHealthAlerts"

const scope = fcunoConnectionPolicy.storageMediaBackup
const activatedAt = "2026-10-25T08:00:00.000Z"
const now = Date.parse("2026-10-26T00:00:00.000Z")
const runtime = { enabled: "1", activatedAt }
const source = { bucket: scope.sourceBucket, path: "private/media-one.mp4", id: "object-one", version: "version-one", sizeBytes: 16 }
function manifest(day = "25", objects = [source]) {
  const startedAt = `2026-10-${day}T18:00:00.000Z`, finishedAt = `2026-10-${day}T18:05:00.000Z`
  return {
    schema: "fcuno.storage-media-daily/v2", status: "succeeded", scope: recurringMediaScope(), runId: `run-${day}`,
    snapshot: { inventorySha256: recurringInventorySha256(objects), windowStartsAt: startedAt, windowExpiresAt: `2026-10-${day}T22:00:00.000Z` },
    inventory: objects, copies: objects.map((item, index) => ({ source: item,
      target: { bucket: scope.targetBucket, objectName: `${scope.targetPrefix}/daily/runs/run-${day}/objects/${String(index).padStart(64, "a")}`, generation: "100" },
      byteSha256: "b".repeat(64), sizeBytes: item.sizeBytes, crc32c: "AAAAAA==", verifiedAt: `2026-10-${day}T18:04:00.000Z`,
    })), startedAt, finishedAt,
  }
}
function receipt(options: { state?: "succeeded" | "failed" | "budget-paused"; day?: string; success?: ReturnType<typeof manifest> | null; activatedAt?: string } = {}) {
  const state = options.state ?? "succeeded", success = options.success === undefined ? manifest(options.day) : options.success
  const latestAttempt = state === "succeeded"
    ? { runId: success!.runId, startedAt: success!.startedAt, finishedAt: success!.finishedAt, state, errorCode: null }
    : { runId: "later-attempt", startedAt: "2026-10-25T21:00:00.000Z", finishedAt: "2026-10-25T21:01:00.000Z", state, errorCode: "synthetic_reason" }
  return buildStorageMediaHealthReceipt({ activatedAt: options.activatedAt ?? activatedAt, publication: { fence: 1, owner: "synthetic-owner" }, latestAttempt, latestSuccess: success,
    budget: { state: state === "budget-paused" ? "paused" : "normal", checkedAt: latestAttempt.startedAt, projectedUsd: state === "budget-paused" ? 9.9 : null, limitUsd: 10 },
  }, { now })
}
function current(objects = [source], modifiedAt: string | null = "2026-10-25T17:00:00.000Z"): StorageMediaInventoryStatus {
  return { inventory: objects, modifiedAtByIdentity: objects.map(item => ({ id: item.id, version: item.version, modifiedAt })) }
}
function evaluate(overrides: Partial<Parameters<typeof evaluateStorageMediaBackupHealth>[0]> = {}) {
  return evaluateStorageMediaBackupHealth({ runtime, now, receipt: receipt(), inventoryStatus: current(), ...overrides })
}

test("strict complete current version coverage is healthy and resolves the incident", () => {
  const result = evaluate()
  assert.equal(result.status, "ok")
  assert.equal(result.details.coveredFiles, 1)
  assert.equal(result.details.incidentResolved, true)
  assert.equal(result.details.notificationEligible, false)
  assert.equal(healthAlertObservation({ ...result, id: "storage-media-backup", label: "Uploaded-file Backup", checkedAt: new Date(now).toISOString() }, false).alert_level, 0)
})

test("unactivated or invalid activation is unknown rather than green or an email", () => {
  for (const value of [{ enabled: "0", activatedAt }, { enabled: "1", activatedAt: "yesterday" }, { enabled: "1", activatedAt: "2027-01-01T00:00:00.000Z" }]) {
    const result = evaluate({ runtime: value })
    assert.equal(result.status, "warning")
    assert.equal(result.details.notificationEligible, false)
    assert.equal(result.details.incidentResolved, false)
  }
})

test("activation gets its first overnight window, not an immediate false failure", () => {
  const freshActivation = "2026-10-26T00:00:00.000Z"
  const result = evaluate({ runtime: { enabled: "1", activatedAt: freshActivation }, receipt: null })
  assert.equal(result.details.notificationEligible, false)
  assert.equal(result.details.incidentResolved, false)
  assert.match(result.message, /first verified cloud run is still pending/)
})

test("missing first success after the deadline alerts without pretending no files exist", () => {
  const result = evaluate({ receipt: null })
  assert.equal(result.status, "warning")
  assert.equal(result.details.notificationEligible, true)
  assert.equal(result.details.incidentResolved, false)
  assert.equal(result.details.activeFiles, 1)
})

test("new changes after the snapshot wait until the next deadline without clearing an incident", () => {
  const added = { ...source, id: "new-source", path: "new.mp4", version: "new-version" }
  const result = evaluate({ inventoryStatus: current([source, added], "2026-10-25T20:00:00.000Z") })
  assert.equal(result.details.notificationEligible, false)
  assert.equal(result.details.pendingFiles, 1)
  assert.equal(result.details.incidentResolved, false)
  assert.match(result.message, /waiting for the next overnight/)
})

test("equal counts cannot conceal a missing source, renamed path, or changed version", () => {
  for (const replacement of [{ ...source, id: "another-object" }, { ...source, path: "other.mp4" }, { ...source, version: "version-two" }, { ...source, sizeBytes: 17 }]) {
    const result = evaluate({ inventoryStatus: current([replacement]) })
    assert.equal(result.details.coveredFiles, 0)
    assert.equal(result.details.missingFiles, 1)
    assert.equal(result.details.notificationEligible, true)
  }
})

test("unreadable or incomplete current metadata never clears or invents an incident", () => {
  const result = evaluate({ inventoryStatus: null })
  assert.equal(result.details.protectionUnknown, true)
  assert.equal(result.details.notificationEligible, false)
  assert.equal(result.details.incidentResolved, false)
  assert.equal(evaluate({ evidenceReadable: false }).details.incidentResolved, false)
  const duplicate = current(); duplicate.modifiedAtByIdentity.push(duplicate.modifiedAtByIdentity[0])
  assert.equal(evaluate({ inventoryStatus: duplicate }).details.protectionUnknown, true)
})

test("unknown change time is unknown for uncovered objects, not misleading pending or recovery", () => {
  const changed = { ...source, version: "unknown-time-version" }
  const result = evaluate({ inventoryStatus: current([changed], null) })
  assert.equal(result.details.protectionUnknown, true)
  assert.equal(result.details.notificationEligible, false)
  assert.equal(result.details.incidentResolved, false)
  assert.equal(evaluate({ inventoryStatus: current([source], null) }).status, "ok", "an exact verified identity does not need a modification guess")
})

test("latest failed redundant attempt does not erase an already verified complete window", () => {
  assert.equal(evaluate({ receipt: receipt({ state: "failed" }) }).status, "ok")
})

test("budget pause is explicit, never success; overdue protection is still actionable", () => {
  const paused = evaluate({ receipt: receipt({ state: "budget-paused" }) })
  assert.equal(paused.status, "warning")
  assert.equal(paused.details.budgetState, "paused")
  assert.equal(paused.details.notificationEligible, false)
  assert.equal(paused.details.incidentResolved, false)
  const overdue = evaluate({ now: Date.parse("2026-10-27T00:00:00.000Z"), receipt: receipt({ state: "budget-paused" }) })
  assert.equal(overdue.details.notificationEligible, true)
  assert.match(overdue.message, /overdue.*paused/)
})

test("stale successful evidence alerts even if counts and every version still match", () => {
  const result = evaluate({ now: Date.parse("2026-10-27T00:00:00.000Z") })
  assert.equal(result.details.missingFiles, 0)
  assert.equal(result.details.notificationEligible, true)
  assert.match(result.message, /overnight.*not completed/)
  const escalated = evaluate({ now: Date.parse("2026-10-29T00:00:00.000Z") })
  assert.equal(escalated.status, "error")
  assert.equal(escalated.details.alertLevel, 2)
})

test("foreign scope, legacy one-time manifest, impossible or invalid copy evidence is untrusted", () => {
  const malformed = [
    (value: ReturnType<typeof receipt>) => { value.projectRef = "another-project" },
    (value: ReturnType<typeof receipt>) => { value.latestSuccess!.schema = "fcuno.storage-media-copy/v1" },
    (value: ReturnType<typeof receipt>) => { value.latestSuccess!.copies[0].byteSha256 = "not-a-digest" },
    (value: ReturnType<typeof receipt>) => { value.latestSuccess!.copies[0].target.bucket = "foreign-bucket" },
    (value: ReturnType<typeof receipt>) => { value.latestSuccess!.copies = [] },
    (value: ReturnType<typeof receipt>) => { value.activatedAt = "2026-10-25T08:00:01.000Z" },
    (value: ReturnType<typeof receipt>) => { value.latestAttempt.finishedAt = "2028-01-01T00:00:00.000Z" },
  ]
  for (const change of malformed) {
    const value = structuredClone(receipt()); change(value)
    const result = evaluate({ receipt: value })
    assert.equal(result.details.protectionUnknown, true)
    assert.equal(result.details.incidentResolved, false)
    assert.equal(result.details.notificationEligible, false)
  }
})

test("receipt encoder enforces exact fields, no accessor execution, budget state and byte limits", () => {
  const value = receipt()
  assert.deepEqual(validateStorageMediaHealthReceipt(JSON.parse(encodeStorageMediaHealthReceipt(value, { now }).toString()), { now }), value)
  assert.throws(() => validateStorageMediaHealthReceipt({ ...value, extra: "unexpected" }, { now }))
  assert.throws(() => validateStorageMediaHealthReceipt({ ...value, budget: { ...value.budget, state: "paused" } }, { now }))
  assert.throws(() => validateStorageMediaHealthReceipt({ ...value, retention: { mode: "dry-run", deletionsEnabled: true } }, { now }))
  const accessor = { ...value }
  Object.defineProperty(accessor, "latestSuccess", { enumerable: true, get() { assert.fail("accessor executed") } })
  assert.throws(() => validateStorageMediaHealthReceipt(accessor, { now }))
  assert.ok(encodeStorageMediaHealthReceipt(value, { now }).byteLength < STORAGE_MEDIA_HEALTH_MAX_BYTES)
})

test("publication fences defeat a late old upload and reject conflicting owners or incomplete old contracts", () => {
  const file = (fence: string, owner: string, finishedAt = "2026-10-25T18:05:00.000Z", sha = "a".repeat(64)) => ({
    id: `${fence}-${owner}`, appProperties: { backupSchema: STORAGE_MEDIA_HEALTH_SCHEMA, verified: "true", healthSha256: sha,
      publicationFence: fence, publicationOwner: owner, attemptFinishedAt: finishedAt },
  })
  const current = file("2", "new-owner")
  assert.equal(selectStorageMediaHealthFile([file("1", "old-owner"), current]).id, current.id)
  assert.equal(selectStorageMediaHealthFile([file("3", "current-owner"), file("3", "current-owner", "2026-10-25T19:05:00.000Z")]).appProperties.attemptFinishedAt, "2026-10-25T19:05:00.000Z")
  assert.throws(() => selectStorageMediaHealthFile([file("2", "one-owner"), file("2", "conflicting-owner")]))
  assert.throws(() => selectStorageMediaHealthFile([file("2", "one-owner"), file("2", "one-owner", undefined, "b".repeat(64))]))
  assert.throws(() => selectStorageMediaHealthFile([file("9007199254740999", "one-owner")]))
  assert.throws(() => selectStorageMediaHealthFile([{ appProperties: { verified: "true" } }]))
})

function fakeDrive(options: { bytes?: Buffer; hash?: string; size?: number; duplicateFolder?: boolean; properties?: Record<string, string>; createdTime?: string; chunk?: Uint8Array; signal?: AbortSignal } = {}) {
  const bytes = options.bytes ?? encodeStorageMediaHealthReceipt(receipt(), { now })
  let reads = 0, downloads = 0
  const queries: string[] = []
  const client = { files: {
    async list(params: { q: string }, request: { signal: AbortSignal }) {
      assert.ok(request.signal)
      queries.push(params.q); reads++
      if (reads < 3) return { data: { files: options.duplicateFolder ? [{ id: "one" }, { id: "two" }] : [{ id: reads === 1 ? "backup-root" : "media-manifests" }] } }
      return { data: { files: [{ id: "receipt-id", name: `${STORAGE_MEDIA_HEALTH_PREFIX}run.json`, size: String(options.size ?? bytes.byteLength),
        createdTime: options.createdTime ?? "2026-10-25T18:06:00.000Z", appProperties: options.properties ?? {
          backupSchema: STORAGE_MEDIA_HEALTH_SCHEMA, verified: "true", healthSha256: options.hash ?? createHash("sha256").update(bytes).digest("hex"),
          publicationFence: "1", publicationOwner: "synthetic-owner", attemptFinishedAt: "2026-10-25T18:05:00.000Z",
        } }] } }
    },
    async get(_: unknown, request: { signal: AbortSignal }) {
      assert.ok(request.signal); downloads++
      return { data: Readable.from([options.chunk ?? bytes]) }
    },
  } } as unknown as Pick<drive_v3.Drive, "files">
  return { client, queries, downloads: () => downloads }
}
function readReceipt(mock: ReturnType<typeof fakeDrive>, signal = new AbortController().signal) {
  return readStorageMediaHealthReceipt({ drive: mock.client, rootFolderId: "configured-parent", sharedDriveId: null, activatedAt, signal, now })
}

test("Drive reader authenticates the exact folder chain and checks full receipt bytes", async () => {
  const mock = fakeDrive()
  const value = await readReceipt(mock)
  assert.deepEqual(value, receipt())
  assert.match(mock.queries[0], /'configured-parent' in parents/)
  assert.match(mock.queries[1], /'backup-root' in parents/)
  assert.match(mock.queries[2], /'media-manifests' in parents/)
  assert.equal(mock.downloads(), 1)
})

test("Drive metadata, content, chronology, folder ambiguity and size limits fail closed", async () => {
  for (const options of [
    { hash: "0".repeat(64) }, { bytes: Buffer.from("not json") }, { size: STORAGE_MEDIA_HEALTH_MAX_BYTES + 1 },
    { duplicateFolder: true }, { properties: { verified: "true", healthSha256: "f".repeat(64) } },
    { createdTime: "2026-10-25T18:01:00.000Z" }, { chunk: new Uint8Array(STORAGE_MEDIA_HEALTH_MAX_BYTES + 1) },
  ]) await assert.rejects(readReceipt(fakeDrive(options)))
  const controller = new AbortController(); controller.abort()
  await assert.rejects(readReceipt(fakeDrive(), controller.signal))
})

test("media alert is simple and contains no private object path, hash, technical receipt or budget dump", () => {
  const result = evaluate({ receipt: null })
  const check = { ...result, id: "storage-media-backup", label: "Uploaded-file Backup", checkedAt: new Date(now).toISOString() }
  const html = buildHealthAlertHtml([check], check.checkedAt)
  assert.match(html, /Last verified backup: Not verified/)
  assert.match(html, /Next step:/)
  assert.doesNotMatch(html, /private\/media-one|version-one|object-one|healthSha256|<table/)
  assert.equal(healthAlertObservation(check, false).check_id, "storage-media-backup")
  assert.equal(healthAlertObservation({ ...check, ...evaluate({ evidenceReadable: false }) }, false).alert_level, null)
})

test("System Health uses only read-only inventory and existing Drive credentials with bounded requests", () => {
  const sourceText = readFileSync(new URL("../lib/systemHealth.ts", import.meta.url), "utf8")
  const check = sourceText.slice(sourceText.indexOf("async function checkStorageMediaBackup()"), sourceText.indexOf("async function checkGoogleCalendar()"))
  assert.match(check, /readCurrentStorageMediaInventoryStatus\(storage, signal\)/)
  assert.match(check, /getOAuthClient\("GOOGLE_DRIVE_REFRESH_TOKEN"\)/)
  assert.match(check, /AbortSignal\.timeout\(40_000\)/)
  assert.doesNotMatch(check, /\.from\([^)]*\)\.(?:insert|update|delete)|gcs|GCLOUD|GOOGLE_APPLICATION_CREDENTIALS/i)
  assert.match(sourceText, /runCheck\("storage-media-backup", "Uploaded-file Backup", checkStorageMediaBackup, 45_000\)/)
})
