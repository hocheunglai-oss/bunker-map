// Network-capable controller only. Native SQL is NEVER executed here. The
// separate inner container receives neither this environment nor ADC access.
import { createPublicKey, createHash, verify } from "node:crypto"
import { constants as fsConstants } from "node:fs"
import { mkdir, open, writeFile, readFile, rename, chown, lstat, rm } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { fcunoConnectionPolicy } from "../../config/fcunoConnections.ts"
import { validatePostgresManifest, validatePostgresManifestReceipt } from "../../lib/postgresBackupReceipt.mjs"
import { RECOVERY_WORKSPACE, validateRecoveryHostInspection } from "../../lib/postgresRecoveryBuild.mjs"
import { validateOfflineRecoveryResult } from "../../lib/postgresRecoveryEvidence.mjs"
import { validateRecoveryDiagnostic, validateRecoveryFailureHost, recoveryFailure } from "../../lib/postgresRecoveryDiagnostics.mjs"
import { createMetadataAccessTokenProvider, requirePostgresRecoveryBuildRuntime } from "../lib/storage-media-job-auth.mjs"
import { createStorageMediaBudgetRuntime } from "../lib/storage-media-budget-runtime.mjs"
import { createStorageMediaGcsAdapter } from "../lib/storage-media-gcs-adapter.mjs"
import { readPostgresManifest } from "../lib/postgres-backup-receiver.mjs"
import { measureByteStream } from "../../lib/storageMediaBackup.mjs"

