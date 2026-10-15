import assert from "node:assert/strict"
import test from "node:test"
import {
  driveBackupDeadlineForChange,
  evaluateDriveFileBackupHealth,
  getDriveFileBackupGaps,
  hasDriveBackupObjectProof,
  isVerifiedDriveBackupManifest,
  type ActiveDriveBackupFile,
  type DriveBackupManifest,
} from "../lib/driveFileBackupHealth"

const date = (value: string) => Date.parse(value)
const oldFile: ActiveDriveBackupFile = {
  id: "existing", name: "Port map.png", createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z",
}
const todayStart = "2026-09-22T18:00:00Z" // September 23, 02:00 HKT
const todayFinish = "2026-09-22T18:10:00Z"
const yesterdayStart = "2026-09-21T18:00:00Z"
const yesterdayFinish = "2026-09-21T18:10:00Z"
function manifest(start = todayStart, finish = todayFinish, ids = [oldFile.id]): DriveBackupManifest {
  return {
    schemaVersion: 2, status: "succeeded", generatedAt: start, finishedAt: finish,
    verification: { status: "verified", checkedFiles: ids.length, completedAt: finish },
    counts: { totalFiles: ids.length, uploaded: 0, skipped: ids.length, failed: 0 },
    files: ids.map((id) => ({ id, status: "skipped", reason: "Unchanged", objectName: `files/${id}`, generation: "123" })),
    failures: [],
    gcs: { location: "US-CENTRAL1", freeTierStorageLimitBytes: 5 * 1024 ** 3 },
  }
}
const check = (now: string, manifests: DriveBackupManifest[], activeFiles = [oldFile]) =>
  evaluateDriveFileBackupHealth({ now: date(now), manifests, activeFiles })

test("new uploads wait until the next 02:00 snapshot plus06:15 publication grace", () => {
  assert.equal(driveBackupDeadlineForChange(date(todayStart)), date("2026-09-22T22:15:00Z"))
  assert.equal(driveBackupDeadlineForChange(date("2026-09-22T18:00:00.001Z")), date("2026-09-23T22:15:00Z"))
  const newFile = { ...oldFile, id: "new", name: "New map.png", createdAt: "2026-09-23T01:00:00Z", updatedAt: "2026-09-23T01:00:00Z" }
  const result = check("2026-09-23T02:00:00Z", [manifest()], [oldFile, newFile])
  assert.equal(result.status, "ok")
  assert.equal(result.details.pendingFiles, 1)
  assert.equal(result.details.missingFiles, 0)
  assert.equal(result.details.notificationEligible, false)
  assert.match(result.message, /pending/)
  const overdue = check("2026-09-23T22:15:00Z", [manifest("2026-09-23T18:00:00Z", "2026-09-23T18:10:00Z")], [oldFile, newFile])
  assert.equal(overdue.details.notificationEligible, true)
  assert.equal(overdue.details.missingFiles, 1)
  assert.equal(overdue.details.missingFileNames, "New map.png")
})

test("daily success stays quiet while the next run is within its retry window", () => {
  const running = { ...manifest(), status: "running", finishedAt: "", verification: { status: "pending" } }
  const result = check("2026-09-22T21:59:59Z", [running, manifest(yesterdayStart, yesterdayFinish)])
  assert.equal(result.status, "ok")
  assert.equal(result.details.notificationEligible, false)
  assert.equal(result.details.incidentResolved, false)
  assert.equal(result.details.lastSuccessfulBackupAt, "2026-09-21T18:10:00.000Z")
  const deadline = check("2026-09-22T22:15:00Z", [running, manifest(yesterdayStart, yesterdayFinish)])
  assert.equal(deadline.details.notificationEligible, true)
})

test("starting a new run does not mask yesterday's overdue backup", () => {
  const running = { ...manifest(), status: "running", finishedAt: "" }
  const result = check("2026-09-22T19:00:00Z", [running, manifest("2026-09-20T18:00:00Z", "2026-09-20T18:10:00Z")])
  assert.equal(result.details.notificationEligible, true)
  assert.equal(result.details.incidentResolved, false)
  assert.equal(result.details.alertLevel, 2)
})

test("48 hours without verified completion raises only the stable incident's severity", () => {
  const before = check("2026-09-23T18:09:59Z", [manifest(yesterdayStart, yesterdayFinish)])
  const after = check("2026-09-23T18:10:00Z", [manifest(yesterdayStart, yesterdayFinish)])
  assert.equal(before.details.alertLevel, 1)
  assert.equal(after.details.alertLevel, 2)
  assert.equal(before.details.alertKey, after.details.alertKey)
  assert.equal(after.status, "error")
})

