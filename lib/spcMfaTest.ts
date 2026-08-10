import {
  createHmac,
  randomInt,
  randomUUID,
} from "node:crypto"
import { createClient } from "@supabase/supabase-js"
import {
  createSpcAuditedSupabaseClient,
  type SpcAuditContext,
  type SpcAuditOutcome,
} from "@/lib/spcAudit"
import { normaliseSpcWhatsappPhone } from "@/lib/spcUsers"
import {
  SPC_MFA_TEST_CODE_LENGTH,
  SPC_MFA_TEST_ACCOUNT_USERNAME,
  SPC_MFA_TEST_EXPIRY_SECONDS,
  SPC_MFA_TEST_MAX_ATTEMPTS,
  SPC_MFA_TEST_MAX_RETRY_SECONDS,
  SPC_MFA_TEST_TEMPLATE_LANGUAGE,
  SPC_MFA_TEST_TEMPLATE_NAME,
} from "@/lib/spcMfaTestConstants"

export {
  SPC_MFA_TEST_CODE_LENGTH,
  SPC_MFA_TEST_ACCOUNT_USERNAME,
  SPC_MFA_TEST_EXPIRY_SECONDS,
  SPC_MFA_TEST_MAX_ATTEMPTS,
  SPC_MFA_TEST_MAX_RETRY_SECONDS,
  SPC_MFA_TEST_RESEND_SECONDS,
  SPC_MFA_TEST_TEMPLATE_LANGUAGE,
  SPC_MFA_TEST_TEMPLATE_NAME,
} from "@/lib/spcMfaTestConstants"

const META_REQUEST_TIMEOUT_MS = 10_000
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const HASH_PATTERN = /^[0-9a-f]{64}$/
const PHONE_PATTERN = /^[1-9][0-9]{7,14}$/
const GRAPH_VERSION_PATTERN = /^v[0-9]{1,3}\.[0-9]{1,2}$/
const GRAPH_ID_PATTERN = /^[0-9]{5,30}$/

type SpcMfaTestUserRow = {
  id: string
  username: string
  display_name: string | null
  whatsapp_phone: string | null
  is_active: boolean
}

type BeginChallengeRow = {
  challenge_id: unknown
  allowed: unknown
  retry_after_seconds: unknown
  challenge_expires_at: unknown
}

type VerifyChallengeRow = {
  result: unknown
  attempts_remaining: unknown
  challenge_expires_at: unknown
}

type ActiveChallengeRow = {
  challenge_id: unknown
  target_user_id: unknown
  challenge_expires_at: unknown
  attempts_remaining: unknown
}

export type SpcMfaTestTarget = {
  id: string
  username: string
  displayName: string
  whatsappPhone: string
  phoneHint: string
  ready: boolean
}

export type SpcMfaTestVerificationResult =
  | "verified"
  | "mismatch"
  | "locked"
  | "expired"
  | "already_used"
  | "unavailable"

export type SpcMfaTestAuditStatus =
  | "challenge_created"
  | "delivery_accepted"
  | "delivery_failed"
  | "activation_failed"
  | "verification_requested"
  | SpcMfaTestVerificationResult

export class SpcMfaTestDeliveryError extends Error {
  readonly category:
    | "configuration"
    | "timeout"
    | "rejected"
    | "template-unavailable"
    | "invalid-response"
  readonly upstreamStatus: number | null
  readonly upstreamCode: string | null

  constructor(
    category: SpcMfaTestDeliveryError["category"],
    options: { upstreamStatus?: number; upstreamCode?: string } = {},
  ) {
    super("WhatsApp could not accept the MFA test message.")
    this.name = "SpcMfaTestDeliveryError"
    this.category = category
    this.upstreamStatus = options.upstreamStatus || null
    this.upstreamCode = options.upstreamCode || null
  }
}

function requireEnv(name: string) {
  const value = process.env[name]?.trim()
  if (!value) throw new SpcMfaTestDeliveryError("configuration")
  return value
}

function getServiceClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("SPC MFA test storage is unavailable.")
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  })
}

function assertUuid(value: string, label: string) {
  if (!UUID_PATTERN.test(value)) throw new Error(`${label} is invalid.`)
}

function parseExpiry(value: unknown) {
  const expiry = typeof value === "string" ? value : ""
  if (!expiry || !Number.isFinite(Date.parse(expiry))) {
    throw new Error("The WhatsApp MFA test expiry is invalid.")
  }
  return expiry
}

function parseAttemptsRemaining(value: unknown) {
  const attempts = Number(value)
  if (
    !Number.isSafeInteger(attempts) ||
    attempts < 0 ||
    attempts > SPC_MFA_TEST_MAX_ATTEMPTS
  ) {
    throw new Error("The WhatsApp MFA test attempt count is invalid.")
  }
  return attempts
}

function safeUpstreamCode(payload: unknown) {
  if (!payload || typeof payload !== "object") return null
  const error = (payload as { error?: unknown }).error
  if (!error || typeof error !== "object") return null
  const code = (error as { code?: unknown }).code
  return typeof code === "string" || typeof code === "number"
    ? String(code).slice(0, 32)
    : null
}

function safeMessageId(payload: unknown) {
  if (!payload || typeof payload !== "object") return ""
  const messages = (payload as { messages?: unknown }).messages
  if (!Array.isArray(messages) || !messages[0] || typeof messages[0] !== "object") {
    return ""
  }
  const id = String((messages[0] as { id?: unknown }).id || "").trim()
  if (!id || id.length > 512 || /[\u0000-\u001f\u007f]/.test(id)) return ""
  return id
}

export function isSpcMfaTestConfigured() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || ""
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || ""
  const secret = process.env.SPC_WHATSAPP_MFA_TEST_SECRET || ""
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN?.trim() || ""
  const graphVersion = process.env.WHATSAPP_GRAPH_API_VERSION?.trim() || ""
  const phoneNumberId =
    process.env.SPC_WHATSAPP_MFA_TEST_PHONE_NUMBER_ID?.trim() || ""
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
    GRAPH_ID_PATTERN.test(phoneNumberId),
  )
}

export function isSameOriginSpcMfaTestRequest(request: Request) {
  const origin = request.headers.get("origin")?.trim()
  if (!origin) return false
  try {
    return new URL(origin).origin === new URL(request.url).origin
  } catch {
    return false
  }
}

export function generateSpcMfaTestCode() {
  return randomInt(0, 10 ** SPC_MFA_TEST_CODE_LENGTH)
    .toString()
    .padStart(SPC_MFA_TEST_CODE_LENGTH, "0")
}

export function hashSpcMfaTestCode(
  challengeId: string,
  userId: string,
  code: string,
  secret = process.env.SPC_WHATSAPP_MFA_TEST_SECRET,
) {
  assertUuid(challengeId, "Challenge ID")
  assertUuid(userId, "SPC user ID")
  if (!new RegExp(`^[0-9]{${SPC_MFA_TEST_CODE_LENGTH}}$`).test(code)) {
    throw new Error("The WhatsApp MFA test code is invalid.")
  }
  if (!secret || secret.length < 32) {
    throw new Error("SPC_WHATSAPP_MFA_TEST_SECRET is not configured securely.")
  }

  return createHmac("sha256", secret)
    .update(`spc-whatsapp-mfa-test:v1:${challengeId}:${userId}:${code}`, "utf8")
    .digest("hex")
}

export function maskSpcWhatsappPhone(value: string | null | undefined) {
  const digits = normaliseSpcWhatsappPhone(value)
  if (!PHONE_PATTERN.test(digits)) return ""
  const prefixLength = Math.min(2, digits.length - 4)
  const hiddenLength = Math.max(1, digits.length - prefixLength - 4)
  return `+${digits.slice(0, prefixLength)}${"•".repeat(hiddenLength)}${digits.slice(-4)}`
}

