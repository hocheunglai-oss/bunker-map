import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { transformSync } from "esbuild"
import * as ccinfoSave from "../lib/ccinfoSave"

const id = "11111111-1111-4111-8111-111111111111"
const before = "2026-10-12T00:00:00.123456Z"
const after = "2026-10-12T00:00:00.123457Z"

function fixture(options: { permission?: string; error?: { code?: string; message?: string }; data?: unknown; throws?: boolean; serviceKey?: boolean } = {}) {
  const calls: unknown[] = []
  const modules: Record<string, unknown> = {
    "next/server": { NextResponse: Object.assign(Response, { json: Response.json }) },
    "@/lib/ccinfoSave": ccinfoSave,
    "@/lib/adminAuth": { requireAdminPagePermission: async (...permission: string[]) => {
      calls.push(permission)
      if (options.permission === "anonymous") throw Error("Unauthorized")
      if (options.permission === "view") throw Error("Forbidden")
      return { username: "TRUSTED EDITOR", displayName: "Trusted Editor", role: "STAFF" }
    } },
    "@/lib/adminAudit": {
      createAdminAuditContext: (session: unknown, request: unknown, page: string) => { calls.push({ session, request, page }); return { username: "TRUSTED EDITOR", pageId: page } },
      createAdminAuditedSupabaseClient: (context: unknown, clientOptions: unknown) => {
        calls.push({ context, clientOptions })
        return { rpc: async (rpc: string, args: unknown) => {
          calls.push({ rpc, args })
          if (options.throws) throw Error("synthetic secret database error")
          return { error: options.error || null, data: Object.hasOwn(options, "data") ? options.data : { id, name: "CÔTE D'IVOIRE", updated_at: after } }
        } }
      },
    },
  }
  const loadedModule: { exports: { POST?: (request: Request) => Promise<Response> } } = { exports: {} }
  const code = transformSync(readFileSync(new URL("../app/api/ccinfo/rename-country/route.ts", import.meta.url), "utf8"), { loader: "ts", format: "cjs", target: "node24" }).code
  new Function("require", "module", "exports", "process", code)((name: string) => { assert.ok(Object.hasOwn(modules, name), name); return modules[name] }, loadedModule, loadedModule.exports, { env: { ...(options.serviceKey === false ? {} : { SUPABASE_SERVICE_ROLE_KEY: "synthetic-only-key" }) } })
  return { calls, async request(body: unknown = { id, name: " côte d'ivoire ", expectedUpdatedAt: before }) {
    return loadedModule.exports.POST!(new Request("https://synthetic.invalid/api/ccinfo/rename-country", { method: "POST", headers: { "content-type": "application/json", "referer": "https://evil.invalid/admin/user-management", "x-bunker-admin-user": "FORGED ACTOR", "x-bunker-audit-action": "FORGED ACTION" }, body: typeof body === "string" ? body : JSON.stringify(body) }))
  } }
}

test("rename route checks CCINFO edit permission before client creation and denies anonymous/view users", async () => {
  for (const [permission, status] of [["anonymous", 401], ["view", 403]] as const) {
    const app = fixture({ permission })
    const response = await app.request()
    assert.equal(response.status, status)
    assert.equal(response.headers.get("cache-control"), "private, no-store")
    assert.deepEqual(app.calls, [["ccinfo", "edit"]])
  }
})

test("rename route preserves raw microseconds and uses trusted canonical context, narrow RPC arguments and service role", async () => {
  const app = fixture()
  const response = await app.request()
  assert.equal(response.status, 200)
  assert.equal(response.headers.get("cache-control"), "private, no-store")
  assert.deepEqual(await response.json(), { record: { id, name: "CÔTE D'IVOIRE", updated_at: after } })
  assert.deepEqual(app.calls.slice(1), [
    { session: { username: "TRUSTED EDITOR", displayName: "Trusted Editor", role: "STAFF" }, request: undefined, page: "ccinfo" },
    { context: { username: "TRUSTED EDITOR", pageId: "ccinfo" }, clientOptions: { useServiceRole: true } },
    { rpc: "rename_ccinfo_country", args: { p_id: id, p_name: "CÔTE D'IVOIRE", p_expected_updated_at: before } },
  ])
})

test("rename route rejects malformed inputs before touching database", async () => {
  for (const body of ["{bad", null, [], {}, { id, name: "", expectedUpdatedAt: before }, { id, name: "BAD\nNAME", expectedUpdatedAt: before }, { id, name: "X".repeat(201), expectedUpdatedAt: before }, { id: "bad", name: "NEW", expectedUpdatedAt: before }, { id, name: "NEW", expectedUpdatedAt: "2026-02-30T00:00:00Z" }, { id, name: "NEW", expectedUpdatedAt: "2026-10-12T00:00:00.1234567Z" }, { id, name: "NEW", expectedUpdatedAt: before, notes: "UNEXPECTED" }]) {
    const app = fixture()
    assert.equal((await app.request(body)).status, 400)
    assert.deepEqual(app.calls, [["ccinfo", "edit"]])
  }
})

test("rename route normalizes uppercase UUIDs before RPC and acknowledgement comparison", async () => {
  const lowerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
  const app = fixture({ data: { id: lowerId, name: "CÔTE D'IVOIRE", updated_at: after } })
  const response = await app.request({ id: lowerId.toUpperCase(), name: "côte d'ivoire", expectedUpdatedAt: before })
  assert.equal(response.status, 200)
  assert.equal(((app.calls.at(-1) as { args: { p_id: string } }).args).p_id, lowerId)
})

test("rename route maps conflict/validation errors and does not expose internal failure details", async () => {
  for (const [code, status] of [["40001", 409], ["40P01", 409], ["55P03", 409], ["23514", 409], ["23505", 400], ["22023", 400], ["XX000", 500]] as const) {
    const app = fixture({ error: { code, message: "synthetic secret database error" } })
    const response = await app.request()
    assert.equal(response.status, status)
    assert.doesNotMatch(await response.text(), /secret database/)
  }
  assert.equal((await fixture({ serviceKey: false }).request()).status, 503)
  const thrown = await fixture({ throws: true }).request()
  assert.equal(thrown.status, 500)
  assert.doesNotMatch(await thrown.text(), /secret database/)
})

test("rename route never acknowledges missing/wrong/malformed or unchanged-version records", async () => {
  for (const data of [null, {}, { id: "other", name: "CÔTE D'IVOIRE", updated_at: after }, { id, name: "WRONG", updated_at: after }, { id, name: "CÔTE D'IVOIRE", updated_at: "bad" }, { id, name: "CÔTE D'IVOIRE", updated_at: before }]) {
    assert.equal((await fixture({ data }).request()).status, 500)
  }
})
