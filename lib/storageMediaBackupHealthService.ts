// Keep orchestration distinct from storageMediaBackupHealth.mjs: extensionless
// Webpack imports must not resolve the protocol module instead of this service.
import { createHash } from "node:crypto"
import type { drive_v3 } from "googleapis"
import { fcunoConnectionPolicy } from "../config/fcunoConnections"
import { backupDeadlineForFileChange, backupDueWindow, BACKUP_HOUR_MS, unknownBackupProtection } from "./backupProtectionPolicy"
import { validateInventory } from "./storageMediaBackup.mjs"
import { STORAGE_MEDIA_HEALTH_FOLDER, STORAGE_MEDIA_HEALTH_PREFIX, STORAGE_MEDIA_HEALTH_SCHEMA, STORAGE_MEDIA_HEALTH_MAX_BYTES,
  validateStorageMediaHealthReceipt, selectStorageMediaHealthFile } from "./storageMediaBackupHealth.mjs"
import type { StorageSourceIdentity } from "./storageMediaBackupSource"

type HealthResult = {
  status: "ok" | "warning" | "error"
  message: string
  details: Record<string, string | number | boolean | null>
}
export type StorageMediaInventoryStatus = {
  inventory: StorageSourceIdentity[]
  modifiedAtByIdentity: { id: string; version: string; modifiedAt: string | null }[]
}
export type StorageMediaHealthRuntime = { enabled?: string; activatedAt?: string }
const scope = fcunoConnectionPolicy.storageMediaBackup

function canonicalTime(value: unknown): number | null {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) return null
  return Date.parse(value)
}
function identityKey(source: StorageSourceIdentity) { return JSON.stringify([source.bucket, source.path, source.id, source.version, source.sizeBytes]) }
function unknown(message = "Uploaded-file backup protection could not be checked. It has not been marked as recovered."): HealthResult {
  return unknownBackupProtection(message)
}

