import assert from "node:assert/strict"
import test from "node:test"
import { fcunoConnectionPolicy } from "../config/fcunoConnections"
import {
  createSupabaseStorageReadProvider, encodedStorageKey, handleStorageMediaBackupSource,
  STORAGE_MEDIA_SOURCE_URL, storageSourceInventorySha256, validateStorageBackupGoogleClaims,
  type StorageReadProvider, type StorageSourceDependencies, type StorageSourceIdentity,
} from "../lib/storageMediaBackupSource"

const now = Date.parse("2026-10-21T05:00:00.000Z")
const seconds = now / 1000
const source: StorageSourceIdentity = { bucket: fcunoConnectionPolicy.storageMediaBackup.sourceBucket, path: "folder/ exact%?#名 .mp4", id: "object-1", version: "immutable-version-1", sizeBytes: 4 }
const approved = [source, ...Array.from({ length: 14 }, (_, index) => ({ ...source, path: `other/file-${index}`, id: `other-${index}`, sizeBytes: 16022097 + (index < 5 ? 1 : 0) }))]
const info = { source, etag: '"opaque-etag"' }
const claims = {
  iss: fcunoConnectionPolicy.storageMediaBackup.googleTokenIssuer, aud: STORAGE_MEDIA_SOURCE_URL,
  email: fcunoConnectionPolicy.storageMediaBackup.googleServiceAccount, email_verified: true,
  sub: "123456789012345678901", iat: seconds, exp: seconds + 3600,
}
function setup() {
  const calls = { verify: 0, provider: 0, list: 0, inspect: 0, open: 0 }
  const storage: StorageReadProvider = {
    async listObjects() { calls.list++; return { objects: approved.map(item => ({ name: item.path, id: item.id })), folders: [], hasNext: false } },
    async inspect(_bucket, path) { calls.inspect++; return { ...info, source: approved.find(item => item.path === path)! } },
    async open() { calls.open++; return new Response(new Uint8Array([1, 2, 3, 4]), { headers: { ETag: info.etag, "Content-Length": "4" } }) },
  }
  const deps: StorageSourceDependencies = {
    now: () => now,
    runtime: { enabled: "1", vercel: "1", environment: "production", projectId: fcunoConnectionPolicy.vercel.projectId,
      windowStartsAt: new Date(now).toISOString(), windowExpiresAt: new Date(now + 3_600_000).toISOString(), approvedInventorySha256: storageSourceInventorySha256(approved) },
    async verifyToken(token, audience) { calls.verify++; assert.equal(token, "header.payload.signature"); assert.equal(audience, STORAGE_MEDIA_SOURCE_URL); return claims },
    provider() { calls.provider++; return { storage, receiptKey: "test-only-service-role-never-returned" } },
  }
  const request = (body: unknown = { operation: "inventory" }, init: RequestInit = {}, url = STORAGE_MEDIA_SOURCE_URL) => new Request(url, {
    method: "POST", headers: { Authorization: "Bearer header.payload.signature", "Content-Type": "application/json" }, body: JSON.stringify(body), ...init,
  })
  const inventory = async () => (await (await handleStorageMediaBackupSource(request(), deps)).json()).items[0]
  return { calls, storage, deps, request, inventory }
}

test("anonymous, malformed, browser credentials and wrong URL deny without provider IO", async () => {
  for (const headers of [{ "Content-Type": "application/json" }, { Authorization: "Bearer opaque" },
    { Authorization: "Bearer header.payload.signature", Origin: "https://fcuno.com" },
    { Authorization: "Bearer header.payload.signature", Cookie: "session=test" }] as Record<string, string>[]) {
    const { deps, calls, request } = setup()
    const response = await handleStorageMediaBackupSource(request(undefined, { headers }), deps)
    assert.ok([401, 403].includes(response.status)); assert.equal(calls.provider, 0)
    assert.match(response.headers.get("cache-control") || "", /no-store/)
  }
  for (const url of [`${STORAGE_MEDIA_SOURCE_URL}?bucket=other`, STORAGE_MEDIA_SOURCE_URL.replace("fcuno.com", "preview.vercel.app")]) {
    const { deps, calls, request } = setup()
    assert.equal((await handleStorageMediaBackupSource(request(undefined, {}, url), deps)).status, 403)
    assert.equal(calls.verify, 0); assert.equal(calls.provider, 0)
  }
})