function mapSpcMfaTestTarget(row: SpcMfaTestUserRow): SpcMfaTestTarget {
  const phone = normaliseSpcWhatsappPhone(row.whatsapp_phone)
  const ready = !row.is_active && PHONE_PATTERN.test(phone)
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name || row.username,
    whatsappPhone: ready ? phone : "",
    phoneHint: ready ? maskSpcWhatsappPhone(phone) : "",
    ready,
  }
}

export async function listSpcMfaTestTargets(): Promise<SpcMfaTestTarget[]> {
  const { data, error } = await getServiceClient()
    .from("spc_users")
    .select("id,username,display_name,whatsapp_phone,is_active")
    .eq("is_active", false)
    .eq("username", SPC_MFA_TEST_ACCOUNT_USERNAME)
    .order("username", { ascending: true })

  if (error) throw new Error("SPC MFA test account lookup failed.")
  return ((data || []) as SpcMfaTestUserRow[]).map(mapSpcMfaTestTarget)
}

export async function getSpcMfaTestTarget(userId: string): Promise<SpcMfaTestTarget | null> {
  assertUuid(userId, "SPC user ID")
  const { data, error } = await getServiceClient()
    .from("spc_users")
    .select("id,username,display_name,whatsapp_phone,is_active")
    .eq("id", userId)
    .eq("is_active", false)
    .eq("username", SPC_MFA_TEST_ACCOUNT_USERNAME)
    .maybeSingle()

  if (error) throw new Error("SPC MFA test account lookup failed.")
  if (!data) return null

  return mapSpcMfaTestTarget(data as SpcMfaTestUserRow)
}

export function buildSpcMfaAuthenticationMessage(to: string, code: string) {
  if (!PHONE_PATTERN.test(to)) throw new Error("The WhatsApp recipient is invalid.")
  if (!new RegExp(`^[0-9]{${SPC_MFA_TEST_CODE_LENGTH}}$`).test(code)) {
    throw new Error("The WhatsApp MFA test code is invalid.")
  }

  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "template",
    template: {
      name: SPC_MFA_TEST_TEMPLATE_NAME,
      language: { code: SPC_MFA_TEST_TEMPLATE_LANGUAGE },
      components: [
        {
          type: "body",
          parameters: [{ type: "text", text: code }],
        },
        {
          type: "button",
          sub_type: "url",
          index: "0",
          parameters: [{ type: "text", text: code }],
        },
      ],
    },
  }
}

