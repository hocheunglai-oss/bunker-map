import { createHash, randomBytes } from "node:crypto"
import { createClient } from "@supabase/supabase-js"

// Chromium-based browsers cap persistent cookies at 400 days. Use that
// browser maximum so FCUNO remains signed in until logout in normal use,
// while password rotation, account disablement, and explicit revocation
// continue to invalidate the server-side session immediately.
export const ADMIN_SESSION_DURATION_SECONDS = 60 * 60 * 24 * 400
export const OUTLOOK_ADDIN_SESSION_DURATION_SECONDS = 60 * 30

const ADMIN_SESSION_TOKEN_BYTES = 32
const ADMIN_SESSION_TOUCH_INTERVAL_MS = 60 * 60 * 1000

type AdminSessionRow = {
  id: string
  admin_user_id: string
  expires_at: string
  last_seen_at: string
  revoked_at: string | null
}

export type DatabaseAdminSession = {
  id: string
  adminUserId: string
  expiresAt: string
}

function requireEnv(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing environment variable: ${name}`)
  return value
}

function getServiceClient() {
  return createClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    },
  )
}

function isPlausibleSessionToken(token: string) {
  return (
    token.length >= 40 &&
    token.length <= 256 &&
    /^[A-Za-z0-9_-]+$/.test(token)
  )
}

export function createAdminSessionToken() {
  return randomBytes(ADMIN_SESSION_TOKEN_BYTES).toString("base64url")
}

export function hashAdminSessionToken(token: string) {
  return createHash("sha256").update(token, "utf8").digest("hex")
}

export function getAdminSessionExpiry(
  now = new Date(),
  durationSeconds = ADMIN_SESSION_DURATION_SECONDS,
) {
  if (
    !Number.isSafeInteger(durationSeconds) ||
    durationSeconds < 60 ||
    durationSeconds > ADMIN_SESSION_DURATION_SECONDS
  ) {
    throw new Error("Admin session duration is invalid.")
  }

  return new Date(
    now.getTime() + durationSeconds * 1000,
  ).toISOString()
}

export async function createDatabaseAdminSession(
  adminUserId: string,
  observedUserUpdatedAt: string,
  durationSeconds = ADMIN_SESSION_DURATION_SECONDS,
) {
  // Keep the application-side duration guard for fast feedback. The RPC
  // repeats this validation and calculates the authoritative expiry using the
  // database clock.
  getAdminSessionExpiry(new Date(), durationSeconds)

  if (
    !observedUserUpdatedAt ||
    !Number.isFinite(Date.parse(observedUserUpdatedAt))
  ) {
    throw new Error("The verified admin-user version is invalid.")
  }

  const token = createAdminSessionToken()
  const tokenHash = hashAdminSessionToken(token)
  const supabase = getServiceClient()
  const { data, error } = await supabase
    .rpc("create_admin_session", {
      p_admin_user_id: adminUserId,
      p_observed_user_updated_at: observedUserUpdatedAt,
      p_token_hash: tokenHash,
      p_duration_seconds: durationSeconds,
    })
    .select("id,expires_at")
    .single()

  if (error) throw error

  return {
    id: String(data.id),
    token,
    expiresAt: String(data.expires_at),
  }
}

export async function getDatabaseAdminSession(
  token: string,
): Promise<DatabaseAdminSession | null> {
  if (!isPlausibleSessionToken(token)) return null

  const now = new Date()
  const supabase = getServiceClient()
  const { data, error } = await supabase
    .from("admin_sessions")
    .select("id,admin_user_id,expires_at,last_seen_at,revoked_at")
    .eq("token_hash", hashAdminSessionToken(token))
    .is("revoked_at", null)
    .gt("expires_at", now.toISOString())
    .maybeSingle()

  if (error) throw error
  if (!data) return null

  const row = data as AdminSessionRow
  const lastSeenAt = Date.parse(row.last_seen_at)
  if (
    Number.isFinite(lastSeenAt) &&
    now.getTime() - lastSeenAt >= ADMIN_SESSION_TOUCH_INTERVAL_MS
  ) {
    await supabase
      .from("admin_sessions")
      .update({ last_seen_at: now.toISOString() })
      .eq("id", row.id)
      .is("revoked_at", null)
  }

  return {
    id: row.id,
    adminUserId: row.admin_user_id,
    expiresAt: row.expires_at,
  }
}

export async function revokeDatabaseAdminSession(token: string) {
  if (!isPlausibleSessionToken(token)) return false

  const { data, error } = await getServiceClient()
    .from("admin_sessions")
    .update({ revoked_at: new Date().toISOString() })
    .eq("token_hash", hashAdminSessionToken(token))
    .is("revoked_at", null)
    .select("id")

  if (error) throw error
  return Boolean(data?.length)
}

export async function revokeAllDatabaseAdminSessions(adminUserId: string) {
  const { error } = await getServiceClient()
    .from("admin_sessions")
    .update({ revoked_at: new Date().toISOString() })
    .eq("admin_user_id", adminUserId)
    .is("revoked_at", null)

  if (error) throw error
}
