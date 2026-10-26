import { createHash } from "node:crypto"
import { fcunoConnectionPolicy } from "../config/fcunoConnections.ts"
import { validateInventory, validateCopyEvidence, validateTargetIdentity } from "./storageMediaBackup.mjs"

const policy = fcunoConnectionPolicy.storageMediaBackup
export const RECURRING_MEDIA_SCHEMA = "fcuno.storage-media-daily/v2"
export const RECURRING_CONTROL_SCHEMA = "fcuno.storage-media-daily-control/v1"
export const RECURRING_MANIFEST_MAX_BYTES = 8 * 1024 * 1024
function fail() { throw new Error("Recurring media backup evidence is invalid") }
function exact(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field))) fail()
}
function hash(value) { if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) fail(); return value }
function time(value) { if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail(); return value }
function id(value) { if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value)) fail(); return value }
function count(value, minimum = 0) { if (!Number.isSafeInteger(value) || value < minimum || Object.is(value, -0)) fail(); return value }
const sourceKey = value => JSON.stringify([value.bucket, value.path, value.id, value.version, value.sizeBytes])
export function recurringInventorySha256(value) {
  const sources = validateRecurringInventory(value)
  sources.sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0)
  return createHash("sha256").update(JSON.stringify(sources)).digest("hex")
}
export function validateRecurringInventory(value) {
  const sources = validateInventory(value)
  const total = sources.reduce((sum, source) => sum + source.sizeBytes, 0)
  if (sources.length > policy.recurring.maxObjects || !Number.isSafeInteger(total) || total > policy.recurring.maxTotalBytes ||
      sources.some(source => source.bucket !== policy.sourceBucket || source.sizeBytes > policy.recurring.maxObjectBytes)) fail()
  return sources
}
export function validateRecurringSnapshot(value) {
  exact(value, ["inventorySha256", "windowStartsAt", "windowExpiresAt"])
  const start = time(value.windowStartsAt), end = time(value.windowExpiresAt)
  const shifted = new Date(Date.parse(start) + 8 * 3_600_000)
  if (Date.parse(end) - Date.parse(start) !== (policy.recurring.windowEndHourHkt - policy.recurring.windowStartHourHkt) * 3_600_000 ||
      shifted.getUTCHours() !== policy.recurring.windowStartHourHkt || shifted.getUTCMinutes() || shifted.getUTCSeconds() || shifted.getUTCMilliseconds()) fail()
  return { inventorySha256: hash(value.inventorySha256), windowStartsAt: start, windowExpiresAt: end }
}
export function recurringMediaScope() {
  return { supabaseProject: fcunoConnectionPolicy.supabase.projectRef, sourceBucket: policy.sourceBucket,
    googleProject: policy.googleProjectId, targetBucket: policy.targetBucket }
}
export function validateRecurringMediaManifest(value) {
  exact(value, ["schema", "status", "scope", "runId", "snapshot", "inventory", "copies", "startedAt", "finishedAt"])
  if (value.schema !== RECURRING_MEDIA_SCHEMA || value.status !== "succeeded") fail()
  exact(value.scope, ["supabaseProject", "sourceBucket", "googleProject", "targetBucket"])
  const expectedScope = recurringMediaScope()
  if (Object.keys(expectedScope).some(field => value.scope[field] !== expectedScope[field])) fail()
  const inventory = validateRecurringInventory(value.inventory), snapshot = validateRecurringSnapshot(value.snapshot)
  if (snapshot.inventorySha256 !== recurringInventorySha256(inventory) || !Array.isArray(value.copies) || value.copies.length !== inventory.length) fail()
  const startedAt = time(value.startedAt), finishedAt = time(value.finishedAt)
  if (Date.parse(startedAt) > Date.parse(finishedAt) || Date.parse(startedAt) < Date.parse(snapshot.windowStartsAt) || Date.parse(finishedAt) >= Date.parse(snapshot.windowExpiresAt)) fail()
  const copies = value.copies.map(validateCopyEvidence), bySource = new Map(), targets = new Set()
  for (const copy of copies) {
    const key = sourceKey(copy.source), targetKey = JSON.stringify(copy.target)
    if (copy.target.bucket !== policy.targetBucket || !new RegExp(`^${policy.targetPrefix}/daily/runs/[A-Za-z0-9][A-Za-z0-9_-]{0,79}/objects/[0-9a-f]{64}$`).test(copy.target.objectName) ||
        bySource.has(key) || targets.has(targetKey) || Date.parse(copy.verifiedAt) < Date.parse(startedAt) || Date.parse(copy.verifiedAt) > Date.parse(finishedAt)) fail()
    bySource.set(key, copy); targets.add(targetKey)
  }
  for (const source of inventory) if (!bySource.has(sourceKey(source))) fail()
  const result = { schema: RECURRING_MEDIA_SCHEMA, status: "succeeded", scope: recurringMediaScope(), runId: id(value.runId), snapshot, inventory, copies, startedAt, finishedAt }
  if (Buffer.byteLength(JSON.stringify(result)) > RECURRING_MANIFEST_MAX_BYTES) fail()
  return result
}
export function encodeRecurringMediaManifest(value) { return Buffer.from(JSON.stringify(validateRecurringMediaManifest(value))) }
export function validateRecurringManifestReceipt(value) {
  exact(value, ["target", "sizeBytes", "crc32c", "byteSha256"])
  const target = validateTargetIdentity(value.target)
  if (target.bucket !== policy.targetBucket || !new RegExp(`^${policy.targetPrefix}/daily/runs/[A-Za-z0-9][A-Za-z0-9_-]{0,79}/manifest\\.json$`).test(target.objectName) ||
      count(value.sizeBytes, 1) > RECURRING_MANIFEST_MAX_BYTES || typeof value.crc32c !== "string" || !/^[A-Za-z0-9+/]{6}==$/.test(value.crc32c) ||
      Buffer.from(value.crc32c, "base64").toString("base64") !== value.crc32c) fail()
  return { target, sizeBytes: value.sizeBytes, crc32c: value.crc32c, byteSha256: hash(value.byteSha256) }
}
export function validateRecurringControl(value) {
  exact(value, ["schema", "fence", "lease", "latestSuccess"])
  if (value.schema !== RECURRING_CONTROL_SCHEMA) fail()
  let lease = null, latestSuccess = null
  if (value.lease !== null) {
    exact(value.lease, ["owner", "expiresAt"])
    lease = { owner: id(value.lease.owner), expiresAt: count(value.lease.expiresAt, 1) }
  }
  if (value.latestSuccess !== null) {
    exact(value.latestSuccess, ["runId", "manifest", "finishedAt"])
    const runId = id(value.latestSuccess.runId), manifest = validateRecurringManifestReceipt(value.latestSuccess.manifest)
    if (manifest.target.objectName !== `${policy.targetPrefix}/daily/runs/${runId}/manifest.json`) fail()
    latestSuccess = { runId, manifest, finishedAt: time(value.latestSuccess.finishedAt) }
  }
  return { schema: RECURRING_CONTROL_SCHEMA, fence: count(value.fence, 1), lease, latestSuccess }
}
