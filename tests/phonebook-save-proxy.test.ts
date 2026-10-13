import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import vm from "node:vm"
import { createClient } from "@supabase/supabase-js"
import ts from "typescript"
import { ccinfoLegacyContentWriteMessage } from "../lib/ccinfoSave"
import { priceSetterLegacyWriteMessage } from "../lib/priceSetterLegacyWrites"
import { validateOutlookContactFields } from "../lib/outlookContactValidation"

const source = readFileSync(new URL("../app/api/admin/supabase/route.ts", import.meta.url), "utf8")
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText
const contactId = "11111111-1111-4111-8111-111111111111"
const saved = { id: contactId, full_name: "SYNTHETIC CONTACT", company: "SYNTHETIC COMPANY", favorite: true, source_key: `manual-${contactId}`, mobile_1: "+85295556666" }

function fixture(status = 200, payload: unknown = saved, forbidden = false) {
  const forwarded: Array<{ target: URL; method: string; headers: Headers; body: unknown }> = []
  const permissions: string[][] = []
  const dependencies: Record<string, unknown> = {
    "next/server": { NextResponse: Response },
    "@/lib/ccinfoSave": { ccinfoLegacyContentWriteMessage },
    "@/lib/priceSetterLegacyWrites": { priceSetterLegacyWriteMessage },
    "@/lib/outlookContactValidation": { validateOutlookContactFields },
    "@/lib/adminAuth": { requireAdminPagePermission: async (...permission: string[]) => {
      permissions.push(permission)
      if (forbidden) throw new Error("Forbidden")
      return { username: "synthetic-admin", displayName: "Synthetic Admin", role: "ADMIN" }
    } },
    "@supabase/supabase-js": { createClient(url: string, key: string) {
      assert.equal(url, "https://database-fixture.invalid")
      assert.equal(key, "synthetic-service-key")
      return { from(table: string) {
        assert.equal(table, "phonebook_companies")
        return { select(column: string) {
          assert.equal(column, "name")
          return { async in(field: string, names: string[]) {
            assert.equal(field, "name")
            assert.deepEqual(Array.from(names), ["SYNTHETIC COMPANY"])
            return { data: [{ name: "SYNTHETIC COMPANY" }], error: null }
          } }
        } }
      } }
    } },
  }
  const handlers: Record<string, (request: Request) => Promise<Response>> = {}
  vm.runInNewContext(output, {
    exports: handlers, Error, URL, Headers, TextDecoder,
    process: { env: { NEXT_PUBLIC_SUPABASE_URL: "https://database-fixture.invalid", SUPABASE_SERVICE_ROLE_KEY: "synthetic-service-key" } },
    require(name: string) { assert.ok(name in dependencies, `Unexpected dependency ${name}`); return dependencies[name] },
    fetch: async (target: URL, init: RequestInit) => {
      assert.equal(target.origin, "https://database-fixture.invalid", "No external request may escape the fixture")
      forwarded.push({ target, method: init.method!, headers: new Headers(init.headers), body: init.body ? JSON.parse(new TextDecoder().decode(init.body as ArrayBuffer)) : null })
      return Response.json(payload, { status })
    },
  })
  const client = createClient("https://database-fixture.invalid", "synthetic-anonymous-key", {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (input, init) => {
      const upstream = new Request(input, init)
      assert.equal(new URL(upstream.url).origin, "https://database-fixture.invalid")
      const url = new URL("https://app-fixture.invalid/api/admin/supabase")
      url.searchParams.set("target", upstream.url)
      const headers = new Headers(upstream.headers)
      headers.set("x-bunker-admin-page-id", "phonebook")
      headers.set("x-bunker-admin-user", "forged-browser-actor")
      return handlers[upstream.method](new Request(url, {
        method: upstream.method, headers,
        body: upstream.method === "GET" ? undefined : await upstream.arrayBuffer(),
      }))
    } },
  })
  return { client, forwarded, permissions }
}

test("the real Supabase UPDATE-select-single request passes actual Phonebook proxy policy unchanged", async () => {
  const f = fixture()
  const { data, error } = await f.client.from("phonebook_contacts").update({ company: saved.company, mobile_1: saved.mobile_1 }).eq("id", contactId).select("*").single()
  assert.equal(error, null)
  assert.deepEqual(data, saved)
  assert.deepEqual(f.permissions, [["phonebook", "edit"]])
  assert.equal(f.forwarded.length, 1)
  const request = f.forwarded[0]
  assert.equal(request.method, "PATCH")
  assert.equal(request.target.searchParams.get("id"), `eq.${contactId}`)
  assert.equal(request.target.searchParams.get("select"), "*")
  assert.equal(request.headers.get("accept"), "application/vnd.pgrst.object+json")
  assert.match(request.headers.get("prefer") || "", /return=representation/)
  assert.equal(request.headers.get("x-bunker-admin-user"), "synthetic-admin")
  assert.equal(request.headers.get("apikey"), "synthetic-service-key")
})

test("a zero-row single response remains an error through the real proxy and SDK", async () => {
  const f = fixture(406, { code: "PGRST116", message: "Cannot coerce the result to a single JSON object", details: "The result contains 0 rows", hint: null })
  const { data, error } = await f.client.from("phonebook_contacts").update({ mobile_1: saved.mobile_1 }).eq("id", contactId).select("*").single()
  assert.equal(data, null)
  assert.equal(error?.code, "PGRST116")
  assert.equal(f.forwarded.length, 1)
})

test("stable manual identity create and exact replay reads are allowed without an upsert", async () => {
  const f = fixture()
  const created = await f.client.from("phonebook_contacts").insert(saved).select("*").single()
  assert.equal(created.error, null)
  assert.deepEqual(f.forwarded[0].body, saved)
  assert.equal(f.forwarded[0].headers.get("prefer")?.includes("resolution=merge-duplicates"), false)
  const replay = fixture(200, [saved])
  const read = await replay.client.from("phonebook_contacts").select("*").eq("id", contactId).maybeSingle()
  assert.equal(read.error, null)
  assert.deepEqual(read.data, saved)
  assert.deepEqual(replay.permissions, [["phonebook", "view"]])
  assert.equal(replay.forwarded[0].method, "GET")
})

test("view-only permissions still prevent every source edit through the real proxy", async () => {
  const f = fixture(200, saved, true)
  const { data, error } = await f.client.from("phonebook_contacts").update({ mobile_1: saved.mobile_1 }).eq("id", contactId).select("*").single()
  assert.equal(data, null)
  assert.ok(error)
  assert.deepEqual(f.forwarded, [])
})
