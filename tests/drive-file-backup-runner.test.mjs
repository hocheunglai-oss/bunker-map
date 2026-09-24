import assert from "node:assert/strict"
import test from "node:test"
import { Readable, Writable } from "node:stream"
import {
  acquireBackupLease,
  alreadyCompletedWindow,
  backupOneFile,
  getBackupWindow,
  isVerifiedManifest,
  metadataMatches,
  publishSuccessfulManifest,
} from "../scripts/backup-google-drive-files-to-gcs.mjs"

test("Hong Kong backup window is 02:00 inclusive until 06:00 exclusive", () => {
  assert.equal(getBackupWindow(new Date("2026-09-22T17:59:59Z")).open, false)
  assert.equal(getBackupWindow(new Date("2026-09-22T18:00:00Z")).open, true)
  assert.equal(getBackupWindow(new Date("2026-09-22T21:59:59Z")).open, true)
  assert.equal(getBackupWindow(new Date("2026-09-22T22:00:00Z")).open, false)
  assert.equal(getBackupWindow(new Date("2026-09-22T18:00:00Z")).localDate, "2026-09-23")
})

function verifiedManifest() {
  return {
    schemaVersion: 2,
    runId: "run-id",
    fileName: "manifest.json",
    generatedAt: "2026-09-22T18:00:01Z",
    finishedAt: "2026-09-22T18:04:01Z",
    status: "succeeded",
    verification: { status: "verified", checkedFiles: 1, completedAt: "2026-09-22T18:04:01Z" },
    counts: { totalFiles: 1, failed: 0, uploaded: 0, skipped: 1 },
    files: [{ id: "drive-id", status: "skipped", reason: "Unchanged", objectName: "ccinfo-drive/files/test", generation: "123" }],
    failures: [],
    driveManifest: { id: "manifest-id", verifiedAt: "2026-09-22T18:04:03Z" },
  }
}

test("only a verified successful run published to Drive suppresses later nightly attempts", () => {
  const now = new Date("2026-09-22T19:00:00Z")
  const window = getBackupWindow(now)
  const manifest = verifiedManifest()
  assert.equal(alreadyCompletedWindow(manifest, window, now), true)
  for (const patch of [
    { status: "running" }, { status: "failed" }, { finishedAt: "" },
    { verification: { status: "verified", checkedFiles: 0, completedAt: manifest.finishedAt } },
    { counts: { totalFiles: 1, failed: 1 } }, { driveManifest: {} },
    { generatedAt: "2026-09-21T18:00:00Z" }, { finishedAt: "2026-09-22T20:00:00Z" },
    { files: [{ status: "skipped", reason: "Unsupported file type" }] },
  ]) assert.equal(alreadyCompletedWindow({ ...manifest, ...patch }, window, now), false)
  assert.equal(isVerifiedManifest({ ...manifest, files: [] }), false)
})

test("completion proof agrees with the health contract on IDs, skips, counts, and timestamp order", () => {
  const manifest = verifiedManifest()
  const now = Date.parse("2026-09-22T19:00:00Z")
  assert.equal(isVerifiedManifest(manifest, now), true)
  for (const filePatch of [{ id: "" }, { reason: "Unsupported type" }, { generation: "abc" }, { generation: 123 }, { objectName: " " }]) {
    assert.equal(isVerifiedManifest({ ...manifest, files: [{ ...manifest.files[0], ...filePatch }] }, now), false)
  }
  for (const patch of [
    { failures: [{ message: "still failed" }] },
    { generatedAt: "2026-09-22T18:05:00Z" },
    { finishedAt: "2026-09-22T20:00:00Z" },
    { verification: { ...manifest.verification, completedAt: "2026-09-22T18:05:00Z" } },
    { counts: { ...manifest.counts, skipped: 0 } },
    { counts: { ...manifest.counts, uploaded: -1, skipped: 2 } },
  ]) assert.equal(isVerifiedManifest({ ...manifest, ...patch }, now), false)
  assert.equal(isVerifiedManifest({
    ...manifest, counts: { ...manifest.counts, totalFiles: 2, skipped: 2 },
    verification: { ...manifest.verification, checkedFiles: 2 }, files: [manifest.files[0], manifest.files[0]],
  }, now), false)
  assert.equal(alreadyCompletedWindow({ ...manifest, driveManifest: { id: "manifest-id", verifiedAt: "2026-09-22T20:00:00Z" } }, getBackupWindow(new Date(now)), new Date(now)), false)
})

test("failed publication or mismatched readback cannot advance the last-successful pointer", async () => {
  for (const failure of ["write", "read", "wrong-run", "incomplete"]) {
    const savedNames = []
    const manifest = verifiedManifest()
    const bucket = { file: (name) => ({ save: async () => { savedNames.push(name) } }) }
    await assert.rejects(publishSuccessfulManifest({
      bucket, prefix: "ccinfo-drive", manifest,
      publishDrive: async () => {
        if (failure === "write") throw new Error("Drive unavailable")
        return { id: "manifest-id" }
      },
      readDrive: async () => {
        if (failure === "read") throw new Error("Drive read failed")
        if (failure === "wrong-run") return { ...manifest, runId: "different-run" }
        return { ...manifest, verification: { ...manifest.verification, status: "pending" } }
      },
    }))
    assert.equal(savedNames.includes("ccinfo-drive/manifests/latest-successful.json"), false)
  }
})

test("successful pointer advances only after the completed Drive manifest is read back", async () => {
  const events = []
  const manifest = verifiedManifest()
  const bucket = { file: (name) => ({ save: async (content) => { events.push(name); assert.ok(JSON.parse(content)) } }) }
  await publishSuccessfulManifest({
    bucket, prefix: "ccinfo-drive", manifest,
    publishDrive: async () => { events.push("publishDrive"); return { id: "manifest-id" } },
    readDrive: async () => { events.push("readDrive"); return manifest },
  })
  assert.deepEqual(events.slice(-3), ["publishDrive", "readDrive", "ccinfo-drive/manifests/latest-successful.json"])
})

