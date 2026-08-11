import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  randomUUID,
} from "node:crypto"
import { cookies } from "next/headers"
import { createClient } from "@supabase/supabase-js"
import {
  SpcWhatsappAuthenticationDeliveryError,
  maskSpcWhatsappPhone,
  sendSpcWhatsappAuthenticationCode,
} from "@/lib/spcWhatsappAuthentication"
import {
  createSpcSessionToken,
  hashSpcSessionToken,
} from "@/lib/spcSessions"
import { normaliseSpcWhatsappPhone } from "@/lib/spcUsers"

export const SPC_WHATSAPP_LOGIN_MFA_COOKIE_NAME = "spc_mfa_pending"
export const SPC_WHATSAPP_LOGIN_MFA_CODE_LENGTH = 6
export const SPC_WHATSAPP_LOGIN_MFA_EXPIRY_SECONDS = 5 * 60
export const SPC_WHATSAPP_LOGIN_MFA_MAX_ATTEMPTS = 5
export const SPC_WHATSAPP_LOGIN_MFA_MAX_RETRY_SECONDS = 24 * 60 * 60
export const SPC_WHATSAPP_LOGIN_MFA_TEMPLATE_NAME = "spc_login_mfa_code"
export const SPC_WHATSAPP_LOGIN_MFA_TEMPLATE_LANGUAGE = "en_US"

const PENDING_TOKEN_BYTES = 32
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const HASH_PATTERN = /^[0-9a-f]{64}$/
const PHONE_PATTERN = /^[1-9][0-9]{7,14}$/
const GRAPH_VERSION_PATTERN = /^v[0-9]{1,3}\.[0-9]{1,2}$/
const GRAPH_ID_PATTERN = /^[0-9]{5,30}$/

type LoginMfaUserRow = {
  id: string
  username: string
  whatsapp_phone: string | null
  updated_at: string
  is_active: boolean
}

type BeginChallengeRow = {
  challenge_id: unknown
  allowed: unknown
  retry_after_seconds: unknown
  challenge_expires_at: unknown
}

type PendingChallengeRow = {
  challenge_id: unknown
  spc_user_id: unknown
  challenge_expires_at: unknown
  attempts_remaining: unknown
}

type VerifyChallengeRow = {
  result: unknown
  attempts_remaining: unknown
  challenge_expires_at: unknown
  spc_user_id: unknown
  user_updated_at: unknown
  session_expires_at: unknown
  mfa_verified_at: unknown
}

export type SpcWhatsappLoginMfaResult =
  | "verified"
  | "mismatch"
  | "locked"
  | "expired"
  | "already_used"
  | "cancelled"
  | "user_changed"
  | "unavailable"

function requireEnv(name: string) {
  const value = process.env[name]?.trim()
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

function assertUuid(value: string, label: string) {
  if (!UUID_PATTERN.test(value)) throw new Error(`${label} is invalid.`)
}

function parseTimestamp(value: unknown, label: string) {
  const timestamp = typeof value === "string" ? value : ""
  if (!timestamp || !Number.isFinite(Date.parse(timestamp))) {
    throw new Error(`${label} is invalid.`)
  }
  return timestamp
}

function parseAttemptsRemaining(value: unknown) {
  const attempts = Number(value)
  if (
    !Number.isSafeInteger(attempts) ||
    attempts < 0 ||
    attempts > SPC_WHATSAPP_LOGIN_MFA_MAX_ATTEMPTS
  ) {
    throw new Error("The WhatsApp login MFA attempt count is invalid.")
  }
  return attempts
}

function pendingCookieOptions(expiresAt?: string) {
  const expires = expiresAt ? new Date(expiresAt) : new Date(0)
  const remainingSeconds = expiresAt
    ? Math.max(0, Math.ceil((expires.getTime() - Date.now()) / 1000))
    : 0

  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: Math.min(remainingSeconds, SPC_WHATSAPP_LOGIN_MFA_EXPIRY_SECONDS),
    expires,
  }
}

export function normalizeSpcWhatsappLoginMfaUsername(username: string | null | undefined) {
  return String(username || "").trim().toLowerCase()
}

