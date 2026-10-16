import assert from "node:assert/strict"
import test from "node:test"
import { browserSessionOwnerKey, createBrowserSessionStore, parseBrowserSessionPayload } from "../lib/clientSessionStore"
import { clearAdminClientCache, fetchAdminClientJson, readAdminClientCache } from "../lib/adminClientCache"

const alice = { authenticated: true, actorKey: "a".repeat(64), username: "ALICE", role: "BT", permissions: { ccinfo: "edit" }, pages: [] }
const bob = { ...alice, actorKey: "b".repeat(64), username: "BOB" }
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }

test("session decoder preserves selected non-secret identity, literal flags and strict access metadata", () => {
  const parsed = parseBrowserSessionPayload({ ...alice, password: "NEVER-PERSIST", accessToken: "NEVER-PERSIST", resetRequired: "false" })
  assert.equal(parsed.actorKey, alice.actorKey)
  assert.equal(parsed.resetRequired, false)
  assert.equal(JSON.stringify(parsed).includes("NEVER-PERSIST"), false)
  assert.equal(parseBrowserSessionPayload({ ...bob, authenticated: false }).username, null)
  for (const value of [null, [], {}, { ...alice, authenticated: "true" }, { ...alice, username: "" }, { ...alice, role: null }, { ...alice, actorKey: "not-an-id" }, { ...alice, permissions: [] }, { ...alice, permissions: { ccinfo: ["edit"] } }, { ...alice, pages: [{}] }]) assert.throws(() => parseBrowserSessionPayload(value))
})

test("owner keys ignore permission ordering/display wording but change for immutable identity, access and reset changes", () => {
  const first = parseBrowserSessionPayload({ ...alice, permissions: { ccinfo: "edit", phonebook: "view" } })
  assert.equal(browserSessionOwnerKey(first), browserSessionOwnerKey({ ...first, displayName: "New display wording", permissions: { phonebook: "view", ccinfo: "edit" } }))
  for (const next of [{ ...first, actorKey: bob.actorKey }, { ...first, username: "BOB" }, { ...first, permissions: { ccinfo: "view" as const } }, { ...first, resetRequired: true }, { ...first, authenticated: false }]) assert.notEqual(browserSessionOwnerKey(first), browserSessionOwnerKey(next))
})

test("one shared session request is deduplicated and retired promises cannot publish or evict a replacement", async () => {
  const original = globalThis.fetch
  try {
    const held = deferred<Response>(); let calls = 0
    globalThis.fetch = async () => { calls += 1; return held.promise }
    const store = createBrowserSessionStore("/api/admin/session", 5000)
    const first = store.load(), same = store.load()
    assert.equal(first, same); assert.equal(calls, 1)
    const rejected = assert.rejects(first, /replaced/)
    store.prime(bob)
    held.resolve(Response.json(alice)); await rejected
    assert.equal(store.current()?.username, "BOB")
    assert.equal((await store.load()).username, "BOB")
  } finally { globalThis.fetch = original }
})

test("an obsolete rejected session request leaves the newer primed session intact", async () => {
  const original = globalThis.fetch
  try {
    const held = deferred<Response>()
    globalThis.fetch = async () => held.promise
    const store = createBrowserSessionStore("/api/spc/session", 30000)
    const pending = store.load(); const rejected = assert.rejects(pending, /old request/)
    store.prime(bob); held.reject(new Error("old request")); await rejected
    assert.equal(store.current()?.username, "BOB")
  } finally { globalThis.fetch = original }
})

test("session HTTP401/403 are authoritative sign-outs even with HTML; failed refresh retains verified data", async () => {
  const original = globalThis.fetch
  try {
    const store = createBrowserSessionStore("/api/admin/session", 5000)
    store.prime(alice)
    globalThis.fetch = async () => new Response("temporarily unavailable", { status: 503 })
    await assert.rejects(store.load(0), /Unable to verify/)
    assert.equal(store.current()?.username, "ALICE")
    for (const status of [401, 403]) {
      store.prime(alice); globalThis.fetch = async () => new Response("<html>signed out</html>", { status })
      assert.equal((await store.load(0)).authenticated, false)
    }
  } finally { globalThis.fetch = original }
})

test("session deadline covers ignored fetch abort and held JSON; late results cannot fill the store", async () => {
  const originalFetch = globalThis.fetch, originalTimer = globalThis.setTimeout
  try {
    globalThis.setTimeout = ((callback: TimerHandler, delay?: number, ...args: unknown[]) => originalTimer(callback, delay === 30000 ? 1 : delay, ...args)) as typeof setTimeout
    for (const phase of ["fetch", "body"]) {
      const held = deferred<unknown>(); let signal: AbortSignal | undefined
      globalThis.fetch = async (_url, init) => {
        signal = init?.signal || undefined
        if (phase === "fetch") { await held.promise; return Response.json(alice) }
        return { ok: true, status: 200, json: () => held.promise } as Response
      }
      const store = createBrowserSessionStore("/api/admin/session", 5000)
      await assert.rejects(store.load(), /timed out/); assert.equal(signal?.aborted, true)
      held.resolve(alice); await new Promise(resolve => originalTimer(resolve, 0))
      assert.equal(store.current(), null)
    }
  } finally { globalThis.fetch = originalFetch; globalThis.setTimeout = originalTimer }
})

test("cleared shared application cache rejects late responses and preserves newer entries", async () => {
  const original = globalThis.fetch
  clearAdminClientCache()
  try {
    const old = deferred<Response>()
    globalThis.fetch = async () => old.promise
    const pending = fetchAdminClientJson("synthetic-index", "/synthetic")
    const rejected = assert.rejects(pending, /replaced/)
    clearAdminClientCache()
    globalThis.fetch = async () => Response.json({ owner: "BOB" })
    assert.deepEqual(await fetchAdminClientJson("synthetic-index", "/synthetic"), { owner: "BOB" })
    old.resolve(Response.json({ owner: "ALICE" })); await rejected
    assert.deepEqual(readAdminClientCache("synthetic-index"), { owner: "BOB" })
  } finally { globalThis.fetch = original; clearAdminClientCache() }
})

test("old shared-cache failures cannot delete a replacement and cache deadlines bound held bodies", async () => {
  const originalFetch = globalThis.fetch, originalTimer = globalThis.setTimeout
  clearAdminClientCache()
  try {
    const old = deferred<Response>(); globalThis.fetch = async () => old.promise
    const pending = fetchAdminClientJson("synthetic-index", "/synthetic"); const rejected = assert.rejects(pending, /old failure/)
    clearAdminClientCache("synthetic-index")
    globalThis.fetch = async () => Response.json({ owner: "BOB" })
    await fetchAdminClientJson("synthetic-index", "/synthetic")
    old.reject(new Error("old failure")); await rejected
    assert.deepEqual(readAdminClientCache("synthetic-index"), { owner: "BOB" })
    globalThis.setTimeout = ((callback: TimerHandler, delay?: number, ...args: unknown[]) => originalTimer(callback, delay === 30000 ? 1 : delay, ...args)) as typeof setTimeout
    const body = deferred<unknown>()
    globalThis.fetch = async () => ({ ok: true, status: 200, json: () => body.promise }) as Response
    await assert.rejects(fetchAdminClientJson("synthetic-held", "/synthetic"), /timed out/)
    body.resolve({ owner: "LATE" }); await new Promise(resolve => originalTimer(resolve, 0))
    assert.equal(readAdminClientCache("synthetic-held"), null)
  } finally { globalThis.fetch = originalFetch; globalThis.setTimeout = originalTimer; clearAdminClientCache() }
})
