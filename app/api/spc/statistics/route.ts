import { NextResponse } from "next/server"
import { requireSpcPagePermission } from "@/lib/spcAuth"
import { loadSpcStatistics } from "@/lib/spcStatistics"
import type { SpcSession } from "@/lib/spcAuth"
import { timedJson } from "@/lib/serverTiming"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const STATISTICS_CACHE_MS = 60_000
type StatisticsPayload = Awaited<ReturnType<typeof loadSpcStatistics>>

const statisticsCache = new Map<string, { value: StatisticsPayload; expiresAt: number }>()
const statisticsPromises = new Map<string, Promise<StatisticsPayload>>()

function statisticsCacheKey(year: string | null) {
  return /^\d{4}$/.test(year || "") ? year as string : "current"
}

async function loadCachedStatistics(
  session: SpcSession,
  year: string | null,
  forceRefresh: boolean,
) {
  const key = statisticsCacheKey(year)
  const cached = statisticsCache.get(key)
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) {
    return { value: cached.value, cacheStatus: "hit" as const }
  }

  const pending = statisticsPromises.get(key)
  if (pending) {
    return { value: await pending, cacheStatus: "deduped" as const }
  }

  const promise = loadSpcStatistics(session, year)
  statisticsPromises.set(key, promise)
  try {
    const value = await promise
    statisticsCache.set(key, { value, expiresAt: Date.now() + STATISTICS_CACHE_MS })
    return { value, cacheStatus: forceRefresh ? "refresh" as const : "miss" as const }
  } catch (error) {
    if (cached) return { value: cached.value, cacheStatus: "stale" as const }
    throw error
  } finally {
    statisticsPromises.delete(key)
  }
}

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "Failed to load SPC statistics."
  return NextResponse.json(
    { message },
    { status: message === "Unauthorized" ? 401 : message === "Forbidden" ? 403 : 500 },
  )
}

export async function GET(request: Request) {
  const startedAt = Date.now()
  try {
    const session = await requireSpcPagePermission("spc-statistics", "view")
    const searchParams = new URL(request.url).searchParams
    const year = searchParams.get("year")
    const statistics = await loadCachedStatistics(
      session,
      year,
      searchParams.get("refresh") === "1",
    )
    return timedJson(
      "/api/spc/statistics",
      startedAt,
      statistics.value,
      { headers: { "Cache-Control": "private, no-store" } },
      { cache: statistics.cacheStatus, year: statistics.value.selectedYear },
    )
  } catch (error) {
    return errorResponse(error)
  }
}
