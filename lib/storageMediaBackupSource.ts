import { createHash, createHmac, timingSafeEqual } from "node:crypto"
import { fcunoConnectionPolicy } from "../config/fcunoConnections"

const policy = fcunoConnectionPolicy.storageMediaBackup
export const STORAGE_MEDIA_SOURCE_URL = `${fcunoConnectionPolicy.vercel.productionOrigins[0]}${policy.sourcePath}`
const STORAGE_ORIGIN = `https://${fcunoConnectionPolicy.supabase.projectRef}.supabase.co`
const PAGE_SIZE = 1000
const MAX_OBJECTS = 50_000
const MAX_BYTES = 1_000_000
const RECEIPT_SECONDS = 300
export const STORAGE_MEDIA_READ_SECONDS = 240
const HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  "CDN-Cache-Control": "no-store", "Vercel-CDN-Cache-Control": "no-store",
  Pragma: "no-cache", "X-Content-Type-Options": "nosniff",
}

export type StorageSourceIdentity = { bucket: string; path: string; id: string; version: string; sizeBytes: number }
export type StorageSourceInfo = { source: StorageSourceIdentity; etag: string; modifiedAt?: string | null }
export type StorageReadProvider = {
  listObjects(bucket: string, cursor: string | undefined, signal: AbortSignal): Promise<unknown>
  inspect(bucket: string, path: string, signal: AbortSignal): Promise<StorageSourceInfo>
  open(source: StorageSourceIdentity, etag: string, signal: AbortSignal): Promise<Response>
}
type Claims = { iss?: unknown; aud?: unknown; sub?: unknown; email?: unknown; email_verified?: unknown; iat?: unknown; exp?: unknown }
export type StorageSourceDependencies = {
  runtime: { enabled?: string; recurringEnabled?: string; recurringActivatedAt?: string; vercel?: string; environment?: string; projectId?: string; windowStartsAt?: string; windowExpiresAt?: string; approvedInventorySha256?: string }
  now(): number
  verifyToken(token: string, audience: string): Promise<Claims | undefined>
  provider(): { storage: StorageReadProvider; receiptKey: string }
  onFailure?(code: string): void
}

