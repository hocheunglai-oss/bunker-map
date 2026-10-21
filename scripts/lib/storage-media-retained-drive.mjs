import { createHash } from "node:crypto"
import { fcunoConnectionPolicy } from "../../config/fcunoConnections.ts"

const DRIVE_ORIGIN = "https://www.googleapis.com/drive/v3/"
const FOLDER_MIME = "application/vnd.google-apps.folder"
const BACKUP_FILE_SCHEMA = "bunker-map-backup/v2"
const VERIFICATION_CONTRACT = "bunker-map-backup-stream-verification/v1"
const BACKUP_NAME = /^bunker-map-backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.json$/
const FILE_FIELDS = "id,name,createdTime,mimeType,trashed,parents,version,size,appProperties"
const FOLDER_FIELDS = "id,name,mimeType,trashed,parents,version"
const SHA256 = /^[0-9a-f]{64}$/
const MAX_PAGES = 500
const PAGE_SIZE = 100
const MAX_FILES = 50_000
const MAX_JSON_BYTES = 2 * 1024 * 1024
const CHUNK_BYTES = 64 * 1024

function fail(code = "DRIVE_BACKUP_UNVERIFIED") {
  const error = new Error(code === "DRIVE_ACCOUNT_MISMATCH"
    ? "Drive OAuth account does not match the canonical storage media backup account"
    : "Retained Drive backup could not be verified")
  error.code = code
  throw error
}
function id(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(value)) fail()
  return value
}
function plain(value) {
  return value !== null && typeof value === "object" &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}
