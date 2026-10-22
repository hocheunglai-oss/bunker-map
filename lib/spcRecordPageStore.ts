import type { SpcSession } from "@/lib/spcAuth"
import { createSpcAuditContext, createSpcAuditedSupabaseClient } from "@/lib/spcAudit"
import { formatSpcEnquiry, readSpcEnquiryMeta } from "@/lib/spcEnquiryText"
import { mapSpcTodayEnquiries, type SpcRecordEnquiryRow, type SpcRecordFixtureRow, type SpcRecordLostHistoryRow } from "@/lib/spcTodayEnquiries"
import { parseSpcRecordCursor, parseSpcRecordPage, spcRecordObject, spcRecordTimestampMicros, SpcRecordPageError, SPC_RECORD_API_MAX_BYTES, SPC_RECORD_PAGE_SIZE, SPC_RECORD_READ_TIMEOUT_MS, type SpcRecordPageKind, type SpcRecordPageCursor } from "@/lib/spcRecordPageResponse"

const SOURCE_MAX_BYTES = 33_554_432
const SINGLE_MAX_BYTES = 1_048_576
const unavailable = () => new SpcRecordPageError("The complete record page is unavailable. Your previous data and drafts are kept.")
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8")
const isUuid = (value: unknown) => typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value)

function rawRow(value: unknown, required: string[], nullable: string[], timestamps: string[]) {
  const row = spcRecordObject(value)
  if (!isUuid(row.id) || required.some(key => typeof row[key] !== "string") || nullable.some(key => row[key] !== null && typeof row[key] !== "string") || bytes(row) > SINGLE_MAX_BYTES) throw unavailable()
  for (const key of timestamps) spcRecordTimestampMicros(row[key])
  return row
}

export function parseSpcRecordPageRequest(request: Request, kind: SpcRecordPageKind) {
  const params = new URL(request.url).searchParams
  const size = params.get("pageSize")
  if (params.getAll("pageSize").length > 1 || params.getAll("cursor").length > 1 || (size !== null && !/^[1-9]\d{0,2}$/.test(size))) throw new SpcRecordPageError("Invalid record page request.", 400)
  const pageSize = size === null ? SPC_RECORD_PAGE_SIZE : Number(size)
  if (pageSize > SPC_RECORD_PAGE_SIZE) throw new SpcRecordPageError("Invalid record page size.", 400)
  let cursor: SpcRecordPageCursor | null = null
  const raw = params.get("cursor")
  if (raw !== null) {
    try {
      if (raw.length > 2048) throw unavailable()
      cursor = parseSpcRecordCursor(JSON.parse(raw), kind)
    } catch { throw new SpcRecordPageError("Invalid record page cursor. Refresh before browsing another page.", 400) }
  }
  return { cursor, pageSize }
}

export function mapSpcRecordPageSource(value: unknown, kind: SpcRecordPageKind, cursor: SpcRecordPageCursor | null, pageSize: number) {
  const source = spcRecordObject(value), counts = spcRecordObject(source.sourceCounts)
  if (source.schema !== "spc.record-page-source/v1" || !Array.isArray(source.rows) || !Array.isArray(source.fixtures) || !Array.isArray(source.lost) || bytes(source) > SOURCE_MAX_BYTES) throw unavailable()
  for (const key of ["rows", "fixtures", "lost"] as const) {
    const entries = source[key] as unknown[]
    if (!Number.isSafeInteger(counts[key]) || counts[key] !== entries.length) throw unavailable()
    const ids = new Set<unknown>()
    for (const entry of entries) {
      const raw = spcRecordObject(entry)
      if (!isUuid(raw.id) || ids.has(raw.id)) throw unavailable()
      ids.add(raw.id)
    }
  }
  const rows = source.rows.map(value => rawRow(value, ["enquiry_number", "title", "status", "created_by_username", "created_by_display_name"], ["vessel_name", "port", "product", "quantity", "delivery_date", "supplier_name", "notes"], ["created_at", "updated_at"])) as SpcRecordEnquiryRow[]
  const fixtures = source.fixtures.map(value => {
    const row = rawRow(value, ["supplier_trader_display_name", "buyer_trader_display_name"], ["fixture_date", "vessel_name", "vessel_imo", "supplier_name", "price", "barging", "completed_at"], ["created_at"])
    if (row.completed_at !== null) spcRecordTimestampMicros(row.completed_at)
    const parent = spcRecordObject(row.enquiry)
    if (parent.vessel_name !== null && typeof parent.vessel_name !== "string") throw unavailable()
    return row
  }) as SpcRecordFixtureRow[]
  const lost = source.lost.map(value => rawRow(value, [], ["vessel_name", "notes"], ["created_at", "updated_at"])) as SpcRecordLostHistoryRow[]
  if (kind === "lost" && (fixtures.length || lost.length || rows.some(row => row.status !== "cancelled"))) throw unavailable()
  const enquiries = kind === "today" ? mapSpcTodayEnquiries(rows, fixtures, lost) : rows.map(row => ({
    id: row.id, title: row.title, vesselName: row.vessel_name, deliveryDate: row.delivery_date,
    formattedText: formatSpcEnquiry({ ...row, vesselName: row.vessel_name, deliveryDate: row.delivery_date }), createdByDisplayName: row.created_by_display_name || row.created_by_username,
    createdAt: row.created_at, updatedAt: row.updated_at, meta: readSpcEnquiryMeta(row.notes),
  }))
  const page = parseSpcRecordPage({
    schema: "spc.record-page/v1", kind: source.kind, day: source.day, checkedAt: source.checkedAt,
    pageSize: source.pageSize, totalCount: source.totalCount, pageCount: source.pageCount, pageIndex: source.pageIndex,
    mainRevision: source.mainRevision, nextCursor: source.nextCursor, enquiries,
  }, kind, cursor, pageSize)
  if (kind === "today") {
    const start = spcRecordTimestampMicros(`${page.day}T00:00:00+08:00`)
    const end = start + BigInt(86_400_000_000)
    if (rows.some(row => { const at = spcRecordTimestampMicros(row.created_at); return at < start || at >= end })) throw unavailable()
  }
  if (bytes(page) > SPC_RECORD_API_MAX_BYTES) throw unavailable()
  return page
}