const hash = bytes => createHash("sha256").update(bytes).digest("hex")
const failure = () => { throw new Error("Private cloud recovery could not be verified") }
const exact = (value, keys) => { if (!value || typeof value !== "object" || Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) failure() }
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
// Only fixed technical stages leave the private controller, as numeric CLI
// exit codes. Never derive a code from an exception, message, provider body,
// object name, identifier, SQL or environment. Every failure remains nonzero.
export const RECOVERY_CONTROLLER_EXIT_CODES = Object.freeze({
  "controller-arguments": 20, "controller-runtime": 21, "controller-input": 22, "controller-client": 23,
  "download-budget": 24, "download-workspace": 25, "download-archive": 26, "download-input": 27,
  "publish-plan-read": 30, "publish-plan-validation": 31, "publish-manifest-read": 32,
  "publish-manifest-validation": 33, "publish-outcome-read": 34, "publish-outcome-validation": 35,
  "failure-input-validation": 40, "failure-upload": 41, "failure-receipt-validation": 42,
  "failure-readback": 43, "failure-readback-validation": 44, "failure-final-inspection": 45, "failure-recorded": 46,
  "acceptance-containment": 50, "acceptance-result": 51, "acceptance-upload": 52,
  "acceptance-readback": 53, "acceptance-final-inspection": 54, "acceptance-local-receipt": 55, "acceptance-cleanup": 56,
})
export function createRecoveryControllerStages() {
  let code = 20
  return Object.freeze({
    enter(value) {
      if (typeof value !== "string" || !Object.hasOwn(RECOVERY_CONTROLLER_EXIT_CODES, value)) { code = 90; failure() }
      code = RECOVERY_CONTROLLER_EXIT_CODES[value]
    },
    exitCode: () => code,
  })
}
async function smallFile(path, maximum = 16384) {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size > maximum) failure()
  return readFile(path)
}
async function optionalPrivateJson(path, maximum = 16384) {
  try { return JSON.parse(await smallFile(path, maximum)) }
  catch (error) { if (error?.code === "ENOENT") return null; throw error }
}
const HOST_READ_STATUSES = Object.freeze(["valid", "missing", "invalid-file", "invalid-json", "invalid-evidence", "read-error"])
function validateHostRead({ host, status }) {
  if (!HOST_READ_STATUSES.includes(status) || (status === "valid" ? host === null : host !== null)) failure()
  if (status === "valid") validateRecoveryFailureHost(host)
}
// A corrupt/unreadable host file is explicit FAILED evidence, never equivalent
// to a successful or merely absent host. Keep only a fixed status, not bytes,
// paths, OS errors or inspect output. The diagnostic is independently validated.
// The optional I/O seam is for local error-injection tests; production supplies
// neither it nor a caller-controlled path.
export async function readRecoveryHostOutcome(path, { openFile = open } = {}) {
  try {
    const file = await openFile(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK)
    try {
      const info = await file.stat()
      if (!info.isFile() || info.size > 16384) return { status: "invalid-file", host: null }
      const bytes = Buffer.alloc(16385)
      let length = 0
      while (length < bytes.length) {
        const { bytesRead } = await file.read(bytes, length, bytes.length - length, null)
        if (!bytesRead) break
        length += bytesRead
      }
      if (length > 16384) return { status: "invalid-file", host: null }
      let host
      try { host = JSON.parse(bytes.subarray(0, length)) }
      catch { return { status: "invalid-json", host: null } }
      try { validateRecoveryFailureHost(host) }
      catch { return { status: "invalid-evidence", host: null } }
      return { status: "valid", host }
    } finally { await file.close() }
  } catch (error) {
    return { status: error?.code === "ENOENT" ? "missing" : error?.code === "ELOOP" ? "invalid-file" : "read-error", host: null }
  }
}
export function recoveryPublicationFailed({ hostOutcome, hostReadStatus, diagnostic }) {
  validateHostRead({ host: hostOutcome, status: hostReadStatus })
  if (diagnostic !== null) validateRecoveryDiagnostic(diagnostic)
  return hostReadStatus !== "valid" || recoveryFailure({ host: hostOutcome, diagnostic })
}
// This branch always rejects, even after its immutable private receipt was
// durably read back. It cannot publish an acceptance or make the Build pass.
export async function recordRecoveryFailureAndReject({ gcs, context, plan, host, diagnostic,
  hostReadStatus = host === null ? "missing" : "valid", stage = () => {} }) {
  stage("failure-input-validation")
  validatePostgresManifestReceipt(plan.manifest)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(plan.buildId) || !/^[0-9a-f]{40}$/.test(plan.sourceCommit)) failure()
  if (!recoveryPublicationFailed({ hostOutcome: host, hostReadStatus, diagnostic })) failure()
  const report = { schema: "fcuno.postgresql-recovery-failure/v1", status: "cloud-isolated-recovery-failed", recoveryVerified: false,
    manifest: plan.manifest, build: { projectId: fcunoConnectionPolicy.storageMediaBackup.googleProjectId, id: plan.buildId, sourceCommit: plan.sourceCommit }, hostReadStatus, host, diagnostic }
  const bytes = Buffer.from(JSON.stringify(report))
  if (bytes.length > 16384) failure()
  stage("failure-upload")
  const saved = await gcs.uploadRecoveryFailure({ buildId: plan.buildId, bytes }, context)
  stage("failure-receipt-validation")
  const expectedName = plan.manifest.target.objectName.replace(/manifest\.json$/, `failures/${plan.buildId}.json`)
  if (saved.target.bucket !== plan.manifest.target.bucket || saved.target.objectName !== expectedName || saved.sizeBytes !== bytes.length) failure()
  stage("failure-readback")
  const readback = await gcs.readTarget(saved.target, context)
  stage("failure-readback-validation")
  if (!same(readback.target, saved.target) || readback.crc32c !== saved.crc32c) failure()
  await measureByteStream(readback.bytes, { expectedBytes: bytes.length, expectedSha256: hash(bytes), expectedCrc32c: saved.crc32c }, context)
  stage("failure-final-inspection")
  if (!same(await gcs.inspectTarget(saved.target, context), saved)) failure()
  stage("failure-recorded")
  throw new Error("Isolated recovery failed; private diagnostic recorded")
}
// Separated only for local filesystem verification. Production always uses
// the fixed workspace; no CLI argument or environment can redirect it.
export async function readRecoveryPublicationInputs({ runtime, descriptor, publicKey, workspace = RECOVERY_WORKSPACE, stage = () => {} }) {
  stage("publish-plan-read")
  const plan = JSON.parse(await smallFile(`${workspace}/plan.json`))
  stage("publish-plan-validation")
  exact(plan, ["buildId", "sourceCommit", "manifest", "verificationKeySha256"])
  if (plan.buildId !== runtime.FCUNO_POSTGRES_RECOVERY_BUILD_ID || plan.sourceCommit !== runtime.FCUNO_RECOVERY_SOURCE_COMMIT ||
      !same(plan.manifest, descriptor) || plan.verificationKeySha256 !== hash(Buffer.from(runtime.POSTGRES_BACKUP_VERIFICATION_KEY_PEM))) failure()
  stage("publish-manifest-read")
  const manifest = JSON.parse(await smallFile(`${workspace}/input/manifest.json`, fcunoConnectionPolicy.postgresBackup.maximumMetadataBytes))
  stage("publish-manifest-validation")
  validatePostgresManifest(manifest)
  const runId = descriptor.target.objectName.split("/").at(-2)
  if (manifest.runId !== runId || hash(Buffer.from(JSON.stringify(manifest.metadata))) !== manifest.completion.metadataSha256 ||
      !verify(null, Buffer.from(JSON.stringify(manifest.completion)), publicKey, Buffer.from(manifest.signature, "base64url"))) failure()
  stage("publish-outcome-read")
  const { host: hostOutcome, status: hostReadStatus } = await readRecoveryHostOutcome(`${workspace}/host-outcome.json`)
  const diagnostic = await optionalPrivateJson(`${workspace}/output/diagnostic.json`)
  stage("publish-outcome-validation")
  // These are the same validators previously reached through recoveryFailure
  // and the failure recorder. Missing files remain an explicit failed restore.
  validateHostRead({ host: hostOutcome, status: hostReadStatus })
  if (diagnostic !== null) validateRecoveryDiagnostic(diagnostic)
  return { plan, manifest, hostOutcome, hostReadStatus, diagnostic }
}
export async function cloudMain({ args = process.argv.slice(2), runtime = process.env, fetch: fetchImpl = fetch, now = Date.now, stage = () => {} } = {}) {
  stage("controller-arguments")
  if (args.length !== 1 || !["download", "publish"].includes(args[0])) failure()
  stage("controller-runtime")
  requirePostgresRecoveryBuildRuntime(runtime)
  stage("controller-input")
  if (!/^[0-9a-f]{40}$/.test(runtime.FCUNO_RECOVERY_SOURCE_COMMIT || "") || typeof runtime.POSTGRES_RECOVERY_MANIFEST_JSON !== "string" ||
      runtime.POSTGRES_RECOVERY_MANIFEST_JSON.length > 8192 || typeof runtime.POSTGRES_BACKUP_VERIFICATION_KEY_PEM !== "string" ||
      runtime.POSTGRES_BACKUP_VERIFICATION_KEY_PEM.length > 2048) failure()
  const descriptor = validatePostgresManifestReceipt(JSON.parse(runtime.POSTGRES_RECOVERY_MANIFEST_JSON))
  const publicKey = createPublicKey(runtime.POSTGRES_BACKUP_VERIFICATION_KEY_PEM)
  if (publicKey.asymmetricKeyType !== "ed25519") failure()
  const runId = descriptor.target.objectName.split("/").at(-2)
  const context = { signal: AbortSignal.timeout(300000), deadline: now() + 300000, now }
  stage("controller-client")
  const runtimeMode = "postgres-recovery-build"
  const getAccessToken = createMetadataAccessTokenProvider({ runtime, fetch: fetchImpl, now, runtimeMode })
  const gcs = createStorageMediaGcsAdapter({ fetch: fetchImpl, getAccessToken, runId, now, mode: "postgres-recovery" })
  if (args[0] === "download") {
    stage("download-budget")
    const budget = createStorageMediaBudgetRuntime({ runtime, fetch: fetchImpl, now, getAccessToken, runtimeMode })
    const decision = await budget.checkOptionalWork({ plannedWriteBytes: 16384 }, context)
    if (decision?.allowed !== true) failure()
    // Deliberately nonrecursive: a second invocation cannot overwrite, resume
    // or quietly adopt another build's private files.
    stage("download-workspace")
    await mkdir(RECOVERY_WORKSPACE, { mode: 0o700 })
    for (const name of ["input", "scratch", "output"]) {
      const path = `${RECOVERY_WORKSPACE}/${name}`
      await mkdir(path, { mode: 0o700 }); await chown(path, 1000, 1000)
    }
    const incomplete = `${RECOVERY_WORKSPACE}/input/archive.partial`, destination = `${RECOVERY_WORKSPACE}/input/archive.dump`
    const file = await open(incomplete, "wx", 0o600)
    let manifest
    try {
      stage("download-archive")
      manifest = await readPostgresManifest(gcs, descriptor, publicKey, context, async bytes => {
        let offset = 0
        while (offset < bytes.length) { const written = await file.write(bytes.subarray(offset)); if (!written.bytesWritten) failure(); offset += written.bytesWritten }
      })
      await file.sync()
    } finally { await file.close() }
    stage("download-input")
    await rename(incomplete, destination); await chown(destination, 1000, 1000)
    for (const [name, bytes] of [["manifest.json", JSON.stringify(manifest)], ["verification-key.pem", runtime.POSTGRES_BACKUP_VERIFICATION_KEY_PEM]]) {
      const path = `${RECOVERY_WORKSPACE}/input/${name}`
      await writeFile(path, bytes, { mode: 0o600, flag: "wx" }); await chown(path, 1000, 1000)
    }
    await writeFile(`${RECOVERY_WORKSPACE}/plan.json`, JSON.stringify({ buildId: runtime.FCUNO_POSTGRES_RECOVERY_BUILD_ID,
      sourceCommit: runtime.FCUNO_RECOVERY_SOURCE_COMMIT, manifest: descriptor, verificationKeySha256: hash(Buffer.from(runtime.POSTGRES_BACKUP_VERIFICATION_KEY_PEM)) }), { mode: 0o600, flag: "wx" })
    return { status: "private-copy-ready-for-isolated-recovery" }
  }
  const { plan, manifest, hostOutcome, hostReadStatus, diagnostic } = await readRecoveryPublicationInputs({ runtime, descriptor, publicKey, stage })
  if (recoveryPublicationFailed({ hostOutcome, hostReadStatus, diagnostic }))
    await recordRecoveryFailureAndReject({ gcs, context, plan, host: hostOutcome, hostReadStatus, diagnostic, stage })
  stage("acceptance-containment")
  const containment = validateRecoveryHostInspection(JSON.parse(await smallFile(`${RECOVERY_WORKSPACE}/host-inspection.json`, 1024 * 1024)))
  stage("acceptance-result")
  const result = validateOfflineRecoveryResult(JSON.parse(await smallFile(`${RECOVERY_WORKSPACE}/output/recovery.json`)), manifest, now())
  const acceptance = { schema: "fcuno.postgresql-recovery-acceptance/v1", status: "cloud-isolated-logical-recovery-verified", manifest: descriptor,
    build: { projectId: fcunoConnectionPolicy.storageMediaBackup.googleProjectId, id: plan.buildId, sourceCommit: plan.sourceCommit,
      imageId: containment.Image, privateLogsDisabled: true, network: "none", credentialsDelegatedToDatabase: false }, result }
  const bytes = Buffer.from(JSON.stringify(acceptance))
  if (bytes.length > 16384) failure()
  stage("acceptance-upload")
  const saved = await gcs.uploadImmutable({ objectName: gcs.manifestObjectName, bytes, sizeBytes: bytes.length, contentType: "application/json" }, context)
  if (saved.sizeBytes !== bytes.length) failure()
  stage("acceptance-readback")
  const readback = await gcs.readTarget(saved.target, context)
  if (!same(readback.target, saved.target) || readback.crc32c !== saved.crc32c) failure()
  await measureByteStream(readback.bytes, { expectedBytes: bytes.length, expectedSha256: hash(bytes), expectedCrc32c: saved.crc32c }, context)
  stage("acceptance-final-inspection")
  if (!same(await gcs.inspectTarget(saved.target, context), saved)) failure()
  // This small descriptor is non-business evidence. The verified private
  // acceptance itself stays in the existing protected backup bucket.
  stage("acceptance-local-receipt")
  await writeFile("/workspace/fcuno-recovery-acceptance-receipt.json", JSON.stringify({ ...saved, byteSha256: hash(bytes) }), { mode: 0o600, flag: "wx" })
  stage("acceptance-cleanup")
  await rm(RECOVERY_WORKSPACE, { recursive: true, force: true })
  return { status: acceptance.status }
}
export async function runCloudRecoveryCli(options = {}) {
  const stages = createRecoveryControllerStages()
  try { await cloudMain({ ...options, stage: stages.enter }); return 0 }
  catch { return stages.exitCode() }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await runCloudRecoveryCli()
