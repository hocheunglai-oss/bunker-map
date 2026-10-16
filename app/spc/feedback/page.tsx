"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { FormEvent } from "react"
import { useRouter } from "next/navigation"
import { SpcShell } from "@/components/SpcShell"
import {
  SPC_FEEDBACK_CATEGORIES,
  SPC_FEEDBACK_STATUSES,
  parseSpcFeedbackList,
  parseSpcFeedbackResponse,
  verifySpcFeedbackReview,
  type SpcFeedbackCategory,
  type SpcFeedbackRecord,
  type SpcFeedbackStatus,
} from "@/lib/spcFeedbackShared"
import { canAccessSpcPage, normaliseSpcRole } from "@/lib/spcPages"
import { useSpcAuth } from "@/lib/useSpcAuth"

const AREA_OPTIONS = ["", "ENQUIRIES", "FIXTURES", "LOST RECORD", "STATISTICS", "SUPPLIER DATABASE", "WHATSAPP EXTENSION", "USER MANAGEMENT", "OTHER"]

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value))
}

export default function SpcFeedbackPage() {
  const router = useRouter()
  const { loading: authLoading, authenticated, permissions, role, username, mustChangePassword } = useSpcAuth()
  const canView = canAccessSpcPage(permissions, "spc-feedback", "view")
  const canEdit = canAccessSpcPage(permissions, "spc-feedback", "edit")
  const isAdmin = normaliseSpcRole(role) === "ADMIN"
  useEffect(() => { document.title = "SPC Feedback" }, [])
  useEffect(() => {
    if (!authLoading && (!authenticated || !canView || mustChangePassword)) router.replace("/spc")
  }, [authLoading, authenticated, canView, mustChangePassword, router])
  if (authLoading || !authenticated || !canView || mustChangePassword) return <div className="spc-loading">Loading...</div>
  // Authenticated replacements need not pass through a signed-out render.
  return <FeedbackContent key={JSON.stringify([username, role, permissions["spc-feedback"]])}
    username={username || ""} canEdit={canEdit} isAdmin={isAdmin} />
}

type ReviewDraft = Pick<SpcFeedbackRecord, "status" | "adminResponse">

class FeedbackTimeout extends Error {}

// Bound the whole fetch + JSON decoding, even if a transport ignores abort.
async function requestFeedback(controller: AbortController, init: RequestInit = {}) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: () => void = () => {}
  const interrupted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new Error("Request cancelled"))
    controller.signal.addEventListener("abort", abort, { once: true })
    timer = setTimeout(() => {
      reject(new FeedbackTimeout("Request timed out"))
      controller.abort()
    }, 30_000)
  })
  try {
    return await Promise.race([interrupted, (async () => {
      const response = await fetch("/api/spc/feedback", { ...init, signal: controller.signal })
      const data: unknown = response.ok ? await response.json() : null
      return { response, data }
    })()])
  } finally {
    clearTimeout(timer)
    controller.signal.removeEventListener("abort", abort)
  }
}

