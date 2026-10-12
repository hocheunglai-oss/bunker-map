"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import {
  fetchParserReportResponse,
  notifyParserReportCountChanged,
  type ParserReportClientSource,
} from "@/lib/parserReportClient"

type ParserReport = {
  id: string
  context: string
  rawText: string
  parserOutput: string
  correctedOutput: string
  note: string
  metadata: Record<string, unknown>
  lastReportedAt: string
  updatedAt: string
}

type AiSource = { title?: string; url: string }

type ReportDraft = ParserReport & {
  aiOutput: string
  aiSources: AiSource[]
}

type ReviewQueue = "pending-user" | "pending-ai"

type AiReviewRequest = {
  generation: number
  source: ParserReportClientSource
  reportId: string
  pending: boolean
}

type ReviewSaveRequest = {
  generation: number
  pending: boolean
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function storedAiSources(metadata: Record<string, unknown>) {
  return Array.isArray(metadata.aiSources)
    ? metadata.aiSources.flatMap((value) => {
        const source = asRecord(value)
        const url = typeof source.url === "string" ? source.url.trim() : ""
        if (!url) return []
        return [{
          url,
          title: typeof source.title === "string" ? source.title : undefined,
        }]
      })
    : []
}

function vesselName(report: ParserReport) {
  const candidates = [
    asRecord(report.metadata.draft),
    asRecord(report.metadata.guesses),
    asRecord(report.metadata.worksheet),
  ]
  for (const candidate of candidates) {
    const value = String(candidate.vesselName || "").trim()
    if (value) return value.toUpperCase()
  }

  return report.rawText
    .split(/[\n/]/)[0]
    ?.replace(/^\s*(?:vessel|mv|mt)\s*[:=-]?\s*/i, "")
    .trim()
    .toUpperCase() || "UNNAMED VESSEL"
}

function aiFields(report: ReportDraft, source: ParserReportClientSource) {
  if (source === "spc") return asRecord(report.metadata.draft)
  return {
    ...asRecord(report.metadata.guesses),
    ...asRecord(report.metadata.worksheet),
  }
}

function confirmedReviewSave(report: ParserReport, draft: ReportDraft, stage: "pending-ai" | "complete") {
  const normalized = (value: string, maximum: number) => value.replace(/\r\n?/g, "\n").trim().slice(0, maximum)
  return report.id === draft.id
    && typeof report.updatedAt === "string" && Boolean(report.updatedAt) && report.updatedAt !== draft.updatedAt
    && report.correctedOutput === normalized(draft.correctedOutput, 20_000)
    && report.note === normalized(draft.note, 2_000)
    && typeof report.rawText === "string" && typeof report.parserOutput === "string"
    && asRecord(report.metadata).aiReviewState === stage
}

export function ParserReportReviewPanel({
  source,
  canEdit,
}: {
  source: ParserReportClientSource
  canEdit: boolean
}) {
  return <ParserReportReviewSession key={source} source={source} canEdit={canEdit} />
}

function ParserReportReviewSession({
  source,
  canEdit,
}: {
  source: ParserReportClientSource
  canEdit: boolean
}) {
  const [pendingAiReports, setPendingAiReports] = useState<ParserReport[]>([])
  const [readyForUserReports, setReadyForUserReports] = useState<ParserReport[]>([])
  const [draft, setDraft] = useState<ReportDraft | null>(null)
  const [draftQueue, setDraftQueue] = useState<ReviewQueue | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const [saving, setSaving] = useState(false)
  const [aiLoading, setAiLoading] = useState(false)
  const [message, setMessage] = useState("")
  const [messageType, setMessageType] = useState<"success" | "error">("success")
  const draftGenerationRef = useRef(0)
  const aiRequestRef = useRef<AiReviewRequest | null>(null)
  const saveRequestRef = useRef<ReviewSaveRequest | null>(null)
  const listRequestGenerationRef = useRef(0)

  const invalidateAiReview = useCallback(() => {
    draftGenerationRef.current += 1
    aiRequestRef.current = null
    setAiLoading(false)
  }, [])

  useEffect(() => () => {
    draftGenerationRef.current += 1
    aiRequestRef.current = null
    saveRequestRef.current = null
    listRequestGenerationRef.current += 1
  }, [])

  const loadReports = useCallback(async () => {
    if (saveRequestRef.current?.pending) return
    const generation = ++listRequestGenerationRef.current
    const isCurrent = () => listRequestGenerationRef.current === generation
    setLoading(true)
    setLoadFailed(false)
    setMessage("")
    try {
      const response = await fetchParserReportResponse(
        `/api/parser-reports?source=${source}`,
        { cache: "no-store" },
      )
      const data = (await response.json().catch(() => ({}))) as {
        pendingAiReports?: ParserReport[]
        readyForUserReports?: ParserReport[]
        message?: string
      }
      if (!isCurrent()) return
      if (!response.ok) throw new Error(data.message || "Failed to load parser reports.")
      setPendingAiReports(data.pendingAiReports || [])
      setReadyForUserReports(data.readyForUserReports || [])
    } catch (error) {
      if (!isCurrent()) return
      setLoadFailed(true)
      setMessageType("error")
      setMessage(
        error instanceof Error && error.message !== "Failed to fetch"
          ? error.message
          : "Could not load parser reports. Check the connection and retry.",
      )
    } finally {
      if (isCurrent()) setLoading(false)
    }
  }, [source])

  useEffect(() => {
    const initialLoad = window.setTimeout(() => void loadReports(), 0)
    return () => window.clearTimeout(initialLoad)
  }, [loadReports])

  function openReport(report: ParserReport, queue: ReviewQueue) {
    if (saveRequestRef.current?.pending) return
    invalidateAiReview()
    const aiOutput = typeof report.metadata.aiFixOutput === "string"
      ? report.metadata.aiFixOutput.trim()
      : ""
    setDraft({
      ...report,
      correctedOutput: report.correctedOutput.trim() || report.parserOutput,
      aiOutput,
      aiSources: storedAiSources(report.metadata),
    })
    setDraftQueue(queue)
    setMessage("")
  }

  function closeDraft() {
    if (saveRequestRef.current?.pending) return
    invalidateAiReview()
    setDraft(null)
    setDraftQueue(null)
  }

  function updateDraftField(field: "correctedOutput" | "note", value: string) {
    if (saveRequestRef.current?.pending) return
    invalidateAiReview()
    setDraft((current) => current ? { ...current, [field]: value } : current)
  }

  async function submitForAiReview() {
    if (!draft || draftQueue !== "pending-user" || !draft.correctedOutput.trim() || saveRequestRef.current?.pending || !canEdit) return
    invalidateAiReview()
    listRequestGenerationRef.current += 1
    setLoading(false)
    const request: ReviewSaveRequest = { generation: draftGenerationRef.current, pending: true }
    saveRequestRef.current = request
    const isCurrent = () => saveRequestRef.current === request && draftGenerationRef.current === request.generation
    setSaving(true)
    setMessage("")
    try {
      const response = await fetchParserReportResponse("/api/parser-reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "submit-ai",
          source,
          id: draft.id,
          expectedUpdatedAt: draft.updatedAt,
          correctedOutput: draft.correctedOutput,
          note: draft.note,
        }),
      }, 20_000)
      const data = (await response.json().catch(() => ({}))) as {
        report?: ParserReport
        success?: boolean
        message?: string
      }
      if (!isCurrent()) return
      if (!response.ok) throw new Error(data.message || "Failed to pass the report to AI review.")
      const queuedReport = data.report
      if (data.success !== true || !queuedReport || !confirmedReviewSave(queuedReport, draft, "pending-ai")) {
        throw new Error("The save could not be confirmed. Your draft has been kept; refresh the reports before trying again.")
      }
      setReadyForUserReports((current) => current.filter((report) => report.id !== draft.id))
      setPendingAiReports((current) => [
        queuedReport,
        ...current.filter((report) => report.id !== draft.id),
      ])
      request.pending = false
      setSaving(false)
      closeDraft()
      setMessageType("success")
      setMessage("Correction saved and passed to AI review.")
      notifyParserReportCountChanged(source)
    } catch (error) {
      if (!isCurrent()) return
      setMessageType("error")
      setMessage(error instanceof Error ? error.message : "Failed to pass the report to AI review.")
    } finally {
      if (isCurrent()) {
        request.pending = false
        setSaving(false)
      }
    }
  }

  async function runAiReview() {
    if (!draft || aiRequestRef.current?.pending || saveRequestRef.current?.pending || !canEdit) return
    const request: AiReviewRequest = {
      generation: draftGenerationRef.current,
      source,
      reportId: draft.id,
      pending: true,
    }
    aiRequestRef.current = request
    const isCurrent = () => aiRequestRef.current === request &&
      draftGenerationRef.current === request.generation
    setAiLoading(true)
    setMessage("")
    try {
      const response = await fetch("/api/parser-ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: request.source,
          context: draft.context || "new-enquiry",
          rawText: draft.rawText,
          parserOutput: draft.parserOutput,
          currentOutput: draft.correctedOutput,
          fields: aiFields(draft, source),
          manualVlsfoMaxRemarks: Array.isArray(draft.metadata.manualVlsfoMaxRemarks)
            ? draft.metadata.manualVlsfoMaxRemarks
            : [],
        }),
      })
      const data = (await response.json().catch(() => ({}))) as {
        correctedOutput?: string
        imoSources?: AiSource[]
        message?: string
      }
      if (!isCurrent()) return
      if (!response.ok || !data.correctedOutput) {
        throw new Error(data.message || "AI review failed.")
      }
      setDraft((current) => current && current.id === request.reportId && isCurrent() ? {
        ...current,
        aiOutput: data.correctedOutput || "",
        aiSources: (data.imoSources || []).filter((item) => item?.url),
      } : current)
    } catch (error) {
      if (!isCurrent()) return
      setMessageType("error")
      setMessage(error instanceof Error ? error.message : "AI review failed.")
    } finally {
      if (isCurrent()) {
        request.pending = false
        setAiLoading(false)
      }
    }
  }

  async function completeAiReview() {
    if (!draft || draftQueue !== "pending-ai" || saveRequestRef.current?.pending || !canEdit) return
    invalidateAiReview()
    listRequestGenerationRef.current += 1
    setLoading(false)
    const request: ReviewSaveRequest = { generation: draftGenerationRef.current, pending: true }
    saveRequestRef.current = request
    const isCurrent = () => saveRequestRef.current === request && draftGenerationRef.current === request.generation
    setSaving(true)
    setMessage("")
    try {
      const response = await fetchParserReportResponse("/api/parser-reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "review",
          source,
          id: draft.id,
          expectedUpdatedAt: draft.updatedAt,
          aiOutput: draft.aiOutput,
          aiSources: draft.aiSources,
          correctedOutput: draft.correctedOutput,
          note: draft.note,
        }),
      }, 20_000)
      const data = (await response.json().catch(() => ({}))) as { success?: boolean; report?: ParserReport; message?: string }
      if (!isCurrent()) return
      if (!response.ok) throw new Error(data.message || "Failed to complete AI review.")
      if (data.success !== true || !data.report || !confirmedReviewSave(data.report, draft, "complete")) {
        throw new Error("The save could not be confirmed. Your draft has been kept; refresh the reports before trying again.")
      }
      setPendingAiReports((current) => current.filter((report) => report.id !== draft.id))
      request.pending = false
      setSaving(false)
      closeDraft()
      setMessageType("success")
      setMessage("AI review completed and case closed.")
      notifyParserReportCountChanged(source)
    } catch (error) {
      if (!isCurrent()) return
      setMessageType("error")
      setMessage(error instanceof Error ? error.message : "Failed to complete AI review.")
    } finally {
      if (isCurrent()) {
        request.pending = false
        setSaving(false)
      }
    }
  }

  return (
    <>
      {message && !draft ? (
        <div className={`spc-alert${messageType === "error" ? " is-error" : ""}`} role={messageType === "error" ? "alert" : "status"}>
          {message}
        </div>
      ) : null}
      <section className="spc-panel spc-parser-report-page">
        <div className="spc-panel-header">
          <h2>Parser Report</h2>
          <button type="button" onClick={() => void loadReports()} disabled={loading}>
            {loading ? "Loading..." : "Refresh"}
          </button>
        </div>
        <div className="spc-parser-report-queues">
          {loading ? <p className="spc-empty">Loading reports...</p> : null}
          {!loading && !loadFailed ? (
            <>
              <section className="spc-parser-report-queue" aria-labelledby="ready-parser-reports">
                <div className="spc-parser-report-queue-header">
                  <h3 id="ready-parser-reports">Pending Your Review</h3>
                  <span>{readyForUserReports.length}</span>
                </div>
                <div className="spc-parser-report-list">
                  {readyForUserReports.map((report) => (
                    <button
                      key={report.id}
                      type="button"
                      onClick={() => openReport(report, "pending-user")}
                    >
                      {vesselName(report)}
                    </button>
                  ))}
                  {readyForUserReports.length === 0 ? <p className="spc-empty">No reports pending your review.</p> : null}
                </div>
              </section>
              <section className="spc-parser-report-queue" aria-labelledby="pending-parser-reports">
                <div className="spc-parser-report-queue-header">
                  <h3 id="pending-parser-reports">Pending AI Review</h3>
                  <span>{pendingAiReports.length}</span>
                </div>
                <div className="spc-parser-report-list">
                  {pendingAiReports.map((report) => (
                    <button key={report.id} type="button" onClick={() => openReport(report, "pending-ai")}>
                      {vesselName(report)}
                    </button>
                  ))}
                  {pendingAiReports.length === 0 ? <p className="spc-empty">No reports pending AI review.</p> : null}
                </div>
              </section>
            </>
          ) : null}
          {!loading && loadFailed ? (
            <div className="spc-parser-report-list">
              <button type="button" onClick={() => void loadReports()}>Retry loading reports</button>
            </div>
          ) : null}
        </div>
      </section>

      {draft ? (
        <div className="spc-dialog-backdrop" role="dialog" aria-modal="true" aria-labelledby="parser-review-title">
          <div className="spc-dialog spc-parser-report-dialog">
            <div className="spc-dialog-header">
              <h2 id="parser-review-title">
                {draftQueue === "pending-user" ? "Review Parser Report" : "Complete AI Parser Review"}
              </h2>
              <button type="button" onClick={closeDraft} disabled={saving} aria-label="Close report dialog">×</button>
            </div>
            <div className="spc-parser-report-body">
              {message ? (
                <div className={`spc-alert${messageType === "error" ? " is-error" : ""}`} role={messageType === "error" ? "alert" : "status"}>
                  {message}
                </div>
              ) : null}
              <label><span>Raw Enquiry</span><textarea value={draft.rawText} readOnly /></label>
              <label><span>Parser Output</span><textarea value={draft.parserOutput} readOnly /></label>
              {draft.aiOutput ? <label><span>AI Fix</span><textarea value={draft.aiOutput} readOnly /></label> : null}
              {draft.aiSources.length ? (
                <p className="spc-parser-report-status">
                  IMO source: <a href={draft.aiSources[0].url} target="_blank" rel="noreferrer">{draft.aiSources[0].title || draft.aiSources[0].url}</a>
                </p>
              ) : null}
              <label>
                <span>Correct Version</span>
                <textarea
                  value={draft.correctedOutput}
                  readOnly={draftQueue === "pending-ai" || saving || !canEdit}
                  onChange={(event) => updateDraftField("correctedOutput", event.target.value)}
                />
              </label>
              <label><span>Note</span><input value={draft.note} readOnly={saving || !canEdit} onChange={(event) => updateDraftField("note", event.target.value)} placeholder="Optional" /></label>
            </div>
            <div className="spc-dialog-actions">
              <button type="button" onClick={closeDraft} disabled={saving}>Cancel</button>
              {draftQueue === "pending-user" ? (
                <button type="button" className="is-primary" onClick={() => void submitForAiReview()} disabled={!canEdit || !draft.correctedOutput.trim() || saving}>
                  {saving ? "Saving..." : "Pass To AI Review"}
                </button>
              ) : (
                <>
                  <button type="button" className="is-primary" onClick={() => void runAiReview()} disabled={!canEdit || aiLoading || saving}>{aiLoading ? "Reviewing..." : "AI Fix"}</button>
                  <button type="button" className="is-primary" onClick={() => void completeAiReview()} disabled={!canEdit || saving}>
                    {saving ? "Closing..." : "Complete AI Review"}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}
