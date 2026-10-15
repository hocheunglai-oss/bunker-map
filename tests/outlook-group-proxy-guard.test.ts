import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { transformSync } from "esbuild"
import * as ccinfo from "../lib/ccinfoSave"
import * as contacts from "../lib/outlookContactValidation"
import * as pricing from "../lib/priceSetterLegacyWrites"
import * as groups from "../lib/outlookGroupWriteGuard"

function fixture(permission: "edit" | "view" | "anonymous" = "edit") {
  const forwarded: Request[] = []
  const permissions: string[][] = []
  const modules: Record<string, unknown> = {
    "next/server": { NextResponse: Object.assign(Response, { json: Response.json }) },
    "@supabase/supabase-js": { createClient: () => { throw Error("Unexpected database client") } },
    "@/lib/ccinfoSave": ccinfo,
    "@/lib/outlookContactValidation": contacts,
    "@/lib/priceSetterLegacyWrites": pricing,
    "@/lib/outlookGroupWriteGuard": groups,
    "@/lib/adminAuth": { async requireAdminPagePermission(page: string, access: string) {
      permissions.push([page, access])
      if (permission === "anonymous") throw Error("Unauthorized")
      if (permission === "view" && access === "edit") throw Error("Forbidden")
      return { username: "SYNTHETIC EDITOR", displayName: "Synthetic Editor", role: "STAFF" }
    } },
  }
  const loaded = { exports: {} as Record<string, (request: Request) => Promise<Response>> }
  const code = transformSync(readFileSync(new URL("../app/api/admin/supabase/route.ts", import.meta.url), "utf8"), { loader: "ts", format: "cjs", target: "node24" }).code
  new Function("require", "module", "exports", "process", "fetch", code)((name: string) => {
    assert.ok(Object.hasOwn(modules, name), `Unexpected module: ${name}`)
    return modules[name]
  }, loaded, loaded.exports, { env: { NEXT_PUBLIC_SUPABASE_URL: "https://group-fixture.invalid", SUPABASE_SERVICE_ROLE_KEY: "synthetic-only-key" } }, async (url: URL, init: RequestInit) => {
    forwarded.push(new Request(url, init))
    return init.method === "HEAD" ? new Response(null) : Response.json([{ id: "group-synthetic" }])
  })
  return { forwarded, permissions, async request(method: string, { table = "shared_addressbook_groups", page = "outlook-addressbook", prefer = "return=representation", body = { id: "group-synthetic", source_uid: "group-synthetic", name: "SYNTHETIC GROUP", source_book: "FC-GENERAL" }, cas = false }: { table?: string; page?: string; prefer?: string; body?: unknown; cas?: boolean } = {}) {
    const target = new URL(`https://group-fixture.invalid/rest/v1/${table}`)
    target.searchParams.set("id", "eq.group-synthetic")
    if (cas) target.searchParams.set("updated_at", "eq.2026-10-14T00:00:00.000001Z")
    return loaded.exports[method](new Request(`https://app-fixture.invalid/api/admin/supabase?target=${encodeURIComponent(target.href)}`, {
      method, headers: { "Content-Type": "application/json", "x-bunker-admin-page-id": page, "x-bunker-admin-user": "FORGED", Prefer: prefer },
      body: ["GET", "HEAD"].includes(method) ? undefined : JSON.stringify(body),
    }))
  } }
}

test("actual proxy blocks old group saves/deletes after edit authorization, before service-role forwarding", async () => {
  for (const method of ["PATCH", "DELETE"]) for (const cas of [false, true]) {
    const app = fixture(), response = await app.request(method, { cas })
    assert.equal(response.status, 409)
    assert.equal(response.headers.get("cache-control"), "private, no-store")
    assert.equal((await response.json()).code, "REFRESH_REQUIRED")
    assert.deepEqual(app.permissions, [["outlook-addressbook", "edit"]])
    assert.deepEqual(app.forwarded, [])
  }
})

