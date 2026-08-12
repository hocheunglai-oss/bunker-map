"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import type { FormEvent } from "react"
import { useRouter } from "next/navigation"
import { SpcShell } from "@/components/SpcShell"
import {
  SPC_FEEDBACK_CATEGORIES,
  SPC_FEEDBACK_STATUSES,
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
  const { loading: authLoading, authenticated, permissions, role } = useSpcAuth()
  const canView = canAccessSpcPage(permissions, "spc-feedback", "view")
  const canEdit = canAccessSpcPage(permissions, "spc-feedback", "edit")
  const isAdmin = normaliseSpcRole(role) === "ADMIN"
  const [records, setRecords] = useState<SpcFeedbackRecord[]>([])
  const [category, setCategory] = useState<SpcFeedbackCategory>("SUGGESTION")
  const [area, setArea] = useState("")
  const [title, setTitle] = useState("")
  const [message, setMessage] = useState("")
  const [notice, setNotice] = useState("")
  const [isError, setIsError] = useState(false)
  const [loadingRecords, setLoadingRecords] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [savingId, setSavingId] = useState("")
  const [statusFilter, setStatusFilter] = useState<SpcFeedbackStatus | "ALL">("ALL")

  const loadRecords = useCallback(async () => {
    if (!authenticated || !canView) return
    setLoadingRecords(true)
    try {
      const response = await fetch("/api/spc/feedback", { cache: "no-store" })
      const data = (await response.json()) as { records?: SpcFeedbackRecord[]; message?: string }
      if (!response.ok) throw new Error(data.message || "Failed to load feedback.")
      setRecords(data.records || [])
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Failed to load feedback.")
      setIsError(true)
    } finally {
      setLoadingRecords(false)
    }
  }, [authenticated, canView])

  useEffect(() => { document.title = "SPC Feedback" }, [])
  useEffect(() => {
    if (!authLoading && (!authenticated || !canView)) router.replace("/spc")
  }, [authLoading, authenticated, canView, router])
  useEffect(() => { void loadRecords() }, [loadRecords])

  const visibleRecords = useMemo(
    () => statusFilter === "ALL" ? records : records.filter((record) => record.status === statusFilter),
    [records, statusFilter],
  )

  async function submitFeedback(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSubmitting(true)
    setNotice("")
    setIsError(false)
    try {
      const response = await fetch("/api/spc/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category, area, title, message }),
      })
      const data = (await response.json()) as { record?: SpcFeedbackRecord; message?: string }
      if (!response.ok || !data.record) throw new Error(data.message || "Failed to submit feedback.")
      setRecords((current) => [data.record as SpcFeedbackRecord, ...current])
      setTitle("")
      setMessage("")
      setArea("")
      setCategory("SUGGESTION")
      setNotice("Thank you. Your feedback has been sent.")
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Failed to submit feedback.")
      setIsError(true)
    } finally {
      setSubmitting(false)
    }
  }

  async function saveReview(record: SpcFeedbackRecord) {
    setSavingId(record.id)
    setNotice("")
    setIsError(false)
    try {
      const response = await fetch("/api/spc/feedback", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: record.id, status: record.status, adminResponse: record.adminResponse }),
      })
      const data = (await response.json()) as { record?: SpcFeedbackRecord; message?: string }
      if (!response.ok || !data.record) throw new Error(data.message || "Failed to save the review.")
      const updatedRecord = data.record
      setRecords((current) => current.map((item) => item.id === updatedRecord.id ? updatedRecord : item))
      setNotice("Feedback review saved.")
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Failed to save the review.")
      setIsError(true)
    } finally {
      setSavingId("")
    }
  }

  function updateRecord(id: string, patch: Partial<SpcFeedbackRecord>) {
    setRecords((current) => current.map((record) => record.id === id ? { ...record, ...patch } : record))
  }

  if (authLoading || !authenticated || !canView) return <div className="spc-loading">Loading...</div>

  return (
    <SpcShell title="SPC Feedback">
      {notice ? <div className={`spc-alert${isError ? " is-error" : ""}`} role="status">{notice}</div> : null}

      <section className="spc-panel spc-feedback-compose">
        <div className="spc-panel-header">
          <div><h2>Feedback</h2><p>Share a suggestion, report a problem, or request a new feature.</p></div>
        </div>
        <form onSubmit={submitFeedback} className="spc-feedback-form">
          <label><span>TYPE</span><select value={category} onChange={(event) => setCategory(event.target.value as SpcFeedbackCategory)} disabled={!canEdit || submitting}>{SPC_FEEDBACK_CATEGORIES.map((option) => <option key={option}>{option}</option>)}</select></label>
          <label><span>AREA</span><select value={area} onChange={(event) => setArea(event.target.value)} disabled={!canEdit || submitting}>{AREA_OPTIONS.map((option) => <option key={option || "general"} value={option}>{option || "GENERAL"}</option>)}</select></label>
          <label className="spc-feedback-title"><span>TITLE</span><input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} placeholder="A short summary" required disabled={!canEdit || submitting} /></label>
          <label className="spc-feedback-message"><span>DETAILS</span><textarea value={message} onChange={(event) => setMessage(event.target.value)} maxLength={4000} rows={6} placeholder="Tell us what happened or what would make SPC better." required disabled={!canEdit || submitting} /></label>
          <div className="spc-feedback-submit"><small>Your name is included so we can follow up.</small><button type="submit" className="spc-page-action" disabled={!canEdit || submitting}>{submitting ? "Sending..." : "Send Feedback"}</button></div>
        </form>
      </section>

      <section className="spc-panel spc-feedback-list-panel">
        <div className="spc-panel-header">
          <div><h2>{isAdmin ? "All Feedback" : "My Feedback"}</h2><p>{records.length} record{records.length === 1 ? "" : "s"}</p></div>
          {isAdmin ? <select aria-label="Filter feedback status" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as SpcFeedbackStatus | "ALL")}><option value="ALL">ALL STATUS</option>{SPC_FEEDBACK_STATUSES.map((status) => <option key={status}>{status}</option>)}</select> : null}
        </div>
        {loadingRecords ? <div className="spc-empty">Loading feedback...</div> : visibleRecords.length === 0 ? <div className="spc-empty">No feedback yet.</div> : (
          <div className="spc-feedback-records">
            {visibleRecords.map((record) => (
              <article key={record.id} className="spc-feedback-record">
                <header><div><span>{record.category}{record.area ? ` · ${record.area}` : ""}</span><h3>{record.title}</h3></div><strong className={`is-${record.status.toLowerCase().replace(" ", "-")}`}>{record.status}</strong></header>
                <p>{record.message}</p>
                <footer><span>{isAdmin ? `${record.createdByDisplayName} · ` : ""}{formatDate(record.createdAt)}</span>{record.reviewedByDisplayName ? <span>Reviewed by {record.reviewedByDisplayName}</span> : null}</footer>
                {isAdmin ? (
                  <div className="spc-feedback-review">
                    <label><span>STATUS</span><select value={record.status} onChange={(event) => updateRecord(record.id, { status: event.target.value as SpcFeedbackStatus })}>{SPC_FEEDBACK_STATUSES.map((status) => <option key={status}>{status}</option>)}</select></label>
                    <label><span>RESPONSE</span><textarea value={record.adminResponse} onChange={(event) => updateRecord(record.id, { adminResponse: event.target.value })} maxLength={2000} rows={3} placeholder="Optional response to the user" /></label>
                    <button type="button" className="spc-page-action" onClick={() => void saveReview(record)} disabled={savingId === record.id}>{savingId === record.id ? "Saving..." : "Save Review"}</button>
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
