import { createHash } from "node:crypto"
import { copyStorageObject, reuseVerifiedCopy, measureByteStream } from "../../lib/storageMediaBackup.mjs"
import { RECURRING_CONTROL_SCHEMA, RECURRING_MEDIA_SCHEMA, RECURRING_MANIFEST_MAX_BYTES,
  validateRecurringInventory, validateRecurringSnapshot, recurringInventorySha256, recurringMediaScope,
  validateRecurringControl, validateRecurringMediaManifest, validateRecurringManifestReceipt, encodeRecurringMediaManifest,
} from "../../lib/storageMediaRecurring.mjs"

function fail() { throw new Error("Recurring media backup could not be verified") }
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const key = source => JSON.stringify([source.bucket, source.path, source.id, source.version, source.sizeBytes])
function progress(context) { context.signal.throwIfAborted(); if (!Number.isSafeInteger(context.deadline) || context.now() >= context.deadline) fail() }
async function* chunks(bytes) { for (let offset = 0; offset < bytes.length; offset += 256 * 1024) yield bytes.subarray(offset, offset + 256 * 1024) }
async function readControl(gcs, context) {
  const value = await gcs.control.read(context)
  if (value === null) return null
  if (!value || Object.keys(value).sort().join(",") !== "generation,record" || !/^[1-9]\d{0,39}$/.test(value.generation)) fail()
  return { generation: value.generation, record: validateRecurringControl(value.record) }
}
async function swap(gcs, expected, record, context) {
  progress(context)
  const next = await gcs.control.compareAndSwap(expected, validateRecurringControl(record), context)
  progress(context)
  if (!next || next.generation === expected || !/^[1-9]\d{0,39}$/.test(next.generation) || !equal(next.record, record)) fail()
  return next
}
async function assertLease(gcs, lease, context) {
  progress(context)
  const current = await readControl(gcs, context)
  if (!current || current.generation !== lease.generation || current.record.fence !== lease.fence ||
      current.record.lease?.owner !== lease.owner || current.record.lease.expiresAt <= context.now()) fail()
  return current
}
async function verifyManifestReceipt(gcs, descriptor, context) {
  const receipt = validateRecurringManifestReceipt(descriptor)
  const expected = { target: receipt.target, sizeBytes: receipt.sizeBytes, crc32c: receipt.crc32c }
  if (!equal(await gcs.inspectTarget(receipt.target, context), expected)) fail()
  const opened = await gcs.readTarget(receipt.target, context), pieces = []
  if (!equal(opened.target, receipt.target) || opened.crc32c !== receipt.crc32c) { await opened.bytes?.return?.(); fail() }
  async function* recording() {
    for await (const piece of opened.bytes) { pieces.push(piece); if (pieces.reduce((sum, item) => sum + item.length, 0) > RECURRING_MANIFEST_MAX_BYTES) fail(); yield piece }
  }
  await measureByteStream(recording(), { expectedBytes: receipt.sizeBytes, expectedSha256: receipt.byteSha256, expectedCrc32c: receipt.crc32c }, context)
  if (!equal(await gcs.inspectTarget(receipt.target, context), expected)) fail()
  let value
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(pieces))) } catch { fail() }
  return validateRecurringMediaManifest(value)
}
function publication(receipt, manifest) {
  const bytes = encodeRecurringMediaManifest(manifest)
  if (!receipt || receipt.verified !== true || typeof receipt.fileId !== "string" || !receipt.fileId ||
      typeof receipt.version !== "string" || !/^[1-9]\d*$/.test(receipt.version) || !Number.isSafeInteger(receipt.byteLength) || receipt.byteLength <= 0 ||
      !/^[0-9a-f]{64}$/.test(receipt.healthSha256) || receipt.manifestByteLength !== bytes.length ||
      receipt.manifestSha256 !== createHash("sha256").update(bytes).digest("hex")) fail()
  return receipt
}

