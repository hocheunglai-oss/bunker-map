import { NextResponse } from "next/server"
import {
  getPublicReportData,
  isReportSnapshotKey,
  publicMarketCacheHeaders,
} from "@/lib/publicMarketData"

export const dynamic = "force-dynamic"

export async function GET(
  _request: Request,
  context: { params: Promise<{ key: string }> },
) {
  const { key } = await context.params
  if (!isReportSnapshotKey(key)) {
    return NextResponse.json({ message: "Unknown report." }, { status: 404 })
  }

  try {
    return NextResponse.json(await getPublicReportData(key), {
      headers: key === "taiwan"
        ? {
            "Cache-Control": "no-store, max-age=0",
          }
        : publicMarketCacheHeaders(),
    })
  } catch (error) {
    console.error("Report data load failed", error)
    return NextResponse.json({ message: "Unable to load report data." }, { status: 502 })
  }
}
