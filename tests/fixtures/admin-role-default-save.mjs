import assert from "node:assert/strict"
import { readFileSync, existsSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, resolve, join } from "node:path"
import { fileURLToPath } from "node:url"
import { transformSync } from "esbuild"
import { createClient } from "@supabase/supabase-js"
import { createHash } from "node:crypto"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const require = createRequire(import.meta.url)
export const groupTestPages = [
  { id: "user-management", label: "Users", group: "Management", path: "/admin/usermanagement" },
  { id: "attendancerecord", label: "Attendance", group: "Office", path: "/admin/attendancerecord" },
]
export const groupTestUser = {
  id: "11111111-1111-4111-8111-111111111111", username: "staff@example.invalid", display_name: "Synthetic staff",
  email: "staff@example.invalid", email_verified: true, role: "BT", password_hash: "synthetic-never-a-credential",
  is_active: true, use_fcos: true, use_spc: true, password_reset_required: false,
  identity_revision: 7, credential_revision: 3, revoked_before: "2026-01-01T00:00:00Z",
  permissions: { "user-management": "view", attendancerecord: "view", __adminRole: "BT", __attendanceGroup: "BT", __preserve: { nested: true } },
  created_at: "2026-01-01T00:00:00Z", updated_at: "2026-10-22T01:00:00.123456Z",
}
const initialGroups = () => ["ADMIN", "AC", "BT", "VN", "CUSTOM GROUP"].map(role => ({ role, permissions: { "user-management": role === "VN" ? "none" : "view", attendancerecord: "view" }, updated_at: "2026-10-22T00:00:00.123456Z" }))

