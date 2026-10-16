import assert from "node:assert/strict"
import { readFileSync, existsSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, resolve, join } from "node:path"
import { fileURLToPath } from "node:url"
import { transformSync } from "esbuild"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const require = createRequire(import.meta.url)
export const todayClock = "2026-10-16T04:00:00.000Z"
class FixedDate extends Date {
  constructor(...args) { super(...(args.length ? args : [todayClock])) }
  static now() { return Date.parse(todayClock) }
}
export const todayId = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
export const todayNotes = (imo, extra = {}) => `Synthetic enquiry\n\n---SPC_META---\n${JSON.stringify({ imo, ...extra })}`
export const todayEnquiry = (n, overrides = {}) => ({
  id: todayId(n), enquiry_number: `SYNTHETIC-${n}`, title: "SYNTHETIC VESSEL",
  vessel_name: "SYNTHETIC VESSEL", port: "SINGAPORE", product: "VLSFO", quantity: "500",
  delivery_date: "2026-10-20", supplier_name: null, status: "open", notes: todayNotes("1234567"),
  created_by_username: "synthetic@example.test", created_by_display_name: "Synthetic",
  created_at: "2026-10-16T03:00:00.000Z", updated_at: "2026-10-16T03:00:00.000Z", ...overrides,
})
export const todayFixture = (n, overrides = {}) => ({
  id: todayId(n), fixture_status: "completed", fixture_date: "2026-10-15",
  supplier_trader_display_name: "Synthetic supplier", buyer_trader_display_name: "Synthetic buyer",
  vessel_name: "SYNTHETIC VESSEL", vessel_imo: "1234567", supplier_name: "SYNTHETIC SUPPLIER",
  price: "500", barging: "0", completed_at: "2026-10-15T03:00:00.000Z",
  created_at: "2026-10-15T02:00:00.000Z", ...overrides,
})

// Real GET, role/permission policy, note parsing, history mapping and identity helpers.
// Only authenticated identity, audited transport and clock are synthetic; no provider calls.
export function createTodayRoute({ enquiries = [], fixtures = [], role = "SUPPLIER TRADER", permission = "view", authenticated = true, queryError = null } = {}) {
  const queries = [], cache = new Map(), mocks = {
    "next/server": { NextResponse: { json: Response.json.bind(Response) } },
    "@/lib/spcAudit": {
      createSpcAuditContext() { return {} },
      createSpcAuditedSupabaseClient() {
        return { from(table) {
          const spec = { table, filters: [], orders: [], limit: Infinity, select: "" }
          const query = {
            select(value) { spec.select = value; return query },
            eq(key, value) { spec.filters.push(["eq", key, value]); return query },
            gte(key, value) { spec.filters.push(["gte", key, value]); return query },
            order(key, options) { spec.orders.push([key, options]); return query },
            limit(value) { spec.limit = value; return query },
            then(resolveResult, reject) {
              queries.push(structuredClone(spec))
              if (queryError && table === queryError.table) return Promise.resolve({ data: null, error: new Error(queryError.message) }).then(resolveResult, reject)
              let rows = (table === "spc_fixtures" ? fixtures : enquiries).filter((row) => spec.filters.every(([op, key, value]) => op === "eq" ? row[key] === value : row[key] >= value))
              rows = [...rows].sort((a, b) => { for (const [key, options] of spec.orders) { const order = String(a[key] ?? "").localeCompare(String(b[key] ?? "")); if (order) return options.ascending ? order : -order } return 0 })
              return Promise.resolve({ data: structuredClone(rows.slice(0, spec.limit)), error: null }).then(resolveResult, reject)
            },
          }
          return query
        } }
      },
    },
  }
  function load(name, parent = root) {
    if (Object.hasOwn(mocks, name)) return mocks[name]
    if (!name.startsWith("@/") && !name.startsWith(".")) return require(name)
    const unresolved = name.startsWith("@/") ? join(root, name.slice(2)) : resolve(parent, name)
    const file = ["", ".ts", ".json", ".js"].map((ext) => unresolved + ext).find(existsSync)
    assert.ok(file, "Unresolved " + name)
    if (file.endsWith(".json")) return JSON.parse(readFileSync(file, "utf8"))
    if (cache.has(file)) return cache.get(file).exports
    const mod = { exports: {} }; cache.set(file, mod)
    const code = transformSync(readFileSync(file, "utf8"), { loader: "ts", format: "cjs", target: "node24" }).code
    new Function("require", "module", "exports", "Date", code)((request) => load(request, dirname(file)), mod, mod.exports, FixedDate)
    return mod.exports
  }
  const pages = load("@/lib/spcPages")
  const session = { authenticated, username: "synthetic@example.test", role, permissions: pages.normaliseSpcPagePermissions({ "spc-today-enquiries": pages.constrainSpcPermissionForRole(role, "spc-today-enquiries", permission) }) }
  mocks["@/lib/spcAuth"] = { async requireSpcPagePermission(page, access) { assert.equal(page, "spc-today-enquiries"); if (!session.authenticated) throw new Error("Unauthorized"); if (!pages.canAccessSpcPage(session.permissions, page, access)) throw new Error("Forbidden"); return session } }
  return { queries, identity: load("@/lib/spcVesselIdentity"), async get() { const response = await load("@/app/api/spc/today-enquiries/route").GET(new Request("https://synthetic.invalid/api/spc/today-enquiries")); return { status: response.status, body: await response.json(), cache: response.headers.get("Cache-Control") } } }
}
