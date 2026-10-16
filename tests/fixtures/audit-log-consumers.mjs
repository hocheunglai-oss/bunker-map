import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { transformSync } from "esbuild"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const require = createRequire(import.meta.url)
export const supplierAuditActor = { username: "synthetic@example.test", displayName: "Synthetic Editor", userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", role: "ADMIN" }

// Matches the actual compare_and_swap_spc_supplier_store audit projection.
// The native suite additionally feeds rows emitted by that exact RPC through
// these actual list/detail/undo consumers, not through this row factory.
export function supplierAuditRow(id, operation = "UPDATE") {
  const key = "spc-supplier-overrides"
  /** @type {Record<string, unknown>} */
  const requestContext = { pageId: "spc-suppliers", pageLabel: "SUPPLIER DATABASE", pagePath: "/spc/suppliers", supplierAction: "save", supplierRequestId: id }
  return { id, occurred_at: "2026-10-16T03:00:00.000Z", actor_user_id: supplierAuditActor.userId,
    actor_id: `spc:${supplierAuditActor.username}`, actor_name: supplierAuditActor.displayName, actor_source: "app",
    table_schema: "public", table_name: "office_calendar_store", operation, record_pk: { key }, changed_fields: ["payload"],
    before_row: operation === "INSERT" ? null : { key, payload: { records: [], barges: [], contacts: [], receipts: [] }, updated_at: "2026-10-16T02:00:00Z" },
    after_row: { key, payload: { records: [{ key: "SYNTHETIC", name: "Synthetic", info: {} }], barges: [], contacts: [], receipts: [] }, updated_at: "2026-10-16T03:00:00Z" },
    request_context: requestContext,
    undo_of_log_id: null, undone_at: null, undone_by_log_id: null }
}

// Only the authenticated session and DB/Next transports are synthetic. The
// actual audit model, page definitions and both HTTP route bodies execute.
export function createAuditConsumers({ rows, permission = "edit", signedIn = true, role = "ADMIN" }) {
  let reads = 0, undoCalls = 0
  const session = { ...supplierAuditActor, role }
  const authorize = async (_page, access) => {
    if (!signedIn) throw new Error("Unauthorized")
    if (permission === "none" || access === "edit" && permission !== "edit") throw new Error("Forbidden")
    return session
  }
  const client = { from(table) {
    assert.equal(table, "audit_logs", "the consumer must not fetch or mutate application data")
    reads += 1
    let fields = "", limit = Infinity
    const predicates = []
    const selected = () => rows.filter(row => predicates.every(test => test(row))).slice(0, limit)
    const q = {
      select(value) { fields = value; return q },
      or(value) {
        if (value === "actor_id.is.null,actor_id.not.like.spc:%") predicates.push(row => !String(row.actor_id || "").startsWith("spc:"))
        return q
      },
      in(field, values) { predicates.push(row => values.includes(row[field])); return q },
      eq(field, value) { predicates.push(row => row[field] === value); return q },
      order() { return q }, limit(value) { limit = value; return q },
      async maybeSingle() { return { data: structuredClone(selected()[0] || null), error: null } },
      then(fulfilled, rejected) {
        const data = selected().map(row => {
          const projected = structuredClone(row)
          for (const match of fields.matchAll(/(before|after)_([^:,]+):(?:before|after)_row->>([^,]+)/g)) projected[`${match[1]}_${match[2]}`] = row[`${match[1]}_row`]?.[match[3]] ?? null
          return projected
        })
        return Promise.resolve({ data, error: null }).then(fulfilled, rejected)
      },
    }
    return q
  }, async rpc(name) { assert.equal(name, "undo_audit_log"); undoCalls += 1; return { data: "33333333-3333-4333-8333-333333333333", error: null } } }
  function load(file, modules) {
    const mod = { exports: {} }, code = transformSync(readFileSync(resolve(root, file), "utf8"), { loader: "ts", format: "cjs", target: "node24" }).code
    new Function("require", "module", "exports", "process", code)(name => {
      if (Object.hasOwn(modules, name)) return modules[name]
      if (name.startsWith("node:")) return require(name)
      throw new Error(`Unexpected audit dependency ${name}`)
    }, mod, mod.exports, { env: { NEXT_PUBLIC_SUPABASE_URL: "https://synthetic.invalid", SUPABASE_SERVICE_ROLE_KEY: "synthetic-only" } })
    return mod.exports
  }
  const audit = load("lib/auditLog.ts", { "@supabase/supabase-js": { createClient: () => client }, "@/lib/spcAudit": { createSpcAuditedSupabaseClient: () => client } })
  const spcPages = load("lib/spcPages.ts", {}), adminPages = load("lib/adminPages.ts", {})
  const spc = load("app/api/spc/audit-logs/route.ts", {
    "@/lib/spcAuth": { requireSpcPagePermission: authorize, requireSpcSession: () => authorize("spc-audit-log", "view"), hasSpcPagePermission: (_session, _page, access) => permission === "edit" || permission === "view" && access === "view", hasSpcRole: (_session, value) => role === value },
    "@/lib/auditLog": audit, "@/lib/spcAudit": { createSpcAuditContext: () => ({}), recordSpcUserManagementAuditEvent: async () => {} },
    "@/lib/spcUsers": { listSpcAuditUserOptions: async () => [] }, "@/lib/spcPages": spcPages,
    "@/lib/serverTiming": { timedJson: (_route, _at, data) => Response.json(data) }, "@/lib/spcResponse": { spcPrivateJson: Response.json.bind(Response) },
  })
  const www = load("app/api/admin/audit-logs/route.ts", {
    "next/server": { NextResponse: { json: Response.json.bind(Response) } }, "@/lib/adminAuth": { requireAdminPagePermission: authorize },
    "@/lib/auditLog": audit, "@/lib/adminPageDiscovery": { getDiscoveredAdminPages: async () => adminPages.ADMIN_PAGE_DEFINITIONS },
    "@/lib/adminUsers": { listManagedAdminRoleDefaults: async () => [], listManagedAdminUsers: async () => [] },
    "@/lib/serverTiming": { timedJson: (_route, _at, data) => Response.json(data) },
  })
  /** @param {import("../../lib/auditLog").AuditLogRecord} record
   * @returns {boolean} */
  function canUndoAuditLogRecord(record) { return audit.canUndoAuditLogRecord(record) }
  return { audit: { canUndoAuditLogRecord }, reads: () => reads, undoCalls: () => undoCalls, async request(scope, query = "", method = "GET", body) {
    const api = scope === "spc" ? spc : www
    const response = await api[method](new Request(`https://synthetic.invalid/api/${scope}/audit-logs${query}`, { method,
      ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) }))
    return { status: response.status, body: await response.json() }
  } }
}
