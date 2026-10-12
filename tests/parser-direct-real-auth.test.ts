import assert from "node:assert/strict"
import * as crypto from "node:crypto"
import { readFileSync } from "node:fs"
import test from "node:test"
import ts from "typescript"
import { NextResponse } from "next/server"
import { autoImplementMethods } from "next/dist/server/route-modules/app-route/helpers/auto-implement-methods"
import * as adminPages from "../lib/adminPages"
import * as spcPages from "../lib/spcPages"
import * as parserReports from "../lib/parserReports"

// These tests evaluate the real route, guards, session readers, page policies,
// MFA policy, response helper, and report helpers. Only request cookies, user
// lookups/link authorization, and database/audit IO are synthetic boundaries.
// No production environment, database client, cookie, account, or key is loaded.
type Handler = (request: Request) => Promise<Response> | Response
type Route = { GET: Handler }
type Row = Record<string, unknown>
type QueryResult = { data: Row | Row[] | null; error: Error | null }
type Query = {
  select: (columns: string) => Query
  eq: (key: string, value: unknown) => Query
  is: (key: string, value: unknown) => Query
  gt: (key: string, value: string) => Query
  update: (values: Row) => Query
  maybeSingle: () => Promise<QueryResult>
  then: Promise<QueryResult>["then"]
}

const ADMIN_TOKEN = "a".repeat(43)
const SPC_TOKEN = "s".repeat(43)
const CREDENTIAL_VERSION = "2026-10-01T00:00:00.000Z"
const CHANGED_CREDENTIAL_VERSION = "2026-10-02T00:00:00.000Z"
const SOURCE_QUERIES = [
  "", "?source=all", "?source=", "?source=unknown",
  "?source=enquiryworksheet", "?source=spc",
  "?source=spc&includeResolved=1", "?source=spc&summary=1&queue=0",
  "?source=spc&source=enquiryworksheet",
]
const fixture: parserReports.ParserReportRow = {
  id: "synthetic-enquiry-report", fingerprint: "synthetic-fingerprint",
  source: "enquiryworksheet", context: "shortened-enquiry",
  raw_text: "PRIVATE SYNTHETIC ENQUIRY VLSFO 100MT",
  cleaned_text: "PRIVATE SYNTHETIC ENQUIRY VLSFO 100MT",
  parser_output: "synthetic vlsfo 100mts", corrected_output: "synthetic vlsfo 100mts",
  note: "PRIVATE SYNTHETIC NOTE", page_url: "/admin/enquiryworksheet",
  metadata: parserReports.pendingParserReportMetadata({ aiFixOutput: "SYNTHETIC AI OUTPUT" }),
  status: "new", duplicate_count: 1,
  created_at: CREDENTIAL_VERSION, last_reported_at: CREDENTIAL_VERSION,
  created_by_username: "synthetic-user", created_by_display_name: "Synthetic User",
  app_commit: "synthetic-commit", updated_at: CREDENTIAL_VERSION,
}

