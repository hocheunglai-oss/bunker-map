import { BACKUP_HOUR_MS, BACKUP_PUBLICATION_GRACE_MS, backupDeadlineForFileChange, backupDueWindow } from "./backupProtectionPolicy"

// Backups take a snapshot at 02:00 Hong Kong time and may retry until 06:00.
// Compare against the last deadline that has passed, never the current retry
// window: starting a new attempt must not hide yesterday's unresolved failure.

export type ActiveDriveBackupFile = {
  id: string
  name: string
  createdAt: string | null
  updatedAt: string | null
}

export type DriveBackupManifest = Record<string, unknown>

type ManifestEvidence = {
  manifest: DriveBackupManifest
  startedAt: number
  completedAt: number | null
  verified: boolean
  failed: boolean
  files: Map<string, Record<string, unknown>>
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function timestamp(value: unknown): number | null {
  if (typeof value !== "string" || !value) return null
  const result = Date.parse(value)
  return Number.isFinite(result) ? result : null
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0
}

export function driveBackupDeadlineForChange(changedAt: number): number {
  return backupDeadlineForFileChange(changedAt)
}

export function hasDriveBackupObjectProof(value: unknown): boolean {
  const file = record(value)
  return (file.status === "uploaded" || (file.status === "skipped" && file.reason === "Unchanged"))
    && typeof file.objectName === "string" && file.objectName.trim().length > 0
    && typeof file.generation === "string" && /^\d+$/.test(file.generation)
    && typeof file.id === "string" && file.id.length > 0
}

function evidence(manifest: DriveBackupManifest, now: number): ManifestEvidence | null {
  const startedAt = timestamp(manifest.generatedAt)
  if (startedAt === null || startedAt > now) return null
  const finishedAt = timestamp(manifest.finishedAt)
  const completedAt = finishedAt !== null && finishedAt >= startedAt && finishedAt <= now ? finishedAt : null
  const counts = record(manifest.counts)
  const listedFiles = Array.isArray(manifest.files) ? manifest.files : []
  const failures = Array.isArray(manifest.failures) ? manifest.failures : []
  const totalFiles = count(counts.totalFiles)
  const files = new Map<string, Record<string, unknown>>()
  // A scheduler acknowledgement, in-progress manifest or unsupported skip is
  // not evidence that any file has been durably backed up.
  if (completedAt !== null && (manifest.schemaVersion === undefined || manifest.schemaVersion === 2)
    && (manifest.status === undefined || manifest.status === "succeeded" || manifest.status === "failed")) {
    for (const value of listedFiles) {
      if (hasDriveBackupObjectProof(value)) {
        const file = record(value)
        files.set(String(file.id), file)
      }
    }
  }
  const verification = record(manifest.verification)
  const verificationTime = timestamp(verification.completedAt)
  const currentContract = manifest.schemaVersion === 2
  const legacyContract = manifest.schemaVersion === undefined
  const contractVerified = currentContract
    ? manifest.status === "succeeded" && verification.status === "verified"
      && verification.checkedFiles === totalFiles
      && verificationTime !== null && verificationTime >= startedAt && completedAt !== null && verificationTime <= completedAt
    : legacyContract && (manifest.status === undefined || manifest.status === "succeeded")
  const completeListing = Number.isInteger(counts.totalFiles) && totalFiles === listedFiles.length
    && files.size === listedFiles.length
    && count(counts.uploaded) + count(counts.skipped) === totalFiles
  const verified = completedAt !== null && contractVerified && completeListing
    && counts.failed === 0 && failures.length === 0
  // Legacy manifests have no supported per-entry verification contract. Their
  // individual references are trusted only when the WHOLE legacy manifest is
  // verified. Unlike completed v2 entries, failed legacy rows cannot establish
  // coverage or clear an existing missing-file incident.
  if (legacyContract && !verified) files.clear()
  return {
    manifest, startedAt, completedAt, verified, files,
    failed: manifest.status === "failed" || count(counts.failed) > 0 || failures.length > 0
      || (completedAt !== null && !verified),
  }
}

export function isVerifiedDriveBackupManifest(manifest: DriveBackupManifest, now = Date.now()): boolean {
  return evidence(manifest, now)?.verified === true
}

type DriveHealthInput = {
  activeFiles: ActiveDriveBackupFile[]
  manifests: DriveBackupManifest[]
  now?: number
  firstDueByFileId?: ReadonlyMap<string, number>
  firstScheduleDueAt?: number
}

function analyzeDriveProtection({ activeFiles, manifests, now = Date.now(), firstDueByFileId, firstScheduleDueAt }: DriveHealthInput) {
  const snapshots = manifests.map((manifest) => evidence(manifest, now))
    .filter((item): item is ManifestEvidence => item !== null)
    .sort((a, b) => b.startedAt - a.startedAt)
  const latest = snapshots[0]
  const latestUnreadable = manifests.length > 0 && evidence(manifests[0], now) === null
  const lastSuccess = snapshots.find((item) => item.verified)
  const window = backupDueWindow(now)
  const uniqueActive = new Map<string, ActiveDriveBackupFile>()
  for (const file of activeFiles) {
    const previous = uniqueActive.get(file.id)
    const change = Math.max(timestamp(file.createdAt) ?? 0, timestamp(file.updatedAt) ?? 0)
    const previousChange = previous ? Math.max(timestamp(previous.createdAt) ?? 0, timestamp(previous.updatedAt) ?? 0) : -1
    if (change > previousChange) uniqueActive.set(file.id, file)
  }
  const missing: ActiveDriveBackupFile[] = []
  const pending: ActiveDriveBackupFile[] = []
  const gaps: Array<{ fileId: string | null; dueAt: string; requiredSinceAt: string; coveredThroughAt?: string }> = []
  let oldestMissingDeadline: number | null = null
  for (const file of uniqueActive.values()) {
    const changedAt = Math.max(timestamp(file.createdAt) ?? 0, timestamp(file.updatedAt) ?? 0)
    const covered = snapshots.some((snapshot) => snapshot.completedAt !== null
      && snapshot.startedAt >= changedAt && snapshot.files.has(file.id))
    if (covered) continue
    const newDue = changedAt ? driveBackupDeadlineForChange(changedAt) : window.deadlineAt
    const due = Math.min(newDue, firstDueByFileId?.get(file.id) ?? newDue)
    // A supported completed v2 attempt records each generation only after its
    // own upload/checksum proof. Another file failing does not erase that proof;
    // only a fully verified manifest can establish GLOBAL scheduled recovery.
    const lastCovered = snapshots.find((snapshot) => snapshot.files.has(file.id)
      && (snapshot.verified || snapshot.manifest.schemaVersion === 2 && snapshot.completedAt !== null))
    gaps.push({ fileId: file.id, dueAt: new Date(due).toISOString(), requiredSinceAt: new Date(changedAt || window.snapshotAt).toISOString(),
      ...(lastCovered ? { coveredThroughAt: new Date(lastCovered.startedAt).toISOString() } : {}) })
    if (now < due) pending.push(file)
    else {
      missing.push(file)
      oldestMissingDeadline = oldestMissingDeadline === null ? due : Math.min(oldestMissingDeadline, due)
    }
  }
  // An installation with only new, not-yet-due files has no missed overnight
  // obligation. A new run must not hide an older established obligation.
  const requiredFiles = [...uniqueActive.values()].some((file) => {
    const changed = Math.max(timestamp(file.createdAt) ?? 0, timestamp(file.updatedAt) ?? 0)
    return !changed || changed <= window.snapshotAt
  }) || missing.length > 0
  const overdue = requiredFiles && (!lastSuccess || lastSuccess.startedAt < window.snapshotAt)
  const newScheduleDue = lastSuccess
    ? backupDeadlineForFileChange(lastSuccess.startedAt + 1)
    : window.deadlineAt
  const scheduleDue = Math.min(newScheduleDue, firstScheduleDueAt ?? newScheduleDue)
  if (overdue) gaps.push({ fileId: null, dueAt: new Date(scheduleDue).toISOString(), requiredSinceAt: new Date(newScheduleDue - 4 * BACKUP_HOUR_MS - BACKUP_PUBLICATION_GRACE_MS).toISOString(),
    ...(lastSuccess ? { coveredThroughAt: new Date(lastSuccess.startedAt).toISOString() } : {}) })
  const latestAttemptUnresolved = Boolean(latest && !latest.verified
    && (!lastSuccess || latest.startedAt >= lastSuccess.startedAt))
  const ageHours = lastSuccess?.completedAt !== null && lastSuccess?.completedAt !== undefined
    ? Math.round((now - lastSuccess.completedAt) / 36_000) / 100 : null
  const escalation = (overdue && ((lastSuccess?.completedAt !== null && lastSuccess?.completedAt !== undefined
    && now - lastSuccess.completedAt >= 48 * BACKUP_HOUR_MS) || now - scheduleDue >= 48 * BACKUP_HOUR_MS))
    || (oldestMissingDeadline !== null && now - oldestMissingDeadline >= 48 * BACKUP_HOUR_MS)
  const latestManifest = latest?.manifest ?? {}
  const counts = record(latestManifest.counts)
  const gcs = record(latestManifest.gcs)
  const storageBytes = count(counts.estimatedCurrentStorageBytes)
  const limitBytes = count(gcs.freeTierStorageLimitBytes)
  const usedPercent = limitBytes ? Math.round(storageBytes / limitBytes * 10_000) / 100 : 0
  const storageNearLimit = limitBytes > 0 && usedPercent >= 80
  const outsideFreeRegion = typeof gcs.location === "string" && Boolean(gcs.location) && limitBytes === 0
  const backupProblem = overdue || missing.length > 0
  const notificationEligible = backupProblem
  const verifiedHealthy = Boolean(lastSuccess) && !backupProblem && latest?.manifest.status !== "running"
  const filesLabel = missing.length === 1 ? "1 file is" : `${missing.length} files are`
  const message = missing.length ? `${filesLabel} still missing a verified backup after the backup deadline`
    : overdue ? "The overnight file backup has not completed successfully."
    : pending.length ? `${pending.length} new or changed file(s) pending the next scheduled backup`
    : latestUnreadable && !lastSuccess ? "File backup evidence could not be verified."
    : outsideFreeRegion ? "Drive file backup storage is outside the free-tier region"
    : storageNearLimit ? "Drive file backup storage is close to the free-tier storage limit"
    : latestAttemptUnresolved && !verifiedHealthy ? "Drive file backup is running or retrying before the deadline"
    : "All eligible active files have a verified Drive file backup"
  return {
    status: (notificationEligible ? (escalation ? "error" : "warning") : storageNearLimit || outsideFreeRegion || latestUnreadable && !lastSuccess ? "warning" : "ok") as "ok" | "warning" | "error",
    message,
    details: {
      alertKey: "drive-file-content-protection",
      alertLevel: escalation ? 2 : 1,
      notificationEligible,
      // An in-progress attempt must not close/re-arm an unresolved incident.
      incidentResolved: verifiedHealthy,
      activeFiles: uniqueActive.size,
      coveredFiles: uniqueActive.size - missing.length - pending.length,
      missingFiles: missing.length,
      pendingFiles: pending.length,
      coverage: `${uniqueActive.size - missing.length - pending.length} / ${uniqueActive.size}`,
      missingFileNames: missing.map((file) => file.name || "Unnamed file").slice(0, 20).join("; "),
      pendingFileNames: pending.map((file) => file.name || "Unnamed file").slice(0, 20).join("; "),
      lastSuccessfulBackupAt: lastSuccess?.completedAt ? new Date(lastSuccess.completedAt).toISOString() : null,
      lastBackupAttemptAt: latest ? new Date(latest.startedAt).toISOString() : null,
      nextBackupDeadline: new Date(window.nextDeadlineAt).toISOString(),
      oldestMissingDeadline: oldestMissingDeadline === null ? null : new Date(oldestMissingDeadline).toISOString(),
      backupSchedule: "Daily 02:00 Asia/Hong_Kong; retries until 06:00; publication grace until 06:15",
      ageHours,
      totalFiles: count(counts.totalFiles),
      uploadedFiles: count(counts.uploaded),
      skippedFiles: count(counts.skipped),
      failedFiles: count(counts.failed),
      estimatedStorageGiB: Math.round(storageBytes / 1024 ** 3 * 1000) / 1000,
      freeTierLimitGiB: Math.round(limitBytes / 1024 ** 3 * 1000) / 1000,
      freeTierRemainingGiB: Math.round((limitBytes - storageBytes) / 1024 ** 3 * 1000) / 1000,
      freeTierUsedPercent: usedPercent,
      gcsLocation: String(gcs.location || ""),
      storageAdvice: storageNearLimit || outsideFreeRegion,
      action: backupProblem
        ? "Open System Health and arrange a verified backup of the missing files."
        : storageNearLimit || outsideFreeRegion
          ? "Review backup storage usage and retention before the free allowance is exceeded."
          : "No action required; new files are picked up by the next scheduled backup.",
    },
    gaps,
  }
}

// Sparse internal evidence only; never include this array or Drive IDs in the
// public health response or the notification-state table.
export function getDriveFileBackupGaps(input: DriveHealthInput) {
  return analyzeDriveProtection(input).gaps
}

export function evaluateDriveFileBackupHealth(input: DriveHealthInput): {
  status: "ok" | "warning" | "error"
  message: string
  details: Record<string, string | number | boolean | null>
} {
  const result = analyzeDriveProtection(input)
  return { status: result.status, message: result.message, details: result.details }
}
