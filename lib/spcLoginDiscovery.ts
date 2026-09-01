import { isIP } from "node:net"
import { createClient } from "@supabase/supabase-js"
import { hashSpcLoginUsername } from "@/lib/spcLoginSecurity"

export const SPC_LOGIN_DISCOVERY_WINDOW_SECONDS = 15 * 60
export const SPC_LOGIN_DISCOVERY_USERNAME_LIMIT = 20
export const SPC_LOGIN_DISCOVERY_SOURCE_IP_LIMIT = 100

type DiscoveryRow = {
  allowed: unknown
  retry_after_seconds: unknown
  blocked_by: unknown
  blocked_count: unknown
}

export type SpcLoginDiscoveryDecision = {
  allowed: boolean
  retryAfterSeconds: number
  blockedBy: "username" | "source_ip" | "username_and_source_ip" | null
  blockedCount: string
}

function requireEnv(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing environment variable: ${name}`)
  return value
}

function serviceClient() {
  return createClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { autoRefreshToken: false, persistSession: false } },
  )
}

export async function beginSpcLoginDiscovery(input: {
  username: string
  trustedSourceIp: string
  requestId: string
}): Promise<SpcLoginDiscoveryDecision> {
  if (isIP(input.trustedSourceIp) === 0) {
    throw new Error("Trusted source IP is unavailable or invalid.")
  }

  const { data, error } = await serviceClient()
    .rpc("begin_spc_login_discovery", {
      p_username_hash: hashSpcLoginUsername(input.username),
      p_source_ip: input.trustedSourceIp,
      p_request_id: input.requestId,
    })
    .single()

  if (error) throw error
  if (!data) throw new Error("Login discovery decision is unavailable.")

  const row = data as DiscoveryRow
  const retryAfterSeconds = Number(row.retry_after_seconds)
  const blockedCount = String(row.blocked_count)
  const blockedBy = row.blocked_by === null
    ? null
    : String(row.blocked_by) as SpcLoginDiscoveryDecision["blockedBy"]
  if (
    typeof row.allowed !== "boolean" ||
    !Number.isSafeInteger(retryAfterSeconds) ||
    retryAfterSeconds < 0 ||
    retryAfterSeconds > SPC_LOGIN_DISCOVERY_WINDOW_SECONDS ||
    !/^[0-9]+$/.test(blockedCount) ||
    ![null, "username", "source_ip", "username_and_source_ip"].includes(blockedBy) ||
    (row.allowed && (retryAfterSeconds !== 0 || blockedBy !== null)) ||
    (!row.allowed && (retryAfterSeconds < 1 || blockedBy === null))
  ) {
    throw new Error("Login discovery decision is invalid.")
  }

  return {
    allowed: row.allowed,
    retryAfterSeconds,
    blockedBy,
    blockedCount,
  }
}
