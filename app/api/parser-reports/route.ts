import { createHash, randomUUID } from "crypto"
import { NextResponse } from "next/server"
import { requireAdminPagePermission } from "@/lib/adminAuth"
import {
  createAdminAuditContext,
  createAdminAuditedSupabaseClient,
} from "@/lib/adminAudit"
import { requireSpcPagePermission } from "@/lib/spcAuth"
import {
  createSpcAuditContext,
  createSpcAuditedSupabaseClient,
} from "@/lib/spcAudit"
import {
  buildShortenedEnquiry,
  type VlsfoMaxRemark,
} from "@/lib/enquiryShortener"
import { parseEnquiryWorksheetGuess } from "@/lib/enquiryWorksheetParser"
import { parseSpcEnquiryText } from "@/lib/spcEnquiryText"

const STORE_KEY = "parser-reports"
const MAX_REPORTS = 500
const MAX_TEXT_LENGTH = 20_000
const MAX_NOTE_LENGTH = 2_000
const REVIEWED_REPORT_CUTOFF_MS = Date.parse("2026-07-08T06:15:00.000Z")

type ParserReportSource = "enquiryworksheet" | "spc"

type ParserReportPayload = {
  source?: unknown
  context?: unknown
  rawText?: unknown
  cleanedText?: unknown
  parserOutput?: unknown
  correctedOutput?: unknown
  note?: unknown
  pageUrl?: unknown
  metadata?: unknown
}

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

