import { createHash, verify } from "node:crypto"
import { fcunoConnectionPolicy } from "../../config/fcunoConnections.ts"
import { measureByteStream } from "../../lib/storageMediaBackup.mjs"
import { decodePostgresExport, digest, assertExportContext, assertExact, guardedExport, postgresBackupWeek } from "../../lib/postgresBackupProtocol.mjs"
import { POSTGRES_CONTROL_SCHEMA, POSTGRES_RECEIPT_SCHEMA, validatePostgresControl, validatePostgresManifest, validatePostgresManifestReceipt } from "../../lib/postgresBackupReceipt.mjs"

const policy = fcunoConnectionPolicy.postgresBackup
const fail = () => { throw new Error("PostgreSQL backup copy could not be verified") }
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b)
async function* chunks(bytes) { for (let n = 0; n < bytes.length; n += policy.chunkBytes) yield bytes.subarray(n, n + policy.chunkBytes) }
async function verifyReceipt(gcs, receipt, context, expectedHash, capture = false, onChunk) {
  assertExact(receipt, ["target", "sizeBytes", "crc32c"])
  if (!equal(await guardedExport(gcs.inspectTarget(receipt.target, context), context), receipt)) fail()
  const opened = await guardedExport(gcs.readTarget(receipt.target, context), context), pieces = []
  if (!equal(opened.target, receipt.target) || opened.crc32c !== receipt.crc32c) { void opened.bytes?.return?.(); fail() }
  async function* recording() { let count = 0; for await (const piece of opened.bytes) { count += piece.length; if (capture) { if (count > policy.maximumMetadataBytes) fail(); pieces.push(piece) } await onChunk?.(piece); yield piece } }
  const measured = await measureByteStream(recording(), { expectedBytes: receipt.sizeBytes, expectedSha256: expectedHash, expectedCrc32c: receipt.crc32c }, context)
  if (!equal(await guardedExport(gcs.inspectTarget(receipt.target, context), context), receipt)) fail()
  return { ...measured, bytes: capture ? Buffer.concat(pieces) : null }
}
async function readControl(gcs, context) {
  const value = await guardedExport(gcs.control.read(context), context)
  if (value === null) return null
  assertExact(value, ["generation", "record"])
  if (!/^[1-9][0-9]{0,19}$/.test(value.generation)) fail()
  return { generation: value.generation, record: validatePostgresControl(value.record) }
}
async function swap(gcs, expected, record, context) {
  const result = await guardedExport(gcs.control.compareAndSwap(expected, validatePostgresControl(record), context), context)
  if (!result || result.generation === expected || !/^[1-9][0-9]{0,19}$/.test(result.generation) || !equal(result.record, record)) fail()
  return result
}
async function owned(gcs, lease, context) {
  const current = await readControl(gcs, context)
  if (!current || current.generation !== lease.generation || current.record.fence !== lease.fence ||
      current.record.lease?.owner !== lease.owner || current.record.lease.expiresAt <= context.now()) fail()
  return current
}
export async function readPostgresManifestMetadata(gcs, descriptor, publicKey, context) {
  const checked = validatePostgresManifestReceipt(descriptor)
  const result = await verifyReceipt(gcs, { target: checked.target, sizeBytes: checked.sizeBytes, crc32c: checked.crc32c }, context, checked.byteSha256, true)
  const manifest = validatePostgresManifest(JSON.parse(result.bytes.toString("utf8")))
  if (Date.parse(manifest.completion.finishedAt) > context.now() + 30000) fail()
  if (digest(Buffer.from(JSON.stringify(manifest.metadata))) !== manifest.completion.metadataSha256 ||
      !verify(null, Buffer.from(JSON.stringify(manifest.completion)), publicKey, Buffer.from(manifest.signature, "base64url"))) fail()
  if (checked.target.objectName !== `${policy.targetPrefix}/runs/${manifest.runId}/manifest.json`) fail()
  return manifest
}
export async function readPostgresManifest(gcs, descriptor, publicKey, context, onArchiveChunk) {
  const manifest = await readPostgresManifestMetadata(gcs, descriptor, publicKey, context)
  // The source signature binds the COMPLETE archive, not caller-written GCS
  // descriptors. Reassemble its hash from immutable readback even on reuse.
  const archiveHash = createHash("sha256")
  for (const part of manifest.parts) await verifyReceipt(gcs,
    { target: part.target, sizeBytes: part.sizeBytes, crc32c: part.crc32c }, context, part.byteSha256, false,
    async bytes => { archiveHash.update(bytes); await onArchiveChunk?.(bytes) })
  if (archiveHash.digest("hex") !== manifest.completion.archiveSha256) fail()
  return manifest
}