function harness(options: { route?: "direct" | "canonical"; mfaEnabled?: boolean } = {}) {
  const now = new Date()
  const expiresAt = new Date(now.getTime() + 400 * 24 * 60 * 60 * 1000).toISOString()
  const state = {
    cookies: new Map([["bunker_admin_auth", ADMIN_TOKEN], ["spc_auth", SPC_TOKEN]]),
    cookieWrites: [] as Array<{ name: string; value: string }>,
    adminUser: {
      id: "synthetic-admin-user", username: "synthetic-admin", displayName: "Synthetic Admin",
      role: "AC", passwordResetRequired: false, credentialUpdatedAt: CREDENTIAL_VERSION,
      permissions: { "parser-reports": "view", "enquiry-worksheet": "none" } as adminPages.AdminPagePermissionMap,
    },
    spcUser: {
      id: "synthetic-spc-user", username: "synthetic-spc", displayName: "Synthetic SPC",
      role: "BUYER TRADER", office: "Synthetic Office", mustChangePassword: false,
      credentialUpdatedAt: CREDENTIAL_VERSION,
      permissions: { "spc-parser-reports": "view", "spc-buyer-enquiries": "none" } as spcPages.SpcPagePermissionMap,
    },
    adminUserExists: true, spcUserExists: true,
    linkedAccess: { linked: false, authorized: false },
    adminSession: {
      id: "synthetic-admin-session", admin_user_id: "synthetic-admin-user",
      token_hash: crypto.createHash("sha256").update(ADMIN_TOKEN).digest("hex"),
      created_at: now.toISOString(), last_seen_at: now.toISOString(), expires_at: expiresAt,
      revoked_at: null as string | null,
    },
    spcSession: {
      id: "synthetic-spc-session", spc_user_id: "synthetic-spc-user",
      token_hash: crypto.createHash("sha256").update(SPC_TOKEN).digest("hex"),
      user_updated_at: CREDENTIAL_VERSION, expires_at: expiresAt,
      revoked_at: null as string | null, mfa_verified_at: null as string | null,
      spc_users: { updated_at: CREDENTIAL_VERSION, is_active: true },
    },
    authClients: 0, authReads: [] as string[], authRevocations: [] as string[],
    userReads: [] as string[], linkReads: 0,
    reportClients: 0, reportReads: 0, reportSourceFilters: [] as string[],
    reportError: null as Error | null,
  }
  const cookieStore = {
    get(name: string) { const value = state.cookies.get(name); return value ? { value } : undefined },
    set(name: string, value: string) {
      state.cookieWrites.push({ name, value })
      if (value) state.cookies.set(name, value)
      else state.cookies.delete(name)
    },
  }
  const syntheticEnv = {
    NODE_ENV: "production", NEXT_PUBLIC_SUPABASE_URL: "https://synthetic.invalid",
    SUPABASE_SERVICE_ROLE_KEY: "synthetic-only-not-a-key",
    SPC_WHATSAPP_LOGIN_MFA_ALL_ENABLED: options.mfaEnabled ? "1" : "0",
  }
  function assertSyntheticClient(url: string, key: string) {
    assert.equal(url, syntheticEnv.NEXT_PUBLIC_SUPABASE_URL)
    assert.equal(key, syntheticEnv.SUPABASE_SERVICE_ROLE_KEY)
  }
  function createAuthClient(url: string, key: string) {
    assertSyntheticClient(url, key)
    state.authClients += 1
    return {
      from(table: string) {
        assert.ok(table === "admin_sessions" || table === "spc_sessions", `Unexpected auth table: ${table}`)
        const row: Row = table === "admin_sessions" ? state.adminSession : state.spcSession
        const filters: Array<["eq" | "is" | "gt", string, unknown]> = []
        let update: Row | null = null
        function valueAt(key: string) {
          return key.split(".").reduce<unknown>((value, part) => (value as Row)?.[part], row)
        }
        function execute(): QueryResult {
          // Require real readers to supply their token/revocation/expiry guards.
          assert.ok(filters.some(([op, key]) => op === "eq" && key === "token_hash"))
          assert.ok(filters.some(([op, key, value]) => op === "is" && key === "revoked_at" && value === null))
          if (!update) assert.ok(filters.some(([op, key]) => op === "gt" && key === "expires_at"))
          const matches = filters.every(([op, key, value]) => op === "gt"
            ? Date.parse(String(valueAt(key))) > Date.parse(String(value))
            : valueAt(key) === value)
          if (update) {
            // Rejection may revoke a synthetic session, but never write reports,
            // create sessions, or silently accommodate an unexpected operation.
            assert.deepEqual(Object.keys(update), ["revoked_at"])
            state.authRevocations.push(table)
            if (matches) Object.assign(row, update)
            return { data: matches ? [{ id: row.id }] : [], error: null }
          }
          state.authReads.push(table)
          return { data: matches ? { ...row } : null, error: null }
        }
        const query: Query = {
          select() { return query },
          eq(key, value) { filters.push(["eq", key, value]); return query },
          is(key, value) { filters.push(["is", key, value]); return query },
          gt(key, value) { filters.push(["gt", key, value]); return query },
          update(values) { update = values; return query },
          async maybeSingle() { return execute() },
          then(onfulfilled, onrejected) { return Promise.resolve().then(execute).then(onfulfilled, onrejected) },
        }
        return query
      },
    }
  }
  function createReportClient(url?: string, key?: string) {
    if (url !== undefined && key !== undefined) assertSyntheticClient(url, key)
    state.reportClients += 1
    return {
      from(table: string) {
        assert.equal(table, "parser_reports")
        let source: string | undefined
        const query = {
          select(columns: string) { assert.equal(columns, "*"); return query },
          eq(key: string, value: string) {
            assert.equal(key, "source"); source = value; state.reportSourceFilters.push(value); return query
          },
          order(column: string, order: { ascending: boolean }) {
            assert.equal(column, "last_reported_at"); assert.equal(order.ascending, false); return query
          },
          async limit(limit: number) {
            assert.equal(limit, 500)
            state.reportReads += 1
            return {
              data: [fixture, { ...fixture, id: "synthetic-spc-report", source: "spc" }]
                .filter((row) => source === undefined || row.source === source),
              error: state.reportError,
            }
          },
        }
        return query
      },
    }
  }
  const never = () => { throw new Error("Unexpected login, outbound delivery, or write boundary") }
  const adapters: Record<string, unknown> = {
    "node:crypto": crypto, crypto,
    "next/headers": { cookies: async () => cookieStore },
    "next/server": { NextResponse },
    "@/lib/adminPages": adminPages, "@/lib/spcPages": spcPages,
    "@/lib/parserReports": parserReports,
    "@/lib/adminPageDiscovery": { getDiscoveredAdminPages: async () => adminPages.ADMIN_PAGE_DEFINITIONS },
    "@/lib/adminUsers": {
      getDatabaseAdminUserByIdStrict: async (id: string, pages: adminPages.AdminPageDefinition[]) => {
        assert.equal(id, state.adminUser.id); state.userReads.push("admin")
        return state.adminUserExists ? {
          ...state.adminUser,
          permissions: adminPages.normaliseAdminPagePermissions(state.adminUser.permissions, "none", pages),
        } : null
      },
      validateDatabaseAdminUser: never, validateDatabaseAdminUserStrict: never,
    },
    "@/lib/spcUsers": {
      getDatabaseSpcUserById: async (id: string) => {
        assert.equal(id, state.spcUser.id); state.userReads.push("spc")
        return state.spcUserExists ? {
          ...state.spcUser, permissions: spcPages.normaliseSpcPagePermissions(state.spcUser.permissions),
        } : null
      },
      getFcunoLinkedSpcAccess: async (id: string) => {
        assert.equal(id, state.spcUser.id); state.linkReads += 1; return { ...state.linkedAccess }
      },
      validateDatabaseSpcUser: never, normaliseSpcWhatsappPhone: never,
    },
    "@/lib/spcWhatsappAuthentication": {
      SpcWhatsappAuthenticationDeliveryError: class extends Error {},
      maskSpcWhatsappPhone: never, sendSpcWhatsappAuthenticationCode: never,
    },
    "@/lib/adminAudit": { createAdminAuditContext: () => ({}), createAdminAuditedSupabaseClient: () => createReportClient() },
    "@/lib/spcAudit": { createSpcAuditContext: () => ({}), createSpcAuditedSupabaseClient: () => createReportClient() },
  }
  const realModules: Record<string, string> = {
    "@/lib/adminAuth": "../lib/adminAuth.ts", "@/lib/spcAuth": "../lib/spcAuth.ts",
    "@/lib/adminSessions": "../lib/adminSessions.ts", "@/lib/spcSessions": "../lib/spcSessions.ts",
    "@/lib/spcWhatsappLoginMfa": "../lib/spcWhatsappLoginMfa.ts",
    "@/lib/parserReportAccess": "../lib/parserReportAccess.ts",
    "@/lib/spcResponse": "../lib/spcResponse.ts", "@/lib/serverTiming": "../lib/serverTiming.ts",
    route: options.route === "canonical" ? "../app/api/parser-reports/route.ts" : "../app/api/parser-reports/direct/route.ts",
  }
  const loaded = new Map<string, { exports: unknown }>()
  function load(name: string): unknown {
    if (Object.hasOwn(adapters, name)) return adapters[name]
    if (loaded.has(name)) return loaded.get(name)!.exports
    assert.ok(Object.hasOwn(realModules, name), `Unexpected dependency: ${name}`)
    const loadedModule = { exports: {} as unknown }
    loaded.set(name, loadedModule)
    const code = ts.transpileModule(readFileSync(new URL(realModules[name], import.meta.url), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText
    new Function("require", "module", "exports", "process", "console", "fetch", code)((dependency: string) => {
      if (dependency === "@supabase/supabase-js") {
        return { createClient: name === "route" ? createReportClient : createAuthClient }
      }
      return load(dependency)
    }, loadedModule, loadedModule.exports, { env: syntheticEnv }, { log() {}, error() {} }, never)
    return loadedModule.exports
  }
  const route = load("route") as Route
  // The real framework signatures use NextRequest and an unused context;
  // these handlers accept its Request base class and return Response values.
  const methods = autoImplementMethods(route) as Record<"GET" | "HEAD" | "OPTIONS", Handler>
  return { state, route, methods }
}

function request(query = "", method = "GET", canonical = false) {
  return new Request(`https://synthetic.invalid/api/parser-reports${canonical ? "" : "/direct"}${query}`, { method })
}
function assertPrivate(response: Response) {
  assert.equal(response.headers.get("cache-control"), "private, no-store")
}
async function assertDenied(h: ReturnType<typeof harness>, status: number, query = "", method = "GET") {
  const response = await h.methods[method as "GET" | "HEAD"](request(query, method))
  assert.equal(response.status, status, `${method} ${query}`)
  assertPrivate(response)
  const body = await response.text()
  assert.deepEqual(JSON.parse(body), { message: status === 401 ? "Unauthorized" : "Forbidden" })
  for (const secret of [fixture.raw_text, fixture.note, "SYNTHETIC AI OUTPUT", "synthetic-enquiry-report", "synthetic-spc-report"]) {
    assert.ok(!body.includes(secret), `Denial contained synthetic report data: ${secret}`)
  }
  assert.equal(h.state.reportClients, 0)
  assert.equal(h.state.reportReads, 0)
}

for (const boundary of ["admin", "spc"] as const) {
  test(`real ${boundary} session is mandatory for every direct source/query mode`, async () => {
    for (const query of SOURCE_QUERIES) {
      const h = harness()
      h.state.cookies.delete(boundary === "admin" ? "bunker_admin_auth" : "spc_auth")
      await assertDenied(h, 401, query)
      assert.ok(!h.state.authReads.includes(`${boundary}_sessions`))
    }
  })
  test(`real ${boundary} View policy is mandatory for every direct source/query mode`, async () => {
    for (const query of SOURCE_QUERIES) {
      const h = harness()
      if (boundary === "admin") h.state.adminUser.permissions["parser-reports"] = "none"
      else h.state.spcUser.permissions["spc-parser-reports"] = "none"
      await assertDenied(h, 403, query)
      assert.ok(h.state.userReads.includes(boundary))
    }
  })
  test(`real ${boundary} session reader rejects malformed, revoked, and expired tokens`, async () => {
    for (const reason of ["malformed", "revoked", "expired"] as const) {
      const h = harness()
      const session = boundary === "admin" ? h.state.adminSession : h.state.spcSession
      if (reason === "malformed") h.state.cookies.set(boundary === "admin" ? "bunker_admin_auth" : "spc_auth", "forged")
      if (reason === "revoked") session.revoked_at = new Date().toISOString()
      if (reason === "expired") session.expires_at = "2000-01-01T00:00:00.000Z"
      await assertDenied(h, 401)
      assert.ok(h.state.cookieWrites.some(({ name, value }) => name === (boundary === "admin" ? "bunker_admin_auth" : "spc_auth") && value === ""))
    }
  })
}

test("dual real View sessions permit direct reads and retain cross-source counts and private headers", async () => {
  for (const source of ["all", "enquiryworksheet", "spc", "unknown"]) {
    const h = harness()
    const response = await h.route.GET(request(`?source=${source}&includeResolved=1`))
    assert.equal(response.status, 200)
    assertPrivate(response)
    const body = await response.json()
    assert.deepEqual(h.state.authReads, ["admin_sessions", "spc_sessions"])
    assert.deepEqual(h.state.userReads, ["admin", "spc"])
    assert.equal(h.state.reportClients, 1)
    assert.equal(h.state.reportReads, 1)
    assert.equal(h.state.linkReads, 1)
    assert.equal(body.counts.all.total, 2)
    assert.equal(body.counts.enquiryworksheet.total, 1)
    assert.equal(body.counts.spc.total, 1)
    assert.equal(body.source, source === "unknown" ? "all" : source)
    assert.equal(body.reports.length, source === "all" || source === "unknown" ? 2 : 1)
    assert.equal(body.reports[0].rawText, fixture.raw_text)
    assert.equal(body.reports[0].note, fixture.note)
    assert.equal(body.reports[0].metadata.aiFixOutput, "SYNTHETIC AI OUTPUT")
    assert.deepEqual(h.state.authRevocations, [])
    assert.deepEqual(h.state.reportSourceFilters, [])
  }
})

test("forced password resets fail closed with the actual FCUNO and SPC guard semantics", async () => {
  const admin = harness()
  admin.state.adminUser.passwordResetRequired = true
  await assertDenied(admin, 401)
  const spc = harness()
  spc.state.spcUser.mustChangePassword = true
  await assertDenied(spc, 403)
})

test("SPC credential changes are rejected at both the joined-session and subsequent-user boundaries", async () => {
  const joined = harness()
  joined.state.spcSession.spc_users.updated_at = CHANGED_CREDENTIAL_VERSION
  await assertDenied(joined, 401)
  assert.ok(!joined.state.userReads.includes("spc"))
  const raced = harness()
  raced.state.spcUser.credentialUpdatedAt = CHANGED_CREDENTIAL_VERSION
  await assertDenied(raced, 401)
  assert.deepEqual(raced.state.authRevocations, ["spc_sessions"])
})

test("FCUNO credential-rotation revocation supplied by the database invalidates the real session reader", async () => {
  const h = harness()
  // FCUNO rotation invalidates sessions in the database; this is deliberately
  // the reader boundary, not a claim to execute/verify the hosted SQL trigger.
  h.state.adminUser.credentialUpdatedAt = CHANGED_CREDENTIAL_VERSION
  h.state.adminSession.revoked_at = CHANGED_CREDENTIAL_VERSION
  await assertDenied(h, 401)
  assert.deepEqual(h.state.authReads, ["admin_sessions"])
  assert.deepEqual(h.state.userReads, [])
})

test("deleted/disabled account results and disabled joined SPC users deny before report access", async () => {
  const admin = harness()
  admin.state.adminUserExists = false
  await assertDenied(admin, 401)
  assert.deepEqual(admin.state.authRevocations, ["admin_sessions"])
  const spc = harness()
  spc.state.spcUserExists = false
  await assertDenied(spc, 401)
  assert.deepEqual(spc.state.authRevocations, ["spc_sessions"])
  const joined = harness()
  joined.state.spcSession.spc_users.is_active = false
  await assertDenied(joined, 401)
})

test("revoked FCUNO-linked SPC access revokes its SPC session even with MFA assurance", async () => {
  const h = harness({ mfaEnabled: true })
  h.state.linkedAccess = { linked: true, authorized: false }
  h.state.spcSession.mfa_verified_at = new Date().toISOString()
  await assertDenied(h, 401)
  assert.deepEqual(h.state.authRevocations, ["spc_sessions"])
  assert.ok(h.state.cookieWrites.some(({ name, value }) => name === "spc_auth" && value === ""))
})

test("real MFA policy rejects unassured external SPC sessions and accepts verified or authorized linked sessions", async () => {
  const denied = harness({ mfaEnabled: true })
  await assertDenied(denied, 401)
  assert.deepEqual(denied.state.authRevocations, ["spc_sessions"])
  const verified = harness({ mfaEnabled: true })
  verified.state.spcSession.mfa_verified_at = new Date().toISOString()
  assert.equal((await verified.route.GET(request())).status, 200)
  assert.equal(verified.state.reportReads, 1)
  const linked = harness({ mfaEnabled: true })
  linked.state.linkedAccess = { linked: true, authorized: true }
  assert.equal((await linked.route.GET(request())).status, 200)
  assert.equal(linked.state.reportReads, 1)
})

test("FCUNO ADMIN does not bypass the separate SPC session or View permission", async () => {
  for (const missing of ["session", "view", "neither"]) {
    const h = harness()
    h.state.adminUser.role = "ADMIN"
    h.state.adminUser.permissions["parser-reports"] = "none"
    if (missing === "session") h.state.cookies.delete("spc_auth")
    if (missing === "view") h.state.spcUser.permissions["spc-parser-reports"] = "none"
    if (missing !== "neither") await assertDenied(h, missing === "session" ? 401 : 403)
    else assert.equal((await h.route.GET(request())).status, 200)
  }
  const spcAdmin = harness()
  spcAdmin.state.spcUser.role = "ADMIN"
  spcAdmin.state.spcUser.permissions["spc-parser-reports"] = "none"
  await assertDenied(spcAdmin, 403)
})

test("Next automatic HEAD invokes the same real guards and reveals no denied report data", async () => {
  for (const boundary of ["admin-session", "spc-session", "admin-view", "spc-view"]) {
    const h = harness()
    assert.equal(h.methods.HEAD, h.route.GET)
    if (boundary === "admin-session") h.state.cookies.delete("bunker_admin_auth")
    if (boundary === "spc-session") h.state.cookies.delete("spc_auth")
    if (boundary === "admin-view") h.state.adminUser.permissions["parser-reports"] = "none"
    if (boundary === "spc-view") h.state.spcUser.permissions["spc-parser-reports"] = "none"
    await assertDenied(h, boundary.endsWith("session") ? 401 : 403, "?source=spc&includeResolved=1", "HEAD")
  }
})

test("Next automatic OPTIONS is empty and does not resolve sessions or construct report clients", async () => {
  const h = harness()
  h.state.cookies.clear()
  const response = await h.methods.OPTIONS(request("", "OPTIONS"))
  assert.equal(response.status, 204)
  assert.equal(response.headers.get("allow"), "GET, HEAD, OPTIONS")
  assert.equal(await response.text(), "")
  assert.equal(h.state.authClients, 0)
  assert.deepEqual(h.state.userReads, [])
  assert.equal(h.state.reportClients, 0)
  assert.equal(h.state.reportReads, 0)
})

test("direct database failures remain private and do not expose backend details", async () => {
  const h = harness()
  h.state.reportError = new Error("PRIVATE SYNTHETIC DATABASE DETAIL")
  const response = await h.route.GET(request())
  assert.equal(response.status, 500)
  assertPrivate(response)
  assert.deepEqual(await response.json(), { message: "Failed to load parser reports." })
})

test("canonical review GET still needs only its own real source-specific session and View permission", async () => {
  for (const source of ["enquiryworksheet", "spc"] as const) {
    const h = harness({ route: "canonical" })
    h.state.cookies.delete(source === "spc" ? "bunker_admin_auth" : "spc_auth")
    const response = await h.route.GET(request(`?source=${source}`, "GET", true))
    assert.equal(response.status, 200)
    assertPrivate(response)
    const body = await response.json()
    assert.deepEqual(h.state.authReads, [source === "spc" ? "spc_sessions" : "admin_sessions"])
    assert.deepEqual(h.state.userReads, [source === "spc" ? "spc" : "admin"])
    assert.deepEqual(h.state.reportSourceFilters, [source])
    assert.equal(h.state.reportReads, 1)
    assert.equal(body.reports.length, 1)
    assert.equal(body.reports[0].source, source)
  }
})
