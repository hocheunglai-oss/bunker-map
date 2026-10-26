import { createHash } from "node:crypto"
import { fcunoConnectionPolicy } from "../../config/fcunoConnections.ts"
import { buildStorageMediaHealthReceipt, validateStorageMediaHealthReceipt, encodeStorageMediaHealthReceipt,
  STORAGE_MEDIA_HEALTH_SCHEMA, STORAGE_MEDIA_HEALTH_FOLDER, STORAGE_MEDIA_HEALTH_PREFIX, STORAGE_MEDIA_HEALTH_MAX_BYTES, selectStorageMediaHealthFile } from "../../lib/storageMediaBackupHealth.mjs"
import { encodeRecurringMediaManifest } from "../../lib/storageMediaRecurring.mjs"

const policy = fcunoConnectionPolicy.storageMediaBackup
const FOLDER = "application/vnd.google-apps.folder"
const FIELDS = "id,name,mimeType,trashed,parents,version,size,appProperties"
const hash = bytes => createHash("sha256").update(bytes).digest("hex")
function fail() { throw new Error("Media backup Drive publication could not be verified") }
function id(value) { if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(value)) fail(); return value }
function version(value) { if (typeof value !== "string" || !/^[1-9][0-9]{0,39}$/.test(value)) fail(); return value }
function metadata(value, parent, name, mimeType) {
  if (!value || value.name !== name || value.mimeType !== mimeType || value.trashed !== false ||
    !Array.isArray(value.parents) || value.parents.length !== 1 || value.parents[0] !== parent) fail()
  id(value.id); version(value.version)
  return value
}
function metadataFingerprint(value) {
  if (!value || typeof value !== "object" || !value.appProperties || typeof value.appProperties !== "object" || Array.isArray(value.appProperties)) fail()
  return JSON.stringify([value.id, value.name, value.mimeType, value.trashed, value.parents, value.version, value.size,
    Object.keys(value.appProperties).sort().map(key => [key, value.appProperties[key]])])
}
// Fetch implementations, token providers and synthetic streams are not all
// cooperative with AbortSignal. Bound our own wait and clean late responses
// without waiting on a provider's potentially stuck cancellation operation.
function bounded(operation, signal, onLate) {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    let settled = false
    const abort = () => { if (!settled) { settled = true; reject(new Error("Media backup Drive request timed out")) } }
    signal.addEventListener("abort", abort, { once: true })
    Promise.resolve().then(() => { signal.throwIfAborted(); return operation() }).then(value => {
      signal.removeEventListener("abort", abort)
      if (settled || signal.aborted) { try { onLate?.(value) } catch { /* A late cleanup failure cannot re-open the completed operation. */ } if (!settled) abort(); return }
      settled = true; resolve(value)
    }, error => {
      signal.removeEventListener("abort", abort)
      if (!settled) { settled = true; reject(error) }
    })
    if (signal.aborted) abort()
  })
}