export async function sendSpcMfaTestCode(
  input: { to: string; code: string },
  fetchImpl: typeof fetch = fetch,
) {
  const accessToken = requireEnv("WHATSAPP_ACCESS_TOKEN")
  const graphVersion = requireEnv("WHATSAPP_GRAPH_API_VERSION")
  const phoneNumberId = requireEnv("SPC_WHATSAPP_MFA_TEST_PHONE_NUMBER_ID")
  if (!GRAPH_VERSION_PATTERN.test(graphVersion) || !GRAPH_ID_PATTERN.test(phoneNumberId)) {
    throw new SpcMfaTestDeliveryError("configuration")
  }

  let response: Response
  try {
    response = await fetchImpl(
      `https://graph.facebook.com/${graphVersion}/${phoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(buildSpcMfaAuthenticationMessage(input.to, input.code)),
        cache: "no-store",
        signal: AbortSignal.timeout(META_REQUEST_TIMEOUT_MS),
      },
    )
  } catch (error) {
    if (
      error instanceof DOMException &&
      (error.name === "AbortError" || error.name === "TimeoutError")
    ) {
      throw new SpcMfaTestDeliveryError("timeout")
    }
    throw new SpcMfaTestDeliveryError("rejected")
  }

  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    const upstreamCode = safeUpstreamCode(payload)
    throw new SpcMfaTestDeliveryError(
      upstreamCode === "132001" ? "template-unavailable" : "rejected",
      {
        upstreamStatus: response.status,
        upstreamCode: upstreamCode || undefined,
      },
    )
  }

  const messageId = safeMessageId(payload)
  if (!messageId) throw new SpcMfaTestDeliveryError("invalid-response")
  return { messageId }
}

export async function beginSpcMfaTestChallenge(input: {
  targetUserId: string
  createdByUserId: string
}) {
  assertUuid(input.targetUserId, "Target SPC user ID")
  assertUuid(input.createdByUserId, "Administrator SPC user ID")
  const challengeId = randomUUID()
  const code = generateSpcMfaTestCode()
  const expiresAt = new Date(Date.now() + SPC_MFA_TEST_EXPIRY_SECONDS * 1000).toISOString()
  const codeHash = hashSpcMfaTestCode(challengeId, input.targetUserId, code)
  if (!HASH_PATTERN.test(codeHash)) throw new Error("The WhatsApp MFA test hash is invalid.")

  const { data, error } = await getServiceClient()
    .rpc("begin_spc_whatsapp_mfa_test_challenge", {
      p_challenge_id: challengeId,
      p_target_user_id: input.targetUserId,
      p_created_by_user_id: input.createdByUserId,
      p_code_hash: codeHash,
      p_expires_at: expiresAt,
    })
    .single()

  if (error || !data) throw new Error("SPC MFA test challenge creation failed.")
  const row = data as BeginChallengeRow
  if (typeof row.allowed !== "boolean") {
    throw new Error("SPC MFA test challenge decision is invalid.")
  }

  const retryAfterSeconds = Number(row.retry_after_seconds)
  if (
    !Number.isSafeInteger(retryAfterSeconds) ||
    retryAfterSeconds < 0 ||
    retryAfterSeconds > SPC_MFA_TEST_MAX_RETRY_SECONDS
  ) {
    throw new Error("SPC MFA test retry period is invalid.")
  }

  if (!row.allowed) {
    if (retryAfterSeconds < 1) {
      throw new Error("SPC MFA test challenge decision is inconsistent.")
    }
    return { allowed: false as const, retryAfterSeconds }
  }

  const returnedChallengeId = String(row.challenge_id || "")
  assertUuid(returnedChallengeId, "Challenge ID")
  if (returnedChallengeId !== challengeId || retryAfterSeconds !== 0) {
    throw new Error("SPC MFA test challenge decision is inconsistent.")
  }

  return {
    allowed: true as const,
    challengeId,
    code,
    expiresAt: parseExpiry(row.challenge_expires_at),
  }
}

export async function completeSpcMfaTestDelivery(input: {
  challengeId: string
  createdByUserId: string
  succeeded: boolean
  messageId?: string
}) {
  assertUuid(input.challengeId, "Challenge ID")
  assertUuid(input.createdByUserId, "Administrator SPC user ID")
  const { data, error } = await getServiceClient().rpc(
    "complete_spc_whatsapp_mfa_test_delivery",
    {
      p_challenge_id: input.challengeId,
      p_created_by_user_id: input.createdByUserId,
      p_succeeded: input.succeeded,
      p_message_id: input.succeeded ? input.messageId || null : null,
    },
  )

  if (error || data !== true) {
    throw new Error("SPC MFA test delivery state could not be saved.")
  }
}

export async function verifySpcMfaTestChallenge(input: {
  challengeId: string
  targetUserId: string
  createdByUserId: string
  code: string
}) {
  assertUuid(input.challengeId, "Challenge ID")
  assertUuid(input.targetUserId, "Target SPC user ID")
  assertUuid(input.createdByUserId, "Administrator SPC user ID")
  const candidateHash = hashSpcMfaTestCode(
    input.challengeId,
    input.targetUserId,
    input.code,
  )
  const { data, error } = await getServiceClient()
    .rpc("verify_spc_whatsapp_mfa_test_challenge", {
      p_challenge_id: input.challengeId,
      p_target_user_id: input.targetUserId,
      p_created_by_user_id: input.createdByUserId,
      p_candidate_hash: candidateHash,
    })
    .single()

  if (error || !data) throw new Error("SPC MFA test verification failed.")
  const row = data as VerifyChallengeRow
  const result = String(row.result || "") as SpcMfaTestVerificationResult
  if (
    result !== "verified" &&
    result !== "mismatch" &&
    result !== "locked" &&
    result !== "expired" &&
    result !== "already_used" &&
    result !== "unavailable"
  ) {
    throw new Error("SPC MFA test verification result is invalid.")
  }

  return {
    result,
    attemptsRemaining: parseAttemptsRemaining(row.attempts_remaining),
    expiresAt:
      row.challenge_expires_at === null
        ? null
        : parseExpiry(row.challenge_expires_at),
  }
}

export async function getActiveSpcMfaTestChallenge(createdByUserId: string) {
  assertUuid(createdByUserId, "Administrator SPC user ID")
  const { data, error } = await getServiceClient()
    .rpc("get_active_spc_whatsapp_mfa_test_challenge", {
      p_created_by_user_id: createdByUserId,
    })
    .maybeSingle()

  if (error) throw new Error("SPC MFA test challenge status failed.")
  if (!data) return null
  const row = data as ActiveChallengeRow
  const challengeId = String(row.challenge_id || "")
  const targetUserId = String(row.target_user_id || "")
  assertUuid(challengeId, "Challenge ID")
  assertUuid(targetUserId, "Target SPC user ID")

  return {
    challengeId,
    targetUserId,
    expiresAt: parseExpiry(row.challenge_expires_at),
    attemptsRemaining: parseAttemptsRemaining(row.attempts_remaining),
  }
}

export function buildSpcMfaTestAuditEvent(
  context: SpcAuditContext,
  input: {
    status: SpcMfaTestAuditStatus
    outcome: SpcAuditOutcome
    challengeId?: string | null
    target: Pick<SpcMfaTestTarget, "id" | "username" | "phoneHint">
    messageId?: string | null
  },
) {
  const safeMessage = input.messageId?.trim().slice(0, 512) || null
  return {
    actor_user_id: context.actorUserId,
    actor_id: `spc:${context.username}`,
    actor_name: context.displayName,
    actor_source: "app",
    table_schema: "app",
    table_name: "spc_mfa_test_events",
    operation: "INSERT" as const,
    record_pk: {
      requestId: context.requestId,
      status: input.status,
      ...(input.challengeId ? { challengeId: input.challengeId } : {}),
    },
    changed_fields: ["status", "outcome"],
    before_row: null,
    after_row: {
      schema: "fcuno.spc-whatsapp-mfa-test-audit/v1",
      title: "WhatsApp MFA test",
      action: context.action,
      status: input.status,
      outcome: input.outcome,
      target_id: input.target.id,
      target_username: input.target.username,
      ...(input.target.phoneHint ? { phone_hint: input.target.phoneHint } : {}),
      ...(safeMessage ? { whatsapp_message_id: safeMessage } : {}),
    },
    request_context: {
      pageId: context.pageId,
      pageLabel: context.pageLabel,
      pagePath: context.pagePath,
      sourceIp: context.sourceIp,
      correlationId: context.correlationId,
      requestId: context.requestId,
      platformRequestId: context.platformRequestId,
      actorRole: context.actorRole,
      action: context.action,
      targetType: "spc-user",
      targetId: input.target.id,
      targetUsername: input.target.username,
      outcome: input.outcome,
    },
  }
}

export async function recordSpcMfaTestAuditEvent(
  context: SpcAuditContext,
  input: Parameters<typeof buildSpcMfaTestAuditEvent>[1],
) {
  const { error } = await createSpcAuditedSupabaseClient(context)
    .from("audit_logs")
    .insert(buildSpcMfaTestAuditEvent(context, input))
  if (error) throw new Error("SPC MFA test audit evidence could not be saved.")
}
