import assert from "node:assert/strict"
import { transformSync } from "esbuild"
import { createClient } from "@supabase/supabase-js"
import { NextResponse } from "next/server.js"
import * as phonebookValidation from "../../lib/phonebookCompanySave.ts"
import * as remarksValidation from "../../lib/taiwanRemarksSave.ts"
import * as requestTransport from "../../lib/priceSetterRequest.ts"
import { source, json, literal, companyId, initialVersion } from "./phonebook-taiwan-cas.mjs"

export function saveConflictApi(domain, db) {
  assert.ok(["phonebook","taiwan"].includes(domain))
  const controls = { auth: "", error: null, beforeRpc: null }
  const calls = [], permissions = [], databaseStates = []
  const syntheticFetch = async (input, init = {}) => {
    const request = input instanceof Request ? input : new Request(input, init), url = new URL(request.url)
    assert.equal(url.origin, "https://synthetic-save-db.invalid")
    assert.equal(request.method, "POST")
    assert.equal(url.pathname, domain === "phonebook" ? "/rest/v1/rpc/save_phonebook_company" : "/rest/v1/rpc/save_taiwan_remarks")
    const args = await request.json()
    calls.push({ method: request.method, path: url.pathname, args })
    if (controls.beforeRpc) await controls.beforeRpc()
    const before = db ? await db.snapshot() : null
    try {
      if (controls.error) throw controls.error
      const sql = domain === "phonebook"
        ? `select public.save_phonebook_company(${literal(args.p_id)}::uuid,${literal(args.p_expected_updated_at)}::timestamptz,${json(args.p_patch)});`
        : `select public.save_taiwan_remarks(${json(args.p_changes)});`
      const data = db ? await db.execute(sql) : domain === "phonebook"
        ? { company: { id: companyId, name: "RENAMED COMPANY", updated_at: "2026-10-14T00:00:01.123456+00:00" }, contactIds: [] }
        : { rows: [{ id: 2, content: "NEW NOTICE" }], replayed: false }
      databaseStates.push({ before, after: db ? await db.snapshot() : null, success: true })
      return Response.json(data)
    } catch (error) {
      const message = error.message.match?.(/ERROR:\s+[A-Z0-9]{5}: ([^\n]*)/)?.[1] ?? error.message
      const details = error.message.match?.(/DETAIL:  ([^\n]*)/)?.[1] ?? error.details ?? "private synthetic diagnostic"
      databaseStates.push({ before, after: db ? await db.snapshot() : null, success: false, code: error.code, message, details })
      return Response.json({ code: error.code, message, details, hint: null }, { status: 400 })
    }
  }
  const client = () => createClient("https://synthetic-save-db.invalid", "synthetic-only-key", { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: syntheticFetch } })
  const authorize = async (page, access) => {
    permissions.push({ page, access })
    if (controls.auth) throw Error(controls.auth)
    return { username: "SYNTHETIC EDITOR" }
  }
  const modules = {
    "next/server": { NextResponse },
    "@/lib/phonebookCompanySave": phonebookValidation,
    "@/lib/taiwanRemarksSave": remarksValidation,
    "@/lib/priceSetterRequest": requestTransport,
    "@/lib/adminAuth": { requireAdminPagePermission: authorize, requireAdminPagePermissionForRequest: async (_request, page, access) => authorize(page, access) },
    "@/lib/adminAudit": { createAdminAuditContext: session => session, createAdminAuditedSupabaseClient: (_context, options) => { assert.deepEqual(options, { useServiceRole: true }); return client() } },
  }
  const loaded = { exports: {} }
  const code = transformSync(source(domain === "phonebook" ? "app/api/phonebook/company/route.ts" : "app/api/admin/taiwan-remarks/route.ts"), { loader: "ts", format: "cjs", target: "node24" }).code
  Function("require", "module", "exports", "process", code)(name => { assert.ok(Object.hasOwn(modules, name), name); return modules[name] }, loaded, loaded.exports, { env: { SUPABASE_SERVICE_ROLE_KEY: "synthetic-only" } })
  const payload = domain === "phonebook" ? { id: companyId, expectedUpdatedAt: initialVersion, patch: { name: "RENAMED COMPANY" } } : { changes: [{ id: 2, content: "NEW NOTICE", expected: { id: 2, exists: true, content: "OLD" } }] }
  async function request(body = payload) {
    const response = await loaded.exports.POST(new Request(`https://synthetic-app.invalid/api/${domain}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }))
    return { status: response.status, body: await response.json(), cacheControl: response.headers.get("cache-control") }
  }
  return { controls, calls, permissions, databaseStates, request, payload }
}