// This is not a database export and makes no historical correspondence claim.
// It captures every current media object, preserving immutable previous versions.
export async function runRecurringStorageMediaBackup({ source, gcs, publisher, budget, runId }, context) {
  let phase = "source-inventory", lease = null, primary = null, success = false
  const startedAt = new Date(context.now()).toISOString()
  const publicationContext = () => {
    if (!lease) fail()
    return { ...context, publication: { fence: lease.fence, owner: lease.owner }, assertOwnership: () => assertLease(gcs, lease, context) }
  }
  try {
    progress(context)
    const inventory = validateRecurringInventory(await source.inventory(context))
    const baseline = recurringInventorySha256(inventory), snapshot = validateRecurringSnapshot(source.snapshot())
    if (snapshot.inventorySha256 !== baseline || context.now() < Date.parse(snapshot.windowStartsAt) || context.now() >= Date.parse(snapshot.windowExpiresAt)) fail()
    phase = "target-preflight"; await gcs.validateBucket(context)
    const initial = await readControl(gcs, context)
    phase = "previous-manifest-verification"
    const previous = initial?.record.latestSuccess ? await verifyManifestReceipt(gcs, initial.record.latestSuccess.manifest, context) : null
    if (previous && (previous.runId !== initial.record.latestSuccess.runId || previous.finishedAt !== initial.record.latestSuccess.finishedAt || Date.parse(previous.finishedAt) > context.now())) fail()
    const prior = new Map(previous?.copies.map(copy => [key(copy.source), copy]) || [])
    const plannedWriteBytes = inventory.reduce((sum, item) => sum + (prior.has(key(item)) ? 0 : item.sizeBytes), 0)
    phase = "optional-budget-check"
    const decision = await budget.checkOptionalWork({ inventory, plannedWriteBytes }, context)
    if (!decision || typeof decision.allowed !== "boolean" || typeof decision.reason !== "string" || !decision.reason || decision.reason.length > 100) fail()
    if (decision.allowed && previous && equal(previous.snapshot, snapshot)) {
      phase = "existing-daily-success-check"
      if (recurringInventorySha256(validateRecurringInventory(await source.inventory(context))) !== baseline) fail()
      // Do not publish a falsely fresh receipt or overwrite a later failure
      // with the old success's timestamp merely because a scheduler retried.
      return { status: "already-succeeded", runId: previous.runId, copiedObjects: 0, copiedBytes: 0, reusedObjects: previous.copies.length }
    }
    phase = "lease-acquisition"
    if (initial?.record.lease && initial.record.lease.expiresAt > context.now()) throw new Error("Another recurring media backup owns the lease")
    const record = { schema: RECURRING_CONTROL_SCHEMA, fence: (initial?.record.fence || 0) + 1,
      lease: { owner: runId, expiresAt: Math.min(context.deadline - 1000, Date.parse(snapshot.windowExpiresAt) - 1000) }, latestSuccess: initial?.record.latestSuccess || null }
    if (record.lease.expiresAt <= context.now()) fail()
    const acquired = await swap(gcs, initial?.generation || "0", record, context)
    lease = { owner: runId, fence: record.fence, generation: acquired.generation }
    if (!decision.allowed) {
      phase = "budget-pause-publication"
      await assertLease(gcs, lease, context)
      await publisher.publishAttempt({ runId, startedAt, finishedAt: new Date(context.now()).toISOString(), state: "budget-paused", reason: decision.reason }, publicationContext())
      return { status: "budget-paused", runId, reason: decision.reason, copiedObjects: 0, copiedBytes: 0 }
    }
    const adapters = { inspectSource: source.inspectSource.bind(source), openSource: source.openSource.bind(source),
      writeTarget: gcs.writeTarget.bind(gcs), inspectTarget: gcs.inspectTarget.bind(gcs), readTarget: gcs.readTarget.bind(gcs) }
    phase = "exact-version-copy-and-readback"
    const copies = []; let copiedBytes = 0, copiedObjects = 0, reusedObjects = 0
    for (const identity of inventory) {
      progress(context)
      const old = prior.get(key(identity))
      if (old) { copies.push(await reuseVerifiedCopy(identity, old, adapters, context)); reusedObjects++ }
      else { copies.push(await copyStorageObject(identity, adapters, context)); copiedObjects++; copiedBytes += identity.sizeBytes }
    }
    phase = "final-source-fence"
    if (recurringInventorySha256(validateRecurringInventory(await source.inventory(context))) !== baseline || !equal(source.snapshot(), snapshot)) fail()
    const manifest = validateRecurringMediaManifest({ schema: RECURRING_MEDIA_SCHEMA, status: "succeeded", scope: recurringMediaScope(), runId,
      snapshot, inventory, copies, startedAt, finishedAt: new Date(context.now()).toISOString() })
    const bytes = encodeRecurringMediaManifest(manifest)
    phase = "immutable-manifest-upload"
    const receipt = await gcs.uploadImmutable({ objectName: gcs.manifestObjectName, bytes: chunks(bytes), sizeBytes: bytes.length, contentType: "application/json" }, context)
    const descriptor = validateRecurringManifestReceipt({ ...receipt, byteSha256: createHash("sha256").update(bytes).digest("hex") })
    phase = "immutable-manifest-readback"
    if (!equal(await verifyManifestReceipt(gcs, descriptor, context), manifest)) fail()
    await assertLease(gcs, lease, context)
    phase = "drive-health-publication"
    const published = publication(await publisher.publishHealth(manifest, publicationContext()), manifest)
    phase = "fenced-success-publication"
    const held = await assertLease(gcs, lease, context)
    const committed = await swap(gcs, lease.generation, { ...held.record,
      latestSuccess: { runId, manifest: descriptor, finishedAt: manifest.finishedAt } }, context)
    lease.generation = committed.generation; success = true
    return { status: "succeeded", runId, copiedObjects, copiedBytes, reusedObjects, manifest: receipt.target, publication: published }
  } catch (error) {
    primary = new Error(`Recurring storage media backup failed during ${phase}`, { cause: error })
    try {
      progress(context)
      // No failed attempt may race another owner's successful publication.
      if (lease) {
        await assertLease(gcs, lease, context)
        await publisher.publishAttempt({ runId, startedAt, finishedAt: new Date(context.now()).toISOString(), state: "failed", reason: phase }, publicationContext())
      }
    } catch { /* Never replace the last good success when failure reporting is unavailable. */ }
    throw primary
  } finally {
    if (lease) {
      try {
        const current = await assertLease(gcs, lease, context)
        await swap(gcs, lease.generation, { ...current.record, lease: null }, context)
      } catch (error) { if (!primary && success) throw new Error("Recurring media lease release could not be confirmed", { cause: error }) }
    }
  }
}