function asString(value: unknown, maxLength = MAX_TEXT_LENGTH) {
  return String(typeof value === "string" ? value : "")
    .replace(/\r\n?/g, "\n")
    .trim()
    .slice(0, maxLength)
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function sourceFrom(value: unknown): ParserReportSource | null {
  return value === "enquiryworksheet" || value === "spc" ? value : null
}

function fingerprintFor(input: {
  source: ParserReportSource
  rawText: string
  parserOutput: string
  correctedOutput: string
}) {
  return createHash("sha256")
    .update(input.source)
    .update("\0")
    .update(input.rawText)
    .update("\0")
    .update(input.parserOutput)
    .update("\0")
    .update(input.correctedOutput)
    .digest("hex")
}

function appCommit() {
  return process.env.VERCEL_GIT_COMMIT_SHA ||
    process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA ||
    process.env.VERCEL_GIT_COMMIT_REF ||
    ""
}

function cleanStoredPayload(value: unknown): ParserReportsPayload {
  const record = asRecord(value)
  const reports = Array.isArray(record.reports)
    ? record.reports.filter((item): item is ParserReportRecord => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return false
        return typeof (item as { id?: unknown }).id === "string"
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
  const manualVlsfoMaxRemarks = manualVlsfoMaxRemarksFrom(report.metadata)

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

function isResolvedReport(report: ParserReportRecord) {
  try {
    const currentOutput = currentParserOutputFor(report)
    if (!currentOutput.trim()) return false
    return normalizeComparableOutput(currentOutput) === normalizeComparableOutput(report.correctedOutput)
  } catch {
    return false
  }
}

function isReviewedReport(report: ParserReportRecord) {
  const timestamp = Date.parse(report.lastReportedAt || report.createdAt || "")
  return Number.isFinite(timestamp) && timestamp <= REVIEWED_REPORT_CUTOFF_MS
}

async function getSessionAndClient(
  source: ParserReportSource,
  request: Request,
  access: "view" | "edit",
) {
  if (source === "spc") {
    const session = await requireSpcPagePermission("spc-buyer-enquiries", access)
    return {
      username: session.username || "spc",
      displayName: session.displayName || session.username || "SPC",
      supabase: createSpcAuditedSupabaseClient(
        createSpcAuditContext(session, request, "spc-buyer-enquiries"),
      ),
    }
  }

  const session = await requireAdminPagePermission("enquiry-worksheet", access)
  return {
    username: session.username || "admin",
    displayName: session.displayName || session.username || "Admin",
    supabase: createAdminAuditedSupabaseClient(
      createAdminAuditContext(session, request, "enquiry-worksheet"),
      { useServiceRole: true },
    ),
  }
}

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "Failed to save parser report."
  const status = message === "Unauthorized" ? 401 : message === "Forbidden" ? 403 : 500
  return NextResponse.json({ message }, { status })
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const source = sourceFrom(searchParams.get("source"))
    const summaryOnly = searchParams.get("summary") === "1"
    if (!source) {
      return NextResponse.json({ message: "Report source is required." }, { status: 400 })
    }

    const { supabase } = await getSessionAndClient(source, request, "view")
    const { data: currentRow, error } = await supabase
      .from("office_calendar_store")
      .select("payload, updated_at")
      .eq("key", STORE_KEY)
      .maybeSingle()

    if (error) throw error

    const payload = cleanStoredPayload(currentRow?.payload || null)
    const sourceReports = payload.reports.filter((report) => report.source === source)
    const reviewedReports = sourceReports.filter(isReviewedReport)
    const unresolvedReports = sourceReports.filter((report) => !isReviewedReport(report) && !isResolvedReport(report))

    return NextResponse.json({
      source,
      ...(summaryOnly ? {} : { reports: unresolvedReports }),
      unresolvedReports: unresolvedReports.length,
      totalReports: sourceReports.length,
      resolvedReports: sourceReports.length - unresolvedReports.length,
      reviewedReports: reviewedReports.length,
      updatedAt: currentRow?.updated_at || null,
    })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as ParserReportPayload
    const source = sourceFrom(payload.source)
    if (!source) {
      return NextResponse.json({ message: "Report source is required." }, { status: 400 })
    }

    const rawText = asString(payload.rawText)
    const parserOutput = asString(payload.parserOutput)
    const correctedOutput = asString(payload.correctedOutput)
    if (!rawText || !correctedOutput) {
      return NextResponse.json(
        { message: "Raw enquiry and corrected output are required." },
        { status: 400 },
      )
    }

    const { username, displayName, supabase } = await getSessionAndClient(source, request, "edit")
    const now = new Date().toISOString()
    const fingerprint = fingerprintFor({ source, rawText, parserOutput, correctedOutput })

    const { data: currentRow, error: loadError } = await supabase
      .from("office_calendar_store")
      .select("payload")
      .eq("key", STORE_KEY)
      .maybeSingle()

    if (loadError) throw loadError

    const currentPayload = cleanStoredPayload(currentRow?.payload || null)
    const existingIndex = currentPayload.reports.findIndex((report) => report.fingerprint === fingerprint)
    let savedReport: ParserReportRecord
    const metadata = asRecord(payload.metadata)

    if (existingIndex >= 0) {
      const existing = currentPayload.reports[existingIndex]
      savedReport = {
        ...existing,
        note: asString(payload.note, MAX_NOTE_LENGTH) || existing.note,
        pageUrl: asString(payload.pageUrl, 1_000) || existing.pageUrl,
        metadata: { ...existing.metadata, ...metadata },
        duplicateCount: existing.duplicateCount + 1,
        lastReportedAt: now,
      }
      currentPayload.reports.splice(existingIndex, 1)
    } else {
      savedReport = {
        id: randomUUID(),
        fingerprint,
        source,
        context: asString(payload.context, 120),
        rawText,
        cleanedText: asString(payload.cleanedText),
        parserOutput,
        correctedOutput,
        note: asString(payload.note, MAX_NOTE_LENGTH),
        pageUrl: asString(payload.pageUrl, 1_000),
        metadata,
        status: "new",
        duplicateCount: 1,
        createdAt: now,
        lastReportedAt: now,
        createdByUsername: username,
        createdByDisplayName: displayName,
        appCommit: appCommit(),
      }
    }

    const nextPayload: ParserReportsPayload = {
      version: 1,
      reports: [savedReport, ...currentPayload.reports].slice(0, MAX_REPORTS),
    }

    const { error: saveError } = await supabase.from("office_calendar_store").upsert({
      key: STORE_KEY,
      payload: nextPayload,
      updated_at: now,
    })

    if (saveError) throw saveError
    return NextResponse.json({ success: true, report: savedReport })
  } catch (error) {
    return errorResponse(error)
  }
}