test("disabled, preview, dev and wrong Vercel project fail before auth", async () => {
  for (const change of [{ enabled: "0" }, { environment: "preview" }, { environment: "development" }, { vercel: "0" }, { projectId: "other" }]) {
    const { deps, calls, request } = setup(); Object.assign(deps.runtime, change)
    assert.equal((await handleStorageMediaBackupSource(request(), deps)).status, 404)
    assert.equal(calls.verify, 0); assert.equal(calls.provider, 0)
  }
})

test("temporary access requires a canonical absolute window of at most one hour", async () => {
  for (const change of [{ windowStartsAt: undefined }, { windowExpiresAt: undefined },
    { windowExpiresAt: new Date(now + 3_600_001).toISOString() }, { windowStartsAt: new Date(now + 1).toISOString() },
    { windowExpiresAt: new Date(now).toISOString() }, { windowStartsAt: "2026-10-21T05:00:00Z" }]) {
    const { deps, calls, request } = setup(); Object.assign(deps.runtime, change)
    assert.equal((await handleStorageMediaBackupSource(request(), deps)).status, 404)
    assert.equal(calls.verify, 0); assert.equal(calls.provider, 0)
  }
})

test("signature verification failures and wrong identity never reach storage", async () => {
  const changes = [{ iss: "accounts.google.com" }, { aud: `${STORAGE_MEDIA_SOURCE_URL}/` }, { aud: [STORAGE_MEDIA_SOURCE_URL] },
    { email: "other@example.com" }, { email_verified: "true" }, { email_verified: false }, { sub: "" },
    { exp: seconds }, { iat: seconds + 31 }, { iat: seconds - 3631 }, { exp: seconds + 3631 }, { iat: "not-numeric" }]
  for (const change of changes) {
    assert.throws(() => validateStorageBackupGoogleClaims({ ...claims, ...change }, now))
    const { deps, calls, request } = setup(); deps.verifyToken = async () => ({ ...claims, ...change })
    assert.equal((await handleStorageMediaBackupSource(request(), deps)).status, 401); assert.equal(calls.provider, 0)
  }
  const { deps, calls, request } = setup(); deps.verifyToken = async () => { throw Error("token secret") }
  const response = await handleStorageMediaBackupSource(request(), deps)
  assert.equal(response.status, 401); assert.equal(calls.provider, 0); assert.doesNotMatch(await response.text(), /token secret/)
})

test("inventory preserves literal paths, mints bounded receipt and exposes no credential", async () => {
  const { deps, request, calls } = setup()
  const response = await handleStorageMediaBackupSource(request(), deps)
  assert.equal(response.status, 200)
  const body = await response.text(), data = JSON.parse(body)
  assert.deepEqual(data.items[0].source, source); assert.match(data.items[0].receipt, /^\d{10}\.[A-Za-z0-9_-]{43}$/)
  assert.doesNotMatch(body, /test-only-service-role|opaque-etag/); assert.equal(calls.open, 0)
})

test("flat listing consumes all cursor pages and never interprets key as full name", async () => {
  const { deps, storage, calls, request } = setup()
  storage.listObjects = async (_bucket, cursor) => {
    calls.list++
    return cursor ? { objects: approved.slice(1).map(item => ({ name: item.path, key: "wrong-basename", id: item.id })), folders: [], hasNext: false } :
      { objects: [{ name: source.path, key: "wrong", id: source.id }], folders: [], hasNext: true, nextCursor: "opaque-next" }
  }
  const response = await handleStorageMediaBackupSource(request(), deps)
  assert.equal(response.status, 200); assert.equal((await response.json()).items.length, 15); assert.equal(calls.list, 2)
})

test("duplicate objects, repeated cursor, hierarchical folders and absent version fail closed", async () => {
  for (const variant of ["duplicate", "cursor", "folder", "version"]) {
    const { deps, storage, request, calls } = setup()
    if (variant === "duplicate") storage.listObjects = async () => ({ objects: [{ name: source.path, id: source.id }, { name: source.path, id: source.id }], folders: [], hasNext: false })
    if (variant === "cursor") storage.listObjects = async () => ({ objects: [], folders: [], hasNext: true, nextCursor: "same" })
    if (variant === "folder") storage.listObjects = async () => ({ objects: [], folders: [{ name: "folder" }], hasNext: false })
    if (variant === "version") storage.inspect = async () => ({ ...info, source: { ...source, version: "" } })
    const response = await handleStorageMediaBackupSource(request(), deps)
    assert.notEqual(response.status, 200); assert.equal(calls.open, 0)
  }
})