export function isSpcWhatsappLoginMfaEnabled() {
  return process.env.SPC_WHATSAPP_LOGIN_MFA_ALL_ENABLED?.trim() === "1"
}

export function requiresSpcWhatsappLoginMfa(username: string | null | undefined) {
  return isSpcWhatsappLoginMfaEnabled() &&
    normalizeSpcWhatsappLoginMfaUsername(username).length > 0
}

export function isSpcWhatsappLoginMfaConfigured() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || ""
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || ""
  const secret = process.env.SPC_WHATSAPP_LOGIN_MFA_SECRET || ""
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN?.trim() || ""
  const graphVersion = process.env.WHATSAPP_GRAPH_API_VERSION?.trim() || ""
  const phoneNumberId =
    process.env.SPC_WHATSAPP_LOGIN_MFA_PHONE_NUMBER_ID?.trim() || ""
  const disallowedPhoneNumberId =
    process.env.SPC_WHATSAPP_LOGIN_MFA_DISALLOWED_PHONE_NUMBER_ID?.trim() || ""
  let validSupabaseUrl = false
  try {
    validSupabaseUrl = new URL(supabaseUrl).protocol === "https:"
  } catch {
    validSupabaseUrl = false
  }

  return Boolean(
    validSupabaseUrl &&
    serviceRoleKey &&
    secret.length >= 32 &&
    accessToken &&
    GRAPH_VERSION_PATTERN.test(graphVersion) &&
    GRAPH_ID_PATTERN.test(phoneNumberId) &&
    GRAPH_ID_PATTERN.test(disallowedPhoneNumberId) &&
    phoneNumberId !== disallowedPhoneNumberId,
  )
}

export function isSameOriginSpcWhatsappLoginMfaRequest(request: Request) {
  const origin = request.headers.get("origin")?.trim()
  if (!origin) return false
  try {
    return new URL(origin).origin === new URL(request.url).origin
  } catch {
    return false
  }
}

export function createSpcWhatsappLoginMfaPendingToken() {
  return randomBytes(PENDING_TOKEN_BYTES).toString("base64url")
}

export function isPlausibleSpcWhatsappLoginMfaPendingToken(token: string) {
  return token.length === 43 && /^[A-Za-z0-9_-]+$/.test(token)
}

export function hashSpcWhatsappLoginMfaPendingToken(token: string) {
  if (!isPlausibleSpcWhatsappLoginMfaPendingToken(token)) {
    throw new Error("The WhatsApp login MFA token is invalid.")
  }
  return createHash("sha256").update(token, "utf8").digest("hex")
}

export function generateSpcWhatsappLoginMfaCode() {
  return randomInt(0, 10 ** SPC_WHATSAPP_LOGIN_MFA_CODE_LENGTH)
    .toString()
    .padStart(SPC_WHATSAPP_LOGIN_MFA_CODE_LENGTH, "0")
}

export function hashSpcWhatsappLoginMfaCode(
  challengeId: string,
  spcUserId: string,
  pendingTokenHash: string,
  code: string,
  secret = process.env.SPC_WHATSAPP_LOGIN_MFA_SECRET,
) {
  assertUuid(challengeId, "Challenge ID")
  assertUuid(spcUserId, "SPC user ID")
  if (!HASH_PATTERN.test(pendingTokenHash)) {
    throw new Error("The WhatsApp login MFA token hash is invalid.")
  }
  if (!new RegExp(`^[0-9]{${SPC_WHATSAPP_LOGIN_MFA_CODE_LENGTH}}$`).test(code)) {
    throw new Error("The WhatsApp login MFA code is invalid.")
  }
  if (!secret || secret.length < 32) {
    throw new Error("SPC_WHATSAPP_LOGIN_MFA_SECRET is not configured securely.")
  }

  return createHmac("sha256", secret)
    .update(
      `spc-whatsapp-login-mfa:v1:${challengeId}:${spcUserId}:${pendingTokenHash}:${code}`,
      "utf8",
    )
    .digest("hex")
}

