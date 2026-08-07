import { createHash } from "node:crypto"
import { NextResponse } from "next/server"
import { requireAdminPagePermissionForRequest } from "@/lib/adminAuth"
import { createAdminAuditContext, createAdminAuditedSupabaseClient } from "@/lib/adminAudit"
import { applyLegacyAttendanceImport } from "@/lib/attendanceImport"
import { ATTENDANCE_PAGE_ID } from "@/lib/attendanceRules"
import { parseLegacyAttendanceWorkbook } from "@/lib/attendanceWorkbookImport"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 60

const MAX_WORKBOOK_BYTES = 10 * 1024 * 1024
const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
}

function privateJson(body: unknown, init: ResponseInit = {}) {
  return NextResponse.json(body, {
    ...init,
    headers: { ...PRIVATE_HEADERS, ...init.headers },
  })
}

function statusForError(error: unknown) {
  if (!(error instanceof Error)) return 500
  if (error.message === "Unauthorized") return 401
  if (error.message === "Forbidden") return 403
  if (
    error.message.includes("workbook") ||
    error.message.includes("file") ||
    error.message.includes("Only the annual") ||
    error.message.includes("Resolve the")
  ) {
    return 400
  }
  return 500
}

export async function POST(request: Request) {
  try {
    const session = await requireAdminPagePermissionForRequest(
      request,
      ATTENDANCE_PAGE_ID,
      "edit",
    )
    const form = await request.formData()
    const file = form.get("file")
    const mode = form.get("mode") === "apply" ? "apply" : "dry-run"
    if (!(file instanceof File)) throw new Error("Attendance workbook file is required.")
    if (file.size <= 0 || file.size > MAX_WORKBOOK_BYTES) {
      throw new Error("Attendance workbook file must be between 1 byte and 10 MB.")
    }
    const fileName = file.name.trim().slice(0, 255)
    if (!/\.xlsx?$/i.test(fileName)) {
      throw new Error("Attendance workbook file must use .xls or .xlsx.")
    }
    const bytes = new Uint8Array(await file.arrayBuffer())
    const sourceFileHash = createHash("sha256").update(bytes).digest("hex")
    const parsed = parseLegacyAttendanceWorkbook(bytes, { fileName })

    let apply = null
    if (mode === "apply") {
      const actor = session.username || session.displayName
      if (!actor) throw new Error("Unauthorized")
      const context = createAdminAuditContext(session, request, ATTENDANCE_PAGE_ID)
      const client = createAdminAuditedSupabaseClient(context, {
        useServiceRole: true,
      })
      apply = await applyLegacyAttendanceImport(
        client,
        parsed,
        sourceFileHash,
        actor,
      )
    }

    return privateJson({
      success: true,
      mode,
      sourceFileHash,
      workbookType: parsed.workbookType,
      source: parsed.source,
      dryRun: parsed.dryRun,
      issues: parsed.issues,
      staffOpenings: parsed.staffOpenings,
      monthlyAggregates: parsed.monthlyAggregates,
      dailyRecords: parsed.dailyRecords,
      apply,
    })
  } catch (error) {
    const status = statusForError(error)
    if (status >= 500) console.error("Attendance workbook import failed", error)
    return privateJson(
      {
        message:
          status < 500 && error instanceof Error
            ? error.message
            : "Could not import the attendance workbook.",
      },
      { status },
    )
  }
}
