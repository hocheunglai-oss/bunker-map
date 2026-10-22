import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import vm from "node:vm"
import ts from "typescript"

const source = readFileSync(new URL("../app/api/outlook-addin/taskpane/route.ts", import.meta.url), "utf8")
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText
const htmlTemplate = source.match(/const html = `([\s\S]*?)`\n\n  return new NextResponse\(html,/)
assert.ok(htmlTemplate)
const html = Function(`return \`${htmlTemplate[1].replace(/\$\{JSON\.stringify\([^)]+\)\}/g, '"https://fcuno.test/api"')}\`;`)() as string
const script = html.match(/<script>\s*([\s\S]*?)\s*<\/script>/)![1]
function block(start: string, end: string) {
  const a = script.indexOf(start), b = script.indexOf(end, a)
  assert.ok(a >= 0 && b > a, `${start} actual script block exists`)
  return script.slice(a, b)
}
const authSource = block("function currentAuthSession()", "function closeAuthDialog()")
const auditSource = block("function waitForRetry(delayMs)", "function certifiedRecipientAddress(recipient)")
const composeSource = block("function currentComposeItem()", "function registerMailboxItemChangedHandler()")
const officeSource = block("function officeAsync(call)", "function clearRecipientMap(")
const insertSource = block("async function insertSelectedTemplate()", "async function loadTemplates()")
const mapSource = block("function clearRecipientMap(", "function addParsedRecipient(")
const detailSource = block("function validApiPayloadTime(", "function createOperationId()")
const normaliseSource = block("function normaliseTemplate(", "function stripOuterQuotes(")
const timeoutConstants = script.match(/var INSERTION_AUDIT_[A-Z_]+ = \d+;/g)?.join("\n") ?? ""

const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve() }
class Clock {
  now = 1_800_000_000_000
  next = 0
  timers = new Map<number, { at: number; callback: () => void }>()
  setTimeout = (callback: () => void, delay = 0) => {
    const id = ++this.next
    this.timers.set(id, { at: this.now + delay, callback })
    return id
  }
  clearTimeout = (id: number) => { this.timers.delete(id) }
  async advance(ms: number) {
    const until = this.now + ms
    await flush()
    for (let guard = 0; guard < 1000; guard++) {
      const next = [...this.timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0]
      if (!next) { this.now = until; await flush(); return }
      this.now = next[1].at; this.timers.delete(next[0]); next[1].callback(); await flush()
    }
    throw new Error("Synthetic timer loop exceeded its bound")
  }
  date() {
    const now = () => this.now
    return class extends Date { static now() { return now() } }
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function ack(phase: string) { return new Response(null, { status: 204, headers: { "X-Outlook-Insertion-Audit-Phase": phase } }) }
type FetchCall = { payload: { phase: string; operationId: string }; signal?: AbortSignal; at: number }

function clientFixture(transport: (call: FetchCall, index: number) => Promise<unknown>, compose = false, realDependencies = false, pendingMapResponse?: Promise<unknown>) {
  const clock = new Clock(), calls: FetchCall[] = [], writes: string[] = [], notices: { message: string; at: number }[] = []
  const dependencyCalls = { detail: 0, map: 0, detailRefresh: [] as boolean[] }
  const cachedTemplate = { id: "synthetic-template", revision: 3, updatedAt: "2026-10-20T00:00:00Z", subject: "Old subject", bodyHtml: "<p>Old body</p>" }
  const latestTemplate = { ...cachedTemplate, revision: 7, updatedAt: "2026-10-22T00:00:00Z", subject: "Synthetic subject", bodyHtml: "<p>Synthetic body</p>", bodyText: "Synthetic body" }
  const state = {
    selectedId: "synthetic-template", inserting: false, authenticated: true, authGeneration: 1, authMode: "bearer",
    authSession: { token: "synthetic-token", expiresAt: clock.now + 600000 }, itemGeneration: 1,
    recipientMapFromNetwork: true, recipientMapExpiresAt: clock.now + 600000,
    recipientCertification: { runId: "22222222-2222-4222-8222-222222222222", sourceFingerprint: "a".repeat(64) },
    recipientMapGeneration: 0, recipientMapLoaded: true, recipientMapPromise: null,
    recipientsBySourceKey: {}, detailCache: { "synthetic-template:3:2026-10-20T00:00:00Z": cachedTemplate, "unrelated:1:old": { id: "unrelated", revision: 1 } } as Record<string, { id: string; revision: number }>,
    detailPromises: {}, templates: [cachedTemplate],
  }
  const mapPayload = () => ({
    schema: "fcuno.outlook-certified-recipient-map/v2", recipientsBySourceKey: {},
    certification: { ...state.recipientCertification, runId: "33333333-3333-4333-8333-333333333333", sourceFingerprint: "a".repeat(64), projectionSnapshotSha256: "a".repeat(64), certifiedAt: new Date(clock.now).toISOString(), maxAgeSeconds: 3600 },
    counts: { contacts: 0, groups: 0, mappedSourceIds: 0 }, generatedAt: new Date(clock.now).toISOString(), expiresAt: new Date(clock.now + 120000).toISOString(), ttlSeconds: 120,
  })
  const item = {
    itemId: "synthetic-compose",
    subject: { setAsync(_value: string, done: (r: unknown) => void) { writes.push("subject"); done({ status: "succeeded" }) } },
    body: { setAsync(_value: string, _options: unknown, done: (r: unknown) => void) { writes.push("body"); done({ status: "succeeded" }) } },
    to: {}, cc: {}, bcc: {},
  }
  const office = { AsyncResultStatus: { Succeeded: "succeeded" }, context: { mailbox: { item: compose ? item : null } } }
  const context = {
    state, window: { Office: office, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout },
    Date: clock.date(), Promise, Error, AbortController, Number, Object, JSON, Math,
    INSERTION_AUDIT_URL: "https://fcuno.test/api",
    TEMPLATE_DETAIL_URL: "https://fcuno.test/detail", RECIPIENT_MAP_URL: "https://fcuno.test/map",
    RECIPIENT_MAP_CACHE_KEY: "synthetic-recipient-map", RECIPIENT_CACHE_SCHEMA: "synthetic-map-cache", INDEX_CACHE_TTL_MS: 120000,
    fetch: async (url: string, init: RequestInit) => {
      if (realDependencies && url === "https://fcuno.test/detail?id=synthetic-template") {
        dependencyCalls.detail++
        return new Response(JSON.stringify({ schema: "fcuno.outlook-template-detail/v2", template: latestTemplate, generatedAt: new Date(clock.now).toISOString(), expiresAt: new Date(clock.now + 120000).toISOString(), ttlSeconds: 120 }))
      }
      if (realDependencies && url === "https://fcuno.test/map") {
        dependencyCalls.map++
        return pendingMapResponse ?? new Response(JSON.stringify(mapPayload()))
      }
      assert.equal(url, "https://fcuno.test/api", "No real network permitted")
      const call = { payload: JSON.parse(String(init.body)), signal: init.signal ?? undefined, at: clock.now }
      calls.push(call); return transport(call, calls.length - 1)
    },
    clearAuthentication() { state.authenticated = false; state.authGeneration++ },
    notice(message: string) { notices.push({ message, at: clock.now }) },
    loadTemplateDetail: async (_id: string, forceRefresh: boolean) => { dependencyCalls.detailRefresh.push(forceRefresh); return forceRefresh ? latestTemplate : cachedTemplate },
    loadRecipientMap: async () => ({}), resolveStoredRecipientRefs: () => [],
    createOperationId: () => "11111111-1111-4111-8111-111111111111",
    snapshotDraft: async () => ({ subject: "", to: [], cc: [], bcc: [], body: "", bodyOptions: {}, isHtml: true }),
    draftContainsUserContent: () => false, copyDraftSnapshot: (value: unknown) => structuredClone(value),
    setRecipients: async () => { writes.push("recipients") },
    restoreDraftIfUnchanged: async () => { writes.push("restore"); return true },
    buildNewMessageForm: () => ({}), openSupportedNewMessageForm: async () => { writes.push("display") },
  }
  const functions = vm.runInNewContext(`${timeoutConstants}\n${authSource}\n${mapSource}\n${realDependencies ? normaliseSource + detailSource : ""}\n${auditSource}\n${composeSource}\n${officeSource}\n${insertSource}\n({ run: insertSelectedTemplate, loadRecipientMap, clearRecipientMap })`, context) as { run: () => Promise<void>; loadRecipientMap: (required: boolean) => Promise<unknown>; clearRecipientMap: () => void }
  if (!realDependencies) context.loadRecipientMap = async () => ({})
  return { clock, calls, writes, notices, state, office, ...functions, dependencyCalls, mapPayload }
}

test("actual insertion never writes Outlook when reservation fetch never returns; one operation stays within35s", async () => {
  const f = clientFixture(() => new Promise(() => {}), true)
  let settled = false; void f.run().then(() => { settled = true })
  await f.clock.advance(40000)
  assert.equal(settled, true, "A hung reservation must leave its busy state within the finite budget")
  assert.equal(f.state.inserting, false); assert.deepEqual(f.writes, [])
  assert.equal(f.calls.length, 3)
  assert.equal(new Set(f.calls.map(call => call.payload.operationId)).size, 1)
  assert.ok(f.calls.every(call => call.signal?.aborted))
  assert.match(f.notices.at(-1)!.message, /No Outlook fields were changed/)
  assert.equal(f.clock.timers.size, 0)
})

test("the same finite attempt budget includes a never-completing error response body", async () => {
  const f = clientFixture(async () => ({ ok: false, status: 503, json: () => new Promise(() => {}) }))
  let settled = false; void f.run().then(() => { settled = true })
  await f.clock.advance(40000)
  assert.equal(settled, true, "A response body must not bypass the insertion deadline")
  assert.deepEqual(f.writes, []); assert.equal(f.calls.length, 3)
  assert.ok(f.calls.every(call => call.signal?.aborted)); assert.equal(f.clock.timers.size, 0)
})

test("late successful reservation acknowledgement after timeout cannot unlock Outlook mutations", async () => {
  const late = deferred<Response>()
  const f = clientFixture((_call, index) => index === 0 ? late.promise : new Promise(() => {}), true)
  void f.run(); await f.clock.advance(16000)
  late.resolve(ack("reserved")); await flush(); assert.deepEqual(f.writes, [])
  await f.clock.advance(24000); assert.equal(f.state.inserting, false); assert.deepEqual(f.writes, [])
})

test("late401 after sign-in replacement cannot clear the new authentication or write Outlook", async () => {
  const late = deferred<Response>()
  const f = clientFixture(() => late.promise, true)
  void f.run(); await f.clock.advance(16000)
  f.state.authGeneration++; f.state.authSession.token = "replacement-token"
  late.resolve(new Response(null, { status: 401 })); await f.clock.advance(24000)
  assert.equal(f.state.authenticated, true); assert.equal(f.state.authSession.token, "replacement-token")
  assert.deepEqual(f.writes, []); assert.equal(f.state.inserting, false)
})

test("retry budget is shared across attempts and never mints a new insertion operation", async () => {
  const f = clientFixture(() => new Promise(resolve => { f.clock.setTimeout(() => resolve(new Response("{}", { status: 503 })), 14000) }))
  let settled = false; void f.run().then(() => { settled = true })
  await f.clock.advance(35000)
  assert.equal(settled, true); assert.equal(f.calls.length, 3)
  assert.equal(new Set(f.calls.map(call => call.payload.operationId)).size, 1)
  assert.deepEqual(f.writes, [])
})

test("terminal audit timeout preserves the inserted message and says not to insert again", async () => {
  const f = clientFixture(async call => call.payload.phase === "reserved" ? ack("reserved") : new Promise(() => {}))
  let settled = false; void f.run().then(() => { settled = true }); await f.clock.advance(40000)
  assert.equal(settled, true); assert.deepEqual(f.writes, ["display"])
  assert.match(f.notices.at(-1)!.message, /template was inserted.*do not insert this template again/)
  assert.equal(f.calls.filter(call => call.payload.phase === "reserved").length, 1)
  assert.equal(new Set(f.calls.map(call => call.payload.operationId)).size, 1)
  assert.equal(f.state.inserting, false)
})

test("compose selection still fences an otherwise valid late reservation", async () => {
  const pending = deferred<Response>()
  const f = clientFixture(call => call.payload.phase === "reserved" ? pending.promise : Promise.resolve(ack("terminal")), true)
  void f.run(); await flush(); f.state.itemGeneration++; pending.resolve(ack("reserved")); await flush()
  assert.deepEqual(f.writes, []); assert.equal(f.state.inserting, false)
  assert.match(f.notices.at(-1)!.message, /selected Outlook message changed/)
})

test("valid exact reservation and terminal acknowledgements still complete one insertion and clear timers", async () => {
  const f = clientFixture(async call => ack(call.payload.phase))
  await f.run(); assert.deepEqual(f.writes, ["display"])
  assert.equal(f.calls.length, 2); assert.equal(f.state.inserting, false)
  assert.match(f.notices.at(-1)!.message, /Audit completed/); assert.equal(f.clock.timers.size, 0)
})

function serverFixture(rpcResult: Promise<{ error: null | { code: string; message: string } }>) {
  const clock = new Clock(), signals: AbortSignal[] = [], requests: string[] = []
  const exports: { POST?: (request: Request) => Promise<Response> } = {}
  vm.runInNewContext(output, {
    exports, Error, Date: clock.date(), AbortController, AbortSignal, Promise, URL,
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    process: { env: { NEXT_PUBLIC_SUPABASE_URL: "https://database-fixture.invalid", SUPABASE_SERVICE_ROLE_KEY: "synthetic-service-key" } },
    require(name: string) {
      if (name === "next/server") return { NextResponse: Response }
      if (name === "@/lib/adminAuth") return { requireOutlookAddinPagePermissionForRequest: async () => ({ username: "synthetic-admin", displayName: "Synthetic Admin" }) }
      if (name === "@supabase/supabase-js") return { createClient(url: string, key: string) {
        assert.equal(url, "https://database-fixture.invalid"); assert.equal(key, "synthetic-service-key")
        return { rpc(rpc: string) {
          requests.push(rpc)
          const query = { abortSignal(signal: AbortSignal) { signals.push(signal); return query }, then: rpcResult.then.bind(rpcResult) }
          return query
        } }
      } }
      throw new Error(`Unexpected dependency: ${name}`)
    },
  })
  const controller = new AbortController()
  const request = {
    url: "https://fcuno.test/api/outlook-addin/taskpane", headers: new Headers({ origin: "https://fcuno.test" }), signal: controller.signal,
    json: async () => ({ phase: "reserved", operationId: "11111111-1111-4111-8111-111111111111", templateId: "synthetic-template", templateRevision: 7, certificationRunId: "22222222-2222-4222-8222-222222222222", sourceFingerprint: "a".repeat(64) }),
  } as unknown as Request
  return { clock, signals, requests, controller, post: () => exports.POST!(request) }
}

test("actual POST bounds never-finishing RPC, propagates cancellation, and never acknowledges a late success", async () => {
  const late = deferred<{ error: null }>(), f = serverFixture(late.promise)
  let response: Response | undefined; void f.post().then(value => { response = value })
  await f.clock.advance(12000)
  assert.equal(response?.status, 503, "A stalled RPC must yield a finite non-acknowledgement")
  assert.equal(f.signals.length, 1); assert.equal(f.signals[0].aborted, true)
  assert.equal(response!.headers.get("X-Outlook-Insertion-Audit-Phase"), null)
  assert.match(response!.headers.get("cache-control")!, /private.*no-store/)
  late.resolve({ error: null }); await flush(); assert.equal(response!.status, 503)
  assert.equal(f.requests.length, 1); assert.equal(f.clock.timers.size, 0)
})

test("actual POST request cancellation promptly aborts the RPC without exposing raw errors", async () => {
  const f = serverFixture(new Promise(() => {}))
  let response: Response | undefined; void f.post().then(value => { response = value }); await flush()
  f.controller.abort(); await flush()
  assert.equal(response?.status, 503); assert.equal(f.signals[0].aborted, true)
  assert.equal(f.clock.timers.size, 0); assert.equal((await response!.json()).message, "Template insertion audit could not be recorded.")
})

test("actual POST successful reservation retains its exact204 phase acknowledgement", async () => {
  const f = serverFixture(Promise.resolve({ error: null }))
  const response = await f.post()
  assert.equal(response.status, 204); assert.equal(response.headers.get("X-Outlook-Insertion-Audit-Phase"), "reserved")
  assert.equal(f.signals.length, 1); assert.equal(f.clock.timers.size, 0)
})

test("an already cancelled POST cannot start a database reservation", async () => {
  const f = serverFixture(Promise.resolve({ error: null }))
  f.controller.abort()
  const response = await f.post()
  assert.equal(response.status, 503); assert.equal(f.requests.length, 0)
  assert.equal(f.signals.length, 0); assert.equal(f.clock.timers.size, 0)
})

test("actual POST maps a P0001 changed-template business error to one non-retryable409", async () => {
  const f = serverFixture(Promise.resolve({ error: { code: "P0001", message: "OUTLOOK_INSERTION_TEMPLATE_CHANGED" } }))
  const response = await f.post()
  assert.equal(response.status, 409); assert.equal((await response.json()).code, "TEMPLATE_REVISION_CHANGED")
  assert.equal(f.requests.length, 1); assert.equal(f.clock.timers.size, 0)
  assert.equal(response.headers.get("X-Outlook-Insertion-Audit-Phase"), null)
})

for (const code of ["TEMPLATE_REVISION_CHANGED", "INSERT_CERTIFICATION_CHANGED"]) {
  test(`actual client ${code} stops without writes, invalidates only relevant dependencies, and recovers on a fresh explicit click`, async () => {
    let rejectFirst = true
    const f = clientFixture(async call => {
      if (rejectFirst) {
        rejectFirst = false
        return new Response(JSON.stringify({ code, message: "This template changed. Select it again." }), { status: 409 })
      }
      return ack(call.payload.phase)
    }, false, true)
    await f.run()
    assert.equal(f.calls.length, 1, "A changed dependency must not be retried automatically")
    assert.deepEqual(f.writes, []); assert.equal(f.state.inserting, false)
    assert.equal(f.state.recipientMapLoaded, false); assert.equal(f.state.recipientCertification, null)
    assert.equal(Object.values(f.state.detailCache).filter(template => template.id === "synthetic-template").length, 0)
    assert.equal(f.state.detailCache["unrelated:1:old"].id, "unrelated")
    assert.match(f.notices.at(-1)!.message, /Select it again.*No Outlook fields were changed/)
    assert.equal(f.dependencyCalls.detail, 1); assert.equal(f.dependencyCalls.map, 0)
    await f.run()
    assert.equal(f.dependencyCalls.detail, 2, "The next explicit click must reload the template despite the old index")
    assert.equal(f.dependencyCalls.map, 1, "The next explicit click must obtain a fresh certified map")
    assert.equal(f.calls.length, 3); assert.deepEqual(f.writes, ["display"])
    assert.equal(f.calls[0].payload.phase, "reserved"); assert.equal(f.clock.timers.size, 0)
  })
}

test("explicit insertion loads the latest actual detail rather than the old index cache", async () => {
  const f = clientFixture(async call => ack(call.payload.phase), false, true)
  await f.run()
  assert.equal(f.dependencyCalls.detail, 1)
  assert.equal((f.calls[0].payload as FetchCall["payload"] & { templateRevision: number }).templateRevision, 7)
  assert.deepEqual(f.writes, ["display"])
})

test("a map response already in flight cannot restore certification after its cache was invalidated", async () => {
  const pending = deferred<Response>()
  const f = clientFixture(async call => ack(call.payload.phase), false, true, pending.promise)
  f.clearRecipientMap()
  const result = f.loadRecipientMap(true).then(() => null, error => error as Error)
  await flush(); assert.equal(f.dependencyCalls.map, 1)
  f.clearRecipientMap()
  pending.resolve(new Response(JSON.stringify(f.mapPayload())))
  const error = await result
  assert.match(error?.message ?? "", /map changed/)
  assert.equal(f.state.recipientMapLoaded, false); assert.equal(f.state.recipientCertification, null)
  assert.equal(f.state.recipientMapPromise, null); assert.equal(Object.keys(f.state.recipientsBySourceKey).length, 0)
})
