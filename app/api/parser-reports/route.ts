import { createHash } from "crypto"
import { NextResponse } from "next/server"
import { requireAdminPagePermission } from "@/lib/adminAuth"
import {
  createAdminAuditContext,
  createAdminAuditedSupabaseClient,
} from "@/lib/adminAudit"
import {
  asParserReportMetadata,
  parserReportCounts,
  parserReportFromRow,
  parserReportWithState,
  type ParserReportRow,
  type ParserReportSource,
} from "@/lib/parserReports"
import { requireSpcPagePermission } from "@/lib/spcAuth"
import {
  createSpcAuditContext,
  createSpcAuditedSupabaseClient,
} from "@/lib/spcAudit"

const MAX_REPORTS = 500
const MAX_TEXT_LENGTH = 20_000
const MAX_NOTE_LENGTH = 2_000

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

function asString(value: unknown, maxLength = MAX_TEXT_LENGTH) {
  return String(typeof value === "string" ? value : "")
    .replace(/\r\n?/g, "\n")
    .trim()
    .slice(0, maxLength)
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
    const { data, error } = await supabase
      .from("parser_reports")
      .select("*")
      .eq("source", source)
      .order("last_reported_at", { ascending: false })
      .limit(MAX_REPORTS)

    if (error) throw error

    const reportsWithState = ((data || []) as ParserReportRow[])
      .map(parserReportFromRow)
      .map(parserReportWithState)
    const unresolvedReports = reportsWithState.filter((report) => report.status === "new" && !report.resolved)
    const counts = parserReportCounts(reportsWithState)

    return NextResponse.json({
      source,
      ...(summaryOnly ? {} : { reports: unresolvedReports }),
      unresolvedReports: counts.unresolved,
      totalReports: counts.total,
      resolvedReports: counts.resolved,
      reviewedReports: counts.reviewed,
      updatedAt: reportsWithState[0]?.updatedAt || null,
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
    const { data, error } = await supabase.rpc("upsert_parser_report", {
      p_fingerprint: fingerprint,
      p_source: source,
      p_context: asString(payload.context, 120),
      p_raw_text: rawText,
      p_cleaned_text: asString(payload.cleanedText),
      p_parser_output: parserOutput,
      p_corrected_output: correctedOutput,
      p_note: asString(payload.note, MAX_NOTE_LENGTH),
      p_page_url: asString(payload.pageUrl, 1_000),
      p_metadata: asParserReportMetadata(payload.metadata),
      p_created_by_username: username,
      p_created_by_display_name: displayName,
      p_app_commit: appCommit(),
      p_reported_at: now,
    })

    if (error) throw error
    const row = Array.isArray(data) ? data[0] as ParserReportRow | undefined : undefined
    if (!row) throw new Error("Parser report was not returned after saving.")

    return NextResponse.json({ success: true, report: parserReportFromRow(row) })
  } catch (error) {
    return errorResponse(error)
  }
}
