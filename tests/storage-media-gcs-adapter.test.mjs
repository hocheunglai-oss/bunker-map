import assert from "node:assert/strict"
import test from "node:test"
import { createStorageMediaGcsAdapter } from "../scripts/lib/storage-media-gcs-adapter.mjs"
import { copyStorageObject } from "../lib/storageMediaBackup.mjs"
import { fcunoConnectionPolicy } from "../config/fcunoConnections.ts"

const policy = fcunoConnectionPolicy.storageMediaBackup
const bytes = Buffer.from("123456789")
const source = { bucket: policy.sourceBucket, path: "literal /%?#名.mp4", id: "source-id", version: "immutable-version", sizeBytes: bytes.length }
const record = { schema: "fcuno.storage-media-control/v1", fence: 1, lease: null, latestSuccess: null }
const context = () => ({ signal: new AbortController().signal, deadline: Date.now() + 600_000 })
function crc32c(input) {
  let result = 0xffffffff
  for (const byte of input) {
    result ^= byte
    for (let bit = 0; bit < 8; bit++) result = (result >>> 1) ^ ((result & 1) ? 0x82f63b78 : 0)
  }
  const buffer = Buffer.alloc(4); buffer.writeUInt32BE((result ^ 0xffffffff) >>> 0)
  return buffer.toString("base64")
}
async function collect(iterable) { const parts = []; for await (const part of iterable) parts.push(part); return Buffer.concat(parts) }
function setup(options = {}) {
  const calls = [], resources = new Map(), latest = new Map(), tokenContexts = []
  let nextGeneration = 9007199254740993n
  const state = { calls, resources, latest, tokenContexts, alterReceipt: null, alterMetadata: null, alterBody: null, onRead: null }
  const bucket = { name: policy.targetBucket, location: policy.googleRegion.toUpperCase(), versioning: { enabled: true },
    iamConfiguration: { publicAccessPrevention: "enforced", uniformBucketLevelAccess: { enabled: true } }, ...options.bucket }
  const fetchImpl = async (input, init) => {
    const url = new URL(input)
    calls.push({ url, init })
    assert.equal(url.origin, "https://storage.googleapis.com")
    assert.ok([undefined, "GET", "POST"].includes(init.method))
    assert.equal(init.redirect, "error"); assert.equal(init.cache, "no-store")
    assert.equal(init.headers.Authorization, "Bearer test-only-adc-token")
    assert.ok(init.signal instanceof AbortSignal)
    if (url.pathname === `/storage/v1/b/${policy.targetBucket}`) return Response.json(bucket)
    if (url.pathname === `/upload/storage/v1/b/${policy.targetBucket}/o`) {
      assert.equal(init.method, "POST"); assert.equal(init.duplex, "half")
      assert.equal(url.searchParams.get("uploadType"), "media")
      const name = url.searchParams.get("name"), expected = url.searchParams.get("ifGenerationMatch")
      if ((expected === "0" && latest.has(name)) || (expected !== "0" && latest.get(name) !== expected)) return Response.json({ error: "conflict" }, { status: 412 })
      const parts = [], reader = init.body.getReader()
      for (;;) {
        const item = await reader.read()
        if (item.done) break
        assert.ok(item.value.byteLength <= 256 * 1024); parts.push(item.value)
      }
      reader.releaseLock()
      const body = Buffer.concat(parts), generation = String(nextGeneration++)
      const metadata = { bucket: policy.targetBucket, name, generation, size: String(body.length), crc32c: crc32c(body) }
      resources.set(`${name}\0${generation}`, { metadata, body }); latest.set(name, generation)
      return Response.json(state.alterReceipt ? state.alterReceipt({ ...metadata }) : metadata)
    }
    const match = url.pathname.match(new RegExp(`^/storage/v1/b/${policy.targetBucket}/o/(.+)$`))
    assert.ok(match)
    const name = decodeURIComponent(match[1]), generation = url.searchParams.get("generation") || latest.get(name)
    const resource = resources.get(`${name}\0${generation}`)
    if (!resource) return Response.json({ error: "absent" }, { status: 404 })
    if (url.searchParams.get("alt") === "media") {
      if (state.onRead) return state.onRead(resource, init)
      return new Response(state.alterBody ? state.alterBody(resource.body) : resource.body, { headers: {
        "Content-Length": String(resource.body.length), "X-Goog-Generation": generation, "X-Goog-Hash": `crc32c=${resource.metadata.crc32c}`,
      } })
    }
    return Response.json(state.alterMetadata ? state.alterMetadata({ ...resource.metadata }) : resource.metadata)
  }
  const adapter = createStorageMediaGcsAdapter({ runId: "offline-run_1", fetch: fetchImpl,
    async getAccessToken(op) { tokenContexts.push(op); return "test-only-adc-token" }, ...options.factory })
  return { adapter, ...state, state, fetchImpl }
}

