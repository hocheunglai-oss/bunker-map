import { fcunoConnectionPolicy } from "../../config/fcunoConnections.ts"

const policy = fcunoConnectionPolicy.storageMediaBackup
const METADATA_BASE = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default"
function fail() { throw new Error("Media backup job credentials unavailable or target mismatch") }
export function requireStorageMediaJobRuntime(runtime) {
  if (runtime.CLOUD_RUN_JOB !== policy.googleJob || runtime.GOOGLE_APPLICATION_CREDENTIALS || runtime.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY ||
      (runtime.GOOGLE_CLOUD_PROJECT && runtime.GOOGLE_CLOUD_PROJECT !== policy.googleProjectId) ||
      (runtime.GCP_PROJECT_ID && runtime.GCP_PROJECT_ID !== policy.googleProjectId) ||
      (runtime.GCS_BACKUP_BUCKET && runtime.GCS_BACKUP_BUCKET !== policy.targetBucket)) fail()
}
export function requirePostgresRecoveryBuildRuntime(runtime) {
  if (runtime.GOOGLE_CLOUD_PROJECT !== policy.googleProjectId || runtime.GCS_BACKUP_BUCKET !== policy.targetBucket ||
      runtime.FCUNO_POSTGRES_RECOVERY_BUILD !== "1" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(runtime.FCUNO_POSTGRES_RECOVERY_BUILD_ID || "") ||
      runtime.CLOUD_RUN_JOB || runtime.GOOGLE_APPLICATION_CREDENTIALS || runtime.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY) fail()
  for (const name of ["PGPASSWORD", "DATABASE_URL", "SUPABASE_DB_PASSWORD", "SUPABASE_ACCESS_TOKEN", "SUPABASE_SERVICE_ROLE_KEY",
    "POSTGRES_BACKUP_SOURCE_CREDENTIAL_JSON", "POSTGRES_BACKUP_SIGNING_KEY_PEM"]) if (runtime[name]) fail()
}
export function requireBackupRuntime(runtime, mode = "cloud-run") {
  if (mode === "cloud-run") requireStorageMediaJobRuntime(runtime)
  else if (mode === "postgres-recovery-build") requirePostgresRecoveryBuildRuntime(runtime)
  else fail()
}
function signalFor(context) {
  context.signal.throwIfAborted()
  const remaining = context.deadline - Date.now()
  if (!Number.isSafeInteger(remaining) || remaining <= 0) fail()
  return AbortSignal.any([context.signal, AbortSignal.timeout(Math.min(remaining, 10_000))])
}
async function text(response, signal, maximum = 16_384) {
  if (!response.body) fail()
  const reader = response.body.getReader(), chunks = []
  let size = 0, done = false
  const abort = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener("abort", abort, { once: true })
  try {
    for (;;) {
      signal.throwIfAborted()
      const next = await reader.read()
      signal.throwIfAborted()
      if (next.done) { done = true; break }
      size += next.value.byteLength
      if (size > maximum) fail()
      chunks.push(next.value)
    }
    return Buffer.concat(chunks).toString("utf8")
  } finally {
    signal.removeEventListener("abort", abort)
    if (!done) await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
function access(value) {
  if (!value || typeof value.access_token !== "string" || !value.access_token || value.access_token.length > 16_384 || /[\s\x00-\x1f\x7f]/.test(value.access_token) ||
      value.token_type !== "Bearer" || !Number.isSafeInteger(value.expires_in) || value.expires_in <= 60 || value.expires_in > 3600) fail()
  return value
}

// Existing Cloud Run metadata ADC only: never key files or developer gcloud
// credentials. Email is checked before issuing the opaque access token.
export function createMetadataAccessTokenProvider({ runtime, fetch: fetchImpl = fetch, now = Date.now, runtimeMode = "cloud-run" }) {
  let cached = null
  return async context => {
    requireBackupRuntime(runtime, runtimeMode)
    const signal = signalFor(context)
    if (cached && cached.expiresAt > now() + 60_000) return cached.token
    const headers = { "Metadata-Flavor": "Google" }
    const emailResponse = await fetchImpl(`${METADATA_BASE}/email`, { headers, signal, redirect: "error", cache: "no-store" })
    if (emailResponse.status !== 200 || emailResponse.headers.get("metadata-flavor") !== "Google") { await emailResponse.body?.cancel(); fail() }
    if (await text(emailResponse, signal, 256) !== policy.googleServiceAccount) fail()
    const response = await fetchImpl(`${METADATA_BASE}/token`, { headers, signal, redirect: "error", cache: "no-store" })
    if (response.status !== 200 || response.headers.get("metadata-flavor") !== "Google") { await response.body?.cancel(); fail() }
    let payload
    try { payload = access(JSON.parse(await text(response, signal))) } catch { fail() }
    cached = { token: payload.access_token, expiresAt: now() + payload.expires_in * 1000 }
    return cached.token
  }
}

// Reuse ONLY the existing job's Drive OAuth refresh credential. No local env
// or token files, new grants, new credentials, browser flows or token logging.
export function createExistingDriveAccessTokenProvider({ runtime, fetch: fetchImpl = fetch, now = Date.now }) {
  let cached = null
  return async context => {
    requireStorageMediaJobRuntime(runtime)
    const signal = signalFor(context)
    if (cached && cached.expiresAt > now() + 60_000) return cached.token
    for (const key of ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "GOOGLE_DRIVE_REFRESH_TOKEN"]) {
      if (typeof runtime[key] !== "string" || !runtime[key]) fail()
    }
    const body = new URLSearchParams({ grant_type: "refresh_token", client_id: runtime.GOOGLE_OAUTH_CLIENT_ID,
      client_secret: runtime.GOOGLE_OAUTH_CLIENT_SECRET, refresh_token: runtime.GOOGLE_DRIVE_REFRESH_TOKEN })
    const response = await fetchImpl("https://oauth2.googleapis.com/token", {
      method: "POST", body, headers: { "Content-Type": "application/x-www-form-urlencoded" }, signal, redirect: "error", cache: "no-store",
    })
    if (response.status !== 200) { await response.body?.cancel(); fail() }
    let payload
    try { payload = access(JSON.parse(await text(response, signal))) } catch { fail() }
    // Never persist or adopt a replacement refresh_token returned by Google.
    cached = { token: payload.access_token, expiresAt: now() + payload.expires_in * 1000 }
    return cached.token
  }
}
