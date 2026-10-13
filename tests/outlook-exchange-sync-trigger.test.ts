import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import test from "node:test"
import vm from "node:vm"
import ts from "typescript"

const source = readFileSync(new URL("../app/api/outlook-addressbook/exchange-sync/route.ts", import.meta.url), "utf8")
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText

type FixtureOptions = {
  permissionError?: "Unauthorized" | "Forbidden"
  statusWriteError?: boolean
  webhook?: () => Promise<Response>
}

function fixture(options: FixtureOptions = {}) {
  const state = {
    owner: null as string | null, webhookCalls: 0, releases: [] as string[], rpcCalls: [] as string[],
    status: null as Record<string, unknown> | null, permissions: [] as string[][],
  }
  const dependencies: Record<string, unknown> = {
    "next/server": { NextResponse: Response },
    "@/lib/adminAuth": { requireAdminPagePermission: async (...permission: string[]) => {
      state.permissions.push(permission)
      if (options.permissionError) throw new Error(options.permissionError)
      return { username: "synthetic-admin", displayName: "Synthetic Admin" }
    } },
    "@supabase/supabase-js": { createClient: (url: string, key: string) => {
      assert.equal(url, "https://database-fixture.invalid")
      assert.equal(key, "synthetic-service-key")
      return {
        async rpc(name: string, args?: { p_run_id: string }) {
          state.rpcCalls.push(name)
          if (name === "acquire_outlook_exchange_sync_lock") {
            if (state.owner && state.owner !== args!.p_run_id) return { data: false, error: null }
            state.owner = args!.p_run_id
            return { data: true, error: null }
          }
          if (name === "release_outlook_exchange_sync_lock") {
            state.releases.push(args!.p_run_id)
            if (state.owner === args!.p_run_id) state.owner = null
            return { data: true, error: null }
          }
          if (name === "get_active_outlook_exchange_sync_lock") return { data: state.owner ? [{
            run_id: state.owner, sync_mode: "incremental", heartbeat_at: "2026-10-12T12:00:00Z", expires_at: "2026-10-12T12:30:00Z",
          }] : [], error: null }
          throw new Error(`Unexpected RPC: ${name}`)
        },
        from(table: string) {
          assert.equal(table, "office_calendar_store")
          const query = {
            select() { return query },
            eq(field: string, value: string) { assert.equal(field, "key"); assert.equal(value, "outlook-addressbook-exchange-sync"); return query },
            async maybeSingle() { return { data: state.status ? { payload: state.status } : null, error: null } },
            async upsert(row: { key: string; payload: Record<string, unknown> }) {
              assert.equal(row.key, "outlook-addressbook-exchange-sync")
              if (options.statusWriteError) return { error: new Error("Synthetic pre-dispatch store failure") }
              state.status = structuredClone(row.payload)
              return { error: null }
            },
          }
          return query
        },
      }
    } },
  }
  const exports: { POST?: () => Promise<Response>; GET?: () => Promise<Response> } = {}
  vm.runInNewContext(output, {
    exports, Error, Date, AbortSignal, crypto: { randomUUID },
    process: { env: { NEXT_PUBLIC_SUPABASE_URL: "https://database-fixture.invalid", SUPABASE_SERVICE_ROLE_KEY: "synthetic-service-key", EXCHANGE_SYNC_WEBHOOK_URL: "https://azure-webhook-fixture.invalid/synthetic" } },
    require(name: string) { assert.ok(name in dependencies, `Unexpected dependency ${name}`); return dependencies[name] },
    console: { error() {} },
    fetch: async (target: string, init: RequestInit) => {
      assert.equal(target, "https://azure-webhook-fixture.invalid/synthetic", "No external network is permitted")
      assert.equal(init.method, "POST")
      assert.ok(init.signal instanceof AbortSignal, "webhook dispatch/readback must have a bounded timeout")
      const body = JSON.parse(String(init.body))
      assert.equal(body.reservationId, state.owner)
      assert.ok(state.owner, "reservation must exist before dispatch")
      state.webhookCalls += 1
      return options.webhook ? options.webhook() : new Response('{"JobIds":["synthetic-job"]}', { status: 202 })
    },
  })
  return { state, post: () => exports.POST!(), get: () => exports.GET!() }
}

