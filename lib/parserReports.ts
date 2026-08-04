import {
  buildShortenedEnquiry,
  type VlsfoMaxRemark,
} from "@/lib/enquiryShortener"
import { parseEnquiryWorksheetGuess } from "@/lib/enquiryWorksheetParser"
import { parseSpcEnquiryText } from "@/lib/spcEnquiryText"

export type ParserReportSource = "enquiryworksheet" | "spc"
export type ParserReportStatus = "new" | "reviewed"

export type ParserReportRow = {
  id: string
  fingerprint: string
  source: ParserReportSource
  context: string
  raw_text: string
  cleaned_text: string
  parser_output: string
  corrected_output: string
  note: string
  page_url: string
  metadata: Record<string, unknown> | null
  status: ParserReportStatus
  duplicate_count: number
  created_at: string
  last_reported_at: string
  created_by_username: string
  created_by_display_name: string
  app_commit: string
  updated_at: string
}

export type ParserReportRecord = {
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
  status: ParserReportStatus
  duplicateCount: number
  createdAt: string
  lastReportedAt: string
  createdByUsername: string
  createdByDisplayName: string
  appCommit: string
  updatedAt: string
}

export type ParserReportWithState = ParserReportRecord & {
  currentParserOutput: string
  resolved: boolean
  reviewed: boolean
}

export function asParserReportMetadata(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

export function parserReportFromRow(row: ParserReportRow): ParserReportRecord {
  return {
    id: row.id,
    fingerprint: row.fingerprint,
    source: row.source,
    context: row.context || "",
    rawText: row.raw_text || "",
    cleanedText: row.cleaned_text || "",
    parserOutput: row.parser_output || "",
    correctedOutput: row.corrected_output || "",
    note: row.note || "",
    pageUrl: row.page_url || "",
    metadata: asParserReportMetadata(row.metadata),
    status: row.status === "reviewed" ? "reviewed" : "new",
    duplicateCount: Math.max(Number(row.duplicate_count) || 1, 1),
    createdAt: row.created_at,
    lastReportedAt: row.last_reported_at,
    createdByUsername: row.created_by_username || "",
    createdByDisplayName: row.created_by_display_name || "",
    appCommit: row.app_commit || "",
    updatedAt: row.updated_at,
  }
}

function manualVlsfoMaxRemarksFrom(metadata: Record<string, unknown>): VlsfoMaxRemark[] {
  const value = metadata.manualVlsfoMaxRemarks
  if (!Array.isArray(value)) return []
  return value.filter(
    (item): item is VlsfoMaxRemark =>
      item === "80cst max" || item === "120cst max" || item === "180cst max",
  )
}

export function normalizeParserReportOutput(value: string) {
  return value
    .toLowerCase()
    .replace(/\bhong\s+kong\b/g, "hk")
    .replace(/\bhkg\b/g, "hk")
    .replace(/香港/g, "hk")
    .replace(/\s+/g, " ")
    .trim()
}

export function currentParserOutputFor(report: ParserReportRecord) {
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

export function parserReportWithState(report: ParserReportRecord): ParserReportWithState {
  let currentParserOutput = ""
  try {
    currentParserOutput = currentParserOutputFor(report)
  } catch {
    currentParserOutput = ""
  }

  const pendingReview = report.metadata.pendingReview === true
  const resolved = !pendingReview && Boolean(currentParserOutput.trim()) &&
    normalizeParserReportOutput(currentParserOutput) === normalizeParserReportOutput(report.correctedOutput)

  return {
    ...report,
    currentParserOutput,
    resolved,
    reviewed: report.status === "reviewed" && !resolved,
  }
}

export function parserReportCounts(reports: ParserReportWithState[]) {
  return {
    total: reports.length,
    unresolved: reports.filter((report) => report.status === "new" && !report.resolved).length,
    resolved: reports.filter((report) => report.resolved).length,
    reviewed: reports.filter((report) => report.reviewed).length,
  }
}
