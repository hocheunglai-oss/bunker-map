import { NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { requireSpcPagePermission } from "@/lib/spcAuth"
import { timedJson } from "@/lib/serverTiming"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
const HEALTH_CACHE_MS = 60_000

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

async function countRows(supabase: ReturnType<typeof getHealthSupabaseClient>, table: string) {
  const { count, error } = await supabase.from(table).select("id", { count: "exact", head: true })
  if (error) throw error
  return count || 0
}

async function getSpcHealth() {
  const checkedAt = new Date().toISOString()
  const supabase = getHealthSupabaseClient()
  const [users, enquiries, fixtures] = await Promise.all([
    countRows(supabase, "spc_users"),
    countRows(supabase, "spc_enquiries"),
    countRows(supabase, "spc_fixtures"),
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
      message: "spc.fcuno.com is served by this Vercel project",
      checkedAt,
      details: { domain: "spc.fcuno.com" },
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
let cachedHealth: { value: SpcHealth; expiresAt: number } | null = null
let healthPromise: Promise<SpcHealth> | null = null

async function loadHealth(forceRefresh: boolean) {
  if (!forceRefresh && cachedHealth && cachedHealth.expiresAt > Date.now()) {
    return { value: cachedHealth.value, cacheStatus: "hit" as const }
  }
  if (healthPromise) {
    return { value: await healthPromise, cacheStatus: "deduped" as const }
  }

  const stale = cachedHealth?.value || null
  healthPromise = getSpcHealth()
  try {
    const value = await healthPromise
    cachedHealth = { value, expiresAt: Date.now() + HEALTH_CACHE_MS }
    return { value, cacheStatus: forceRefresh ? "refresh" as const : "miss" as const }
  } catch (error) {
    if (stale) return { value: stale, cacheStatus: "stale" as const }
    throw error
  } finally {
    healthPromise = null
  }
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
    return NextResponse.json(
      { message },
      { status: message === "Unauthorized" ? 401 : message === "Forbidden" ? 403 : 500 },
    )
  }
}