async function getLoginMfaUser(
  spcUserId: string,
  observedUserUpdatedAt: string,
) {
  assertUuid(spcUserId, "SPC user ID")
  const observedTimestamp = parseTimestamp(
    observedUserUpdatedAt,
    "The verified SPC-user version",
  )
  const { data, error } = await getServiceClient()
    .from("spc_users")
    .select("id,username,whatsapp_phone,updated_at,is_active")
    .eq("id", spcUserId)
    .eq("is_active", true)
    .maybeSingle()

  if (error) throw new Error("The WhatsApp login MFA account lookup failed.")
  if (!data) return null
  const row = data as LoginMfaUserRow
  const phone = normaliseSpcWhatsappPhone(row.whatsapp_phone)
  if (
    row.updated_at !== observedTimestamp ||
    !PHONE_PATTERN.test(phone) ||
    !requiresSpcWhatsappLoginMfa(row.username)
  ) {
    return null
  }

  return {
    id: row.id,
    username: row.username,
    whatsappPhone: phone,
    phoneHint: maskSpcWhatsappPhone(phone),
    credentialUpdatedAt: row.updated_at,
  }
}

export async function beginSpcWhatsappLoginMfaChallenge(input: {
  spcUserId: string
  credentialUpdatedAt: string
  loginAttemptId: string
  trustedSourceIp: string
  requestId: string
}) {
  assertUuid(input.spcUserId, "SPC user ID")
  assertUuid(input.loginAttemptId, "Login attempt ID")
  assertUuid(input.requestId, "Request ID")
  const user = await getLoginMfaUser(
    input.spcUserId,
    input.credentialUpdatedAt,
  )
  if (!user) throw new Error("The WhatsApp login MFA account is unavailable.")

  const challengeId = randomUUID()
  const pendingToken = createSpcWhatsappLoginMfaPendingToken()
  const pendingTokenHash = hashSpcWhatsappLoginMfaPendingToken(pendingToken)
  const code = generateSpcWhatsappLoginMfaCode()
  const codeHash = hashSpcWhatsappLoginMfaCode(
    challengeId,
    user.id,
    pendingTokenHash,
    code,
  )
  const expiresAt = new Date(
    Date.now() + SPC_WHATSAPP_LOGIN_MFA_EXPIRY_SECONDS * 1000,
  ).toISOString()

  const { data, error } = await getServiceClient()
    .rpc("begin_spc_whatsapp_login_mfa_challenge", {
      p_challenge_id: challengeId,
      p_spc_user_id: user.id,
      p_login_attempt_id: input.loginAttemptId,
      p_preauth_token_hash: pendingTokenHash,
      p_code_hash: codeHash,
      p_observed_user_updated_at: user.credentialUpdatedAt,
      p_source_ip: input.trustedSourceIp,
      p_request_id: input.requestId,
      p_expires_at: expiresAt,
    })
    .single()

  if (error || !data) throw new Error("The WhatsApp login MFA challenge could not be created.")
  const row = data as BeginChallengeRow
  if (typeof row.allowed !== "boolean") {
    throw new Error("The WhatsApp login MFA challenge decision is invalid.")
  }

  const retryAfterSeconds = Number(row.retry_after_seconds)
  if (
    !Number.isSafeInteger(retryAfterSeconds) ||
    retryAfterSeconds < 0 ||
    retryAfterSeconds > SPC_WHATSAPP_LOGIN_MFA_MAX_RETRY_SECONDS
  ) {
    throw new Error("The WhatsApp login MFA retry period is invalid.")
  }

  if (!row.allowed) {
    if (retryAfterSeconds < 1) {
      throw new Error("The WhatsApp login MFA challenge decision is inconsistent.")
    }
    return { allowed: false as const, retryAfterSeconds }
  }

  const returnedChallengeId = String(row.challenge_id || "")
  assertUuid(returnedChallengeId, "Challenge ID")
  if (returnedChallengeId !== challengeId || retryAfterSeconds !== 0) {
    throw new Error("The WhatsApp login MFA challenge decision is inconsistent.")
  }

  return {
    allowed: true as const,
    challengeId,
    pendingToken,
    pendingTokenHash,
    code,
    expiresAt: parseTimestamp(
      row.challenge_expires_at,
      "The WhatsApp login MFA expiry",
    ),
    user,
  }
}

