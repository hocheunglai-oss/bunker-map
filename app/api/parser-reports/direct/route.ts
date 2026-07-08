import { createClient } from "@supabase/supabase-js"
import { NextResponse } from "next/server"
import {
  buildShortenedEnquiry,
  type VlsfoMaxRemark,
} from "@/lib/enquiryShortener"
import { parseEnquiryWorksheetGuess } from "@/lib/enquiryWorksheetParser"
import { parseSpcEnquiryText } from "@/lib/spcEnquiryText"

const STORE_KEY = "parser-reports"

export const dynamic = "force-dynamic"

type ParserReportSource = "enquiryworksheet" | "spc"

type ParserReportRecord = {
  id: string
  fingerprint: string
  source: ParserReportSource
  context: string
  rawText: string
  cleanedText: string
  parserOutput: string
  correctedOutput: string
  note: string
  pageUrl: string
  metadata: Record<string, unknown>
  status: "new"
  duplicateCount: number
  createdAt: string
  lastReportedAt: string
  createdByUsername: string
  createdByDisplayName: string
  appCommit: string
}

type ParserReportsPayload = {
  version: 1
  reports: ParserReportRecord[]
}

function requireEnv(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing environment variable: ${name}`)
  return value
}

function sourceFrom(value: string | null): ParserReportSource | "all" {
  return value === "enquiryworksheet" || value === "spc" ? value : "all"
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function cleanStoredPayload(value: unknown): ParserReportsPayload {
  const record = asRecord(value)
  const reports = Array.isArray(record.reports)
    ? record.reports.filter((item): item is ParserReportRecord => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return false
        const source = (item as { source?: unknown }).source
        return (
          typeof (item as { id?: unknown }).id === "string" &&
          (source === "enquiryworksheet" || source === "spc")
        )
      })
    : []

  return {
    version: 1,
    reports,
  }
}

function manualVlsfoMaxRemarksFrom(metadata: Record<string, unknown>): VlsfoMaxRemark[] {
  const value = metadata.manualVlsfoMaxRemarks
  if (!Array.isArray(value)) return []
  return value.filter((item): item is VlsfoMaxRemark => item === "180cst max" || item === "120cst max")
}

function normalizeComparableOutput(value: string) {
  return value
    .toLowerCase()
    .replace(/\bhong\s+kong\b/g, "hk")
    .replace(/\bhkg\b/g, "hk")
    .replace(/香港/g, "hk")
    .replace(/\s+/g, " ")
    .trim()
}

function currentParserOutputFor(report: ParserReportRecord) {
  const manualVlsfoMaxRemarks = manualVlsfoMaxRemarksFrom(asRecord(report.metadata))

  if (report.source === "spc") {
    return parseSpcEnquiryText(report.rawText, manualVlsfoMaxRemarks).standardText
  }

  const sourceText = report.cleanedText || report.rawText
  const guess = parseEnquiryWorksheetGuess(sourceText)
  return buildShortenedEnquiry(
    sourceText,
    guess.vesselName,
    guess.imo,
    manualVlsfoMaxRemarks,
    {
      autoDetectVlsfoRemarks: false,
      includePort: true,
      port: guess.port,
    },
  )
}

function reportWithReviewState(report: ParserReportRecord) {
  const currentParserOutput = currentParserOutputFor(report)
  const resolved = Boolean(currentParserOutput.trim()) &&
    normalizeComparableOutput(currentParserOutput) === normalizeComparableOutput(report.correctedOutput)

  return {
    ...report,
    currentParserOutput,
    resolved,
  }
}

function countsFor(reports: Array<ReturnType<typeof reportWithReviewState>>) {
  const total = reports.length
  const resolved = reports.filter((report) => report.resolved).length
  return {
    total,
    unresolved: total - resolved,
    resolved,
  }
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
      .from("office_calendar_store")
      .select("payload, updated_at")
      .eq("key", STORE_KEY)
      .maybeSingle()

    if (error) throw error

    const payload = cleanStoredPayload(data?.payload || null)
    const reportsWithState = payload.reports.map(reportWithReviewState)
    const sourceReports = source === "all"
      ? reportsWithState
      : reportsWithState.filter((report) => report.source === source)
    const reports = includeResolved
      ? sourceReports
      : sourceReports.filter((report) => !report.resolved)

    const enquiryworksheet = reportsWithState.filter((report) => report.source === "enquiryworksheet")
    const spc = reportsWithState.filter((report) => report.source === "spc")

    return NextResponse.json({
      source,
      reports,
      counts: {
        all: countsFor(reportsWithState),
        enquiryworksheet: countsFor(enquiryworksheet),
        spc: countsFor(spc),
      },
      updatedAt: data?.updated_at || null,
      includeResolved,
    })
  } catch (error) {
    return NextResponse.json(
      { message: error instanceof Error ? error.message : "Failed to load parser reports." },
      { status: 500 },
    )
  }
}
