import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { transformSync } from "esbuild"
import * as ccinfoSave from "../lib/ccinfoSave"
import * as pricingWrites from "../lib/priceSetterLegacyWrites"

function fixture(permission = "edit") {
  const requests: Request[] = []
  const permissions: Array<[string, string]> = []
  const modules: Record<string, unknown> = {
    "next/server": { NextResponse: Object.assign(Response, { json: Response.json }) },
    "@supabase/supabase-js": { createClient: () => { throw Error("Unexpected database client") } },
    "@/lib/adminAuth": { requireAdminPagePermission: async (page: string, access: string) => {
      permissions.push([page, access])
      if (permission === "anonymous") throw Error("Unauthorized")
      if (permission === "view" && access === "edit") throw Error("Forbidden")
      return { username: "SYNTHETIC EDITOR", displayName: "Synthetic Editor", role: "STAFF" }
    } },
    "@/lib/outlookContactValidation": { validateOutlookContactFields: () => null },
    // Exercise both real guards together while isolating only external I/O.
    "@/lib/priceSetterLegacyWrites": pricingWrites,
    "@/lib/ccinfoSave": ccinfoSave,
  }
  const loadedModule: { exports: Record<string, (request: Request) => Promise<Response>> } = { exports: {} }
  const code = transformSync(readFileSync(new URL("../app/api/admin/supabase/route.ts", import.meta.url), "utf8"), { loader: "ts", format: "cjs", target: "node24" }).code
  new Function("require", "module", "exports", "process", "fetch", code)((name: string) => {
    assert.ok(Object.hasOwn(modules, name), name)
    return modules[name]
  }, loadedModule, loadedModule.exports, { env: { NEXT_PUBLIC_SUPABASE_URL: "https://synthetic-database.invalid", SUPABASE_SERVICE_ROLE_KEY: "synthetic-only-key" } }, async (url: URL, init: RequestInit) => {
    const request = new Request(url, init)
    requests.push(request)
    return Response.json([{ id: "11111111-1111-4111-8111-111111111111", updated_at: "2026-10-12T00:00:00.000002Z" }])
  })
  return { requests, permissions, async request({ table = "cc_companies", method = "PATCH", page = "ccinfo", cas = false, body = { summary: "SYNTHETIC DRAFT" }, prefer = "return=representation" }: { table?: string; method?: string; page?: string; cas?: boolean; body?: Record<string, unknown>; prefer?: string } = {}) {
    const target = new URL(`https://synthetic-database.invalid/rest/v1/${table}`)
    target.searchParams.set("id", "eq.11111111-1111-4111-8111-111111111111")
    if (cas) { target.searchParams.set("updated_at", "eq.2026-10-12T00:00:00.000001Z"); target.searchParams.set("select", "*") }
    return loadedModule.exports[method](new Request(`https://synthetic-app.invalid/api/admin/supabase?target=${encodeURIComponent(target.toString())}`, { method, headers: { "x-bunker-admin-page-id": page, prefer, "Content-Type": "application/json" }, body: JSON.stringify(body) }))
  } }
}

test("actual CCINFO proxy rejects old content clients after authorization without forwarding privileged writes", async () => {
  for (const table of ["cc_companies", "cc_countries", "cc_ports"]) {
    const app = fixture()
    const response = await app.request({ table })
    assert.equal(response.status, 409)
    assert.equal(response.headers.get("cache-control"), "private, no-store")
    assert.equal((await response.json()).code, "REFRESH_REQUIRED")
    assert.deepEqual(app.permissions, [["ccinfo", "edit"]])
    assert.equal(app.requests.length, 0)
  }
  for (const [permission, status] of [["anonymous", 401], ["view", 403]] as const) {
    const app = fixture(permission)
    assert.equal((await app.request()).status, status)
    assert.equal(app.requests.length, 0)
  }
})

test("actual CCINFO proxy preserves exact CAS filter, representation and trusted audit identity", async () => {
  const app = fixture()
  const response = await app.request({ cas: true })
  assert.equal(response.status, 200)
  assert.equal(app.requests.length, 1)
  const request = app.requests[0]
  assert.equal(new URL(request.url).searchParams.get("updated_at"), "eq.2026-10-12T00:00:00.000001Z")
  assert.equal(request.headers.get("prefer"), "return=representation")
  assert.equal(request.headers.get("x-bunker-admin-user"), "SYNTHETIC EDITOR")
  assert.equal(request.headers.get("x-bunker-admin-page-id"), "ccinfo")
  assert.deepEqual(await request.json(), { summary: "SYNTHETIC DRAFT" })
})

test("actual proxy leaves noncontent CCINFO writes and other pages unchanged", async () => {
  for (const input of [{ table: "cc_entry_files", body: { folder_path: "RENAMED" } }, { table: "cc_entry_folders", body: { name: "RENAMED" } }, { table: "cc_ports", cas: true, body: { country_name: "RENAMED", country_id: "11111111-1111-4111-8111-111111111111" } }, { table: "cc_companies", method: "POST" }, { table: "cc_companies", method: "DELETE" }, { page: "taiwan-remarks", table: "remarks", method: "POST", body: { id: 1, content: "UNCHANGED PATH" } }]) {
    const app = fixture()
    assert.equal((await app.request(input)).status, 200)
    assert.equal(app.requests.length, 1)
  }
})

test("actual proxy prevents old tabs from directly renaming countries or cascading unbounded port labels", async () => {
  for (const input of [{ table: "cc_countries", cas: true, body: { name: "RENAMED" } }, { table: "cc_ports", body: { country_name: "RENAMED" } }]) {
    const app = fixture()
    assert.equal((await app.request(input)).status, 409)
    assert.equal(app.requests.length, 0)
    assert.deepEqual(app.permissions, [["ccinfo", "edit"]])
  }
})
