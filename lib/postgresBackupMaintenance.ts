import { fcunoConnectionPolicy } from "@/config/fcunoConnections"
import { isAdminRole } from "@/lib/adminPages"
import { isValidEmailAddress } from "@/lib/emailAddress"
import { deliverHealthAlerts, type HealthAlertStore } from "@/lib/systemHealthAlerts"
import type { HealthCheck } from "@/lib/systemHealth"
import type { ManagedAdminUser } from "@/lib/adminUsers"
import { createHash } from "node:crypto"
import { validateRecoveryAcceptanceDescriptor } from "@/lib/postgresRecoveryAcceptance.mjs"
import { validatePostgresManifestReceipt } from "@/lib/postgresBackupReceipt.mjs"
import { RECOVERY_POSTGRES_IMAGE } from "@/lib/postgresRecoveryEvidence.mjs"

const DAY = 86400000
const ids = new Set(["postgresql-backup-access-renewal", "postgresql-backup-recovery-renewal"])
type Kind = "credential" | "recovery"
type Administrator = Pick<ManagedAdminUser, "email" | "role" | "isActive" | "emailVerified">

export function isPostgresBackupMaintenanceCheck(check: Pick<HealthCheck, "id">) {
  return ids.has(check.id)
}

// Deliberately independent of the ordinary System Health/calendar staff list.
// This validates configuration syntax only; delivery rechecks every account.
export function getPostgresBackupMaintenanceRecipients(runtime: Record<string, string | undefined>): string[] {
  const configured = runtime.POSTGRES_BACKUP_MAINTENANCE_EMAIL_RECIPIENTS
  if (typeof configured !== "string" || configured.length > 16384) throw Error("Independent backup maintenance administrator recipients are not configured.")
  const recipients = [...new Set(configured.split(/[,;\n]/).map(value => value.trim().toLowerCase()).filter(Boolean))]
  if (!recipients.length || recipients.length > 1000 || recipients.some(value => !isValidEmailAddress(value))) {
    throw Error("Independent backup maintenance administrator recipients are not configured.")
  }
  return recipients
}

// Pure maintenance advice, not proof that a backup currently succeeds. The
// source credential window comes only from the trusted source configuration;
// recovery dates must come from independently verified immutable receipts.
export function postgresBackupMaintenanceCheck(input: {
  kind: Kind; enabled: boolean; now: number; validFrom: number | null; validUntil: number | null
}): HealthCheck {
  if (!["credential", "recovery"].includes(input.kind) || !Number.isSafeInteger(input.now) || input.now < 0) throw Error("Invalid backup maintenance context")
  const credential = input.kind === "credential"
  const base = { id: credential ? "postgresql-backup-access-renewal" : "postgresql-backup-recovery-renewal",
    label: credential ? "Independent backup access" : "Independent backup recovery test", checkedAt: new Date(input.now).toISOString() }
  const details = { notificationAudience: "verified-administrators-only", alertLevel: 1,
    evidence: credential ? "configured-source-credential-expiry" : "verified-cloud-recovery-receipt",
    automaticRenewal: false, existingCopiesChanged: false }
  const start = input.validFrom, end = input.validUntil
  if (!input.enabled || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start === null || end === null ||
    start < 0 || start > input.now || end <= start || end - start > 90 * DAY || (input.kind === "recovery" && end - start !== 90 * DAY)) {
    return { ...base, status: "warning", message: "Backup renewal dates have not been verified.", details: {
      ...details, notificationEligible: false, incidentResolved: false, action: "Verify the backup maintenance dates in System Health." } }
  }
  const remaining = end - input.now, upcoming = remaining <= 14 * DAY, expired = remaining <= 0
  const description = credential ? "backup access" : "backup recovery test"
  const message = expired ? `The independent ${description} needs renewal before weekly copies can continue.`
    : upcoming ? `The independent ${description} needs renewal within ${Math.ceil(remaining / DAY)} days.`
      : `The independent ${description} renewal is not due yet.`
  return { ...base, status: expired ? "error" : upcoming ? "warning" : "ok", message, details: {
    ...details, expiresAt: new Date(end).toISOString(), notificationEligible: upcoming, incidentResolved: !upcoming,
    // Keep the same incident level at expiry: no daily/reminder escalation mail.
    action: credential ? "Ask the FC Uno administrator to renew backup-only access. Existing copies are not changed."
      : "Ask the FC Uno administrator to run the isolated cloud recovery test. Existing copies are not changed." } }
}

