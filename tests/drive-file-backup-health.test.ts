import assert from "node:assert/strict"
import test from "node:test"
import {
  driveBackupDeadlineForChange,
  evaluateDriveFileBackupHealth,
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

test("new uploads wait until the next 02:00 snapshot's 06:00 Hong Kong deadline", () => {
  assert.equal(driveBackupDeadlineForChange(date(todayStart)), date("2026-09-22T22:00:00Z"))
  assert.equal(driveBackupDeadlineForChange(date("2026-09-22T18:00:00.001Z")), date("2026-09-23T22:00:00Z"))
  const newFile = { ...oldFile, id: "new", name: "New map.png", createdAt: "2026-09-23T01:00:00Z", updatedAt: "2026-09-23T01:00:00Z" }
  const result = check("2026-09-23T02:00:00Z", [manifest()], [oldFile, newFile])
  assert.equal(result.status, "ok")
  assert.equal(result.details.pendingFiles, 1)
  assert.equal(result.details.missingFiles, 0)
  assert.equal(result.details.notificationEligible, false)
  assert.match(result.message, /pending/)
  const overdue = check("2026-09-23T22:00:00Z", [manifest("2026-09-23T18:00:00Z", "2026-09-23T18:10:00Z")], [oldFile, newFile])
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
  const deadline = check("2026-09-22T22:00:00Z", [running, manifest(yesterdayStart, yesterdayFinish)])
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

test("completed failed backup after the deadline cannot use an earlier success as recovery", () => {
  const failed = { ...manifest("2026-09-22T23:00:00Z", "2026-09-22T23:10:00Z"), status: "failed" }
  const result = check("2026-09-23T00:30:00Z", [failed, manifest()])
  assert.equal(result.details.notificationEligible, true)
  assert.equal(result.details.incidentResolved, false)
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

test("malformed latest evidence and no manifest are actionable rather than successful", () => {
  assert.equal(check("2026-09-23T00:30:00Z", []).details.incidentResolved, false)
  const result = check("2026-09-23T00:30:00Z", [{ generatedAt: "bad" }, manifest()])
  assert.equal(result.details.notificationEligible, true)
  assert.equal(result.details.incidentResolved, false)
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
