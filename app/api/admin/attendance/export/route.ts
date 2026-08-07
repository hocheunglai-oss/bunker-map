import { requireAdminPagePermissionForRequest } from "@/lib/adminAuth"
import { getAttendanceServiceClient } from "@/lib/attendanceData"
import { ATTENDANCE_PAGE_ID, hktDateFromTimestamp } from "@/lib/attendanceRules"
import {
  emptyAttendanceCategoryTotals,
  type AttendanceCategoryTotals,
  type AttendanceLegacyCategoryCode,
  type LegacyAttendanceMonthlyAggregate,
  type LegacyAttendanceStaffOpening,
} from "@/lib/attendanceWorkbook"
import { createAttendanceMonthlyWorkbook } from "@/lib/attendanceWorkbookExport"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 60

type Row = Record<string, unknown>

function asRow(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Row)
    : {}
}

function yearFromRequest(request: Request) {
  const value = new URL(request.url).searchParams.get("year")
  const year = value ? Number(value) : Number(hktDateFromTimestamp(new Date()).slice(0, 4))
  if (!Number.isInteger(year) || year < 2000 || year > 2200) {
    throw new Error("Year must be between 2000 and 2200.")
  }
  return year
}

function monthEnd(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10)
}

export async function GET(request: Request) {
  try {
    await requireAdminPagePermissionForRequest(
      request,
      ATTENDANCE_PAGE_ID,
      "view",
    )
    const year = yearFromRequest(request)
    const today = hktDateFromTimestamp(new Date())
    const periodEnd = Number(today.slice(0, 4)) === year ? today : `${year}-12-31`
    const supabase = getAttendanceServiceClient()
    const [peopleResult, entitlementResult, adjustmentResult, leaveResult, confirmationResult] =
      await Promise.all([
        supabase.from("attendance_people").select("id,staff_code").order("staff_code"),
        supabase.from("attendance_entitlements").select("*").eq("year", year),
        supabase.from("attendance_monthly_adjustments").select("*").eq("year", year),
        supabase
          .from("attendance_leave_entries")
          .select("person_id,leave_date,code,units")
          .gte("leave_date", `${year}-01-01`)
          .lte("leave_date", `${year}-12-31`),
        supabase.from("attendance_monthly_confirmations").select("*").eq("year", year),
      ])
    for (const result of [
      peopleResult,
      entitlementResult,
      adjustmentResult,
      leaveResult,
      confirmationResult,
    ]) {
      if (result.error) throw result.error
    }

    const staffByPersonId = new Map(
      (peopleResult.data || []).map((value) => {
        const row = asRow(value)
        return [String(row.id), String(row.staff_code)]
      }),
    )
    const entitlementByPersonId = new Map(
      (entitlementResult.data || []).map((value) => {
        const row = asRow(value)
        return [String(row.person_id), row]
      }),
    )
    const staffOpenings: LegacyAttendanceStaffOpening[] = [...staffByPersonId].map(
      ([personId, staffCode], index) => {
        const entitlement = entitlementByPersonId.get(personId)
        return {
          sourceKey: `platform-opening:${year}:${encodeURIComponent(staffCode)}`,
          year,
          staffCode,
          currentYearAllowance: Number(entitlement?.allowance_units || 0),
          carryForward: Number(entitlement?.opening_carry_forward_units || 0),
          legacyBalance: null,
          categories: emptyAttendanceCategoryTotals(),
          sourceSheet: "ATTENDANCE RECORD",
          sourceRow: index + 2,
        }
      },
    )

    const categoryTotalsByPersonMonth = new Map<string, AttendanceCategoryTotals>()
    const ensureTotals = (personId: string, month: number) => {
      const key = `${personId}:${month}`
      let totals = categoryTotalsByPersonMonth.get(key)
      if (!totals) {
        totals = emptyAttendanceCategoryTotals()
        categoryTotalsByPersonMonth.set(key, totals)
      }
      return totals
    }
    for (const value of adjustmentResult.data || []) {
      const row = asRow(value)
      const personId = String(row.person_id)
      const month = Number(row.month)
      const code = String(row.code) as AttendanceLegacyCategoryCode
      const totals = ensureTotals(personId, month)
      if (code in totals) totals[code] += Number(row.units || 0)
    }
    for (const value of leaveResult.data || []) {
      const row = asRow(value)
      const personId = String(row.person_id)
      const leaveDate = String(row.leave_date)
      const month = Number(leaveDate.slice(5, 7))
      const code = String(row.code) as AttendanceLegacyCategoryCode
      const totals = ensureTotals(personId, month)
      if (code in totals) totals[code] += Number(row.units || 0)
    }

    const confirmationByPersonMonth = new Map(
      (confirmationResult.data || []).map((value) => {
        const row = asRow(value)
        return [`${row.person_id}:${row.month}`, String(row.status)]
      }),
    )
    const aggregateKeys = new Set([
      ...categoryTotalsByPersonMonth.keys(),
      ...confirmationByPersonMonth.keys(),
    ])
    const monthlyAggregates: LegacyAttendanceMonthlyAggregate[] = [...aggregateKeys]
      .flatMap((key) => {
        const separator = key.lastIndexOf(":")
        const personId = key.slice(0, separator)
        const month = Number(key.slice(separator + 1))
        const staffCode = staffByPersonId.get(personId)
        if (!staffCode || !Number.isInteger(month) || month < 1 || month > 12) return []
        return [
          {
            sourceKey: `platform-monthly:${year}-${String(month).padStart(2, "0")}:${encodeURIComponent(staffCode)}`,
            statementDate: monthEnd(year, month),
            staffCode,
            categories:
              categoryTotalsByPersonMonth.get(key) || emptyAttendanceCategoryTotals(),
            confirmation:
              confirmationByPersonMonth.get(key) === "confirmed"
                ? ("confirmed" as const)
                : ("unconfirmed" as const),
            confirmationRaw: confirmationByPersonMonth.get(key) || null,
            sourceSheet: "ATTENDANCE RECORD",
            sourceRow: 0,
          },
        ]
      })
      .sort(
        (left, right) =>
          left.statementDate.localeCompare(right.statementDate) ||
          left.staffCode.localeCompare(right.staffCode),
      )

    const workbook = createAttendanceMonthlyWorkbook({
      periodEnd,
      staffOpenings,
      monthlyAggregates,
    })
    return new Response(new Uint8Array(workbook), {
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="Attendance-Record-${year}.xlsx"`,
        "Cache-Control": "private, no-store, max-age=0",
        Pragma: "no-cache",
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not export attendance."
    const status =
      message === "Unauthorized"
        ? 401
        : message === "Forbidden"
          ? 403
          : message.startsWith("Year must")
            ? 400
            : 500
    if (status >= 500) console.error("Attendance workbook export failed", error)
    return Response.json(
      { message: status < 500 ? message : "Could not export attendance." },
      {
        status,
        headers: {
          "Cache-Control": "private, no-store, max-age=0",
          Pragma: "no-cache",
        },
      },
    )
  }
}
