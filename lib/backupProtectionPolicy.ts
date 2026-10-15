// Pure policy shared by the dashboard and the notification-only observer.
// These are protection deadlines, not evidence that a scheduler actually ran.
export const BACKUP_HOUR_MS = 3_600_000
export const BACKUP_DAY_MS = 24 * BACKUP_HOUR_MS
export const BACKUP_PUBLICATION_GRACE_MS = 15 * 60_000
const HKT_OFFSET_MS = 8 * BACKUP_HOUR_MS

export type BackupGapDomain = "database" | "drive-file"
export type BackupGapInput = {
  key: string
  dueAt: string
  coveredThroughAt?: string
  requiredSinceAt?: string
  requiredVersion?: string
  requiredFingerprint?: string
  coveredVersion?: string
  coveredFingerprint?: string
}
export type BackupProtectionGap = { key: string; firstUncoveredAt: string; firstDueAt: string }
export type BackupGapObservation = {
  domain: BackupGapDomain
  observedAt: string
  gaps: BackupGapInput[]
  complete: boolean
}
export type BackupGapObservationResult = {
  schema: "fcuno.backup-protection-gaps/v1"
  domain: BackupGapDomain
  accepted: boolean
  observedAt: string
  gaps: BackupProtectionGap[]
}
export type BackupGapObserver = (observation: BackupGapObservation) => Promise<BackupGapObservationResult>

// Never convert a storage/ordering failure into a backup failure or send an
// email from an observation that was not durably accepted.
export class BackupProtectionObservationError extends Error {
  constructor(message = "Backup protection could not be recorded. No alert was sent.") {
    super(message)
    this.name = "BackupProtectionObservationError"
  }
}

export function backupDayStart(time: number): number {
  return Math.floor((time + HKT_OFFSET_MS) / BACKUP_DAY_MS) * BACKUP_DAY_MS - HKT_OFFSET_MS
}

export function backupDueWindow(now: number) {
  const today = backupDayStart(now)
  const todayDeadline = today + 6 * BACKUP_HOUR_MS + BACKUP_PUBLICATION_GRACE_MS
  const day = now >= todayDeadline ? today : today - BACKUP_DAY_MS
  return {
    snapshotAt: day + 2 * BACKUP_HOUR_MS,
    databaseFinalAttemptAt: day + 5 * BACKUP_HOUR_MS + 2 * 60_000,
    // All three database retries may legitimately reuse this recent receipt,
    // including a manual backup from the preceding evening.
    databaseEarliestReceiptAt: day - BACKUP_HOUR_MS + 2 * 60_000,
    deadlineAt: day + 6 * BACKUP_HOUR_MS + BACKUP_PUBLICATION_GRACE_MS,
    nextDeadlineAt: day + BACKUP_DAY_MS + 6 * BACKUP_HOUR_MS + BACKUP_PUBLICATION_GRACE_MS,
  }
}

export function backupDeadlineForFileChange(changedAt: number): number {
  const snapshot = backupDayStart(changedAt) + 2 * BACKUP_HOUR_MS
  return (changedAt <= snapshot ? snapshot : snapshot + BACKUP_DAY_MS)
    + 4 * BACKUP_HOUR_MS + BACKUP_PUBLICATION_GRACE_MS
}

export function validBackupTime(value: unknown): number | null {
  if (typeof value !== "string" || !value) return null
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : null
}

export function firstGapDue(gaps: readonly BackupProtectionGap[], key: string, fallback: number): number {
  const saved = validBackupTime(gaps.find((gap) => gap.key === key)?.firstDueAt)
  return saved === null ? fallback : Math.min(saved, fallback)
}

export function unknownBackupProtection(message = "Backup protection could not be checked. It has not been marked as recovered.") {
  return {
    status: "warning" as const,
    message,
    details: {
      notificationEligible: false,
      incidentResolved: false,
      protectionUnknown: true,
      action: "Open System Health to check backup access and try the check again.",
    },
  }
}

export function evaluateDatabaseBackupProtection({ now, receiptCreatedAt, generatedAt, inventoryCurrent, gaps = [], advisory = false }: {
  now: number
  receiptCreatedAt: string | null
  generatedAt?: string | null
  inventoryCurrent: boolean | null
  gaps?: readonly BackupProtectionGap[]
  advisory?: boolean
}) {
  const window = backupDueWindow(now)
  const receipt = validBackupTime(receiptCreatedAt)
  const usableReceipt = receipt !== null && receipt <= now
  const availabilityMissing = !usableReceipt || receipt < window.databaseEarliestReceiptAt
  const availabilityDue = firstGapDue(gaps, "availability", window.deadlineAt)
  const schemaDue = firstGapDue(gaps, "inventory", window.nextDeadlineAt)
  const schemaOverdue = inventoryCurrent === false && now >= schemaDue
  const actionable = availabilityMissing || schemaOverdue
  const escalation = (availabilityMissing && (
    (usableReceipt && now - receipt >= 48 * BACKUP_HOUR_MS)
    || now - availabilityDue >= 48 * BACKUP_HOUR_MS
  )) || (schemaOverdue && now - schemaDue >= 48 * BACKUP_HOUR_MS)
  const healthy = !availabilityMissing && inventoryCurrent === true
  return {
    status: actionable ? (escalation ? "error" as const : "warning" as const)
      : advisory || inventoryCurrent !== true ? "warning" as const : "ok" as const,
    message: availabilityMissing
      ? "The overnight database backup is missing or older than expected."
      : schemaOverdue ? "The database backup still does not include the latest system changes."
      : inventoryCurrent === false ? "The latest system changes are waiting for the next overnight database backup."
      : advisory ? "Database protection is verified; backup metadata needs review on the dashboard."
      : "The database has a recent verified backup.",
    details: {
      notificationEligible: actionable,
      incidentResolved: healthy,
      alertLevel: escalation ? 2 : 1,
      lastSuccessfulBackupAt: generatedAt || receiptCreatedAt,
      backupDeadline: new Date(window.deadlineAt).toISOString(),
      nextBackupDeadline: new Date(window.nextDeadlineAt).toISOString(),
      schemaBackupDeadline: inventoryCurrent === false ? new Date(schemaDue).toISOString() : null,
      action: actionable ? "Open System Health and arrange a verified database backup."
        : "No immediate action is needed. The next overnight backup will be checked automatically.",
    },
  }
}
