"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import type { ReportSnapshotKey } from "@/lib/reportSnapshots"
import { formatReportDate } from "@/lib/taiwanReport"
import { parsePublicationBaseline, type PublicationBaseline as Baseline } from "@/lib/reportPublicationClient"

type State = { baseline: Baseline | null; status: "loading" | "ready" | "reload" | "publishing"; message: string; published: boolean }
const VERSION = /^[a-f0-9]{64}$/
const INITIAL: State = { baseline: null, status: "loading", message: "", published: false }
const RELOAD = "Reload saved report data to review it before publishing. Your inputs are unchanged."

// A local save may refresh source data, but must never silently adopt a newer
// publication baseline. Only an explicit reload accepts somebody else's report.
export function useReportPublication(report: ReportSnapshotKey, page: string, enabled: boolean, canEdit: boolean) {
  const [state, setState] = useState<State>(INITIAL)
  const current = useRef<State>(INITIAL), generation = useRef(0), operation = useRef(0)
  const controller = useRef<AbortController | null>(null)
  const url = `/api/admin/report-publication?report=${report}&page=${page}`
  const update = useCallback((patch: Partial<State>) => {
    current.current = { ...current.current, ...patch }; setState(current.current)
  }, [])
  const reload = useCallback(async (keepPublication = false) => {
    if (!enabled || current.current.status === "publishing") return false
    const previous = current.current.baseline
    if (keepPublication && !previous) { update({ status: "reload", published: false, message: RELOAD }); return false }
    const id = ++operation.current, epoch = generation.current
    controller.current?.abort()
    const abort = new AbortController(); controller.current = abort
    const timer = setTimeout(() => abort.abort(), 20_000)
    update({ status: "loading", message: "", published: false })
    try {
      const response = await fetch(url, { cache: "no-store", credentials: "same-origin", signal: abort.signal })
      if (!response.ok) throw Error()
      const data = parsePublicationBaseline(await response.json(), report)
      if (id !== operation.current || epoch !== generation.current) return false
      if (keepPublication && data.publicationVersion !== previous?.publicationVersion) {
        update({ status: "reload", message: "Another publication was saved. " + RELOAD }); return false
      }
      update({ baseline: data, status: "ready", message: "" }); return true
    } catch {
      if (id === operation.current && epoch === generation.current) update({ status: "reload", message: "Saved report data could not be loaded completely. " + RELOAD })
      return false
    } finally { clearTimeout(timer); if (id === operation.current) controller.current = null }
  }, [enabled, report, update, url])
  useEffect(() => {
    const generations = generation, operations = operation, requests = controller
    const epoch = ++generations.current
    queueMicrotask(() => {
      if (generation.current !== epoch) return
      update(INITIAL)
      if (enabled) void reload()
    })
    return () => { generations.current++; operations.current++; requests.current?.abort() }
  }, [enabled, reload, update])

  function invalidate() {
    if (current.current.status === "publishing") return
    operation.current++; controller.current?.abort(); controller.current = null
    update({ status: "reload", published: false, message: RELOAD })
  }
  function resetPublished() {
    if (current.current.status !== "publishing") update({ published: false, message: current.current.status === "ready" ? "" : current.current.message })
  }
  async function publish(dateOverride = "") {
    const previous = current.current.baseline
    if (!enabled || !canEdit || !previous || current.current.status !== "ready") return null
    const id = ++operation.current, epoch = generation.current
    controller.current?.abort()
    const abort = new AbortController(); controller.current = abort
    const timer = setTimeout(() => abort.abort(), 25_000)
    update({ status: "publishing", published: false, message: "" })
    try {
      const response = await fetch(url, { method: "POST", cache: "no-store", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceVersion: previous.sourceVersion, publicationVersion: previous.publicationVersion, dateOverride }),
        signal: abort.signal })
      if (!response.ok) {
        if (response.status === 409) throw Error("Saved data or the published report changed. " + RELOAD)
        if (response.status === 403) throw Error("You do not have permission to publish this report.")
        throw Error()
      }
      const data = await response.json()
      const expectedDate = dateOverride ? formatReportDate(dateOverride) : previous.preview.reportDate
      if (!data || data.report !== report || data.sourceVersion !== previous.sourceVersion
        || typeof data.publicationVersion !== "string" || !VERSION.test(data.publicationVersion)
        || typeof data.replayed !== "boolean" || data.reportDate !== expectedDate) throw Error()
      if (id !== operation.current || epoch !== generation.current) return null
      update({ baseline: { ...previous, publicationVersion: data.publicationVersion, publishedReportDate: data.reportDate, publishedReportDamaged: false },
        status: "ready", published: true, message: `Published ${data.reportDate}` })
      return data as { reportDate: string }
    } catch (error) {
      if (id === operation.current && epoch === generation.current) update({ status: "reload", published: false,
        message: error instanceof Error && /^(Saved data or|You do not have permission)/.test(error.message) ? error.message
          : "Publication could not be confirmed. " + RELOAD })
      return null
    } finally { clearTimeout(timer); if (id === operation.current) controller.current = null }
  }
  return { ...state, ready: enabled && state.status === "ready", loading: state.status === "loading",
    publishing: state.status === "publishing", reload, invalidate, resetPublished, publish }
}
