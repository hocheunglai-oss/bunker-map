import "server-only"

import type { SupabaseClient } from "@supabase/supabase-js"
import type { LegacyAttendanceImportResult } from "@/lib/attendanceWorkbook"

type ImportedCounts = {
  entitlementsUpserted: number
  monthlyAdjustmentsUpserted: number
  confirmationsUpserted: number
}

function row(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export async function applyLegacyAttendanceImport(
  client: SupabaseClient,
  parsed: LegacyAttendanceImportResult,
  sourceFileHash: string,
  actor: string,
) {
  if (parsed.workbookType !== "annual") {
    throw new Error(
      "Only the annual legacy attendance workbook can be applied. Daily workbooks are preview-only.",
    )
  }
  if (parsed.dryRun.errorCount > 0) {
    throw new Error("Resolve the workbook import errors before applying it.")
  }
  if (!/^[0-9a-f]{64}$/.test(sourceFileHash)) {
    throw new Error("Attendance workbook hash is invalid.")
  }

  const staffCodes = [
    ...new Set(
      [...parsed.staffOpenings, ...parsed.monthlyAggregates]
        .map((entry) => entry.staffCode.trim().toUpperCase())
        .filter(Boolean),
    ),
  ].sort()
  const { data: people, error: peopleError } = staffCodes.length
    ? await client
        .from("attendance_people")
        .select("id,staff_code")
        .in("staff_code", staffCodes)
    : { data: [], error: null }
  if (peopleError) throw peopleError
  const personByStaffCode = new Map(
    (people || []).map((person) => {
      const value = row(person)
      return [String(value.staff_code), String(value.id)]
    }),
  )
  const unmappedStaffCodes = staffCodes.filter(
    (staffCode) => !personByStaffCode.has(staffCode),
  )
  if (unmappedStaffCodes.length) {
    return {
      applied: false,
      entitlementsUpserted: 0,
      monthlyAdjustmentsUpserted: 0,
      confirmationsUpserted: 0,
      dailyRecordsSkipped: parsed.dailyRecords.length,
      unmappedStaffCodes,
    }
  }

  const payload = {
    openings: parsed.staffOpenings.map((opening) => ({
      person_id: personByStaffCode.get(opening.staffCode.trim().toUpperCase()),
      year: opening.year,
      allowance_units: opening.currentYearAllowance,
      opening_carry_forward_units: opening.carryForward,
      source_key: opening.sourceKey,
    })),
    monthly: parsed.monthlyAggregates.map((aggregate) => ({
      person_id: personByStaffCode.get(aggregate.staffCode.trim().toUpperCase()),
      year: Number(aggregate.statementDate.slice(0, 4)),
      month: Number(aggregate.statementDate.slice(5, 7)),
      source_key: aggregate.sourceKey,
      statement_date: aggregate.statementDate,
      categories: aggregate.categories,
      is_confirmed: aggregate.confirmation === "confirmed",
    })),
  }
  const { data, error } = await client.rpc("apply_attendance_legacy_import", {
    p_payload: payload,
    p_source_file_hash: sourceFileHash,
    p_actor: actor,
  })
  if (error) throw error
  const counts = row(data) as Partial<ImportedCounts>
  return {
    applied: true,
    entitlementsUpserted: Number(counts.entitlementsUpserted || 0),
    monthlyAdjustmentsUpserted: Number(counts.monthlyAdjustmentsUpserted || 0),
    confirmationsUpserted: Number(counts.confirmationsUpserted || 0),
    dailyRecordsSkipped: parsed.dailyRecords.length,
    unmappedStaffCodes: [] as string[],
  }
}
