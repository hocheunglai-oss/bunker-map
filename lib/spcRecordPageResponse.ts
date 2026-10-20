import type { SpcEnquiryMeta } from "@/lib/spcEnquiryText"
import type { SpcTodayEnquiry } from "@/lib/spcTodayEnquiries"

export const SPC_RECORD_PAGE_SIZE = 250
export const SPC_RECORD_API_MAX_BYTES = 4_000_000
export const SPC_RECORD_READ_TIMEOUT_MS = 30_000
export type SpcRecordPageKind = "lost" | "today"
export type SpcRecordPageCursor = {
  kind: SpcRecordPageKind
  day: string | null
  createdAt: string
  id: string
  revision: string
}
export type SpcLostRecordEnquiry = {
  id: string
  title: string
  vesselName: string | null
  deliveryDate: string | null
  formattedText: string
  createdByDisplayName: string
  createdAt: string
  updatedAt: string
  meta: SpcEnquiryMeta
}
export type SpcRecordPage<K extends SpcRecordPageKind = SpcRecordPageKind> = {
  schema: "spc.record-page/v1"
  kind: K
  day: string | null
  checkedAt: string
  pageSize: number
  totalCount: number
  pageCount: number
  pageIndex: number
  mainRevision: string
  nextCursor: SpcRecordPageCursor | null
  enquiries: Array<K extends "today" ? SpcTodayEnquiry : SpcLostRecordEnquiry>
}
export class SpcRecordPageError extends Error {
  constructor(message: string, public readonly status = 503) {
    super(message)
    this.name = "SpcRecordPageError"
  }
}
function unavailable(): never {
  throw new SpcRecordPageError("The complete record page could not be verified. Your previous data and drafts are kept.")
}
export function spcRecordObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) unavailable()
  return value as Record<string, unknown>
}
function text(value: unknown): value is string { return typeof value === "string" }
function uuid(value: unknown): value is string { return text(value) && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value) }
function digest(value: unknown): value is string { return text(value) && /^[0-9a-f]{64}$/.test(value) }
function count(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 }
export function spcRecordTimestampMicros(value: unknown): bigint {
  if (!text(value)) unavailable()
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/.exec(value)
  if (!match) unavailable()
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3])
  const calendar = new Date(0)
  calendar.setUTCFullYear(year, month, 0)
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > calendar.getUTCDate() || Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59) unavailable()
  const millis = Date.parse(value)
  if (!Number.isFinite(millis)) unavailable()
  return BigInt(millis) * BigInt(1000) + BigInt((match[7] || "").padEnd(6, "0").slice(3))
}
function day(value: unknown): value is string {
  if (!text(value) || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  spcRecordTimestampMicros(value + "T00:00:00Z")
  return true
}
export function getSpcRecordHongKongDay(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Hong_Kong", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date)
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(value => value.type === type)?.value || ""
  return `${part("year")}-${part("month")}-${part("day")}`
}
export function parseSpcRecordCursor(value: unknown, expectedKind: SpcRecordPageKind): SpcRecordPageCursor {
  const cursor = spcRecordObject(value)
  if (Object.keys(cursor).length !== 5 || Object.keys(cursor).some(key => !["kind", "day", "createdAt", "id", "revision"].includes(key)) || cursor.kind !== expectedKind || !uuid(cursor.id) || !digest(cursor.revision) || !text(cursor.createdAt) || (expectedKind === "today" ? !day(cursor.day) : cursor.day !== null)) unavailable()
  spcRecordTimestampMicros(cursor.createdAt)
  return { kind: expectedKind, day: cursor.day as string | null, createdAt: cursor.createdAt, id: cursor.id, revision: cursor.revision }
}
function meta(value: unknown) {
  const result = spcRecordObject(value)
  if (Object.values(result).some(value => !text(value))) unavailable()
}
function row(value: unknown, kind: SpcRecordPageKind) {
  const entry = spcRecordObject(value)
  if (!uuid(entry.id) || !text(entry.formattedText) || !text(entry.createdByDisplayName) || !text(entry.createdAt)) unavailable()
  spcRecordTimestampMicros(entry.createdAt)
  meta(entry.meta)
  if (kind === "lost") {
    if (!text(entry.title) || (entry.vesselName !== null && !text(entry.vesselName)) || (entry.deliveryDate !== null && !day(entry.deliveryDate))) unavailable()
    spcRecordTimestampMicros(entry.updatedAt)
  } else {
    if (!text(entry.enquiryNumber) || !text(entry.vesselName) || !text(entry.status)) unavailable()
    if (entry.previousFixture !== null) {
      const fixture = spcRecordObject(entry.previousFixture)
      if ((fixture.date !== null && !text(fixture.date)) || [fixture.supplier, fixture.price, fixture.barging, fixture.supplierTrader].some(value => !text(value))) unavailable()
    }
    if (entry.previousLost !== null) {
      const lost = spcRecordObject(entry.previousLost)
      if ([lost.date, lost.buyerReason, lost.supplierReason, lost.supplierReasonDetails, lost.spcComments].some(value => !text(value))) unavailable()
    }
  }
  return entry
}
function compare(left: Record<string, unknown>, right: Record<string, unknown>, kind: SpcRecordPageKind) {
  const a = spcRecordTimestampMicros(left.createdAt), b = spcRecordTimestampMicros(right.createdAt)
  return a === b ? (String(left.id) === String(right.id) ? 0 : String(left.id) < String(right.id) ? -1 : 1) : (a < b ? -1 : 1) * (kind === "today" ? 1 : -1)
}
export function parseSpcRecordPage<K extends SpcRecordPageKind>(value: unknown, kind: K, requestedCursor: SpcRecordPageCursor | null = null, pageSize = SPC_RECORD_PAGE_SIZE): SpcRecordPage<K> {
  const page = spcRecordObject(value)
  if (page.schema !== "spc.record-page/v1" || page.kind !== kind || page.pageSize !== pageSize || !count(pageSize) || pageSize < 1 || pageSize > SPC_RECORD_PAGE_SIZE || !count(page.totalCount) || !count(page.pageCount) || !count(page.pageIndex) || !digest(page.mainRevision) || !text(page.checkedAt) || !Array.isArray(page.enquiries)) unavailable()
  spcRecordTimestampMicros(page.checkedAt)
  if (kind === "today" ? !day(page.day) : page.day !== null) unavailable()
  if (kind === "today" && page.day !== getSpcRecordHongKongDay(new Date(page.checkedAt))) unavailable()
  if (page.pageCount !== Math.ceil(page.totalCount / pageSize) || (page.totalCount === 0 ? page.pageIndex !== 0 : page.pageIndex < 1 || page.pageIndex > page.pageCount)) unavailable()
  if (!requestedCursor && page.pageIndex !== (page.totalCount === 0 ? 0 : 1)) unavailable()
  if (requestedCursor && (requestedCursor.kind !== kind || requestedCursor.day !== page.day || requestedCursor.revision !== page.mainRevision || page.pageIndex < 2)) unavailable()
  const remaining = page.totalCount - Math.max(0, page.pageIndex - 1) * pageSize
  if (page.enquiries.length !== Math.min(pageSize, remaining)) unavailable()
  const rows = page.enquiries.map(value => row(value, kind)), ids = new Set<string>()
  for (let index = 0; index < rows.length; index++) {
    const current = rows[index]
    if (ids.has(String(current.id)) || (index > 0 && compare(rows[index - 1], current, kind) >= 0)) unavailable()
    ids.add(String(current.id))
  }
  if (requestedCursor && rows.length && compare(requestedCursor, rows[0], kind) >= 0) unavailable()
  const hasMore = page.pageIndex * pageSize < page.totalCount
  if (hasMore) {
    const cursor = parseSpcRecordCursor(page.nextCursor, kind), last = rows.at(-1)
    if (!last || cursor.day !== page.day || cursor.revision !== page.mainRevision || cursor.id !== last.id || spcRecordTimestampMicros(cursor.createdAt) !== spcRecordTimestampMicros(last.createdAt)) unavailable()
  } else if (page.nextCursor !== null) unavailable()
  return page as unknown as SpcRecordPage<K>
}

// The deadline covers fetch AND body reading even when a mocked/old transport
// ignores AbortSignal. Already-dispatched server reads are not claimed cancelled.
export async function fetchSpcRecordPage<K extends SpcRecordPageKind>(kind: K, cursor: SpcRecordPageCursor | null = null, signal?: AbortSignal, pageSize = SPC_RECORD_PAGE_SIZE): Promise<SpcRecordPage<K>> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let rejectAbort: ((reason: Error) => void) | undefined
  const abort = () => { controller.abort(); rejectAbort?.(new DOMException("The record request was cancelled.", "AbortError")) }
  signal?.addEventListener("abort", abort, { once: true })
  if (signal?.aborted) controller.abort()
  const read = async () => {
    if (controller.signal.aborted) throw new DOMException("The record request was cancelled.", "AbortError")
    const params = new URLSearchParams({ pageSize: String(pageSize) })
    if (cursor) params.set("cursor", JSON.stringify(parseSpcRecordCursor(cursor, kind)))
    const response = await fetch(`/api/spc/${kind === "lost" ? "lost-record" : "today-enquiries"}?${params}`, { cache: "no-store", signal: controller.signal })
    if (response.status === 401 || response.status === 403) throw new SpcRecordPageError("Your access could not be verified. Sign in again before loading records.", response.status)
    if (response.status === 409) throw new SpcRecordPageError("The record list changed. Refresh after saving or discarding your drafts.", 409)
    if (!response.ok) throw new SpcRecordPageError("The complete record page is unavailable. Your previous data and drafts are kept.", response.status)
    const body = await response.text()
    if (controller.signal.aborted) throw new DOMException("The record request was cancelled.", "AbortError")
    if (new TextEncoder().encode(body).byteLength > SPC_RECORD_API_MAX_BYTES) unavailable()
    let parsed: unknown
    try { parsed = JSON.parse(body) } catch { unavailable() }
    return parseSpcRecordPage(parsed, kind, cursor, pageSize)
  }
  try {
    return await Promise.race([read(), new Promise<never>((_, reject) => { rejectAbort = reject }), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new SpcRecordPageError("Loading records timed out. Your previous data and drafts are kept.")) }, SPC_RECORD_READ_TIMEOUT_MS)
    })])
  } finally {
    if (timer) clearTimeout(timer)
    signal?.removeEventListener("abort", abort)
  }
}
