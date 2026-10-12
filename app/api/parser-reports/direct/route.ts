import { createClient } from "@supabase/supabase-js"
import { requireAdminPagePermission } from "@/lib/adminAuth"
import { parserReportAccessPage } from "@/lib/parserReportAccess"
import {
  parserReportCounts,
  parserReportFromRow,
  parserReportWithState,
  type ParserReportRow,
  type ParserReportSource,
} from "@/lib/parserReports"
import { requireSpcPagePermission } from "@/lib/spcAuth"
import { spcPrivateJson } from "@/lib/spcResponse"

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

    // This diagnostic/export response always includes both sources' counts,
    // even when its report list is source-filtered. Both review permissions
    // must succeed before constructing the privileged client or reading data.
    await requireAdminPagePermission(parserReportAccessPage("enquiryworksheet", true), "view")
    await requireSpcPagePermission(parserReportAccessPage("spc", true), "view")

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
    const pendingAiReports = sourceReports.filter((report) => report.pendingAiReview)
    const readyForUserReports = sourceReports.filter((report) => report.readyForUserReview)
    const reports = includeResolved
      ? sourceReports
      : pendingAiReports
    const enquiryworksheet = reportsWithState.filter((report) => report.source === "enquiryworksheet")
    const spc = reportsWithState.filter((report) => report.source === "spc")

    return spcPrivateJson({
      source,
      reports,
      pendingAiReports,
      readyForUserReports,
      counts: {
        all: parserReportCounts(reportsWithState),
        enquiryworksheet: parserReportCounts(enquiryworksheet),
        spc: parserReportCounts(spc),
      },
      updatedAt: reportsWithState[0]?.updatedAt || null,
      includeResolved,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : ""
    const status = message === "Unauthorized" ? 401 : message === "Forbidden" ? 403 : 500
    return spcPrivateJson(
      { message: status === 500 ? "Failed to load parser reports." : message },
      { status },
    )
  }
}
