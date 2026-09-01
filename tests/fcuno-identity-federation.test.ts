import assert from "node:assert/strict"
import { createHash, generateKeyPairSync } from "node:crypto"
import { readFileSync } from "node:fs"
import test from "node:test"
import {
  OIDC_AUTH_CODE_TTL_SECONDS,
  OIDC_MAX_AUTH_AGE_SECONDS,
  createAuthorizationCode,
  hashOidcValue,
  issueOidcToken,
  isFreshOidcAuthentication,
  normaliseScope,
  validatePkceChallenge,
  verifyPkceS256,
  verifyOidcToken,
} from "@/lib/fcunoOidc"
import { normaliseOidcAuthorizeReturnTo } from "@/lib/fcunoOidcContinuation"
import { isFcosIdentitySyncEnabled, isFcunoOidcEnabled } from "@/lib/fcunoFederationFlags"
import { ADMIN_PAGE_DEFINITIONS } from "@/lib/adminPages"

const migration = readFileSync(
  new URL("../supabase/migrations/20260831090000_fcuno_identity_federation.sql", import.meta.url),
  "utf8",
)
const oidcDigestFixMigration = readFileSync(
  new URL("../supabase/migrations/20260831090100_fix_oidc_pkce_digest_schema.sql", import.meta.url),
  "utf8",
)
const syncSource = readFileSync(
  new URL("../lib/fcunoIdentitySync.ts", import.meta.url),
  "utf8",
)
const authorizeSource = readFileSync(
  new URL("../app/api/oidc/authorize/route.ts", import.meta.url),
  "utf8",
)
const discoverySource = readFileSync(
  new URL("../app/.well-known/openid-configuration/route.ts", import.meta.url),
  "utf8",
)
const jwksSource = readFileSync(new URL("../app/api/oidc/jwks/route.ts", import.meta.url), "utf8")
const syncJwksSource = readFileSync(
  new URL("../app/api/fcos-identity-sync/jwks/route.ts", import.meta.url),
  "utf8",
)
const tokenSource = readFileSync(new URL("../app/api/oidc/token/route.ts", import.meta.url), "utf8")
const userinfoSource = readFileSync(new URL("../app/api/oidc/userinfo/route.ts", import.meta.url), "utf8")
const revokeSource = readFileSync(new URL("../app/api/oidc/revoke/route.ts", import.meta.url), "utf8")
const syncRouteSource = readFileSync(
  new URL("../app/api/cron/fcos-identity-sync/route.ts", import.meta.url),
  "utf8",
)
const userManagementSource = readFileSync(
  new URL("../app/admin/usermanagement/page.tsx", import.meta.url),
  "utf8",
)
const adminUsersSource = readFileSync(
  new URL("../lib/adminUsers.ts", import.meta.url),
  "utf8",
)
const spcAuthSource = readFileSync(
  new URL("../lib/spcAuth.ts", import.meta.url),
  "utf8",
)
const spcLoginSource = readFileSync(
  new URL("../app/api/spc/fcuno-login/route.ts", import.meta.url),
  "utf8",
)
const adminAuthSource = readFileSync(
  new URL("../lib/adminAuth.ts", import.meta.url),
  "utf8",
)
const spcUserManagementSource = readFileSync(
  new URL("../app/spc/usermanagement/page.tsx", import.meta.url),
  "utf8",
)
const spcPageSource = readFileSync(
  new URL("../app/spc/page.tsx", import.meta.url),
  "utf8",
)

test("OIDC codes are random, SHA-256 stored, short lived, and PKCE S256-bound", () => {
  const code = createAuthorizationCode()
  assert.match(code, /^[A-Za-z0-9_-]{43}$/)
  assert.match(hashOidcValue(code), /^[0-9a-f]{64}$/)
  assert.equal(OIDC_AUTH_CODE_TTL_SECONDS, 60)
  const verifier = "a".repeat(43)
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  assert.equal(validatePkceChallenge(challenge), true)
  assert.equal(verifyPkceS256(verifier, challenge), true)
  assert.equal(verifyPkceS256("b".repeat(43), challenge), false)
})

