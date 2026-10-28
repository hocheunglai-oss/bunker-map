import { randomUUID } from "node:crypto"
import { fcunoConnectionPolicy } from "../config/fcunoConnections.ts"
import { POSTGRES_BACKUP_CONTENT_TYPE, assertExact, guardedExport, postgresBackupWeek } from "./postgresBackupProtocol.mjs"

const policy = fcunoConnectionPolicy.postgresBackup
export const POSTGRES_BACKUP_URL = `${fcunoConnectionPolicy.vercel.productionOrigins[0]}${policy.sourcePath}`
const safeHeaders = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" }
function response(status) { return new Response(null, { status, headers: safeHeaders }) }

// Dependency contract: verifyToken MUST verify Google's signature (reuse
// verifyStorageBackupGoogleIdentity); admission MUST be a durable source-owned
// atomic admission, not a caller flag, process-local lock or Google-held lease.
// No production route installs this candidate until both adapters are proved.
export function createPostgresBackupHandler({ runtime, verifyToken, admission, openNative, now = Date.now }) {
  return async request => {
    if (runtime.enabled !== true || runtime.vercel !== "1" || runtime.environment !== "production" ||
        runtime.projectId !== fcunoConnectionPolicy.vercel.projectId) return response(404)
    if (request.url !== POSTGRES_BACKUP_URL || request.method !== "POST" || request.headers.get("content-type") !== "application/json" ||
        ["content-encoding", "range", "content-range", "x-fcuno-storage-mode"].some(header => request.headers.has(header))) return response(400)
    if (!/^[0-9]{10,30}$/.test(runtime.googleSubject || "") || typeof verifyToken !== "function" ||
        typeof admission?.acquire !== "function" || typeof admission?.finish !== "function" || typeof openNative !== "function") return response(503)
    const current = now(), hkt = new Date(current + 8 * 3600000)
    if (!Number.isSafeInteger(current) || hkt.getUTCHours() < policy.windowStartHourHkt || hkt.getUTCHours() >= policy.windowEndHourHkt) return response(403)
    const windowEnd = Date.UTC(hkt.getUTCFullYear(), hkt.getUTCMonth(), hkt.getUTCDate(), policy.windowEndHourHkt) - 8 * 3600000
    const deadline = Math.min(current + policy.maximumExportMs, windowEnd - 1000)
    if (deadline - current < 30000) return response(403)
    const stop = new AbortController(), signal = AbortSignal.any([request.signal, stop.signal, AbortSignal.timeout(deadline - current)])
    const context = { signal, deadline, now }
    let owned = null, opened = null, nativeOpeningStarted = false, cleanupPromise = null
    const cleanup = () => cleanupPromise ??= (async () => {
      let closed = false
      try {
        if (opened) { await opened.close(); closed = true }
        else closed = !nativeOpeningStarted
      } finally {
        stop.abort()
        // If native cleanup itself fails, preserve the source lease until its
        // bounded expiry rather than knowingly admitting overlapping readers.
        if (owned && closed) {
          const finishContext = { signal: AbortSignal.timeout(5000), deadline: now() + 5000, now }
          await guardedExport(admission.finish(owned, { exported: opened?.completed() === true }, finishContext), finishContext)
        }
      }
    })()
    try {
      const authorization = request.headers.get("authorization")
      if (!authorization || !/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(authorization) || authorization.length > 17000) return response(401)
      const claims = await guardedExport(verifyToken(authorization.slice(7), POSTGRES_BACKUP_URL, context), context)
      const seconds = Math.floor(now() / 1000)
      if (claims?.iss !== fcunoConnectionPolicy.storageMediaBackup.googleTokenIssuer || claims.aud !== POSTGRES_BACKUP_URL ||
          claims.sub !== runtime.googleSubject || claims.email !== fcunoConnectionPolicy.storageMediaBackup.googleServiceAccount || claims.email_verified !== true ||
          !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp) || claims.iat > seconds + 30 || claims.iat < seconds - 3630 ||
          claims.exp <= seconds || claims.exp <= claims.iat || claims.exp - claims.iat > 3630) return response(401)
      if (!request.body) return response(400)
      const reader = request.body.getReader(); let count = 0; const parts = []
      try {
        for (;;) {
          const part = await guardedExport(reader.read(), context)
          if (part.done) break
          count += part.value.byteLength; if (count > 64) return response(400)
          parts.push(part.value)
        }
      } finally { void reader.cancel().catch(() => {}); reader.releaseLock() }
      // Exact one-operation capability; no generic JSON parser, duplicate keys,
      // path expansion, SQL/arguments/env or future unknown fields accepted.
      if (Buffer.concat(parts).toString("utf8") !== '{"operation":"weekly-full-v1"}') return response(400)
      const week = postgresBackupWeek(current)
      const owner = randomUUID()
      owned = await guardedExport(admission.acquire({ week, owner, expiresAt: deadline }, context), context,
        value => {
          if (!value) return
          const lateContext = { signal: AbortSignal.timeout(5000), deadline: now() + 5000, now }
          return guardedExport(admission.finish(value, { exported: false }, lateContext), lateContext)
        })
      if (!owned) return response(409)
      assertExact(owned, ["week", "owner", "fence"])
      if (owned.week !== week || owned.owner !== owner || !Number.isSafeInteger(owned.fence) || owned.fence < 1) throw new Error("Admission failed")
      nativeOpeningStarted = true
      opened = await guardedExport(openNative(context), context, value => value?.close?.())
      const iterator = opened.bytes[Symbol.asyncIterator]()
      let ended = false
      const aborted = () => { void cleanup().catch(() => {}) }
      signal.addEventListener("abort", aborted, { once: true })
      const stream = new ReadableStream({
        async pull(controller) {
          try {
            const part = await guardedExport(iterator.next(), context)
            if (part.done) {
              ended = true; signal.removeEventListener("abort", aborted)
              await cleanup(); controller.close()
            } else controller.enqueue(part.value)
          } catch {
            ended = true; signal.removeEventListener("abort", aborted)
            await cleanup().catch(() => {}); controller.error(new Error("PostgreSQL export interrupted"))
          }
        },
        async cancel() {
          signal.removeEventListener("abort", aborted)
          // An unstarted async generator's return() does not enter finally.
          // Always close native sessions explicitly before iterator cleanup.
          await cleanup().catch(() => {})
          if (!ended) void Promise.resolve(iterator.return?.()).catch(() => {})
          ended = true
        },
      }, { highWaterMark: 0 })
      return new Response(stream, { status: 200,
        headers: { ...safeHeaders, "Content-Type": POSTGRES_BACKUP_CONTENT_TYPE } })
    } catch { await cleanup().catch(() => {}); return response(503) }
  }
}
