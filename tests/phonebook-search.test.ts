import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { transformSync } from "esbuild"
import { createClient } from "@supabase/supabase-js"

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")
type Trace = { method: string; path: string; params: URLSearchParams }

function execute(text: string, modules: Record<string, unknown>, environment: Record<string, string> = {}) {
  const mod = { exports: {} as Record<string, unknown> }
  const code = transformSync(text, { loader: "ts", format: "cjs", target: "node24" }).code
  new Function("require", "module", "exports", "process", code)((name: string) => {
    assert.ok(Object.hasOwn(modules, name), `Unexpected route dependency: ${name}`)
    return modules[name]
  }, mod, mod.exports, { env: environment })
  return mod.exports
}

function fixture(upstream: () => Response = () => Response.json([])) {
  const requests: Trace[] = [], permissions: string[][] = []
  const origin = "https://synthetic-phonebook.invalid"
  const route = execute(source("../app/api/phonebook/contacts/route.ts"), {
    "next/server": { NextResponse: { json: Response.json.bind(Response) } },
    "@/lib/queryEscaping": execute(source("../lib/queryEscaping.ts"), {}),
    "@/lib/adminAuth": { requireAdminPagePermission: async (page: string, access: string) => {
      permissions.push([page, access])
      assert.deepEqual([page, access], ["phonebook", "view"])
    } },
    "@supabase/supabase-js": { createClient: (url: string, key: string) => {
      assert.equal(url, origin)
      assert.equal(key, "synthetic-only")
      return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false }, global: {
        fetch: async (input, init) => {
          const target = new URL(input instanceof Request ? input.url : String(input))
          assert.equal(target.origin, origin)
          const method = (init?.method || "GET").toUpperCase()
          assert.equal(method, "GET")
          assert.ok(["/rest/v1/phonebook_contacts", "/rest/v1/phonebook_companies"].includes(target.pathname))
          requests.push({ method, path: target.pathname, params: target.searchParams })
          return upstream()
        },
      } })
    } },
  }, { NEXT_PUBLIC_SUPABASE_URL: origin, SUPABASE_SERVICE_ROLE_KEY: "synthetic-only" })
  return { GET: route.GET as (request: Request) => Promise<Response>, requests, permissions }
}

test("actual Phonebook route and SDK serialize literal all-token filters without network access", async () => {
  for (const query of ["CAPTAIN ONE", "  CaPtAiN \t ONE  ", "ACME (HK),", "ACME,HK", ",", "%", "_", "*", '"', "\\", "(", ")", "(?i).*", "***=X", "a:b", "港口", "ACME ANCHOR", "ONE TWO THREE FOUR FIVE SIX SEVENTH", ""]) {
    const f = fixture()
    const response = await f.GET(new Request("https://synthetic.invalid/api/phonebook/contacts?" + new URLSearchParams({ query })))
    assert.equal(response.status, 200, query)
    assert.deepEqual(await response.json(), query.trim() ? { contacts: [], limited: false } : { contacts: [] })
    assert.deepEqual(f.permissions, [["phonebook", "view"]])
    if (!query.trim()) {
      assert.equal(f.requests.length, 0)
      continue
    }
    assert.equal(f.requests.length, 2)
    const direct = f.requests.find(row => row.path.endsWith("/phonebook_contacts"))!
    const company = f.requests.find(row => row.path.endsWith("/phonebook_companies"))!
    const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6)
    assert.deepEqual(direct.params.getAll("search_text"), tokens.map(token => `imatch.***=${token}`), query)
    // Independent string expectation: the existing quoting helper's printable
    // quote/backslash representation is JSON-compatible. Native proof covers
    // PostgreSQL matching and PostgREST parsing separately.
    assert.equal(company.params.get("or"), `(and(${tokens.map(token => {
      const literal = JSON.stringify(`***=${token}`)
      return `or(name.imatch.${literal},other_name.imatch.${literal})`
    }).join(",")}))`, query)
    assert.equal(direct.params.get("order"), "favorite.desc,full_name.asc,id.asc")
    assert.equal(direct.params.get("limit"), "400")
    assert.equal(company.params.get("select"), "name")
    assert.equal(company.params.get("limit"), "120")
  }
})

test("Phonebook SDK query failures remain errors rather than false empty successes", async () => {
  const f = fixture(() => Response.json({ code: "PGRST100", message: "Synthetic query failure", details: null, hint: null }, { status: 400 }))
  const response = await f.GET(new Request("https://synthetic.invalid/api/phonebook/contacts?query=ACME"))
  assert.equal(response.status, 500)
  assert.deepEqual(await response.json(), { message: "Unable to load phonebook contacts." })
  assert.deepEqual(f.permissions, [["phonebook", "view"]])
})
