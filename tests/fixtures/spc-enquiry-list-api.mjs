import assert from "node:assert/strict"
import { readFileSync, existsSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, resolve, join } from "node:path"
import { fileURLToPath } from "node:url"
import { transformSync } from "esbuild"
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../.."), require = createRequire(import.meta.url)

// Exercise the real GET, scope policy and enquiry mapper. Only identity and DB transport are synthetic.
export function createEnquiryListRoute({ permissions = {}, authenticated = true, username = "synthetic@example.test", rows = [] } = {}) {
  const queries = [], requiredPermissions = [], cache = new Map(), mocks = {
    "next/server": { NextResponse: { json: Response.json.bind(Response) }, after() { throw new Error("Unexpected write") } },
    "@/lib/spcAudit": { createSpcAuditContext() { return {} }, createSpcAuditedSupabaseClient() { return { from(table) {
      const spec = { table, filters: [], order: [], limit: Infinity }
      const q = { select() { return q }, eq(key, value) { spec.filters.push([key, value]); return q }, gt(key, value) { spec.filters.push([key, value, "gt"]); return q }, order(key, options) { spec.order.push([key, options]); return q }, limit(value) { spec.limit = value; return q }, then(resolveResult, reject) {
        queries.push(structuredClone(spec))
        const data = rows.filter(row => spec.filters.every(([key, value, op]) => op === "gt" ? row[key] > value : row[key] === value)).slice(0, spec.limit)
        return Promise.resolve({ data: structuredClone(data), error: null }).then(resolveResult, reject)
      } }
      return q
    } } } },
    "@/lib/spcFixtures": {},
    "@/lib/spcGroupDispatcher": { normalizeSpcAmendmentChanges: value => value },
    "@/lib/spcUsers": { async listSupplierTraderOptions() { return ["SYNTHETIC"] } },
    "@/lib/spcMobileEnquiries": {},
    "@/lib/spcLostReasons": { async listSpcLostReasons() { return ["UNKNOWN"] } },
  }
  function load(name, parent = root) {
    if (Object.hasOwn(mocks, name)) return mocks[name]
    if (!name.startsWith("@/") && !name.startsWith(".")) return require(name)
    const unresolved = name.startsWith("@/") ? join(root, name.slice(2)) : resolve(parent, name)
    const file = ["", ".ts", ".json", ".js"].map(ext => unresolved + ext).find(existsSync)
    assert.ok(file, "Unresolved " + name)
    if (file.endsWith(".json")) return JSON.parse(readFileSync(file, "utf8"))
    if (cache.has(file)) return cache.get(file).exports
    const mod = { exports: {} }; cache.set(file, mod)
    const code = transformSync(readFileSync(file, "utf8"), { loader: "ts", format: "cjs", target: "node24" }).code
    new Function("require", "module", "exports", code)(request => load(request, dirname(file)), mod, mod.exports)
    return mod.exports
  }
  const pages = load("@/lib/spcPages"), session = { authenticated, username, role: "SUPPLIER TRADER", mustChangePassword: false, permissions: pages.normaliseSpcPagePermissions(permissions) }
  const hasPermission = (actor, page, access) => actor.authenticated && pages.canAccessSpcPage(actor.permissions, page, access)
  mocks["@/lib/spcAuth"] = { hasSpcPagePermission: hasPermission, async requireSpcPagePermission(page, access) { requiredPermissions.push([page, access]); if (!session.authenticated) throw new Error("Unauthorized"); if (!hasPermission(session, page, access)) throw new Error("Forbidden"); return session } }
  return { queries, requiredPermissions, async get(query = "") { const response = await load("@/app/api/spc/enquiries/route").GET(new Request("https://synthetic.invalid/api/spc/enquiries" + (query ? "?" + query : ""))); return { status: response.status, body: await response.json(), cache: response.headers.get("Cache-Control") } } }
}
