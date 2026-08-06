import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import {
  hasSpcAdminPagePermission,
  type SpcSession,
} from "../lib/spcAuth"
import {
  constrainSpcPermissionForRole,
  getDefaultSpcPermissionsForRole,
} from "../lib/spcPages"
import {
  getSpcPasswordValidationError,
  wouldRemoveFinalActiveSpcAdmin,
} from "../lib/spcUsers"
import {
  SPC_SESSION_DURATION_SECONDS,
  createSpcSessionToken,
  getSpcSessionExpiry,
  getDatabaseSpcSession,
  hashSpcSessionToken,
  isPlausibleSpcSessionToken,
} from "../lib/spcSessions"

function session(input: Partial<SpcSession> = {}): SpcSession {
  return {
    authenticated: true,
    username: "buyer@example.com",
    displayName: "Buyer",
    role: "BUYER TRADER",
    office: "HONG KONG",
    mustChangePassword: false,
    permissions: {
      "spc-user-management": "edit",
      "spc-audit-log": "edit",
    },
    ...input,
  }
}

test("SPC sessions use random 32-byte bearer tokens and stable hashes", () => {
  const first = createSpcSessionToken()
  const second = createSpcSessionToken()

  assert.match(first, /^[A-Za-z0-9_-]{43}$/)
  assert.match(second, /^[A-Za-z0-9_-]{43}$/)
  assert.notEqual(first, second)
  assert.match(hashSpcSessionToken(first), /^[0-9a-f]{64}$/)
  assert.equal(hashSpcSessionToken(first), hashSpcSessionToken(first))
  assert.notEqual(hashSpcSessionToken(first), hashSpcSessionToken(second))
})

test("SPC sessions have a fixed 12-hour expiry", () => {
  const now = new Date("2026-08-06T03:00:00.000Z")
  const expiresAt = new Date(getSpcSessionExpiry(now))

  assert.equal(SPC_SESSION_DURATION_SECONDS, 12 * 60 * 60)
  assert.equal(
    expiresAt.getTime() - now.getTime(),
    SPC_SESSION_DURATION_SECONDS * 1000,
  )
})

test("legacy marker and username-cookie values fail closed without a database lookup", async () => {
  assert.equal(isPlausibleSpcSessionToken("1"), false)
  assert.equal(isPlausibleSpcSessionToken("buyer@example.com"), false)
  assert.equal(await getDatabaseSpcSession("1"), null)
})

test("SPC user administration requires ADMIN role and page permission", () => {
  assert.equal(hasSpcAdminPagePermission(session(), "view"), false)
  assert.equal(
    hasSpcAdminPagePermission(
      session({ role: "ADMIN", permissions: { "spc-user-management": "view" } }),
      "view",
    ),
    true,
  )
  assert.equal(
    hasSpcAdminPagePermission(
      session({ role: "ADMIN", permissions: { "spc-user-management": "view" } }),
      "edit",
    ),
    false,
  )
  assert.equal(
    hasSpcAdminPagePermission(
      session({
        role: "ADMIN",
        mustChangePassword: true,
        permissions: { "spc-user-management": "edit" },
      }),
      "edit",
    ),
    false,
  )
})

test("BUYER TRADER cannot manage users or undo audit records by default", () => {
  const permissions = getDefaultSpcPermissionsForRole("BUYER TRADER")
  assert.equal(permissions["spc-user-management"], "none")
  assert.equal(permissions["spc-audit-log"], "view")
  assert.equal(
    constrainSpcPermissionForRole("BUYER TRADER", "spc-user-management", "edit"),
    "none",
  )
  assert.equal(
    constrainSpcPermissionForRole("BUYER TRADER", "spc-audit-log", "edit"),
    "view",
  )
})

test("the final active SPC ADMIN cannot be demoted, deactivated, or deleted", () => {
  const users = [
    { id: "admin-1", role: "ADMIN", isActive: true },
    { id: "buyer-1", role: "BUYER TRADER", isActive: true },
  ]

  assert.equal(
    wouldRemoveFinalActiveSpcAdmin(users, "admin-1", "BUYER TRADER", true),
    true,
  )
  assert.equal(
    wouldRemoveFinalActiveSpcAdmin(users, "admin-1", "ADMIN", false),
    true,
  )
  assert.equal(
    wouldRemoveFinalActiveSpcAdmin(users, "admin-1", null, false),
    true,
  )
  assert.equal(
    wouldRemoveFinalActiveSpcAdmin(
      [...users, { id: "admin-2", role: "ADMIN", isActive: true }],
      "admin-1",
      null,
      false,
    ),
    false,
  )
})

test("new and changed SPC passwords must contain 12 to 256 characters", () => {
  assert.match(getSpcPasswordValidationError("") || "", /required/i)
  assert.match(getSpcPasswordValidationError("too-short") || "", /at least 12/i)
  assert.equal(getSpcPasswordValidationError("correct horse battery staple"), null)
  assert.equal(getSpcPasswordValidationError("x".repeat(256)), null)
  assert.match(getSpcPasswordValidationError("x".repeat(257)) || "", /no more than 256/i)
})