// Uses the existing budget policy, transport, immutable-generation readback
// and fence contracts. No deletion or retention mutation. This confirms a copy,
// NOT an actual restore or hosted-platform recovery; those remain separate.
export async function receivePostgresBackup({ source, gcs, budget, publicKey, runId, week }, context) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(runId) || week !== postgresBackupWeek(context.now())) fail()
  const began = context.now()
  let lease = null, opened = null, primary = null
  try {
    assertExportContext(context)
    await guardedExport(gcs.validateBucket(context), context)
    const initial = await readControl(gcs, context)
    // Authentic fresh budget evidence gates full archive reads too, including
    // same-week reuse. Only bounded bucket/control metadata is read beforehand.
    const decision = await guardedExport(budget.checkOptionalWork({ plannedWriteBytes: policy.maximumArchiveBytes }, context), context)
    if (!decision || typeof decision.allowed !== "boolean" || typeof decision.reason !== "string") fail()
    if (!decision.allowed) return { status: "budget-paused", reason: decision.reason }
    if (initial?.record.latestSuccess) {
      const old = await readPostgresManifest(gcs, initial.record.latestSuccess.manifest, publicKey, context)
      if (old.runId !== initial.record.latestSuccess.runId || old.week !== initial.record.latestSuccess.week) fail()
      if (old.week === week) return { status: "already-copied", runId: old.runId }
    }
    if (initial?.record.lease?.expiresAt > context.now()) return { status: "already-running" }
    const record = { schema: POSTGRES_CONTROL_SCHEMA, fence: (initial?.record.fence || 0) + 1,
      lease: { owner: runId, expiresAt: context.deadline }, latestSuccess: initial?.record.latestSuccess || null }
    const acquired = await swap(gcs, initial?.generation || "0", record, context)
    lease = { owner: runId, fence: record.fence, generation: acquired.generation }
    opened = await guardedExport(source.open(context), context, value => value?.close?.())
    let metadata = null, completion = null, signature = null, buffers = [], buffered = 0
    const parts = []
    async function savePart() {
      const bytes = Buffer.concat(buffers, buffered), byteSha256 = digest(bytes)
      buffers = []; buffered = 0
      const receipt = await guardedExport(gcs.writeArchivePart({ index: parts.length, bytes: chunks(bytes), sizeBytes: bytes.length, ifGenerationMatch: "0" }, context), context)
      const expectedName = `${policy.targetPrefix}/runs/${runId}/archive/${String(parts.length).padStart(6, "0")}`
      if (receipt.target?.bucket !== fcunoConnectionPolicy.storageMediaBackup.targetBucket || receipt.target?.objectName !== expectedName || receipt.sizeBytes !== bytes.length) fail()
      parts.push({ ...receipt, byteSha256 })
    }
    for await (const item of decodePostgresExport(opened.bytes, publicKey, context)) {
      if (item.type === "metadata") {
        metadata = item.metadata
        if (Date.parse(metadata.startedAt) < began - 30000 || Date.parse(metadata.startedAt) > context.now() + 30000 ||
            postgresBackupWeek(Date.parse(metadata.startedAt)) !== week) fail()
      }
      else if (item.type === "archive") {
        let offset = 0
        while (offset < item.bytes.length) {
          const end = Math.min(item.bytes.length, offset + policy.objectBytes - buffered)
          buffers.push(item.bytes.subarray(offset, end)); buffered += end - offset; offset = end
          if (buffered === policy.objectBytes) await savePart()
        }
      } else { completion = item.completion; signature = item.signature }
    }
    if (!metadata || !completion || !signature) fail()
    if (Date.parse(completion.finishedAt) > context.now() + 30000 ||
        Date.parse(completion.finishedAt) - Date.parse(metadata.startedAt) > policy.maximumExportMs + 1000) fail()
    if (buffered) await savePart()
    // Source transactions are already closed before independent readback;
    // GCS verification must not extend production snapshot lifetime.
    await opened.close?.()
    const manifest = validatePostgresManifest({ schema: POSTGRES_RECEIPT_SCHEMA, status: "copied-and-byte-verified", runId, week,
      metadata, completion, signature, parts })
    const bytes = Buffer.from(JSON.stringify(manifest))
    const receipt = await guardedExport(gcs.uploadImmutable({ objectName: gcs.manifestObjectName, bytes: chunks(bytes), sizeBytes: bytes.length, contentType: "application/json" }, context), context)
    const descriptor = validatePostgresManifestReceipt({ ...receipt, byteSha256: digest(bytes) })
    if (!equal(await readPostgresManifest(gcs, descriptor, publicKey, context), manifest)) fail()
    const held = await owned(gcs, lease, context)
    const committed = await swap(gcs, lease.generation, { ...held.record, latestSuccess: { runId, week, manifest: descriptor } }, context)
    lease.generation = committed.generation
    return { status: "copied-and-byte-verified", runId, archiveBytes: completion.archiveBytes, parts: parts.length, manifest: descriptor }
  } catch (error) { primary = error; throw error }
  finally {
    await opened?.close?.()
    if (lease) {
      try { const current = await owned(gcs, lease, context); await swap(gcs, lease.generation, { ...current.record, lease: null }, context) }
      catch (error) { if (!primary) throw error }
    }
  }
}
