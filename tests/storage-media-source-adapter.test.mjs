import assert from "node:assert/strict"
import test from "node:test"
import { createHash } from "node:crypto"
import { fcunoConnectionPolicy } from "../config/fcunoConnections.ts"
import { createMetadataIdentityTokenProvider, createStorageMediaSourceAdapter } from "../scripts/lib/storage-media-source-adapter.mjs"

const policy = fcunoConnectionPolicy.storageMediaBackup
const sourceUrl = `${fcunoConnectionPolicy.vercel.productionOrigins[0]}${policy.sourcePath}`
const source = { bucket: policy.sourceBucket, path: "folder/ literal%?#名.mp4", id: "object-1", version: "version-1", sizeBytes: 4 }
const digest = createHash("sha256").update(JSON.stringify(source)).digest("hex")
function context() { return { signal: new AbortController().signal, deadline: Date.now() + 60_000 } }
function setup({ readStatus = 200, readHeaders = {}, bytes = Uint8Array.from([1, 2, 3, 4]), server } = {}) {
  const calls = [], tokens = []
  const adapter = createStorageMediaSourceAdapter({
    getIdentityToken: async ctx => { ctx.signal.throwIfAborted(); tokens.push(ctx); return "google-identity-only" },
    fetch: async (url, init) => {
      calls.push({ url, init })
      if (url === sourceUrl) {
        const input = JSON.parse(init.body)
        if (server) { const value = await server(input); if (value) return value }
        if (input.operation === "inventory") return Response.json({ schema: "fcuno.storage-media-source/v1", items: [{ source, receipt: `${Math.floor(Date.now() / 1000) + 300}.${"a".repeat(43)}` }] })
        if (input.operation === "inspect") return Response.json({ source, etag: '"same"' })
        return new Response(bytes, { status: readStatus, headers: { ETag: '"same"', "X-Fcuno-Storage-Expected-Bytes": "4", "Content-Type": "application/octet-stream",
          "X-Fcuno-Storage-Source-Sha256": digest, "Cache-Control": "private, no-store", ...readHeaders } })
      }
      throw Error("Unexpected non-FCUNO request")
    },
  })
  return { adapter, calls, tokens }
}
async function prepare(options) { const value = setup(options); await value.adapter.inventory(context()); await value.adapter.inspectSource(source, context()); return value }

test("runner source calls use fixed audience URL and Google token, with no provider URL or credential handoff", async () => {
  const { adapter, calls, tokens } = await prepare()
  assert.deepEqual(await adapter.inspectSource(source, context()), source)
  const opened = await adapter.openSource(source, context()), bytes = []
  for await (const chunk of opened.bytes) bytes.push(...chunk)
  assert.deepEqual(bytes, [1, 2, 3, 4]); assert.deepEqual(opened.identity, source); assert.equal(tokens.length, 4)
  for (const call of calls.filter(call => call.url === sourceUrl)) {
    assert.equal(call.init.method, "POST"); assert.equal(call.init.headers.Authorization, "Bearer google-identity-only")
    assert.equal(call.init.redirect, "error"); assert.equal(call.init.cache, "no-store")
  }
  assert.ok(calls.every(call => call.url === sourceUrl))
  const download = calls.at(-1)
  assert.equal(download.init.method, "POST"); assert.equal(download.init.headers["Accept-Encoding"], "identity")
  assert.equal(download.init.headers.Cookie, undefined); assert.equal(download.init.headers.apikey, undefined)
})

test("runner cannot inspect or open a source that was never inventoried", async () => {
  const { adapter, calls } = setup()
  await assert.rejects(adapter.inspectSource(source, context())); await assert.rejects(adapter.openSource(source, context()))
  assert.equal(calls.length, 0)
})

test("runner refuses changed source id/version/size/path before any byte read", async () => {
  for (const change of [{ id: "new-id" }, { version: "new-version" }, { sizeBytes: 5 }, { path: "other" }]) {
    const { adapter, calls } = await prepare({ server: input => input.operation === "read" ? new Response(new Uint8Array([1, 2, 3, 4]), {
      headers: { "X-Fcuno-Storage-Expected-Bytes": "4", ETag: '"same"', "Content-Type": "application/octet-stream", "Cache-Control": "private, no-store",
        "X-Fcuno-Storage-Source-Sha256": createHash("sha256").update(JSON.stringify({ ...source, ...change })).digest("hex") },
    }) : null })
    await assert.rejects(adapter.openSource(source, context())); assert.equal(calls.filter(call => call.url !== sourceUrl).length, 0)
  }
})

test("runner rejects any bearer-URL handoff or JSON substitute for the authenticated byte stream", async () => {
  for (const url of ["https://evil.example", "https://provider.example/signed?token=secret"]) {
    const { adapter, calls } = await prepare({ server: input => input.operation === "read" ? Response.json({ source, etag: '"same"', url, expiresIn: 45 }) : null })
    await assert.rejects(adapter.openSource(source, context())); assert.equal(calls.filter(call => call.url !== sourceUrl).length, 0)
  }
})

test("runner rejects partial, conditional-failed, cached and redirected response statuses", async () => {
  for (const status of [206, 304, 302, 404, 412]) {
    const { adapter } = await prepare({ readStatus: status, bytes: status === 304 ? null : undefined })
    await assert.rejects(adapter.openSource(source, context()))
  }
})

