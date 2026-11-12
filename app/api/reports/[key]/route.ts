import { NextResponse } from "next/server"
import { isReportSnapshotKey } from "@/lib/publicMarketData"
import { readAndRememberPublicReport } from "@/lib/publicReportAvailability"

export const dynamic = "force-dynamic"
const REPORT_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  "CDN-Cache-Control": "no-store",
  "Vercel-CDN-Cache-Control": "no-store",
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ key: string }> },
) {
  const { key } = await context.params
  if (!isReportSnapshotKey(key)) {
    return NextResponse.json({ message: "Unknown report." }, { status: 404, headers: REPORT_HEADERS })
  }

  try {
    return NextResponse.json(await readAndRememberPublicReport(key), {
      headers: REPORT_HEADERS,
    })
  } catch (error) {
    console.error("Report data load failed", error)
    return NextResponse.json({ message: "Unable to load report data." }, { status: 502, headers: REPORT_HEADERS })
  }
}
