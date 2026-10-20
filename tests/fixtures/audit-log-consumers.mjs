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
export function createAuditConsumers({ rows, permission = "edit", signedIn = true, role = "ADMIN", viewerId = supplierAuditActor.userId, providerCap = 1000, legacyOracle = false, identityAvailable = true, ports = /** @type {ReadonlyArray<{id:number,name:string}>} */ ([]), keyring = JSON.stringify({ activeKid: "synthetic", keys: [{ kid: "synthetic", keyBase64url: Buffer.alloc(32, 7).toString("base64url") }] }), users = /** @type {ReadonlyArray<{username:string,displayName:string}>} */ ([]) }) {
  let reads = 0, undoCalls = 0
  const session = { ...supplierAuditActor, userId: viewerId, adminUserId: viewerId, role, authenticated: true, permissions: { "audit-log": permission, "spc-audit-log": permission } }
  const authorize = async (_page, access) => {
    if (!signedIn) throw new Error("Unauthorized")
    if (permission === "none" || access === "edit" && permission !== "edit") throw new Error("Forbidden")
    return session
  }
  const client = { from(table) {
    assert.ok(["audit_logs", "ports", "spc_users", "admin_users"].includes(table), "only audit reads and existing read-only name classification maps are allowed")
    reads += 1
    let fields = "", limit = Infinity, countRequested = false
    const order = []
    const predicates = []
    const namedUsers = users.map((user,index)=>({id:`aaaaaaaa-aaaa-4aaa-8aaa-${String(index+1).padStart(12,"0")}`,username:user.username,display_name:user.displayName}))
    const candidates = () => (table === "ports" ? ports : ["spc_users","admin_users"].includes(table) ? namedUsers : rows).filter(row => predicates.every(test => test(row))).toSorted((a,b) => {
      for (const [field, ascending] of order) {
        const comparison = field === "occurred_at" ? cursor.compareAuditBrowsePositions({ occurredAt:a[field], id:a.id }, { occurredAt:b[field], id:b.id })
          : a[field] < b[field] ? -1 : a[field] > b[field] ? 1 : 0
        if (comparison) return ascending ? comparison : -comparison
      }
      return 0
    })
    const selected = () => candidates().slice(0, Math.min(limit, providerCap))
    const q = {
      select(value, options) { fields = value; countRequested = options?.count === "exact"; return q },
      or(value) {
        if (value === "actor_id.is.null,actor_id.not.like.spc:%") predicates.push(row => !String(row.actor_id || "").startsWith("spc:"))
        if (value.startsWith("table_schema.eq.public")) predicates.push(row => row.table_schema === "public" || row.table_schema === "app" && ["outlook_template_insertion_attempts", "spc_user_management_events", "spc_mfa_test_events"].includes(row.table_name))
        if (value.startsWith("occurred_at.lt.")) {
          const match = /^occurred_at\.lt\.(.*),and\(occurred_at\.eq\.(.*),id\.lt\.([0-9a-f-]+)\)$/.exec(value)
          assert.ok(match); assert.equal(match[1],match[2])
          predicates.push(row => cursor.compareAuditBrowsePositions({ occurredAt:row.occurred_at,id:row.id }, { occurredAt:match[1],id:match[3] }) < 0)
        }
        return q
      },
      in(field, values) { const [parent,child]=field.split("->>"); predicates.push(row => values.includes(child ? row[parent]?.[child] : row[field])); return q },
      eq(field, value) { predicates.push(row => row[field] === value); return q },
      gt(field, value) { predicates.push(row => row[field] > value); return q },
      order(field, { ascending }) { order.push([field, ascending]); return q }, limit(value) { limit = value; return q },
      async maybeSingle() { return { data: structuredClone(selected()[0] || null), error: null } },
      then(fulfilled, rejected) {
        const data = selected().map(row => {
          const projected = structuredClone(row)
          // Synthetic model only; the native PostgREST test separately proves
          // the actual SQL computed fields, NULL/type preservation and ACLs.
          for (const side of ["before", "after"]) {
            const value = projected[`${side}_row`]
            if (fields.includes(`${side}_row:audit_browsing_${side}_row`) && row.table_schema === "public"
              && row.table_name === "email_templates" && value !== null && typeof value === "object" && !Array.isArray(value)) {
              delete value.body_html; delete value.body_text
            }
          }
          for (const match of fields.matchAll(/(before|after)_([^:,]+):(?:before|after)_row->>([^,]+)/g)) projected[`${match[1]}_${match[2]}`] = row[`${match[1]}_row`]?.[match[3]] ?? null
          return projected
        })
        return Promise.resolve({ data, count: countRequested ? candidates().length : null, error: null }).then(fulfilled, rejected)
      },
    }
    return q
  }, async rpc(name) { assert.equal(name, "undo_audit_log"); undoCalls += 1; return { data: "33333333-3333-4333-8333-333333333333", error: null } } }
  function load(file, modules) {
    const mod = { exports: {} }, code = transformSync(readFileSync(resolve(root, file), "utf8"), { loader: "ts", format: "cjs", target: "node24" }).code
    new Function("require", "module", "exports", "process", code)(name => {
      if (Object.hasOwn(modules, name)) return modules[name]
      if (name === "server-only") return {}
      if (name.startsWith("node:")) return require(name)
      throw new Error(`Unexpected audit dependency ${name}`)
    }, mod, mod.exports, { env: { NEXT_PUBLIC_SUPABASE_URL: "https://synthetic.invalid", SUPABASE_SERVICE_ROLE_KEY: "synthetic-only", AUDIT_BROWSING_CURSOR_KEYS_JSON: keyring } })
    return mod.exports
  }
  const audit = load("lib/auditLog.ts", { "@supabase/supabase-js": { createClient: () => client }, "@/lib/spcAudit": { createSpcAuditedSupabaseClient: () => client } })
  const cursor = load("lib/auditBrowsingCursor.ts", {})
  const transport = load("lib/auditBrowsingTransport.ts", { "@/lib/auditBrowsingCursor": cursor })
  const source = load("lib/auditBrowsingSource.ts", { "@/lib/auditLog": audit, "@/lib/auditBrowsingCursor": cursor })
  const browsing = load("lib/auditBrowsing.ts", { "@/lib/auditLog": audit, "@/lib/auditBrowsingCursor": cursor, "@/lib/auditBrowsingTransport": transport, "@/lib/auditBrowsingSource": source })
  const managedUsers = { listManagedAdminRoleDefaults: async () => [], listManagedAdminUsers: async () => users }
  const legacy = load("lib/legacyAdminAuditFullList.ts", { "@/lib/auditLog": audit, "@/lib/adminUsers": managedUsers })
  const spcPages = load("lib/spcPages.ts", {}), adminPages = load("lib/adminPages.ts", {})
  const spc = load("app/api/spc/audit-logs/route.ts", {
    "@/lib/spcAuth": { requireSpcPagePermission: authorize, requireSpcSession: () => authorize("spc-audit-log", "view"), hasSpcPagePermission: (_session, _page, access) => permission === "edit" || permission === "view" && access === "view", hasSpcRole: (_session, value) => role === value },
    "@/lib/auditLog": audit, "@/lib/auditBrowsing": browsing, "@/lib/auditBrowsingCursor": cursor, "@/lib/auditBrowsingSource": source, "@/lib/spcAudit": { createSpcAuditContext: () => ({}), recordSpcUserManagementAuditEvent: async () => {} },
    "@/lib/spcUsers": { listSpcAuditUserOptions: async () => users }, "@/lib/spcPages": spcPages,
    "@/lib/serverTiming": { timedJson: (_route, _at, data, init) => Response.json(data, init) }, "@/lib/spcResponse": { spcPrivateJson: Response.json.bind(Response) },
  })
  const www = load(legacyOracle ? "tests/fixtures/admin-audit-legacy-route.txt" : "app/api/admin/audit-logs/route.ts", {
    "next/server": { NextResponse: { json: Response.json.bind(Response) } }, "@/lib/adminAuth": { requireAdminPagePermission: authorize, requireAdminIdentitySession: () => identityAvailable ? authorize("audit-log","view") : Promise.reject(new Error("Unauthorized")), hasAdminPagePermission: (_s,_p,access) => permission === "edit" || permission === "view" && access === "view" },
    "@/lib/auditBrowsing": browsing, "@/lib/auditBrowsingCursor": cursor, "@/lib/auditBrowsingSource": source,
    "@/lib/legacyAdminAuditFullList": legacy,
    "@/lib/auditLog": audit, "@/lib/adminPageDiscovery": { getDiscoveredAdminPages: async () => adminPages.ADMIN_PAGE_DEFINITIONS },
    "@/lib/adminUsers": managedUsers,
    "@/lib/serverTiming": { timedJson: (_route, _at, data, init) => Response.json(data, init) },
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
