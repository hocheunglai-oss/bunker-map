import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"
import { fcunoConnectionPolicy } from "../config/fcunoConnections.ts"
import { runStorageMediaBackup } from "../scripts/lib/storage-media-run.mjs"
import { measureByteStream } from "../lib/storageMediaBackup.mjs"

const policy = fcunoConnectionPolicy.storageMediaBackup
const sha = value => createHash("sha256").update(value).digest("hex")
const inventory = Array.from({ length: 15 }, (_, index) => ({ bucket: policy.sourceBucket, path: `opaque/file-${index}`,
  id: `object-${index}`, version: `version-${index}`, sizeBytes: index === 14 ? policy.approvedTotalBytes - 14 * 9 : 9 }))
const zeros = Buffer.alloc(64 * 1024)
async function* bytes(size) { for (let remaining = size; remaining > 0;) { const width = Math.min(zeros.length, remaining); yield zeros.subarray(0, width); remaining -= width } }
const crcTable = Array.from({ length: 256 }, (_, index) => { let crc = index; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0x82f63b78 : 0); return crc >>> 0 })
const cachedCrc = new Map()
function zeroCrc(size) {
  if (cachedCrc.has(size)) return cachedCrc.get(size)
  let crc = 0xffffffff
  for (let index = 0; index < size; index++) crc = ((crc >>> 8) ^ crcTable[crc & 255]) >>> 0
  const out = Buffer.alloc(4); out.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
  const encoded = out.toString("base64"); cachedCrc.set(size, encoded); return encoded
}
function fixture(options = {}) {
  let generation = 0, control = null, inventoryReads = 0, pairChecks = 0
  const now = Date.now, controller = new AbortController(), context = { signal: controller.signal, deadline: now() + 3_300_000, now }
  const events = [], objects = new Map(), runId = "offline-snapshot-run"
  const rawFiles = [0, 1].map(index => {
    const rows = [{ id: `chunk-${index}`, video_path: inventory[index].path, video_bytes: 9, narration_path: null, narration_bytes: 0 }]
    const raw = Buffer.from(JSON.stringify({ schemaVersion: 2, data: { auditLogs: [{ ignored: true }], spcPresentationChunks: rows },
      integrity: { artifactSha256: String(index + 1).repeat(64), sections: { spcPresentationChunks: { rowCount: 1, sha256: sha(JSON.stringify(rows)) } },
        truth: { checkpointAfterExport: { headSequence: index + 1, headSha256: String(index + 3).repeat(64), checkpointValid: true } } } }))
    return { fileId: `drive-${index}`, uploadedFileSha256: sha(raw), fileByteLength: raw.length, artifactSha256: String(index + 1).repeat(64), raw }
  })
  const source = {
    async inventory() { inventoryReads++; if (options.changedInventory && inventoryReads >= 2) return inventory.map((item, index) => index === 0 ? { ...item, version: "changed" } : { ...item }); return structuredClone(inventory) },
    async inspectSource(identity) { events.push("source-inspect"); if (options.changedSource) return { ...identity, version: "changed" }; return structuredClone(identity) },
    async openSource(identity) { return { identity: structuredClone(identity), bytes: bytes(identity.sizeBytes) } },
  }
  const retained = {
    async readRetainedPair() { events.push("select-pair"); return { files: rawFiles } },
    async openRetainedArtifact(file) {
      events.push("open-retained")
      const raw = options.wrongReceipt ? Buffer.concat([file.raw, Buffer.from(" ")]) : file.raw
      return { bytes: (async function* () { for (let offset = 0; offset < raw.length; offset += 7) yield raw.subarray(offset, offset + 7) })() }
    },
    async verifyRetainedPair() { pairChecks++; if (options.rotatedPair) throw Error("private ID must not leak"); return { files: rawFiles } },
  }
  const gcs = {
    manifestObjectName: `${policy.targetPrefix}/runs/${runId}/manifest.json`,
    async validateBucket() { events.push("bucket"); if (options.unsafeBucket) throw Error("unsafe") },
    control: {
      async read() { return control && structuredClone(control) },
      async compareAndSwap(expected, record) {
        events.push("cas")
        if (options.casConflict || expected !== (control?.generation || "0")) return null
        control = { generation: String(++generation), record: structuredClone(record) }; return structuredClone(control)
      },
    },
    async writeTarget(request) {
      assert.equal(request.ifGenerationMatch, "0"); events.push("write-object")
      let count = 0
      for await (const chunk of request.bytes) { assert.ok(chunk.byteLength <= 256 * 1024); count += chunk.byteLength }
      if (options.abortOnWrite) controller.abort()
      const target = { bucket: policy.targetBucket, objectName: `${policy.targetPrefix}/runs/${runId}/objects/${sha(JSON.stringify(request.source))}`, generation: String(++generation) }
      const result = { target, sizeBytes: count, crc32c: zeroCrc(count) }
      objects.set(JSON.stringify(target), { ...result, source: request.source }); return structuredClone(result)
    },
    async inspectTarget(target) {
      const saved = objects.get(JSON.stringify(target)); assert.ok(saved)
      return { target: structuredClone(target), sizeBytes: saved.sizeBytes, crc32c: saved.crc32c }
    },
    async readTarget(target) {
      events.push("readback")
      const saved = objects.get(JSON.stringify(target)); assert.ok(saved)
      return { target: structuredClone(target), bytes: saved.manifest ? (async function* () { yield saved.manifest })() : bytes(saved.sizeBytes), crc32c: saved.crc32c }
    },
    async uploadImmutable(request) {
      events.push("manifest-upload")
      assert.equal(request.objectName, gcs.manifestObjectName)
      const chunks = []; for await (const chunk of request.bytes) chunks.push(chunk)
      const body = Buffer.concat(chunks), measured = await measureByteStream((async function* () { yield body })(), { expectedBytes: body.length }, context)
      const target = { bucket: policy.targetBucket, objectName: request.objectName, generation: String(++generation) }
      const result = { target, sizeBytes: body.length, crc32c: measured.crc32c }
      objects.set(JSON.stringify(target), { ...result, manifest: body }); return structuredClone(result)
    },
  }
  return { source, retained, gcs, runId, context, events, objects, rawFiles, getControl: () => control, pairChecks: () => pairChecks }
}

