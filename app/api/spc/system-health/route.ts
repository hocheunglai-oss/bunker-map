import { createClient } from "@supabase/supabase-js"
import { requireSpcPagePermission } from "@/lib/spcAuth"
import { getEmailNoticeConfigStatus } from "@/lib/emailNotice"
import { timedJson } from "@/lib/serverTiming"
import { spcPrivateJson } from "@/lib/spcResponse"
import { fcunoConnectionPolicy } from "@/config/fcunoConnections"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
const HEALTH_CACHE_MS = 60_000
const HEALTH_TIMEOUT_MS = 15_000

type HealthStatus = "ok" | "warning" | "error"

function requireEnv(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing environment variable: ${name}`)
  return value
}

function getDeployment() {
  const commit = process.env.DEPLOY_COMMIT || process.env.NEXT_PUBLIC_DEPLOY_COMMIT || process.env.VERCEL_GIT_COMMIT_SHA || "unknown"
  return {
    commit,
    shortCommit: commit === "unknown" ? commit : commit.slice(0, 7),
    branch: process.env.DEPLOY_BRANCH || process.env.VERCEL_GIT_COMMIT_REF || "unknown",
    deployedAt: process.env.DEPLOYED_AT || (process.env.VERCEL_GIT_COMMIT_SHA && process.env.VERCEL_ENV ? "vercel" : "unknown"),
    environment: process.env.VERCEL_ENV || process.env.NODE_ENV || "unknown",
  }
}

function combineStatus(checks: Array<{ status: HealthStatus }>): HealthStatus {
  if (checks.some((check) => check.status === "error")) return "error"
  if (checks.some((check) => check.status === "warning")) return "warning"
  return "ok"
}

function getHealthSupabaseClient() {
  return createClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    process.env.SUPABASE_SERVICE_ROLE_KEY || requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
  )
}

async function countRows(supabase: ReturnType<typeof getHealthSupabaseClient>, table: string, signal: AbortSignal) {
  const { count, error } = await supabase.from(table).select("id", { count: "exact", head: true }).abortSignal(signal)
  if (error) throw error
  if (count === null || !Number.isSafeInteger(count) || count < 0) throw new Error("A table count could not be verified.")
  return count
}

async function getSpcHealth(signal: AbortSignal, checkedAt: string) {
  const supabase = getHealthSupabaseClient()
  const emailNotice = getEmailNoticeConfigStatus()
  const [users, enquiries, fixtures] = await Promise.all([
    countRows(supabase, "spc_users", signal),
    countRows(supabase, "spc_enquiries", signal),
    countRows(supabase, "spc_fixtures", signal),
  ])
  const checks = [
    {
      id: "spc-auth-users",
      label: "SPC USERS",
      status: users > 0 ? "ok" as const : "warning" as const,
      message: users > 0 ? "SPC user table reachable" : "No SPC users found",
      checkedAt,
      details: { users },
    },
    {
      id: "spc-enquiries",
      label: "SPC ENQUIRIES",
      status: "ok" as const,
      message: "SPC enquiry table reachable",
      checkedAt,
      details: { enquiries },
    },
    {
      id: "spc-fixtures",
      label: "SPC FIXTURES",
      status: "ok" as const,
      message: "SPC fixture table reachable",
      checkedAt,
      details: { fixtures },
    },
    {
      id: "spc-domain",
      label: "SPC DOMAIN",
      status: "ok" as const,
      message: "Configured SPC domain; this is not a live DNS check",
      checkedAt,
      details: { domain: new URL(fcunoConnectionPolicy.vercel.productionOrigins[1]).hostname },
    },
    {
      id: "spc-speedboard-update-email",
      label: "SPEED BOARD UPDATE EMAIL",
      status: emailNotice.missing.length ? "warning" as const : "ok" as const,
      message: emailNotice.missing.length
        ? "Exchange notice email configuration incomplete"
        : "Exchange notice email settings present; delivery is not tested",
      checkedAt,
      details: {
        sender: emailNotice.from,
        host: emailNotice.host,
        missing: emailNotice.missing.join(", ") || "none",
      },
    },
  ]

  return {
    status: combineStatus(checks),
    checkedAt,
    deployment: getDeployment(),
    checks,
  }
}

type SpcHealth = Awaited<ReturnType<typeof getSpcHealth>>
type HealthResult = { value: SpcHealth & { freshness: { state: "fresh" | "cached" | "stale"; attemptedAt: string } }; cacheStatus: "fresh" | "cached" | "stale" }
let cachedHealth: { value: SpcHealth; expiresAt: number; failedAttemptAt?: string } | null = null
let healthPromise: Promise<HealthResult> | null = null

function result(value: SpcHealth, state: "fresh" | "cached" | "stale", attemptedAt: string): HealthResult {
  return { value: { ...value, freshness: { state, attemptedAt } }, cacheStatus: state }
}

async function loadHealth(forceRefresh: boolean) {
  if (!forceRefresh && cachedHealth && cachedHealth.expiresAt > Date.now()) {
    return result(cachedHealth.value, cachedHealth.failedAttemptAt ? "stale" : "cached", cachedHealth.failedAttemptAt || new Date().toISOString())
  }
  if (healthPromise) {
    return healthPromise
  }

  const attemptedAt = new Date().toISOString()
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  healthPromise = (async () => {
    try {
      const deadline = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => {
        controller.abort()
        reject(new Error("SPC health check timed out."))
      }, HEALTH_TIMEOUT_MS) })
      const value = await Promise.race([getSpcHealth(controller.signal, attemptedAt), deadline])
      cachedHealth = { value, expiresAt: Date.now() + HEALTH_CACHE_MS }
      return result(value, "fresh", attemptedAt)
    } catch (error) {
      if (cachedHealth) {
        cachedHealth.failedAttemptAt = attemptedAt
        return result(cachedHealth.value, "stale", attemptedAt)
      }
      throw error
    } finally {
      clearTimeout(timer)
      controller.abort()
    }
  })()
  try { return await healthPromise } finally { healthPromise = null }
}

export async function GET(request: Request) {
  const startedAt = Date.now()
  try {
    await requireSpcPagePermission("spc-system-health", "view")
    const forceRefresh = new URL(request.url).searchParams.get("refresh") === "1"
    const health = await loadHealth(forceRefresh)
    return timedJson(
      "/api/spc/system-health",
      startedAt,
      health.value,
      undefined,
      { cache: health.cacheStatus, forceRefresh, status: health.value.status },
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not load SPC system health."
    return spcPrivateJson(
      { message },
      { status: message === "Unauthorized" ? 401 : message === "Forbidden" ? 403 : 500 },
    )
  }
}
