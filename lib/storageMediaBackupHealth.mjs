import { createHash } from "node:crypto"
import { fcunoConnectionPolicy } from "../config/fcunoConnections.ts"
import { validateRecurringMediaManifest } from "./storageMediaRecurring.mjs"

// This is an authenticated job receipt, not a new path to Storage or GCS.
// The reader must additionally verify its exact Drive folder and byte digest.
export const STORAGE_MEDIA_HEALTH_SCHEMA = "fcuno.storage-media-health/v1"
export const STORAGE_MEDIA_HEALTH_FOLDER = fcunoConnectionPolicy.storageMediaBackup.recurring.healthFolderName
export const STORAGE_MEDIA_HEALTH_PREFIX = fcunoConnectionPolicy.storageMediaBackup.recurring.healthFilePrefix
export const STORAGE_MEDIA_HEALTH_MAX_BYTES = 2 * 1024 * 1024
const policy = fcunoConnectionPolicy.storageMediaBackup
const TOP_FIELDS = ["schema", "projectRef", "sourceBucket", "targetBucket", "activatedAt", "publication", "latestAttempt", "latestSuccess", "retention", "budget"]

function fail() { throw new Error("Media backup receipt failed its safety checks") }
function record(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value, key)) ||
      fields.some(key => !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), "value"))) fail()
  return value
}
function time(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail()
  return value
}
function identifier(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(value)) fail()
  return value
}
function money(value) {
  if (value !== null && (!Number.isFinite(value) || value < 0 || value > 1_000_000)) fail()
  return value
}
function canonical(value) {
  // The strict validators below have already removed accessors and exotic
  // values. Recursing only over their returned JSON prevents toJSON hooks.
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
}

export function validateStorageMediaHealthReceipt(value, options = {}) {
  const input = record(value, TOP_FIELDS)
  if (input.schema !== STORAGE_MEDIA_HEALTH_SCHEMA || input.projectRef !== fcunoConnectionPolicy.supabase.projectRef ||
      input.sourceBucket !== policy.sourceBucket || input.targetBucket !== policy.targetBucket) fail()
  const activatedAt = time(input.activatedAt)
  if (options.activatedAt !== undefined && activatedAt !== time(options.activatedAt)) fail()
  const publication = record(input.publication, ["fence", "owner"])
  if (!Number.isSafeInteger(publication.fence) || publication.fence < 1) fail()
  identifier(publication.owner)
  const attempt = record(input.latestAttempt, ["runId", "startedAt", "finishedAt", "state", "errorCode"])
  const runId = identifier(attempt.runId), startedAt = time(attempt.startedAt), finishedAt = time(attempt.finishedAt)
  if (!["succeeded", "failed", "budget-paused"].includes(attempt.state) ||
      Date.parse(startedAt) < Date.parse(activatedAt) || Date.parse(finishedAt) < Date.parse(startedAt) ||
      (attempt.errorCode !== null && (typeof attempt.errorCode !== "string" || !/^[a-z0-9_-]{1,80}$/.test(attempt.errorCode))) ||
      (attempt.state === "succeeded" && attempt.errorCode !== null)) fail()
  const now = options.now === undefined ? Date.now() : options.now
  if (!Number.isSafeInteger(now) || now < 0 || Date.parse(finishedAt) > now || Date.parse(activatedAt) > now) fail()
  const latestSuccess = input.latestSuccess === null ? null : validateRecurringMediaManifest(input.latestSuccess)
  if (latestSuccess) {
    if (Date.parse(latestSuccess.startedAt) < Date.parse(activatedAt) || Date.parse(latestSuccess.finishedAt) > Date.parse(finishedAt) ||
        latestSuccess.scope.sourceBucket !== policy.sourceBucket || latestSuccess.scope.targetBucket !== policy.targetBucket ||
        latestSuccess.inventory.some(source => source.bucket !== policy.sourceBucket) ||
        latestSuccess.copies.some(copy => copy.target.bucket !== policy.targetBucket || !copy.target.objectName.startsWith(`${policy.targetPrefix}/`))) fail()
  }
  if (attempt.state === "succeeded" && (!latestSuccess || latestSuccess.runId !== runId || latestSuccess.startedAt !== startedAt || latestSuccess.finishedAt !== finishedAt)) fail()
  if (attempt.state !== "succeeded" && latestSuccess && (latestSuccess.runId === runId || Date.parse(latestSuccess.finishedAt) > Date.parse(startedAt))) fail()
  const retention = record(input.retention, ["mode", "deletionsEnabled"])
  if (!["dry-run", "disabled"].includes(retention.mode) || retention.deletionsEnabled !== false) fail()
  const budget = record(input.budget, ["state", "checkedAt", "projectedUsd", "limitUsd"])
  if (!["normal", "paused", "unknown"].includes(budget.state) || budget.limitUsd !== 10 ||
      Date.parse(time(budget.checkedAt)) > Date.parse(finishedAt) ||
      (budget.state === "paused") !== (attempt.state === "budget-paused")) fail()
  const result = {
    schema: STORAGE_MEDIA_HEALTH_SCHEMA, projectRef: input.projectRef, sourceBucket: input.sourceBucket, targetBucket: input.targetBucket, activatedAt,
    publication: { fence: publication.fence, owner: publication.owner },
    latestAttempt: { runId, startedAt, finishedAt, state: attempt.state, errorCode: attempt.errorCode }, latestSuccess,
    retention: { mode: retention.mode, deletionsEnabled: false },
    budget: { state: budget.state, checkedAt: budget.checkedAt, projectedUsd: money(budget.projectedUsd), limitUsd: 10 },
  }
  if (Buffer.byteLength(canonical(result)) > STORAGE_MEDIA_HEALTH_MAX_BYTES) fail()
  return result
}