class SourceError extends Error { constructor(readonly status: number, readonly code: string) { super(code) } }
function fail(status: number, code: string): never { throw new SourceError(status, code) }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail(502, "invalid_provider_response")
  return value as Record<string, unknown>
}
function exact(value: Record<string, unknown>, fields: string[]) {
  return Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field))
}
function accessWindow(runtime: StorageSourceDependencies["runtime"], now: number) {
  const start = Date.parse(runtime.windowStartsAt || ""), end = Date.parse(runtime.windowExpiresAt || "")
  if (!Number.isFinite(start) || !Number.isFinite(end) || new Date(start).toISOString() !== runtime.windowStartsAt ||
      new Date(end).toISOString() !== runtime.windowExpiresAt || end <= start || end - start > 3_600_000 ||
      now < start || now >= end) fail(404, "not_found")
  return end
}
// This is a separate, explicit recurring authorization. It never stretches or
// silently replaces the legacy approved one-hour snapshot window.
export function recurringStorageAccessWindow(now: number) {
  const shifted = new Date(now + 8 * 3_600_000)
  const day = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - 8 * 3_600_000
  const start = day + policy.recurring.windowStartHourHkt * 3_600_000
  const end = day + policy.recurring.windowEndHourHkt * 3_600_000
  if (!Number.isSafeInteger(now) || now < start || now >= end) fail(404, "not_found")
  return { windowStartsAt: new Date(start).toISOString(), windowExpiresAt: new Date(end).toISOString() }
}
type RecurringSnapshot = { inventorySha256: string; windowStartsAt: string; windowExpiresAt: string }
function recurringSnapshot(value: unknown, window: ReturnType<typeof recurringStorageAccessWindow>): RecurringSnapshot {
  const snapshot = record(value)
  if (!exact(snapshot, ["inventorySha256", "windowStartsAt", "windowExpiresAt"]) ||
      typeof snapshot.inventorySha256 !== "string" || !/^[0-9a-f]{64}$/.test(snapshot.inventorySha256) ||
      snapshot.windowStartsAt !== window.windowStartsAt || snapshot.windowExpiresAt !== window.windowExpiresAt) fail(403, "invalid_snapshot")
  return { inventorySha256: snapshot.inventorySha256, ...window }
}
function boundedRecurringInventory(sources: StorageSourceIdentity[]) {
  let total = 0
  if (sources.length > policy.recurring.maxObjects) fail(413, "inventory_limit_exceeded")
  for (const source of sources) {
    if (source.bucket !== policy.sourceBucket || source.sizeBytes > policy.recurring.maxObjectBytes) fail(413, "inventory_limit_exceeded")
    total += source.sizeBytes
    if (!Number.isSafeInteger(total) || total > policy.recurring.maxTotalBytes) fail(413, "inventory_limit_exceeded")
  }
}
function text(value: unknown, max = 4096): value is string {
  return typeof value === "string" && value.length > 0 && value.isWellFormed() &&
    !/[\x00-\x1f\x7f]/.test(value) && Buffer.byteLength(value) <= max
}
export function validateStorageSource(value: unknown): StorageSourceIdentity {
  const source = record(value)
  if (!exact(source, ["bucket", "path", "id", "version", "sizeBytes"]) ||
      !text(source.bucket, 100) || !text(source.path) || !text(source.id, 200) || !text(source.version, 200) ||
      !Number.isSafeInteger(source.sizeBytes) || Number(source.sizeBytes) < 0 || Object.is(source.sizeBytes, -0)) fail(400, "invalid_source")
  return { bucket: source.bucket, path: source.path, id: source.id, version: source.version, sizeBytes: source.sizeBytes as number }
}
function equalSource(left: StorageSourceIdentity, right: StorageSourceIdentity) {
  return left.bucket === right.bucket && left.path === right.path && left.id === right.id &&
    left.version === right.version && left.sizeBytes === right.sizeBytes
}
export function storageSourceIdentitySha256(source: StorageSourceIdentity) {
  return createHash("sha256").update(JSON.stringify(validateStorageSource(source))).digest("hex")
}
export function storageSourceInventorySha256(sources: StorageSourceIdentity[]) {
  const ordered = sources.map(validateStorageSource).sort((a, b) => {
    const left = JSON.stringify(a), right = JSON.stringify(b)
    return left < right ? -1 : left > right ? 1 : 0
  })
  return createHash("sha256").update(JSON.stringify(ordered)).digest("hex")
}
function strongEtag(value: unknown): string {
  if (!text(value, 512) || !/^"[\x21\x23-\x7e]+"$/.test(value)) fail(502, "missing_strong_etag")
  return value
}

// Opaque keys are never trimmed, URL-decoded, case-folded or Unicode-normalised.
// WHATWG URL cannot represent standalone dot segments, so fail closed for them.
export function encodedStorageKey(bucket: string, path: string) {
  if (!text(bucket, 100) || bucket.includes("/") || !text(path) ||
      [bucket, ...path.split("/")].some(segment => segment === "." || segment === "..")) fail(409, "unrepresentable_storage_key")
  const encoded = [bucket, ...path.split("/")].map(segment => encodeURIComponent(segment)).join("/")
  const url = new URL(`${STORAGE_ORIGIN}/storage/v1/object/info/${encoded}`)
  if (url.pathname !== `/storage/v1/object/info/${encoded}`) fail(409, "unrepresentable_storage_key")
  return encoded
}
function receiptBody(source: StorageSourceIdentity, expires: number) { return JSON.stringify([source.bucket, source.path, source.id, source.version, source.sizeBytes, expires]) }
function mac(body: string, key: string) { return createHmac("sha256", key).update("fcuno-storage-media-read/v1\0").update(body).digest("base64url") }
function issueReceipt(source: StorageSourceIdentity, key: string, now: number) {
  const expires = Math.floor(now / 1000) + RECEIPT_SECONDS
  return `${expires}.${mac(receiptBody(source, expires), key)}`
}
function verifyReceipt(source: StorageSourceIdentity, receipt: unknown, key: string, now: number) {
  if (typeof receipt !== "string" || !/^\d{10}\.[A-Za-z0-9_-]{43}$/.test(receipt)) fail(403, "invalid_inventory_receipt")
  const [expiration, signature] = receipt.split(".")
  const expires = Number(expiration), current = Math.floor(now / 1000)
  if (expires <= current || expires > current + RECEIPT_SECONDS) fail(403, "expired_inventory_receipt")
  if (!timingSafeEqual(Buffer.from(signature), Buffer.from(mac(receiptBody(source, expires), key)))) fail(403, "invalid_inventory_receipt")
}