test("create-only media upload captures server receipt and preserves unsafe-integer generation exactly", async () => {
  const { adapter, calls } = setup()
  const saved = await adapter.writeTarget({ source, bytes, ifGenerationMatch: "0" }, context())
  assert.equal(saved.target.generation, "9007199254740993")
  assert.equal(saved.sizeBytes, bytes.length); assert.equal(saved.crc32c, "4waSgw==")
  assert.match(saved.target.objectName, /^fcuno-storage-media\/runs\/offline-run_1\/objects\/[a-f0-9]{64}$/)
  assert.equal(saved.target.objectName, adapter.objectNameForSource(source))
  const upload = calls.find(call => call.init.method === "POST")
  assert.equal(upload.url.searchParams.get("ifGenerationMatch"), "0")
  assert.equal(upload.url.searchParams.get("name"), saved.target.objectName)
  assert.ok(Object.isFrozen(saved)); assert.ok(Object.isFrozen(saved.target))
  await assert.rejects(adapter.writeTarget({ source, bytes, ifGenerationMatch: "0" }, context()), /precondition_failed/)
  assert.ok(calls.every(call => call.init.method !== "DELETE"))
})

test("metadata and readback select the receipt generation, not a newer live object", async () => {
  const { adapter, resources, latest, calls } = setup()
  const saved = await adapter.writeTarget({ source, bytes, ifGenerationMatch: "0" }, context())
  latest.set(saved.target.objectName, "18446744073709551615")
  resources.set(`${saved.target.objectName}\0${latest.get(saved.target.objectName)}`, { metadata: { bucket: policy.targetBucket, name: saved.target.objectName, generation: latest.get(saved.target.objectName), size: "3", crc32c: crc32c(Buffer.from("new")) }, body: Buffer.from("new") })
  assert.deepEqual(await adapter.inspectTarget(saved.target, context()), saved)
  const opened = await adapter.readTarget(saved.target, context())
  assert.deepEqual(opened.target, saved.target); assert.deepEqual(await collect(opened.bytes), bytes)
  for (const call of calls.filter(call => call.url.pathname.includes("/o/"))) assert.equal(call.url.searchParams.get("generation"), saved.target.generation)
})

test("immutable manifest upload permits only this run's exact manifest name and create-only precondition", async () => {
  const { adapter } = setup()
  const saved = await adapter.uploadImmutable({ objectName: adapter.manifestObjectName, bytes: (async function* () { yield bytes })(), sizeBytes: bytes.length, contentType: "application/json" }, context())
  assert.equal(saved.target.objectName, adapter.manifestObjectName)
  for (const objectName of [`${policy.targetPrefix}/control.json`, `${policy.targetPrefix}/runs/other/manifest.json`, "outside/manifest.json"]) {
    await assert.rejects(adapter.uploadImmutable({ objectName, bytes, ifGenerationMatch: "0" }, context()), /unapproved_immutable_write/)
  }
  await assert.rejects(adapter.uploadImmutable({ objectName: adapter.manifestObjectName, bytes, ifGenerationMatch: "1" }, context()), /unapproved_immutable_write/)
})

test("unsafe bucket configurations deny all object writes", async () => {
  for (const bucket of [{ location: "EU" }, { versioning: { enabled: false } }, { iamConfiguration: { publicAccessPrevention: "inherited", uniformBucketLevelAccess: { enabled: true } } },
    { iamConfiguration: { publicAccessPrevention: "enforced", uniformBucketLevelAccess: { enabled: false } } }]) {
    const { adapter, calls } = setup({ bucket })
    await assert.rejects(adapter.writeTarget({ source, bytes, ifGenerationMatch: "0" }, context()), /unsafe_bucket_configuration/)
    assert.equal(calls.length, 1); assert.ok(calls.every(call => !call.init.method || call.init.method === "GET"))
  }
})

test("invalid write receipts fail closed without latest lookup or delete", async () => {
  for (const change of [{ bucket: "other" }, { name: "other" }, { generation: 9007199254740992 }, { generation: "18446744073709551616" },
    { generation: "01" }, { size: "8" }, { size: 9 }, { crc32c: "not-crc" }]) {
    const { adapter, calls, state } = setup()
    state.alterReceipt = metadata => ({ ...metadata, ...change })
    await assert.rejects(adapter.writeTarget({ source, bytes, ifGenerationMatch: "0" }, context()))
    assert.equal(calls.length, 2); assert.equal(calls[1].init.method, "POST")
  }
})

