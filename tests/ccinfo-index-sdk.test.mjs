import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { transformSync } from "esbuild"
import ts from "typescript"
import * as sdk from "@supabase/supabase-js"
import { buildCcinfoIndexSearchFilter, CCINFO_INDEX_CONFIG, parseCcinfoIndexResult } from "../lib/ccinfoIndex.ts"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const source = path => readFileSync(resolve(root, path), "utf8")
function execute(text, modules, globals = {}) {
  const mod = { exports: {} }, code = transformSync(text, { loader: "ts", format: "cjs", target: "node24" }).code
  new Function("require", "module", "exports", ...Object.keys(globals), code)(name => {
    assert.ok(Object.hasOwn(modules, name), `Unexpected dependency ${name}`)
    return modules[name]
  }, mod, mod.exports, ...Object.values(globals))
  return mod.exports
}
const cache = new Map()
function actualModule(path) {
  if (cache.has(path)) return cache.get(path)
  const text = source(path), modules = {}
  for (const match of text.matchAll(/from\s+["'](@\/lib\/[^"']+|\.\/[^"']+)["']/g)) {
    modules[match[1]] = actualModule(`${match[1].startsWith("@/") ? match[1].slice(2) : resolve(dirname(path), match[1])}.ts`)
  }
  const value = execute(text, modules)
  cache.set(path, value)
  return value
}
const pages = actualModule("lib/adminPages.ts"), registry = actualModule("lib/adminPageRegistry.ts")
const authAst = ts.createSourceFile("adminAuth.ts", source("lib/adminAuth.ts"), ts.ScriptTarget.Latest, true)
const authNodes = authAst.statements.filter(node => ts.isFunctionDeclaration(node) && ["hasAdminPagePermission", "requireAdminPagePermission"].includes(node.name?.text))
assert.equal(authNodes.length, 2)

// The real SDK, browser audit wrapper, server proxy and server permission
// helpers execute. Only cookie/session data and external fetch are synthetic.
function fixture({ kind = "company", permission = "edit", signedIn = true, upstream = () => Response.json([]) } = {}) {
  const calls = [], authorization = []
  const session = { authenticated: signedIn, resetRequired: false, username: "SYNTHETIC SERVER ACTOR", displayName: "Synthetic Actor", role: "STAFF", permissions: { ccinfo: permission } }
  const auth = execute(authNodes.map(node => node.getText(authAst)).join("\n"), {}, {
    canAccessAdminPage: pages.canAccessAdminPage, isAdminRole: pages.isAdminRole,
    requireAdminSession: async () => { if (!signedIn) throw Error("Unauthorized"); return session },
  })
  const modules = { "next/server": { NextResponse: Object.assign(Response, { json: Response.json }) }, "@supabase/supabase-js": sdk,
    "@/lib/adminAuth": { requireAdminPagePermission: async (page, access) => { authorization.push([page, access]); return auth.requireAdminPagePermission(page, access) } } }
  for (const name of ["outlookContactValidation", "priceSetterLegacyWrites", "ccinfoSave", "outlookGroupWriteGuard"]) modules[`@/lib/${name}`] = actualModule(`lib/${name}.ts`)
  const server = execute(source("app/api/admin/supabase/route.ts"), modules, {
    process: { env: { NEXT_PUBLIC_SUPABASE_URL: "https://synthetic.invalid", SUPABASE_SERVICE_ROLE_KEY: "synthetic-service-key" } },
    fetch: async (url, init) => { const request = new Request(url, init); calls.push(request); return upstream(request) },
  })
  const client = execute(source("lib/supabase.ts"), {
    "@supabase/supabase-js": sdk, "@/lib/adminPages": pages, "@/lib/adminPageRegistry": registry,
    "@/lib/clientStorage": { readClientStorage: () => JSON.stringify({ username: "UNTRUSTED CLIENT ACTOR", role: "STAFF", permissions: { ccinfo: "edit" }, pages: pages.ADMIN_PAGE_DEFINITIONS }) },
  }, {
    window: { location: { pathname: `/admin/ccinfo/${kind === "country" ? "countries" : `${kind}s`}` } },
    process: { env: { NEXT_PUBLIC_SUPABASE_URL: "https://synthetic.invalid", NEXT_PUBLIC_SUPABASE_ANON_KEY: "synthetic-anon-key" } },
    fetch: async (url, init) => { const request = new Request(new URL(url, "https://synthetic-app.invalid"), init); assert.equal(new URL(request.url).pathname, "/api/admin/supabase"); return server[request.method](request) },
  }).supabase
  return { client, calls, authorization }
}
const id = "11111111-1111-4111-8111-111111111111", version = "2026-10-16T07:30:00.123456Z"
const row = { id, name: "SYNTHETIC", notes: null, country_name: null, updated_at: version }

test("real SDK and proxy preserve quoted literal search, stable ordering, raw versions and same-response exact count", async () => {
  for (const kind of ["company", "country", "port"]) {
    for (const needle of [",", "_", "%", "*", '"', "\\", "(", ")", "(?i).*", "***=", "港口"]) {
      const f = fixture({ kind, upstream: () => Response.json([row], { headers: { "content-range": "0-0/1", "preference-applied": "count=exact" } }) })
      const config = CCINFO_INDEX_CONFIG[kind]
      let query = f.client.from(config.table).select(config.select, { count: "exact" })
      for (const field of config.orderFields) query = query.order(field, { ascending: true })
      const filter = buildCcinfoIndexSearchFilter(kind, needle)
      const result = await query.or(filter).range(0, 199).abortSignal(new AbortController().signal)
      assert.equal(parseCcinfoIndexResult(result, kind, 1).rows[0].updated_at, version)
      const target = new URL(f.calls[0].url)
      assert.equal(target.searchParams.get("or"), `(${filter})`)
      assert.equal(target.searchParams.get("order"), config.orderFields.map(field => `${field}.asc`).join(","))
      assert.equal(target.searchParams.get("limit"), "200")
      assert.equal(f.calls[0].headers.get("prefer"), "count=exact")
      assert.deepEqual(f.authorization, [["ccinfo", "view"]])
    }
  }
})

test("real SDK/proxy errors, missing count and malformed totals fail verification rather than displaying zero", async () => {
  for (const response of [
    () => Response.json({ code: "PGRST100", message: "Synthetic parse error" }, { status: 400 }),
    () => Response.json({ code: "PGRST103", message: "Synthetic out-of-range" }, { status: 416 }),
    () => Response.json([row]),
    () => Response.json([row], { headers: { "content-range": "0-0/not-a-number" } }),
  ]) {
    const f = fixture({ upstream: response })
    const result = await f.client.from("cc_companies").select("id,name,notes,updated_at", { count: "exact" }).range(0, 199)
    assert.throws(() => parseCcinfoIndexResult(result, "company", 1), /could not be verified/)
  }
})

test("old raw SDK record DELETE clients are rejected after Edit authorization, even with a version and representation", async () => {
  for (const table of ["cc_companies", "cc_countries", "cc_ports"]) {
    const f = fixture()
    const result = await f.client.from(table).delete().eq("id", id).eq("updated_at", version).select("id")
    assert.equal(result.status,409); assert.equal(result.error.code,"REFRESH_REQUIRED")
    assert.equal(f.calls.length,0);assert.deepEqual(f.authorization,[["ccinfo","edit"]])
  }
})

test("actual server permissions deny anonymous/none reads and View/none writes despite client Edit claims", async () => {
  for (const [permission, signedIn, method, status] of [["none", true, "GET", 403], ["none", true, "DELETE", 403], ["view", true, "DELETE", 403], ["edit", false, "GET", 401], ["edit", false, "DELETE", 401]]) {
    const f = fixture({ permission, signedIn })
    const result = method === "GET" ? await f.client.from("cc_companies").select("id", { count: "exact" }) : await f.client.from("cc_companies").delete().eq("id", id).eq("updated_at", version).select("id")
    assert.equal(result.status, status); assert.ok(result.error)
    assert.equal(f.calls.length, 0)
    assert.deepEqual(f.authorization, [["ccinfo", method === "GET" ? "view" : "edit"]])
  }
  const view = fixture({ permission: "view", upstream: () => Response.json([], { headers: { "content-range": "*/0" } }) })
  assert.equal(parseCcinfoIndexResult(await view.client.from("cc_companies").select("id", { count: "exact" }), "company", 1).count, 0)
})
