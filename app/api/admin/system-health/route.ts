import { NextResponse } from "next/server"
import { requireAdminPagePermission } from "@/lib/adminAuth"
import { getSystemHealth } from "@/lib/systemHealth"
import { timedJson } from "@/lib/serverTiming"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 240

const HEALTH_CACHE_MS = 60_000
let cachedHealth: { expiresAt: number; value: Awaited<ReturnType<typeof getSystemHealth>> } | null = null
let healthPromise: Promise<Awaited<ReturnType<typeof getSystemHealth>>> | null = null

async function loadHealth(forceRefresh: boolean) {
  if (!forceRefresh && cachedHealth && cachedHealth.expiresAt > Date.now()) {
    return cachedHealth.value
  }
  if (!forceRefresh && healthPromise) return healthPromise

  healthPromise = getSystemHealth()
  try {
    const value = await healthPromise
    cachedHealth = { expiresAt: Date.now() + HEALTH_CACHE_MS, value }
    return value
  } finally {
    healthPromise = null
  }
}

export async function GET(request: Request) {
  const startedAt = Date.now()
  try {
    await requireAdminPagePermission("system-health", "view")
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unauthorized"
    return NextResponse.json(
      { message },
      { status: message === "Unauthorized" ? 401 : 403 }
    )
  }

  const forceRefresh = new URL(request.url).searchParams.get("refresh") === "1"
  const health = await loadHealth(forceRefresh)
  return timedJson("/api/admin/system-health", startedAt, health, undefined, {
    forceRefresh,
    status: health.status,
  })
}
