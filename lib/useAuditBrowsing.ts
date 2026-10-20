"use client"

import { useCallback, useEffect, useRef, useState } from "react"

export type AuditOperation = "INSERT" | "UPDATE" | "DELETE"
export type AuditLogRecord = {
  id: string
  occurredAt: string
  actorUserId?: string | null
  actorId: string | null
  actorName: string | null
  operation?: AuditOperation
  displayOperation: AuditOperation
  pageId: string
  pageLabel: string
  recordLabel: string
  summary: string
  details: string[]
  detailsLoaded: boolean
  undoable: boolean
  undoOfLogId: string | null
  undoneAt: string | null
}
type PageInfo = {
  pageSize: number
  returnedMatches: number
  state: "more" | "scan-pending" | "exhausted"
  hasMoreMatches: boolean | null
  nextCursor: string | null
  consistency: "live-keyset"
}
type AuditPage = {
  logs: AuditLogRecord[]
  pages: Array<{ id: string; label: string }>
  users: Array<{ value: string; label: string }>
  pageInfo: PageInfo
}
type View = Omit<AuditPage, "pageInfo"> & {
  scope: string | null
  pageInfo: PageInfo | null
  selectedId: string | null
  loading: boolean
  detailLoadingId: string | null
  message: string
  detailFailed: boolean
  listFailed: boolean
  cursors: Array<string | null>
  index: number
  historyTruncated: boolean
}
type ReadTarget = { cursor: string | null; cursors: Array<string | null>; index: number; historyTruncated: boolean }
type Token = { scope: string | null; ownershipRevision: number }
const EMPTY: View = {
  scope: null, logs: [], pages: [], users: [], pageInfo: null, selectedId: null,
  loading: false, detailLoadingId: null, message: "", detailFailed: false, listFailed: false,
  cursors: [null], index: 0, historyTruncated: false,
}
const REQUEST_TIMEOUT_MS = 30_000
const HISTORY_LIMIT = 20

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}
function text(value: unknown): value is string { return typeof value === "string" }
function nullableText(value: unknown): value is string | null { return value === null || text(value) }
function operation(value: unknown): value is AuditOperation { return value === "INSERT" || value === "UPDATE" || value === "DELETE" }
function validLog(value: unknown): value is AuditLogRecord {
  return object(value) && text(value.id) && value.id.length > 0 && text(value.occurredAt)
    && Number.isFinite(Date.parse(value.occurredAt)) && nullableText(value.actorId)
    && nullableText(value.actorName) && (value.actorUserId === undefined || nullableText(value.actorUserId))
    && (value.operation === undefined || operation(value.operation)) && operation(value.displayOperation)
    && text(value.pageId) && text(value.pageLabel) && text(value.recordLabel) && text(value.summary)
    && Array.isArray(value.details) && value.details.every(text)
    && typeof value.detailsLoaded === "boolean" && typeof value.undoable === "boolean"
    && nullableText(value.undoOfLogId) && nullableText(value.undoneAt)
}
function options(value: unknown, key: "id" | "value") {
  return Array.isArray(value) && value.every((item) => object(item) && text(item[key]) && item[key].length > 0 && text(item.label))
    && new Set(value.map((item) => item[key])).size === value.length
}
export function parseAuditBrowsingPage(value: unknown): AuditPage {
  if (!object(value) || !Array.isArray(value.logs) || value.logs.length > 150 || !value.logs.every(validLog)
    || new Set(value.logs.map((log) => log.id)).size !== value.logs.length
    || !options(value.pages, "id") || !options(value.users, "value") || value.totalMatches !== null
    || !object(value.pageInfo)) throw new Error("The audit records could not be verified. Please retry.")
  const info = value.pageInfo
  if (!Number.isInteger(info.pageSize) || Number(info.pageSize) < 1 || Number(info.pageSize) > 150
    || info.returnedMatches !== value.logs.length || value.logs.length > Number(info.pageSize)
    || info.consistency !== "live-keyset"
    || !(info.state === "exhausted" && info.hasMoreMatches === false && info.nextCursor === null
      || (info.state === "more" && info.hasMoreMatches === true && value.logs.length > 0
        || info.state === "scan-pending" && info.hasMoreMatches === null)
        && text(info.nextCursor) && info.nextCursor.length > 0 && info.nextCursor.length <= 16_384)) {
    throw new Error("The audit records could not be verified. Please retry.")
  }
  return value as unknown as AuditPage
}

