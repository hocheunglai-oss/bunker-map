import { NextResponse } from "next/server"
import {
  requireAdminSessionForRequest,
} from "@/lib/adminAuth"
import { isAdminRole } from "@/lib/adminPages"
import { getAttendanceServiceClient } from "@/lib/attendanceData"
import { summarizeAttendanceSource, validateAttendanceSourceDiagnostic } from "@/lib/attendanceSourceDiagnostic"
import {
  DingTalkAttendanceConfigurationError,
  DingTalkAttendanceUpstreamError,
  DingTalkAttendanceValidationError,
  getDingTalkAttendanceClient,
} from "@/lib/dingTalkAttendance"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
}

function privateJson(body: unknown, init: ResponseInit = {}) {
  return NextResponse.json(body, {
    ...init,
    headers: {
      ...PRIVATE_HEADERS,
      ...init.headers,
    },
  })
}

function errorStatus(error: unknown) {
  if (!(error instanceof Error)) return 500
  if (error.message === "Unauthorized") return 401
  if (error.message === "Forbidden") return 403
  if (error instanceof DingTalkAttendanceValidationError) return 400
  if (error instanceof DingTalkAttendanceConfigurationError) return 503
  if (error instanceof DingTalkAttendanceUpstreamError) return 502
  return 500
}

function publicErrorMessage(error: unknown) {
  if (!(error instanceof Error)) return "Could not load DingTalk attendance records."
  if (error.message === "Unauthorized" || error.message === "Forbidden") return error.message
  if (error instanceof DingTalkAttendanceValidationError) return error.message
  if (error instanceof DingTalkAttendanceConfigurationError) {
    return "DingTalk attendance is not configured in Vercel."
  }
  if (error instanceof DingTalkAttendanceUpstreamError) {
    return error.upstreamCode
      ? `${error.message} DingTalk code: ${error.upstreamCode}.`
      : error.message
  }
  return "Could not load DingTalk attendance records."
}

// Read-only, single-person/day support view. No raw payload, device identifier,
// provider identity or credentials are returned. POST retains its existing API.
export async function GET(request: Request) {
  try {
    const session = await requireAdminSessionForRequest(request)
    if (!isAdminRole(session.role)) throw new Error("Forbidden")
    let input: { personId: string; date: string }
    try {
      input = validateAttendanceSourceDiagnostic(new URL(request.url).searchParams)
    } catch {
      return privateJson({ message: "Select one employee and one valid date within the last 180 days." }, { status: 400 })
    }
    const { data: person, error } = await getAttendanceServiceClient()
      .from("attendance_people").select("id,staff_code,dingtalk_user_id")
      .eq("id", input.personId).maybeSingle()
    if (error) throw new Error("Attendance employee lookup failed.")
    if (!person?.dingtalk_user_id) {
      return privateJson({ message: "Employee has no linked DingTalk account." }, { status: 404 })
    }
    const { records } = await getDingTalkAttendanceClient().listRecords({
      userIds: [person.dingtalk_user_id],
      checkDateFrom: `${input.date} 00:00:00`,
      checkDateTo: `${input.date} 23:59:59`,
      isI18n: false,
    })
    return privateJson({ staffCode: person.staff_code, date: input.date,
      fetchedAt: new Date().toISOString(),
      records: summarizeAttendanceSource(records, input.personId, person.dingtalk_user_id) })
  } catch (error) {
    return privateJson({ message: publicErrorMessage(error) }, { status: errorStatus(error) })
  }
}

export async function POST(request: Request) {
  try {
    const session = await requireAdminSessionForRequest(request)
    if (!isAdminRole(session.role)) throw new Error("Forbidden")

    let input: unknown
    try {
      input = await request.json()
    } catch {
      throw new DingTalkAttendanceValidationError("A valid JSON request body is required.")
    }

    const { query, records } = await getDingTalkAttendanceClient().listRecords(input)
    return privateJson({
      source: "DingTalk attendance/listRecord",
      fetchedAt: new Date().toISOString(),
      query,
      count: records.length,
      records,
    })
  } catch (error) {
    const status = errorStatus(error)
    if (status >= 500) {
      console.error("DingTalk attendance request failed", {
        name: error instanceof Error ? error.name : "UnknownError",
        status,
        upstreamCode:
          error instanceof DingTalkAttendanceUpstreamError
            ? error.upstreamCode
            : null,
      })
    }
    return privateJson({ message: publicErrorMessage(error) }, { status })
  }
}
