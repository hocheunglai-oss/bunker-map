import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import ts from "typescript"
import { NextResponse } from "next/server"
import { normaliseOidcAuthorizeReturnTo } from "../lib/fcunoOidcContinuation"
import {
  isFreshOidcAuthentication, normaliseScope, validatePkceChallenge,
} from "../lib/fcunoOidc"

const callback = "https://auth.example.test/auth/v1/callback"
const session = () => ({ adminUserId: "synthetic-user", authTime: new Date().toISOString() })
function authorize(prompt?: string) {
  const url = new URL("https://identity.example.test/api/oidc/authorize")
  for (const [name, value] of Object.entries({ client_id: "synthetic-client", redirect_uri: callback,
    response_type: "code", scope: "openid profile email", state: "synthetic-state",
    nonce: "synthetic-nonce-long-enough", code_challenge: "a".repeat(43),
    code_challenge_method: "S256", redirect_to: "https://app.example.test/login?federated=1" })) {
    url.searchParams.set(name, value)
  }
  if (prompt !== undefined) url.searchParams.set("prompt", prompt)
  return url
}
function harness(initial: ReturnType<typeof session> | null = null) {
  let current = initial, cleared = 0, codes = 0, allowed = true, clearFails = false, lookupFails = false, lookups = 0
  const modules: Record<string, unknown> = {
    "next/server": { NextResponse },
    "@/lib/adminAuth": {
      requireAdminSessionForOidc: async () => { lookups++; if (lookupFails) throw Error("synthetic lookup failure"); if (!current) throw Error("Unauthorized"); return current },
      clearAdminSession: async () => { if (clearFails) throw Error("synthetic revoke failure"); cleared++; current = null },
    },
    "@/lib/fcunoFederationFlags": { isFcunoOidcEnabled: () => true },
    "@/lib/fcunoOidc": {
      getOidcClient: (id: string) => id === "synthetic-client" ? { redirectUris: [callback] } : null,
      createAuthorizationCode: () => "synthetic-authorization-code", hashOidcValue: () => "synthetic-code-hash",
      isFreshOidcAuthentication, normaliseScope, validatePkceChallenge,
    },
    "@/lib/fcunoOidcStore": {
      getOidcIdentity: async () => ({ id: "synthetic-user", isActive: true, useFcos: allowed,
        emailVerified: true, identityRevision: 2, credentialRevision: 1 }),
      createOidcAuthorizationCode: async () => { codes++ },
    },
  }
  const compiled = ts.transpileModule(readFileSync(new URL("../app/api/oidc/authorize/route.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const route = { exports: {} as { GET: (request: Request) => Promise<Response> } }
  new Function("require", "module", "exports", compiled)((name: string) => {
    assert.ok(name in modules, `Unexpected dependency: ${name}`)
    return modules[name]
  }, route, route.exports)
  return { get: (url: URL) => route.exports.GET(new Request(url)),
    signIn: () => { current = session() }, deny: () => { allowed = false },
    failRevocation: () => { clearFails = true }, failLookup: () => { lookupFails = true }, stats: () => ({ cleared, codes, current, lookups }) }
}
function continuation(response: Response) {
  assert.equal(response.status, 302)
  const login = new URL(response.headers.get("location")!)
  assert.equal(login.pathname, "/admin")
  const returnTo = normaliseOidcAuthorizeReturnTo(login.searchParams.get("returnTo"), login.origin)
  assert.ok(returnTo)
  assert.equal(response.headers.get("cache-control"), "no-store")
  return new URL(returnTo, login.origin)
}

test("prompt=login authenticates once, preserves protocol bindings and then issues a code", async () => {
  const h = harness(session()), original = authorize("login")
  const resumed = continuation(await h.get(original))
  assert.equal(h.stats().cleared, 1)
  assert.equal(h.stats().current, null)
  assert.equal(h.stats().codes, 0)
  assert.equal(resumed.searchParams.has("prompt"), false)
  for (const [name, value] of original.searchParams) if (name !== "prompt") assert.equal(resumed.searchParams.get(name), value)
  // The server-side continuation still cannot authorize without a new login.
  continuation(await h.get(resumed))
  assert.equal(h.stats().codes, 0)
  h.signIn()
  const result = await h.get(resumed), destination = new URL(result.headers.get("location")!)
  assert.equal(destination.origin, new URL(callback).origin)
  assert.equal(destination.searchParams.get("code"), "synthetic-authorization-code")
  assert.equal(destination.searchParams.get("state"), "synthetic-state")
  assert.equal(h.stats().cleared, 1)
  assert.equal(h.stats().codes, 1)
})

test("an unauthenticated forced-login request also completes after its first fresh login", async () => {
  const h = harness(), resumed = continuation(await h.get(authorize("login")))
  h.signIn()
  const result = await h.get(resumed)
  assert.equal(new URL(result.headers.get("location")!).searchParams.get("code"), "synthetic-authorization-code")
  assert.equal(h.stats().cleared, 1)
  assert.equal(h.stats().codes, 1)
})

test("select_account is consumed only by the server login handoff; other prompt tokens survive", async () => {
  const h = harness(session()), original = authorize("login select_account consent")
  const resumed = continuation(await h.get(original))
  assert.equal(resumed.searchParams.get("prompt"), "consent")
  assert.equal(h.stats().cleared, 1)
  // The shared admin normalizer must not strip a fresh request's directive.
  assert.equal(normaliseOidcAuthorizeReturnTo(original.pathname + original.search, original.origin), original.pathname + original.search)
})

test("failed session revocation cannot create a sanitized continuation or an authorization code", async () => {
  const h = harness(session()); h.failRevocation()
  const result = await h.get(authorize("login")), location = new URL(result.headers.get("location")!)
  assert.equal(location.origin, new URL(callback).origin)
  assert.equal(location.searchParams.get("error"), "invalid_request")
  assert.equal(h.stats().codes, 0)
})

test("a lookup failure still clears the hidden session before consuming a fresh-login prompt", async () => {
  const h = harness(session()); h.failLookup()
  const resumed = continuation(await h.get(authorize("login")))
  assert.equal(resumed.searchParams.has("prompt"), false)
  assert.equal(h.stats().current, null)
  assert.equal(h.stats().cleared, 1)
  assert.equal(h.stats().codes, 0)
  const failed = harness(session()); failed.failLookup(); failed.failRevocation()
  const result = await failed.get(authorize("login"))
  assert.equal(new URL(result.headers.get("location")!).searchParams.get("error"), "invalid_request")
  assert.equal(failed.stats().codes, 0)
})

test("stale authentication, silent login, entitlement and redirect checks still fail closed", async () => {
  const stale = harness({ ...session(), authTime: "2000-01-01T00:00:00Z" })
  continuation(await stale.get(authorize()))
  assert.equal(stale.stats().cleared, 1)
  const silent = harness(), silentResult = await silent.get(authorize("none"))
  assert.equal(new URL(silentResult.headers.get("location")!).searchParams.get("error"), "login_required")
  const denied = harness(session()); denied.deny()
  assert.equal(new URL((await denied.get(authorize())).headers.get("location")!).searchParams.get("error"), "access_denied")
  assert.equal(denied.stats().codes, 0)
  const foreign = authorize("login"); foreign.searchParams.set("redirect_uri", "https://foreign.example.test/callback")
  assert.equal((await denied.get(foreign)).status, 400)
  assert.equal(denied.stats().cleared, 0)
})

test("mixed silent/interactive and duplicate prompts are rejected before accessing the session", async () => {
  for (const prompt of ["none login", "none select_account", "login"]) {
    const h = harness(session()), request = authorize(prompt)
    if (prompt === "login") request.searchParams.append("prompt", "login")
    const result = await h.get(request)
    assert.equal(new URL(result.headers.get("location")!).searchParams.get("error"), "invalid_request")
    assert.equal(h.stats().lookups, 0)
    assert.equal(h.stats().cleared, 0)
    assert.equal(h.stats().codes, 0)
  }
})
