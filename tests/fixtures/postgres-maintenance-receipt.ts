import { createHash } from "node:crypto"
import { fcunoConnectionPolicy as pins } from "../../config/fcunoConnections"
import { RECOVERY_POSTGRES_IMAGE } from "../../lib/postgresRecoveryEvidence.mjs"
import { postgresBackupWeek } from "../../lib/postgresBackupProtocol.mjs"

// Synthetic advice fixture only: no provider, source export or real recovery.
export function recoveryMaintenanceFixture(verifiedAt: number, checkedAt = verifiedAt + 1000) {
  const prefix = `${pins.postgresBackup.targetPrefix}/runs/fixture`
  const acceptance = { schema: "fcuno.postgresql-recovery-acceptance/v1", status: "cloud-isolated-logical-recovery-verified",
    manifest: { target: { bucket: pins.storageMediaBackup.targetBucket, objectName: `${prefix}/manifest.json`, generation: "1" },
      sizeBytes: 100, crc32c: "AAAAAA==", byteSha256: "a".repeat(64) },
    build: { projectId: pins.storageMediaBackup.googleProjectId, id: "11111111-1111-4111-8111-111111111111", sourceCommit: "a".repeat(40),
      imageId: `sha256:${"b".repeat(64)}`, privateLogsDisabled: true, network: "none", credentialsDelegatedToDatabase: false },
    result: { schema: "fcuno.cloud-postgresql-recovery/v1", status: "isolated-logical-recovery-verified", projectRef: pins.supabase.projectRef,
      archiveSha256: "c".repeat(64), archiveBytes: 100, metadataSha256: "d".repeat(64), runId: "fixture", week: postgresBackupWeek(verifiedAt),
      verifiedAt: new Date(verifiedAt).toISOString(), runtime: RECOVERY_POSTGRES_IMAGE, tables: 1, tableContentProofSha256: "e".repeat(64),
      catalogSections: 12, tocEntries: 2, unaccountedTocEntries: 0, sequences: 0, sequenceProofSha256: "f".repeat(64),
      sourceRoleCopiesNoLogin: true, productionConnections: 0,
      excludes: ["hosted-service configuration", "role passwords", "external storage bytes", "Vault root encryption key"] } }
  function record(value = acceptance) {
    const bytes = Buffer.from(JSON.stringify(value))
    let crc = 0xffffffff
    for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0x82f63b78 : 0) }
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
    return { schema: "fcuno.recovery-maintenance-attestation/v1", projectRef: pins.supabase.projectRef, checkedAt: new Date(checkedAt).toISOString(),
      descriptor: { target: { bucket: pins.storageMediaBackup.targetBucket, objectName: `${prefix}/recovery.json`, generation: "2" },
        sizeBytes: bytes.length, byteSha256: createHash("sha256").update(bytes).digest("hex"), crc32c: checksum.toString("base64") },
      acceptanceBase64: bytes.toString("base64") }
  }
  return { acceptance, record, runtime: { POSTGRES_BACKUP_SOURCE_ENABLED: "1", VERCEL: "1", VERCEL_ENV: "production", VERCEL_PROJECT_ID: pins.vercel.projectId,
    POSTGRES_BACKUP_RECOVERY_MAINTENANCE_JSON: JSON.stringify(record()) } }
}
