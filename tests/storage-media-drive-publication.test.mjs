import assert from "node:assert/strict"
import test from "node:test"
import { fcunoConnectionPolicy } from "../config/fcunoConnections.ts"
import { recurringInventorySha256, recurringMediaScope } from "../lib/storageMediaRecurring.mjs"
import { createStorageMediaDrivePublisher } from "../scripts/lib/storage-media-drive-publication.mjs"

const policy = fcunoConnectionPolicy.storageMediaBackup
const activatedAt = "2026-10-25T08:00:00.000Z", now = Date.parse("2026-10-26T00:00:00.000Z")
const runtime = { STORAGE_MEDIA_BACKUP_RECURRING_ENABLED: "1", STORAGE_MEDIA_BACKUP_RECURRING_ACTIVATED_AT: activatedAt }
function manifest() {
  const source = { bucket: policy.sourceBucket, path: "synthetic/private-video.mp4", id: "object-one", version: "version-one", sizeBytes: 16 }
  return { schema: "fcuno.storage-media-daily/v2", status: "succeeded", scope: recurringMediaScope(), runId: "synthetic-run",
    snapshot: { inventorySha256: recurringInventorySha256([source]), windowStartsAt: "2026-10-25T18:00:00.000Z", windowExpiresAt: "2026-10-25T22:00:00.000Z" },
    inventory: [source], copies: [{ source,
      target: { bucket: policy.targetBucket, objectName: `${policy.targetPrefix}/daily/runs/synthetic-run/objects/${"a".repeat(64)}`, generation: "100" },
      byteSha256: "b".repeat(64), sizeBytes: 16, crc32c: "AAAAAA==", verifiedAt: "2026-10-25T18:04:00.000Z" }],
    startedAt: "2026-10-25T18:00:00.000Z", finishedAt: "2026-10-25T18:05:00.000Z" }
}
const folderMime = "application/vnd.google-apps.folder"
function provider(options = {}) {
  const files = new Map(), bodies = new Map(), calls = [], metadataReads = new Map()
  let creates = 0, uploads = 0, sequence = 0
  files.set("backup-root", { id: "backup-root", name: "Bunker Map Backups", mimeType: folderMime, trashed: false, parents: ["configured-parent"], version: "1" })
  const json = value => new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } })
  const clone = value => structuredClone(value)
  const ordered = value => options.shuffleMetadata ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, key === "appProperties" ? Object.fromEntries(Object.entries(item).reverse()) : item])) : value
  async function fetchImpl(raw, request) {
    const url = new URL(raw)
    calls.push({ url: url.href, method: request.method })
    assert.equal(url.origin, "https://www.googleapis.com")
    assert.equal(request.headers.Authorization, "Bearer synthetic-token")
    assert.equal(request.redirect, "error")
    assert.equal(request.cache, "no-store")
    assert.ok(request.signal instanceof AbortSignal)
    if (url.pathname === "/drive/v3/about") return json({ user: { emailAddress: options.foreignAccount ? "foreign@example.invalid" : policy.googleAccount } })
    if (url.pathname === "/drive/v3/files" && request.method === "GET") {
      const q = url.searchParams.get("q")
      const parent = q.match(/'([^']+)' in parents/)?.[1], exactName = q.match(/and name = '([^']+)'/)?.[1]
      let result = [...files.values()].filter(value => value.parents[0] === parent && (!exactName || value.name === exactName) && (!q.includes("mimeType =") || value.mimeType === (q.includes(folderMime) ? folderMime : "application/json")))
      result = result.sort((a, b) => Number(b.sortSequence || 0) - Number(a.sortSequence || 0)).map(value => { const next = clone(value); delete next.sortSequence; return next })
      if (options.duplicateFolder && q.includes(folderMime)) result.push({ ...clone(result[0]), id: "duplicate-folder" })
      if (options.wrongParent && q.includes(folderMime)) result = result.map(value => ({ ...value, parents: ["not-the-configured-parent"] }))
      return json({ files: result, ...(options.incompleteSearch ? { incompleteSearch: true } : {}) })
    }
    if (url.pathname === "/drive/v3/files" && request.method === "POST") {
      creates++
      const value = JSON.parse(request.body), id = `created-folder-${creates}`
      const meta = { id, ...value, trashed: false, version: "1" }
      files.set(id, meta); return json(meta)
    }
    if (url.pathname === "/upload/drive/v3/files" && request.method === "POST") {
      uploads++
      const boundary = request.headers["Content-Type"].split("boundary=")[1]
      const body = Buffer.from(request.body).toString("utf8")
      const sections = body.split(`--${boundary}`), meta = JSON.parse(sections[1].split("\r\n\r\n")[1].trim())
      const bytes = Buffer.from(sections[2].slice(sections[2].indexOf("\r\n\r\n") + 4, -2))
      const id = `receipt-${uploads}`
      const stored = { id, ...meta, trashed: false, version: "1", size: String(bytes.length), sortSequence: ++sequence }
      files.set(id, stored); bodies.set(id, bytes)
      const result = clone(stored); delete result.sortSequence
      return json(result)
    }
    const id = url.pathname.split("/").at(-1)
    assert.ok(files.has(id), `unexpected request ${url.pathname}`)
    if (url.searchParams.get("alt") === "media") return new Response(options.corruptBody ? Buffer.from("corrupted") : bodies.get(id))
    const count = (metadataReads.get(id) || 0) + 1; metadataReads.set(id, count)
    const value = clone(files.get(id)); delete value.sortSequence
    if (options.mutateVersion && count === 2) value.version = "2"
    if (options.mutateDigest && count === 2) value.appProperties.healthSha256 = "0".repeat(64)
    return json(ordered(value))
  }
  return { fetchImpl, files, bodies, calls, uploads: () => uploads, creates: () => creates }
}
function context(signal = new AbortController().signal) { return { signal, deadline: now + 60_000, now: () => now,
  publication: { fence: 1, owner: "synthetic-owner" }, assertOwnership: async () => true } }
