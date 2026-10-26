import { createHash } from "node:crypto"
import { fcunoConnectionPolicy } from "../../config/fcunoConnections.ts"

const policy = fcunoConnectionPolicy.storageMediaBackup
const SOURCE_URL = `${fcunoConnectionPolicy.vercel.productionOrigins[0]}${policy.sourcePath}`
const METADATA_IDENTITY_URL = `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=${encodeURIComponent(SOURCE_URL)}`
const MAX_JSON_BYTES = 1_000_000
const MAX_CHUNK_BYTES = 256 * 1024

function fail() { throw new Error("Storage media source could not be verified") }
function sourceKey(source) { return JSON.stringify([source.bucket, source.path, source.id, source.version, source.sizeBytes]) }
function identity(value) {
  if (!value || Object.keys(value).sort().join(",") !== "bucket,id,path,sizeBytes,version" ||
      ![value.bucket, value.path, value.id, value.version].every(item => typeof item === "string" && item && item.isWellFormed() && !/[\x00-\x1f\x7f]/.test(item) && Buffer.byteLength(item) <= 4096) ||
      !Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 0 || Object.is(value.sizeBytes, -0)) fail()
  return { bucket: value.bucket, path: value.path, id: value.id, version: value.version, sizeBytes: value.sizeBytes }
}
function signalFor(context, maximum = 55_000, now = Date.now) {
  context.signal.throwIfAborted()
  const remaining = context.deadline - now()
  if (!Number.isSafeInteger(remaining) || remaining <= 0) fail()
  return AbortSignal.any([context.signal, AbortSignal.timeout(Math.min(remaining, maximum))])
}
async function boundedText(response, maximum, signal) {
  if (!response.body) fail()
  const reader = response.body.getReader(), pieces = []
  let size = 0, done = false
  const stop = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener("abort", stop, { once: true })
  try {
    for (;;) {
      signal.throwIfAborted()
      const part = await reader.read()
      signal.throwIfAborted()
      if (part.done) { done = true; break }
      size += part.value.byteLength
      if (size > maximum) fail()
      pieces.push(part.value)
    }
    return Buffer.concat(pieces).toString("utf8")
  } finally {
    signal.removeEventListener("abort", stop)
    if (!done) void reader.cancel().catch(() => {})
    try { reader.releaseLock() } catch { /* A cancelled pending read settles independently. */ }
  }
}

// No local OAuth refresh token, key file, Supabase credential, IAM change, or
// GOOGLE_APPLICATION_CREDENTIALS fallback. Only this Cloud Run job's metadata
// identity can request a short-lived, fixed-audience Google ID token.
export function createMetadataIdentityTokenProvider({ fetch: fetchImpl = fetch, runtime = process.env, now = Date.now } = {}) {
  return async context => {
    if (runtime.CLOUD_RUN_JOB !== policy.googleJob || runtime.GOOGLE_APPLICATION_CREDENTIALS) fail()
    const signal = signalFor(context, 55_000, now)
    const response = await fetchImpl(METADATA_IDENTITY_URL, {
      headers: { "Metadata-Flavor": "Google" }, signal, redirect: "error", cache: "no-store",
    })
    if (response.status !== 200 || response.headers.get("metadata-flavor") !== "Google") { await response.body?.cancel(); fail() }
    const token = await boundedText(response, 16_384, signal)
    if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) fail()
    let claims
    try { claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")) } catch { fail() }
    const current = Math.floor(now() / 1000)
    // This is a local target check, not signature verification. The source
    // endpoint independently verifies Google's signature and every claim.
    if (claims.iss !== policy.googleTokenIssuer || claims.aud !== SOURCE_URL || claims.email !== policy.googleServiceAccount ||
        claims.email_verified !== true || !Number.isSafeInteger(claims.exp) || !Number.isSafeInteger(claims.iat) ||
        claims.exp <= current || claims.iat > current + 30 || claims.iat < current - 3630 ||
        claims.exp <= claims.iat || claims.exp - claims.iat > 3630) fail()
    return token
  }
}

