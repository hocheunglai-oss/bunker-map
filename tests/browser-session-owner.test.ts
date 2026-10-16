import assert from "node:assert/strict"
import * as crypto from "node:crypto"
import { readFileSync } from "node:fs"
import test from "node:test"
import ts from "typescript"
import { NextResponse } from "next/server"
import * as adminPages from "../lib/adminPages"
import { SPC_PAGE_DEFINITIONS } from "../lib/spcPages"
import { spcPrivateJson } from "../lib/spcResponse"

// Actual helper and response handlers. Only server-session/cookie/database IO
// and credential verification are synthetic; no real env, login or provider IO.
function load<T>(path: string, dependencies: Record<string, unknown>): T {
  const module = { exports: {} }
  const compiled = ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText
  const require = (id: string) => {
    if (!(id in dependencies)) throw new Error(`Unexpected module/IO boundary: ${id}`)
    return dependencies[id]
  }
  new Function("require", "module", "exports", "process", "console", compiled)(require, module, module.exports,
    { env: { NODE_ENV: "test" } }, { info() {}, warn() {}, error() {} })
  return module.exports as T
}
type Owner = { browserSessionActorKey: (scope: "fcuno" | "spc", id: string | null | undefined) => string | null }
type Route = { GET: () => Promise<Response>; POST: (request: Request) => Promise<Response> }
const owner = load<Owner>("../lib/browserSessionOwner.ts", { "server-only": {}, "node:crypto": crypto })
const id = "11111111-1111-4111-8111-111111111111"
const user = { id, username: "synthetic@example.invalid", displayName: "Synthetic User", role: "ADMIN", office: "SG",
  passwordResetRequired: false, mustChangePassword: false, credentialUpdatedAt: "2026-10-16T00:00:00Z",
  permissions: {}, pages: [], passwordHash: "NEVER-BROWSER", refreshToken: "NEVER-BROWSER" }
const ownerDependency = { "@/lib/browserSessionOwner": owner }
function request(body: unknown) { return new Request("https://synthetic.invalid/api/login", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }) }
async function assertOwnerResponse(response: Response, scope: "fcuno" | "spc", nested = false) {
  assert.equal(response.status, 200)
  const body = await response.json()
  const value = nested ? body.user : body
  assert.equal(value.actorKey, owner.browserSessionActorKey(scope, id))
  assert.match(value.actorKey, /^[0-9a-f]{64}$/)
  const raw = JSON.stringify(body)
  assert.equal(raw.includes(id), false, "Internal stable IDs never enter the browser session payload")
  assert.equal(raw.includes("NEVER-BROWSER"), false)
  for (const key of ["id", "userId", "passwordHash", "refreshToken", "sessionToken"]) assert.equal(key in value, false)
  return body
}

test("ownership fingerprints are deterministic, domain-separated, nullable and not raw stable IDs", () => {
  const key = owner.browserSessionActorKey("fcuno", id)
  assert.equal(key, crypto.createHash("sha256").update(`fcuno-browser-owner/v1\0fcuno\0${id}`).digest("hex"))
  assert.notEqual(key, owner.browserSessionActorKey("spc", id))
  assert.notEqual(key, owner.browserSessionActorKey("fcuno", "22222222-2222-4222-8222-222222222222"))
  assert.equal(owner.browserSessionActorKey("spc", null), null)
  assert.equal(owner.browserSessionActorKey("fcuno", undefined), null)
})

test("actual FCUNO session reader adds only display ownership; base public/OIDC session stays unchanged", async () => {
  let signedIn = true
  const cookies = { get: () => signedIn ? { value: "synthetic-session-only" } : undefined, set() {} }
  const auth = load<{ getRefreshedAdminSession: () => Promise<unknown>; getAdminSession: () => Promise<Record<string, unknown>> }>("../lib/adminAuth.ts", {
    ...ownerDependency, "next/headers": { cookies: async () => cookies }, "@/lib/adminPages": adminPages,
    "@/lib/adminPageDiscovery": { getDiscoveredAdminPages: async () => [] },
    "@/lib/adminUsers": { getDatabaseAdminUserByIdStrict: async () => user },
    "@/lib/adminSessions": { ADMIN_SESSION_DURATION_SECONDS: 400 * 86400,
      getDatabaseAdminSession: async () => ({ id: "synthetic-session", adminUserId: id, createdAt: "2026-10-16T00:00:00Z", expiresAt: "2027-10-16T00:00:00Z" }) },
  })
  const route = load<Route>("../app/api/admin/session/route.ts", { "next/server": { NextResponse }, "@/lib/adminAuth": auth })
  const response = await route.GET()
  assert.match(response.headers.get("cache-control") || "", /private, no-store/)
  await assertOwnerResponse(response, "fcuno")
  assert.equal("actorKey" in await auth.getAdminSession(), false)
  signedIn = false
  const out = await (await route.GET()).json()
  assert.equal(out.authenticated, false); assert.equal(out.actorKey, null)
})

