import assert from "node:assert/strict"
import { readFileSync, existsSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, resolve, join } from "node:path"
import { fileURLToPath } from "node:url"
import { transformSync } from "esbuild"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const require = createRequire(import.meta.url)
export const buyerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
export const supplierId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
export const secondSupplierId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
export const enquiryId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
export const requestId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
export const expectedVersion = "2026-10-14T01:02:03.123456Z"
export const session = { authenticated: true, username: "buyer@example.test", displayName: "Synthetic Buyer", role: "BUYER TRADER", userId: buyerId }
export const users = [
  { id: buyerId, username: session.username, displayName: session.displayName, role: "BUYER TRADER", office: "HONG KONG", isActive: true, isSupplierTrader: false },
  { id: supplierId, username: "supplier@example.test", displayName: "Synthetic Supplier", role: "SUPPLIER TRADER", office: "SINGAPORE", isActive: true, isSupplierTrader: true },
  { id: secondSupplierId, username: "second@example.test", displayName: "Second Supplier", role: "SUPPLIER TRADER", office: "SINGAPORE", isActive: true, isSupplierTrader: true },
]
export const enquiry = {
  id: enquiryId, enquiry_number: "SPC-SYNTHETIC", title: "SYNTHETIC VESSEL", vessel_name: "SYNTHETIC VESSEL",
  port: "Singapore", product: "VLSFO", quantity: "500", delivery_date: "2026-10-20", supplier_name: null,
  status: "sent", notes: "synthetic vessel / singapore 20 oct / vlsfo 500mts", revision_number: 1,
  last_amended_at: null, last_amended_by_username: null, last_amendment_changes: [],
  created_by_username: session.username, created_by_display_name: session.displayName,
  created_at: expectedVersion, updated_at: expectedVersion,
  stem_request_id: null, stem_source_updated_at: null, stem_supplier_username: null,
}
export const stemPayload = (overrides = {}) => ({
  id: enquiryId, outcome: "stem", supplierTraderUsername: users[1].username,
  supplierTraderDisplayName: "Untrusted browser display name", expectedUpdatedAt: expectedVersion, stemRequestId: requestId,
  ...overrides,
})

// Execute the real route, enquiry store, fixture preparation, parser and audit
// headers. Only infrastructure adapters (DB, validated session, managed users)
// are substituted; mutations cannot silently bypass the new RPC.
/** @param {{createClient: (headers: Record<string,string>) => unknown, permission?: string, actor?: typeof session | null, userLookupError?: Error | null, userOptions?: typeof users, fixtureRoute?: boolean}} options */
export function createSpcStemRoute({ createClient, permission = "edit", actor = session, userLookupError = null, userOptions = users, fixtureRoute = false }) {
  let lookups = 0
  const mocks = {
    "next/server": { NextResponse: { json: Response.json.bind(Response) }, after() { throw new Error("Unexpected delivery side effect") } },
    "@supabase/supabase-js": { createClient: (_url, _key, options) => createClient(options.global.headers) },
    "@/lib/spcAuth": {
      async requireSpcPagePermission(page, access) {
        assert.ok(["spc-buyer-enquiries", "spc-fixtures"].includes(page)); assert.equal(access, "edit")
        if (!actor) throw new Error("Unauthorized")
        if (permission !== "edit") throw new Error("Forbidden")
        return actor
      },
    },
    "@/lib/spcUsers": {
      async listManagedSpcUsers() { lookups += 1; if (userLookupError) throw userLookupError; return structuredClone(userOptions) },
      async listActiveSpcUserOptions() { lookups += 1; if (userLookupError) throw userLookupError; return structuredClone(userOptions) },
    },
    "@/lib/spcGroupDispatcher": { normalizeSpcAmendmentChanges: value => value },
    "@/lib/spcMobileEnquiries": {},
    "@/lib/spcSuppliers": {},
    "@/lib/spcLostReasons": { async listSpcLostReasons() { return ["PRICE"] } },
  }
  const cache = new Map()
  function load(name, parent = root) {
    if (Object.hasOwn(mocks, name)) return mocks[name]
    if (!name.startsWith("@/") && !name.startsWith(".")) return require(name)
    const unresolved = name.startsWith("@/") ? join(root, name.slice(2)) : resolve(parent, name)
    const file = ["", ".ts", ".json", ".js"].map(extension => unresolved + extension).find(candidate => existsSync(candidate))
    assert.ok(file, `Unexpected local import ${name}`)
    if (file.endsWith(".json")) return JSON.parse(readFileSync(file, "utf8"))
    if (cache.has(file)) return cache.get(file).exports
    const loadedModule = { exports: {} }; cache.set(file, loadedModule)
    const code = transformSync(readFileSync(file, "utf8"), { loader: "ts", format: "cjs", target: "node24" }).code
    new Function("require", "module", "exports", "process", code)(
      request => load(request, dirname(file)), loadedModule, loadedModule.exports,
      { env: { NEXT_PUBLIC_SUPABASE_URL: "https://synthetic.invalid", SUPABASE_SERVICE_ROLE_KEY: "synthetic-only-never-remote" } },
    )
    return loadedModule.exports
  }
  const route = load(fixtureRoute ? "@/app/api/spc/fixtures/route" : "@/app/api/spc/enquiries/route")
  return {
    lookups: () => lookups,
    /** @param {Record<string, unknown>} [payload] */
    async patch(payload = stemPayload()) {
      const response = await route.PATCH(new Request("https://synthetic.invalid/api/spc/enquiries", {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
      }))
      return { status: response.status, body: await response.json() }
    },
  }
}
