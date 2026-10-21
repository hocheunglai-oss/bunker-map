import { fcunoConnectionPolicy } from "../../config/fcunoConnections.ts"
import { extractBackupMediaReferences } from "../../lib/backupValidationSpool.mjs"
import {
  validateInventory, copyStorageObject, buildRecoveryPairMapping, buildCopyManifest,
  encodeCopyManifest, acquireMediaLease, publishMediaSuccess, releaseMediaLease,
} from "../../lib/storageMediaBackup.mjs"

const policy = fcunoConnectionPolicy.storageMediaBackup
function fail() { throw new Error("Approved media snapshot or retained receipt could not be verified") }
function fingerprint(sources) { return JSON.stringify(validateInventory(sources).map(source => JSON.stringify(source)).sort()) }
function approvedInventory(value) {
  const sources = validateInventory(value)
  if (sources.length !== policy.approvedObjectCount || sources.some(source => source.bucket !== policy.sourceBucket) ||
      sources.reduce((sum, source) => sum + source.sizeBytes, 0) !== policy.approvedTotalBytes) fail()
  return sources
}
function progress(context) {
  context.signal.throwIfAborted()
  if (!Number.isSafeInteger(context.deadline) || context.now() >= context.deadline) throw new Error("Media backup deadline reached")
}
async function* chunks(bytes) { for (let offset = 0; offset < bytes.length; offset += 256 * 1024) yield bytes.subarray(offset, offset + 256 * 1024) }

// The only orchestration path. Provider boundaries are injected; the reviewed
// helpers own byte hashes/CRC, exact-generation readback, mapping and fenced
// publication. No recovery point or history claim is inferred from copy count.
export async function runStorageMediaBackup({ source, gcs, retained, runId }, context) {
  let phase = "source-inventory", lease = null, primaryError = null
  const startedAt = new Date(context.now()).toISOString()
  try {
    progress(context)
    const inventory = approvedInventory(await source.inventory(context)), baseline = fingerprint(inventory)
    phase = "target-preflight"; await gcs.validateBucket(context)
    phase = "lease-acquisition"
    lease = await acquireMediaLease(gcs.control, { owner: runId, ttlMs: Math.max(1, context.deadline - context.now() - 1000) }, context)
    if (!lease) throw new Error("Another media backup owns the active lease")
    phase = "retained-pair-selection"
    const catalog = await retained.readRetainedPair(context)
    if (!Array.isArray(catalog?.files) || catalog.files.length !== 2) fail()
    const extracted = [], artifacts = []
    for (const file of catalog.files) {
      phase = "retained-artifact-extraction"; progress(context)
      const opened = await retained.openRetainedArtifact(file, context)
      const result = await extractBackupMediaReferences(opened.bytes,
        { uploadedFileSha256: file.uploadedFileSha256, fileByteLength: file.fileByteLength }, { signal: context.signal })
      // Raw receipt authentication has completed before accessing any metadata.
      // The independently recorded Drive raw hash anchors this checkpoint;
      // never construct a checkpoint from partial Drive appProperties fields.
      const checkpoint = result.metadata?.integrity?.truth?.checkpointAfterExport
      if (!checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint) ||
          result.metadata?.integrity?.artifactSha256 !== file.artifactSha256) fail()
      artifacts.push({ driveFileId: file.fileId, uploadedFileSha256: file.uploadedFileSha256,
        fileByteLength: file.fileByteLength, logicalArtifactSha256: file.artifactSha256, checkpoint })
      extracted.push({ driveFileId: file.fileId, result })
    }
    phase = "reference-preflight"
    const byPath = new Map(inventory.map(item => [item.path, item]))
    for (const item of extracted) for (const ref of item.result.references) {
      const current = byPath.get(ref.path)
      if (!current || current.sizeBytes !== ref.expectedBytes) fail()
    }
    await retained.verifyRetainedPair(catalog, context)
    if (fingerprint(approvedInventory(await source.inventory(context))) !== baseline) fail()
    phase = "object-copy"
    const evidence = []
    for (const identity of inventory) {
      progress(context)
      evidence.push(await copyStorageObject(identity, {
        inspectSource: source.inspectSource.bind(source), openSource: source.openSource.bind(source),
        writeTarget: gcs.writeTarget.bind(gcs), inspectTarget: gcs.inspectTarget.bind(gcs), readTarget: gcs.readTarget.bind(gcs),
      }, context))
    }
    phase = "final-source-and-pair-fences"
    if (fingerprint(approvedInventory(await source.inventory(context))) !== baseline) fail()
    await retained.verifyRetainedPair(catalog, context)
    const pair = buildRecoveryPairMapping({ sourceBucket: policy.sourceBucket, artifacts, extracted,
      copies: evidence, checkedAt: new Date(context.now()).toISOString() })
    const manifest = buildCopyManifest({ runId, inventory, copies: evidence, pair,
      startedAt, finishedAt: new Date(context.now()).toISOString() })
    phase = "manifest-upload"
    const encoded = encodeCopyManifest(manifest)
    const receipt = await gcs.uploadImmutable({ objectName: gcs.manifestObjectName, bytes: chunks(encoded),
      sizeBytes: encoded.length, contentType: "application/json" }, context)
    phase = "manifest-readback-and-fenced-publication"
    lease = await publishMediaSuccess(gcs.control, lease, manifest, receipt, {
      inspectManifest: gcs.inspectTarget.bind(gcs), readManifest: gcs.readTarget.bind(gcs),
      async readRetainedPair() {
        await retained.verifyRetainedPair(catalog, context)
        if (fingerprint(approvedInventory(await source.inventory(context))) !== baseline) fail()
        return { artifacts, checkedAt: new Date(context.now()).toISOString() }
      },
    }, context)
    return { status: "succeeded", runId, copiedObjects: evidence.length,
      copiedBytes: inventory.reduce((sum, item) => sum + item.sizeBytes, 0),
      manifest: receipt.target, historicalByteCorrespondence: "unproved", retainedArtifacts: artifacts.length }
  } catch (error) {
    primaryError = new Error(`Storage media backup failed during ${phase}`, { cause: error })
    throw primaryError
  } finally {
    if (lease) {
      try { await releaseMediaLease(gcs.control, lease, context) }
      catch (error) {
        // An abort/lost acknowledgement leaves the fenced record to expire.
        // Never delete or perform an unconditional cleanup write.
        if (!primaryError) throw new Error("Storage media backup lease release could not be confirmed", { cause: error })
      }
    }
  }
}