export async function sendSpcWhatsappLoginMfaCode(
  input: {
    to: string
    code: string
  },
  fetchImpl: typeof fetch = fetch,
) {
  const phoneNumberId =
    process.env.SPC_WHATSAPP_LOGIN_MFA_PHONE_NUMBER_ID?.trim() || ""
  const disallowedPhoneNumberId =
    process.env.SPC_WHATSAPP_LOGIN_MFA_DISALLOWED_PHONE_NUMBER_ID?.trim() || ""
  if (
    !GRAPH_ID_PATTERN.test(disallowedPhoneNumberId) ||
    phoneNumberId === disallowedPhoneNumberId
  ) {
    throw new SpcWhatsappAuthenticationDeliveryError("configuration")
  }

  return sendSpcWhatsappAuthenticationCode(
    input,
    {
      phoneNumberId,
      templateName: SPC_WHATSAPP_LOGIN_MFA_TEMPLATE_NAME,
      templateLanguage: SPC_WHATSAPP_LOGIN_MFA_TEMPLATE_LANGUAGE,
    },
    fetchImpl,
  )
}

export {
  SpcWhatsappAuthenticationDeliveryError as SpcWhatsappLoginMfaDeliveryError,
}

export async function completeSpcWhatsappLoginMfaDelivery(input: {
  challengeId: string
  pendingTokenHash: string
  succeeded: boolean
  messageId?: string
}) {
  assertUuid(input.challengeId, "Challenge ID")
  if (!HASH_PATTERN.test(input.pendingTokenHash)) {
    throw new Error("The WhatsApp login MFA token hash is invalid.")
  }
  const messageId = input.messageId?.trim() || null
  if (messageId && (messageId.length > 512 || /[\u0000-\u001f\u007f]/.test(messageId))) {
    throw new Error("The WhatsApp message ID is invalid.")
  }

  const { data, error } = await getServiceClient().rpc(
    "complete_spc_whatsapp_login_mfa_delivery",
    {
      p_challenge_id: input.challengeId,
      p_preauth_token_hash: input.pendingTokenHash,
      p_succeeded: input.succeeded,
      p_message_id: messageId,
    },
  )
  if (error || data !== true) {
    throw new Error("The WhatsApp login MFA delivery state could not be saved.")
  }
}

export async function setSpcWhatsappLoginMfaPendingCookie(
  pendingToken: string,
  expiresAt: string,
) {
  if (!isPlausibleSpcWhatsappLoginMfaPendingToken(pendingToken)) {
    throw new Error("The WhatsApp login MFA token is invalid.")
  }
  const expiry = parseTimestamp(expiresAt, "The WhatsApp login MFA expiry")
  const cookieStore = await cookies()
  cookieStore.set(
    SPC_WHATSAPP_LOGIN_MFA_COOKIE_NAME,
    pendingToken,
    pendingCookieOptions(expiry),
  )
}

export async function clearSpcWhatsappLoginMfaPendingCookie() {
  const cookieStore = await cookies()
  cookieStore.set(
    SPC_WHATSAPP_LOGIN_MFA_COOKIE_NAME,
    "",
    pendingCookieOptions(),
  )
}

async function getCurrentPendingToken() {
  const cookieStore = await cookies()
  const token = cookieStore.get(SPC_WHATSAPP_LOGIN_MFA_COOKIE_NAME)?.value || ""
  return isPlausibleSpcWhatsappLoginMfaPendingToken(token) ? token : ""
}

async function getPendingChallenge(pendingTokenHash: string) {
  const { data, error } = await getServiceClient()
    .rpc("get_spc_whatsapp_login_mfa_challenge", {
      p_preauth_token_hash: pendingTokenHash,
    })
    .maybeSingle()

  if (error) throw new Error("The WhatsApp login MFA challenge lookup failed.")
  if (!data) return null
  const row = data as PendingChallengeRow
  const challengeId = String(row.challenge_id || "")
  const spcUserId = String(row.spc_user_id || "")
  assertUuid(challengeId, "Challenge ID")
  assertUuid(spcUserId, "SPC user ID")
  return {
    challengeId,
    spcUserId,
    expiresAt: parseTimestamp(
      row.challenge_expires_at,
      "The WhatsApp login MFA expiry",
    ),
    attemptsRemaining: parseAttemptsRemaining(row.attempts_remaining),
  }
}