export async function readSpcRecordPage(session: SpcSession, request: Request, kind: SpcRecordPageKind) {
  const { cursor, pageSize } = parseSpcRecordPageRequest(request, kind)
  const controller = new AbortController()
  const abort = () => controller.abort()
  request.signal.addEventListener("abort", abort, { once: true })
  if (request.signal.aborted) controller.abort()
  let timer: ReturnType<typeof setTimeout> | undefined
  let rejectAbort: ((error: Error) => void) | undefined
  const interrupted = () => rejectAbort?.(unavailable())
  controller.signal.addEventListener("abort", interrupted, { once: true })
  try {
    const context = createSpcAuditContext(session, request, kind === "lost" ? "spc-lost-record" : "spc-today-enquiries", {
      action: kind === "lost" ? "list-lost-record-page" : "list-today-enquiry-page", targetType: "spc-enquiry", targetId: cursor?.day || "",
    })
    const read = async () => {
      if (controller.signal.aborted) throw unavailable()
      const result = await createSpcAuditedSupabaseClient(context)
        .rpc(kind === "lost" ? "read_spc_lost_record_page" : "read_spc_today_enquiry_page", { p_cursor: cursor, p_page_size: pageSize })
        .abortSignal(controller.signal)
      if (controller.signal.aborted) throw unavailable()
      if (result.error) {
        if (
          (result.error.code === "P0001" && result.error.message === "SPC_RECORD_PAGE_REFRESH_REQUIRED") ||
          (result.error.code === "40001" && (
            result.error.message === "The record list changed. Refresh before browsing another page." ||
            result.error.message === "The complete record page could not be verified."
          ))
        ) throw new SpcRecordPageError("The record list changed. Refresh after saving or discarding your drafts.", 409)
        if (result.error.code === "22023") throw new SpcRecordPageError("Invalid record page cursor. Refresh before browsing another page.", 400)
        throw unavailable()
      }
      return mapSpcRecordPageSource(result.data, kind, cursor, pageSize)
    }
    return await Promise.race([read(), new Promise<never>((_, reject) => { rejectAbort = reject }), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { reject(unavailable()); controller.abort() }, SPC_RECORD_READ_TIMEOUT_MS)
    })])
  } finally {
    if (timer) clearTimeout(timer)
    request.signal.removeEventListener("abort", abort)
    controller.signal.removeEventListener("abort", interrupted)
  }
}

export function spcRecordPageFailure(error: unknown) {
  const message = error instanceof Error ? error.message : "The complete record page is unavailable."
  const status = message === "Unauthorized" ? 401 : message === "Forbidden" ? 403 : error instanceof SpcRecordPageError ? error.status : 503
  return { message: status >= 500 ? unavailable().message : message, status, code: status === 409 ? "REFRESH_REQUIRED" : status >= 500 ? "COMPLETE_READ_UNAVAILABLE" : undefined }
}
