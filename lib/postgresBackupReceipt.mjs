import { fcunoConnectionPolicy } from "../config/fcunoConnections.ts"
import { assertExact, validateExportMetadata, validateExportCompletion, postgresBackupWeek } from "./postgresBackupProtocol.mjs"
import { validateTargetIdentity } from "./storageMediaBackup.mjs"

export const POSTGRES_CONTROL_SCHEMA = "fcuno.postgresql-control/v1"
export const POSTGRES_RECEIPT_SCHEMA = "fcuno.postgresql-copy/v1"
const fail = () => { throw new Error("PostgreSQL backup receipt invalid") }
const policy = fcunoConnectionPolicy.postgresBackup
const targetBucket = fcunoConnectionPolicy.storageMediaBackup.targetBucket
export function validatePostgresManifestReceipt(value) {
  assertExact(value, ["target", "sizeBytes", "crc32c", "byteSha256"])
  const target = validateTargetIdentity(value.target)
  if (target.bucket !== targetBucket || !new RegExp(`^${policy.targetPrefix}/runs/[A-Za-z0-9][A-Za-z0-9_-]{0,79}/manifest\\.json$`).test(target.objectName) ||
      !Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 1 || value.sizeBytes > policy.maximumMetadataBytes ||
      !/^[A-Za-z0-9+/]{6}==$/.test(value.crc32c) || !/^[0-9a-f]{64}$/.test(value.byteSha256)) fail()
  return { target, sizeBytes: value.sizeBytes, crc32c: value.crc32c, byteSha256: value.byteSha256 }
}
export function validatePostgresControl(value) {
  assertExact(value, ["schema", "fence", "lease", "latestSuccess"])
  if (value.schema !== POSTGRES_CONTROL_SCHEMA || !Number.isSafeInteger(value.fence) || value.fence < 1) fail()
  if (value.lease !== null) {
    assertExact(value.lease, ["owner", "expiresAt"])
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value.lease.owner) || !Number.isSafeInteger(value.lease.expiresAt) || value.lease.expiresAt < 1) fail()
  }
  if (value.latestSuccess !== null) {
    assertExact(value.latestSuccess, ["runId", "week", "manifest"])
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value.latestSuccess.runId) || !/^\d{4}-\d{2}-\d{2}$/.test(value.latestSuccess.week)) fail()
    validatePostgresManifestReceipt(value.latestSuccess.manifest)
  }
  return structuredClone(value)
}
export function validatePostgresManifest(value) {
  assertExact(value, ["schema", "status", "runId", "week", "metadata", "completion", "signature", "parts"])
  if (value.schema !== POSTGRES_RECEIPT_SCHEMA || value.status !== "copied-and-byte-verified" ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value.runId) || !/^\d{4}-\d{2}-\d{2}$/.test(value.week)) fail()
  validateExportMetadata(value.metadata); validateExportCompletion(value.completion, value.metadata)
  // The period must derive from the SOURCE-SIGNED timestamp. A GCS writer
  // cannot relabel a genuine older archive as this week's new backup.
  if (value.week !== postgresBackupWeek(Date.parse(value.metadata.startedAt)) ||
      Date.parse(value.completion.finishedAt) - Date.parse(value.metadata.startedAt) > policy.maximumExportMs + 1000) fail()
  if (!/^[A-Za-z0-9_-]{86}$/.test(value.signature) || !Array.isArray(value.parts) || !value.parts.length ||
      value.parts.length > Math.ceil(policy.maximumArchiveBytes / policy.objectBytes)) fail()
  let total = 0
  const seen = new Set()
  for (const [index, part] of value.parts.entries()) {
    assertExact(part, ["target", "sizeBytes", "crc32c", "byteSha256"])
    const target = validateTargetIdentity(part.target)
    if (target.bucket !== targetBucket || target.objectName !== `${policy.targetPrefix}/runs/${value.runId}/archive/${String(index).padStart(6, "0")}` ||
        seen.has(JSON.stringify(target)) || !Number.isSafeInteger(part.sizeBytes) || part.sizeBytes < 1 || part.sizeBytes > policy.objectBytes ||
        (index < value.parts.length - 1 && part.sizeBytes !== policy.objectBytes) ||
        !/^[A-Za-z0-9+/]{6}==$/.test(part.crc32c) || !/^[0-9a-f]{64}$/.test(part.byteSha256)) fail()
    seen.add(JSON.stringify(target)); total += part.sizeBytes
  }
  if (total !== value.completion.archiveBytes || Buffer.byteLength(JSON.stringify(value)) > policy.maximumMetadataBytes) fail()
  return value
}