test("OIDC accepts only an explicit openid scope and fresh FCUNO authentication", () => {
  assert.equal(normaliseScope("email openid profile email"), "email openid profile")
  assert.throws(() => normaliseScope("profile"), /invalid_scope/)
  assert.throws(() => normaliseScope("openid offline_access"), /invalid_scope/)
  const now = Date.parse("2026-08-31T09:00:00.000Z")
  assert.equal(isFreshOidcAuthentication(new Date(now - OIDC_MAX_AUTH_AGE_SECONDS * 1000).toISOString(), now), true)
  assert.equal(isFreshOidcAuthentication(new Date(now - (OIDC_MAX_AUTH_AGE_SECONDS + 1) * 1000).toISOString(), now), false)
})

test("federation endpoints and delivery remain explicitly disabled by default", () => {
  assert.equal(isFcunoOidcEnabled({}), false)
  assert.equal(isFcunoOidcEnabled({ FCUNO_OIDC_ENABLED: "false" }), false)
  assert.equal(isFcunoOidcEnabled({ FCUNO_OIDC_ENABLED: "TRUE" }), false)
  assert.equal(isFcunoOidcEnabled({ FCUNO_OIDC_ENABLED: "true" }), true)
  assert.equal(isFcosIdentitySyncEnabled({}), false)
  assert.equal(isFcosIdentitySyncEnabled({ FCUNO_FCOS_IDENTITY_SYNC_ENABLED: "true" }), true)

  for (const source of [discoverySource, authorizeSource, jwksSource, tokenSource, userinfoSource, revokeSource]) {
    assert.match(source, /if \(!isFcunoOidcEnabled\(\)\) return federationNotFound\(\)/)
  }
  assert.match(syncJwksSource, /if \(!isFcosIdentitySyncEnabled\(\)\) return federationNotFound\(\)/)
  assert.doesNotMatch(syncJwksSource, /isFcunoOidcEnabled/)
  assert.match(syncRouteSource, /if \(!isFcosIdentitySyncEnabled\(\)\)/)
  assert.match(syncRouteSource, /disabled: true, processed: 0/)
  assert.ok(syncRouteSource.indexOf("!isFcosIdentitySyncEnabled()") < syncRouteSource.indexOf("processFcunoIdentitySyncOutbox()"))
})