export async function verifyStorageBackupGoogleIdentity(token: string, audience: string): Promise<Claims | undefined> {
  // Existing locked dependency; this fetches only Google's public signing certs.
  const { google } = await import("googleapis")
  const verifier = new google.auth.OAuth2({ issuers: [policy.googleTokenIssuer],
    transporterOptions: { signal: AbortSignal.timeout(10_000), maxRedirects: 0 } })
  return (await verifier.verifyIdToken({ idToken: token, audience, maxExpiry: 3630 })).getPayload()
}
export function validateStorageBackupGoogleClaims(claims: Claims | undefined, now: number) {
  const current = Math.floor(now / 1000)
  if (!claims || claims.iss !== policy.googleTokenIssuer || claims.aud !== STORAGE_MEDIA_SOURCE_URL ||
      claims.email !== policy.googleServiceAccount || claims.email_verified !== true ||
      typeof claims.sub !== "string" || !/^\d{1,40}$/.test(claims.sub) ||
      !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp) ||
      Number(claims.iat) > current + 30 || Number(claims.iat) < current - 3630 ||
      Number(claims.exp) <= current || Number(claims.exp) <= Number(claims.iat) ||
      Number(claims.exp) - Number(claims.iat) > 3630) fail(401, "unauthorized")
}

export async function readBoundedStorageJson(response: Response, limit: number, signal: AbortSignal): Promise<unknown> {
  if (!response.body) fail(502, "empty_json")
  const reader = response.body.getReader()
  const pieces: Uint8Array[] = []
  let total = 0, done = false
  const cancel = () => { void reader.cancel().catch(() => {}) }
  signal.throwIfAborted()
  signal.addEventListener("abort", cancel, { once: true })
  try {
    for (;;) {
      signal.throwIfAborted()
      const part = await reader.read()
      signal.throwIfAborted()
      if (part.done) { done = true; break }
      total += part.value.byteLength
      if (total > limit) fail(413, "json_limit_exceeded")
      pieces.push(part.value)
    }
    try { return JSON.parse(Buffer.concat(pieces).toString("utf8")) }
    catch { return fail(400, "invalid_json") }
  } finally {
    signal.removeEventListener("abort", cancel)
    if (!done) await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export function createSupabaseStorageReadProvider(options: { url: string; serviceRoleKey: string; fetch: typeof fetch }): StorageReadProvider {
  if (options.url !== STORAGE_ORIGIN || !options.serviceRoleKey) fail(503, "source_not_configured")
  async function api(path: string, signal: AbortSignal, body?: unknown) {
    const response = await options.fetch(`${STORAGE_ORIGIN}/storage/v1${path}`, {
      method: body === undefined ? "GET" : "POST", redirect: "error", cache: "no-store",
      signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
      headers: { apikey: options.serviceRoleKey, Authorization: `Bearer ${options.serviceRoleKey}`, "Content-Type": "application/json", "Cache-Control": "no-cache" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (response.status !== 200) { await response.body?.cancel(); fail(502, "storage_read_failed") }
    return readBoundedStorageJson(response, MAX_BYTES, signal)
  }
  return {
    listObjects: (bucket, cursor, signal) => api(`/object/list-v2/${encodedStorageKey(bucket, "_").slice(0, -2)}`, signal,
      { prefix: "", with_delimiter: false, limit: PAGE_SIZE, sortBy: { column: "name", order: "asc" }, ...(cursor ? { cursor } : {}) }),
    async inspect(bucket, path, signal) {
      const data = record(await api(`/object/info/${encodedStorageKey(bucket, path)}`, signal))
      const source = validateStorageSource({ bucket: data.bucket_id, path: data.name, id: data.id, version: data.version, sizeBytes: data.size })
      if (source.bucket !== bucket || source.path !== path) fail(502, "storage_identity_mismatch")
      // Storage's info ETag is backend metadata, never user-supplied metadata.
      const etag = typeof data.etag === "string" && !data.etag.startsWith('"') ? `"${data.etag}"` : data.etag
      const rawModified = data.updated_at ?? data.updatedAt
      const modified = typeof rawModified === "string" ? Date.parse(rawModified) : NaN
      // Only server-owned object-info metadata, not the user metadata object.
      const modifiedAt = Number.isFinite(modified) ? new Date(modified).toISOString() : null
      return { source, etag: strongEtag(etag), ...(rawModified === undefined ? {} : { modifiedAt }) }
    },
    async open(source, etag, signal) {
      if (source.bucket !== policy.sourceBucket || source.sizeBytes > Math.max(policy.approvedTotalBytes, policy.recurring.maxObjectBytes)) fail(403, "unapproved_source")
      return options.fetch(`${STORAGE_ORIGIN}/storage/v1/object/authenticated/${encodedStorageKey(source.bucket, source.path)}`, {
        method: "GET", redirect: "error", cache: "no-store", signal,
        headers: { apikey: options.serviceRoleKey, Authorization: `Bearer ${options.serviceRoleKey}`,
          "If-Match": strongEtag(etag), "Accept-Encoding": "identity", "Cache-Control": "no-cache" },
      })
    },
  }
}

async function inventory(storage: StorageReadProvider, signal: AbortSignal, options?: { recurring?: boolean; modified?: { id: string; version: string; modifiedAt: string | null }[] }) {
  const result: StorageSourceIdentity[] = [], paths = new Set<string>(), ids = new Set<string>()
  for (const bucket of [policy.sourceBucket]) {
    let cursor: string | undefined
    const cursors = new Set<string>()
    for (;;) {
      const page = record(await storage.listObjects(bucket, cursor, signal))
      if (!Array.isArray(page.objects) || page.objects.length > PAGE_SIZE || !Array.isArray(page.folders) || page.folders.length ||
          typeof page.hasNext !== "boolean") fail(502, "invalid_object_page")
      for (const raw of page.objects) {
        const row = record(raw)
        if (!text(row.name) || !text(row.id, 200) || result.length >= (options?.recurring ? policy.recurring.maxObjects : MAX_OBJECTS)) fail(502, "invalid_object_inventory")
        const pathKey = JSON.stringify([bucket, row.name]), idKey = JSON.stringify([bucket, row.id])
        if (paths.has(pathKey) || ids.has(idKey)) fail(409, "inventory_changed")
        const info = await storage.inspect(bucket, row.name, signal)
        if (info.source.id !== row.id || info.source.bucket !== bucket || info.source.path !== row.name) fail(409, "inventory_changed")
        const source = validateStorageSource(info.source)
        strongEtag(info.etag)
        paths.add(pathKey); ids.add(idKey); result.push(source)
        options?.modified?.push({ id: source.id, version: source.version, modifiedAt: typeof info.modifiedAt === "string" && Number.isFinite(Date.parse(info.modifiedAt)) ? new Date(info.modifiedAt).toISOString() : null })
        if (options?.recurring) boundedRecurringInventory(result)
      }
      if (!page.hasNext) break
      if (!page.objects.length || !text(page.nextCursor, 16_384) || cursors.has(page.nextCursor)) fail(502, "invalid_object_cursor")
      cursors.add(page.nextCursor); cursor = page.nextCursor
    }
  }
  return result
}

export async function readCurrentStorageMediaInventory(storage: StorageReadProvider, signal: AbortSignal) {
  const sources = await inventory(storage, signal, { recurring: true })
  boundedRecurringInventory(sources)
  return sources
}

export async function readCurrentStorageMediaInventoryStatus(storage: StorageReadProvider, signal: AbortSignal) {
  const modifiedAtByIdentity: { id: string; version: string; modifiedAt: string | null }[] = []
  const sources = await inventory(storage, signal, { recurring: true, modified: modifiedAtByIdentity })
  return { inventory: sources, modifiedAtByIdentity }
}

function checkedStream(source: StorageSourceIdentity, etag: string, upstream: Response, storage: StorageReadProvider, signal: AbortSignal, stopUpstream: () => void) {
  const length = upstream.headers.get("content-length")
  if (upstream.status !== 200 || upstream.headers.get("etag") !== etag || upstream.headers.has("content-range") ||
      ![null, "identity"].includes(upstream.headers.get("content-encoding")) || !length || !/^(0|[1-9]\d*)$/.test(length) ||
      Number(length) !== source.sizeBytes || !upstream.body) {
    void upstream.body?.cancel().catch(() => {})
    stopUpstream()
    fail(502, "unverified_storage_read")
  }
  const reader = upstream.body.getReader()
  let total = 0, stopped = false, cleanup = () => {}
  let pending: Uint8Array | null = null, pendingOffset = 0
  const close = async () => {
    if (stopped) return
    stopped = true; cleanup()
    stopUpstream()
    pending = null
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const abort = () => { controller.error(new Error("Storage read stopped")); void close() }
      cleanup = () => signal.removeEventListener("abort", abort)
      signal.addEventListener("abort", abort, { once: true })
      if (signal.aborted) abort()
    },
    async pull(controller) {
      try {
        signal.throwIfAborted()
        if (pending) {
          const end = Math.min(pendingOffset + 256 * 1024, pending.byteLength)
          controller.enqueue(pending.subarray(pendingOffset, end)); pendingOffset = end
          if (end === pending.byteLength) { pending = null; pendingOffset = 0 }
          return
        }
        const part = await reader.read()
        signal.throwIfAborted()
        if (part.done) {
          if (total !== source.sizeBytes) fail(502, "storage_size_mismatch")
          const after = await storage.inspect(source.bucket, source.path, signal)
          if (!equalSource(after.source, source) || after.etag !== etag) fail(409, "source_changed")
          signal.throwIfAborted()
          await close(); controller.close(); return
        }
        total += part.value.byteLength
        if (total > source.sizeBytes) fail(502, "storage_size_mismatch")
        // Upstream fetch chunks are not accumulated; downstream backpressure
        // controls reads, and each emitted chunk is bounded to 256 KiB.
        pending = part.value; pendingOffset = Math.min(256 * 1024, pending.byteLength)
        controller.enqueue(pending.subarray(0, pendingOffset))
        if (pendingOffset === pending.byteLength) { pending = null; pendingOffset = 0 }
      } catch {
        await close(); controller.error(new Error("Storage read could not be verified"))
      }
    },
    cancel: close,
  }, { highWaterMark: 0 })
  return new Response(body, { headers: { ...HEADERS, "Content-Type": "application/octet-stream", "X-Fcuno-Storage-Expected-Bytes": String(source.sizeBytes),
    ETag: etag, "X-Fcuno-Storage-Source-Sha256": storageSourceIdentitySha256(source) } })
}

export async function handleStorageMediaBackupSource(request: Request, deps: StorageSourceDependencies): Promise<Response> {
  const startedAt = deps.now()
  try {
    const runtime = deps.runtime
    const mode = request.headers.get("x-fcuno-storage-mode")
    const recurring = mode === "recurring"
    if ((mode !== null && !recurring) || (recurring ? runtime.recurringEnabled !== "1" : runtime.enabled !== "1") || runtime.vercel !== "1" || runtime.environment !== "production" ||
        runtime.projectId !== fcunoConnectionPolicy.vercel.projectId) fail(404, "not_found")
    const dailyWindow = recurring ? recurringStorageAccessWindow(deps.now()) : null
    const activatedAt = Date.parse(runtime.recurringActivatedAt || "")
    if (recurring && (!Number.isFinite(activatedAt) || new Date(activatedAt).toISOString() !== runtime.recurringActivatedAt || activatedAt > deps.now())) fail(404, "not_found")
    const windowEnd = dailyWindow ? Date.parse(dailyWindow.windowExpiresAt) : accessWindow(runtime, deps.now())
    if (!recurring && (!runtime.approvedInventorySha256 || !/^[0-9a-f]{64}$/.test(runtime.approvedInventorySha256))) fail(404, "not_found")
    if (request.url !== STORAGE_MEDIA_SOURCE_URL || request.headers.has("origin") || request.headers.has("cookie")) fail(403, "forbidden")
    const authorization = request.headers.get("authorization") || ""
    if (!/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(authorization) || authorization.length > 16_384) fail(401, "unauthorized")
    let claims: Claims | undefined
    try { claims = await deps.verifyToken(authorization.slice(7), STORAGE_MEDIA_SOURCE_URL) }
    catch { fail(401, "unauthorized") }
    validateStorageBackupGoogleClaims(claims, deps.now())
    if (request.method !== "POST") fail(405, "method_not_allowed")
    if (request.headers.get("content-type") !== "application/json") fail(415, "json_required")
    const inputSignal = AbortSignal.any([request.signal, AbortSignal.timeout(10_000)])
    const input = record(await readBoundedStorageJson(new Response(request.body), 20_000, inputSignal))
    if (!["inventory", "inspect", "read"].includes(String(input.operation)) ||
        !exact(input, input.operation === "inventory" ? ["operation"] : ["operation", "source", "receipt", ...(recurring ? ["snapshot"] : [])])) fail(400, "invalid_operation")
    const remaining = Math.min((input.operation === "read" ? STORAGE_MEDIA_READ_SECONDS * 1000 : 55_000) - (deps.now() - startedAt), windowEnd - deps.now())
    if (!Number.isSafeInteger(remaining) || remaining <= 0) fail(403, "access_window_ending")
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(remaining)])
    const provider = deps.provider(), storage = provider.storage
    if (!provider.receiptKey) fail(503, "source_not_configured")
    let snapshot: RecurringSnapshot | null = null
    if (recurring && input.operation !== "inventory") snapshot = recurringSnapshot(input.snapshot, dailyWindow!)
    const receiptKeyFor = (daily: RecurringSnapshot | null) => createHmac("sha256", provider.receiptKey).update(daily ?
      `fcuno-storage-snapshot/v2\0${JSON.stringify(daily)}` : `fcuno-storage-snapshot/v1\0${runtime.windowStartsAt}\0${runtime.approvedInventorySha256}`).digest("hex")
    if (input.operation === "inventory") {
      const sources = await inventory(storage, signal, { recurring })
      if (recurring) {
        boundedRecurringInventory(sources)
        const digest = storageSourceInventorySha256(sources)
        // A non-atomic storage cursor walk is not a snapshot. Require a second
        // full walk to agree before issuing snapshot-bound short-lived reads.
        const after = await inventory(storage, signal, { recurring: true })
        boundedRecurringInventory(after)
        if (storageSourceInventorySha256(after) !== digest) fail(409, "inventory_changed")
        snapshot = { inventorySha256: digest, ...dailyWindow! }
      } else if (sources.length !== policy.approvedObjectCount || sources.reduce((sum, source) => sum + source.sizeBytes, 0) !== policy.approvedTotalBytes ||
          storageSourceInventorySha256(sources) !== runtime.approvedInventorySha256) fail(409, "unapproved_inventory")
      const receiptKey = receiptKeyFor(snapshot)
      const items = sources.map(source => ({ source, receipt: issueReceipt(source, receiptKey, deps.now()) }))
      const body = JSON.stringify({ schema: recurring ? "fcuno.storage-media-source/v2" : "fcuno.storage-media-source/v1", ...(snapshot ? { snapshot } : {}), items })
      if (Buffer.byteLength(body) > MAX_BYTES) fail(413, "inventory_limit_exceeded")
      if (recurring) recurringStorageAccessWindow(deps.now()); else accessWindow(runtime, deps.now())
      return new Response(body, { headers: { ...HEADERS, "Content-Type": "application/json" } })
    }
    const source = validateStorageSource(input.source)
    if (source.bucket !== policy.sourceBucket || source.sizeBytes > (recurring ? policy.recurring.maxObjectBytes : policy.approvedTotalBytes)) fail(403, "unapproved_source")
    verifyReceipt(source, input.receipt, receiptKeyFor(snapshot), deps.now())
    const before = await storage.inspect(source.bucket, source.path, signal)
    if (!equalSource(before.source, source)) fail(409, "source_changed")
    strongEtag(before.etag)
    if (input.operation === "inspect") {
      if (recurring) recurringStorageAccessWindow(deps.now()); else accessWindow(runtime, deps.now())
      return Response.json({ source, etag: before.etag }, { headers: HEADERS })
    }
    const upstreamController = new AbortController(), upstreamSignal = AbortSignal.any([signal, upstreamController.signal])
    const upstream = await storage.open(source, before.etag, upstreamSignal)
    return checkedStream(source, before.etag, upstream, storage, upstreamSignal, () => upstreamController.abort())
  } catch (error) {
    const known = error instanceof SourceError
    const code = known ? error.code : "source_unavailable"
    // Emit a bounded code only: never log tokens, URLs, paths or provider errors.
    if (!known || error.status >= 500) deps.onFailure?.(code)
    return Response.json({ error: code }, { status: known ? error.status : 503, headers: HEADERS })
  }
}
