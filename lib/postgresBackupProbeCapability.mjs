import { fcunoConnectionPolicy as pins } from "../config/fcunoConnections.ts"
import { assertExact, guardedExport } from "./postgresBackupProtocol.mjs"

export const POSTGRES_PROBE_URL = `${pins.vercel.productionOrigins[0]}${pins.postgresBackup.sourcePath}-probe`
export const POSTGRES_PROBE_BODY = '{"operation":"verify-native-v1"}'
const headers = { "Cache-Control": "private, no-store, max-age=0", "CDN-Cache-Control": "no-store",
  "Vercel-CDN-Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }
const response = status => new Response(null, { status, headers })
const fail = () => { throw Error("Native compatibility unavailable") }
export function validatePostgresProbeResult(value, now) {
  assertExact(value, ["status", "scope", "databaseVersion", "checkedAt", "databaseLastStart", "clientTls", "backendTls",
    "restrictedSourceRole", "intrinsicCannotWrite", "exportPerformed", "recoveryVerified"])
  if (!Number.isSafeInteger(now) || value.status !== "verified" || value.scope !== "native-runtime-and-read-only-metadata" ||
      typeof value.databaseVersion !== "string" || !/^17\.[0-9]+(?: \([^\r\n()]{1,120}\))?$/.test(value.databaseVersion) ||
      !Number.isFinite(Date.parse(value.checkedAt)) || Math.abs(Date.parse(value.checkedAt) - now) > 60000 ||
      !Number.isFinite(Date.parse(value.databaseLastStart)) || Date.parse(value.databaseLastStart) > Date.parse(value.checkedAt) ||
      value.clientTls !== "verify-full" || value.backendTls !== true || value.restrictedSourceRole !== true ||
      value.intrinsicCannotWrite !== false || value.exportPerformed !== false || value.recoveryVerified !== false) fail()
  return value
}

// The same approved backup identity gets only a separate fixed metadata
// operation. No dump, native credentials, business rows or query parameters.
export function createPostgresProbeHandler({ runtime, verifyToken, probe, now = Date.now }) {
  let inFlight = null
  return async request => {
    if (runtime.POSTGRES_BACKUP_PROBE_ENABLED !== "1" || runtime.VERCEL !== "1" || runtime.VERCEL_ENV !== "production" ||
        runtime.VERCEL_PROJECT_ID !== pins.vercel.projectId) return response(404)
    if (request.url !== POSTGRES_PROBE_URL || request.method !== "POST" || request.headers.get("content-type") !== "application/json" ||
        ["content-encoding", "range", "content-range", "x-fcuno-storage-mode"].some(key => request.headers.has(key))) return response(400)
    if (!/^[0-9]{10,30}$/.test(runtime.POSTGRES_BACKUP_GOOGLE_SUBJECT || "") || typeof verifyToken !== "function" || typeof probe !== "function") return response(503)
    const current = now()
    if (!Number.isSafeInteger(current)) return response(503)
    const context = { signal: AbortSignal.any([request.signal, AbortSignal.timeout(30000)]), deadline: current + 30000, now }
    try {
      const authorization = request.headers.get("authorization")
      if (!authorization || !/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(authorization) || authorization.length > 17000) return response(401)
      const claims = await guardedExport(verifyToken(authorization.slice(7), POSTGRES_PROBE_URL, context), context)
      const seconds = Math.floor(now() / 1000)
      if (claims?.iss !== pins.storageMediaBackup.googleTokenIssuer || claims.aud !== POSTGRES_PROBE_URL ||
          claims.sub !== runtime.POSTGRES_BACKUP_GOOGLE_SUBJECT || claims.email !== pins.storageMediaBackup.googleServiceAccount || claims.email_verified !== true ||
          !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp) || claims.iat > seconds + 30 || claims.iat < seconds - 3630 ||
          claims.exp <= seconds || claims.exp <= claims.iat || claims.exp - claims.iat > 3630) return response(401)
      if (!request.body) return response(400)
      const reader = request.body.getReader(), parts = []; let size = 0
      try {
        for (;;) {
          const next = await guardedExport(reader.read(), context)
          if (next.done) break
          size += next.value.byteLength
          if (size > 64) return response(400)
          parts.push(next.value)
        }
      } finally { void reader.cancel().catch(() => {}); reader.releaseLock() }
      if (Buffer.concat(parts).toString("utf8") !== POSTGRES_PROBE_BODY) return response(400)
      // Only share active bounded work. Authorize each caller independently;
      // no settled success cache can turn an old check into fresh evidence.
      inFlight ??= Promise.resolve().then(() => probe()).finally(() => { inFlight = null })
      const result = validatePostgresProbeResult(await guardedExport(inFlight, context), now())
      return Response.json(result, { headers })
    } catch { return response(503) }
  }
}