test("unsupported skipped files and absent generation are not counted as protected", () => {
  assert.equal(hasDriveBackupObjectProof({ id: "x", status: "skipped", reason: "Unsupported Google Workspace file type" }), false)
  assert.equal(hasDriveBackupObjectProof({ id: "x", status: "uploaded", objectName: "files/x" }), false)
  const bad = manifest()
  bad.files = [{ id: oldFile.id, status: "skipped", reason: "Unsupported Google Workspace file type" }]
  const result = check("2026-09-23T00:30:00Z", [bad])
  assert.equal(result.details.coveredFiles, 0)
  assert.equal(result.details.missingFiles, 1)
  assert.equal(result.details.lastSuccessfulBackupAt, null)
  assert.equal(result.details.notificationEligible, true)
})

test("legacy manifests with complete object-generation evidence remain valid", () => {
  const legacy = manifest()
  delete legacy.schemaVersion
  delete legacy.status
  delete legacy.verification
  assert.equal(isVerifiedDriveBackupManifest(legacy, date("2026-09-23T00:30:00Z")), true)
  assert.equal(check("2026-09-23T00:30:00Z", [legacy]).status, "ok")
})

test("failed legacy file references cannot establish coverage or falsely recover a missing-file incident", () => {
  const missing = { ...oldFile, id: "missing", createdAt: "2026-09-21T19:00:00Z", updatedAt: "2026-09-21T19:00:00Z" }
  const current = manifest()
  const failedLegacy = manifest("2026-09-22T23:00:00Z", "2026-09-22T23:10:00Z", [oldFile.id, missing.id])
  delete failedLegacy.schemaVersion
  failedLegacy.status = "failed"
  failedLegacy.counts = { totalFiles: 2, uploaded: 0, skipped: 2, failed: 1 }
  failedLegacy.failures = [{ error: "Synthetic failed legacy attempt" }]
  const input = { now: date("2026-09-23T00:30:00Z"), activeFiles: [oldFile, missing], manifests: [failedLegacy, current] }
  const result = evaluateDriveFileBackupHealth(input)
  assert.equal(result.details.missingFiles, 1)
  assert.equal(result.details.coveredFiles, 1)
  assert.equal(result.details.notificationEligible, true)
  assert.equal(result.details.incidentResolved, false)
  assert.equal(getDriveFileBackupGaps(input).find((gap) => gap.fileId === missing.id)?.coveredThroughAt, undefined)

  const modernPartial = { ...failedLegacy, schemaVersion: 2 }
  const modern = evaluateDriveFileBackupHealth({ ...input, manifests: [modernPartial, current] })
  assert.equal(modern.details.missingFiles, 0)
  assert.equal(modern.details.notificationEligible, false)
  assert.equal(modern.details.incidentResolved, true)
})

test("new manifests require explicit verification, not only success or completed time", () => {
  for (const changes of [
    { verification: { status: "pending" } },
    { status: "running" },
    { status: "failed" },
    { finishedAt: "" },
    { schemaVersion: 3 },
    { counts: { totalFiles: 2, uploaded: 0, skipped: 1, failed: 0 } },
    { counts: { totalFiles: 1, uploaded: 0, skipped: 1, failed: 1 } },
  ]) {
    assert.equal(isVerifiedDriveBackupManifest({ ...manifest(), ...changes }, date("2026-09-23T00:30:00Z")), false)
  }
})

test("later failed manual attempt does not invalidate sufficient verified current-cycle protection", () => {
  const failed = { ...manifest("2026-09-22T23:00:00Z", "2026-09-22T23:10:00Z"), status: "failed" }
  const result = check("2026-09-23T00:30:00Z", [failed, manifest()])
  assert.equal(result.details.notificationEligible, false)
  assert.equal(result.details.incidentResolved, true)
  assert.equal(result.details.lastSuccessfulBackupAt, "2026-09-22T18:10:00.000Z")
})

test("new verified completion closes an incident but only when eligible files are covered", () => {
  const result = check("2026-09-23T00:30:00Z", [manifest()])
  assert.equal(result.details.notificationEligible, false)
  assert.equal(result.details.incidentResolved, true)
})

test("changed file IDs require a snapshot after their update, not old membership", () => {
  const changed = { ...oldFile, updatedAt: "2026-09-23T01:00:00Z" }
  const result = check("2026-09-23T02:00:00Z", [manifest()], [changed])
  assert.equal(result.details.coveredFiles, 0)
  assert.equal(result.details.pendingFiles, 1)
})

test("duplicate references count once and retain the latest update", () => {
  const result = check("2026-09-23T02:00:00Z", [manifest()], [oldFile, { ...oldFile, updatedAt: "2026-09-23T01:00:00Z" }])
  assert.equal(result.details.activeFiles, 1)
  assert.equal(result.details.pendingFiles, 1)
})

test("missing protection is actionable, but malformed later metadata does not invalidate sufficient verified proof", () => {
  assert.equal(check("2026-09-23T00:30:00Z", []).details.incidentResolved, false)
  const result = check("2026-09-23T00:30:00Z", [{ generatedAt: "bad" }, manifest()])
  assert.equal(result.details.notificationEligible, false)
  assert.equal(result.details.incidentResolved, true)
})