test("only an exact inventoried receipt can inspect or open bytes", async () => {
  const { deps, request, inventory, calls } = setup(), item = await inventory()
  for (const bad of [{ ...item, source: { ...source, path: "different" } }, { ...item, source: { ...source, version: "other" } },
    { ...item, receipt: item.receipt.slice(0, -1) + (item.receipt.endsWith("A") ? "B" : "A") }]) {
    const before = calls.inspect
    assert.equal((await handleStorageMediaBackupSource(request({ operation: "read", ...bad }), deps)).status, 403)
    assert.equal(calls.inspect, before); assert.equal(calls.open, 0)
  }
  deps.now = () => now + 300_000
  assert.equal((await handleStorageMediaBackupSource(request({ operation: "read", ...item }), deps)).status, 403)
})

test("inspect is read-only; streamed bytes fence id/version/size/etag before and after EOF", async () => {
  const { deps, request, inventory, calls, storage } = setup(), item = await inventory()
  assert.equal((await handleStorageMediaBackupSource(request({ operation: "inspect", ...item }), deps)).status, 200); assert.equal(calls.open, 0)
  const read = await handleStorageMediaBackupSource(request({ operation: "read", ...item }), deps)
  assert.equal(read.status, 200); assert.deepEqual(new Uint8Array(await read.arrayBuffer()), new Uint8Array([1, 2, 3, 4])); assert.equal(calls.open, 1)
  assert.equal(read.headers.get("content-type"), "application/octet-stream")
  let count = 0
  storage.inspect = async () => ++count === 1 ? info : { ...info, source: { ...source, version: "changed" } }
  const changed = await handleStorageMediaBackupSource(request({ operation: "read", ...item }), deps)
  assert.equal(changed.status, 200); await assert.rejects(changed.arrayBuffer())
})

test("unsafe operations and oversized input have no provider access", async () => {
  for (const input of [{ operation: "delete" }, { operation: "inventory", bucket: "other" }, { operation: "inventory", extra: "x".repeat(21_000) }]) {
    const { deps, request, calls } = setup()
    assert.ok([400, 413].includes((await handleStorageMediaBackupSource(request(input), deps)).status)); assert.equal(calls.provider, 0)
  }
})

test("provider encodes opaque key, uses only authenticated READ/info/list APIs and ignores user metadata", async () => {
  const origin = `https://${fcunoConnectionPolicy.supabase.projectRef}.supabase.co`, seen: { url: string; init: RequestInit }[] = []
  const encoded = encodedStorageKey(source.bucket, source.path)
  const provider = createSupabaseStorageReadProvider({ url: origin, serviceRoleKey: "test-only", fetch: (async (url, init) => {
    seen.push({ url: String(url), init: init! })
    if (String(url).includes("/object/info/")) return Response.json({ bucket_id: source.bucket, name: source.path, id: source.id, version: source.version, size: 4, etag: "opaque-etag", metadata: { version: "evil", size: 99 } })
    return new Response(new Uint8Array([1, 2, 3, 4]), { headers: { ETag: info.etag, "Content-Length": "4" } })
  }) as typeof fetch })
  assert.deepEqual(await provider.inspect(source.bucket, source.path, new AbortController().signal), info)
  const read = await provider.open(source, info.etag, new AbortController().signal)
  assert.deepEqual(new Uint8Array(await read.arrayBuffer()), new Uint8Array([1, 2, 3, 4]))
  assert.equal(seen[0].url, `${origin}/storage/v1/object/info/${encoded}`)
  assert.equal(seen[1].url, `${origin}/storage/v1/object/authenticated/${encoded}`)
  assert.equal(seen[0].init.method, "GET"); assert.equal(seen[1].init.method, "GET")
  assert.equal((seen[1].init.headers as Record<string, string>)["If-Match"], info.etag)
  assert.equal(seen[1].init.body, undefined)
  assert.ok(seen.every(call => call.init.redirect === "error" && call.init.cache === "no-store"))
})

