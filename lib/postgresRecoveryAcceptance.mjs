import { fcunoConnectionPolicy } from "../config/fcunoConnections.ts"
import { measureByteStream } from "./storageMediaBackup.mjs"
import { validatePostgresManifestReceipt } from "./postgresBackupReceipt.mjs"
import { validateOfflineRecoveryResult } from "./postgresRecoveryEvidence.mjs"
import { readPostgresManifestMetadata } from "../scripts/lib/postgres-backup-receiver.mjs"
const fail = () => { throw new Error("Verified cloud recovery acceptance required") }
export function validateRecoveryAcceptanceDescriptor(value) {
  if (!value || Object.keys(value).sort().join(",") !== "byteSha256,crc32c,sizeBytes,target" ||
      !value.target || Object.keys(value.target).sort().join(",") !== "bucket,generation,objectName" ||
      value.target.bucket !== fcunoConnectionPolicy.storageMediaBackup.targetBucket ||
      !new RegExp(`^${fcunoConnectionPolicy.postgresBackup.targetPrefix}/runs/[A-Za-z0-9][A-Za-z0-9_-]{0,79}/recovery\\.json$`).test(value.target.objectName) ||
      !/^[1-9][0-9]{0,19}$/.test(value.target.generation) || !Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 1 || value.sizeBytes > 16384 ||
      !/^[A-Za-z0-9+/]{6}==$/.test(value.crc32c) || !/^[0-9a-f]{64}$/.test(value.byteSha256)) fail()
  return value
}
export async function requireCloudRecoveryAcceptance(gcs, descriptor, publicKey, context) {
  validateRecoveryAcceptanceDescriptor(descriptor)
  const { byteSha256, ...expected } = descriptor
  if (JSON.stringify(await gcs.inspectTarget(descriptor.target, context)) !== JSON.stringify(expected)) fail()
  const opened = await gcs.readTarget(descriptor.target, context), chunks = []
  if (JSON.stringify(opened.target) !== JSON.stringify(expected.target) || opened.crc32c !== expected.crc32c) {
    await opened.bytes?.[Symbol.asyncIterator]?.().return?.(); fail()
  }
  async function* recording() {
    let bytes = 0
    for await (const chunk of opened.bytes) { if ((bytes += chunk.length) > 16384) fail(); chunks.push(chunk); yield chunk }
  }
  await measureByteStream(recording(), { expectedBytes: expected.sizeBytes, expectedSha256: byteSha256, expectedCrc32c: expected.crc32c }, context)
  const acceptance = JSON.parse(Buffer.concat(chunks).toString("utf8"))
  if (acceptance?.schema !== "fcuno.postgresql-recovery-acceptance/v1" || acceptance.status !== "cloud-isolated-logical-recovery-verified" ||
      acceptance.build?.projectId !== fcunoConnectionPolicy.storageMediaBackup.googleProjectId || acceptance.build?.network !== "none" ||
      acceptance.build?.credentialsDelegatedToDatabase !== false || acceptance.build?.privateLogsDisabled !== true ||
      !/^[0-9a-f-]{36}$/.test(acceptance.build?.id || "") || !/^[0-9a-f]{40}$/.test(acceptance.build?.sourceCommit || "") ||
      !/^sha256:[0-9a-f]{64}$/.test(acceptance.build?.imageId || "") ||
      acceptance.result?.status !== "isolated-logical-recovery-verified" || acceptance.result.projectRef !== fcunoConnectionPolicy.supabase.projectRef ||
      acceptance.result.sourceRoleCopiesNoLogin !== true || acceptance.result.productionConnections !== 0 || acceptance.result.unaccountedTocEntries !== 0 ||
      acceptance.result.catalogSections !== 12 || !Number.isFinite(Date.parse(acceptance.result.verifiedAt)) ||
      acceptance.result.runtime !== "sha256:b75a42959151593e90d6ad7f0ef69abb329916caa397556976375da4c333412e" ||
      Date.parse(acceptance.result.verifiedAt) > context.now() + 30000 || Date.parse(acceptance.result.verifiedAt) < context.now() - 90 * 86400000) fail()
  validatePostgresManifestReceipt(acceptance.manifest)
  if (acceptance.manifest.target.objectName.replace(/manifest\.json$/, "recovery.json") !== descriptor.target.objectName) fail()
  // Small metadata read: independently bind the result to the exact source
  // signature without downloading the multi-GB archive a second time.
  const manifest = await readPostgresManifestMetadata(gcs, acceptance.manifest, publicKey, context)
  validateOfflineRecoveryResult(acceptance.result, manifest, context.now())
  if (JSON.stringify(await gcs.inspectTarget(descriptor.target, context)) !== JSON.stringify(expected)) fail()
  return acceptance
}