test("pure helper rejects canonical-but-wrong upload CRC and adapter never cleans up by deleting", async () => {
  const { adapter, calls, state } = setup()
  state.alterReceipt = metadata => ({ ...metadata, crc32c: "AAAAAA==" })
  await assert.rejects(copyStorageObject(source, { ...adapter, inspectSource: async () => source,
    openSource: async () => ({ identity: source, bytes: (async function* () { yield bytes })() }) }, { ...context(), now: Date.now }), /computed source size\/CRC/)
  assert.ok(calls.every(call => call.init.method !== "DELETE"))
  assert.equal(calls.filter(call => call.init.method === "POST").length, 1)
})

test("control initial creation and compare-and-swap use exact generation and verify committed bytes", async () => {
  const { adapter, calls } = setup()
  assert.equal(await adapter.control.read(context()), null)
  const created = await adapter.control.compareAndSwap("0", record, context())
  assert.deepEqual(created, { generation: "9007199254740993", record })
  assert.deepEqual(await adapter.control.read(context()), created)
  assert.equal(await adapter.control.compareAndSwap("0", record, context()), null)
  const changed = await adapter.control.compareAndSwap(created.generation, { ...record, fence: 2 }, context())
  assert.equal(changed.generation, "9007199254740994"); assert.equal(changed.record.fence, 2)
  assert.equal(await adapter.control.compareAndSwap(created.generation, record, context()), null)
  const writes = calls.filter(call => call.init.method === "POST")
  assert.deepEqual(writes.map(call => call.url.searchParams.get("ifGenerationMatch")), ["0", "0", created.generation, created.generation])
  assert.ok(writes.every(call => call.url.searchParams.get("name") === `${policy.targetPrefix}/control.json`))
})

test("control corrupt readback is rejected without deletion or unconditional overwrite", async () => {
  const { adapter, calls, state } = setup()
  state.alterBody = body => Buffer.from(body).fill(0)
  await assert.rejects(adapter.control.compareAndSwap("0", record, context()), /control_integrity_mismatch/)
  assert.equal(calls.filter(call => call.init.method === "POST").length, 1)
  assert.ok(calls.every(call => call.init.method !== "DELETE"))
})

test("abort while token acquisition is pending prevents all provider IO", async () => {
  const controller = new AbortController(), calls = []
  const adapter = createStorageMediaGcsAdapter({ runId: "abort-token", getAccessToken: async () => new Promise(() => {}), fetch: async (...args) => { calls.push(args); throw Error("unexpected IO") } })
  const pending = adapter.validateBucket({ signal: controller.signal, deadline: Date.now() + 60_000 })
  controller.abort(new Error("offline cancellation"))
  await assert.rejects(pending, /offline cancellation/); assert.equal(calls.length, 0)
})

test("abort while headers are pending rejects promptly and late responses are cancelled", async () => {
  let resolveFetch, cancelled = false
  const controller = new AbortController()
  const adapter = createStorageMediaGcsAdapter({ runId: "abort-headers", getAccessToken: async () => "test-token", fetch: async () => new Promise(resolve => { resolveFetch = resolve }) })
  const pending = adapter.validateBucket({ signal: controller.signal, deadline: Date.now() + 60_000 })
  while (!resolveFetch) await new Promise(resolve => setImmediate(resolve))
  controller.abort(new Error("offline cancellation"))
  await assert.rejects(pending, /offline cancellation/)
  resolveFetch(new Response(new ReadableStream({ cancel() { cancelled = true } })))
  await new Promise(resolve => setImmediate(resolve)); assert.equal(cancelled, true)
})

test("readback early return before first next cancels the body; large fetch chunks are rechunked", async () => {
  const { adapter, state } = setup(), large = Buffer.alloc(700_000, 7), largeSource = { ...source, sizeBytes: large.length }
  const saved = await adapter.writeTarget({ source: largeSource, bytes: large, ifGenerationMatch: "0" }, context())
  const opened = await adapter.readTarget(saved.target, context()), parts = []
  for await (const part of opened.bytes) { assert.ok(part.byteLength <= 256 * 1024); parts.push(part) }
  assert.deepEqual(Buffer.concat(parts), large)
  let cancelled = false
  state.onRead = resource => new Response(new ReadableStream({ cancel() { cancelled = true } }), { headers: {
    "Content-Length": String(resource.body.length), "X-Goog-Generation": saved.target.generation, "X-Goog-Hash": `crc32c=${resource.metadata.crc32c}`,
  } })
  const unread = await adapter.readTarget(saved.target, context())
  await unread.bytes[Symbol.asyncIterator]().return()
  assert.equal(cancelled, true)
})

