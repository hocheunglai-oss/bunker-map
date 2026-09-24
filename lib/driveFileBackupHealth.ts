// Backups take a snapshot at 02:00 Hong Kong time and may retry until 06:00.
// Compare against the last deadline that has passed, never the current retry
// window: starting a new attempt must not hide yesterday's unresolved failure.
const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const HONG_KONG_OFFSET_MS = 8 * HOUR_MS
const RETRY_WINDOW_MS = 4 * HOUR_MS

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

function snapshotStartForDay(time: number) {
  return Math.floor((time + HONG_KONG_OFFSET_MS) / DAY_MS) * DAY_MS
    - HONG_KONG_OFFSET_MS + 2 * HOUR_MS
}

export function driveBackupDeadlineForChange(changedAt: number): number {
  const dayStart = snapshotStartForDay(changedAt)
  return (changedAt <= dayStart ? dayStart : dayStart + DAY_MS) + RETRY_WINDOW_MS
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
  if (completedAt !== null && (manifest.status === undefined || manifest.status === "succeeded" || manifest.status === "failed")) {
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
  return {
    manifest, startedAt, completedAt, verified, files,
    failed: manifest.status === "failed" || count(counts.failed) > 0 || failures.length > 0
      || (completedAt !== null && !verified),
  }
}

export function isVerifiedDriveBackupManifest(manifest: DriveBackupManifest, now = Date.now()): boolean {
  return evidence(manifest, now)?.verified === true
}

export function evaluateDriveFileBackupHealth({
  activeFiles,
  manifests,
  now = Date.now(),
}: {
  activeFiles: ActiveDriveBackupFile[]
  manifests: DriveBackupManifest[]
  now?: number
}): {
  status: "ok" | "warning" | "error"
  message: string
  details: Record<string, string | number | boolean | null>
} {
  const snapshots = manifests.map((manifest) => evidence(manifest, now))
    .filter((item): item is ManifestEvidence => item !== null)
    .sort((a, b) => b.startedAt - a.startedAt)
  const latest = snapshots[0]
  const latestUnreadable = manifests.length > 0 && evidence(manifests[0], now) === null
  const lastSuccess = snapshots.find((item) => item.verified)
  const todayStart = snapshotStartForDay(now)
  const dueStart = now >= todayStart + RETRY_WINDOW_MS ? todayStart : todayStart - DAY_MS
  const nextDeadline = now < todayStart + RETRY_WINDOW_MS
    ? todayStart + RETRY_WINDOW_MS : todayStart + DAY_MS + RETRY_WINDOW_MS
  const overdue = !lastSuccess || lastSuccess.startedAt < dueStart
  const uniqueActive = new Map<string, ActiveDriveBackupFile>()
  for (const file of activeFiles) {
    const previous = uniqueActive.get(file.id)
    const change = Math.max(timestamp(file.createdAt) ?? 0, timestamp(file.updatedAt) ?? 0)
    const previousChange = previous ? Math.max(timestamp(previous.createdAt) ?? 0, timestamp(previous.updatedAt) ?? 0) : -1
    if (change > previousChange) uniqueActive.set(file.id, file)
  }
  const missing: ActiveDriveBackupFile[] = []
  const pending: ActiveDriveBackupFile[] = []
  for (const file of uniqueActive.values()) {
    const changedAt = Math.max(timestamp(file.createdAt) ?? 0, timestamp(file.updatedAt) ?? 0)
    const covered = snapshots.some((snapshot) => snapshot.completedAt !== null
      && snapshot.startedAt >= changedAt && snapshot.files.has(file.id))
    if (covered) continue
    if (changedAt && now < driveBackupDeadlineForChange(changedAt)) pending.push(file)
    else missing.push(file)
  }
  const latestRetryDeadline = latest ? snapshotStartForDay(latest.startedAt) + RETRY_WINDOW_MS : null
  const latestAttemptUnresolved = Boolean(latest && !latest.verified
    && (!lastSuccess || latest.startedAt >= lastSuccess.startedAt))
  const failureDue = latestAttemptUnresolved && latestRetryDeadline !== null && now >= latestRetryDeadline
  const ageHours = lastSuccess?.completedAt !== null && lastSuccess?.completedAt !== undefined
    ? Math.round((now - lastSuccess.completedAt) / 36_000) / 100 : null
  const oldestSeen = snapshots.at(-1)?.startedAt
  const escalation = lastSuccess?.completedAt !== null && lastSuccess?.completedAt !== undefined
    ? now - lastSuccess.completedAt >= 48 * HOUR_MS
    : oldestSeen !== undefined && now - oldestSeen >= 48 * HOUR_MS
  const latestManifest = latest?.manifest ?? {}
  const counts = record(latestManifest.counts)
  const gcs = record(latestManifest.gcs)
  const storageBytes = count(counts.estimatedCurrentStorageBytes)
  const limitBytes = count(gcs.freeTierStorageLimitBytes)
  const usedPercent = limitBytes ? Math.round(storageBytes / limitBytes * 10_000) / 100 : 0
  const storageNearLimit = limitBytes > 0 && usedPercent >= 80
  const outsideFreeRegion = typeof gcs.location === "string" && Boolean(gcs.location) && limitBytes === 0
  const backupProblem = overdue || missing.length > 0 || failureDue || latestUnreadable
  const notificationEligible = backupProblem || storageNearLimit || outsideFreeRegion
  const filesLabel = missing.length === 1 ? "1 file is" : `${missing.length} files are`
  const message = latestUnreadable || !latest ? "No readable, completed Drive file backup evidence was found"
    : overdue ? "The scheduled Drive file backup has not completed successfully by 06:00 Hong Kong time"
    : failureDue ? "The latest Drive file backup has not been verified successfully"
    : missing.length ? `${filesLabel} still missing a verified backup after the backup deadline`
    : outsideFreeRegion ? "Drive file backup storage is outside the free-tier region"
    : storageNearLimit ? "Drive file backup storage is close to the free-tier storage limit"
    : pending.length ? `${pending.length} new or changed file(s) pending the next scheduled backup`
    : latestAttemptUnresolved ? "Drive file backup is running or retrying before the 06:00 deadline"
    : "All eligible active files have a verified Drive file backup"
  return {
    status: notificationEligible ? (backupProblem && escalation ? "error" : "warning") : "ok",
    message,
    details: {
      alertKey: "drive-file-backup",
      alertLevel: backupProblem && escalation ? 2 : 1,
      notificationEligible,
      // An in-progress attempt must not close/re-arm an unresolved incident.
      incidentResolved: !notificationEligible && !latestAttemptUnresolved && Boolean(lastSuccess),
      activeFiles: uniqueActive.size,
      coveredFiles: uniqueActive.size - missing.length - pending.length,
      missingFiles: missing.length,
      pendingFiles: pending.length,
      coverage: `${uniqueActive.size - missing.length - pending.length} / ${uniqueActive.size}`,
      missingFileNames: missing.map((file) => file.name || file.id).slice(0, 20).join("; "),
      pendingFileNames: pending.map((file) => file.name || file.id).slice(0, 20).join("; "),
      lastSuccessfulBackupAt: lastSuccess?.completedAt ? new Date(lastSuccess.completedAt).toISOString() : null,
      lastBackupAttemptAt: latest ? new Date(latest.startedAt).toISOString() : null,
      nextBackupDeadline: new Date(nextDeadline).toISOString(),
      backupSchedule: "Daily 02:00 Asia/Hong_Kong; retries until 06:00",
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
      action: backupProblem
        ? "Check the Cloud Run backup execution and its failure details, retry the failed files, and verify a completed backup."
        : storageNearLimit || outsideFreeRegion
          ? "Review backup storage usage and retention before the free allowance is exceeded."
          : "No action required; new files are picked up by the next scheduled backup.",
    },
  }
}