// Does not execute SQL, open a connection, read native binaries or return any
// password. Production role expiry must still be verified during provisioning.
export function getPostgresSourceMaintenanceCheck(runtime: Record<string, string | undefined>, now = Date.now()): HealthCheck | null {
  if (runtime.POSTGRES_BACKUP_SOURCE_ENABLED !== "1") return null
  const input = { kind: "credential" as const, enabled: true, now, validFrom: null as number | null, validUntil: null as number | null }
  try {
    if (runtime.VERCEL !== "1" || runtime.VERCEL_ENV !== "production" || runtime.VERCEL_PROJECT_ID !== fcunoConnectionPolicy.vercel.projectId) throw Error("Unverified source")
    const serialized = runtime.POSTGRES_BACKUP_SOURCE_CREDENTIAL_JSON
    if (typeof serialized !== "string" || serialized.length > 1024) throw Error("Unverified source")
    const value = JSON.parse(serialized)
    if (!value || Object.keys(value).sort().join(",") !== "expiresAt,issuedAt,password" ||
      typeof value.password !== "string" || !/^[A-Za-z0-9_-]{43,128}$/.test(value.password) || value.password.startsWith("sbp_")) throw Error("Unverified source")
    input.validFrom = value.issuedAt; input.validUntil = value.expiresAt
  } catch { /* Never disclose raw configuration or exception text. */ }
  const check = postgresBackupMaintenanceCheck(input)
  try {
    getPostgresBackupMaintenanceRecipients(runtime)
  } catch {
    return { ...check, status: "error", message: "Independent backup maintenance has no valid administrator notification list.", details: {
      ...check.details, notificationEligible: false, incidentResolved: false,
      action: "Configure the dedicated backup maintenance list with verified FC Uno administrators. Staff notification lists are not used." } }
  }
  return check
}

// This is a source-owned OPERATOR ATTESTATION installed only after independent
// immutable GCS readback, source-signature verification and the real cloud
// restore. It is not accepted from a request, and is never an export admission
// input. Matching these cached bytes does NOT repeat any remote verification.
export function getPostgresRecoveryMaintenanceCheck(runtime: Record<string, string | undefined>, now = Date.now()): HealthCheck | null {
  if (runtime.POSTGRES_BACKUP_SOURCE_ENABLED !== "1") return null
  let validFrom: number | null = null, validUntil: number | null = null, operatorCheckedAt: string | null = null
  try {
    if (runtime.VERCEL !== "1" || runtime.VERCEL_ENV !== "production" || runtime.VERCEL_PROJECT_ID !== fcunoConnectionPolicy.vercel.projectId) throw Error("Unverified source")
    const serialized = runtime.POSTGRES_BACKUP_RECOVERY_MAINTENANCE_JSON
    if (typeof serialized !== "string" || Buffer.byteLength(serialized) > 32768) throw Error("Invalid maintenance evidence")
    const record = JSON.parse(serialized)
    const exact = (value: unknown, names: string[]) => {
      if (!value || typeof value !== "object" || Object.keys(value).sort().join(",") !== names.sort().join(",")) throw Error("Invalid maintenance evidence")
    }
    const timestamp = (value: unknown) => {
      if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw Error("Invalid maintenance evidence")
      return Date.parse(value)
    }
    exact(record, ["schema", "projectRef", "checkedAt", "descriptor", "acceptanceBase64"])
    if (record.schema !== "fcuno.recovery-maintenance-attestation/v1" || record.projectRef !== fcunoConnectionPolicy.supabase.projectRef) throw Error("Invalid maintenance evidence")
    const checkedAt = timestamp(record.checkedAt)
    if (checkedAt > now || typeof record.acceptanceBase64 !== "string" || record.acceptanceBase64.length > 21848) throw Error("Invalid maintenance evidence")
    const descriptor = validateRecoveryAcceptanceDescriptor(record.descriptor)
    const bytes = Buffer.from(record.acceptanceBase64, "base64")
    if (bytes.length !== descriptor.sizeBytes || bytes.toString("base64") !== record.acceptanceBase64 ||
        createHash("sha256").update(bytes).digest("hex") !== descriptor.byteSha256) throw Error("Invalid maintenance evidence")
    let crc = 0xffffffff
    for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0x82f63b78 : 0) }
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
    if (checksum.toString("base64") !== descriptor.crc32c) throw Error("Invalid maintenance evidence")
    const acceptance = JSON.parse(bytes.toString("utf8"))
    exact(acceptance, ["schema", "status", "manifest", "build", "result"])
    const build = acceptance.build, result = acceptance.result
    exact(build, ["projectId", "id", "sourceCommit", "imageId", "privateLogsDisabled", "network", "credentialsDelegatedToDatabase"])
    exact(result, ["schema", "status", "projectRef", "archiveSha256", "archiveBytes", "metadataSha256", "runId", "week", "verifiedAt", "runtime", "tables",
      "tableContentProofSha256", "catalogSections", "tocEntries", "unaccountedTocEntries", "sequences", "sequenceProofSha256", "sourceRoleCopiesNoLogin", "productionConnections", "excludes"])
    validatePostgresManifestReceipt(acceptance.manifest)
    if (acceptance.schema !== "fcuno.postgresql-recovery-acceptance/v1" || acceptance.status !== "cloud-isolated-logical-recovery-verified" ||
        build.projectId !== fcunoConnectionPolicy.storageMediaBackup.googleProjectId || build.network !== "none" ||
        build.privateLogsDisabled !== true || build.credentialsDelegatedToDatabase !== false ||
        !/^[0-9a-f-]{36}$/.test(build.id) || !/^[0-9a-f]{40}$/.test(build.sourceCommit) || !/^sha256:[0-9a-f]{64}$/.test(build.imageId) ||
        !result || result.schema !== "fcuno.cloud-postgresql-recovery/v1" || result.status !== "isolated-logical-recovery-verified" ||
        result.projectRef !== fcunoConnectionPolicy.supabase.projectRef || result.runtime !== RECOVERY_POSTGRES_IMAGE ||
        result.sourceRoleCopiesNoLogin !== true || result.productionConnections !== 0 || result.unaccountedTocEntries !== 0 || result.catalogSections !== 12 ||
        ![result.archiveSha256, result.metadataSha256, result.tableContentProofSha256, result.sequenceProofSha256].every(value => typeof value === "string" && /^[0-9a-f]{64}$/.test(value)) ||
        !Number.isSafeInteger(result.archiveBytes) || result.archiveBytes < 1 || result.archiveBytes > fcunoConnectionPolicy.postgresBackup.maximumArchiveBytes ||
        !Number.isSafeInteger(result.tables) || result.tables < 0 || !Number.isSafeInteger(result.tocEntries) || result.tocEntries < result.tables ||
        !Number.isSafeInteger(result.sequences) || result.sequences < 0 || !/^\d{4}-\d{2}-\d{2}$/.test(result.week) ||
        result.runId !== descriptor.target.objectName.split("/").at(-2) ||
        JSON.stringify(result.excludes) !== JSON.stringify(["hosted-service configuration", "role passwords", "external storage bytes", "Vault root encryption key"]) ||
        acceptance.manifest.target.objectName.replace(/manifest\.json$/, "recovery.json") !== descriptor.target.objectName) throw Error("Invalid maintenance evidence")
    const recoveredAt = timestamp(result.verifiedAt)
    if (recoveredAt < 0 || recoveredAt > checkedAt) throw Error("Invalid maintenance evidence")
    // The verification date in the exact cached receipt is the only clock.
    // Reinstalling the record or updating checkedAt cannot extend ninety days.
    validFrom = recoveredAt; validUntil = recoveredAt + 90 * DAY; operatorCheckedAt = record.checkedAt
  } catch { /* Bad/missing advice preserves incident history and discloses no raw input. */ }
  const check = postgresBackupMaintenanceCheck({ kind: "recovery", enabled: true, now, validFrom, validUntil })
  return { ...check, details: { ...check.details, evidence: "operator-verified-recovery-receipt-copy", operatorCheckedAt,
    remoteReadbackCurrent: false, provesCurrentBackupSuccess: false } }
}

