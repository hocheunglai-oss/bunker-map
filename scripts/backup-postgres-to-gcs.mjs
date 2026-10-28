#!/usr/bin/env node
import { createPublicKey, randomUUID } from "node:crypto"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { postgresBackupWeek } from "../lib/postgresBackupProtocol.mjs"
import { createMetadataIdentityTokenProvider } from "./lib/storage-media-source-adapter.mjs"
import { createMetadataAccessTokenProvider, requireStorageMediaJobRuntime } from "./lib/storage-media-job-auth.mjs"
import { createStorageMediaGcsAdapter } from "./lib/storage-media-gcs-adapter.mjs"
import { createStorageMediaBudgetRuntime } from "./lib/storage-media-budget-runtime.mjs"
import { createPostgresBackupSourceAdapter } from "./lib/postgres-backup-source-adapter.mjs"
import { receivePostgresBackup } from "./lib/postgres-backup-receiver.mjs"
import { requireCloudRecoveryAcceptance, validateRecoveryAcceptanceDescriptor } from "../lib/postgresRecoveryAcceptance.mjs"

// Packaging this command does not enable it or change the existing job default.
// This Google runtime must never receive either native or signing credentials.
export async function main({ args = process.argv.slice(2), runtime = process.env, fetch: fetchImpl = fetch, now = Date.now } = {}) {
  const firstCopy = args.length === 1 && args[0] === "--execute-approved-first-copy" && runtime.POSTGRES_BACKUP_FIRST_COPY_APPROVED === "1" && runtime.POSTGRES_BACKUP_RECURRING_ENABLED !== "1"
  if (!firstCopy && (args.length !== 1 || args[0] !== "--execute-recurring-weekly" || runtime.POSTGRES_BACKUP_RECURRING_ENABLED !== "1"))
    throw new Error("Weekly PostgreSQL backup is not activated")
  requireStorageMediaJobRuntime(runtime)
  for (const name of ["PGPASSWORD", "DATABASE_URL", "SUPABASE_DB_PASSWORD", "SUPABASE_ACCESS_TOKEN",
    "POSTGRES_BACKUP_SOURCE_CREDENTIAL_JSON", "POSTGRES_BACKUP_SIGNING_KEY_PEM", "SUPABASE_SERVICE_ROLE_KEY"]) {
    if (runtime[name]) throw new Error("Source credential must not be present in Google backup runtime")
  }
  const pem = runtime.POSTGRES_BACKUP_VERIFICATION_KEY_PEM
  if (typeof pem !== "string" || pem.length > 2048) throw new Error("Source verification key unavailable")
  const publicKey = createPublicKey(pem)
  if (publicKey.asymmetricKeyType !== "ed25519") throw new Error("Source verification key invalid")
  const controller = new AbortController(), deadline = now() + 2700000, runId = randomUUID()
  const stop = () => controller.abort(), timer = setTimeout(stop, 2700000)
  process.once("SIGINT", stop); process.once("SIGTERM", stop)
  try {
    const getAccessToken = createMetadataAccessTokenProvider({ fetch: fetchImpl, runtime, now })
    const context = { signal: controller.signal, deadline, now }
    if (!firstCopy) {
      if (typeof runtime.POSTGRES_BACKUP_RECOVERY_ACCEPTANCE_JSON !== "string" || runtime.POSTGRES_BACKUP_RECOVERY_ACCEPTANCE_JSON.length > 8192)
        throw new Error("First cloud recovery acceptance remains pending")
      const acceptance = validateRecoveryAcceptanceDescriptor(JSON.parse(runtime.POSTGRES_BACKUP_RECOVERY_ACCEPTANCE_JSON))
      const recoveryGcs = createStorageMediaGcsAdapter({ fetch: fetchImpl, getAccessToken, runId, now, mode: "postgres-recovery" })
      await requireCloudRecoveryAcceptance(recoveryGcs, acceptance, publicKey, context)
    }
    const budget = createStorageMediaBudgetRuntime({ runtime, fetch: fetchImpl, now, getAccessToken })
    const gcs = createStorageMediaGcsAdapter({ fetch: fetchImpl, getAccessToken, runId, now, mode: "postgres-candidate" })
    const source = createPostgresBackupSourceAdapter({ fetch: fetchImpl, now,
      getIdentityToken: createMetadataIdentityTokenProvider({ fetch: fetchImpl, runtime, now, purpose: "postgres-candidate" }) })
    return await receivePostgresBackup({ source, gcs, budget, publicKey, runId, week: postgresBackupWeek(now()) },
      context)
  } finally { clearTimeout(timer); process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop) }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).join(" ") === "--help") console.log("Weekly PostgreSQL copy: --execute-recurring-weekly (explicit source/job activation and authentic budget guard required)")
  else main().then(result => console.log(JSON.stringify({ status: result.status, archiveBytes: result.archiveBytes, parts: result.parts })))
    .catch(() => { console.error("Weekly PostgreSQL backup was not verified. Existing backup copies were preserved."); process.exitCode = 1 })
}
