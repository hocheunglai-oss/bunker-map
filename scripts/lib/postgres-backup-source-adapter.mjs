import { fcunoConnectionPolicy } from "../../config/fcunoConnections.ts"
import { POSTGRES_BACKUP_CONTENT_TYPE, assertExportContext, guardedExport } from "../../lib/postgresBackupProtocol.mjs"

const policy = fcunoConnectionPolicy.postgresBackup
const sourceUrl = `${fcunoConnectionPolicy.vercel.productionOrigins[0]}${policy.sourcePath}`
const fail = () => { throw new Error("Fixed PostgreSQL source unavailable") }

// Reuse createMetadataIdentityTokenProvider({purpose:'postgres-candidate'}).
// There is no native login, administrator credential or URL handoff in Google.
export function createPostgresBackupSourceAdapter({ getIdentityToken, fetch: fetchImpl = fetch, now = Date.now }) {
  if (typeof getIdentityToken !== "function" || typeof fetchImpl !== "function") fail()
  return {
    async open(context) {
      assertExportContext(context)
      const remaining = Math.min(policy.maximumExportMs + 10000, context.deadline - now())
      if (!Number.isSafeInteger(remaining) || remaining <= 0) fail()
      const stop = new AbortController(), signal = AbortSignal.any([context.signal, stop.signal, AbortSignal.timeout(remaining)])
      const operation = { ...context, signal, deadline: now() + remaining, now }
      let reader = null, closed = false
      const close = () => {
        if (closed) return
        closed = true; stop.abort()
        if (reader) { void reader.cancel().catch(() => {}); try { reader.releaseLock() } catch { /* pending cancellation */ } }
      }
      try {
        const token = await guardedExport(getIdentityToken(operation), operation)
        if (typeof token !== "string" || token.length > 16384 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) fail()
        const response = await guardedExport(fetchImpl(sourceUrl, { method: "POST", cache: "no-store", redirect: "error", signal,
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Accept-Encoding": "identity", "Cache-Control": "no-store" },
          body: '{"operation":"weekly-full-v1"}' }), operation, result => result.body?.cancel())
        if (response.status !== 200 || response.headers.get("content-type") !== POSTGRES_BACKUP_CONTENT_TYPE ||
            !/private.*no-store/.test(response.headers.get("cache-control") || "") || response.headers.has("content-range") ||
            response.headers.has("content-length") || ![null, "identity"].includes(response.headers.get("content-encoding")) || !response.body) {
          void response.body?.cancel().catch(() => {}); fail()
        }
        reader = response.body.getReader()
        const bytes = (async function* () {
          try {
            for (;;) {
              const part = await guardedExport(reader.read(), operation)
              if (part.done) return
              if (!(part.value instanceof Uint8Array) || !part.value.length) fail()
              for (let offset = 0; offset < part.value.length; offset += policy.chunkBytes) yield part.value.subarray(offset, offset + policy.chunkBytes)
            }
          } finally { close() }
        })()
        return { bytes, close }
      } catch { close(); fail() }
    },
  }
}
