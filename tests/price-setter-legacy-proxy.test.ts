import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { transformSync } from "esbuild"
import * as guard from "../lib/priceSetterLegacyWrites"
import * as contacts from "../lib/outlookContactValidation"
import * as ccinfo from "../lib/ccinfoSave"
import * as groupWrites from "../lib/outlookGroupWriteGuard"

function harness(auth?: "Unauthorized" | "Forbidden") {
  const permissions: { page: string; access: string }[] = []
  const upstream: { url: string; init: RequestInit }[] = []
  class Reply extends Response {
    static json(value: unknown, init?: ResponseInit) { return new Reply(JSON.stringify(value), { ...init, headers: { "Content-Type": "application/json", ...init?.headers } }) }
  }
  const modules: Record<string, unknown> = {
    "next/server": { NextResponse: Reply },
    "@/lib/priceSetterLegacyWrites": guard,
    "@/lib/outlookContactValidation": contacts,
    "@/lib/ccinfoSave": ccinfo,
    "@/lib/outlookGroupWriteGuard": groupWrites,
    "@supabase/supabase-js": { createClient() { throw Error("Unexpected client creation") } },
    "@/lib/adminAuth": { async requireAdminPagePermission(page: string, access: string) {
      permissions.push({ page, access })
      if (auth) throw Error(auth)
      return { username: "SERVER-EDITOR", displayName: "Server Editor", role: "BT" }
    } },
  }
  const loaded = { exports: {} as Record<string, (request: Request) => Promise<Response>> }
  const code = transformSync(readFileSync(new URL("../app/api/admin/supabase/route.ts", import.meta.url), "utf8"), { loader: "ts", format: "cjs", target: "node24" }).code
  new Function("require", "module", "exports", "process", "fetch", code)((name: string) => {
    assert.ok(Object.hasOwn(modules, name), `Unexpected module ${name}`)
    return modules[name]
  }, loaded, loaded.exports, { env: { NEXT_PUBLIC_SUPABASE_URL: "https://database.example.test", SUPABASE_SERVICE_ROLE_KEY: "synthetic-only" } }, async (url: URL, init: RequestInit) => {
    upstream.push({ url: String(url), init })
    return Response.json({ saved: true }, { headers: { "Preference-Applied": "return=representation" } })
  })
  return { permissions, upstream, async request(table: string, method: string, payload?: unknown, page = "pricesetter", query = "") {
    const target = `https://database.example.test/rest/v1/${table}${query}`
    const request = new Request(`https://example.test/api/admin/supabase?target=${encodeURIComponent(target)}`, {
      method,
      headers: { "Content-Type": "application/json", "x-bunker-admin-page-id": page, "x-bunker-admin-user": "SPOOFED", "x-bunker-admin-role": "ADMIN", Prefer: "return=representation" },
      body: ["GET", "HEAD"].includes(method) ? undefined : typeof payload === "string" ? payload : JSON.stringify(payload ?? {}),
    })
    const response = await loaded.exports[method](request)
    return { status: response.status, headers: response.headers, body: await response.json() }
  } }
}

test("actual proxy fences legacy Price Setter writes before any service-role fetch", async () => {
  for (const [table, method, value, query] of [
    ["ports", "POST", { id: "11111111-1111-4111-8111-111111111111", hsfo: 999 }, "?on_conflict=id"],
    ["ports", "POST", { name: "New Port", display_order: 1 }, ""],
    ["ports", "PATCH", { hsfo: 1 }, "?id=eq.11111111-1111-4111-8111-111111111111"],
    ["ports", "PATCH", { display_order: 1 }, ""],
    ["ports", "DELETE", null, "?id=eq.11111111-1111-4111-8111-111111111111"],
    ["price_history", "POST", { hsfo: 1 }, ""], ["price_history", "DELETE", null, "?id=eq.old"],
    ["remarks", "POST", { id: 105, content: "{}" }, "?on_conflict=id"],
    ["remarks", "PATCH", { content: "{}" }, "?id=eq.105"], ["remarks", "DELETE", null, ""],
  ] as const) {
    const app = harness(), result = await app.request(table, method, value, "pricesetter", query)
    assert.equal(result.status, 409); assert.equal(result.body.code, "REFRESH_REQUIRED")
    assert.match(result.body.message, /Refresh/); assert.match(result.headers.get("Cache-Control")!, /no-store/)
    assert.deepEqual(app.permissions, [{ page: "pricesetter", access: "edit" }])
    assert.deepEqual(app.upstream, [])
  }
})

