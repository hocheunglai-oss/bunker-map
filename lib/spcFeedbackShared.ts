export const SPC_FEEDBACK_CATEGORIES = ["SUGGESTION", "PROBLEM", "NEW FEATURE", "OTHER"] as const
export const SPC_FEEDBACK_STATUSES = ["NEW", "REVIEWING", "PLANNED", "COMPLETED", "CLOSED"] as const

export type SpcFeedbackCategory = (typeof SPC_FEEDBACK_CATEGORIES)[number]
export type SpcFeedbackStatus = (typeof SPC_FEEDBACK_STATUSES)[number]

export type SpcFeedbackRecord = {
  id: string
  category: SpcFeedbackCategory
  title: string
  message: string
  area: string
  status: SpcFeedbackStatus
  adminResponse: string
  createdByUsername: string
  createdByDisplayName: string
  reviewedByDisplayName: string
  createdAt: string
  updatedAt: string
}

export class SpcFeedbackError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message)
    this.name = "SpcFeedbackError"
  }
}

export function isSpcFeedbackId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)
}

// Keep the original Postgres timestamp for the CAS filter. Date alone loses
// microseconds and can make two different database versions look identical.
export function spcFeedbackTimestampMicros(value: unknown): bigint {
  if (typeof value !== "string") throw new SpcFeedbackError("Feedback version is invalid.")
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/.exec(value)
  if (!match) throw new SpcFeedbackError("Feedback version is invalid.")
  const [, year, month, day, hour, minute, second, fraction = "", zone] = match
  const y = Number(year), m = Number(month), d = Number(day)
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (y === 0 || m < 1 || m > 12 || d < 1 || d > days[m - 1] || Number(hour) > 23 ||
      Number(minute) > 59 || Number(second) > 59 ||
      (zone !== "Z" && (Number(zone.slice(1, 3)) > 15 || Number(zone.slice(4)) > 59))) {
    throw new SpcFeedbackError("Feedback version is invalid.")
  }
  const milliseconds = Date.parse(year + "-" + month + "-" + day + "T" + hour + ":" + minute + ":" + second + zone)
  if (!Number.isFinite(milliseconds)) throw new SpcFeedbackError("Feedback version is invalid.")
  return BigInt(milliseconds) * BigInt(1000) + BigInt(fraction.padEnd(6, "0"))
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SpcFeedbackError("Feedback response is invalid.", 503)
  return value as Record<string, unknown>
}

export function parseSpcFeedbackRecord(value: unknown): SpcFeedbackRecord {
  const row = object(value)
  const text = (key: string, maximum?: number, required = false) => {
    const value = row[key]
    if (typeof value !== "string" || value.includes("\u0000") ||
        (maximum !== undefined && (value.length > maximum * 2 || Array.from(value).length > maximum)) || (required && !value.trim())) {
      throw new SpcFeedbackError("Feedback response is invalid.", 503)
    }
    return value
  }
  if (!isSpcFeedbackId(row.id) || !SPC_FEEDBACK_CATEGORIES.includes(row.category as SpcFeedbackCategory) ||
      !SPC_FEEDBACK_STATUSES.includes(row.status as SpcFeedbackStatus)) {
    throw new SpcFeedbackError("Feedback response is invalid.", 503)
  }
  const createdAt = text("createdAt"), updatedAt = text("updatedAt")
  try {
    if (spcFeedbackTimestampMicros(updatedAt) < spcFeedbackTimestampMicros(createdAt)) throw Error("Invalid order")
  } catch { throw new SpcFeedbackError("Feedback response is invalid.", 503) }
  return {
    id: row.id, category: row.category as SpcFeedbackCategory, status: row.status as SpcFeedbackStatus,
    title: text("title", 120, true), message: text("message", 4000, true), area: text("area", 80),
    adminResponse: text("adminResponse", 2000), createdByUsername: text("createdByUsername"),
    createdByDisplayName: text("createdByDisplayName"), reviewedByDisplayName: text("reviewedByDisplayName"),
    createdAt, updatedAt,
  }
}

export function parseSpcFeedbackList(value: unknown): SpcFeedbackRecord[] {
  const rows = object(value).records
  if (!Array.isArray(rows) || rows.length > 250) throw new SpcFeedbackError("Feedback response is invalid.", 503)
  const parsed = rows.map(parseSpcFeedbackRecord)
  if (new Set(parsed.map(row => row.id.toLowerCase())).size !== parsed.length) throw new SpcFeedbackError("Feedback response is invalid.", 503)
  return parsed
}

export function parseSpcFeedbackResponse(value: unknown): SpcFeedbackRecord {
  return parseSpcFeedbackRecord(object(value).record)
}

export function verifySpcFeedbackReview(
  record: SpcFeedbackRecord,
  expected: { id: string; expectedUpdatedAt: string; status: SpcFeedbackStatus; adminResponse: string },
) {
  if (record.id !== expected.id || record.status !== expected.status ||
      record.adminResponse !== expected.adminResponse ||
      spcFeedbackTimestampMicros(record.updatedAt) <= spcFeedbackTimestampMicros(expected.expectedUpdatedAt)) {
    throw new SpcFeedbackError("The saved review could not be verified. Refresh before trying again.", 503)
  }
  return record
}