test("complete approved224MB snapshot streams with bounded chunks and publishes only independently read-back generations", async () => {
  const f = fixture(), result = await runStorageMediaBackup(f, f.context)
  assert.equal(result.status, "succeeded"); assert.equal(result.copiedObjects, 15); assert.equal(result.copiedBytes, 224309367)
  assert.equal(result.retainedArtifacts, 2); assert.equal(result.historicalByteCorrespondence, "unproved")
  assert.equal(f.events.filter(item => item === "write-object").length, 15)
  assert.equal(f.events.filter(item => item === "readback").length, 16)
  const control = f.getControl(); assert.equal(control.record.lease, null); assert.equal(control.record.latestSuccess.runId, f.runId)
  const manifest = JSON.parse(f.objects.get(JSON.stringify(result.manifest)).manifest)
  assert.equal(manifest.inventory.length, 15); assert.equal(manifest.copies.length, 15)
  assert.equal(manifest.pair.artifacts.length, 2); assert.equal(manifest.pair.artifacts[0].references.length, 1)
  assert.equal(manifest.pair.historicalByteCorrespondence, "unproved")
  assert.ok(f.pairChecks() >= 3)
})

test("unsafe bucket, lease CAS conflict, wrong raw receipt, retained rotation and source change never publish", async () => {
  for (const options of [{ unsafeBucket: true }, { casConflict: true }, { wrongReceipt: true }, { rotatedPair: true }, { changedInventory: true }, { changedSource: true }, { abortOnWrite: true }]) {
    const f = fixture(options)
    await assert.rejects(runStorageMediaBackup(f, f.context), error => /^Storage media backup failed during /.test(error.message) && !error.message.includes("private ID"))
    assert.equal(f.getControl()?.record.latestSuccess || null, null)
    assert.equal(f.events.includes("manifest-upload"), false)
  }
})

test("a forged self-computed receipt is not obtained from downloaded JSON or used as trusted input", async () => {
  const f = fixture(); f.rawFiles[0].uploadedFileSha256 = "0".repeat(64)
  await assert.rejects(runStorageMediaBackup(f, f.context), /retained-artifact-extraction/)
  assert.equal(f.events.includes("write-object"), false); assert.equal(f.getControl().record.latestSuccess, null)
})

test("missing current reference or wrong expected size fails before target object writes", async () => {
  const f = fixture()
  const payload = JSON.parse(f.rawFiles[0].raw); payload.data.spcPresentationChunks[0].video_path = "not-in-current-inventory"
  f.rawFiles[0].raw = Buffer.from(JSON.stringify(payload)); f.rawFiles[0].uploadedFileSha256 = sha(f.rawFiles[0].raw); f.rawFiles[0].fileByteLength = f.rawFiles[0].raw.length
  await assert.rejects(runStorageMediaBackup(f, f.context), /reference-preflight/)
  assert.equal(f.events.includes("write-object"), false)
})

test("aborted or expired common context cannot acquire a source or target", async () => {
  for (const aborted of [true, false]) {
    const f = fixture(), controller = new AbortController()
    if (aborted) controller.abort()
    await assert.rejects(runStorageMediaBackup(f, { ...f.context, signal: controller.signal, deadline: aborted ? Date.now() + 1000 : Date.now() - 1 }))
    assert.equal(f.events.length, 0)
  }
})
