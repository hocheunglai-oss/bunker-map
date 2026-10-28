// Network-capable controller only. Native SQL is NEVER executed here. The
// separate inner container receives neither this environment nor ADC access.
import { createPublicKey, createHash, verify } from "node:crypto"
import { mkdir, open, writeFile, readFile, rename, chown, lstat, rm } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { fcunoConnectionPolicy } from "../../config/fcunoConnections.ts"
import { validatePostgresManifest, validatePostgresManifestReceipt } from "../../lib/postgresBackupReceipt.mjs"
import { RECOVERY_WORKSPACE, validateRecoveryHostInspection } from "../../lib/postgresRecoveryBuild.mjs"
import { validateOfflineRecoveryResult } from "../../lib/postgresRecoveryEvidence.mjs"
import { createMetadataAccessTokenProvider, requirePostgresRecoveryBuildRuntime } from "../lib/storage-media-job-auth.mjs"
import { createStorageMediaBudgetRuntime } from "../lib/storage-media-budget-runtime.mjs"
import { createStorageMediaGcsAdapter } from "../lib/storage-media-gcs-adapter.mjs"
import { readPostgresManifest } from "../lib/postgres-backup-receiver.mjs"
import { measureByteStream } from "../../lib/storageMediaBackup.mjs"

const hash = bytes => createHash("sha256").update(bytes).digest("hex")
const failure = () => { throw new Error("Private cloud recovery could not be verified") }
const exact = (value, keys) => { if (!value || typeof value !== "object" || Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) failure() }
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
async function smallFile(path, maximum = 16384) {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size > maximum) failure()
  return readFile(path)
}
export async function cloudMain({ args = process.argv.slice(2), runtime = process.env, fetch: fetchImpl = fetch, now = Date.now } = {}) {
  if (args.length !== 1 || !["download", "publish"].includes(args[0])) failure()
  requirePostgresRecoveryBuildRuntime(runtime)
  if (!/^[0-9a-f]{40}$/.test(runtime.FCUNO_RECOVERY_SOURCE_COMMIT || "") || typeof runtime.POSTGRES_RECOVERY_MANIFEST_JSON !== "string" ||
      runtime.POSTGRES_RECOVERY_MANIFEST_JSON.length > 8192 || typeof runtime.POSTGRES_BACKUP_VERIFICATION_KEY_PEM !== "string" ||
      runtime.POSTGRES_BACKUP_VERIFICATION_KEY_PEM.length > 2048) failure()
  const descriptor = validatePostgresManifestReceipt(JSON.parse(runtime.POSTGRES_RECOVERY_MANIFEST_JSON))
  const publicKey = createPublicKey(runtime.POSTGRES_BACKUP_VERIFICATION_KEY_PEM)
  if (publicKey.asymmetricKeyType !== "ed25519") failure()
  const runId = descriptor.target.objectName.split("/").at(-2)
  const context = { signal: AbortSignal.timeout(300000), deadline: now() + 300000, now }
  const runtimeMode = "postgres-recovery-build"
  const getAccessToken = createMetadataAccessTokenProvider({ runtime, fetch: fetchImpl, now, runtimeMode })
  const gcs = createStorageMediaGcsAdapter({ fetch: fetchImpl, getAccessToken, runId, now, mode: "postgres-recovery" })
  if (args[0] === "download") {
    const budget = createStorageMediaBudgetRuntime({ runtime, fetch: fetchImpl, now, getAccessToken, runtimeMode })
    const decision = await budget.checkOptionalWork({ plannedWriteBytes: 16384 }, context)
    if (decision?.allowed !== true) failure()
    // Deliberately nonrecursive: a second invocation cannot overwrite, resume
    // or quietly adopt another build's private files.
    await mkdir(RECOVERY_WORKSPACE, { mode: 0o700 })
    for (const name of ["input", "scratch", "output"]) {
      const path = `${RECOVERY_WORKSPACE}/${name}`
      await mkdir(path, { mode: 0o700 }); await chown(path, 1000, 1000)
    }
    const incomplete = `${RECOVERY_WORKSPACE}/input/archive.partial`, destination = `${RECOVERY_WORKSPACE}/input/archive.dump`
    const file = await open(incomplete, "wx", 0o600)
    let manifest
    try {
      manifest = await readPostgresManifest(gcs, descriptor, publicKey, context, async bytes => {
        let offset = 0
        while (offset < bytes.length) { const written = await file.write(bytes.subarray(offset)); if (!written.bytesWritten) failure(); offset += written.bytesWritten }
      })
      await file.sync()
    } finally { await file.close() }
    await rename(incomplete, destination); await chown(destination, 1000, 1000)
    for (const [name, bytes] of [["manifest.json", JSON.stringify(manifest)], ["verification-key.pem", runtime.POSTGRES_BACKUP_VERIFICATION_KEY_PEM]]) {
      const path = `${RECOVERY_WORKSPACE}/input/${name}`
      await writeFile(path, bytes, { mode: 0o600, flag: "wx" }); await chown(path, 1000, 1000)
    }
    await writeFile(`${RECOVERY_WORKSPACE}/plan.json`, JSON.stringify({ buildId: runtime.FCUNO_POSTGRES_RECOVERY_BUILD_ID,
      sourceCommit: runtime.FCUNO_RECOVERY_SOURCE_COMMIT, manifest: descriptor, verificationKeySha256: hash(Buffer.from(runtime.POSTGRES_BACKUP_VERIFICATION_KEY_PEM)) }), { mode: 0o600, flag: "wx" })
    return { status: "private-copy-ready-for-isolated-recovery" }
  }
  const plan = JSON.parse(await smallFile(`${RECOVERY_WORKSPACE}/plan.json`))
  exact(plan, ["buildId", "sourceCommit", "manifest", "verificationKeySha256"])
  if (plan.buildId !== runtime.FCUNO_POSTGRES_RECOVERY_BUILD_ID || plan.sourceCommit !== runtime.FCUNO_RECOVERY_SOURCE_COMMIT ||
      !same(plan.manifest, descriptor) || plan.verificationKeySha256 !== hash(Buffer.from(runtime.POSTGRES_BACKUP_VERIFICATION_KEY_PEM))) failure()
  const manifest = validatePostgresManifest(JSON.parse(await smallFile(`${RECOVERY_WORKSPACE}/input/manifest.json`, fcunoConnectionPolicy.postgresBackup.maximumMetadataBytes)))
  if (manifest.runId !== runId || hash(Buffer.from(JSON.stringify(manifest.metadata))) !== manifest.completion.metadataSha256 ||
      !verify(null, Buffer.from(JSON.stringify(manifest.completion)), publicKey, Buffer.from(manifest.signature, "base64url"))) failure()
  const containment = validateRecoveryHostInspection(JSON.parse(await smallFile(`${RECOVERY_WORKSPACE}/host-inspection.json`, 1024 * 1024)))
  const result = validateOfflineRecoveryResult(JSON.parse(await smallFile(`${RECOVERY_WORKSPACE}/output/recovery.json`)), manifest, now())
  const acceptance = { schema: "fcuno.postgresql-recovery-acceptance/v1", status: "cloud-isolated-logical-recovery-verified", manifest: descriptor,
    build: { projectId: fcunoConnectionPolicy.storageMediaBackup.googleProjectId, id: plan.buildId, sourceCommit: plan.sourceCommit,
      imageId: containment.Image, privateLogsDisabled: true, network: "none", credentialsDelegatedToDatabase: false }, result }
  const bytes = Buffer.from(JSON.stringify(acceptance))
  if (bytes.length > 16384) failure()
  const saved = await gcs.uploadImmutable({ objectName: gcs.manifestObjectName, bytes, sizeBytes: bytes.length, contentType: "application/json" }, context)
  if (saved.sizeBytes !== bytes.length) failure()
  const readback = await gcs.readTarget(saved.target, context)
  if (!same(readback.target, saved.target) || readback.crc32c !== saved.crc32c) failure()
  await measureByteStream(readback.bytes, { expectedBytes: bytes.length, expectedSha256: hash(bytes), expectedCrc32c: saved.crc32c }, context)
  if (!same(await gcs.inspectTarget(saved.target, context), saved)) failure()
  // This small descriptor is non-business evidence. The verified private
  // acceptance itself stays in the existing protected backup bucket.
  await writeFile("/workspace/fcuno-recovery-acceptance-receipt.json", JSON.stringify({ ...saved, byteSha256: hash(bytes) }), { mode: 0o600, flag: "wx" })
  await rm(RECOVERY_WORKSPACE, { recursive: true, force: true })
  return { status: acceptance.status }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) cloudMain().catch(() => { process.exitCode = 1 })