export async function verifySpcWhatsappLoginMfaCode(code: string) {
  if (!new RegExp(`^[0-9]{${SPC_WHATSAPP_LOGIN_MFA_CODE_LENGTH}}$`).test(code)) {
    return {
      result: "unavailable" as const,
      attemptsRemaining: SPC_WHATSAPP_LOGIN_MFA_MAX_ATTEMPTS,
      expiresAt: null,
    }
  }

  const pendingToken = await getCurrentPendingToken()
  if (!pendingToken) {
    return {
      result: "unavailable" as const,
      attemptsRemaining: 0,
      expiresAt: null,
    }
  }
  const pendingTokenHash = hashSpcWhatsappLoginMfaPendingToken(pendingToken)
  const challenge = await getPendingChallenge(pendingTokenHash)
  if (!challenge) {
    return {
      result: "unavailable" as const,
      attemptsRemaining: 0,
      expiresAt: null,
    }
  }

  const codeHash = hashSpcWhatsappLoginMfaCode(
    challenge.challengeId,
    challenge.spcUserId,
    pendingTokenHash,
    code,
  )
  const sessionToken = createSpcSessionToken()
  const sessionTokenHash = hashSpcSessionToken(sessionToken)
  const { data, error } = await getServiceClient()
    .rpc("verify_spc_whatsapp_login_mfa_challenge", {
      p_challenge_id: challenge.challengeId,
      p_spc_user_id: challenge.spcUserId,
      p_preauth_token_hash: pendingTokenHash,
      p_code_hash: codeHash,
      p_session_token_hash: sessionTokenHash,
    })
    .single()

  if (error || !data) throw new Error("The WhatsApp login MFA code could not be verified.")
  const row = data as VerifyChallengeRow
  const result = String(row.result || "") as SpcWhatsappLoginMfaResult
  if (![
    "verified",
    "mismatch",
    "locked",
    "expired",
    "already_used",
    "cancelled",
    "user_changed",
    "unavailable",
  ].includes(result)) {
    throw new Error("The WhatsApp login MFA verification result is invalid.")
  }

  const attemptsRemaining = parseAttemptsRemaining(row.attempts_remaining)
  const expiresAt = parseTimestamp(
    row.challenge_expires_at,
    "The WhatsApp login MFA expiry",
  )
  if (result !== "verified") {
    return { result, attemptsRemaining, expiresAt }
  }

  const spcUserId = String(row.spc_user_id || "")
  assertUuid(spcUserId, "SPC user ID")
  if (spcUserId !== challenge.spcUserId) {
    throw new Error("The WhatsApp login MFA user binding is invalid.")
  }

  return {
    result: "verified" as const,
    attemptsRemaining,
    expiresAt,
    spcUserId,
    userUpdatedAt: parseTimestamp(
      row.user_updated_at,
      "The verified SPC-user version",
    ),
    sessionToken,
    sessionExpiresAt: parseTimestamp(
      row.session_expires_at,
      "The SPC session expiry",
    ),
    mfaVerifiedAt: parseTimestamp(
      row.mfa_verified_at,
      "The WhatsApp login MFA verification time",
    ),
  }
}

export async function cancelCurrentSpcWhatsappLoginMfaChallenge() {
  const pendingToken = await getCurrentPendingToken()
  try {
    if (pendingToken) await cancelSpcWhatsappLoginMfaChallenge(pendingToken)
  } finally {
    await clearSpcWhatsappLoginMfaPendingCookie()
  }
}

export async function cancelSpcWhatsappLoginMfaChallenge(pendingToken: string) {
  const pendingTokenHash = hashSpcWhatsappLoginMfaPendingToken(pendingToken)
  const { error } = await getServiceClient().rpc(
    "cancel_spc_whatsapp_login_mfa_challenge",
    { p_preauth_token_hash: pendingTokenHash },
  )
  if (error) throw new Error("The WhatsApp login MFA challenge could not be cancelled.")
}