test("actual FCUNO login selects the opaque fingerprint rather than internal account metadata", async () => {
  const route = load<Route>("../app/api/admin/login/route.ts", { ...ownerDependency, "next/server": { NextResponse },
    "@/lib/adminAuth": { validateAdminCredentials: async () => user, setAdminSession: async () => undefined } })
  await assertOwnerResponse(await route.POST(request({ username: user.username, password: "synthetic-only" })), "fcuno", true)
})

test("actual SPC session selects an opaque fingerprint and preserves private response policy", async () => {
  let signedIn = true
  const route = load<Route>("../app/api/spc/session/route.ts", { ...ownerDependency,
    "@/lib/spcAuth": { getRefreshedSpcSession: async () => ({ ...user, authenticated: signedIn, userId: signedIn ? id : null }) },
    "@/lib/spcPages": { SPC_PAGE_DEFINITIONS }, "@/lib/spcResponse": { spcPrivateJson } })
  const response = await route.GET(); assert.match(response.headers.get("cache-control") || "", /private, no-store/)
  await assertOwnerResponse(response, "spc")
  signedIn = false; assert.equal((await (await route.GET()).json()).actorKey, null)
})

test("actual SPC credential and MFA login responses keep tokens and stable IDs server-side", async () => {
  const common = { ...ownerDependency, "@/lib/spcPages": { SPC_PAGE_DEFINITIONS },
    "@/lib/trustedRequestContext": { createTrustedRequestContext: () => ({ sourceIp: "192.0.2.1", requestId: "synthetic", platformRequestId: null }) } }
  const route = load<Route>("../app/api/spc/login/route.ts", { ...common, "next/server": { NextResponse },
    "@/lib/spcAuth": { validateSpcCredentials: async () => user, setSpcSession: async () => undefined },
    "@/lib/spcLoginSecurity": { hashSpcLoginUsername: () => "synthetic-hash", beginSpcLoginAttempt: async () => ({ allowed: true, attemptId: "synthetic-attempt" }), completeSpcLoginAttempt: async () => undefined },
    "@/lib/spcWhatsappLoginMfa": { requiresSpcWhatsappLoginMfa: () => false } })
  await assertOwnerResponse(await route.POST(request({ username: user.username, password: "synthetic-only" })), "spc", true)
  const mfa = load<Route>("../app/api/spc/login/mfa/verify/route.ts", { ...common,
    "@/lib/spcResponse": { spcPrivateJson }, "@/lib/spcAuth": { setSpcVerifiedSession: async () => undefined },
    "@/lib/spcSessions": { revokeDatabaseSpcSession: async () => undefined }, "@/lib/spcUsers": { getDatabaseSpcUserById: async () => user },
    "@/lib/spcWhatsappLoginMfa": { isSameOriginSpcWhatsappLoginMfaRequest: () => true, isSpcWhatsappLoginMfaEnabled: () => true,
      isSpcWhatsappLoginMfaConfigured: () => true, requiresSpcWhatsappLoginMfa: () => true, clearSpcWhatsappLoginMfaPendingCookie: async () => undefined,
      verifySpcWhatsappLoginMfaCode: async () => ({ result: "verified", sessionToken: "NEVER-BROWSER", spcUserId: id, userUpdatedAt: user.credentialUpdatedAt }) } })
  await assertOwnerResponse(await mfa.POST(request({ code: "123456" })), "spc", true)
})

test("actual password-change ACK selects browser ownership without exposing credentials", async () => {
  const route = load<Route>("../app/api/spc/password/route.ts", { ...ownerDependency, "@/lib/spcResponse": { spcPrivateJson },
    "@/lib/spcAuth": { requireSpcSession: async () => ({ ...user, userId: id }), setSpcSession: async () => undefined },
    "@/lib/spcUsers": { changeManagedSpcUserPassword: async () => user },
    "@/lib/spcAudit": { createSpcAuditContext: () => ({ correlationId: "synthetic" }), recordSpcUserManagementAuditEvent: async () => undefined } })
  await assertOwnerResponse(await route.POST(request({ password: "synthetic-only" })), "spc", true)
})