function publisher(mock, overrides = {}) {
  return createStorageMediaDrivePublisher({ parentFolderId: "configured-parent", runtime,
    getAccessToken: async () => "synthetic-token", fetch: mock.fetchImpl, now: () => now,
    getBudgetState: () => ({ state: "normal", checkedAt: "2026-10-25T18:00:00.000Z", projectedUsd: null, limitUsd: 10 }), ...overrides })
}

test("cloud publisher uses only exact Drive account/folder, verifies bytes and immutable version", async () => {
  const mock = provider({ shuffleMetadata: true })
  const result = await publisher(mock).publishHealth(manifest(), context())
  assert.equal(result.verified, true)
  assert.equal(mock.creates(), 1)
  assert.equal(mock.uploads(), 1)
  assert.match(result.healthSha256, /^[a-f0-9]{64}$/)
  assert.match(result.manifestSha256, /^[a-f0-9]{64}$/)
  assert.equal(mock.calls.filter(call => call.url.includes("alt=media")).length, 1)
  assert.ok(mock.calls.every(call => !/delete|permissions|uploadType=resumable/i.test(call.url)))
})

test("identical publication retry reuses one already verified receipt instead of uploading duplicates", async () => {
  const mock = provider(), service = publisher(mock)
  const first = await service.publishHealth(manifest(), context())
  const second = await service.publishHealth(manifest(), context())
  assert.deepEqual(second, first)
  assert.equal(mock.uploads(), 1)
})

test("wrong account, duplicate/misparented folders and incomplete listing fail before any upload", async () => {
  for (const options of [{ foreignAccount: true }, { duplicateFolder: true }, { wrongParent: true }, { incompleteSearch: true }]) {
    const mock = provider(options)
    await assert.rejects(publisher(mock).publishHealth(manifest(), context()))
    assert.equal(mock.uploads(), 0)
  }
})

test("corrupt readback, changed version and digest fail rather than returning verified success", async () => {
  for (const options of [{ corruptBody: true }, { mutateVersion: true }, { mutateDigest: true }]) {
    const mock = provider(options)
    await assert.rejects(publisher(mock).publishHealth(manifest(), context()))
  }
})

test("failed attempt preserves the complete previous success, while its own state is not success", async () => {
  const mock = provider(), service = publisher(mock)
  await service.publishHealth(manifest(), context())
  await service.publishAttempt({ runId: "failed-run", startedAt: "2026-10-25T21:00:00.000Z", finishedAt: "2026-10-25T21:01:00.000Z", state: "failed", reason: "source-fence" }, context())
  const value = JSON.parse(mock.bodies.get("receipt-2"))
  assert.equal(value.latestAttempt.state, "failed")
  assert.deepEqual(value.latestSuccess, manifest())
  assert.equal(mock.bodies.has("receipt-1"), true)
})