// Real route, store, normalization and Supabase SDK. Only the session and
// transport are isolated synthetic state; no credentials/provider calls.
export function createAdminGroupSave({ storage = "table", users = [groupTestUser], groups = initialGroups(), afterUsersRead, permission = "edit", authenticated = true, failGroupWrite = false, failUsersRead = false, transport, adminUsersSource } = {}) {
  const state = { users: structuredClone(users), groups: structuredClone(groups), store: { groups: groups.map(g => ({ role: g.role, permissions: structuredClone(g.permissions), updatedAt: g.updated_at })) } }
  const requests = [], cache = new Map()
  let sequence = 0
  let usersReadHookFired = false
  const session = { authenticated, username: "operator@example.invalid", displayName: "Synthetic operator", role: "ADMIN" }
  const json = (value, status = 200) => Response.json(value, { status })
  const missingTable = () => json({ code: "PGRST205", message: "Could not find the table 'public.admin_role_defaults' in the schema cache" }, 404)
  const rows = () => storage === "table" ? structuredClone(state.groups) : state.store.groups.map(g => ({ role: g.role, permissions: structuredClone(g.permissions), updated_at: g.updatedAt }))
  const version = row => row ? createHash("sha256").update(JSON.stringify(row)).digest("hex") : null
  const currentVersion = role => version(rows().find(g => g.role === role))
  async function fetchImpl(input, init = {}) {
    const url = new URL(input), table = url.pathname.split("/").at(-1), method = init.method || "GET"
    assert.equal(url.origin, "https://group-save.synthetic.invalid")
    const body = init.body ? JSON.parse(String(init.body)) : undefined
    const entry = { table, method, body, headers: Object.fromEntries(new Headers(init.headers)), url: url.href }
    requests.push(entry)
    if (transport) return transport(entry)
    if (table === "read_admin_permission_groups") return json({ schema: "fcuno.admin-permission-groups/v1", storage, groups: rows().map(row => ({ ...row, version: version(row) })) })
    if (table === "write_admin_permission_group") {
      if (failGroupWrite) return json({ code: "08006", message: "Synthetic group write unavailable" }, 503)
      if (body.p_expected_version !== currentVersion(body.p_role)) return json({ code: "P0001", message: "ADMIN_PERMISSION_GROUP_CONFLICT" }, 400)
      const count = state.users.filter(u => load("@/lib/adminPages").normaliseAdminRole(u.permissions?.__adminRole ?? u.role) === body.p_role).length
      if (body.p_action === "delete" && count) return json({ code: "P0001", message: "ADMIN_PERMISSION_GROUP_IN_USE" }, 400)
      const row = { role: body.p_role, permissions: body.p_permissions, updated_at: new Date(Date.parse("2026-10-22T03:00:00Z") + ++sequence).toISOString() }
      const next = rows().filter(g => g.role !== body.p_role)
      if (body.p_action === "save") next.push(row)
      if (storage === "table") state.groups = next
      else state.store = { ...state.store, groups: next.map(g => ({ role: g.role, permissions: g.permissions, updatedAt: g.updated_at })) }
      if (afterUsersRead && !usersReadHookFired) { usersReadHookFired = true; await afterUsersRead(state) }
      return json({ saved: true, role: body.p_role, deleted: body.p_action === "delete", memberCount: count,
        row: body.p_action === "save" ? { ...row, version: version(row) } : null, version: body.p_action === "save" ? version(row) : null })
    }
    if (table === "admin_users") {
      if (method === "GET") {
        if (failUsersRead) return json({ code: "08006", message: "Synthetic users read unavailable" }, 503)
        let rows = state.users.filter(u => (!url.searchParams.has("id") || "eq." + u.id === url.searchParams.get("id")) && (!url.searchParams.has("is_active") || "eq." + u.is_active === url.searchParams.get("is_active")))
        const snapshot = structuredClone(rows)
        if (afterUsersRead && !usersReadHookFired) { usersReadHookFired = true; await afterUsersRead(state) }
        return json(snapshot)
      }
      assert.equal(method, "PATCH", "No user create/delete/RPC is allowed in this fixture")
      const id = url.searchParams.get("id")?.slice(3)
      for (const user of state.users) if (user.id === id) Object.assign(user, body)
      return new Response(null, { status: 204 })
    }
    if (table === "admin_role_defaults") {
      if (storage === "shared-store") return missingTable()
      if (method === "GET") return json(structuredClone(state.groups))
      assert.equal(method, "POST")
      if (failGroupWrite) return json({ code: "08006", message: "Synthetic group write unavailable" }, 503)
      const row = structuredClone(body)
      const index = state.groups.findIndex(g => g.role === row.role)
      if (index < 0) state.groups.push(row); else state.groups[index] = row
      return json(row)
    }
    assert.equal(table, "office_calendar_store")
    if (method === "GET") return json({ payload: structuredClone(state.store) })
    assert.equal(method, "POST")
    assert.equal(body.key, "admin-permission-groups")
    if (failGroupWrite) return json({ code: "08006", message: "Synthetic group write unavailable" }, 503)
    state.store = structuredClone(body.payload)
    return new Response(null, { status: 201 })
  }
  const mocks = {
    "@supabase/supabase-js": { createClient: (url, key, options) => {
      assert.equal(url, "https://group-save.synthetic.invalid")
      assert.equal(key, "synthetic-no-provider-credential")
      return createClient(url, key, { ...options, auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false }, global: { ...options?.global, fetch: fetchImpl } })
    } },
    "next/server": { NextResponse: { json: Response.json.bind(Response) } },
    "@/lib/adminPageDiscovery": { getDiscoveredAdminPages: async () => groupTestPages },
    "@/lib/adminAuth": { requireAdminPagePermission: async (page, access) => {
      assert.equal(page, "user-management")
      if (!authenticated) throw Error("Unauthorized")
      if (permission === "none" || (access === "edit" && permission !== "edit")) throw Error("Forbidden")
      return session
    } },
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
    const code = transformSync(file === join(root, "lib/adminUsers.ts") && adminUsersSource !== undefined ? adminUsersSource : readFileSync(file, "utf8"), { loader: "ts", format: "cjs", target: "node24" }).code
    const contextProcess = { env: { NEXT_PUBLIC_SUPABASE_URL: "https://group-save.synthetic.invalid", SUPABASE_SERVICE_ROLE_KEY: "synthetic-no-provider-credential" } }
    new Function("require", "module", "exports", "process", code)(request => load(request, dirname(file)), mod, mod.exports, contextProcess)
    return mod.exports
  }
  async function request(payload) {
      const response = await load("@/app/api/admin/users/route").POST(new Request("https://app.synthetic.invalid/api/admin/users", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }))
      return { status: response.status, body: await response.json() }
  }
  return { state, requests, session, load, version: currentVersion, request,
    save: (role = "BT", permissions = { "user-management": "edit", attendancerecord: "none" }) => load("@/lib/adminUsers").saveManagedAdminRoleDefault({ role, permissions, expectedVersion: currentVersion(role) }, session, groupTestPages),
    post: (role = "BT", permissions = { "user-management": "edit", attendancerecord: "none" }) => request({ action: "save-role-default", roleDefault: { role, permissions, expectedVersion: currentVersion(role) } }),
  }
}

