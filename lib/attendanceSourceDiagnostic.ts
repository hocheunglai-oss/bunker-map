import { validateDingTalkAttendanceQuery, type DingTalkAttendanceRecord } from "./dingTalkAttendance"
import { classifyDingTalkPunches } from "./attendanceSyncRecords"

export function validateAttendanceSourceDiagnostic(params: URLSearchParams) {
  const personId = params.get("personId") || ""
  const date = params.get("date") || ""
  if ([...params.keys()].some((key) => key !== "personId" && key !== "date") ||
      params.getAll("personId").length !== 1 || params.getAll("date").length !== 1 ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(personId) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error("Select one employee and one valid date.")
  }
  // Reuse the provider's calendar validation and maximum history window.
  validateDingTalkAttendanceQuery({ userIds: ["validation-only"],
    checkDateFrom: `${date} 00:00:00`, checkDateTo: `${date} 23:59:59` })
  return { personId: personId.toLowerCase(), date }
}

export function summarizeAttendanceSource(records: DingTalkAttendanceRecord[], personId: string, userId: string, workDate: string) {
  const people = new Map([[userId, { id: personId, dingtalkUserId: userId }]])
  const { mapped, redundantArrivalIndexes } = classifyDingTalkPunches(records, people, {
    from: new Date(`${workDate}T00:00:00+08:00`), to: new Date(`${workDate}T23:59:59+08:00`),
  })
  const text = (value: unknown) => typeof value === "string" ? value.slice(0, 500) : null
  return records.map((record, index) => {
    const normalized = mapped[index]
    const timestamp = Number(record.userCheckTime)
    const date = new Date(timestamp)
    return {
      acceptedByNormalizer: Boolean(normalized),
      redundantArrival: redundantArrivalIndexes.has(index),
      identityMatches: String(record.userId ?? "").trim() === userId,
      hasRecordId: record.id !== null && record.id !== undefined && String(record.id).trim() !== "",
      punchTime: timestamp > 0 && Number.isFinite(date.getTime()) ? date.toISOString() : null,
      checkType: text(record.checkType),
      sourceType: text(record.sourceType),
      timeResult: text(record.timeResult),
      invalidRecordType: text(record.invalidRecordType),
      invalidRecordMsg: text(record.invalidRecordMsg),
    }
  })
}
