import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import {
  ADMIN_SESSION_DURATION_SECONDS,
  OUTLOOK_ADDIN_SESSION_DURATION_SECONDS,
  createAdminSessionToken,
  createDatabaseAdminSession,
  getDatabaseAdminSession,
  getAdminSessionExpiry,
  hashAdminSessionToken,
  revokeDatabaseAdminSession,
  shouldRenewAdminSession,
} from "@/lib/adminSessions"
import { getAdminPasswordValidationError } from "@/lib/adminUsers"

test("admin session tokens are random bearer secrets stored as stable hashes", () => {
  const first = createAdminSessionToken()
  const second = createAdminSessionToken()

  assert.match(first, /^[A-Za-z0-9_-]{40,}$/)
  assert.match(second, /^[A-Za-z0-9_-]{40,}$/)
  assert.notEqual(first, second)
  assert.match(hashAdminSessionToken(first), /^[0-9a-f]{64}$/)
  assert.equal(hashAdminSessionToken(first), hashAdminSessionToken(first))
  assert.notEqual(hashAdminSessionToken(first), hashAdminSessionToken(second))
})

test("admin sessions use the browser maximum persistent-cookie lifetime", () => {
  const now = new Date("2026-07-23T12:00:00.000Z")
  const expiresAt = new Date(getAdminSessionExpiry(now))

  assert.equal(ADMIN_SESSION_DURATION_SECONDS, 400 * 24 * 60 * 60)
  assert.equal(
    expiresAt.getTime() - now.getTime(),
    ADMIN_SESSION_DURATION_SECONDS * 1000,
  )
})

test("Outlook add-in sessions use the browser-maximum renewable expiry", () => {
  const now = new Date("2026-07-23T12:00:00.000Z")
  const expiresAt = new Date(
    getAdminSessionExpiry(now, OUTLOOK_ADDIN_SESSION_DURATION_SECONDS),
  )

  assert.equal(
    OUTLOOK_ADDIN_SESSION_DURATION_SECONDS,
    ADMIN_SESSION_DURATION_SECONDS,
  )
  assert.equal(
    expiresAt.getTime() - now.getTime(),
    OUTLOOK_ADDIN_SESSION_DURATION_SECONDS * 1000,
  )
  assert.throws(
    () => getAdminSessionExpiry(now, ADMIN_SESSION_DURATION_SECONDS + 1),
    /duration is invalid/,
  )
})

test("legacy short Outlook sessions renew immediately without over-touching fresh sessions", () => {
  const now = new Date("2026-07-28T04:00:00.000Z")
  const recent = new Date(now.getTime() - 5 * 60 * 1000).toISOString()
  const thirtyMinutes = new Date(now.getTime() + 30 * 60 * 1000).toISOString()
  const fourHundredDays = new Date(
    now.getTime() + ADMIN_SESSION_DURATION_SECONDS * 1000,
  ).toISOString()
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString()

  assert.equal(
    shouldRenewAdminSession(now, recent, thirtyMinutes),
    true,
  )
  assert.equal(
    shouldRenewAdminSession(now, recent, fourHundredDays),
    false,
  )
  assert.equal(
    shouldRenewAdminSession(now, oneHourAgo, fourHundredDays),
    true,
  )
})

test("legacy constant cookies fail closed before any database lookup", async () => {
  assert.equal(await getDatabaseAdminSession("1"), null)
  assert.equal(await revokeDatabaseAdminSession("1"), false)
})

test("session creation sends the password-verified user version to the RPC", async () => {
  const originalSupabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const originalServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const originalFetch = globalThis.fetch
  const observedUpdatedAt = "2026-07-23T12:34:56.123456Z"
  const expiresAt = "2026-07-23T13:04:56.123456Z"
  let capturedUrl = ""
  let capturedBody: Record<string, unknown> = {}

  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://session-race-test.supabase.co"
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test-key"
  globalThis.fetch = async (input, init) => {
    capturedUrl =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url
    capturedBody = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>

    return new Response(
      JSON.stringify({
        id: "20000000-0000-4000-8000-000000000001",
        expires_at: expiresAt,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    )
  }

  try {
    const session = await createDatabaseAdminSession(
      "10000000-0000-4000-8000-000000000001",
      observedUpdatedAt,
      OUTLOOK_ADDIN_SESSION_DURATION_SECONDS,
    )

    assert.match(capturedUrl, /\/rest\/v1\/rpc\/create_admin_session/)
    assert.equal(
      capturedBody.p_admin_user_id,
      "10000000-0000-4000-8000-000000000001",
    )
    assert.equal(
      capturedBody.p_observed_user_updated_at,
      observedUpdatedAt,
    )
    assert.equal(
      capturedBody.p_duration_seconds,
      OUTLOOK_ADDIN_SESSION_DURATION_SECONDS,
    )
    assert.match(String(capturedBody.p_token_hash), /^[0-9a-f]{64}$/)
    assert.equal(
      capturedBody.p_token_hash,
      hashAdminSessionToken(session.token),
    )
    assert.equal(session.expiresAt, expiresAt)
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

test("database race guard serializes password rotation against session issuance", () => {
  const migration = readFileSync(
    new URL(
      "../supabase/migrations/20260723131143_admin_session_password_rotation_race_guard.sql",
      import.meta.url,
    ),
    "utf8",
  )
  const baseline = readFileSync(
    new URL("../supabase/admin_users.sql", import.meta.url),
    "utf8",
  )

  for (const sql of [migration, baseline]) {
    assert.match(
      sql,
      /create or replace function public\.create_admin_session\([\s\S]*?users\.updated_at = p_observed_user_updated_at[\s\S]*?for update;[\s\S]*?insert into public\.admin_sessions/,
    )
    assert.match(
      sql,
      /drop trigger if exists set_admin_users_updated_at on public\.admin_users;[\s\S]*?create trigger set_admin_users_updated_at[\s\S]*?before update on public\.admin_users[\s\S]*?execute function public\.set_admin_users_updated_at\(\);/,
    )
    assert.match(
      sql,
      /create or replace function public\.update_admin_user_with_password_and_revoke_sessions\([\s\S]*?for update;[\s\S]*?update public\.admin_users[\s\S]*?update public\.admin_sessions/,
    )
    assert.match(
      sql,
      /create or replace function public\.complete_admin_password_reset\([\s\S]*?updated_at = greatest\([\s\S]*?sessions\.id <> p_session_id/,
    )
  }

  assert.match(
    migration,
    /revoke insert on table public\.admin_sessions from service_role;/,
  )
  assert.match(
    baseline,
    /grant select, update, delete on table public\.admin_sessions\s+to service_role;/,
  )
})

test("forced password rotation rejects short and oversized passwords", () => {
  assert.equal(getAdminPasswordValidationError("12345678"), null)
  assert.match(
    getAdminPasswordValidationError("1234567") || "",
    /at least 8/,
  )
  assert.equal(getAdminPasswordValidationError("correct horse battery staple"), null)
  assert.match(
    getAdminPasswordValidationError("x".repeat(257)) || "",
    /no more than 256/,
  )
})