test("path encoding never collapses slash, percent, Unicode or space and denies URL dot-normalization", () => {
  for (const path of ["/leading", "a//b", "a/%2E/b", "a/%2f/b", "a/名 space?x#y"]) {
    assert.equal(encodedStorageKey("media", path).split("/").slice(1).map(decodeURIComponent).join("/"), path)
  }
  for (const path of [".", "..", "a/../b", "a/./b"]) assert.throws(() => encodedStorageKey("media", path))
})

test("only the explicitly approved complete snapshot is inventoried", async () => {
  for (const variant of ["hash", "count", "size", "bucket"]) {
    const { deps, storage, request, calls } = setup()
    if (variant === "hash") deps.runtime.approvedInventorySha256 = "0".repeat(64)
    if (variant === "count") storage.listObjects = async () => ({ objects: approved.slice(1).map(item => ({ name: item.path, id: item.id })), folders: [], hasNext: false })
    if (variant === "size") {
      const original = storage.inspect
      storage.inspect = async (...args) => { const result = await original(...args); return { ...result, source: { ...result.source, sizeBytes: result.source.sizeBytes + 1 } } }
    }
    if (variant === "bucket") {
      const original = storage.listObjects
      storage.listObjects = async (bucket, ...args) => { assert.equal(bucket, source.bucket); return original(bucket, ...args) }
      deps.runtime.approvedInventorySha256 = undefined
    }
    assert.notEqual((await handleStorageMediaBackupSource(request(), deps)).status, 200); assert.equal(calls.open, 0)
  }
})

test("proxy withholds EOF for late extra bytes, truncation and post-read inspection failures", async () => {
  for (const variant of ["extra", "truncated", "post-inspect"]) {
    const { deps, storage, request, inventory } = setup(), item = await inventory()
    let opened = false
    const originalInspect = storage.inspect
    storage.inspect = async (...args) => { if (opened && variant === "post-inspect") throw Error("private provider failure"); return originalInspect(...args) }
    storage.open = async () => {
      opened = true
      let step = 0
      return new Response(new ReadableStream({ pull(controller) {
        if (step++ === 0) controller.enqueue(new Uint8Array(variant === "truncated" ? [1, 2, 3] : [1, 2, 3, 4]))
        else if (variant === "extra" && step === 2) controller.enqueue(new Uint8Array([5]))
        else controller.close()
      } }), { headers: { "Content-Length": "4", ETag: info.etag } })
    }
    const response = await handleStorageMediaBackupSource(request({ operation: "read", ...item }), deps)
    assert.equal(response.status, 200); assert.equal(response.headers.has("content-length"), false)
    assert.equal(response.headers.get("x-fcuno-storage-expected-bytes"), "4")
    const reader = response.body!.getReader(), first = await reader.read()
    assert.equal(first.done, false); assert.equal(first.value?.byteLength, variant === "truncated" ? 3 : 4)
    await assert.rejects(reader.read()); reader.releaseLock()
  }
})

test("proxy rejects empty, redirected, ranged, transformed or mismatched upstream responses", async () => {
  for (const variant of ["empty", "redirect", "range", "encoding", "etag", "length"]) {
    const { deps, storage, request, inventory } = setup(), item = await inventory()
    storage.open = async () => new Response(variant === "empty" ? null : new Uint8Array([1, 2, 3, 4]), {
      status: variant === "redirect" ? 302 : 200,
      headers: { "Content-Length": variant === "length" ? "5" : "4", ETag: variant === "etag" ? '"different"' : info.etag,
        ...(variant === "range" ? { "Content-Range": "bytes 0-3/4" } : {}), ...(variant === "encoding" ? { "Content-Encoding": "gzip" } : {}) },
    })
    assert.equal((await handleStorageMediaBackupSource(request({ operation: "read", ...item }), deps)).status, 502)
  }
})

