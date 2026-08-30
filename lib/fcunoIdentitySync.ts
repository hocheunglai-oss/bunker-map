import { randomUUID } from "node:crypto"
import { createClient } from "@supabase/supabase-js"
import { issueOidcToken } from "@/lib/fcunoOidc"

type OutboxRow = {
  id: string
  admin_user_id: string
  identity_revision: number
  payload: Record<string, unknown>
  attempt_count: number
  lease_token: string
}

function requireEnv(name: string) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Missing environment variable: ${name}`)
  return value
}

function getSyncTarget() {
  const rawUrl = requireEnv("FCOS_IDENTITY_SYNC_URL")
  let url: URL
  try { url = new URL(rawUrl) } catch { throw new Error("FCOS_IDENTITY_SYNC_URL must be an absolute HTTPS URL.") }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error("FCOS_IDENTITY_SYNC_URL must be an HTTPS URL without credentials or fragment.")
  }
  return { url: url.toString() }
}

function serviceClient() {
  return createClient(requireEnv("NEXT_PUBLIC_SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

function requiredString(payload: Record<string, unknown>, key: string) {
  const value = payload[key]
  if (typeof value !== "string" || !value) throw new Error(`Identity outbox payload has no valid ${key}.`)
  return value
}

function requiredBoolean(payload: Record<string, unknown>, key: string) {
  if (typeof payload[key] !== "boolean") throw new Error(`Identity outbox payload has no valid ${key}.`)
  return payload[key]
}

function requiredRevision(payload: Record<string, unknown>, key: string) {
  const value = payload[key]
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error(`Identity outbox payload has no valid ${key}.`)
  return value
}

export function issueFcosIdentitySyncToken(input: { eventId: string, occurredAt: string, payload: Record<string, unknown> }) {
  const emailVerified = requiredBoolean(input.payload, "email_verified")
  if (!emailVerified) throw new Error("FCOS identity sync requires a verified email identity.")
  return issueOidcToken({
    sub: requiredString(input.payload, "sub"),
    aud: "fcos-identity-sync",
    typ: "fcuno.identity-sync+jwt",
    jti: input.eventId,
    expiresInSeconds: 5 * 60,
    event_id: input.eventId,
    event_type: "fcuno.identity.v1",
    occurred_at: input.occurredAt,
    identity: {
      sub: requiredString(input.payload, "sub"),
      email: requiredString(input.payload, "email"),
      email_verified: true,
      username: requiredString(input.payload, "username"),
      display_name: requiredString(input.payload, "display_name"),
      is_active: requiredBoolean(input.payload, "is_active"),
      use_fcos: requiredBoolean(input.payload, "use_fcos"),
      use_spc: requiredBoolean(input.payload, "use_spc"),
      identity_revision: requiredRevision(input.payload, "identity_revision"),
      credential_revision: requiredRevision(input.payload, "credential_revision"),
      revoked_before: requiredString(input.payload, "revoked_before"),
    },
  })
}

function nextRetry(attemptCount: number) {
  const delaySeconds = Math.min(60 * 60, 2 ** Math.min(12, attemptCount) * 15)
  return new Date(Date.now() + delaySeconds * 1000).toISOString()
}

async function markDelivery(input: { row: OutboxRow, delivered: boolean, error?: string }) {
  const supabase = serviceClient()
  const update = input.delivered
    ? { delivered_at: new Date().toISOString(), lease_token: null, lease_expires_at: null, last_error: null }
    : { next_attempt_at: nextRetry(input.row.attempt_count), lease_token: null, lease_expires_at: null, last_error: (input.error || "Delivery failed.").slice(0, 1000) }
  const { error } = await supabase
    .from("fcuno_identity_sync_outbox")
    .update(update)
    .eq("id", input.row.id)
    .eq("lease_token", input.row.lease_token)
  if (error) throw error
  const { error: auditError } = await supabase.from("fcuno_identity_audit").insert({
    admin_user_id: input.row.admin_user_id,
    event_type: input.delivered ? "fcos.sync.delivered" : "fcos.sync.failed",
    details: { event_id: input.row.id, identity_revision: input.row.identity_revision, ...(input.error ? { error: input.error.slice(0, 300) } : {}) },
  })
  if (auditError) throw auditError
}

export async function processFcunoIdentitySyncOutbox(limit = 25) {
  const target = getSyncTarget()
  const leaseToken = randomUUID()
  const supabase = serviceClient()
  const { data, error } = await supabase.rpc("claim_fcuno_identity_sync_outbox", {
    p_limit: Math.max(1, Math.min(100, Math.floor(limit))),
    p_lease_token: leaseToken,
  })
  if (error) throw error
  const rows = (data || []) as OutboxRow[]
  let delivered = 0
  let failed = 0
  for (const row of rows) {
    const timestamp = new Date().toISOString()
    try {
      const token = issueFcosIdentitySyncToken({ eventId: row.id, occurredAt: timestamp, payload: row.payload })
      const response = await fetch(target.url, {
        method: "POST",
        redirect: "error",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "X-FCUNO-Event-Id": row.id,
          "X-FCUNO-Timestamp": timestamp,
        },
        body: "{}",
        signal: AbortSignal.timeout(15_000),
      })
      if (!response.ok) throw new Error(`FCOS returned HTTP ${response.status}.`)
      await markDelivery({ row: { ...row, lease_token: leaseToken }, delivered: true })
      delivered += 1
    } catch (error) {
      const message = error instanceof Error ? error.message : "FCOS identity delivery failed."
      await markDelivery({ row: { ...row, lease_token: leaseToken }, delivered: false, error: message })
      failed += 1
    }
  }
  return { claimed: rows.length, delivered, failed }
}
