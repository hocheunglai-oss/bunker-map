import type { PublicReportPayloadByKey, ReportSnapshotKey } from "@/lib/publicMarketData"
import type { FallbackMap } from "@/lib/reportFallbackKeys"
import { normaliseHistoryTimestamp } from "@/lib/priceHistoryRecords"
import { emptyTaiwanOperationalNotice, normaliseTaiwanOperationalNotice, type TaiwanOperationalNotice } from "@/lib/taiwanOperationalNotice"

export const PUBLIC_REPORT_UNAVAILABLE_MESSAGE = "This report is temporarily unavailable. Please try again later."
const FUELS = ["hsfo", "vlsfo", "mgo"] as const
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
function invalid(): never { throw Error("Public report data is incomplete or invalid") }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid()
  return value as Record<string, unknown>
}
function text(value: unknown, max = 200, allowEmpty = false): asserts value is string {
  if (typeof value !== "string" || value.length > max || !allowEmpty && !value.trim()) invalid()
}
function price(value: unknown, negative = false) {
  if (value !== null && (typeof value !== "number" || !Number.isFinite(value) || !negative && value < 0)) invalid()
}
function date(value: unknown) {
  text(value, 20)
  // Both Sep and Sept occur in older Intl-generated reports. Validate the
  // calendar without changing saved wording or depending on the browser locale.
  const match = value.match(/^(\d{2}) ([A-Za-z]{3}|Sept) (\d{4})$/)
  if (!match) return invalid()
  const month = MONTHS.indexOf(match[2].slice(0, 3).toLowerCase())
  const iso = `${match[3]}-${String(month + 1).padStart(2, "0")}-${match[1]}`
  const parsed = new Date(`${iso}T12:00:00Z`)
  if (month < 0 || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso) invalid()
}
function rows(value: unknown, key: ReportSnapshotKey) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 2000) return invalid()
  const names = new Set<string>()
  for (const item of value) {
    const row = object(item); text(row.port)
    const name = row.port.trim().toLowerCase()
    if (names.has(name)) invalid()
    names.add(name)
    for (const fuel of FUELS) {
      if (key === "china" || key === "compact") price(row[fuel])
      else {
        const values = object(row[fuel])
        for (const field of key === "hongkong" ? ["today", "last1", "last2"] : ["today", "last", "change"]) price(values[field], field === "change")
      }
    }
    if (key === "hongkong") for (const field of ["todayDate", "last1Date", "last2Date"]) {
      if (row[field] === null) continue
      text(row[field], 80)
      normaliseHistoryTimestamp(row[field]) // Includes legacy explicit timezones and microseconds.
    }
  }
  if (key === "hongkong" && (value.length !== 1 || !names.has("hong kong"))) invalid()
  if (key === "taiwan" && (value.length !== 5 || ["kaohsiung", "keelung", "taichung", "suao", "hualien"].some(name => !names.has(name)))) invalid()
}

export function validatePublicReportSnapshot<Key extends ReportSnapshotKey>(value: unknown, key: Key): NonNullable<PublicReportPayloadByKey[Key]["snapshot"]> {
  const snapshot = object(value); date(snapshot.reportDate)
  if (key === "china" || key === "compact") {
    if (!Array.isArray(snapshot.sections) || snapshot.sections.length === 0 || snapshot.sections.length > 200) invalid()
    const titles = new Set<string>(); let rowCount = 0
    for (const item of snapshot.sections) {
      const section = object(item); text(section.title)
      const title = section.title.trim().toLowerCase()
      if (titles.has(title)) invalid()
      titles.add(title); rows(section.rows, key)
      rowCount += (section.rows as unknown[]).length
      if (rowCount > 2000) invalid()
    }
  } else rows(snapshot.rows, key)
  if (key === "taiwan") {
    text(snapshot.remark, 1_048_576, true)
    // Older Taiwan snapshots predate the embedded specialNotice field. The
    // authoritative separately saved notice is supplied by the public reader.
    if (snapshot.specialNotice !== undefined) text(snapshot.specialNotice, 1_048_576, true)
  }
  return value as NonNullable<PublicReportPayloadByKey[Key]["snapshot"]>
}

export function validatePublicFallbacks(value: unknown): FallbackMap {
  const map = object(value)
  if (Object.keys(map).length > 10000) invalid()
  for (const [key, fallback] of Object.entries(map)) {
    if (!/^.{1,200}::(?:hsfo|vlsfo|mgo)$/.test(key) || !["-", "NA", "SE"].includes(fallback as string)) invalid()
  }
  return value as FallbackMap
}

export function validatePublicOperationalNotice(value: unknown): TaiwanOperationalNotice {
  const notice = object(value)
  if (notice.active !== undefined && typeof notice.active !== "boolean") invalid()
  for (const field of ["typhoonName", "expectedReopenDate"]) if (notice[field] !== undefined) text(notice[field], 200, true)
  if (notice.message !== undefined) text(notice.message, 10000, true)
  // Keep the existing legacy message-to-fields compatibility, without coercing
  // malformed active flags (e.g. the string "false") into a price suspension.
  return normaliseTaiwanOperationalNotice(notice)
}

export function parsePublicReportJson(content: string | null | undefined): unknown {
  if (content == null || !content.trim()) return null
  if (content.length > 4_194_304) invalid()
  try { return JSON.parse(content) } catch { return invalid() }
}

export function parsePublicReportPayload<Key extends ReportSnapshotKey>(value: unknown, key: Key): PublicReportPayloadByKey[Key] {
  const data = object(value)
  if (data.key !== key || data.snapshot === undefined || data.unavailable !== undefined && typeof data.unavailable !== "boolean") invalid()
  if (data.snapshot !== null) validatePublicReportSnapshot(data.snapshot, key)
  validatePublicFallbacks(data.fallbacks)
  if (key === "taiwan") {
    text(data.specialNotice, 1_048_576, true)
    return { ...data, operationalNotice: validatePublicOperationalNotice(data.operationalNotice) } as PublicReportPayloadByKey[Key]
  }
  return value as PublicReportPayloadByKey[Key]
}

export function readPublicOperationalNotice(content: string | null | undefined) {
  const value = parsePublicReportJson(content)
  return value === null ? emptyTaiwanOperationalNotice : validatePublicOperationalNotice(value)
}