export function createStorageMediaSourceAdapter({ fetch: fetchImpl = fetch, getIdentityToken, now = Date.now, mode = "approved-snapshot" } = {}) {
  if (typeof getIdentityToken !== "function") fail()
  if (!["approved-snapshot", "recurring"].includes(mode)) fail()
  const receipts = new Map(), etags = new Map()
  let baseline = null, snapshot = null
  async function api(input, context, stream = false) {
    const local = stream ? new AbortController() : null
    const signal = local ? AbortSignal.any([signalFor(context, 240_000, now), local.signal]) : signalFor(context, 55_000, now)
    const token = await getIdentityToken(context)
    const response = await fetchImpl(SOURCE_URL, {
      method: "POST", redirect: "error", cache: "no-store", signal,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Accept-Encoding": "identity", "Cache-Control": "no-cache",
        ...(mode === "recurring" ? { "X-Fcuno-Storage-Mode": "recurring" } : {}) },
      body: JSON.stringify(input),
    })
    if (response.status !== 200) { local?.abort(); void response.body?.cancel().catch(() => {}); fail() }
    if (stream) return { response, signal, stop: () => local.abort() }
    try { return JSON.parse(await boundedText(response, MAX_JSON_BYTES, signal)) } catch { fail() }
  }
  async function request(operation, source, context) {
    const key = sourceKey(identity(source))
    let receipt = receipts.get(key)
    if (typeof receipt !== "string") fail()
    if (Number(receipt.split(".")[0]) <= Math.floor(now() / 1000) + 60) {
      await loadInventory(context)
      receipt = receipts.get(key)
      if (typeof receipt !== "string" || Number(receipt.split(".")[0]) <= Math.floor(now() / 1000) + 60) fail()
    }
    return { operation, source, receipt, ...(mode === "recurring" ? { snapshot } : {}) }
  }
  function checkedInfo(result, source) {
    if (sourceKey(identity(result?.source)) !== sourceKey(identity(source)) ||
        typeof result.etag !== "string" || !/^"[\x21\x23-\x7e]+"$/.test(result.etag)) fail()
    const key = sourceKey(source), existing = etags.get(key)
    if (existing && existing !== result.etag) fail()
    etags.set(key, result.etag)
    return result
  }
  async function loadInventory(context) {
      const result = await api({ operation: "inventory" }, context)
      if (result?.schema !== (mode === "recurring" ? "fcuno.storage-media-source/v2" : "fcuno.storage-media-source/v1") || !Array.isArray(result.items) || result.items.length > (mode === "recurring" ? policy.recurring.maxObjects : 50_000)) fail()
      const paths = new Set(), ids = new Set(), sources = [], nextReceipts = new Map()
      for (const item of result.items) {
        const source = identity(item?.source), path = JSON.stringify([source.bucket, source.path]), id = JSON.stringify([source.bucket, source.id])
        if (paths.has(path) || ids.has(id) || typeof item.receipt !== "string" || !/^\d{10}\.[A-Za-z0-9_-]{43}$/.test(item.receipt) ||
            Number(item.receipt.split(".")[0]) <= Math.floor(now() / 1000) || Number(item.receipt.split(".")[0]) > Math.floor(now() / 1000) + 330) fail()
        paths.add(path); ids.add(id); sources.push(source); nextReceipts.set(sourceKey(source), item.receipt)
      }
      const fingerprint = JSON.stringify(sources.map(sourceKey).sort())
      if (baseline !== null && baseline !== fingerprint) fail()
      if (mode === "recurring") {
        const next = result.snapshot
        const total = sources.reduce((sum, item) => sum + item.sizeBytes, 0)
        const sorted = sources.slice().sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0)
        if (!next || Object.keys(next).sort().join(",") !== "inventorySha256,windowExpiresAt,windowStartsAt" ||
            next.inventorySha256 !== createHash("sha256").update(JSON.stringify(sorted)).digest("hex") ||
            sources.some(item => item.bucket !== policy.sourceBucket || item.sizeBytes > policy.recurring.maxObjectBytes) ||
            !Number.isSafeInteger(total) || total > policy.recurring.maxTotalBytes ||
            ![next.windowStartsAt, next.windowExpiresAt].every(value => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value) ||
            Date.parse(next.windowStartsAt) > now() || Date.parse(next.windowExpiresAt) <= now() ||
            Date.parse(next.windowExpiresAt) - Date.parse(next.windowStartsAt) !== (policy.recurring.windowEndHourHkt - policy.recurring.windowStartHourHkt) * 3_600_000 ||
            new Date(Date.parse(next.windowStartsAt) + 8 * 3_600_000).getUTCHours() !== policy.recurring.windowStartHourHkt ||
            new Date(next.windowStartsAt).getUTCMinutes() !== 0 || new Date(next.windowStartsAt).getUTCSeconds() !== 0 || new Date(next.windowStartsAt).getUTCMilliseconds() !== 0 ||
            (snapshot && JSON.stringify(snapshot) !== JSON.stringify(next))) fail()
        snapshot = structuredClone(next)
      }
      baseline = fingerprint; receipts.clear()
      for (const [key, receipt] of nextReceipts) receipts.set(key, receipt)
      return sources
  }
  return {
    inventory: loadInventory,
    snapshot() { if (mode !== "recurring" || !snapshot) fail(); return structuredClone(snapshot) },
    async inspectSource(source, context) {
      return checkedInfo(await api(await request("inspect", source, context), context), source).source
    },
    async openSource(source, context) {
      const expected = identity(source), etag = etags.get(sourceKey(expected))
      if (!etag) fail()
      const { response, signal, stop } = await api(await request("read", expected, context), context, true)
      const length = response.headers.get("x-fcuno-storage-expected-bytes")
      const digest = createHash("sha256").update(JSON.stringify(expected)).digest("hex")
      if (response.headers.get("content-type") !== "application/octet-stream" || response.headers.get("x-fcuno-storage-source-sha256") !== digest ||
          !/private.*no-store/.test(response.headers.get("cache-control") || "") ||
          response.headers.get("etag") !== etag || response.headers.has("content-range") || response.headers.has("content-length") ||
          ![null, "identity"].includes(response.headers.get("content-encoding")) ||
          !length || !/^(0|[1-9]\d*)$/.test(length) || Number(length) !== source.sizeBytes || !response.body) {
        stop(); void response.body?.cancel().catch(() => {}); fail()
      }
      const reader = response.body.getReader()
      let total = 0, closed = false, finished = false, pending = null, offset = 0
      const close = () => {
        if (closed) return
        closed = true; pending = null
        signal.removeEventListener("abort", close); stop()
        void reader.cancel().catch(() => {})
        try { reader.releaseLock() } catch { /* A cancelled pending read settles independently. */ }
      }
      signal.addEventListener("abort", close, { once: true })
      const bytes = {
        [Symbol.asyncIterator]() { return this },
        async next() {
          try {
            if (finished) return { done: true }
            signal.throwIfAborted()
            if (closed) return { done: true }
            if (!pending) {
              const part = await reader.read()
              signal.throwIfAborted()
              if (part.done) { if (total !== source.sizeBytes) fail(); finished = true; close(); return { done: true } }
              total += part.value.byteLength
              if (total > source.sizeBytes) fail()
              pending = part.value; offset = 0
            }
            const end = Math.min(offset + MAX_CHUNK_BYTES, pending.byteLength), value = pending.subarray(offset, end)
            offset = end; if (offset === pending.byteLength) pending = null
            return { done: false, value }
          } catch (error) { close(); throw error }
        },
        async return() { close(); return { done: true } },
      }
      return { identity: identity(source), bytes }
    },
  }
}