test("budget-paused publication preserves prior copies and never stamps another success", async () => {
  const mock = provider(), service = publisher(mock)
  await service.publishHealth(manifest(), context())
  await service.publishAttempt({ runId: "paused-run", startedAt: "2026-10-25T21:00:00.000Z", finishedAt: "2026-10-25T21:01:00.000Z", state: "budget-paused", reason: "cost-estimate-unavailable" }, context())
  const value = JSON.parse(mock.bodies.get("receipt-2"))
  assert.equal(value.latestAttempt.state, "budget-paused")
  assert.equal(value.budget.state, "paused")
  assert.equal(value.latestSuccess.runId, "synthetic-run")
})

test("malformed newest receipt is not skipped in favour of an older green record", async () => {
  const mock = provider(), service = publisher(mock)
  await service.publishHealth(manifest(), context())
  mock.files.get("receipt-1").appProperties.backupSchema = "unsupported-schema"
  await assert.rejects(service.publishAttempt({ runId: "later-run", startedAt: "2026-10-25T21:00:00.000Z", finishedAt: "2026-10-25T21:01:00.000Z", state: "failed", reason: "source-error" }, context()))
  assert.equal(mock.uploads(), 1)
})

test("older attempts cannot replace newer published states", async () => {
  const mock = provider(), service = publisher(mock)
  await service.publishHealth(manifest(), context())
  await service.publishAttempt({ runId: "later-run", startedAt: "2026-10-25T21:00:00.000Z", finishedAt: "2026-10-25T21:01:00.000Z", state: "failed", reason: "source-error" }, context())
  await assert.rejects(service.publishAttempt({ runId: "older-run", startedAt: "2026-10-25T20:00:00.000Z", finishedAt: "2026-10-25T20:01:00.000Z", state: "failed", reason: "source-error" }, context()))
  assert.equal(mock.uploads(), 2)
})

test("lease ownership is required before every mutation and a lower fence cannot supersede a higher fence", async () => {
  const mock = provider(), service = publisher(mock)
  const lost = { ...context(), assertOwnership: async () => { throw new Error("lease lost") } }
  await assert.rejects(service.publishHealth(manifest(), lost))
  assert.equal(mock.creates(), 0)
  const higher = { ...context(), publication: { fence: 2, owner: "higher-owner" } }
  await service.publishHealth(manifest(), higher)
  await assert.rejects(service.publishAttempt({ runId: "lower-run", startedAt: "2026-10-25T21:00:00.000Z", finishedAt: "2026-10-25T21:01:00.000Z", state: "failed", reason: "source-error" }, context()))
  assert.equal(mock.uploads(), 1)
})

test("invalid runtime gates and unapproved source/target cannot publish", async () => {
  const mock = provider()
  for (const value of [{ ...runtime, STORAGE_MEDIA_BACKUP_RECURRING_ENABLED: "0" }, { ...runtime, STORAGE_MEDIA_BACKUP_RECURRING_ACTIVATED_AT: "yesterday" }]) assert.throws(() => publisher(mock, { runtime: value }))
  const changed = manifest(); changed.scope.targetBucket = "other-bucket"
  await assert.rejects(publisher(mock).publishHealth(changed, context()))
  assert.equal(mock.uploads(), 0)
})

test("noncooperative token, fetch and body promises are bounded by abort independently", async () => {
  for (const blocked of ["token", "fetch", "body"]) {
    const mock = provider(), controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 20)
    const overrides = blocked === "token" ? { getAccessToken: () => new Promise(() => {}) }
      : { fetch: blocked === "fetch" ? () => new Promise(() => {})
        : () => ({ status: 200, headers: new Headers(), body: { getReader: () => ({ read: () => new Promise(() => {}), cancel: () => new Promise(() => {}), releaseLock() {} }) } }) }
    try {
      const start = performance.now()
      await assert.rejects(publisher(mock, overrides).publishHealth(manifest(), context(controller.signal)))
      assert.ok(performance.now() - start < 500, `${blocked} ignored deadline`)
      assert.equal(mock.uploads(), 0)
    } finally { clearTimeout(timer) }
  }
})

test("HTTP failure, redirect and compressed or partial body never become a receipt", async () => {
  for (const response of [new Response("no", { status: 503 }), new Response("redirect", { status: 302 }),
    new Response("partial", { status: 200, headers: { "Content-Range": "bytes 0-1/10" } }), new Response("gzip", { status: 200, headers: { "Content-Encoding": "gzip" } }),
    new Response(new Uint8Array(2 * 1024 * 1024 + 1))]) {
    const mock = provider()
    await assert.rejects(publisher(mock, { fetch: async () => response }).publishHealth(manifest(), context()))
    assert.equal(mock.uploads(), 0)
  }
})