function decimal(value, positive = false) {
  if (typeof value !== "string" || !/^(0|[1-9]\d{0,39})$/.test(value) || (positive && value === "0")) fail()
  return value
}
function receiptInteger(value, positive = false) {
  // Mirror validateStreamReceiptProperties in the existing database runner.
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < (positive ? 1 : 0)) fail()
  return parsed
}
function properties(value) {
  if (!plain(value) || Object.keys(value).length > 100) fail()
  const result = Object.create(null)
  for (const key of Object.keys(value).sort()) {
    if (typeof value[key] !== "string" || !value[key].isWellFormed() ||
        Buffer.byteLength(key) > 256 || Buffer.byteLength(value[key]) > 4096) fail()
    result[key] = value[key]
  }
  return Object.freeze(result)
}
function receipt(props) {
  if (props.backupSchema !== BACKUP_FILE_SCHEMA || props.verificationStatus !== "complete" ||
      !SHA256.test(props.artifactSha256 ?? "") || !SHA256.test(props.uploadedFileSha256 ?? "") ||
      !SHA256.test(props.truthHeadSha256 ?? "")) fail()
  const fileByteLength = receiptInteger(props.fileByteLength, true)
  receiptInteger(props.truthHeadSequence, true)
  if (props.verificationContract && props.verificationContract !== VERIFICATION_CONTRACT) fail()
  if (props.verificationContract === VERIFICATION_CONTRACT) {
    for (const key of ["migrationHead", "databaseEpoch", "inventorySha256", "catalogSha256", "liveTableCount",
      "sectionCount", "totalRecordCount", "backupRunId", "generatedAt", "deploymentCommit", "source",
      "latestCertificationRunId", "latestProjectionSnapshotSha256", "previousFileId", "previousFileName",
      "previousCreatedTime", "previousArtifactSha256", "previousUploadedFileSha256"]) {
      if (!props[key]) fail()
    }
    if (!/^\d{14}$/.test(props.migrationHead) ||
        ![props.inventorySha256, props.catalogSha256, props.latestProjectionSnapshotSha256].every(value => SHA256.test(value))) fail()
    receiptInteger(props.liveTableCount, true)
    receiptInteger(props.databaseEpoch)
    receiptInteger(props.sectionCount, true)
    receiptInteger(props.totalRecordCount)
  }
  return { artifactSha256: props.artifactSha256, uploadedFileSha256: props.uploadedFileSha256, fileByteLength }
}
function placement(file, parentId, mimeType) {
  if (!plain(file) || file.trashed !== false || file.mimeType !== mimeType ||
      !Array.isArray(file.parents) || file.parents.length !== 1 || file.parents[0] !== parentId) fail()
  id(file.id)
  decimal(file.version, true)
}
function folder(file, parentId, name) {
  placement(file, parentId, FOLDER_MIME)
  if (file.name !== name) fail()
  return Object.freeze({ folderId: file.id, name, parentId, version: file.version })
}
function descriptor(file, folderId) {
  placement(file, folderId, "application/json")
  if (!BACKUP_NAME.test(file.name ?? "") || (file.createdTime !== undefined && file.createdTime !== null &&
      (typeof file.createdTime !== "string" || file.createdTime.length > 100))) fail()
  const size = decimal(file.size, true), sizeBytes = Number(size)
  if (!Number.isSafeInteger(sizeBytes)) fail()
  const appProperties = properties(file.appProperties), independentReceipt = receipt(appProperties)
  if (sizeBytes !== independentReceipt.fileByteLength) fail()
  return Object.freeze({ fileId: file.id, name: file.name, createdTime: file.createdTime ?? null,
    version: file.version, size, sizeBytes, folderId, mimeType: file.mimeType, trashed: false,
    parents: Object.freeze([...file.parents]), appProperties, ...independentReceipt })
}
function compare(left, right) {
  return String(right.createdTime || "").localeCompare(String(left.createdTime || "")) ||
    String(right.name || "").localeCompare(String(left.name || "")) ||
    String(right.id || "").localeCompare(String(left.id || ""))
}
function same(left, right) { return JSON.stringify(left) === JSON.stringify(right) }
function contextFor(context, maximumMs) {
  if (!context || typeof context.signal?.throwIfAborted !== "function" || !Number.isSafeInteger(context.deadline)) fail()
  context.signal.throwIfAborted()
  const remaining = context.deadline - Date.now()
  if (!Number.isSafeInteger(remaining) || remaining <= 0) fail("DRIVE_DEADLINE_EXCEEDED")
  return { signal: AbortSignal.any([context.signal, AbortSignal.timeout(Math.min(remaining, maximumMs))]), deadline: context.deadline }
}
async function abortable(promise, signal, onLateValue) {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    let aborted = false
    const stop = () => { aborted = true; reject(signal.reason) }
    signal.addEventListener("abort", stop, { once: true })
    Promise.resolve(promise).then(value => {
      signal.removeEventListener("abort", stop)
      if (aborted) { onLateValue?.(value); return }
      resolve(value)
    }, error => { signal.removeEventListener("abort", stop); reject(error) })
  })
}
function cancel(body) { try { void body?.cancel().catch(() => {}) } catch { /* Already locked or closed. */ } }
async function json(response, signal) {
  if (!response.body) fail()
  const reader = response.body.getReader(), pieces = []
  let size = 0, complete = false
  const stop = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener("abort", stop, { once: true })
  try {
    for (;;) {
      signal.throwIfAborted()
      const part = await abortable(reader.read(), signal)
      signal.throwIfAborted()
      if (part.done) { complete = true; break }
      if (!(part.value instanceof Uint8Array) || (size += part.value.byteLength) > MAX_JSON_BYTES) fail()
      pieces.push(part.value)
    }
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(pieces)))
    if (!plain(value)) fail()
    return value
  } finally {
    signal.removeEventListener("abort", stop)
    if (!complete) stop()
    try { reader.releaseLock() } catch { /* Cancellation finishes an outstanding native read. */ }
  }
}

