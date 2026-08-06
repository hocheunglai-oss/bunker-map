import { createClient } from "@supabase/supabase-js"
import { NextResponse } from "next/server"
import { hasSpcSecurityMaintenanceAccess } from "@/lib/spcSecurityMaintenance"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const MAX_CLEANUP_BATCHES = 10
const CLEANUP_BATCH_SIZE = 10_000

function requireEnv(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing environment variable: ${name}`)
  return value
}

function maintenanceResponse(body: Record<string, unknown>, status: number) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  })
}

async function purgeExpiredSpcLoginAttempts() {
  const supabase = createClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { autoRefreshToken: false, persistSession: false } },
  )

  let deleted = 0
  let batches = 0

  while (batches < MAX_CLEANUP_BATCHES) {
    const { data, error } = await supabase.rpc("cleanup_spc_login_attempts")
    if (error) throw error

    const batchDeleted = Number(data)
    if (!Number.isSafeInteger(batchDeleted) || batchDeleted < 0) {
      throw new Error("SPC login-attempt cleanup returned an invalid count.")
    }

    deleted += batchDeleted
    batches += 1
    if (batchDeleted < CLEANUP_BATCH_SIZE) break
  }

  return { deleted, batches }
}

export async function GET(request: Request) {
  if (!hasSpcSecurityMaintenanceAccess(request)) {
    return maintenanceResponse({ message: "Unauthorized" }, 401)
  }

  try {
    const result = await purgeExpiredSpcLoginAttempts()
    console.info("[spc-security-maintenance]", {
      event: "login_attempt_retention_complete",
      ...result,
    })
    return maintenanceResponse({ success: true, ...result }, 200)
  } catch (error) {
    console.error("[spc-security-maintenance]", {
      event: "login_attempt_retention_failed",
      error: error instanceof Error ? error.message : "unknown",
    })
    return maintenanceResponse(
      { success: false, message: "SPC security maintenance failed." },
      500,
    )
  }
}