test("OIDC emits and verifies an ES256 JWT with a stable event id", () => {
  const names = ["FCUNO_OIDC_ISSUER", "FCUNO_OIDC_ES256_CURRENT_KID", "FCUNO_OIDC_ES256_CURRENT_PRIVATE_KEY", "FCUNO_OIDC_ES256_NEXT_KID", "FCUNO_OIDC_ES256_NEXT_PRIVATE_KEY"] as const
  const before = new Map(names.map((name) => [name, process.env[name]]))
  const current = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
  const next = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
  try {
    process.env.FCUNO_OIDC_ISSUER = "https://fcuno.example"
    process.env.FCUNO_OIDC_ES256_CURRENT_KID = "fcuno-current"
    process.env.FCUNO_OIDC_ES256_CURRENT_PRIVATE_KEY = current.privateKey.export({ type: "pkcs8", format: "pem" }).toString()
    process.env.FCUNO_OIDC_ES256_NEXT_KID = "fcuno-next"
    process.env.FCUNO_OIDC_ES256_NEXT_PRIVATE_KEY = next.privateKey.export({ type: "pkcs8", format: "pem" }).toString()
    const token = issueOidcToken({ sub: "00000000-0000-4000-8000-000000000001", aud: "fcos-identity-sync", typ: "fcuno.identity-sync+jwt", jti: "00000000-0000-4000-8000-000000000002", expiresInSeconds: 5 * 60 })
    const claims = verifyOidcToken(token)
    assert.equal(claims?.aud, "fcos-identity-sync")
    assert.equal(claims?.typ, "fcuno.identity-sync+jwt")
    assert.equal(claims?.jti, "00000000-0000-4000-8000-000000000002")
  } finally {
    for (const name of names) {
      const value = before.get(name)
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})

test("federation storage is service-only and preserves application data boundaries", () => {
  assert.match(migration, /add column if not exists identity_revision bigint not null default 1/)
  assert.match(migration, /add column if not exists credential_revision bigint not null default 1/)
  assert.match(migration, /add column if not exists use_fcos boolean not null default false/)
  assert.match(migration, /add column if not exists use_spc boolean not null default false/)
  assert.match(migration, /default '1970-01-01T00:00:00Z'::timestamptz/)
  assert.match(migration, /set revoked_before = '1970-01-01T00:00:00Z'::timestamptz/)
  assert.match(migration, /create unique index if not exists admin_users_verified_email_lower_key/)
  assert.match(migration, /duplicate email-form usernames/)
  assert.match(migration, /set email = lower\(btrim\(username\)\),[\s\S]*?email_verified = true/)
  assert.match(migration, /insert into public\.fcuno_identity_sync_outbox[\s\S]*?from public\.admin_users as users/)
  assert.match(migration, /'sub', new\.id::text,[\s\S]*?'username', new\.username,[\s\S]*?'email', new\.email/)
  assert.match(migration, /revoke all on table public\.oidc_authorization_codes, public\.oidc_token_revocations,[\s\S]*?from public, anon, authenticated, service_role;/)
  assert.match(migration, /grant select, insert, update, delete on table public\.oidc_authorization_codes,[\s\S]*?public\.spc_identity_links to service_role;/)
  assert.match(migration, /create trigger fcuno_reject_identity_audit_mutation[\s\S]*?before update or delete on public\.fcuno_identity_audit/)
  assert.match(migration, /grant select, insert on table public\.fcuno_identity_audit to service_role;/)
  assert.match(migration, /Losing email verification must revoke a previously projected identity/)
  assert.match(migration, /'is_active', false,[\s\S]*?'use_fcos', false/)
  assert.match(migration, /FCUNO owns linked identity sign-in; SPC retains operational roles, offices, routes, permissions, and history/)
  assert.doesNotMatch(migration, /update public\.spc_users/)
})

test("OIDC code consumption uses the schema-qualified pgcrypto digest", () => {
  assert.match(oidcDigestFixMigration, /extensions\.digest\(convert_to\(p_code_verifier, 'UTF8'\), 'sha256'\)/)
  assert.match(oidcDigestFixMigration, /set search_path = pg_catalog, public, pg_temp/)
  assert.match(oidcDigestFixMigration, /grant execute on function public\.consume_oidc_authorization_code\(text, text, text, text\)[\s\S]*?to service_role/)
  assert.doesNotMatch(oidcDigestFixMigration, /encode\(digest\(/)
})

test("FCUNO User Management owns identity email and application entitlements", () => {
  assert.match(userManagementSource, /Identity Email/)
  assert.match(userManagementSource, /Email Verified/)
  assert.match(userManagementSource, /Use FCOS/)
  assert.match(userManagementSource, /Use SPC/)
  assert.match(adminUsersSource, /update_admin_user_identity_with_password_and_revoke_sessions/)
  assert.match(migration, /create or replace function public\.update_admin_user_identity_with_password_and_revoke_sessions/)
  assert.match(migration, /revoke all on function public\.update_admin_user_identity_with_password_and_revoke_sessions/)
})

test("the FCOS sidebar entry uses the application name while retaining its stable identity and URL", () => {
  const fcosPage = ADMIN_PAGE_DEFINITIONS.find((page) => page.id === "salesforce-data")
  assert.ok(fcosPage)
  assert.equal(fcosPage.label, "FCOS")
  assert.equal(fcosPage.path, "https://fcos.fcuno.com/")
  assert.equal(fcosPage.external, true)
})

test("linked SPC users use FCUNO identity while SPC keeps operational authority", () => {
  assert.match(migration, /create table if not exists public\.spc_identity_links/)
  assert.match(migration, /lower\(coalesce\(users\.email, users\.username\)\) = 'otto@cosulich\.com\.hk'/)
  assert.match(migration, /create trigger fcuno_revoke_linked_spc_sessions/)
  assert.match(spcAuthSource, /getFcunoLinkedSpcAccess/)
  assert.match(spcAuthSource, /return linkedAccess\.linked \? null : user/)
  assert.match(spcLoginSource, /requireAdminIdentitySession/)
  assert.match(spcLoginSource, /getFcunoLinkedSpcUser/)
  assert.match(spcUserManagementSource, /Identity and sign-in are managed in FCUNO/)
  assert.match(spcUserManagementSource, /SPC role, office, route, and page authority remain editable here/)
})

test("FCOS outbox uses a short ES256 JWT whose jti is the idempotency event id", () => {
  assert.match(syncSource, /issueOidcToken\(\{/)
  assert.match(syncSource, /aud: "fcos-identity-sync"/)
  assert.match(syncSource, /typ: "fcuno\.identity-sync\+jwt"/)
  assert.match(syncSource, /expiresInSeconds: 5 \* 60/)
  assert.match(syncSource, /jti: input\.eventId/)
  assert.match(syncSource, /identity: \{[\s\S]*?email_verified: true/)
  assert.match(syncSource, /identity: \{[\s\S]*?username: requiredString\(input\.payload, "username"\)/)
  assert.match(syncSource, /identity: \{[\s\S]*?display_name: requiredString\(input\.payload, "display_name"\)/)
  assert.doesNotMatch(syncSource, /FCOS_IDENTITY_SYNC_SHARED_SECRET|createHmac/)
  assert.match(syncSource, /"X-FCUNO-Event-Id": row\.id/)
  assert.match(syncSource, /Authorization: `Bearer \$\{token\}`/)
  assert.match(syncSource, /body: "\{\}"/)
  assert.match(syncSource, /redirect: "error"/)
})

test("OIDC login continuation admits only local requests and the exact SPC handoff", () => {
  const origin = "https://fcuno.example"
  const valid = "/api/oidc/authorize?client_id=fcos&state=preserved"
  assert.equal(normaliseOidcAuthorizeReturnTo(valid, origin), valid)
  assert.equal(normaliseOidcAuthorizeReturnTo("https://attacker.example/api/oidc/authorize?x=1", origin), null)
  assert.equal(normaliseOidcAuthorizeReturnTo("//attacker.example/api/oidc/authorize?x=1", origin), null)
  assert.equal(normaliseOidcAuthorizeReturnTo("/admin?returnTo=evil", origin), null)
  assert.equal(normaliseOidcAuthorizeReturnTo("/api/oidc/authorize?x=1#fragment", origin), null)
  assert.equal(normaliseOidcAuthorizeReturnTo("/api/spc/fcuno-login", origin), "/api/spc/fcuno-login")
  assert.equal(
    normaliseOidcAuthorizeReturnTo("https://spc.fcuno.com/api/spc/fcuno-login", "https://fcuno.com"),
    "https://spc.fcuno.com/api/spc/fcuno-login",
  )
  assert.equal(normaliseOidcAuthorizeReturnTo("http://spc.fcuno.com/api/spc/fcuno-login", "https://fcuno.com"), null)
  assert.equal(normaliseOidcAuthorizeReturnTo("https://spc.fcuno.com/api/spc/fcuno-login?next=evil", "https://fcuno.com"), null)
})

test("FCUNO shares only its admin identity cookie for the trusted SPC handoff", () => {
  assert.match(adminAuthSource, /domain: "\.fcuno\.com"/)
  assert.match(adminAuthSource, /expiredHostOnlyCookieOptions/)
  assert.match(spcLoginSource, /new URL\("\/admin", "https:\/\/fcuno\.com"\)/)
  assert.match(spcLoginSource, /new URL\("\/api\/spc\/fcuno-login", request\.url\)\.toString\(\)/)
})

test("SPC silently resumes an active FCUNO session without showing an extra button", () => {
  assert.match(spcLoginSource, /searchParams\.get\("silent"\) === "1"/)
  assert.match(spcLoginSource, /NextResponse\.json\(\{ authenticated: false \}, \{ status: 401 \}\)/)
  assert.match(spcPageSource, /fetch\("\/api\/spc\/fcuno-login\?silent=1"/)
  assert.match(spcPageSource, /window\.location\.replace\("\/spc"\)/)
  assert.doesNotMatch(spcPageSource, />\s*Continue with FCUNO\s*</)
})

test("OIDC authorization accepts Supabase code flow without a nonce", () => {
  assert.match(authorizeSource, /const nonce = params\.has\("nonce"\) \? parameter\(params, "nonce"\) : null/)
  assert.match(authorizeSource, /nonce !== null && \(nonce\.length < 16 \|\| nonce\.length > 512\)/)
  assert.doesNotMatch(authorizeSource, /const nonce = parameter\(params, "nonce"\)/)
})

test("stale OIDC authentication cannot loop through the long-lived admin session", () => {
  assert.match(authorizeSource, /if \(!isFreshOidcAuthentication\(session\.authTime\)\)/)
  assert.match(authorizeSource, /await clearAdminSession\(\)/)
  assert.match(authorizeSource, /return interactiveLoginRedirect\(request\)/)
})

test("an explicit OIDC login prompt requires fresh FCUNO account entry", () => {
  assert.match(authorizeSource, /prompts\.includes\("login"\) \|\| prompts\.includes\("select_account"\)/)
  assert.match(authorizeSource, /if \(promptRequiresFreshLogin\(params\)\) \{[\s\S]*?await clearAdminSession\(\)[\s\S]*?return interactiveLoginRedirect\(request\)/)
})
