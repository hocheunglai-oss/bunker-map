import assert from "node:assert/strict"
import * as crypto from "node:crypto"
import { readFileSync } from "node:fs"
import { performance } from "node:perf_hooks"
import test from "node:test"
import * as util from "node:util"
import vm from "node:vm"
import ts from "typescript"

const source = (path: string) => ts.transpileModule(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText
const modules: Record<string, string> = Object.fromEntries([
  ["@/lib/adminPages", "lib/adminPages.ts"], ["@/lib/adminAuth", "lib/adminAuth.ts"],
  ["@/lib/adminSessions", "lib/adminSessions.ts"], ["@/lib/adminUsers", "lib/adminUsers.ts"],
  ["@/lib/passwordPolicy", "lib/passwordPolicy.ts"], ["@/lib/emailAddress", "lib/emailAddress.ts"],
  ["@/lib/phonebookCarddav", "lib/phonebookCarddav.ts"], ["route", "app/api/phonebook/carddav-sync/route.ts"],
].map(([name, path]) => [name, source(path)]))

type Options = {
  state?: "anonymous" | "expired" | "revoked" | "reset" | "disabled"
  role?: string
  permission?: "none" | "view" | "edit"
  addressBookUrl?: string | null
  configurationThrows?: boolean
  authThrows?: boolean
  environment?: string | null
  commit?: string | null
  deployCommit?: string
}

// Execute the real route, URL helper, canonical session resolver, session
// expiry/revocation filters, strict active-user lookup and canonical role
// mapping. Only database/cookie/network IO is replaced with synthetic data.
function fixture(options: Options = {}) {
  const counts = { configurationReads: 0, credentialReads: 0, authClients: 0, authQueries: 0, authWrites: 0, businessClients: 0, providerRequests: 0, observations: 0 }
  const logs: unknown[][] = []
  const now = Date.now(), token = "A".repeat(43), userId = "10000000-0000-4000-8000-000000000001"
  const session = {
    id: "20000000-0000-4000-8000-000000000001", admin_user_id: userId,
    token_hash: crypto.createHash("sha256").update(token).digest("hex"),
    created_at: new Date(now - 60_000).toISOString(), last_seen_at: new Date(now).toISOString(),
    expires_at: new Date(now + (options.state === "expired" ? -1 : 400 * 86400_000)).toISOString(),
    revoked_at: options.state === "revoked" ? new Date(now - 1).toISOString() : null,
  }
  const user = {
    id: userId, username: "synthetic-admin", display_name: "SYNTHETIC PRIVATE NAME", email: "private@example.invalid",
    email_verified: true, role: options.role ?? "ADMIN", password_hash: "PRIVATE PASSWORD HASH",
    is_active: options.state !== "disabled", use_fcos: false, use_spc: false,
    password_reset_required: options.state === "reset", permissions: { phonebook: options.permission ?? "view" },
    created_at: new Date(now - 60_000).toISOString(), updated_at: new Date(now - 60_000).toISOString(),
  }
  const env: Record<string, string | undefined> = {
    NODE_ENV: "test", NEXT_PUBLIC_SUPABASE_URL: "https://auth-fixture.invalid", SUPABASE_SERVICE_ROLE_KEY: "synthetic-service-key",
    VERCEL_ENV: options.environment === null ? undefined : options.environment ?? "production",
    VERCEL_GIT_COMMIT_SHA: options.commit === null ? undefined : options.commit ?? "1".repeat(40),
    DEPLOY_COMMIT: options.deployCommit,
  }
  Object.defineProperty(env, "CARDDAV_ADDRESSBOOK_URL", { get() {
    counts.configurationReads++
    if (options.configurationThrows) throw new Error("PRIVATE RAW URL AND CONFIGURATION ERROR")
    return options.addressBookUrl === null ? undefined : options.addressBookUrl ?? "https://provider-fixture.invalid:8443/PRIVATE-ACCOUNT/PRIVATE-BOOK/"
  } })
  for (const key of ["CARDDAV_USERNAME", "CARDDAV_PASSWORD"]) Object.defineProperty(env, key, { get() {
    counts.credentialReads++
    throw new Error("Diagnostic must never access PRIVATE PROVIDER CREDENTIALS")
  } })
  const authClient = () => {
    counts.authClients++
    if (options.authThrows) throw new Error("PRIVATE AUTH DATABASE ERROR")
    return {
      from(table: string) {
        assert.ok(["admin_sessions", "admin_users"].includes(table), "No business data may be read")
        counts.authQueries++
        const predicates: Array<(row: Record<string, unknown>) => boolean> = []
        let single = false, update: Record<string, unknown> | null = null
        const builder = {
          select() { return builder }, order() { return builder },
          eq(key: string, value: unknown) { predicates.push(row => row[key] === value); return builder },
          is(key: string, value: unknown) { predicates.push(row => row[key] === value); return builder },
          gt(key: string, value: string) { predicates.push(row => String(row[key]) > value); return builder },
          maybeSingle() { single = true; return builder }, single() { single = true; return builder },
          update(value: Record<string, unknown>) { counts.authWrites++; update = value; return builder },
          then(resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) {
            const row = table === "admin_sessions" ? session : user
            const selected = predicates.every(predicate => predicate(row)) ? row : null
            if (selected && update) Object.assign(selected, update)
            return Promise.resolve({ data: single ? selected : selected ? [selected] : [], error: null }).then(resolve, reject)
          },
        }
        return builder
      },
      rpc(name: string) {
        assert.equal(name, "read_admin_permission_groups", "Only canonical authentication RPC is allowed")
        return { abortSignal: async () => ({ data: { schema: "fcuno.admin-permission-groups/v1", storage: "table", groups: [] }, error: null }) }
      },
    }
  }
  const loaded: Record<string, Record<string, unknown>> = {}
  function load(name: string): Record<string, unknown> {
    if (loaded[name]) return loaded[name]
    assert.ok(name in modules, `Unexpected module ${name}`)
    const exports: Record<string, unknown> = {}; loaded[name] = exports
    const require = (dependency: string): unknown => {
      if (dependency in modules) return load(dependency)
      if (dependency === "node:crypto") return crypto
      if (dependency === "node:util") return util
      if (dependency === "node:perf_hooks") return { performance }
      if (dependency === "next/server") return { NextResponse: Response }
      if (dependency === "next/headers") return { cookies: async () => ({
        get: (key: string) => key === "bunker_admin_auth" && options.state !== "anonymous" ? { value: token } : undefined,
        set: () => {},
      }) }
      if (dependency === "@/lib/browserSessionOwner") return { browserSessionActorKey: () => { throw new Error("Unexpected actor key") } }
      if (dependency === "@/lib/adminPageDiscovery") return { getDiscoveredAdminPages: async () => load("@/lib/adminPages").ADMIN_PAGE_DEFINITIONS }
      if (dependency === "@/lib/phonebookCarddavSemanticShadow") return { observePhonebookCarddavSemanticShadow: () => {
        counts.observations++; throw new Error("PRIVATE observer must not run")
      } }
      if (dependency === "@supabase/supabase-js") return { createClient: () => {
        if (name === "@/lib/adminSessions" || name === "@/lib/adminUsers") return authClient()
        counts.businessClients++; throw new Error("PRIVATE business database must not be accessed")
      } }
      throw new Error(`Unexpected dependency ${dependency}`)
    }
    vm.runInNewContext(modules[name], {
      exports, require, process: { env }, Error, URL, Buffer, Date, AbortSignal, AbortController, DOMException,
      TextDecoder, setTimeout, clearTimeout, performance,
      console: { info: (...args: unknown[]) => logs.push(args), error: (...args: unknown[]) => logs.push(args) },
      fetch: () => { counts.providerRequests++; throw new Error("PRIVATE provider must never be contacted") },
    }, { filename: name })
    return exports
  }
  const route = load("route") as { GET: (request: Request) => Promise<Response> }
  return { counts, logs, get: (query = "configuration=1") => route.GET(new Request(`https://app-fixture.invalid/api/phonebook/carddav-sync?${query}`)) }
}

async function result(f: ReturnType<typeof fixture>, query?: string) {
  const response = await f.get(query), body = await response.json()
  assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0")
  assert.equal(response.headers.get("pragma"), "no-cache")
  assert.equal(f.counts.credentialReads, 0)
  assert.equal(f.counts.businessClients, 0)
  assert.equal(f.counts.providerRequests, 0)
  assert.equal(f.counts.observations, 0)
  assert.deepEqual(f.logs, [], "Configuration results must never enter sync-failure or alert logs")
  assert.doesNotMatch(JSON.stringify(body), /PRIVATE|synthetic|PASSWORD|Bearer|Basic|https?:|8443|ACCOUNT|BOOK|example\.invalid/)
  return { response, body }
}

test("configuration diagnostic runs canonical ADMIN session/user/role guards and returns only hostname plus bounded metadata", async () => {
  const f = fixture(), { response, body } = await result(f)
  assert.equal(response.status, 200)
  assert.equal(body.hostname, "provider-fixture.invalid")
  assert.deepEqual(body.deployment, { environment: "production", commit: "1".repeat(40) })
  assert.equal(body.connectivity, "not_checked")
  assert.ok(Number.isFinite(Date.parse(body.checkedAt)))
  assert.deepEqual(Object.keys(body).sort(), ["checkedAt", "connectivity", "deployment", "hostname"])
  assert.ok(f.counts.authClients > 0, "Canonical authentication still verifies its database session and active account")
  assert.equal(f.counts.authWrites, 0)
  assert.equal(f.counts.configurationReads, 1)
})

test("canonical expired, revoked, anonymous, disabled and forced-reset sessions fail before configuration or query validation", async () => {
  for (const state of ["anonymous", "expired", "revoked", "disabled", "reset"] as const) {
    const f = fixture({ state, configurationThrows: true }), { response, body } = await result(f, "configuration=bad&details=1")
    assert.equal(response.status, 401, state)
    assert.deepEqual(body, { message: "Unauthorized" })
    assert.equal(f.counts.configurationReads, 0)
  }
})

test("Phonebook View/Edit and unknown roles do not grant actual ADMIN configuration access", async () => {
  for (const role of ["AC", "BT", "VN", "CUSTOM", "ADMINISTRATOR", ""]) for (const permission of ["none", "view", "edit"] as const) {
    const f = fixture({ role, permission, configurationThrows: true }), { response, body } = await result(f, "configuration=0")
    assert.equal(response.status, 403, `${role}/${permission}`)
    assert.deepEqual(body, { message: "Forbidden" })
    assert.equal(f.counts.configurationReads, 0)
  }
  assert.equal((await result(fixture({ role: " admin ", permission: "none" }))).response.status, 200, "Canonical role normalization is preserved")
})

test("configuration mode rejects duplicate, mixed, unknown and invalid selector values without business/provider work", async () => {
  for (const query of [
    "configuration", "configuration=", "configuration=0", "configuration=true", "configuration=01", "configuration=%201", "configuration=1%20",
    "configuration=1&configuration=1", "configuration=0&configuration=1", "configuration=1&details=1", "configuration=1&verifyContent=1",
    "configuration=1&startsAt=2026-10-26", "configuration=1&unexpected=value", "configuration=1&configuration%5B%5D=1",
  ]) {
    const f = fixture({ configurationThrows: true }), { response, body } = await result(f, query)
    assert.equal(response.status, 400, query)
    assert.deepEqual(body, { message: "Use configuration=1 without other parameters." })
    assert.equal(f.counts.configurationReads, 0)
  }
})

test("hostname derives from the exact runtime HTTPS URL without domain hardcoding, path, port or credential access", async () => {
  for (const addressBookUrl of [
    "https://USE22.THEGOOD.CLOUD:8443/private-account/private-book/", "https://p42-contacts.icloud.com/123/carddavhome/card/",
    "https://second-fixture.invalid/PRIVATE/%0aevil.invalid/", "https://127.0.0.1:8443/PRIVATE/", "https://例え.テスト/PRIVATE/",
  ]) {
    const { response, body } = await result(fixture({ addressBookUrl }))
    assert.equal(response.status, 200)
    assert.equal(body.hostname, new URL(addressBookUrl).hostname)
  }
})

test("invalid or missing URL configuration fails generically without raw values, provider work or error logging", async () => {
  for (const addressBookUrl of [null, "", "PRIVATE INVALID URL", "http://private.invalid/book", "ftp://private.invalid/book", "javascript:PRIVATE",
    "https://PRIVATE-USER:PRIVATE-PASSWORD@private.invalid/book", "https://PRIVATE-USER@private.invalid/book",
    "https://private.invalid/book?PRIVATE=PASSWORD", "https://private.invalid/book#PRIVATE", "https://[PRIVATE/", "https://safe.invalid@evil.invalid/PRIVATE/"]) {
    const { response, body } = await result(fixture({ addressBookUrl }))
    assert.equal(response.status, 503, String(addressBookUrl))
    assert.deepEqual(body, { message: "CardDAV configuration unavailable." })
  }
})

test("raw authentication/configuration failures are private sanitized 503s and never trigger normal sync logging", async () => {
  for (const options of [{ authThrows: true }, { configurationThrows: true }]) {
    const { response, body } = await result(fixture(options))
    assert.equal(response.status, 503)
    assert.deepEqual(body, { message: "CardDAV configuration unavailable." })
  }
})

test("deployment metadata is allowlisted or null and cannot disclose arbitrary environment contents", async () => {
  for (const environment of ["production", "preview", "development", "PRIVATE UNKNOWN ENV", "", null]) {
    const { body } = await result(fixture({ environment }))
    assert.equal(body.deployment.environment, ["production", "preview", "development"].includes(environment || "") ? environment : null)
  }
  for (const commit of ["PRIVATE COMMIT", "A".repeat(40), "1".repeat(39), "1".repeat(41), "", null]) {
    const { body } = await result(fixture({ commit }))
    assert.equal(body.deployment.commit, null)
  }
  const { body } = await result(fixture({ deployCommit: "PRIVATE OVERRIDE", commit: "1".repeat(40) }))
  assert.equal(body.deployment.commit, null, "Malformed higher-priority metadata must not be presented as verified")
})