test("large transport chunks are rechunked across downstream pulls, not buffered as a whole file", async () => {
  const { deps, storage, request, inventory } = setup()
  const large = { ...source, sizeBytes: 700_000 }
  const snapshot = approved.map((item, index) => index === 0 ? large : index === 14 ? { ...item, sizeBytes: item.sizeBytes - 699_996 } : item)
  deps.runtime.approvedInventorySha256 = storageSourceInventorySha256(snapshot)
  storage.listObjects = async () => ({ objects: snapshot.map(item => ({ name: item.path, id: item.id })), folders: [], hasNext: false })
  storage.inspect = async (_bucket, path) => ({ source: snapshot.find(item => item.path === path)!, etag: info.etag })
  let pulls = 0
  storage.open = async () => new Response(new ReadableStream({ pull(controller) {
    if (pulls++ === 0) controller.enqueue(new Uint8Array(700_000))
    else controller.close()
  } }, { highWaterMark: 0 }), { headers: { "Content-Length": "700000", ETag: info.etag } })
  const item = await inventory(), response = await handleStorageMediaBackupSource(request({ operation: "read", ...item }), deps)
  const reader = response.body!.getReader()
  let total = 0, chunks = 0
  for (;;) {
    const part = await reader.read(); if (part.done) break
    assert.ok(part.value.byteLength <= 256 * 1024); total += part.value.byteLength; chunks++
    if (chunks <= 3) assert.equal(pulls, 1)
  }
  assert.equal(total, 700_000); assert.equal(chunks, 3); assert.equal(pulls, 2); reader.releaseLock()
})

test("client cancellation aborts the upstream reader and active fetch signal", async () => {
  const { deps, storage, request, inventory } = setup(), item = await inventory(), controller = new AbortController()
  let cancelled = 0, upstreamSignal: AbortSignal | undefined
  storage.open = async (_source, _etag, signal) => {
    upstreamSignal = signal
    return new Response(new ReadableStream({ pull() { /* Wait for cancellation. */ }, cancel() { cancelled++ } }), { headers: { "Content-Length": "4", ETag: info.etag } })
  }
  const response = await handleStorageMediaBackupSource(request({ operation: "read", ...item }, { signal: controller.signal }), deps)
  const read = response.body!.getReader().read(); controller.abort()
  await assert.rejects(read); assert.equal(upstreamSignal?.aborted, true); assert.equal(cancelled, 1)
})

test("fixed activation expiry aborts an in-flight byte stream without releasing a provider URL", async () => {
  const { deps, storage, request, inventory } = setup(), item = await inventory()
  deps.runtime.windowExpiresAt = new Date(now + 20).toISOString()
  let cancelled = 0
  storage.open = async () => new Response(new ReadableStream({ pull() { /* Timer must stop this pending read. */ }, cancel() { cancelled++ } }),
    { headers: { "Content-Length": "4", ETag: info.etag } })
  const response = await handleStorageMediaBackupSource(request({ operation: "read", ...item }), deps)
  assert.equal(response.status, 200); assert.equal(response.headers.has("location"), false)
  const keepAlive = setTimeout(() => {}, 100)
  try { await assert.rejects(response.body!.getReader().read()); assert.equal(cancelled, 1) }
  finally { clearTimeout(keepAlive) }
})

test("downstream response cancellation aborts upstream fetch and reader", async () => {
  const { deps, storage, request, inventory } = setup(), item = await inventory()
  let cancelled = 0, upstreamSignal: AbortSignal | undefined
  storage.open = async (_source, _etag, signal) => {
    upstreamSignal = signal
    return new Response(new ReadableStream({ cancel() { cancelled++ } }), { headers: { "Content-Length": "4", ETag: info.etag } })
  }
  const response = await handleStorageMediaBackupSource(request({ operation: "read", ...item }), deps)
  await response.body!.cancel()
  assert.equal(upstreamSignal?.aborted, true); assert.equal(cancelled, 1)
})

test("bounded per-object deadline aborts pending stream, never exceeds Vercel headroom", async () => {
  const { deps, storage, request, inventory } = setup(), item = await inventory()
  let cancelled = 0
  storage.open = async () => new Response(new ReadableStream({ pull() { /* Deadline must abort. */ }, cancel() { cancelled++ } }),
    { headers: { "Content-Length": "4", ETag: info.etag } })
  const original = AbortSignal.timeout, durations: number[] = []
  AbortSignal.timeout = duration => { durations.push(duration); return original(duration === 240_000 ? 15 : duration) }
  const keepAlive = setTimeout(() => {}, 100)
  try {
    const response = await handleStorageMediaBackupSource(request({ operation: "read", ...item }), deps)
    await assert.rejects(response.body!.getReader().read())
    assert.ok(durations.includes(240_000)); assert.ok(durations.every(duration => duration <= 240_000)); assert.equal(cancelled, 1)
  } finally { AbortSignal.timeout = original; clearTimeout(keepAlive) }
})