test("runner requires exact strong ETag, identity encoding, full content length and no content range", async () => {
  for (const headers of [{ ETag: '"other"' }, { ETag: 'W/"same"' }, { "X-Fcuno-Storage-Expected-Bytes": "5" }, { "X-Fcuno-Storage-Expected-Bytes": "04" }, { "Content-Length": "4" },
    { "Content-Encoding": "gzip" }, { "Content-Range": "bytes 0-3/4" }]) {
    const { adapter } = await prepare({ readHeaders: headers }); await assert.rejects(adapter.openSource(source, context()))
  }
})

test("runner detects truncated and oversized complete streams", async () => {
  for (const bytes of [Uint8Array.from([1, 2]), Uint8Array.from([1, 2, 3, 4, 5])]) {
    const { adapter } = await prepare({ bytes }), opened = await adapter.openSource(source, context())
    await assert.rejects(async () => { for await (const _ of opened.bytes) { /* consume */ } })
  }
})

test("runner detects a changed opaque ETag across source inspections", async () => {
  let count = 0
  const { adapter } = await prepare({ server: input => input.operation === "inspect" ? Response.json({ source, etag: ++count === 1 ? '"same"' : '"changed"' }) : null })
  await assert.rejects(adapter.inspectSource(source, context()))
})

test("runner rejects duplicate inventory identities and oversized JSON without source reads", async () => {
  for (const response of [Response.json({ schema: "fcuno.storage-media-source/v1", items: [{ source, receipt: "x" }, { source, receipt: "x" }] }),
    new Response("x".repeat(1_000_001))]) {
    const { adapter, calls } = setup({ server: () => response })
    await assert.rejects(adapter.inventory(context())); assert.equal(calls.length, 1)
  }
})

test("aborted or expired runner contexts cannot call metadata or source", async () => {
  const { adapter, calls } = setup(), controller = new AbortController(); controller.abort()
  await assert.rejects(adapter.inventory({ signal: controller.signal, deadline: Date.now() + 60_000 }))
  await assert.rejects(adapter.inventory({ signal: new AbortController().signal, deadline: Date.now() - 1 }))
  assert.equal(calls.length, 0)
})

test("metadata identity requires exact job and rejects permanent credential file fallback", async () => {
  for (const runtime of [{}, { CLOUD_RUN_JOB: "different" }, { CLOUD_RUN_JOB: policy.googleJob, GOOGLE_APPLICATION_CREDENTIALS: "/credentials/key.json" }]) {
    let calls = 0
    const get = createMetadataIdentityTokenProvider({ runtime, fetch: async () => { calls++; throw Error("must not call") } })
    await assert.rejects(get(context())); assert.equal(calls, 0)
  }
})

test("metadata identity accepts only fixed local metadata origin, exact audience, issuer and verified service account", async () => {
  const now = Date.now(), iat = Math.floor(now / 1000)
  const claims = { iss: policy.googleTokenIssuer, aud: sourceUrl, email: policy.googleServiceAccount, email_verified: true, iat, exp: iat + 3600 }
  for (const change of [{}, { aud: "other" }, { iss: "other" }, { email: "other@example.com" }, { email_verified: false }, { exp: iat }, { exp: iat + 3631 }]) {
    const token = `header.${Buffer.from(JSON.stringify({ ...claims, ...change })).toString("base64url")}.signature`
    const get = createMetadataIdentityTokenProvider({ runtime: { CLOUD_RUN_JOB: policy.googleJob }, now: () => now, fetch: async (url, init) => {
      const parsed = new URL(url)
      assert.equal(parsed.origin, "http://metadata.google.internal")
      assert.equal(parsed.searchParams.get("audience"), sourceUrl)
      assert.equal(init.headers["Metadata-Flavor"], "Google"); assert.equal(init.redirect, "error")
      return new Response(token, { headers: { "Metadata-Flavor": "Google" } })
    } })
    if (Object.keys(change).length) await assert.rejects(get(context()))
    else assert.equal(await get(context()), token)
  }
})

test("receipt renewal re-enumerates and compares the exact snapshot before another source operation", async () => {
  let tick = Date.now(), inventories = 0, changed = false, inspections = 0
  const adapter = createStorageMediaSourceAdapter({ now: () => tick, getIdentityToken: async () => "google-test",
    fetch: async (_url, init) => {
      const input = JSON.parse(init.body)
      if (input.operation === "inventory") {
        inventories++
        return Response.json({ schema: "fcuno.storage-media-source/v1", items: [{ source: changed ? { ...source, version: "changed" } : source,
          receipt: `${Math.floor(tick / 1000) + 300}.${"a".repeat(43)}` }] })
      }
      inspections++; return Response.json({ source, etag: '"same"' })
    },
  })
  await adapter.inventory(context()); tick += 241_000
  assert.deepEqual(await adapter.inspectSource(source, context()), source)
  assert.equal(inventories, 2); assert.equal(inspections, 1)
  changed = true; tick += 241_000
  await assert.rejects(adapter.inspectSource(source, context()))
  assert.equal(inventories, 3); assert.equal(inspections, 1)
})

test("closing an opened source before the first byte cancels HTTP even if underlying cancellation never resolves", async () => {
  let cancelled = 0
  const { adapter } = await prepare({ server: input => input.operation === "read" ? new Response(new ReadableStream({
    cancel() { cancelled++; return new Promise(() => {}) },
  }), { headers: { ETag: '"same"', "X-Fcuno-Storage-Expected-Bytes": "4", "Content-Type": "application/octet-stream",
    "X-Fcuno-Storage-Source-Sha256": digest, "Cache-Control": "private, no-store" } }) : null })
  const opened = await adapter.openSource(source, context())
  assert.deepEqual(await opened.bytes.return(), { done: true }); assert.equal(cancelled, 1)
})
