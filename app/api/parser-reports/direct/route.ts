import { createClient } from "@supabase/supabase-js"
import { NextResponse } from "next/server"
import {
  parserReportCounts,
  parserReportFromRow,
  parserReportWithState,
  type ParserReportRow,
  type ParserReportSource,
} from "@/lib/parserReports"

export const dynamic = "force-dynamic"

function requireEnv(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing environment variable: ${name}`)
  return value
}

function sourceFrom(value: string | null): ParserReportSource | "all" {
  return value === "enquiryworksheet" || value === "spc" ? value : "all"
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const source = sourceFrom(searchParams.get("source"))
    const includeResolved = searchParams.get("includeResolved") === "1"
    const supabase = createClient(
      requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
      requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    )

    const { data, error } = await supabase
      .from("parser_reports")
      .select("*")
      .order("last_reported_at", { ascending: false })
      .limit(500)

    if (error) throw error

    const reportsWithState = ((data || []) as ParserReportRow[])
      .map(parserReportFromRow)
      .map(parserReportWithState)
    const sourceReports = source === "all"
      ? reportsWithState
      : reportsWithState.filter((report) => report.source === source)
    const reports = includeResolved
      ? sourceReports
      : sourceReports.filter((report) => report.status === "new" && !report.resolved)
    const enquiryworksheet = reportsWithState.filter((report) => report.source === "enquiryworksheet")
    const spc = reportsWithState.filter((report) => report.source === "spc")

    return NextResponse.json({
      source,
      reports,
      counts: {
        all: parserReportCounts(reportsWithState),
        enquiryworksheet: parserReportCounts(enquiryworksheet),
        spc: parserReportCounts(spc),
      },
      updatedAt: reportsWithState[0]?.updatedAt || null,
      includeResolved,
    })
  } catch (error) {
    return NextResponse.json(
      { message: error instanceof Error ? error.message : "Failed to load parser reports." },
      { status: 500 },
    )
  }
}