test("actual proxy blocks group upserts, including batched and alternate Prefer formatting", async () => {
  for (const prefer of ["resolution=merge-duplicates", "return=representation, resolution=merge-duplicates", "resolution=ignore-duplicates,return=representation", ' RETURN=representation , RESOLUTION = "MERGE-DUPLICATES" ']) {
    for (const body of [{ id: "group-synthetic", name: "STALE GROUP" }, [{ id: "group-synthetic", name: "STALE GROUP" }]]) {
      const app = fixture(), response = await app.request("POST", { prefer, body })
      assert.equal(response.status, 409, prefer)
      assert.deepEqual(app.forwarded, [])
    }
  }
})

test("legacy group guard does not disclose state to anonymous or view-only writers", async () => {
  for (const [permission, status] of [["anonymous", 401], ["view", 403]] as const) for (const method of ["PATCH", "DELETE", "POST"]) {
    const app = fixture(permission), response = await app.request(method, { prefer: "resolution=merge-duplicates" })
    assert.equal(response.status, status)
    assert.deepEqual(app.permissions, [["outlook-addressbook", "edit"]])
    assert.deepEqual(app.forwarded, [])
  }
  const app = fixture()
  assert.equal((await app.request("PATCH", { page: "phonebook" })).status, 403)
  assert.deepEqual(app.permissions, [])
})

test("actual proxy still creates groups and permits reads with the right permission and trusted identity", async () => {
  const app = fixture(), response = await app.request("POST")
  assert.equal(response.status, 200)
  assert.equal(app.forwarded.length, 1)
  assert.equal(app.forwarded[0].headers.get("x-bunker-admin-user"), "SYNTHETIC EDITOR")
  assert.equal(app.forwarded[0].headers.get("x-bunker-admin-page-id"), "outlook-addressbook")
  assert.equal(app.forwarded[0].headers.get("prefer"), "return=representation")
  for (const method of ["GET", "HEAD"]) {
    const read = fixture("view")
    assert.equal((await read.request(method)).status, 200)
    assert.deepEqual(read.permissions, [["outlook-addressbook", "view"]])
    assert.equal(read.forwarded.length, 1)
  }
})

test("actual proxy leaves supported membership add/remove and validated contact changes unchanged", async () => {
  for (const method of ["POST", "DELETE"]) {
    const app = fixture()
    assert.equal((await app.request(method, { table: "shared_addressbook_group_members", prefer: "resolution=merge-duplicates" })).status, 200)
    assert.equal(app.forwarded.length, 1)
  }
  const app = fixture()
  assert.equal((await app.request("PATCH", { table: "shared_addressbook_contacts", body: { nickname: "SYNTHETIC" } })).status, 200)
  assert.equal(app.forwarded.length, 1)
})

test("actual proxy blocks legacy count-preserving membership replacements before privileged forwarding", async () => {
  for (const body of [{ contact_id: "replacement" }, { group_id: "different-group" }, { source_book: "DIFFERENT" }]) {
    const app = fixture()
    const response = await app.request("PATCH", { table: "shared_addressbook_group_members", body })
    assert.equal(response.status, 409)
    assert.equal((await response.json()).code, "REFRESH_REQUIRED")
    assert.deepEqual(app.permissions, [["outlook-addressbook", "edit"]])
    assert.deepEqual(app.forwarded, [])
  }
})

test("actual proxy validates all new groups and protects server versions and membership counts", async () => {
  const valid = { id: "group-synthetic", source_uid: "group-synthetic", name: "SYNTHETIC GROUP", source_book: "FC-GENERAL", member_count: 0 }
  for (const body of [null, [], {}, "invalid", { ...valid, name: " " }, { ...valid, source_book: "" }, { ...valid, member_count: 7 }, { ...valid, updated_at: "2026-10-14T00:00:00Z" }, { ...valid, source_uid: null }, { ...valid, id: "x\n" }, [valid, { ...valid, nickname: 123 }]]) {
    const app = fixture()
    assert.equal((await app.request("POST", { body })).status, 400)
    assert.deepEqual(app.permissions, [["outlook-addressbook", "edit"]])
    assert.deepEqual(app.forwarded, [])
  }
  const app = fixture()
  assert.equal((await app.request("POST", { body: [valid, { ...valid, id: "historical-text-id", source_uid: "historical-source" }] })).status, 200)
  assert.equal(app.forwarded.length, 1)
})