test("September 16 evidence plus a September 17 upload is genuinely overdue on September 23", () => {
  const uploaded = {
    id: "port-map", name: "KAOHSIUNG Port map.png",
    createdAt: "2026-09-17T07:57:07.804Z", updatedAt: "2026-09-17T07:57:07.804Z",
  }
  const result = check("2026-09-23T00:31:31.701Z", [manifest("2026-09-16T00:02:08.099Z", "2026-09-16T00:03:07.143Z")], [oldFile, uploaded])
  assert.equal(result.details.coveredFiles, 1)
  assert.equal(result.details.missingFiles, 1)
  assert.equal(result.details.pendingFiles, 0)
  assert.equal(result.details.missingFileNames, "KAOHSIUNG Port map.png")
  assert.equal(result.details.alertLevel, 2)
  assert.equal(result.details.notificationEligible, true)
})

test("storage advice stays visible and quiet without preventing verified protection recovery", () => {
  const full = manifest()
  full.counts = { ...(full.counts as object), estimatedCurrentStorageBytes: 4.25 * 1024 ** 3 }
  const result = check("2026-09-23T00:30:00Z", [full])
  assert.equal(result.status, "warning")
  assert.equal(result.details.freeTierUsedPercent, 85)
  assert.equal(result.details.storageAdvice, true)
  assert.equal(result.details.notificationEligible, false)
  assert.equal(result.details.incidentResolved, true)
  assert.equal(result.details.alertKey, "drive-file-content-protection")
})

test("missing file escalates48h after its own deadline even with fresh successful global manifests", () => {
  const missing = { ...oldFile, id: "missing", createdAt: "2026-09-23T01:00:00Z", updatedAt: "2026-09-23T01:00:00Z" }
  const start = "2026-09-25T18:00:00Z", finish = "2026-09-25T18:10:00Z"
  const before = check("2026-09-25T22:14:59.999Z", [manifest(start, finish)], [oldFile, missing])
  const exact = check("2026-09-25T22:15:00.000Z", [manifest(start, finish)], [oldFile, missing])
  assert.equal(before.details.alertLevel, 1)
  assert.equal(exact.details.alertLevel, 2)
  assert.equal(exact.status, "error")
  assert.equal(exact.details.missingFiles, 1)
  assert.equal(exact.details.lastSuccessfulBackupAt, finish.replace("Z", ".000Z"))
})

test("later edits without intervening verified proof cannot postpone an established missing-file deadline", () => {
  const edited = { ...oldFile, id: "missing", createdAt: "2026-09-23T01:00:00Z", updatedAt: "2026-09-25T23:00:00Z" }
  const input = { now: date("2026-09-26T00:30:00Z"), manifests: [manifest("2026-09-25T18:00:00Z", "2026-09-25T18:10:00Z")], activeFiles: [oldFile, edited] }
  assert.equal(evaluateDriveFileBackupHealth(input).details.pendingFiles, 1)
  const persisted = evaluateDriveFileBackupHealth({ ...input, firstDueByFileId: new Map([[edited.id, date("2026-09-23T22:15:00Z")]]) })
  assert.equal(persisted.details.pendingFiles, 0)
  assert.equal(persisted.details.missingFiles, 1)
  assert.equal(persisted.details.alertLevel, 2)
})

test("verified overnight protection then a new morning edit carries reset proof and remains legitimately pending", () => {
  const edited = { ...oldFile, updatedAt: "2026-09-23T00:00:00Z" }
  const input = { now: date("2026-09-23T00:30:00Z"), manifests: [manifest()], activeFiles: [edited] }
  const gaps = getDriveFileBackupGaps(input)
  assert.deepEqual(gaps, [{ fileId: oldFile.id, dueAt: "2026-09-23T22:15:00.000Z", requiredSinceAt: "2026-09-23T00:00:00.000Z", coveredThroughAt: "2026-09-22T18:00:00.000Z" }])
  const result = evaluateDriveFileBackupHealth({ ...input, firstDueByFileId: new Map([[oldFile.id, date(gaps[0].dueAt)]]) })
  assert.equal(result.details.pendingFiles, 1)
  assert.equal(result.details.notificationEligible, false)
  assert.equal(result.details.incidentResolved, true)
  const failed = { ...manifest(), status: "failed" }
  assert.equal(getDriveFileBackupGaps({ ...input, manifests: [failed] })[0].coveredThroughAt, "2026-09-22T18:00:00.000Z")
  assert.equal(evaluateDriveFileBackupHealth({ ...input, manifests: [failed] }).details.incidentResolved, false)
  assert.equal(getDriveFileBackupGaps({ ...input, manifests: [{ ...failed, schemaVersion: 3 }] })[0].coveredThroughAt, undefined)
})

test("new installation with only not-yet-due files does not invent a missed backup", () => {
  const newFile = { ...oldFile, createdAt: "2026-09-23T01:00:00Z", updatedAt: "2026-09-23T01:00:00Z" }
  const result = check("2026-09-23T02:00:00Z", [], [newFile])
  assert.equal(result.details.pendingFiles, 1)
  assert.equal(result.details.notificationEligible, false)
  assert.equal(result.details.incidentResolved, false)
})