function FeedbackContent({ username, canEdit, isAdmin }: { username: string; canEdit: boolean; isAdmin: boolean }) {
  const [records, setRecords] = useState<SpcFeedbackRecord[]>([])
  const [drafts, setDrafts] = useState<Record<string, ReviewDraft>>({})
  const draftsRef = useRef(drafts)
  const owner = useRef({ active: true, generation: 0, controllers: new Set<AbortController>(), saving: new Set<string>(), submitting: false, uncertainSubmission: false })
  const [category, setCategory] = useState<SpcFeedbackCategory>("SUGGESTION")
  const [area, setArea] = useState("")
  const [title, setTitle] = useState("")
  const [message, setMessage] = useState("")
  const [notice, setNotice] = useState("")
  const [isError, setIsError] = useState(false)
  const [loadingRecords, setLoadingRecords] = useState(true)
  const [loaded, setLoaded] = useState(false)
  const [accessDenied, setAccessDenied] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [uncertainSubmission, setUncertainSubmission] = useState(false)
  const [savingIds, setSavingIds] = useState<Set<string>>(new Set())
  const [statusFilter, setStatusFilter] = useState<SpcFeedbackStatus | "ALL">("ALL")

  useEffect(() => {
    const current = owner.current
    current.active = true
    return () => {
      current.active = false
      current.generation++
      for (const controller of current.controllers) controller.abort()
      current.controllers.clear()
    }
  }, [])

  function replaceDrafts(next: Record<string, ReviewDraft>) {
    draftsRef.current = next
    setDrafts(next)
  }

  const denyAccess = useCallback(() => {
    setRecords([])
    setLoaded(false)
    setAccessDenied(true)
    setLoadingRecords(false)
    draftsRef.current = {}
    setDrafts({})
    setTitle("")
    setMessage("")
    setArea("")
    setNotice("Your access has changed. Sign in again or refresh your session.")
    setIsError(true)
    owner.current.generation++
    for (const controller of owner.current.controllers) controller.abort()
  }, [])

  const loadRecords = useCallback(async () => {
    const current = owner.current, generation = ++current.generation, controller = new AbortController()
    current.controllers.add(controller)
    const owns = () => current.active && current.generation === generation && !controller.signal.aborted
    setLoadingRecords(true)
    try {
      const { response, data } = await requestFeedback(controller, { cache: "no-store" })
      if (!owns()) return
      if (response.status === 401 || response.status === 403) { denyAccess(); return }
      if (!response.ok) throw Error("Unavailable")
      setRecords(parseSpcFeedbackList(data))
      const wasUncertain = current.uncertainSubmission
      current.uncertainSubmission = false
      setUncertainSubmission(false)
      setLoaded(true)
      setAccessDenied(false)
      setNotice(wasUncertain ? "Feedback refreshed. Check the list below before sending your kept draft again." : "")
      setIsError(false)
    } catch (error) {
      if (!owns() && !(current.active && current.generation === generation && error instanceof FeedbackTimeout)) return
      setNotice("Feedback could not be loaded. Please try again. Any last verified feedback is shown below.")
      setIsError(true)
    } finally {
      current.controllers.delete(controller)
      if (current.active && current.generation === generation) setLoadingRecords(false)
    }
  }, [denyAccess])

  useEffect(() => {
    const initialLoad = window.setTimeout(() => void loadRecords(), 0)
    return () => window.clearTimeout(initialLoad)
  }, [loadRecords])

  const visibleRecords = useMemo(
    () => statusFilter === "ALL" ? records : records.filter((record) => record.status === statusFilter),
    [records, statusFilter],
  )

  async function submitFeedback(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canEdit || accessDenied || owner.current.submitting || owner.current.uncertainSubmission || !loaded || loadingRecords) return
    const current = owner.current, controller = new AbortController()
    current.submitting = true
    current.controllers.add(controller)
    const owns = () => current.active && !controller.signal.aborted
    const submitted = { category, area: area.trim(), title: title.trim(), message: message.trim() }
    setSubmitting(true)
    setNotice("")
    setIsError(false)
    try {
      const { response, data } = await requestFeedback(controller, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(submitted),
      })
      if (!owns()) return
      if (response.status === 401 || response.status === 403) {
        current.uncertainSubmission = true
        setUncertainSubmission(true)
        denyAccess()
        return
      }
      if (!response.ok) throw Error("Unavailable")
      const record = parseSpcFeedbackResponse(data)
      if (record.createdByUsername !== username || record.category !== submitted.category ||
          record.title !== submitted.title || record.message !== submitted.message || record.area !== submitted.area ||
          record.status !== "NEW" || record.adminResponse !== "") throw Error("Unverified acknowledgement")
      setRecords(previous => [record, ...previous.filter(item => item.id !== record.id)].slice(0, 250))
      setTitle("")
      setMessage("")
      setArea("")
      setCategory("SUGGESTION")
      setNotice("Thank you. Your feedback has been sent.")
    } catch (error) {
      if (!owns() && !(current.active && error instanceof FeedbackTimeout)) return
      current.uncertainSubmission = true
      setUncertainSubmission(true)
      setNotice("Your submission could not be verified. Your draft is kept. Refresh feedback and check the list before sending it again.")
      setIsError(true)
    } finally {
      current.controllers.delete(controller)
      current.submitting = false
      if (current.active) setSubmitting(false)
    }
  }

  async function saveReview(record: SpcFeedbackRecord) {
    const current = owner.current
    if (!canEdit || accessDenied || current.saving.has(record.id) || loadingRecords) return
    const controller = new AbortController(), draft = draftsRef.current[record.id] || record
    const submitted = { id: record.id, expectedUpdatedAt: record.updatedAt, status: draft.status, adminResponse: draft.adminResponse.trim() }
    const capturedDraft = { status: draft.status, adminResponse: draft.adminResponse }
    current.controllers.add(controller)
    current.saving.add(record.id)
    setSavingIds(new Set(current.saving))
    const owns = () => current.active && !controller.signal.aborted
    setNotice("")
    setIsError(false)
    try {
      const { response, data } = await requestFeedback(controller, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(submitted),
      })
      if (!owns()) return
      if (response.status === 401 || response.status === 403) { denyAccess(); return }
      if (response.status === 409) throw Error("conflict")
      if (!response.ok) throw Error("Unavailable")
      const updatedRecord = verifySpcFeedbackReview(parseSpcFeedbackResponse(data), submitted)
      setRecords((current) => current.map((item) => item.id === updatedRecord.id ? updatedRecord : item))
      const latest = draftsRef.current[record.id]
      const changed = latest && (latest.status !== capturedDraft.status || latest.adminResponse !== capturedDraft.adminResponse)
      if (!changed) {
        const next = { ...draftsRef.current }
        delete next[record.id]
        replaceDrafts(next)
      }
      setNotice(changed ? "Feedback review saved. Your newer unsaved changes are kept." : "Feedback review saved.")
    } catch (error) {
      if (!owns() && !(current.active && error instanceof FeedbackTimeout)) return
      setNotice(error instanceof Error && error.message === "conflict"
        ? "This feedback has changed. Your draft is kept. Refresh feedback to review the latest version before saving."
        : "The saved review could not be verified. Your draft is kept. Refresh feedback before trying again.")
      setIsError(true)
    } finally {
      current.controllers.delete(controller)
      current.saving.delete(record.id)
      if (current.active) setSavingIds(new Set(current.saving))
    }
  }

  function updateRecord(record: SpcFeedbackRecord, patch: Partial<ReviewDraft>) {
    replaceDrafts({ ...draftsRef.current, [record.id]: { ...(draftsRef.current[record.id] || record), ...patch } })
  }

  function refresh() {
    if (Object.keys(draftsRef.current).length && !window.confirm("Refresh feedback and discard unsaved reviews?")) return
    replaceDrafts({})
    void loadRecords()
  }
  const editable = canEdit && !accessDenied

  return (
    <SpcShell title="SPC Feedback">
      {notice ? <div className={`spc-alert${isError ? " is-error" : ""}`} role={isError ? "alert" : "status"}>{notice}</div> : null}

      <section className="spc-panel spc-feedback-compose">
        <div className="spc-panel-header">
          <div><h2>Feedback</h2><p>Share a suggestion, report a problem, or request a new feature.</p></div>
        </div>
        <form onSubmit={submitFeedback} className="spc-feedback-form">
          <label><span>TYPE</span><select value={category} onChange={(event) => setCategory(event.target.value as SpcFeedbackCategory)} disabled={!editable || submitting}>{SPC_FEEDBACK_CATEGORIES.map((option) => <option key={option}>{option}</option>)}</select></label>
          <label><span>AREA</span><select value={area} onChange={(event) => setArea(event.target.value)} disabled={!editable || submitting}>{AREA_OPTIONS.map((option) => <option key={option || "general"} value={option}>{option || "GENERAL"}</option>)}</select></label>
          <label className="spc-feedback-title"><span>TITLE</span><input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} placeholder="A short summary" required disabled={!editable || submitting} /></label>
          <label className="spc-feedback-message"><span>DETAILS</span><textarea value={message} onChange={(event) => setMessage(event.target.value)} maxLength={4000} rows={6} placeholder="Tell us what happened or what would make SPC better." required disabled={!editable || submitting} /></label>
          <div className="spc-feedback-submit"><small>{uncertainSubmission ? "Refresh feedback and check the list before sending again." : "Your name is included so we can follow up."}</small><button type="submit" className="spc-page-action" disabled={!editable || submitting || uncertainSubmission || !loaded || loadingRecords}>{submitting ? "Sending..." : "Send Feedback"}</button></div>
        </form>
      </section>

      <section className="spc-panel spc-feedback-list-panel">
        <div className="spc-panel-header" style={{ flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 160px" }}><h2>{isAdmin ? "All Feedback" : "My Feedback"}</h2><p>{loaded ? records.length + " record" + (records.length === 1 ? "" : "s") : "Feedback unavailable"}</p></div>
          <button type="button" className="spc-page-action" onClick={refresh} disabled={loadingRecords || submitting || savingIds.size > 0}>{loadingRecords ? "Loading..." : loaded ? "Refresh Feedback" : "Retry Feedback"}</button>
          {isAdmin ? <select aria-label="Filter feedback status" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as SpcFeedbackStatus | "ALL")}><option value="ALL">ALL STATUS</option>{SPC_FEEDBACK_STATUSES.map((status) => <option key={status}>{status}</option>)}</select> : null}
        </div>
        {loadingRecords ? <div className="spc-empty">Loading feedback...</div> : !loaded ? <div className="spc-empty">Feedback is unavailable. Please retry.</div> : visibleRecords.length === 0 ? <div className="spc-empty">{records.length ? "No feedback matches this status." : "No feedback yet."}</div> : (
          <div className="spc-feedback-records">
            {visibleRecords.map((record) => (
              <article key={record.id} className="spc-feedback-record">
                <header><div><span>{record.category}{record.area ? ` · ${record.area}` : ""}</span><h3>{record.title}</h3></div><strong className={`is-${record.status.toLowerCase().replace(" ", "-")}`}>{record.status}</strong></header>
                <p>{record.message}</p>
                <footer><span>{isAdmin ? `${record.createdByDisplayName} · ` : ""}{formatDate(record.createdAt)}</span>{record.reviewedByDisplayName ? <span>Reviewed by {record.reviewedByDisplayName}</span> : null}</footer>
                {isAdmin ? (
                  <div className="spc-feedback-review">
                    <label><span>STATUS</span><select value={(drafts[record.id] || record).status} disabled={!editable} onChange={(event) => updateRecord(record, { status: event.target.value as SpcFeedbackStatus })}>{SPC_FEEDBACK_STATUSES.map((status) => <option key={status}>{status}</option>)}</select></label>
                    <label><span>RESPONSE</span><textarea value={(drafts[record.id] || record).adminResponse} disabled={!editable} onChange={(event) => updateRecord(record, { adminResponse: event.target.value })} maxLength={2000} rows={3} placeholder="Optional response to the user" /></label>
                    <button type="button" className="spc-page-action" onClick={() => void saveReview(record)} disabled={!editable || loadingRecords || savingIds.has(record.id)}>{savingIds.has(record.id) ? "Saving..." : "Save Review"}</button>
                  </div>
                ) : record.adminResponse ? <div className="spc-feedback-response"><span>RESPONSE</span><p>{record.adminResponse}</p></div> : null}
              </article>
            ))}
          </div>
        )}
      </section>
    </SpcShell>
  )
}
