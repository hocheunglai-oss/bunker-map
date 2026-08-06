import { createHash } from "node:crypto"
import { isIP } from "node:net"
import { createClient } from "@supabase/supabase-js"

export const SPC_LOGIN_RATE_LIMIT_WINDOW_SECONDS = 15 * 60
export const SPC_LOGIN_USERNAME_FAILURE_LIMIT = 5
export const SPC_LOGIN_SOURCE_IP_FAILURE_LIMIT = 20
export const SPC_LOGIN_PENDING_TIMEOUT_SECONDS = 2 * 60
export const SPC_LOGIN_ATTEMPT_RETENTION_DAYS = 30

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ZERO_BIGINT = BigInt(0)
const ONE_BIGINT = BigInt(1)

type SpcLoginBlockedBy =
  | "username"
  | "source_ip"
  | "username_and_source_ip"

export type SpcLoginCancellationReason =
  | "authentication_unavailable"
  | "attempt_monitoring_unavailable"
  | "session_unavailable"

type BeginSpcLoginAttemptInput = {
  username: string
  trustedSourceIp: string
  requestId: string
}

type CompleteSpcLoginAttemptInput = {
  attemptId: string
  succeeded: boolean
}

type CancelSpcLoginAttemptInput = {
  attemptId: string
  reason: SpcLoginCancellationReason
}

type SpcLoginAttemptRow = {
  attempt_id: unknown
  allowed: unknown
  retry_after_seconds: unknown
  blocked_by: unknown
  blocked_count: unknown
}

export type SpcLoginAttemptDecision = {
  attemptId: string
  allowed: boolean
  retryAfterSeconds: number
  blockedBy: SpcLoginBlockedBy | null
  blockedCount: string
  shouldLogRateLimit: boolean
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

export function normalizeSpcLoginUsername(username: string) {
  return String(username || "").trim().toLowerCase()
}

export function hashSpcLoginUsername(username: string) {
  return createHash("sha256")
    .update(normalizeSpcLoginUsername(username), "utf8")
    .digest("hex")
}

export function shouldLogSpcRateLimitCount(value: string | number | bigint) {
  let count: bigint
  try {
    count = BigInt(value)
  } catch {
    return false
  }

  return count > ZERO_BIGINT &&
    (count & (count - ONE_BIGINT)) === ZERO_BIGINT
}

function assertUuid(value: string, label: string) {
  if (!UUID_PATTERN.test(value)) {
    throw new Error(`${label} is invalid.`)
  }
}

function parseAttemptDecision(row: SpcLoginAttemptRow): SpcLoginAttemptDecision {
  const attemptId = String(row.attempt_id || "")
  assertUuid(attemptId, "Login attempt ID")

  if (typeof row.allowed !== "boolean") {
    throw new Error("Login-attempt decision is invalid.")
  }

  const retryAfterSeconds = Number(row.retry_after_seconds)
  if (
    !Number.isSafeInteger(retryAfterSeconds) ||
    retryAfterSeconds < 0 ||
    retryAfterSeconds > SPC_LOGIN_RATE_LIMIT_WINDOW_SECONDS
  ) {
    throw new Error("Login-attempt retry period is invalid.")
  }

  const blockedBy = row.blocked_by === null
    ? null
    : String(row.blocked_by) as SpcLoginBlockedBy
  if (
    blockedBy !== null &&
    blockedBy !== "username" &&
    blockedBy !== "source_ip" &&
    blockedBy !== "username_and_source_ip"
  ) {
    throw new Error("Login-attempt block reason is invalid.")
  }

  let blockedCount: bigint
  try {
    blockedCount = BigInt(String(row.blocked_count))
  } catch {
    throw new Error("Login-attempt blocked count is invalid.")
  }
  if (blockedCount < ZERO_BIGINT) {
    throw new Error("Login-attempt blocked count is invalid.")
  }

  if (
    (
      row.allowed &&
      (
        retryAfterSeconds !== 0 ||
        blockedBy !== null ||
        blockedCount !== ZERO_BIGINT
      )
    ) ||
    (
      !row.allowed &&
      (
        retryAfterSeconds < 1 ||
        blockedBy === null ||
        blockedCount < ONE_BIGINT
      )
    )
  ) {
    throw new Error("Login-attempt decision is inconsistent.")
  }

  return {
    attemptId,
    allowed: row.allowed,
    retryAfterSeconds,
    blockedBy,
    blockedCount: blockedCount.toString(),
    shouldLogRateLimit: shouldLogSpcRateLimitCount(blockedCount),
  }
}

export async function beginSpcLoginAttempt({
  username,
  trustedSourceIp,
  requestId,
}: BeginSpcLoginAttemptInput): Promise<SpcLoginAttemptDecision> {
  if (isIP(trustedSourceIp) === 0) {
    throw new Error("Trusted source IP is unavailable or invalid.")
  }
  assertUuid(requestId, "Request ID")

  const { data, error } = await getServiceClient()
    .rpc("begin_spc_login_attempt", {
      p_username_hash: hashSpcLoginUsername(username),
      p_source_ip: trustedSourceIp,
      p_request_id: requestId,
    })
    .single()

  if (error) throw error
  if (!data) throw new Error("Login-attempt decision is unavailable.")

  return parseAttemptDecision(data as SpcLoginAttemptRow)
}

export async function completeSpcLoginAttempt({
  attemptId,
  succeeded,
}: CompleteSpcLoginAttemptInput) {
  assertUuid(attemptId, "Login attempt ID")

  const { data, error } = await getServiceClient().rpc(
    "complete_spc_login_attempt",
    {
      p_attempt_id: attemptId,
      p_succeeded: succeeded,
    },
  )

  if (error) throw error
  if (data !== true) {
    throw new Error("Login-attempt completion was rejected.")
  }
}

export async function cancelSpcLoginAttempt({
  attemptId,
  reason,
}: CancelSpcLoginAttemptInput) {
  assertUuid(attemptId, "Login attempt ID")

  const { data, error } = await getServiceClient().rpc(
    "cancel_spc_login_attempt",
    {
      p_attempt_id: attemptId,
      p_reason: reason,
    },
  )

  if (error) throw error
  if (data !== true) {
    throw new Error("Login-attempt cancellation was rejected.")
  }
}
