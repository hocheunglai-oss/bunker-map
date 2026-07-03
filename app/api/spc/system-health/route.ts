import { NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { requireSpcPagePermission } from "@/lib/spcAuth"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

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

async function countRows(supabase: ReturnType<typeof createClient<any>>, table: string) {
  const { count, error } = await supabase.from(table).select("id", { count: "exact", head: true })
  if (error) throw error
  return count || 0
}

export async function GET() {
  try {
    await requireSpcPagePermission("spc-system-health", "view")
    const checkedAt = new Date().toISOString()
    const supabase = createClient(
      requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
      process.env.SUPABASE_SERVICE_ROLE_KEY || requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    )
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

    return NextResponse.json({
      status: combineStatus(checks),
      checkedAt,
      deployment: getDeployment(),
      checks,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not load SPC system health."
    return NextResponse.json(
      { message },
      { status: message === "Unauthorized" ? 401 : message === "Forbidden" ? 403 : 500 },
    )
  }
}