// Source metadata is read independently from the authenticated cloud-job
// receipt. A current matching identity/version, not just an equal count, is
// required. Paths and IDs are deliberately excluded from returned details.
export function evaluateStorageMediaBackupHealth(input: {
  runtime: StorageMediaHealthRuntime
  receipt: unknown | null
  inventoryStatus: StorageMediaInventoryStatus | null
  now: number
  evidenceReadable?: boolean
}): HealthResult {
  const { runtime, now } = input
  if (runtime.enabled !== "1") return {
    status: "warning", message: "Recurring uploaded-file backups are not activated.",
    details: { notificationEligible: false, incidentResolved: false, protectionUnknown: true, recurringActivated: false,
      action: "Finish activation and verify the first cloud backup before relying on recurring protection." },
  }
  const activation = canonicalTime(runtime.activatedAt)
  if (!Number.isSafeInteger(now) || activation === null || activation > now) return unknown("The uploaded-file backup activation could not be verified.")
  if (input.evidenceReadable === false || !input.inventoryStatus) return unknown()
  let inventory: StorageSourceIdentity[]
  const changes = new Map<string, number | null>()
  try {
    inventory = validateInventory(input.inventoryStatus.inventory)
    if (inventory.some(source => source.bucket !== scope.sourceBucket) ||
        !Array.isArray(input.inventoryStatus.modifiedAtByIdentity) || input.inventoryStatus.modifiedAtByIdentity.length !== inventory.length) return unknown()
    for (const item of input.inventoryStatus.modifiedAtByIdentity) {
      const key = JSON.stringify([item.id, item.version])
      const modified = item.modifiedAt === null ? null : canonicalTime(item.modifiedAt)
      if (changes.has(key) || (item.modifiedAt !== null && modified === null) || (modified !== null && modified > now)) return unknown()
      changes.set(key, modified)
    }
    if (inventory.some(source => !changes.has(JSON.stringify([source.id, source.version])))) return unknown()
  } catch { return unknown() }
  const firstDeadline = backupDeadlineForFileChange(activation)
  let receipt: ReturnType<typeof validateStorageMediaHealthReceipt> | null = null
  if (input.receipt !== null) {
    try { receipt = validateStorageMediaHealthReceipt(input.receipt, { activatedAt: runtime.activatedAt, now }) }
    catch { return unknown("The uploaded-file backup receipt could not be verified. Existing protection has not been marked as recovered.") }
  }
  const success = receipt?.latestSuccess ?? null
  const covered = new Set<string>((success?.inventory ?? []).map(identityKey))
  const uncovered = inventory.filter(source => !covered.has(identityKey(source)))
  const missing = uncovered.filter(source => {
    const modifiedAt = changes.get(JSON.stringify([source.id, source.version]))
    return modifiedAt !== null && modifiedAt !== undefined && now >= Math.max(firstDeadline, backupDeadlineForFileChange(Math.max(modifiedAt, activation)))
  })
  const unknownChanges = uncovered.some(source => changes.get(JSON.stringify([source.id, source.version])) === null)
  const window = backupDueWindow(now)
  const scheduleDue = now >= firstDeadline && (!success || Date.parse(success.startedAt) < window.snapshotAt)
  const lastSuccessAt = success?.finishedAt ?? null
  const latestBudgetPaused = receipt?.latestAttempt.state === "budget-paused"
  const actionable = missing.length > 0 || scheduleDue
  const earliestDue = Math.min(...missing.map(source => Math.max(firstDeadline,
    backupDeadlineForFileChange(Math.max(changes.get(JSON.stringify([source.id, source.version]))!, activation))))
    , ...(scheduleDue ? [Math.max(firstDeadline, success ? backupDeadlineForFileChange(Date.parse(success.startedAt) + 1) : firstDeadline)] : []))
  const escalation = actionable && now - earliestDue >= 48 * BACKUP_HOUR_MS
  const base: HealthResult["details"] = {
    notificationEligible: actionable, incidentResolved: !actionable && !unknownChanges && !latestBudgetPaused && Boolean(success),
    alertLevel: escalation ? 2 : 1, recurringActivated: true,
    activeFiles: inventory.length, coveredFiles: inventory.length - uncovered.length, missingFiles: missing.length,
    pendingFiles: uncovered.length - missing.length, lastSuccessfulBackupAt: lastSuccessAt,
    backupDeadline: new Date(Math.max(firstDeadline, window.deadlineAt)).toISOString(),
    nextBackupDeadline: new Date(Math.max(firstDeadline, window.nextDeadlineAt)).toISOString(),
    backupSchedule: "Daily 02:00 Asia/Hong_Kong; retries until 06:00; publication grace until 06:15",
    budgetState: receipt?.budget.state ?? "unknown", budgetLimitUsd: 10,
    budgetProjectedUsd: receipt?.budget.projectedUsd ?? null,
    retentionMode: receipt?.retention.mode ?? "not verified", retentionDeletionsEnabled: false,
    action: actionable ? (latestBudgetPaused
      ? "Review the cloud budget pause and arrange a verified backup of the overdue files."
      : "Open System Health and arrange a verified uploaded-file backup.")
      : latestBudgetPaused ? "Review the cloud budget pause. Existing copies are preserved, but optional backup work is paused."
        : "No immediate action is needed. The next overnight backup will be checked automatically.",
  }
  if (actionable) return {
    status: escalation ? "error" : "warning",
    message: latestBudgetPaused ? "Uploaded-file backups are overdue while optional cloud work is paused for the budget."
      : missing.length ? `${missing.length} uploaded file(s) still need a verified backup after the deadline.`
        : "The overnight uploaded-file backup has not completed successfully.", details: base,
  }
  if (unknownChanges) return { ...unknown(), details: { ...base, ...unknown().details } }
  if (latestBudgetPaused) return { status: "warning", message: "Optional uploaded-file backup work is paused for the cloud budget. Existing copies are preserved.", details: base }
  if (!success) return { status: "warning", message: "Uploaded-file backups are activated; the first verified cloud run is still pending.", details: base }
  if (uncovered.length) return { status: "warning", message: `${uncovered.length} new or changed uploaded file(s) are waiting for the next overnight backup.`, details: { ...base, incidentResolved: false } }
  return { status: "ok", message: "Every current uploaded file has a recent verified cloud backup.", details: base }
}