test("a lost accepted webhook reply cannot revoke the worker lease or permit duplicate dispatch", async () => {
  const f = fixture({ webhook: async () => { throw new Error("Synthetic reply lost after Azure accepted the job") } })
  const first = await f.post()
  assert.equal(first.status, 202)
  assert.equal((await first.json()).status, "queued")
  assert.ok(f.state.owner)
  assert.deepEqual(f.state.releases, [])
  const second = await f.post()
  assert.equal(second.status, 202)
  assert.equal((await second.json()).status, "running")
  assert.equal(f.state.webhookCalls, 1)
})

test("an aborted dispatch timeout keeps the reservation until its outcome is resolved", async () => {
  const f = fixture({ webhook: async () => { throw new DOMException("Synthetic Azure dispatch timeout", "TimeoutError") } })
  const first = await f.post()
  assert.equal(first.status, 202)
  assert.equal((await first.json()).status, "queued")
  assert.ok(f.state.owner)
  assert.deepEqual(f.state.releases, [])
  assert.equal((await f.post()).status, 202)
  assert.equal(f.state.webhookCalls, 1, "a timeout must not enable a second overlapping Azure job")
})

test("accepted dispatch and ambiguous 5xx preserve one reservation; definitive rejection releases it", async () => {
  for (const status of [202, 408, 429, 500, 503, 400, 401, 403, 404, 405, 410]) {
    const f = fixture({ webhook: async () => new Response("Synthetic response", { status }) })
    const response = await f.post()
    const definitiveRejection = [400, 401, 403, 404, 405, 410].includes(status)
    assert.equal(response.status, definitiveRejection ? 502 : status === 202 ? 200 : 202, `HTTP ${status}`)
    assert.equal(Boolean(f.state.owner), !definitiveRejection, `HTTP ${status}`)
    assert.equal(f.state.releases.length, definitiveRejection ? 1 : 0, `HTTP ${status}`)
  }
})

test("a lost accepted response body preserves the reservation and the worker's newer status", async () => {
  const f = fixture({ webhook: async () => {
    f.state.status = { status: "running", message: "Synthetic Azure worker started" }
    return new Response(new ReadableStream({ start(controller) { controller.error(new Error("Synthetic response body lost")) } }), { status: 202 })
  } })
  const response = await f.post()
  assert.equal(response.status, 202)
  assert.ok(f.state.owner)
  assert.deepEqual(f.state.releases, [])
  assert.equal(f.state.status?.status, "running", "late trigger handling must not overwrite the active worker's status")
})

test("a failure before dispatch releases the reservation and never contacts Azure", async () => {
  const f = fixture({ statusWriteError: true })
  assert.equal((await f.post()).status, 500)
  assert.equal(f.state.owner, null)
  assert.equal(f.state.releases.length, 1)
  assert.equal(f.state.webhookCalls, 0)
})

test("view-only and unsigned users cannot dispatch or reserve any job", async () => {
  for (const [permissionError, status] of [["Unauthorized", 401], ["Forbidden", 403]] as const) {
    const f = fixture({ permissionError })
    assert.equal((await f.post()).status, status)
    assert.deepEqual(f.state.permissions, [["outlook-addressbook", "edit"]])
    assert.deepEqual(f.state.rpcCalls, [])
    assert.equal(f.state.webhookCalls, 0)
  }
})

test("sync status and trigger outcomes are private and never cached", async () => {
  const f = fixture()
  for (const response of [await f.get(), await f.post()]) assert.match(response.headers.get("cache-control") || "", /private.*no-store/)
})