/**
 * @param {{activatedAt: string, publication: {fence: number, owner: string}, latestAttempt: {runId: string, startedAt: string, finishedAt: string, state: string, errorCode: string|null}, latestSuccess?: ReturnType<typeof validateRecurringMediaManifest>|null, retention?: {mode: string, deletionsEnabled: boolean}, budget: {state: string, checkedAt: string, projectedUsd: number|null, limitUsd: number}}} input
 * @param {{activatedAt?: string, now?: number}} options
 */
export function buildStorageMediaHealthReceipt({ activatedAt, publication, latestAttempt, latestSuccess = null, retention = { mode: "dry-run", deletionsEnabled: false }, budget }, options = {}) {
  return validateStorageMediaHealthReceipt({
    schema: STORAGE_MEDIA_HEALTH_SCHEMA, projectRef: fcunoConnectionPolicy.supabase.projectRef,
    sourceBucket: policy.sourceBucket, targetBucket: policy.targetBucket, activatedAt, publication,
    latestAttempt, latestSuccess, retention, budget,
  }, options)
}

export function encodeStorageMediaHealthReceipt(value, options = {}) {
  return Buffer.from(canonical(validateStorageMediaHealthReceipt(value, options)), "utf8")
}

export function storageMediaHealthReceiptSha256(value, options = {}) {
  return createHash("sha256").update(encodeStorageMediaHealthReceipt(value, options)).digest("hex")
}

// Drive creation time is not a fencing token: an old stalled upload can arrive
// after a newer owner. Select the highest committed job fence and, within that
// owner, the latest finished attempt. Callers must supply a COMPLETE bounded
// listing; pagination beyond their bound is unknown, never a green fallback.
export function selectStorageMediaHealthFile(files) {
  if (!Array.isArray(files) || files.length > 1000) fail()
  const values = files.map(file => {
    const properties = file?.appProperties
    if (properties?.backupSchema !== STORAGE_MEDIA_HEALTH_SCHEMA || properties?.verified !== "true" ||
        !/^[a-f0-9]{64}$/.test(properties?.healthSha256 ?? "") || !/^[1-9]\d{0,15}$/.test(properties?.publicationFence ?? "")) fail()
    const fence = Number(properties.publicationFence), owner = identifier(properties.publicationOwner), finishedAt = time(properties.attemptFinishedAt)
    if (!Number.isSafeInteger(fence)) fail()
    return { file, fence, owner, finishedAt }
  })
  if (!values.length) return null
  const fence = Math.max(...values.map(value => value.fence)), current = values.filter(value => value.fence === fence)
  if (new Set(current.map(value => value.owner)).size !== 1) fail()
  current.sort((left, right) => Date.parse(right.finishedAt) - Date.parse(left.finishedAt))
  const latest = current.filter(value => value.finishedAt === current[0].finishedAt)
  if (new Set(latest.map(value => value.file.appProperties.healthSha256)).size !== 1) fail()
  return latest[0].file
}
