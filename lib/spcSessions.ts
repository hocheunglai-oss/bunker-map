import { createHash, randomBytes } from "node:crypto"
import { createClient } from "@supabase/supabase-js"

// Chromium-based browsers cap persistent cookies at 400 days. Renew active
// SPC sessions before that browser limit so normal use stays signed in, while
// explicit logout and user-version changes remain immediately enforceable.
export const SPC_SESSION_DURATION_SECONDS = 400 * 24 * 60 * 60

const SPC_SESSION_TOKEN_BYTES = 32
const SPC_SESSION_RENEWAL_INTERVAL_MS = 24 * 60 * 60 * 1000

type SpcSessionRow = {
  id: string
  spc_user_id: string
  user_updated_at: string
  expires_at: string
  mfa_verified_at: string | null
  revoked_at: string | null
  spc_users:
    | {
        updated_at: string
        is_active: boolean
      }
    | Array<{
        updated_at: string
        is_active: boolean
      }>
}

export type DatabaseSpcSession = {
  id: string
  spcUserId: string
  userUpdatedAt: string
  expiresAt: string
  mfaVerifiedAt: string | null
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

export function isPlausibleSpcSessionToken(token: string) {
  return token.length === 43 && /^[A-Za-z0-9_-]+$/.test(token)
}

export function createSpcSessionToken() {
  return randomBytes(SPC_SESSION_TOKEN_BYTES).toString("base64url")
}

export function hashSpcSessionToken(token: string) {
  return createHash("sha256").update(token, "utf8").digest("hex")
}

export function getSpcSessionExpiry(now = new Date()) {
  return new Date(
    now.getTime() + SPC_SESSION_DURATION_SECONDS * 1000,
  ).toISOString()
}

export function shouldRenewSpcSession(now: Date, expiresAt: string) {
  const expiryTime = Date.parse(expiresAt)
  const renewalThresholdMs =
    SPC_SESSION_DURATION_SECONDS * 1000 - SPC_SESSION_RENEWAL_INTERVAL_MS

  return (
    Number.isFinite(expiryTime) &&
    expiryTime > now.getTime() &&
    expiryTime - now.getTime() < renewalThresholdMs
  )
}

export async function createDatabaseSpcSession(
  spcUserId: string,
  observedUserUpdatedAt: string,
) {
  if (
    !observedUserUpdatedAt ||
    !Number.isFinite(Date.parse(observedUserUpdatedAt))
  ) {
    throw new Error("The verified SPC-user version is invalid.")
  }

  const token = createSpcSessionToken()
  const tokenHash = hashSpcSessionToken(token)
  const { data, error } = await getServiceClient()
    .rpc("create_spc_session", {
      p_spc_user_id: spcUserId,
      p_observed_user_updated_at: observedUserUpdatedAt,
      p_token_hash: tokenHash,
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

export async function createDatabaseSpcSessionFromAssuredSession(
  spcUserId: string,
  observedUserUpdatedAt: string,
  previousToken: string,
) {
  if (
    !observedUserUpdatedAt ||
    !Number.isFinite(Date.parse(observedUserUpdatedAt)) ||
    !isPlausibleSpcSessionToken(previousToken)
  ) {
    throw new Error("The assured SPC-session rotation parameters are invalid.")
  }

  const token = createSpcSessionToken()
  const { data, error } = await getServiceClient()
    .rpc("create_spc_session_from_assured_session", {
      p_spc_user_id: spcUserId,
      p_observed_user_updated_at: observedUserUpdatedAt,
      p_previous_token_hash: hashSpcSessionToken(previousToken),
      p_token_hash: hashSpcSessionToken(token),
    })
    .select("id,expires_at,mfa_verified_at")
    .single()

  if (error) throw error
  const expiresAt = String(data.expires_at || "")
  const mfaVerifiedAt = String(data.mfa_verified_at || "")
  if (
    !Number.isFinite(Date.parse(expiresAt)) ||
    !Number.isFinite(Date.parse(mfaVerifiedAt))
  ) {
    throw new Error("The assured SPC session response is invalid.")
  }

  return {
    id: String(data.id),
    token,
    expiresAt,
    mfaVerifiedAt,
  }
}

export async function getDatabaseSpcSession(
  token: string,
): Promise<DatabaseSpcSession | null> {
  if (!isPlausibleSpcSessionToken(token)) return null

  const now = new Date()
  const tokenHash = hashSpcSessionToken(token)
  const supabase = getServiceClient()
  const { data, error } = await supabase
    .from("spc_sessions")
    .select(
      "id,spc_user_id,user_updated_at,expires_at,revoked_at,mfa_verified_at,spc_users!inner(updated_at,is_active)",
    )
    .eq("token_hash", tokenHash)
    .is("revoked_at", null)
    .gt("expires_at", now.toISOString())
    .eq("spc_users.is_active", true)
    .maybeSingle()

  if (error) throw error
  if (!data) return null

  const row = data as unknown as SpcSessionRow
  const relatedUser = Array.isArray(row.spc_users)
    ? row.spc_users[0]
    : row.spc_users

  if (
    !relatedUser?.is_active ||
    relatedUser.updated_at !== row.user_updated_at
  ) {
    return null
  }

  let expiresAt = row.expires_at
  if (shouldRenewSpcSession(now, row.expires_at)) {
    const renewedExpiry = getSpcSessionExpiry(now)
    const { data: renewedSession, error: renewalError } = await supabase
      .from("spc_sessions")
      .update({ expires_at: renewedExpiry })
      .eq("id", row.id)
      .eq("token_hash", tokenHash)
      .eq("user_updated_at", row.user_updated_at)
      .is("revoked_at", null)
      .gt("expires_at", now.toISOString())
      .select("expires_at")
      .maybeSingle()

    if (renewalError) throw renewalError
    if (!renewedSession) return null
    expiresAt = String(renewedSession.expires_at)
  }

  return {
    id: row.id,
    spcUserId: row.spc_user_id,
    userUpdatedAt: row.user_updated_at,
    expiresAt,
    mfaVerifiedAt: row.mfa_verified_at || null,
  }
}

export async function revokeDatabaseSpcSession(token: string) {
  if (!isPlausibleSpcSessionToken(token)) return false

  const { data, error } = await getServiceClient()
    .from("spc_sessions")
    .update({ revoked_at: new Date().toISOString() })
    .eq("token_hash", hashSpcSessionToken(token))
    .is("revoked_at", null)
    .select("id")

  if (error) throw error
  return Boolean(data?.length)
}

export async function revokeAllDatabaseSpcSessions(spcUserId: string) {
  const { error } = await getServiceClient()
    .from("spc_sessions")
    .update({ revoked_at: new Date().toISOString() })
    .eq("spc_user_id", spcUserId)
    .is("revoked_at", null)

  if (error) throw error
}
