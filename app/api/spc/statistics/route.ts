import { NextResponse } from "next/server"
import { requireSpcPagePermission } from "@/lib/spcAuth"
import { loadSpcStatistics } from "@/lib/spcStatistics"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "Failed to load SPC statistics."
  return NextResponse.json(
    { message },
    { status: message === "Unauthorized" ? 401 : message === "Forbidden" ? 403 : 500 },
  )
}

export async function GET(request: Request) {
  try {
    const session = await requireSpcPagePermission("spc-statistics", "view")
    const year = new URL(request.url).searchParams.get("year")
    const statistics = await loadSpcStatistics(session, year)
    return NextResponse.json(
      statistics,
      {
        headers: {
          "Cache-Control": "private, no-store",
        },
      },
    )
  } catch (error) {
    return errorResponse(error)
  }
}
