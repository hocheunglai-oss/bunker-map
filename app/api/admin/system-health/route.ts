import { NextResponse } from "next/server"
import { requireAdminPagePermission } from "@/lib/adminAuth"
import { getSystemHealth } from "@/lib/systemHealth"
import { timedJson } from "@/lib/serverTiming"
import { createBackupProtectionGapPreviewObserver } from "@/lib/backupProtectionGapStore"
import { BackupProtectionObservationError } from "@/lib/backupProtectionPolicy"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 240

const HEALTH_CACHE_MS = 60_000
let cachedHealth: { expiresAt: number; value: Awaited<ReturnType<typeof getSystemHealth>> } | null = null
let healthPromise: Promise<Awaited<ReturnType<typeof getSystemHealth>>> | null = null

async function loadHealth(forceRefresh: boolean) {
  // A refresh bypasses completed cached data, not an already-running check.
  if (healthPromise) return healthPromise
  if (!forceRefresh && cachedHealth && cachedHealth.expiresAt > Date.now()) {
    return cachedHealth.value
  }

  const pendingHealth = getSystemHealth({ backupGapObserver: createBackupProtectionGapPreviewObserver() })
  healthPromise = pendingHealth
  try {
    const value = await pendingHealth
    cachedHealth = { expiresAt: Date.now() + HEALTH_CACHE_MS, value }
    return value
  } finally {
    if (healthPromise === pendingHealth) healthPromise = null
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
  let health: Awaited<ReturnType<typeof getSystemHealth>>
  try {
    health = await loadHealth(forceRefresh)
  } catch (error) {
    if (!(error instanceof BackupProtectionObservationError)) throw error
    return NextResponse.json({ message: "Backup protection is temporarily unavailable. Please try again." }, { status: 500 })
  }
  return timedJson("/api/admin/system-health", startedAt, health, undefined, {
    forceRefresh,
    status: health.status,
  })
}
