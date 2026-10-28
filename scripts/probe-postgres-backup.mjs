import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { guardedExport } from "../lib/postgresBackupProtocol.mjs"
import { POSTGRES_PROBE_URL, POSTGRES_PROBE_BODY, validatePostgresProbeResult } from "../lib/postgresBackupProbeCapability.mjs"
import { createMetadataIdentityTokenProvider } from "./lib/storage-media-source-adapter.mjs"
import { requireStorageMediaJobRuntime } from "./lib/storage-media-job-auth.mjs"

const fail = () => { throw Error("Native compatibility was not verified") }
export async function main({ args = process.argv.slice(2), runtime = process.env, fetch: fetchImpl = fetch, now = Date.now } = {}) {
  if (args.length !== 1 || args[0] !== "--verify-native-only") fail()
  requireStorageMediaJobRuntime(runtime)
  for (const name of ["PGPASSWORD", "DATABASE_URL", "SUPABASE_DB_PASSWORD", "SUPABASE_ACCESS_TOKEN", "SUPABASE_SERVICE_ROLE_KEY",
    "POSTGRES_BACKUP_SOURCE_CREDENTIAL_JSON", "POSTGRES_BACKUP_SIGNING_KEY_PEM"]) if (runtime[name]) fail()
  const context = { now, deadline: now() + 45000, signal: AbortSignal.timeout(45000) }
  const getIdentity = createMetadataIdentityTokenProvider({ runtime, fetch: fetchImpl, now, purpose: "postgres-probe" })
  const token = await guardedExport(getIdentity(context), context)
  const response = await guardedExport(fetchImpl(POSTGRES_PROBE_URL, { method: "POST", redirect: "error", cache: "no-store", signal: context.signal,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Accept-Encoding": "identity", "Cache-Control": "no-cache" },
    body: POSTGRES_PROBE_BODY }), context, value => value?.body?.cancel())
  if (response.status !== 200 || !response.body || response.headers.get("content-type") !== "application/json" ||
      !/private.*no-store/.test(response.headers.get("cache-control") || "") || response.headers.has("content-range") ||
      ![null, "identity"].includes(response.headers.get("content-encoding"))) { void response.body?.cancel().catch(() => {}); fail() }
  const reader = response.body.getReader(), parts = []; let size = 0
  try {
    for (;;) {
      const next = await guardedExport(reader.read(), context)
      if (next.done) break
      size += next.value.byteLength
      if (size > 4096) fail()
      parts.push(next.value)
    }
    return validatePostgresProbeResult(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts))), now())
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock() }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
  .then(result => console.log(JSON.stringify(result)))
  .catch(() => { console.error("Native compatibility was not verified. No export was requested."); process.exitCode = 1 })
