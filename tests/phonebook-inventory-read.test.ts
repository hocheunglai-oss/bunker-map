import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import test from "node:test"
import vm from "node:vm"
import ts from "typescript"

const source = readFileSync(new URL("../lib/phonebookCarddav.ts", import.meta.url), "utf8")
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const xml = '<d:multistatus xmlns:d="DAV:"><d:response><d:href>/book/</d:href></d:response></d:multistatus>'
const wallStart = Date.parse("2026-10-22T02:00:00.000Z")
type Call = { at: number; init: RequestInit }

function fixture(fetcher: (call: Call, attempt: number) => Response | Promise<Response>) {
  let now = 0
  let timerId = 0
  const timers = new Map<number, { at: number; callback: () => void }>()
  const calls: Call[] = []
  const events: unknown[] = []
  class ClockDate extends Date {
    constructor(value?: string | number) { super(value === undefined ? wallStart + now : value) }
    static now() { return wallStart + now }
  }
  const exports: { readCardDavInventoryXml?: (signal?: AbortSignal) => Promise<string> } = {}
  vm.runInNewContext(compiled, {
    exports, Error, URL, Buffer, AbortController, AbortSignal, TextDecoder,
    Date: ClockDate, performance: { now: () => now },
    setTimeout(callback: () => void, delay: number) {
      assert.ok(Number.isFinite(delay) && delay >= 0 && delay <= 25_000)
      const id = ++timerId
      timers.set(id, { at: now + delay, callback })
      return id
    },
    clearTimeout(id: number) { timers.delete(id) },
    console: { info: (...args: unknown[]) => events.push(args), error: (...args: unknown[]) => events.push(args) },
    require(name: string) { assert.equal(name, "node:crypto"); return { createHash, randomUUID } },
    process: { env: {
      CARDDAV_ADDRESSBOOK_URL: "https://provider-fixture.invalid/book/",
      CARDDAV_USERNAME: "synthetic-user", CARDDAV_PASSWORD: "synthetic-password",
    } },
    fetch(target: string, init: RequestInit) {
      assert.equal(target, "https://provider-fixture.invalid/book/")
      assert.equal(init.method, "PROPFIND")
      assert.equal(init.redirect, "error")
      assert.equal(init.cache, "no-store")
      assert.ok(init.signal)
      const headers = new Headers(init.headers)
      assert.equal(headers.get("authorization"), `Basic ${Buffer.from("synthetic-user:synthetic-password").toString("base64")}`)
      assert.equal(headers.get("depth"), "1")
      assert.equal(headers.get("content-type"), "application/xml; charset=utf-8")
      assert.equal(init.body, '<?xml version="1.0" encoding="UTF-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:getetag/><d:resourcetype/></d:prop></d:propfind>')
      const call = { at: now, init }
      calls.push(call)
      return Promise.resolve(fetcher(call, calls.length))
    },
  })
  assert.equal(typeof exports.readCardDavInventoryXml, "function")
  const flush = async () => { for (let turn = 0; turn < 40; turn += 1) await Promise.resolve() }
  async function run<T>(pending: Promise<T>): Promise<T> {
    let done = false
    let failed = false
    let result: T | undefined
    let error: unknown
    pending.then((value) => { done = true; result = value }, (reason) => { done = true; failed = true; error = reason })
    for (let step = 0; step < 20 && !done; step += 1) {
      await flush()
      if (done) break
      const next = [...timers].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
      assert.ok(next, "An unsettled operation must retain a bounded deadline")
      assert.ok(next[1].at <= 25_000)
      now = next[1].at
      timers.delete(next[0])
      next[1].callback()
    }
    await flush()
    assert.equal(done, true, "Read-only inventory must settle within its fixed budget")
    assert.equal(timers.size, 0, "Every owned timer must be cleared")
    assert.equal(events.length, 0, "The transport helper must not log credentials, URLs or bodies")
    if (failed) throw error
    return result as T
  }
  return {
    calls, timers, run, read: (signal?: AbortSignal) => exports.readCardDavInventoryXml!(signal),
    at: () => now,
    schedule(delay: number, callback: () => void) { timers.set(++timerId, { at: now + delay, callback }) },
  }
}

test("read-only inventory retries only three times with fixed 300/600ms backoff and cancels failed bodies", async () => {
  let cancelled = 0
  const f = fixture((_call, attempt) => attempt < 3
    ? new Response(new ReadableStream({ cancel() { cancelled += 1 } }), { status: 503 })
    : new Response(xml, { status: 207 }))
  assert.equal(await f.run(f.read()), xml)
  assert.deepEqual(f.calls.map((call) => call.at), [0, 300, 900])
  assert.equal(cancelled, 2)
  assert.ok(f.calls.every((call) => call.init.signal?.aborted))
})

test("read-only inventory honors short Retry-After seconds and HTTP dates", async () => {
  for (const value of ["2", new Date(wallStart + 2000).toUTCString()]) {
    const f = fixture((_call, attempt) => new Response(attempt === 1 ? null : xml, {
      status: attempt === 1 ? 503 : 207, headers: attempt === 1 ? { "Retry-After": value } : {},
    }))
    assert.equal(await f.run(f.read()), xml)
    assert.deepEqual(f.calls.map((call) => call.at), [0, 2000])
  }
})