// Call with the fresh canonical FCUNO account directory, not JWT user_metadata
// or a caller-supplied role. Only the intersection with an explicitly selected
// maintenance list can receive mail; there is no staff-list fallback.
export async function deliverPostgresBackupMaintenance(input: {
  checks: HealthCheck[]; accounts: Administrator[]; configuredRecipients: string[];
  token: () => string; createStore: (recipient: string) => HealthAlertStore;
  send: (recipient: string, checks: HealthCheck[]) => Promise<void>;
}) {
  if (!Array.isArray(input.checks) || input.checks.length > 2 || input.checks.some(check => !ids.has(check.id)) ||
      new Set(input.checks.map(check => check.id)).size !== input.checks.length) throw Error("Invalid backup maintenance checks")
  if (!Array.isArray(input.accounts) || input.accounts.length > 10000 || !Array.isArray(input.configuredRecipients) || input.configuredRecipients.length > 1000) throw Error("Invalid backup administrator directory")
  const recipients = [...new Set(input.configuredRecipients.map(value => {
    if (!isValidEmailAddress(value)) throw Error("Invalid backup administrator address")
    return value.trim().toLowerCase()
  }))].filter(email => {
    const matches = input.accounts.filter(account => typeof account.email === "string" && account.email.trim().toLowerCase() === email)
    return matches.length > 0 && matches.every(account => account.isActive === true && account.emailVerified === true && isAdminRole(account.role))
  })
  if (!recipients.length) throw Error("No verified backup administrator recipient is configured")
  const results = await Promise.allSettled(recipients.map(recipient => deliverHealthAlerts({ checks: input.checks,
    muted: () => false, token: input.token(), store: input.createStore(recipient), send: checks => input.send(recipient, checks) })))
  const failed = results.find(result => result.status === "rejected")
  if (failed?.status === "rejected") throw failed.reason
  return { recipients: recipients.length, sent: results.filter(result => result.status === "fulfilled" && result.value.length > 0).length }
}
