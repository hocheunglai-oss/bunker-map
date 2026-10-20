"use client"

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { fetchSpcRecordPage, getSpcRecordHongKongDay, SpcRecordPageError, SPC_RECORD_API_MAX_BYTES, SPC_RECORD_READ_TIMEOUT_MS,
  type SpcRecordPage, type SpcRecordPageCursor, type SpcRecordPageKind } from "@/lib/spcRecordPageResponse"

type ReadState<K extends SpcRecordPageKind> = {
  owner: string | null
  page: SpcRecordPage<K> | null
  trail: Array<SpcRecordPageCursor | null>
  loading: boolean
  error: string
  denied: boolean
  navigationStale: boolean
  readSequence: number
}
const unavailable = "The complete record page could not be verified. Your previous data and drafts are kept."

// Used by the existing review/reason endpoints too. Deadline includes the body,
// and ownership checks at the caller remain necessary if a transport ignores abort.
export async function fetchSpcRecordJson(url: string, init: RequestInit, signal: AbortSignal): Promise<unknown> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal.addEventListener("abort", abort, { once: true })
  if (signal.aborted) controller.abort()
  let timer: ReturnType<typeof setTimeout> | undefined
  let rejectAbort: (() => void) | undefined
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = () => reject(new DOMException("Request cancelled", "AbortError"))
    controller.signal.addEventListener("abort", rejectAbort, { once: true })
    if (controller.signal.aborted) rejectAbort()
  })
  const read = async () => {
    const response = await fetch(url, { ...init, cache: "no-store", signal: controller.signal })
    if (response.status === 401 || response.status === 403) throw new SpcRecordPageError("Your access could not be verified. Sign in again before loading records.", response.status)
    if (response.status === 409) throw new SpcRecordPageError("This record changed. Your draft is kept. Refresh and review the latest record before saving.", 409)
    if (!response.ok) throw new SpcRecordPageError("The request could not be completed. Your draft is kept. Refresh and check its result before trying again.", response.status)
    const body = await response.text()
    if (new TextEncoder().encode(body).byteLength > SPC_RECORD_API_MAX_BYTES) throw new SpcRecordPageError(unavailable)
    try { return JSON.parse(body) as unknown } catch { throw new SpcRecordPageError(unavailable) }
  }
  try {
    return await Promise.race([read(), aborted, new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new SpcRecordPageError("The request timed out. Your draft is kept. Refresh and check its result before trying again."))
        controller.abort()
      }, SPC_RECORD_READ_TIMEOUT_MS)
    })])
  } finally {
    if (timer) clearTimeout(timer)
    signal.removeEventListener("abort", abort)
    if (rejectAbort) controller.signal.removeEventListener("abort", rejectAbort)
  }
}

export function useSpcRecordPageRead<K extends SpcRecordPageKind>(kind: K, owner: string | null) {
  const [state, setState] = useState<ReadState<K>>({ owner, page: null, trail: [null], loading: false,
    error: "", denied: false, navigationStale: false, readSequence: 0 })
  const stateRef = useRef(state)
  const ownerRef = useRef(owner)
  useLayoutEffect(() => { stateRef.current = state; ownerRef.current = owner }, [state, owner])
  const generation = useRef(0)
  const controller = useRef<AbortController | null>(null)
  const active = useRef(true)
  const busy = useRef(false)
  const cancel = useCallback(() => {
    generation.current++
    controller.current?.abort()
    controller.current = null
    busy.current = false
  }, [])
  const deny = useCallback(() => {
    cancel()
    setState(current => ({ ...current, owner: ownerRef.current, page: null, trail: [null], loading: false,
      denied: true, error: "Your access could not be verified. Sign in again before loading records." }))
  }, [cancel])
  const read = useCallback(async (trail: Array<SpcRecordPageCursor | null>) => {
    if (!owner || ownerRef.current !== owner) return
    // A Hong Kong day boundary invalidates today's cursor even when the device
    // uses another timezone. Never send yesterday's cursor to today's list.
    const cursor = trail.at(-1)
    if (kind === "today" && cursor && cursor.day !== getSpcRecordHongKongDay()) trail = [null]
    cancel()
    const request = ++generation.current, abort = new AbortController()
    controller.current = abort
    busy.current = true
    const owns = () => active.current && ownerRef.current === owner && request === generation.current
    setState(current => ({ ...current, owner, loading: true, error: "" }))
    try {
      const page = await fetchSpcRecordPage(kind, trail.at(-1) || null, abort.signal)
      if (!owns()) return
      if (page.pageIndex !== (page.totalCount ? trail.length : 0)) throw new SpcRecordPageError(unavailable)
      setState(current => ({ owner, page, trail, loading: false, error: "", denied: false,
        navigationStale: false, readSequence: current.readSequence + 1 }))
    } catch (error) {
      if (!owns()) return
      if (error instanceof SpcRecordPageError && (error.status === 401 || error.status === 403)) { deny(); return }
      setState(current => ({ ...current, owner, loading: false,
        error: error instanceof SpcRecordPageError ? error.message : unavailable }))
    } finally {
      if (owns()) { busy.current = false; controller.current = null }
    }
  }, [owner, kind, cancel, deny])
  useEffect(() => {
    active.current = true
    cancel()
    setState({ owner, page: null, trail: [null], loading: false, error: "", denied: false, navigationStale: false, readSequence: 0 })
    if (owner) void read([null])
    return () => { active.current = false; cancel() }
  }, [owner, read, cancel])
  const refresh = useCallback(() => read([null]), [read])
  const reloadCurrent = useCallback(() => {
    const current = stateRef.current
    if (!busy.current && !current.navigationStale && current.owner === owner && !current.denied) {
      void read(kind === "today" && current.page?.day !== getSpcRecordHongKongDay() ? [null] : current.trail)
    }
  }, [owner, kind, read])
  function next() {
    const current = stateRef.current
    if (!busy.current && !current.navigationStale && current.owner === owner && current.page?.nextCursor) void read([...current.trail, current.page.nextCursor])
  }
  function previous() {
    const current = stateRef.current
    if (!busy.current && !current.navigationStale && current.owner === owner && current.trail.length > 1) void read(current.trail.slice(0, -1))
  }
  function updateRows(update: (rows: SpcRecordPage<K>["enquiries"]) => SpcRecordPage<K>["enquiries"]) {
    cancel()
    setState(current => current.owner === owner && current.page ? { ...current,
      page: { ...current.page, enquiries: update(current.page.enquiries) }, loading: false, navigationStale: true } : current)
  }
  function cancelRead() {
    cancel()
    setState(current => ({ ...current, loading: false }))
  }
  function invalidateNavigation() {
    cancel()
    setState(current => ({ ...current, loading: false, navigationStale: true }))
  }
  return { ...state, page: state.owner === owner ? state.page : null,
    error: state.owner === owner ? state.error : "", denied: state.owner === owner && state.denied,
    refresh, reloadCurrent, next, previous, updateRows, cancelRead, invalidateNavigation, deny }
}