type DriveReader = Pick<drive_v3.Drive, "files">
function escapeQuery(value: string) { return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'") }
function driveId(value: string) { if (!/^[A-Za-z0-9_-]{1,200}$/.test(value)) throw new Error("Invalid backup folder identity"); return value }

// The supplied client is the existing authenticated Drive client. No Google
// Cloud credential or native database credential is introduced into FCUNO.
export async function readStorageMediaHealthReceipt(input: {
  drive: DriveReader; rootFolderId: string; sharedDriveId: string | null; activatedAt: string; signal: AbortSignal; now: number
}): Promise<unknown | null> {
  const { drive, signal } = input
  const listingOptions = { supportsAllDrives: true, includeItemsFromAllDrives: true,
    corpora: input.sharedDriveId ? "drive" : undefined, driveId: input.sharedDriveId || undefined }
  const folder = async (parent: string, name: string) => {
    signal.throwIfAborted()
    const result = await drive.files.list({ ...listingOptions,
      q: `trashed = false and mimeType = 'application/vnd.google-apps.folder' and '${driveId(parent)}' in parents and name = '${escapeQuery(name)}'`,
      fields: "files(id,name),nextPageToken", pageSize: 2,
    }, { signal })
    signal.throwIfAborted()
    const files = result.data.files || []
    if (files.length > 1 || result.data.nextPageToken) throw new Error("Ambiguous backup folder")
    return files[0]?.id ? driveId(files[0].id) : null
  }
  const backupRoot = await folder(driveId(input.rootFolderId), "Bunker Map Backups")
  if (!backupRoot) return null
  const manifests = await folder(backupRoot, STORAGE_MEDIA_HEALTH_FOLDER)
  if (!manifests) return null
  const listed = await drive.files.list({ ...listingOptions,
    q: `trashed = false and mimeType = 'application/json' and '${manifests}' in parents and name contains '${STORAGE_MEDIA_HEALTH_PREFIX}'`,
    fields: "files(id,name,size,createdTime,appProperties),nextPageToken,incompleteSearch", pageSize: 1000, orderBy: "createdTime desc",
  }, { signal })
  signal.throwIfAborted()
  if (listed.data.nextPageToken !== undefined && listed.data.nextPageToken !== null ||
      listed.data.incompleteSearch !== undefined && listed.data.incompleteSearch !== false) throw new Error("Media backup receipt history is incomplete")
  const file = selectStorageMediaHealthFile(listed.data.files || [])
  if (!file) return null
  const properties = file.appProperties || {}
  const size = typeof file.size === "string" && /^[1-9]\d*$/.test(file.size) ? Number(file.size) : NaN
  if (!file.id || !file.name?.startsWith(STORAGE_MEDIA_HEALTH_PREFIX) || !Number.isSafeInteger(size) || size > STORAGE_MEDIA_HEALTH_MAX_BYTES ||
      properties.backupSchema !== STORAGE_MEDIA_HEALTH_SCHEMA || properties.verified !== "true" ||
      !/^[a-f0-9]{64}$/.test(properties.healthSha256 || "") || canonicalTime(file.createdTime) === null || Date.parse(file.createdTime!) > input.now) throw new Error("Invalid media backup receipt metadata")
  const response = await drive.files.get({ fileId: driveId(file.id), alt: "media", supportsAllDrives: true }, { responseType: "stream", signal })
  const chunks: Buffer[] = []
  let length = 0
  const stream = response.data as AsyncIterable<Uint8Array> & { destroy?: () => void }
  const cancel = () => stream.destroy?.()
  signal.addEventListener("abort", cancel, { once: true })
  try {
    for await (const chunk of stream) {
      signal.throwIfAborted()
      if (!(chunk instanceof Uint8Array)) throw new Error("Invalid receipt bytes")
      length += chunk.byteLength
      if (length > STORAGE_MEDIA_HEALTH_MAX_BYTES || length > size) throw new Error("Oversized media backup receipt")
      chunks.push(Buffer.from(chunk))
    }
    signal.throwIfAborted()
    const bytes = Buffer.concat(chunks)
    if (length !== size || createHash("sha256").update(bytes).digest("hex") !== properties.healthSha256) throw new Error("Media backup receipt digest mismatch")
    const receipt = validateStorageMediaHealthReceipt(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), { activatedAt: input.activatedAt, now: input.now })
    if (receipt.publication.fence !== Number(properties.publicationFence) || receipt.publication.owner !== properties.publicationOwner ||
        receipt.latestAttempt.finishedAt !== properties.attemptFinishedAt) throw new Error("Media backup publication fence does not match")
    if (Date.parse(receipt.latestAttempt.finishedAt) > Date.parse(file.createdTime!)) throw new Error("Receipt publication predates completion")
    return receipt
  } finally {
    signal.removeEventListener("abort", cancel)
    stream.destroy?.()
  }
}