test("an excessive Retry-After stops rather than retrying earlier than requested", async () => {
  for (const value of ["25", "120", "999999999999999999999999999", new Date(wallStart + 60_000).toUTCString()]) {
    const f = fixture(() => new Response(null, { status: 503, headers: { "Retry-After": value } }))
    await assert.rejects(f.run(f.read()), /HTTP 503/)
    assert.equal(f.calls.length, 1)
    assert.equal(f.at(), 0)
  }
})

test("transient HTTP statuses and connection errors retry but permanent responses never do", async () => {
  for (const status of [408, 429, 500, 502, 503, 504]) {
    const f = fixture((_call, attempt) => new Response(attempt === 1 ? null : xml, { status: attempt === 1 ? status : 207 }))
    assert.equal(await f.run(f.read()), xml)
    assert.equal(f.calls.length, 2)
  }
  const network = fixture((_call, attempt) => {
    if (attempt === 1) throw new Error("PRIVATE PROVIDER CREDENTIAL")
    return new Response(xml, { status: 207 })
  })
  assert.equal(await network.run(network.read()), xml)
  assert.equal(network.calls.length, 2)
  for (const status of [200, 301, 401, 403, 404, 501, 505]) {
    const f = fixture(() => new Response(null, { status }))
    await assert.rejects(f.run(f.read()), new RegExp(`HTTP ${status}`))
    assert.equal(f.calls.length, 1)
  }
})

test("persistent transient failure has no fourth attempt and preserves a sanitized failure", async () => {
  const f = fixture(() => new Response("PRIVATE PROVIDER CREDENTIAL", { status: 503 }))
  await assert.rejects(f.run(f.read()), /HTTP 503/)
  assert.deepEqual(f.calls.map((call) => call.at), [0, 300, 900])
})

test("fetch timeouts abort each request by 15s and the whole operation by 25s", async () => {
  const f = fixture(() => new Promise<Response>(() => {}))
  await assert.rejects(f.run(f.read()), /CardDAV count unavailable/)
  assert.ok(f.calls.length <= 3)
  assert.equal(f.at(), 25_000)
  assert.ok(f.calls.every((call) => call.init.signal?.aborted))
  assert.equal(f.calls[0].at, 0)
  assert.ok(f.calls[1].at >= 15_000)
})

test("a stalled response body is cancelled without escaping the shared deadline", async () => {
  let cancelled = 0
  const f = fixture(() => new Response(new ReadableStream({ cancel() { cancelled += 1 } }), { status: 207 }))
  await assert.rejects(f.run(f.read()), /CardDAV count unavailable/)
  assert.equal(f.at(), 25_000)
  assert.equal(cancelled, f.calls.length)
  assert.ok(f.calls.every((call) => call.init.signal?.aborted))
})

test("body cancellation itself cannot hold a failed read open", async () => {
  let cancelled = 0
  const f = fixture(() => new Response(new ReadableStream({ cancel() { cancelled += 1; return new Promise<void>(() => {}) } }), { status: 503 }))
  await assert.rejects(f.run(f.read()), /HTTP 503/)
  assert.equal(f.calls.length, 3)
  assert.equal(cancelled, 3)
  assert.equal(f.at(), 900)
})

test("caller abort before fetch, during fetch or during retry backoff prevents more requests", async () => {
  for (const phase of ["before", "fetch", "backoff"]) {
    const controller = new AbortController()
    const f = fixture(() => phase === "fetch" ? new Promise<Response>(() => {}) : new Response(null, { status: 503 }))
    if (phase === "before") controller.abort()
    else f.schedule(100, () => controller.abort())
    await assert.rejects(f.run(f.read(controller.signal)), /CardDAV count unavailable/)
    assert.equal(f.calls.length, phase === "before" ? 0 : 1)
    assert.ok(f.calls.every((call) => call.init.signal?.aborted))
    assert.equal(f.at(), phase === "before" ? 0 : 100)
  }
})

test("a response arriving after caller abort has its unread body cancelled", async () => {
  let resolve!: (response: Response) => void
  let cancelled = 0
  const controller = new AbortController()
  const f = fixture(() => new Promise<Response>((done) => { resolve = done }))
  f.schedule(100, () => controller.abort())
  await assert.rejects(f.run(f.read(controller.signal)), /CardDAV count unavailable/)
  resolve(new Response(new ReadableStream({ cancel() { cancelled += 1 } }), { status: 207 }))
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve()
  assert.equal(cancelled, 1)
  assert.equal(f.timers.size, 0)
  assert.equal(f.calls.length, 1)
})

test("oversized inventory bodies and advertised lengths fail closed without a retry", async () => {
  for (const advertised of [true, false]) {
    let cancelled = 0
    const f = fixture(() => new Response(new ReadableStream({
      start(controller) { if (!advertised) controller.enqueue(new Uint8Array(15_000_001)) },
      cancel() { cancelled += 1 },
    }), { status: 207, headers: advertised ? { "Content-Length": "15000001" } : {} }))
    await assert.rejects(f.run(f.read()), /Incomplete CardDAV inventory/)
    assert.equal(f.calls.length, 1)
    assert.equal(cancelled, 1)
  }
})

test("the inventory transport returns malformed 207 XML once for the existing parser to reject", async () => {
  const f = fixture(() => new Response("not XML", { status: 207 }))
  assert.equal(await f.run(f.read()), "not XML")
  assert.equal(f.calls.length, 1)
})