test("actual proxy rejects all three unversioned Taiwan notice writes before privileged fetch", async () => {
  for (const id of [1, 2, 3]) {
    const app = harness(), payload = { id, content: JSON.stringify({ reportDate: "09 Oct 2026" }) }
    const result = await app.request("remarks", "POST", payload, "taiwan-remarks", "?on_conflict=id&select=id")
    assert.equal(result.status, 409); assert.equal(result.body.code, "REFRESH_REQUIRED")
    assert.deepEqual(app.upstream, [])
    assert.deepEqual(app.permissions, [{ page: "taiwan-remarks", access: "edit" }])
  }
})

test("the generic admin proxy cannot invoke the service-only Taiwan remarks RPC", async () => {
  const app = harness()
  const response = await app.request("rpc/save_taiwan_remarks", "POST", { p_changes: [] }, "taiwan-remarks")
  assert.equal(response.status, 403)
  assert.deepEqual(app.upstream, [])
})

test("all legacy publication writers and alternate Taiwan Remarks headers are rejected before privileged fetch", async () => {
  for (const page of ["pricesetter", "taiwan-remarks", "hongkong-price-history", "taiwan-price-history"]) {
    for (const id of [101, 102, 103, 104, 105]) for (const payload of [{ id, content: "{}" }, [{ id, content: "{}" }]]) {
      const app = harness()
      assert.equal((await app.request("remarks", "POST", payload, page, "?on_conflict=id")).status, 409)
      assert.deepEqual(app.upstream, [])
    }
  }
  for (const method of ["PATCH", "DELETE"]) {
    const app = harness()
    assert.equal((await app.request("remarks", method, { content: "{}" }, "taiwan-remarks", "?id=eq.101")).status, 409)
    assert.deepEqual(app.upstream, [])
  }
  for (const value of ["{broken", [], { id: "1", content: "" }, { id: 1, content: "", extra: true }, [{ id: 1, content: "NOTICE" }, { id: 101, content: "{}" }]]) {
    const app = harness()
    assert.equal((await app.request("remarks", "POST", value, "taiwan-remarks")).status, 409)
    assert.deepEqual(app.upstream, [])
  }
})

test("reads and independent admin pages preserve their existing routes", async () => {
  for (const table of ["ports", "price_history", "remarks"]) for (const method of ["GET", "HEAD"]) {
    const app = harness()
    assert.equal((await app.request(table, method)).status, 200)
    assert.deepEqual(app.permissions, [{ page: "pricesetter", access: "view" }]); assert.equal(app.upstream.length, 1)
  }
  for (const [page, table, method, value] of [
    ["ccinfo", "cc_ports", "PATCH", { name: "PORT" }],
    ["phonebook", "phonebook_contacts", "PATCH", { name: "CONTACT" }],
    ["outlook-addressbook", "shared_addressbook_contacts", "PATCH", { display_name: "CONTACT", email: "contact@example.test" }],
  ] as const) {
    const app = harness(); assert.equal((await app.request(table, method, value, page)).status, 200)
    assert.equal(app.upstream.length, 1)
  }
})

test("both history pages must use the atomic endpoint rather than old direct price/history writes", async () => {
  for (const page of ["hongkong-price-history", "taiwan-price-history"]) for (const table of ["ports", "price_history"]) for (const method of ["POST", "PATCH", "DELETE"]) {
    const app = harness()
    assert.equal((await app.request(table, method, { hsfo: 1 }, page)).status, 409)
    assert.deepEqual(app.upstream, [])
    assert.deepEqual(app.permissions, [{ page, access: "edit" }])
  }
})

test("history pages cannot use any legacy snapshot writer, including their own report", async () => {
  for (const [page, ownId] of [["hongkong-price-history",102],["taiwan-price-history",101]] as const) {
    let app = harness()
    assert.equal((await app.request("remarks", "POST", { id: ownId, content: "{}" }, page)).status, 409)
    assert.equal(app.upstream.length, 0)
    for (const id of [1,2,3,103,104,105,ownId===101?102:101]) {
      app = harness()
      assert.equal((await app.request("remarks", "POST", { id, content: "{}" }, page)).status, 409)
      assert.deepEqual(app.upstream, [])
    }
  }
})

test("authorization still precedes the fence; malformed and mixed settings writes cannot get through", async () => {
  for (const [auth, status] of [["Unauthorized", 401], ["Forbidden", 403]] as const) {
    const app = harness(auth); assert.equal((await app.request("ports", "PATCH", "{broken")).status, status)
    assert.deepEqual(app.upstream, [])
  }
  for (const value of ["{broken", [], { id: "101", content: "{}" }, [{ id: 101, content: "{}" }, { id: 105, content: "{}" }]]) {
    const app = harness(); assert.equal((await app.request("remarks", "POST", value)).status, 409)
    assert.deepEqual(app.upstream, [])
  }
})
