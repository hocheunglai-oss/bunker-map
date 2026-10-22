import assert from "node:assert/strict"
import { readFileSync, existsSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, resolve, join } from "node:path"
import { fileURLToPath } from "node:url"
import { transformSync } from "esbuild"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const require = createRequire(import.meta.url)
export const supplierActor = { authenticated: true, username: "synthetic@example.test", displayName: "Synthetic Editor", userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", role: "ADMIN" }
export const supplierCsv = "SUPPLIER,PAYMENT,CLAIMS,TRADER,GRADES,FO BDN,GO BDN\nSYNTHETIC ALPHA,15,,,,,\nSYNTHETIC BETA,15,,,,,"
// The actual API/store/parser/audit headers execute. Only auth, transport and
// managed-user adapters are synthetic; no remote credentials/network exist.
export function createSupplierRoute({ createClient, permission = "edit", actor = supplierActor, optionalUnavailable = false, csv = supplierCsv, sheetChildren = false }) {
  const xlsx = sheetChildren ? require("xlsx") : null
  const workbook = (contacts) => {
    const book = xlsx.utils.book_new()
    const rows = contacts
      ? [["SUPPLIER", "SALES", "MOBILE", "OPS", "MOBILE"], ["SYNTHETIC ALPHA", "SYNTHETIC SHEET CONTACT", "synthetic-number", "", ""]]
      : [["SUPPLIER", "GRADE", "BARGE NAME", "IMO", "CAPACITY"], ["SYNTHETIC ALPHA", "VLSFO", "SYNTHETIC SHEET BARGE", "9999999", "500"]]
    xlsx.utils.book_append_sheet(book, xlsx.utils.aoa_to_sheet(rows), contacts ? "CONTACTS" : "SUPPLIER BARGES")
    return xlsx.write(book, { type: "buffer", bookType: "xlsx" })
  }
  const mocks = {
    "next/server": { NextResponse: { json: Response.json.bind(Response) } },
    "@supabase/supabase-js": { createClient: (_url, _key, options) => createClient(options?.global?.headers || {}) },
    "@/lib/spcAuth": { async requireSpcSession() { if (!actor) throw new Error("Unauthorized"); return actor }, hasSpcPagePermission: () => permission === "edit" },
    "@/lib/spcUsers": { async listSpcUserReferenceOptions() { return [] } },
    xlsx: xlsx || { read: () => ({ SheetNames: [], Sheets: {} }) },
  }
  const cache = new Map()
  const localFetch = async url => {
    assert.match(String(url), /^https:\/\/docs\.google\.com\/spreadsheets\//)
    return String(url).includes("/gviz/") ? new Response(csv)
      : new Response(sheetChildren ? workbook(String(url).includes("927102689")) : "synthetic workbook", { status: optionalUnavailable ? 503 : 200 })
  }
  function load(name, parent = root) {
    if (Object.hasOwn(mocks, name)) return mocks[name]
    if (!name.startsWith("@/") && !name.startsWith(".")) return require(name)
    const unresolved = name.startsWith("@/") ? join(root, name.slice(2)) : resolve(parent, name)
    const file = ["", ".ts", ".json", ".js"].map(ext => unresolved + ext).find(existsSync)
    assert.ok(file, `Unexpected import ${name}`)
    if (file.endsWith(".json")) return JSON.parse(readFileSync(file, "utf8"))
    if (cache.has(file)) return cache.get(file).exports
    const mod = { exports: {} }; cache.set(file, mod)
    const code = transformSync(readFileSync(file, "utf8"), { loader: "ts", format: "cjs", target: "node24" }).code
      .replaceAll('import("xlsx")', 'Promise.resolve(require("xlsx"))')
    new Function("require", "module", "exports", "process", "fetch", code)(
      request => load(request, dirname(file)), mod, mod.exports,
      { env: { NEXT_PUBLIC_SUPABASE_URL: "https://synthetic.invalid", SUPABASE_SERVICE_ROLE_KEY: "synthetic-only" } }, localFetch,
    )
    return mod.exports
  }
  const route = load("@/app/api/spc/suppliers/route")
  return {
    async get() { const response = await route.GET(new Request("https://synthetic.invalid/api/spc/suppliers")); return { status: response.status, body: await response.json() } },
    async patch(payload) { const response = await route.PATCH(new Request("https://synthetic.invalid/api/spc/suppliers", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })); return { status: response.status, body: await response.json() } },
  }
}

/** @typedef {{key:string,payload:{records:Array<{key:string,info:{paymentTerms:string},deleted?:boolean}>,barges:Array<{supplierKey:string}>,contacts:Array<{supplierKey:string,contacts:Array<{name:string}>}>,receipts?:Array<{requestId:string,actorUserId:string,operationHash:string}>},updated_at:string}} SupplierFixtureRow */
/** @param {{initial?:SupplierFixtureRow|null,auditFailure?:boolean,loseResponse?:boolean,holdReads?:boolean}} [options] */
export function supplierMemoryDb({ initial = null, auditFailure = false, loseResponse = false, holdReads = false } = {}) {
  let stored = structuredClone(initial), audits = 0, rpcCalls = 0, firstReads = 0, release
  const held = new Promise(resolve => { release = resolve })
  return {
    state: () => ({ stored: structuredClone(stored), audits, rpcCalls }),
    client: () => ({
      from(table) {
        if (table === "office_calendar_store") return { select() { return this }, eq() { return this }, async maybeSingle() {
          const data = structuredClone(stored)
          if (holdReads && ++firstReads <= 2) { if (firstReads === 2) release(); await held }
          return { data, error: null }
        } }
        if (table === "spc_fixtures") return { select() { return this }, eq() { return this }, order() { return this }, async range() { return { data: [], error: null } } }
        throw new Error(`Unexpected table write ${table}`)
      },
      async rpc(name, args) {
        assert.equal(name, "compare_and_swap_spc_supplier_store"); rpcCalls += 1
        if (Boolean(stored) !== args.p_expected_exists || JSON.stringify(stored?.payload ?? null) !== JSON.stringify(args.p_expected_payload)) return { error: { code: "40001", message: "Supplier data changed. Reload and retry the save.", details: "supplier-store-cas-contention" } }
        if (auditFailure) return { error: { code: "P0001", message: "Injected atomic audit failure" } }
        stored = { key: "spc-supplier-overrides", payload: structuredClone(args.p_payload), updated_at: new Date().toISOString() }; audits += 1
        if (loseResponse) { loseResponse = false; return { error: { message: "Injected response loss after commit" } } }
        return { data: { schema: "fcuno.supplier-store-cas/v1", requestId: args.p_request_id, payload: structuredClone(stored.payload), updatedAt: stored.updated_at }, error: null }
      },
    }),
  }
}