test("SPC routes enforce the administrator guard at the direct API boundary", () => {
  const usersRoute = readFileSync(
    new URL("../app/api/spc/users/route.ts", import.meta.url),
    "utf8",
  )
  const auditRoute = readFileSync(
    new URL("../app/api/spc/audit-logs/route.ts", import.meta.url),
    "utf8",
  )

  assert.match(
    usersRoute,
    /requireSpcAdminPagePermission\("(?:spc-user-management)", "view"\)/,
  )
  assert.match(
    usersRoute,
    /if \(!hasSpcAdminPagePermission\(session, "edit"\)\)/,
  )
  assert.match(usersRoute, /recordSpcUserManagementAuditEvent\(auditContext/)
  assert.match(usersRoute, /outcome: "denied"/)
  assert.match(usersRoute, /\.\.\.auditContext, outcome: "failed"/)
  assert.match(auditRoute, /isSpcUserManagementAuditRecord\(target\)/)
  assert.match(auditRoute, /hasSpcRole\(session, "ADMIN"\)/)
})

test("SPC authentication trusts only the opaque database session token", () => {
  const authSource = readFileSync(
    new URL("../lib/spcAuth.ts", import.meta.url),
    "utf8",
  )
  const sessionSource = readFileSync(
    new URL("../lib/spcSessions.ts", import.meta.url),
    "utf8",
  )

  assert.match(authSource, /getDatabaseSpcSession\(token\)/)
  assert.match(authSource, /getDatabaseSpcUserById\(databaseSession\.spcUserId\)/)
  assert.doesNotMatch(authSource, /getDatabaseSpcUserByUsername/)
  assert.doesNotMatch(authSource, /cookieStore\.set\(SPC_COOKIE_NAME,\s*"1"/)
  assert.match(sessionSource, /\.is\("revoked_at", null\)/)
  assert.match(sessionSource, /revokeDatabaseSpcSession/)
})

test("SPC session migration is version-bound, private, revocable, and fixed to 12 hours", () => {
  const migration = readFileSync(
    new URL(
      "../supabase/migrations/20260806105956_secure_spc_sessions_and_user_administration.sql",
      import.meta.url,
    ),
    "utf8",
  )

  assert.match(migration, /create table public\.spc_sessions/)
  assert.match(migration, /token_hash text not null unique/)
  assert.match(migration, /user_updated_at timestamptz not null/)
  assert.match(migration, /users\.updated_at = p_observed_user_updated_at/)
  assert.match(migration, /users\.is_active/)
  assert.match(migration, /interval '12 hours'/)
  assert.match(migration, /interval '30 days'/)
  assert.match(migration, /limit 1000/)
  assert.match(migration, /revoked_at timestamptz/)
  assert.match(migration, /alter table public\.spc_sessions enable row level security/)
  assert.match(
    migration,
    /revoke all privileges on table public\.spc_sessions[\s\S]*from public, anon, authenticated, service_role/,
  )
  assert.match(
    migration,
    /grant select, update, delete on table public\.spc_sessions[\s\S]*to service_role/,
  )
})

test("SPC user lifecycle is atomic and the final ADMIN invariant is database-enforced", () => {
  const usersSource = readFileSync(
    new URL("../lib/spcUsers.ts", import.meta.url),
    "utf8",
  )
  const migration = readFileSync(
    new URL(
      "../supabase/migrations/20260806203000_enforce_spc_admin_continuity.sql",
      import.meta.url,
    ),
    "utf8",
  )
  const canonicalSchema = readFileSync(
    new URL("../supabase/spc_schema.sql", import.meta.url),
    "utf8",
  )
  const canonicalMarker = "-- Make SPC user rows and their role/profile metadata one atomic security"

  assert.match(usersSource, /\.rpc\("save_spc_user_with_admin_continuity"/)
  assert.match(usersSource, /"delete_spc_user_with_admin_continuity"/)
  assert.doesNotMatch(
    usersSource,
    /const query = input\.id[\s\S]*?\.from\("spc_users"\)\.insert/,
  )

  assert.match(migration, /pg_advisory_xact_lock/)
  assert.match(migration, /deferrable initially deferred/)
  assert.match(migration, /to_jsonb\(new\) ->> 'key'/)
  assert.match(migration, /to_jsonb\(old\) ->> 'key'/)
  assert.doesNotMatch(migration, /coalesce\(new\.key, old\.key\)/)
  assert.match(migration, /when is_new then true/)
  assert.match(migration, /perform private\.assert_spc_active_admin\(\)/)
  assert.match(migration, /Username must contain no more than 320 characters\./)
  assert.match(migration, /Display name must contain no more than 256 characters\./)
  assert.match(migration, /Office must contain no more than 128 characters\./)
  assert.match(
    migration,
    /revoke all on function public\.save_spc_user_with_admin_continuity[\s\S]*from public, anon, authenticated, service_role;[\s\S]*grant execute[\s\S]*to service_role;/,
  )
  assert.doesNotMatch(
    migration.match(/returns table \([\s\S]*?\)\nlanguage plpgsql/)?.[0] || "",
    /password_hash/,
  )
  assert.match(
    migration,
    /revoke truncate on table public\.spc_users[\s\S]*from public, anon, authenticated, service_role/,
  )
  assert.match(
    migration,
    /revoke truncate on table public\.office_calendar_store[\s\S]*from public, anon, authenticated, service_role/,
  )

  assert.equal(
    canonicalSchema.slice(canonicalSchema.indexOf(canonicalMarker)).trim(),
    migration.trim(),
  )
})