// Only existing OAuth access is injected. This module reads no environment,
// credentials, disk or checkpoint; every provider operation is a fixed-origin
// GET. The caller supplies GOOGLE_DRIVE_BACKUP_FOLDER_ID ||
// GOOGLE_DRIVE_COMPANY_FOLDER_ID as parentFolderId, just like the DB runner.
export function createRetainedDriveReadAdapter({ fetch: fetchImpl = fetch, getAccessToken, parentFolderId, sharedDriveId = null } = {}) {
  if (typeof fetchImpl !== "function" || typeof getAccessToken !== "function") fail()
  id(parentFolderId)
  if (sharedDriveId !== null) id(sharedDriveId)
  const knownCatalogs = new WeakSet(), knownFiles = new WeakSet()
  async function request(path, query, session) {
    session.signal.throwIfAborted()
    const url = new URL(path, DRIVE_ORIGIN)
    for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, String(value))
    const response = await abortable(fetchImpl(url.href, {
      method: "GET", redirect: "error", cache: "no-store", signal: session.signal,
      headers: { Authorization: `Bearer ${session.token}`, "Accept-Encoding": "identity", "Cache-Control": "no-cache" },
    }), session.signal, response => cancel(response.body))
    if (response.status !== 200 || response.headers.get("content-range") !== null ||
        ![null, "identity"].includes(response.headers.get("content-encoding"))) { cancel(response.body); fail() }
    return response
  }
  async function getJson(path, query, session) {
    return json(await request(path, query, session), session.signal)
  }
  async function sessionFor(context, maximumMs) {
    const bounded = contextFor(context, maximumMs)
    const token = await abortable(getAccessToken(bounded), bounded.signal)
    bounded.signal.throwIfAborted()
    if (typeof token !== "string" || !token || token.length > 16_384 || /[\s\x00-\x1f\x7f]/.test(token)) fail()
    const session = { ...bounded, token }
    const about = await getJson("about", { fields: "user(emailAddress)" }, session)
    if (about.user?.emailAddress !== fcunoConnectionPolicy.storageMediaBackup.googleAccount) fail("DRIVE_ACCOUNT_MISMATCH")
    return session
  }
  async function list(query, fields, session, visit) {
    let pageToken, count = 0
    const tokens = new Set(), ids = new Set()
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await getJson("files", { q: query, fields: `nextPageToken,incompleteSearch,files(${fields})`,
        orderBy: "createdTime desc", pageSize: PAGE_SIZE, pageToken, supportsAllDrives: true,
        includeItemsFromAllDrives: true, corpora: sharedDriveId ? "drive" : "user", driveId: sharedDriveId ?? undefined }, session)
      if ((result.incompleteSearch !== undefined && result.incompleteSearch !== false) ||
          !Array.isArray(result.files) || result.files.length > PAGE_SIZE || (count += result.files.length) > MAX_FILES) fail()
      for (const file of result.files) {
        const fileId = id(file?.id)
        if (ids.has(fileId)) fail()
        ids.add(fileId)
        visit(file)
      }
      if (result.nextPageToken === undefined || result.nextPageToken === "") return
      if (typeof result.nextPageToken !== "string" || result.nextPageToken.length > 4096 || tokens.has(result.nextPageToken)) fail()
      tokens.add(result.nextPageToken)
      pageToken = result.nextPageToken
    }
    fail()
  }
  async function resolveFolder(parentId, name, session) {
    const matches = []
    await list(`trashed = false and mimeType = '${FOLDER_MIME}' and '${parentId}' in parents and name = '${name}'`, FOLDER_FIELDS, session, file => {
      matches.push(folder(file, parentId, name))
      if (matches.length > 1) fail("DRIVE_FOLDER_AMBIGUOUS")
    })
    if (matches.length !== 1) fail("DRIVE_FOLDER_MISSING")
    return matches[0]
  }
  async function fence(expected, session) {
    const actual = descriptor(await getJson(`files/${id(expected.fileId)}`, { fields: FILE_FIELDS, supportsAllDrives: true }, session), expected.folderId)
    if (!same(actual, expected)) fail("DRIVE_FILE_CHANGED")
  }
  async function readRetainedPair(context) {
    const session = await sessionFor(context, 55_000)
    const backupFolder = await resolveFolder(parentFolderId, "Bunker Map Backups", session)
    const dailyFolder = await resolveFolder(backupFolder.folderId, "Daily Supabase Backups", session)
    const latest = []
    await list(`trashed = false and mimeType = 'application/json' and '${dailyFolder.folderId}' in parents and name contains 'bunker-map-backup-'`, FILE_FIELDS, session, file => {
      if (!BACKUP_NAME.test(file.name ?? "") || file.mimeType !== "application/json") return
      if (file.appProperties?.backupSchema !== BACKUP_FILE_SCHEMA || file.appProperties?.verificationStatus !== "complete" ||
          !SHA256.test(file.appProperties?.artifactSha256 ?? "") || !SHA256.test(file.appProperties?.uploadedFileSha256 ?? "")) return
      latest.push(file)
      latest.sort(compare)
      if (latest.length > 2) latest.pop()
    })
    if (latest.length !== 2) fail("DRIVE_RETAINED_PAIR_MISSING")
    const files = latest.map(file => descriptor(file, dailyFolder.folderId))
    for (const file of files) await fence(file, session)
    const catalog = Object.freeze({ parentFolderId, sharedDriveId, backupFolder, dailyFolder, files: Object.freeze(files) })
    knownCatalogs.add(catalog)
    for (const file of files) knownFiles.add(file)
    return catalog
  }
  async function openRetainedArtifact(file, context) {
    if (!knownFiles.has(file)) fail()
    const session = await sessionFor(context, 240_000)
    await fence(file, session)
    // Lazy fetch means returning/closing an unstarted iterator leaves no media
    // response open. Successful EOF is withheld until raw receipt AND post-read
    // metadata match the independently obtained, immutable catalog descriptor.
    const bytes = (async function* () {
      const response = await request(`files/${id(file.fileId)}`, { alt: "media", supportsAllDrives: true }, session)
      const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase()
      if (!response.body || !["application/json", "application/octet-stream"].includes(contentType) ||
          (response.headers.get("content-length") !== null && response.headers.get("content-length") !== file.size)) {
        cancel(response.body); fail()
      }
      const reader = response.body.getReader(), hasher = createHash("sha256")
      let count = 0, complete = false
      const stop = () => { void reader.cancel().catch(() => {}) }
      session.signal.addEventListener("abort", stop, { once: true })
      try {
        for (;;) {
          session.signal.throwIfAborted()
          const part = await abortable(reader.read(), session.signal)
          session.signal.throwIfAborted()
          if (part.done) break
          if (!(part.value instanceof Uint8Array) || !Number.isSafeInteger(count += part.value.byteLength) || count > file.fileByteLength) fail()
          hasher.update(part.value)
          for (let offset = 0; offset < part.value.byteLength; offset += CHUNK_BYTES) {
            session.signal.throwIfAborted()
            yield part.value.subarray(offset, offset + CHUNK_BYTES)
          }
        }
        if (count !== file.fileByteLength || hasher.digest("hex") !== file.uploadedFileSha256) fail("DRIVE_RAW_RECEIPT_MISMATCH")
        await fence(file, session)
        session.signal.throwIfAborted()
        complete = true
      } finally {
        session.signal.removeEventListener("abort", stop)
        if (!complete) stop()
        try { reader.releaseLock() } catch { /* Cancellation finishes an outstanding native read. */ }
      }
    })()
    return Object.freeze({ descriptor: file, bytes })
  }
  async function verifyRetainedPair(catalog, context) {
    if (!knownCatalogs.has(catalog)) fail()
    const current = await readRetainedPair(context)
    if (!same(current, catalog)) fail("DRIVE_RETAINED_PAIR_CHANGED")
    return catalog
  }
  return Object.freeze({ readRetainedPair, openRetainedArtifact, verifyRetainedPair })
}