// Fixed-origin, bounded Drive-only operations using the existing cloud job's
// OAuth token. No local credentials, Storage keys, deletion API or public URL.
export function createStorageMediaDrivePublisher({ getAccessToken, parentFolderId, sharedDriveId = null,
  runtime, fetch: fetchImpl = fetch, now = Date.now, getBudgetState = () => null } = {}) {
  id(parentFolderId)
  if (sharedDriveId !== null) id(sharedDriveId)
  if (typeof getAccessToken !== "function" || typeof fetchImpl !== "function") fail()
  const activatedAt = runtime?.STORAGE_MEDIA_BACKUP_RECURRING_ACTIVATED_AT
  if (runtime?.STORAGE_MEDIA_BACKUP_RECURRING_ENABLED !== "1" ||
    typeof activatedAt !== "string" || !Number.isFinite(Date.parse(activatedAt)) || new Date(activatedAt).toISOString() !== activatedAt) fail()

  function signalFor(context) {
    context.signal.throwIfAborted()
    const remaining = context.deadline - now()
    if (!Number.isSafeInteger(remaining) || remaining <= 0) fail()
    return AbortSignal.any([context.signal, AbortSignal.timeout(Math.min(remaining, 30_000))])
  }

  async function request(path, query, context, options = {}) {
    const signal = signalFor(context)
    const token = await bounded(() => getAccessToken({ ...context, signal }), signal)
    if (typeof token !== "string" || !token || token.length > 16_384 || /[\s\x00-\x1f\x7f]/.test(token)) fail()
    const url = new URL(`https://www.googleapis.com/${path}`)
    for (const [key, value] of Object.entries(query ?? {})) if (value !== undefined) url.searchParams.set(key, String(value))
    if ((options.method ?? "GET") !== "GET") {
      if (typeof context.assertOwnership !== "function") fail()
      await bounded(() => context.assertOwnership(), signal)
    }
    const response = await bounded(() => fetchImpl(url.href, { method: options.method ?? "GET", body: options.body,
      headers: { Authorization: `Bearer ${token}`, "Accept-Encoding": "identity", ...options.headers },
      redirect: "error", cache: "no-store", signal }), signal, value => { void value.body?.cancel().catch(() => {}) })
    if (response.status !== 200 || !response.body || response.headers.get("content-range") !== null ||
      ![null, "identity"].includes(response.headers.get("content-encoding"))) { void response.body?.cancel().catch(() => {}); fail() }
    const reader = response.body.getReader(), chunks = []
    let size = 0, done = false
    const stop = () => { void reader.cancel().catch(() => {}) }
    signal.addEventListener("abort", stop, { once: true })
    try {
      for (;;) {
        signal.throwIfAborted()
        const part = await bounded(() => reader.read(), signal)
        signal.throwIfAborted()
        if (part.done) { done = true; break }
        if (!(part.value instanceof Uint8Array)) fail()
        size += part.value.byteLength
        if (size > STORAGE_MEDIA_HEALTH_MAX_BYTES) fail()
        chunks.push(part.value)
      }
      return Buffer.concat(chunks)
    } finally { signal.removeEventListener("abort", stop); if (!done) stop(); try { reader.releaseLock() } catch { /* A cancelled pending read settles independently. */ } }
  }
  async function json(path, query, context, options) {
    const bytes = await request(path, query, context, options)
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
    if (!value || typeof value !== "object" || Array.isArray(value)) fail()
    return value
  }
  async function list(q, context, maximum = 1000) {
    let pageToken, result = []
    const tokens = new Set(), ids = new Set()
    for (let page = 0; page < 20; page++) {
      const value = await json("drive/v3/files", { q, fields: `nextPageToken,incompleteSearch,files(${FIELDS})`,
        pageSize: 100, orderBy: "createdTime desc", pageToken, supportsAllDrives: true,
        includeItemsFromAllDrives: true, corpora: sharedDriveId ? "drive" : "user", driveId: sharedDriveId ?? undefined }, context)
      if (value.incompleteSearch !== undefined && value.incompleteSearch !== false || !Array.isArray(value.files) || value.files.length > 100) fail()
      for (const file of value.files) { if (ids.has(id(file.id))) fail(); ids.add(file.id); result.push(file); if (result.length > maximum) fail() }
      if (value.nextPageToken === undefined || value.nextPageToken === null) return result
      if (typeof value.nextPageToken !== "string" || !value.nextPageToken || value.nextPageToken.length > 4096 || tokens.has(value.nextPageToken)) fail()
      tokens.add(value.nextPageToken); pageToken = value.nextPageToken
    }
    fail()
  }
  async function folder(parent, name, context, mayCreate) {
    const values = await list(`trashed = false and mimeType = '${FOLDER}' and '${id(parent)}' in parents and name = '${name}'`, context, 2)
    if (values.length > 1) fail()
    if (values.length === 1) return metadata(values[0], parent, name, FOLDER).id
    if (!mayCreate) fail()
    const created = await json("drive/v3/files", { fields: FIELDS, supportsAllDrives: true }, context,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, mimeType: FOLDER, parents: [parent] }) })
    return metadata(created, parent, name, FOLDER).id
  }
  async function resolve(context) {
    const about = await json("drive/v3/about", { fields: "user(emailAddress)" }, context)
    if (about.user?.emailAddress !== policy.googleAccount) fail()
    const root = await folder(parentFolderId, "Bunker Map Backups", context, false)
    return folder(root, STORAGE_MEDIA_HEALTH_FOLDER, context, true)
  }
  async function read(file, folderId, context) {
    metadata(file, folderId, file.name, "application/json")
    if (!file.name.startsWith(STORAGE_MEDIA_HEALTH_PREFIX) || file.appProperties?.backupSchema !== STORAGE_MEDIA_HEALTH_SCHEMA ||
      file.appProperties?.verified !== "true" || !/^[0-9a-f]{64}$/.test(file.appProperties?.healthSha256 ?? "") ||
      !/^[1-9][0-9]*$/.test(file.size ?? "") || Number(file.size) > STORAGE_MEDIA_HEALTH_MAX_BYTES) fail()
    const before = await json(`drive/v3/files/${id(file.id)}`, { fields: FIELDS, supportsAllDrives: true }, context)
    metadata(before, folderId, file.name, "application/json")
    if (metadataFingerprint(before) !== metadataFingerprint(file)) fail()
    const bytes = await request(`drive/v3/files/${id(file.id)}`, { alt: "media", supportsAllDrives: true }, context)
    if (bytes.byteLength !== Number(file.size) || hash(bytes) !== file.appProperties.healthSha256) fail()
    const receipt = validateStorageMediaHealthReceipt(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), { activatedAt, now: now() })
    if (receipt.publication.fence !== Number(file.appProperties.publicationFence) || receipt.publication.owner !== file.appProperties.publicationOwner ||
        receipt.latestAttempt.finishedAt !== file.appProperties.attemptFinishedAt) fail()
    const after = await json(`drive/v3/files/${id(file.id)}`, { fields: FIELDS, supportsAllDrives: true }, context)
    metadata(after, folderId, file.name, "application/json")
    if (metadataFingerprint(after) !== metadataFingerprint(before)) fail()
    return { receipt, bytes, file: after }
  }
  async function previous(folderId, context) {
    const files = await list(`trashed = false and mimeType = 'application/json' and '${folderId}' in parents and name contains '${STORAGE_MEDIA_HEALTH_PREFIX}'`, context)
    if (!files.length) return null
    // Listing has a provider-created ordering. An unreadable newest record is
    // not silently replaced by an older green receipt.
    return (await read(selectStorageMediaHealthFile(files), folderId, context)).receipt
  }
  async function publish(latestAttempt, latestSuccess, context) {
    const publication = context.publication
    if (!publication || !Number.isSafeInteger(publication.fence) || publication.fence < 1 ||
        typeof publication.owner !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(publication.owner) || typeof context.assertOwnership !== "function") fail()
    await bounded(() => context.assertOwnership(), signalFor(context))
    const folderId = await resolve(context)
    const prior = await previous(folderId, context)
    if (prior && (prior.publication.fence > publication.fence || prior.publication.fence === publication.fence && prior.publication.owner !== publication.owner)) fail()
    if (prior && Date.parse(prior.latestAttempt.finishedAt) > Date.parse(latestAttempt.finishedAt)) fail()
    const state = getBudgetState() ?? { state: "unknown", checkedAt: latestAttempt.startedAt, projectedUsd: null, limitUsd: 10 }
    const receipt = buildStorageMediaHealthReceipt({ activatedAt, publication, latestAttempt,
      latestSuccess: latestSuccess ?? prior?.latestSuccess ?? null, budget: {
        ...state, state: latestAttempt.state === "budget-paused" ? "paused" : state.state,
      } }, { activatedAt, now: now() })
    const bytes = encodeStorageMediaHealthReceipt(receipt, { activatedAt, now: now() }), sha = hash(bytes)
    const name = `${STORAGE_MEDIA_HEALTH_PREFIX}${latestAttempt.finishedAt.replaceAll(":", "-")}-${latestAttempt.runId}.json`
    const existing = await list(`trashed = false and '${folderId}' in parents and name = '${name}'`, context, 2)
    if (existing.length > 1) fail()
    let file
    if (existing.length) file = existing[0]
    else {
      const boundary = `fcuno_${latestAttempt.runId}`
      const meta = { name, mimeType: "application/json", parents: [folderId],
        appProperties: { backupSchema: STORAGE_MEDIA_HEALTH_SCHEMA, healthSha256: sha, verified: "true",
          publicationFence: String(publication.fence), publicationOwner: publication.owner, attemptFinishedAt: latestAttempt.finishedAt } }
      const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n`), bytes, Buffer.from(`\r\n--${boundary}--\r\n`)])
      file = await json("upload/drive/v3/files", { uploadType: "multipart", supportsAllDrives: true, fields: FIELDS }, context,
        { method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body })
    }
    const confirmed = await read(file, folderId, context)
    await bounded(() => context.assertOwnership(), signalFor(context))
    if (!confirmed.bytes.equals(bytes)) fail()
    const manifestBytes = confirmed.receipt.latestSuccess ? encodeRecurringMediaManifest(confirmed.receipt.latestSuccess) : null
    return { fileId: file.id, healthSha256: sha, byteLength: bytes.byteLength, version: file.version, verified: true,
      manifestSha256: manifestBytes ? hash(manifestBytes) : null, manifestByteLength: manifestBytes?.byteLength ?? null }
  }
  return {
    publishHealth(manifest, context) { return publish({ runId: manifest.runId, startedAt: manifest.startedAt,
      finishedAt: manifest.finishedAt, state: "succeeded", errorCode: null }, manifest, context) },
    publishAttempt(attempt, context) { return publish({ runId: attempt.runId, startedAt: attempt.startedAt,
      finishedAt: attempt.finishedAt, state: attempt.state,
      errorCode: /^[a-z0-9_-]{1,80}$/.test(attempt.reason ?? "") ? attempt.reason : "media_backup_unverified" }, null, context) },
  }
}