const sourceFile = { id: "drive-id", modifiedTime: "2026-09-22T12:00:00Z", size: "4", md5Checksum: "098f6bcd4621d373cade4e832627b4f6", mimeType: "text/plain" }
function objectMetadata() {
  return {
    generation: "123", crc32c: "htZwIw==", size: "4", md5Hash: "CY9rzUYh03PK3k6DJie09g==",
    metadata: {
      driveFileId: sourceFile.id, driveModifiedTime: sourceFile.modifiedTime, driveSize: sourceFile.size,
      driveMd5Checksum: sourceFile.md5Checksum, driveMimeType: sourceFile.mimeType, downloadMode: "media",
    },
  }
}

test("unchanged object requires generation, CRC, matching size, and source MD5", () => {
  const metadata = objectMetadata()
  assert.equal(metadataMatches(metadata, sourceFile, { mode: "media" }), true)
  for (const patch of [{ generation: "" }, { crc32c: "" }, { size: "0" }, { md5Hash: "" }, { md5Hash: "ZmFrZQ==" }]) {
    assert.equal(metadataMatches({ ...metadata, ...patch }, sourceFile, { mode: "media" }), false)
  }
  assert.equal(metadataMatches(metadata, { ...sourceFile, modifiedTime: "2026-09-23T00:00:00Z" }, { mode: "media" }), false)
})

test("unchanged verified file is incremental and does not download", async () => {
  const result = await backupOneFile({
    drive: {}, prefix: "ccinfo-drive", force: false,
    file: { ...sourceFile, name: "test.txt", relativePath: "test.txt" },
    bucket: { file: () => ({ getMetadata: async () => [objectMetadata()] }) },
  })
  assert.equal(result.status, "skipped")
  assert.equal(result.reason, "Unchanged")
  assert.equal(result.generation, "123")
})

test("unsupported Workspace types cannot be reported as backed up", async () => {
  await assert.rejects(backupOneFile({
    drive: {}, bucket: {}, prefix: "ccinfo-drive", force: false,
    file: { id: "form", name: "Form", relativePath: "Form", mimeType: "application/vnd.google-apps.form" },
  }), /Unsupported Google Workspace/)
})

test("an uploaded object is not certified if its read-back metadata is missing or corrupt", async () => {
  for (const uploadedMetadata of [null, { ...objectMetadata(), size: "0" }, { ...objectMetadata(), generation: "" }]) {
    let reads = 0
    await assert.rejects(backupOneFile({
      drive: { files: { get: async () => ({ data: Readable.from(["test"]) }) } },
      prefix: "ccinfo-drive", force: false,
      file: { ...sourceFile, name: "test.txt", relativePath: "test.txt" },
      bucket: { file: () => ({
        getMetadata: async () => {
          if (++reads === 1 || !uploadedMetadata) throw Object.assign(new Error("missing"), { code: 404 })
          return [uploadedMetadata]
        },
        createWriteStream: (options) => {
          assert.equal(options.validation, "crc32c")
          return new Writable({ write: (_chunk, _encoding, callback) => callback() })
        },
      }) },
    }), /failed generation, checksum, size, or source metadata verification/)
  }
})

function fakeLeaseBucket(initial) {
  let metadata = initial
  let generation = 10
  const lock = {
    save: async (_content, options) => {
      assert.equal(options.preconditionOpts.ifGenerationMatch, 0)
      if (metadata) throw Object.assign(new Error("exists"), { code: 412 })
      metadata = { generation: String(++generation), ...options.metadata }
    },
    getMetadata: async () => {
      if (!metadata) throw Object.assign(new Error("missing"), { code: 404 })
      return [metadata]
    },
    delete: async (options) => {
      if (options.ifGenerationMatch !== metadata?.generation) throw Object.assign(new Error("changed"), { code: 412 })
      metadata = null
    },
  }
  return { file: () => lock, current: () => metadata }
}

test("atomic lease excludes concurrent runs and is released by its owner", async () => {
  const bucket = fakeLeaseBucket()
  const now = new Date("2026-09-22T18:00:00Z")
  const first = await acquireBackupLease(bucket, "ccinfo-drive", now)
  assert.ok(first)
  assert.equal(await acquireBackupLease(bucket, "ccinfo-drive", now), null)
  await first.release()
  assert.equal(bucket.current(), null)
  assert.ok(await acquireBackupLease(bucket, "ccinfo-drive", now))
})

test("expired lease can be reclaimed but unknown expiration fails closed", async () => {
  const now = new Date("2026-09-22T19:00:00Z")
  const expired = fakeLeaseBucket({ generation: "old", metadata: { expiresAt: "2026-09-22T18:56:00Z" } })
  assert.ok(await acquireBackupLease(expired, "ccinfo-drive", now))
  const unknown = fakeLeaseBucket({ generation: "old", metadata: {} })
  assert.equal(await acquireBackupLease(unknown, "ccinfo-drive", now), null)
})

test("an expired owner's release cannot delete a replacement lease", async () => {
  const bucket = fakeLeaseBucket()
  const first = await acquireBackupLease(bucket, "ccinfo-drive", new Date("2026-09-22T18:00:00Z"))
  const second = await acquireBackupLease(bucket, "ccinfo-drive", new Date("2026-09-22T19:00:00Z"))
  assert.ok(second)
  await first.release()
  assert.equal(bucket.current().metadata.runId, second.runId)
  await second.release()
  assert.equal(bucket.current(), null)
})
