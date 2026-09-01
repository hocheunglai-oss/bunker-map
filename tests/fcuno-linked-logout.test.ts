import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import {
  createAdminSessionToken,
  hashAdminSessionToken,
  revokeDatabaseAdminSessionAndLinkedSpcSessions,
} from "@/lib/adminSessions"
import { createDatabaseSpcSessionFromFcuno } from "@/lib/spcSessions"

const migration = readFileSync(
  new URL(
    "../supabase/migrations/20260901034742_revoke_linked_spc_sessions_on_fcuno_logout.sql",
    import.meta.url,
  ),
  "utf8",
)
const baseline = readFileSync(
  new URL("../supabase/spc_schema.sql", import.meta.url),
  "utf8",
)
const baselineLinkedLogout = baseline.slice(
  baseline.indexOf("-- BEGIN FCUNO LINKED SINGLE LOGOUT"),
  baseline.indexOf("-- END FCUNO LINKED SINGLE LOGOUT"),
)
const adminAuthSource = readFileSync(
  new URL("../lib/adminAuth.ts", import.meta.url),
  "utf8",
)
const adminLogoutSource = readFileSync(
  new URL("../app/api/admin/logout/route.ts", import.meta.url),
  "utf8",
)
const adminNavigationSource = readFileSync(
  new URL("../components/AdminNavigationShell.tsx", import.meta.url),
  "utf8",
)
const spcAuthSource = readFileSync(
  new URL("../lib/spcAuth.ts", import.meta.url),
  "utf8",
)
const fcunoLoginSource = readFileSync(
  new URL("../app/api/spc/fcuno-login/route.ts", import.meta.url),
  "utf8",
)
const spcClientAuthSource = readFileSync(
  new URL("../lib/useSpcAuth.ts", import.meta.url),
  "utf8",
)

test("FCUNO logout atomically revokes the admin session and only its linked SPC identity", () => {
  for (const sql of [migration, baselineLinkedLogout]) {
    assert.match(
      sql,
      /create or replace function public\.revoke_fcuno_session_and_linked_spc_sessions\(/,
    )
    assert.match(sql, /language plpgsql\s+security invoker/)
    assert.match(
      sql,
      /update public\.admin_sessions as sessions[\s\S]*?returning sessions\.admin_user_id into linked_admin_user_id;[\s\S]*?update public\.spc_sessions as sessions/,
    )
    assert.match(
      sql,
      /from public\.spc_identity_links as links[\s\S]*?links\.admin_user_id = linked_admin_user_id[\s\S]*?sessions\.spc_user_id = links\.spc_user_id/,
    )
    assert.doesNotMatch(sql, /update public\.spc_users/)
    assert.match(
      sql,
      /revoke all on function public\.revoke_fcuno_session_and_linked_spc_sessions\(text\)[\s\S]*?from public, anon, authenticated, service_role;[\s\S]*?grant execute[\s\S]*?to service_role;/,
    )
  }
})

test("FCUNO-linked SPC creation serializes against logout and rechecks every authority", () => {
  for (const sql of [migration, baselineLinkedLogout]) {
    assert.match(
      sql,
      /create or replace function public\.create_fcuno_linked_spc_session\(/,
    )
    assert.match(
      sql,
      /from public\.admin_sessions as sessions[\s\S]*?join public\.admin_users as users[\s\S]*?join public\.spc_identity_links as links/,
    )
    assert.match(sql, /sessions\.revoked_at is null/)
    assert.match(sql, /sessions\.expires_at > current_time_value/)
    assert.match(sql, /users\.is_active = true/)
    assert.match(sql, /users\.use_spc = true/)
    assert.match(sql, /users\.email_verified = true/)
    assert.match(sql, /for update of sessions;/)
    assert.match(
      sql,
      /revoke all on function public\.create_fcuno_linked_spc_session\([\s\S]*?from public, anon, authenticated, service_role;[\s\S]*?grant execute[\s\S]*?to service_role;/,
    )
  }
})

test("the linked logout and race-safe login paths are wired end to end", () => {
  assert.match(adminAuthSource, /clearAdminAndLinkedSpcSessions/)
  assert.match(
    adminAuthSource,
    /revokeDatabaseAdminSessionAndLinkedSpcSessions\(token\)/,
  )
  assert.match(adminLogoutSource, /await clearAdminAndLinkedSpcSessions\(\)/)
  assert.match(adminAuthSource, /sessionId: resolved\.sessionId/)
  assert.match(spcAuthSource, /createDatabaseSpcSessionFromFcuno/)
  assert.match(spcAuthSource, /options\.fcunoAdminSessionId/)
  assert.match(
    fcunoLoginSource,
    /setSpcSession\(user, \{ fcunoAdminSessionId: session\.sessionId \}\)/,
  )
})

test("admin logout does not claim success when linked revocation fails", () => {
  assert.match(
    adminNavigationSource,
    /fetch\("\/api\/admin\/logout", \{ method: "POST" \}\)[\s\S]*?response\.ok/,
  )
  assert.match(adminNavigationSource, /if \(!loggedOut\)/)
  assert.match(adminNavigationSource, /Unable to log out\. Please try again\./)
})

test("an SPC tab bypasses its normal cache whenever it regains focus", () => {
  assert.match(
    spcClientAuthSource,
    /function refreshActiveSession\(\) \{\s*void checkSession\(0\)\s*\}/,
  )
  assert.match(
    spcClientAuthSource,
    /window\.addEventListener\("focus", refreshActiveSession\)/,
  )
  assert.match(
    spcClientAuthSource,
    /document\.addEventListener\("visibilitychange", handleVisibilityChange\)/,
  )
  assert.match(spcClientAuthSource, /SPC_SESSION_CACHE_MS = 30_000/)
})

test("linked logout sends only the SHA-256 admin token hash to Supabase", async () => {
  const originalSupabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const originalServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const originalFetch = globalThis.fetch
  const token = createAdminSessionToken()
  let capturedUrl = ""
  let capturedBody: Record<string, unknown> = {}

  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://linked-logout-test.supabase.co"
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test-key"
  globalThis.fetch = async (input, init) => {
    capturedUrl =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url
    capturedBody = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>
    return new Response("true", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  }

  try {
    assert.equal(
      await revokeDatabaseAdminSessionAndLinkedSpcSessions(token),
      true,
    )
    assert.match(
      capturedUrl,
      /\/rest\/v1\/rpc\/revoke_fcuno_session_and_linked_spc_sessions/,
    )
    assert.equal(capturedBody.p_token_hash, hashAdminSessionToken(token))
    assert.notEqual(capturedBody.p_token_hash, token)
    assert.doesNotMatch(JSON.stringify(capturedBody), new RegExp(token))
  } finally {
    globalThis.fetch = originalFetch
    if (originalSupabaseUrl === undefined) {
      delete process.env.NEXT_PUBLIC_SUPABASE_URL
    } else {
      process.env.NEXT_PUBLIC_SUPABASE_URL = originalSupabaseUrl
    }
    if (originalServiceRoleKey === undefined) {
      delete process.env.SUPABASE_SERVICE_ROLE_KEY
    } else {
      process.env.SUPABASE_SERVICE_ROLE_KEY = originalServiceRoleKey
    }
  }
})

test("FCUNO-linked SPC creation rejects an invalid admin session before database access", async () => {
  await assert.rejects(
    createDatabaseSpcSessionFromFcuno(
      "not-a-session-id",
      "10000000-0000-4000-8000-000000000001",
      "2026-09-01T03:47:42.000Z",
    ),
    /verified FCUNO-linked SPC session is invalid/,
  )
})
