import { createHash } from "node:crypto"
import { fcunoConnectionPolicy } from "../../config/fcunoConnections.ts"
import { validateRecurringControl } from "../../lib/storageMediaRecurring.mjs"
import { validateControlRecord, validateSourceIdentity, validateTargetIdentity } from "../../lib/storageMediaBackup.mjs"
import { validatePostgresControl } from "../../lib/postgresBackupReceipt.mjs"

const policy = fcunoConnectionPolicy.storageMediaBackup
const ORIGIN = "https://storage.googleapis.com"
const BUCKET = policy.targetBucket
const PREFIX = policy.targetPrefix
const JSON_LIMIT = 1024 * 1024
const MANIFEST_LIMIT = 32 * 1024 * 1024
const CHUNK = 256 * 1024
const UINT64_MAX = 18446744073709551615n

function fail(code = "verification_failed") { throw new Error(`Storage media GCS ${code}`) }
function generation(value, zero = false) {
  if (zero && value === "0") return value
  if (typeof value !== "string" || !/^[1-9]\d{0,19}$/.test(value) || BigInt(value) > UINT64_MAX) fail("invalid_generation")
  return value
}
function size(value) {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value))) fail("invalid_size")
  return Number(value)
}
function crc(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]{6}==$/.test(value) || Buffer.from(value, "base64").toString("base64") !== value) fail("invalid_crc32c")
  return value
}
function crc32c(bytes) {
  let state = 0xffffffff
  for (const byte of bytes) {
    state = (state ^ byte) >>> 0
    for (let bit = 0; bit < 8; bit++) state = ((state >>> 1) ^ ((state & 1) ? 0x82f63b78 : 0)) >>> 0
  }
  const result = Buffer.alloc(4)
  result.writeUInt32BE((state ^ 0xffffffff) >>> 0)
  return result.toString("base64")
}
function record(value) { if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid_response"); return value }
function digest(bytes) { return createHash("sha256").update(bytes).digest("hex") }
async function discard(response) { void response?.body?.cancel().catch(() => {}) }
function cancelReader(reader) {
  // cancel() immediately closes the readable side, but an underlying source
  // may never settle its cleanup promise. Never await that untrusted promise
  // past an abort/deadline; always observe a later rejection.
  try { void Promise.resolve(reader.cancel()).catch(() => {}) } catch { /* Already closed. */ }
  try { reader.releaseLock() } catch { /* Cancellation already requested. */ }
}

// Race non-cooperative injected mocks too. A late HTTP response is discarded,
// never returned after the common operation has already been cancelled.
function guarded(promise, signal, late = () => {}) {
  return new Promise((resolve, reject) => {
    let settled = false
    const abort = () => { if (!settled) { settled = true; reject(signal.reason || new Error("Storage media GCS cancelled")) } }
    signal.addEventListener("abort", abort, { once: true })
    Promise.resolve(promise).then(value => {
      signal.removeEventListener("abort", abort)
      if (settled || signal.aborted) { void late(value); if (!settled) abort(); return }
      settled = true; resolve(value)
    }, error => {
      signal.removeEventListener("abort", abort)
      if (!settled) { settled = true; reject(error) }
    })
    if (signal.aborted) abort()
  })
}

/** No import-time IO, environment access, SDK cleanup, deletion or retries. */
export function createStorageMediaGcsAdapter({ fetch: fetchImpl = fetch, getAccessToken, runId, now = Date.now, mode = "approved-snapshot" } = {}) {
  if (typeof fetchImpl !== "function" || typeof getAccessToken !== "function" || typeof now !== "function" ||
      !["approved-snapshot", "recurring", "postgres-candidate", "postgres-recovery"].includes(mode) || typeof runId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(runId)) fail("invalid_configuration")
  const recovery = mode === "postgres-recovery", postgres = mode === "postgres-candidate" || recovery
  const scopedPrefix = postgres ? fcunoConnectionPolicy.postgresBackup.targetPrefix : mode === "recurring" ? `${PREFIX}/daily` : PREFIX
  const runPrefix = `${scopedPrefix}/runs/${runId}`
  const manifestObjectName = `${runPrefix}/${recovery ? "recovery" : "manifest"}.json`
  const controlName = `${scopedPrefix}/control.json`
  const validateControl = postgres ? validatePostgresControl : mode === "recurring" ? validateRecurringControl : validateControlRecord
  const maximumObjectBytes = postgres ? fcunoConnectionPolicy.postgresBackup.objectBytes : mode === "recurring" ? policy.recurring.maxObjectBytes : policy.approvedTotalBytes
  let bucketValidated = false
  function operation(context, maximum) {
    if (!context?.signal || typeof context.signal.throwIfAborted !== "function" || !Number.isSafeInteger(context.deadline)) fail("invalid_context")
    context.signal.throwIfAborted()
    const current = now(), remaining = Math.min(context.deadline - current, maximum)
    if (!Number.isSafeInteger(current) || !Number.isSafeInteger(remaining) || remaining <= 0) fail("deadline_exceeded")
    return { signal: AbortSignal.any([context.signal, AbortSignal.timeout(remaining)]), deadline: current + remaining }
  }
  function active(op) { op.signal.throwIfAborted(); if (now() >= op.deadline) fail("deadline_exceeded") }
  function target(value) {
    const result = validateTargetIdentity(value)
    generation(result.generation)
    if (result.bucket !== BUCKET || !new RegExp(`^${scopedPrefix}/runs/[A-Za-z0-9][A-Za-z0-9_-]{0,79}/(?:${postgres ? "archive/[0-9]{6}" : "objects/[0-9a-f]{64}"}|manifest\\.json${recovery ? "|recovery\\.json" : ""})$`).test(result.objectName)) fail("unapproved_target")
    return result
  }
  function objectUrl(name, query = {}) {
    const url = new URL(`${ORIGIN}/storage/v1/b/${encodeURIComponent(BUCKET)}/o/${encodeURIComponent(name)}`)
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
    return url.href
  }
  function uploadUrl(name, expected) {
    const url = new URL(`${ORIGIN}/upload/storage/v1/b/${encodeURIComponent(BUCKET)}/o`)
    url.searchParams.set("uploadType", "media"); url.searchParams.set("name", name); url.searchParams.set("ifGenerationMatch", expected)
    return url.href
  }
  async function request(url, op, init = {}) {
    active(op)
    const tokenOperation = operation(op, 20_000)
    const token = await guarded(getAccessToken(tokenOperation), tokenOperation.signal)
    if (typeof token !== "string" || !/^[A-Za-z0-9._~+/-]{1,16384}={0,2}$/.test(token)) fail("invalid_access_token")
    active(op)
    return guarded(fetchImpl(url, {
      ...init, redirect: "error", cache: "no-store", signal: op.signal,
      headers: { Authorization: `Bearer ${token}`, "Accept-Encoding": "identity", "Cache-Control": "no-store", ...init.headers },
    }), op.signal, discard)
  }
  async function boundedBytes(response, maximum, op) {
    if (!response.body) fail("empty_response")
    const reader = response.body.getReader(), pieces = []
    let total = 0, done = false
    const abort = () => { void reader.cancel().catch(() => {}) }
    op.signal.addEventListener("abort", abort, { once: true })
    try {
      for (;;) {
        active(op)
        const part = await guarded(reader.read(), op.signal)
        active(op)
        if (part.done) { done = true; break }
        total += part.value.byteLength
        if (total > maximum) fail("response_limit_exceeded")
        pieces.push(part.value)
      }
      return Buffer.concat(pieces)
    } finally {
      op.signal.removeEventListener("abort", abort)
      if (!done) cancelReader(reader)
      else reader.releaseLock()
    }
  }
  async function json(response, op) {
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await boundedBytes(response, JSON_LIMIT, op))) }
    catch { fail("invalid_json_response") }
  }
  async function validateBucket(context) {
    const op = operation(context, 20_000)
    const response = await request(`${ORIGIN}/storage/v1/b/${encodeURIComponent(BUCKET)}?fields=name,location,iamConfiguration,versioning${mode !== "approved-snapshot" ? ",lifecycle" : ""}`, op)
    if (response.status !== 200) { await discard(response); fail("bucket_read_failed") }
    const info = record(await json(response, op))
    if (info.name !== BUCKET || info.location !== policy.googleRegion.toUpperCase() || info.versioning?.enabled !== true ||
        info.iamConfiguration?.publicAccessPrevention !== "enforced" || info.iamConfiguration?.uniformBucketLevelAccess?.enabled !== true) fail("unsafe_bucket_configuration")
    if (mode !== "approved-snapshot" && info.lifecycle !== undefined) {
      if (!info.lifecycle || typeof info.lifecycle !== "object" || Array.isArray(info.lifecycle)) fail("unsafe_lifecycle_configuration")
      const rules = info.lifecycle?.rule
      if (rules !== undefined && (!Array.isArray(rules) || rules.length > 1000)) fail("unsafe_lifecycle_configuration")
      for (const rule of rules || []) {
        if (!rule || typeof rule !== "object" || !rule.action || typeof rule.action.type !== "string") fail("unsafe_lifecycle_configuration")
        if (rule.action.type !== "Delete") continue
        const prefixes = rule.condition?.matchesPrefix
        // An age/noncurrent-version condition is not a dependency safeguard:
        // an old generation may still be referenced by today's manifest.
        if (!Array.isArray(prefixes) || !prefixes.length || prefixes.length > 1000 || prefixes.some(prefix =>
          typeof prefix !== "string" || !prefix.isWellFormed() || Buffer.byteLength(prefix) > 4096 || /[\x00-\x1f\x7f]/.test(prefix) ||
          `${scopedPrefix}/`.startsWith(prefix) || prefix.startsWith(`${scopedPrefix}/`))) fail("unsafe_lifecycle_configuration")
      }
    }
    op.signal.throwIfAborted(); bucketValidated = true
    return Object.freeze({ bucket: BUCKET, location: info.location, versioning: true, publicAccessPrevention: "enforced", uniformBucketLevelAccess: true })
  }
  async function ensureBucket(context) { if (!bucketValidated) await validateBucket(context) }
  function receipt(metadata, name) {
    const info = record(metadata)
    if (info.bucket !== BUCKET || info.name !== name) fail("receipt_identity_mismatch")
    const sizeBytes = size(info.size), maximum = name === controlName ? JSON_LIMIT : name.endsWith("/recovery.json") ? 16384 : name.endsWith("/manifest.json") ? MANIFEST_LIMIT : maximumObjectBytes
    if (sizeBytes > maximum) fail("receipt_size_exceeded")
    return Object.freeze({ target: Object.freeze({ bucket: BUCKET, objectName: name, generation: generation(info.generation) }), sizeBytes, crc32c: crc(info.crc32c) })
  }
  async function inspectName(name, selectedGeneration, op, missing = false) {
    const response = await request(objectUrl(name, selectedGeneration ? { generation: selectedGeneration } : {}), op)
    if (missing && response.status === 404) { await discard(response); return null }
    if (response.status !== 200) { await discard(response); fail("metadata_read_failed") }
    const result = receipt(await json(response, op), name)
    if (selectedGeneration && result.target.generation !== selectedGeneration) fail("generation_mismatch")
    return result
  }
  function byteInput(bytes, maximum, expected, op) {
    const input = bytes instanceof Uint8Array ? (async function* () {
      for (let offset = 0; offset < bytes.byteLength; offset += CHUNK) yield bytes.subarray(offset, offset + CHUNK)
    })() : bytes
    if (typeof input?.[Symbol.asyncIterator] !== "function") fail("invalid_byte_source")
    const iterator = input[Symbol.asyncIterator]()
    let total = 0, complete = false, closed = false, pending = null, offset = 0
    const close = async () => {
      if (closed) return
      closed = true; pending = null
      // Do not let an uncooperative iterator retain the request past deadline.
      if (typeof iterator.return === "function") { const ended = iterator.return(); if (!op.signal.aborted) await guarded(ended, op.signal); else void Promise.resolve(ended).catch(() => {}) }
    }
    let abort = () => {}
    const body = new ReadableStream({
      start(controller) {
        abort = () => { controller.error(new Error("Storage media GCS upload cancelled")); void close().catch(() => {}) }
        op.signal.addEventListener("abort", abort, { once: true })
        if (op.signal.aborted) abort()
      },
      async pull(controller) {
        try {
          active(op)
          if (!pending) {
            const item = await guarded(iterator.next(), op.signal)
            if (item.done) {
              if (expected !== undefined && total !== expected) fail("upload_size_mismatch")
              complete = true; op.signal.removeEventListener("abort", abort); await close(); controller.close(); return
            }
            if (!(item.value instanceof Uint8Array)) fail("invalid_byte_chunk")
            total += item.value.byteLength
            if (!Number.isSafeInteger(total) || total > maximum || (expected !== undefined && total > expected)) fail("upload_size_exceeded")
            pending = item.value; offset = 0
          }
          const end = Math.min(offset + CHUNK, pending.byteLength)
          controller.enqueue(pending.subarray(offset, end)); offset = end
          if (offset === pending.byteLength) pending = null
        } catch (error) { op.signal.removeEventListener("abort", abort); await close().catch(() => {}); controller.error(error) }
      },
      async cancel() { op.signal.removeEventListener("abort", abort); await close() },
    }, { highWaterMark: 0 })
    return { body, close: async () => { op.signal.removeEventListener("abort", abort); await close() }, finished: () => { if (!complete) fail("upload_missing_eof"); return total } }
  }
  async function upload(name, bytes, expectedGeneration, context, { maximum, expectedBytes, conflict = false, contentType = "application/octet-stream", milliseconds = 300_000 } = {}) {
    const op = operation(context, milliseconds)
    await ensureBucket(op)
    const local = new AbortController(), scoped = { ...op, signal: AbortSignal.any([op.signal, local.signal]) }
    const input = byteInput(bytes, maximum, expectedBytes, scoped)
    try {
      const response = await request(uploadUrl(name, expectedGeneration), scoped, {
        method: "POST", headers: { "Content-Type": contentType }, body: input.body, duplex: "half",
      })
      if (conflict && response.status === 412) { await discard(response); return null }
      if (![200, 201].includes(response.status)) { await discard(response); fail(response.status === 412 ? "precondition_failed" : "upload_failed") }
      const result = receipt(await json(response, operation(scoped, 20_000)), name)
      if (result.sizeBytes !== input.finished()) fail("upload_receipt_size_mismatch")
      active(scoped)
      return result
    } finally { local.abort(); await input.close().catch(() => {}) }
  }
  function objectNameForSource(value) {
    if (postgres) fail("media_write_not_available")
    const source = validateSourceIdentity(value)
    if (source.bucket !== policy.sourceBucket || source.sizeBytes > maximumObjectBytes) fail("unapproved_source")
    return `${runPrefix}/objects/${digest(JSON.stringify(source))}`
  }
  async function writeTarget(input, context) {
    if (input?.ifGenerationMatch !== "0") fail("create_only_required")
    const source = validateSourceIdentity(input.source)
    return upload(objectNameForSource(source), input.bytes, "0", context, { maximum: maximumObjectBytes, expectedBytes: source.sizeBytes })
  }
  async function writeArchivePart(input, context) {
    if (!postgres || recovery || !input || input.ifGenerationMatch !== "0" || !Number.isSafeInteger(input.index) || input.index < 0 ||
        input.index >= Math.ceil(fcunoConnectionPolicy.postgresBackup.maximumArchiveBytes / maximumObjectBytes) ||
        !Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 1 || input.sizeBytes > maximumObjectBytes) fail("unapproved_archive_part")
    return upload(`${runPrefix}/archive/${String(input.index).padStart(6, "0")}`, input.bytes, "0", context,
      { maximum: maximumObjectBytes, expectedBytes: input.sizeBytes })
  }
  async function uploadImmutable(input, context) {
    const maximum = recovery ? 16384 : MANIFEST_LIMIT
    if (!input || (input.ifGenerationMatch !== undefined && input.ifGenerationMatch !== "0") || input.objectName !== manifestObjectName ||
        (input.contentType !== undefined && input.contentType !== "application/json") ||
        (input.sizeBytes !== undefined && (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0 || input.sizeBytes > maximum || Object.is(input.sizeBytes, -0)))) fail("unapproved_immutable_write")
    return upload(input.objectName, input.bytes, "0", context, { maximum, expectedBytes: input.sizeBytes, contentType: "application/json" })
  }
  async function inspectTarget(value, context) {
    const selected = target(value), op = operation(context, 20_000)
    await ensureBucket(op)
    return inspectName(selected.objectName, selected.generation, op)
  }
  async function download(expected, op) {
    const response = await request(objectUrl(expected.target.objectName, { alt: "media", generation: expected.target.generation }), op)
    const hashes = response.headers.get("x-goog-hash")?.split(",").map(value => value.trim()).filter(value => value.startsWith("crc32c="))
    if (response.status !== 200 || response.headers.get("x-goog-generation") !== expected.target.generation || hashes?.length !== 1 ||
        hashes[0].slice(7) !== expected.crc32c || response.headers.get("content-length") !== String(expected.sizeBytes) || response.headers.has("content-range") ||
        ![null, "identity"].includes(response.headers.get("content-encoding")) || !response.body) { await discard(response); fail("unverified_download") }
    return response
  }
  function returnedBytes(response, expected, op) {
    const reader = response.body.getReader()
    let closed = false, total = 0, pending = null, offset = 0
    const close = async () => {
      if (closed) return
      closed = true; pending = null; op.signal.removeEventListener("abort", abort)
      cancelReader(reader)
    }
    const abort = () => { void close() }
    op.signal.addEventListener("abort", abort, { once: true })
    return {
      [Symbol.asyncIterator]() { return this },
      async next() {
        try {
          active(op)
          if (closed) return { done: true }
          if (!pending) {
            const part = await guarded(reader.read(), op.signal)
            active(op)
            if (part.done) { if (total !== expected) fail("download_size_mismatch"); await close(); return { done: true } }
            total += part.value.byteLength
            if (total > expected) fail("download_size_exceeded")
            pending = part.value; offset = 0
          }
          const end = Math.min(offset + CHUNK, pending.byteLength), value = pending.subarray(offset, end)
          offset = end; if (end === pending.byteLength) pending = null
          return { done: false, value }
        } catch (error) { await close(); throw error }
      },
      async return() { await close(); return { done: true } },
    }
  }
  async function readTarget(value, context) {
    const selected = target(value), op = operation(context, 300_000)
    const metadata = await inspectTarget(selected, op)
    const response = await download(metadata, op)
    return { target: metadata.target, bytes: returnedBytes(response, metadata.sizeBytes, op), crc32c: metadata.crc32c }
  }
  async function readControlReceipt(expected, op) {
    const bytes = await boundedBytes(await download(expected, op), JSON_LIMIT, op)
    if (bytes.byteLength !== expected.sizeBytes || crc32c(bytes) !== expected.crc32c) fail("control_integrity_mismatch")
    let value
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) } catch { fail("invalid_control_json") }
    return { bytes, snapshot: { generation: expected.target.generation, record: validateControl(value) } }
  }
  const control = Object.freeze({
    async read(context) {
      if (recovery) fail("control_not_available")
      const op = operation(context, 20_000)
      await ensureBucket(op)
      const expected = await inspectName(controlName, undefined, op, true)
      if (expected === null) return null
      return (await readControlReceipt(expected, op)).snapshot
    },
    async compareAndSwap(expectedGeneration, record, context) {
      if (recovery) fail("control_not_available")
      generation(expectedGeneration, true)
      const op = operation(context, 20_000), checked = validateControl(record), bytes = Buffer.from(JSON.stringify(checked))
      if (bytes.byteLength > JSON_LIMIT) fail("control_limit_exceeded")
      const saved = await upload(controlName, bytes, expectedGeneration, op, { maximum: JSON_LIMIT, expectedBytes: bytes.byteLength, conflict: true, contentType: "application/json", milliseconds: 20_000 })
      if (saved === null) return null
      if (saved.target.generation === expectedGeneration || saved.crc32c !== crc32c(bytes)) fail("control_commit_mismatch")
      const verified = await readControlReceipt(saved, op)
      if (digest(verified.bytes) !== digest(bytes)) fail("control_commit_mismatch")
      return verified.snapshot
    },
  })
  return Object.freeze({ validateBucket, writeTarget, writeArchivePart, inspectTarget, readTarget, uploadImmutable, control, objectNameForSource, manifestObjectName })
}