class AuditReadError extends Error {
  constructor(message: string, readonly status = 0) { super(message) }
}
async function readJson(url: string, controller: AbortController): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError")
  try {
    return await Promise.race([
      (async () => {
        const response = await fetch(url, { cache: "no-store", signal: controller.signal })
        if (response.status === 401 || response.status === 403) {
          throw new AuditReadError("Access to these audit records is no longer available. Refresh after signing in.", response.status)
        }
        const data: unknown = await response.json()
        if (!response.ok) throw new AuditReadError(object(data) && text(data.message) ? data.message : "Failed to load audit records. Please retry.")
        return data
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new AuditReadError("Loading audit records took too long. Please retry."))
          controller.abort()
        }, REQUEST_TIMEOUT_MS)
      }),
      new Promise<never>((_, reject) => {
        onAbort = () => reject(new DOMException("Aborted", "AbortError"))
        controller.signal.addEventListener("abort", onAbort, { once: true })
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
    if (onAbort) controller.signal.removeEventListener("abort", onAbort)
  }
}

export function useAuditBrowsing({ endpoint, owner, enabled, page, actor, operation: filterOperation = "all" }: {
  endpoint: string; owner: string; enabled: boolean; page: string; actor: string; operation?: string
}) {
  const scope = enabled ? JSON.stringify([endpoint, owner, page, actor, filterOperation]) : null
  const liveScope = useRef(scope)
  const ownership = useRef({ scope, revision: 0 })
  if (ownership.current.scope !== scope) ownership.current = { scope, revision: ownership.current.revision + 1 }
  liveScope.current = scope
  const generation = useRef(0)
  const listController = useRef<AbortController | null>(null)
  const detailController = useRef<AbortController | null>(null)
  const pendingTarget = useRef<ReadTarget | null>(null)
  const [stored, setStored] = useState<View>(EMPTY)
  const [detailRetry, setDetailRetry] = useState(0)
  // Never render a prior owner's or prior filter's rows while an effect catches up.
  const view = stored.scope === scope && scope !== null ? stored : EMPTY
  const selectedLog = view.logs.find((log) => log.id === view.selectedId) || view.logs[0] || null
  const selectedId = selectedLog?.id ?? null
  const detailsLoaded = selectedLog?.detailsLoaded ?? false

  const readPage = useCallback(async (target: ReadTarget, reset = false) => {
    if (scope === null || liveScope.current !== scope) return
    const sequence = ++generation.current
    listController.current?.abort()
    detailController.current?.abort()
    const controller = new AbortController()
    listController.current = controller
    pendingTarget.current = target
    setStored((current) => ({ ...(reset || current.scope !== scope ? EMPTY : current), scope, loading: true, detailLoadingId: null, message: "", detailFailed: false, listFailed: false }))
    const params = new URLSearchParams({ limit: "150" })
    if (page !== "all") params.set("page", page)
    if (actor !== "all") params.set("actor", actor)
    if (filterOperation !== "all") params.set("operation", filterOperation)
    if (target.cursor) params.set("cursor", target.cursor)
    const current = () => liveScope.current === scope && generation.current === sequence && !controller.signal.aborted
    try {
      const data = parseAuditBrowsingPage(await readJson(`${endpoint}?${params}`, controller))
      if (target.cursor !== null && data.pageInfo.nextCursor === target.cursor) throw new Error("The next audit page could not be verified. Please refresh.")
      if (!current()) return
      setStored((previous) => ({
        ...previous, ...data, scope, ...target, loading: false, detailLoadingId: null, message: "", detailFailed: false, listFailed: false,
        selectedId: data.logs.some((log) => log.id === previous.selectedId) ? previous.selectedId : data.logs[0]?.id ?? null,
      }))
    } catch (error) {
      if (liveScope.current !== scope || generation.current !== sequence) return
      if (controller.signal.aborted && !(error instanceof AuditReadError)) return
      if (error instanceof AuditReadError && (error.status === 401 || error.status === 403)) ownership.current.revision += 1
      setStored((previous) => ({
        ...(error instanceof AuditReadError && (error.status === 401 || error.status === 403) ? EMPTY : previous),
        scope, loading: false, detailLoadingId: null, listFailed: true,
        message: error instanceof Error ? error.message : "Failed to load audit records. Please retry.",
      }))
    }
  }, [scope, endpoint, page, actor, filterOperation])

  useEffect(() => {
    if (scope !== null) void readPage({ cursor: null, cursors: [null], index: 0, historyTruncated: false }, true)
    else { generation.current += 1; setStored(EMPTY) }
    return () => {
      ownership.current.revision += 1
      generation.current += 1
      listController.current?.abort()
      detailController.current?.abort()
    }
  }, [scope, readPage])

  useEffect(() => {
    if (scope === null || view.loading || !selectedId || detailsLoaded) return
    const sequence = generation.current
    const controller = new AbortController()
    detailController.current?.abort()
    detailController.current = controller
    let active = true
    const current = () => active && liveScope.current === scope && generation.current === sequence && !controller.signal.aborted
    setStored((previous) => ({ ...previous, detailLoadingId: selectedId, detailFailed: false,
      message: previous.detailFailed && !previous.listFailed ? "" : previous.message }))
    void (async () => {
      try {
        const data = await readJson(`${endpoint}?id=${encodeURIComponent(selectedId)}`, controller)
        if (!object(data) || !validLog(data.log) || data.log.id !== selectedId || !data.log.detailsLoaded) throw new Error("The audit details could not be verified. Please retry.")
        if (!current()) return
        const detail = data.log
        setStored((previous) => ({
          ...previous,
          // The bounded list owns classification, identity and its display
          // labels. Legacy lazy-detail enrichment may use an older name map.
          logs: previous.logs.map((log) => log.id === selectedId ? {
            ...log, details: detail.details, detailsLoaded: detail.detailsLoaded,
            undoable: detail.undoable, undoOfLogId: detail.undoOfLogId, undoneAt: detail.undoneAt,
          } : log),
          detailLoadingId: null, detailFailed: false,
        }))
      } catch (error) {
        if (!active || liveScope.current !== scope || generation.current !== sequence) return
        if (controller.signal.aborted && !(error instanceof AuditReadError)) return
        if (error instanceof AuditReadError && (error.status === 401 || error.status === 403)) ownership.current.revision += 1
        setStored((previous) => ({
          ...(error instanceof AuditReadError && (error.status === 401 || error.status === 403) ? EMPTY : previous),
          scope, detailLoadingId: null,
          detailFailed: error instanceof AuditReadError && (error.status === 401 || error.status === 403) || !previous.listFailed,
          message: error instanceof AuditReadError && (error.status === 401 || error.status === 403)
            ? error.message : previous.listFailed ? previous.message : error instanceof Error ? error.message : "Failed to load audit details. Please retry.",
        }))
      }
    })()
    return () => { active = false; controller.abort() }
  }, [scope, endpoint, selectedId, detailsLoaded, view.loading, detailRetry])

  const refresh = () => readPage({ cursor: null, cursors: [null], index: 0, historyTruncated: false })
  const retry = () => {
    if (view.detailFailed && selectedId && !view.listFailed) setDetailRetry((value) => value + 1)
    // A denied detail clears the private page and selection. Recover through
    // a fresh authorized list, not a detail effect with no selected row.
    else void readPage(view.pageInfo && pendingTarget.current
      ? pendingTarget.current : { cursor: null, cursors: [null], index: 0, historyTruncated: false })
  }
  const older = () => {
    const cursor = view.pageInfo?.nextCursor
    if (view.loading || !cursor) return
    let cursors = [...view.cursors.slice(0, view.index + 1), cursor]
    const historyTruncated = view.historyTruncated || cursors.length > HISTORY_LIMIT
    if (cursors.length > HISTORY_LIMIT) cursors = cursors.slice(-HISTORY_LIMIT)
    void readPage({ cursor, cursors, index: cursors.length - 1, historyTruncated })
  }
  const previous = () => {
    if (view.loading || view.index < 1) return
    const index = view.index - 1
    void readPage({ cursor: view.cursors[index], cursors: view.cursors, index, historyTruncated: view.historyTruncated })
  }
  const select = (id: string) => setStored((current) => current.scope === scope && current.logs.some((log) => log.id === id) ? { ...current, selectedId: id, message: current.listFailed ? current.message : "", detailFailed: false } : current)
  // An intervening list refresh does not cancel an already authorized write.
  // Owner/filter replacement or lost access still makes its callback stale.
  const token = (): Token => ({ scope, ownershipRevision: ownership.current.revision })
  const isCurrent = (value: Token) => value.scope !== null && liveScope.current === value.scope && ownership.current.revision === value.ownershipRevision
  return { ...view, selectedLog, refresh, retry, older, previous, select, token, isCurrent }
}