test("expired deadlines, invalid configuration and unapproved generations deny before object IO", async () => {
  const { adapter, calls, tokenContexts } = setup()
  await assert.rejects(adapter.validateBucket({ signal: new AbortController().signal, deadline: Date.now() - 1 }), /deadline/)
  assert.equal(calls.length, 0)
  for (const runId of ["../escape", "with/slash", "", "space id"]) assert.throws(() => createStorageMediaGcsAdapter({ runId, getAccessToken: async () => "x" }))
  for (const generation of ["0", "01", "18446744073709551616", 7]) await assert.rejects(adapter.inspectTarget({ bucket: policy.targetBucket, objectName: adapter.manifestObjectName, generation }, context()))
  assert.equal(calls.length, 0)
  const before = Date.now()
  await adapter.validateBucket(context())
  assert.ok(tokenContexts[0].deadline >= before && tokenContexts[0].deadline <= Date.now() + 20_000)
})

test("readback cancellation interrupts a pending body read and cancels upstream", async () => {
  const { adapter, state } = setup()
  const saved = await adapter.writeTarget({ source, bytes, ifGenerationMatch: "0" }, context())
  let cancelled = false
  state.onRead = resource => new Response(new ReadableStream({ cancel() { cancelled = true } }), { headers: {
    "Content-Length": String(resource.body.length), "X-Goog-Generation": saved.target.generation, "X-Goog-Hash": `crc32c=${resource.metadata.crc32c}`,
  } })
  const controller = new AbortController(), opened = await adapter.readTarget(saved.target, { signal: controller.signal, deadline: Date.now() + 60_000 })
  const pending = opened.bytes.next()
  controller.abort(new Error("cancel readback"))
  await assert.rejects(pending, /cancel readback/)
  assert.equal(cancelled, true)
})

test("explicit clock deadline checks stop immediately resolving empty-chunk producers", async () => {
  let current = Date.now(), pulls = 0
  const { adapter, calls } = setup({ factory: { now: () => current } })
  const deadline = current + 1000
  const input = (async function* () { for (;;) { pulls++; current += 501; yield Buffer.alloc(0) } })()
  await assert.rejects(adapter.uploadImmutable({ objectName: adapter.manifestObjectName, bytes: input }, { signal: new AbortController().signal, deadline }), /deadline|cancelled|missing_eof/)
  assert.ok(pulls <= 2)
  assert.equal(calls.filter(call => call.init.method === "POST").length, 1)
})

test("oversized metadata rejects even when the underlying cancellation promise never settles", async () => {
  let cancelled = false
  const controller = new AbortController()
  const adapter = createStorageMediaGcsAdapter({ runId: "uncooperative-metadata", getAccessToken: async () => "offline-token",
    fetch: async () => new Response(new ReadableStream({
      start(stream) { stream.enqueue(new Uint8Array(1024 * 1024 + 1)) },
      cancel() { cancelled = true; return new Promise(() => {}) },
    })) })
  const pending = adapter.validateBucket({ signal: controller.signal, deadline: Date.now() + 1000 })
  let timer
  try {
    const outcome = await Promise.race([pending.then(() => "resolved", () => "rejected"), new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve("blocked") }, 60) })])
    assert.equal(outcome, "rejected"); assert.equal(cancelled, true)
  } finally { clearTimeout(timer); controller.abort() }
})

test("readback return before first next does not await an uncooperative cancellation promise", async () => {
  const { adapter, state } = setup()
  const saved = await adapter.writeTarget({ source, bytes, ifGenerationMatch: "0" }, context())
  let cancelled = false
  state.onRead = resource => new Response(new ReadableStream({ cancel() { cancelled = true; return new Promise(() => {}) } }), { headers: {
    "Content-Length": String(resource.body.length), "X-Goog-Generation": saved.target.generation, "X-Goog-Hash": `crc32c=${resource.metadata.crc32c}`,
  } })
  const opened = await adapter.readTarget(saved.target, context())
  let timer
  try {
    const outcome = await Promise.race([opened.bytes.return().then(() => "closed"), new Promise(resolve => { timer = setTimeout(() => resolve("blocked"), 60) })])
    assert.equal(outcome, "closed"); assert.equal(cancelled, true)
  } finally { clearTimeout(timer) }
})

test("late cancellation rejection is observed and never escapes as an unhandled rejection", async () => {
  const { adapter, state } = setup()
  const saved = await adapter.writeTarget({ source, bytes, ifGenerationMatch: "0" }, context())
  let rejectCancellation
  state.onRead = resource => new Response(new ReadableStream({ cancel() { return new Promise((_, reject) => { rejectCancellation = reject }) } }), { headers: {
    "Content-Length": String(resource.body.length), "X-Goog-Generation": saved.target.generation, "X-Goog-Hash": `crc32c=${resource.metadata.crc32c}`,
  } })
  const opened = await adapter.readTarget(saved.target, context())
  await opened.bytes.return()
  rejectCancellation(new Error("offline cleanup rejection"))
  await new Promise(resolve => setImmediate(resolve))
})
