"use client"

import { useCallback, useEffect, useState } from "react"
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
}

type AiSource = { title?: string; url: string }
type ReviewQueue = "pending-ai" | "ready-user"

type ReportDraft = ParserReport & {
  aiOutput: string
  aiSources: AiSource[]
  queue: ReviewQueue
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

export function ParserReportReviewPanel({
  source,
  canEdit,
}: {
  source: ParserReportClientSource
  canEdit: boolean
}) {
  const [pendingAiReports, setPendingAiReports] = useState<ParserReport[]>([])
  const [readyForUserReports, setReadyForUserReports] = useState<ParserReport[]>([])
  const [draft, setDraft] = useState<ReportDraft | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const [saving, setSaving] = useState(false)
  const [acknowledgingId, setAcknowledgingId] = useState("")
  const [aiLoading, setAiLoading] = useState(false)
  const [message, setMessage] = useState("")
  const [messageType, setMessageType] = useState<"success" | "error">("success")

  const loadReports = useCallback(async () => {
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
      if (!response.ok) throw new Error(data.message || "Failed to load parser reports.")
      setPendingAiReports(data.pendingAiReports || [])
      setReadyForUserReports(data.readyForUserReports || [])
    } catch (error) {
      setLoadFailed(true)
      setMessageType("error")
      setMessage(
        error instanceof Error && error.message !== "Failed to fetch"
          ? error.message
          : "Could not load parser reports. Check the connection and retry.",
      )
    } finally {
      setLoading(false)
    }
  }, [source])

  useEffect(() => {
    const initialLoad = window.setTimeout(() => void loadReports(), 0)
    return () => window.clearTimeout(initialLoad)
  }, [loadReports])

  async function acknowledgeReadyReport(report: ParserReport) {
    if (!canEdit || acknowledgingId) return

    setAcknowledgingId(report.id)
    try {
      const response = await fetchParserReportResponse("/api/parser-reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "acknowledge",
          source,
          id: report.id,
          correctedOutput: report.correctedOutput,
          note: report.note,
        }),
      }, 20_000)
      const data = (await response.json().catch(() => ({}))) as { message?: string }
      if (!response.ok) throw new Error(data.message || "Failed to mark the report as reviewed.")

      setReadyForUserReports((current) => current.filter((item) => item.id !== report.id))
      notifyParserReportCountChanged(source)
    } catch (error) {
      setMessageType("error")
      setMessage(error instanceof Error ? error.message : "Failed to mark the report as reviewed.")
    } finally {
      setAcknowledgingId("")
    }
  }

  function openReport(report: ParserReport, queue: ReviewQueue) {
    const aiOutput = typeof report.metadata.aiFixOutput === "string"
      ? report.metadata.aiFixOutput.trim()
      : ""
    setDraft({
      ...report,
      correctedOutput: report.correctedOutput.trim() || report.parserOutput,
      aiOutput,
      aiSources: storedAiSources(report.metadata),
      queue,
    })
    setMessage("")
    if (queue === "ready-user") void acknowledgeReadyReport(report)
  }

  async function runAiReview() {
    if (!draft || draft.queue !== "pending-ai" || aiLoading) return
    setAiLoading(true)
    setMessage("")
    try {
      const response = await fetch("/api/parser-ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source,
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
      if (!response.ok || !data.correctedOutput) {
        throw new Error(data.message || "AI review failed.")
      }
      setDraft((current) => current ? {
        ...current,
        correctedOutput: data.correctedOutput || current.correctedOutput,
        aiOutput: data.correctedOutput || "",
        aiSources: (data.imoSources || []).filter((item) => item?.url),
      } : current)
    } catch (error) {
      setMessageType("error")
      setMessage(error instanceof Error ? error.message : "AI review failed.")
    } finally {
      setAiLoading(false)
    }
  }

  async function saveReview() {
    if (!draft || draft.queue !== "pending-ai" || !draft.correctedOutput.trim() || saving || !canEdit) return
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
          aiOutput: draft.aiOutput,
          aiSources: draft.aiSources,
          correctedOutput: draft.correctedOutput,
          note: draft.note,
        }),
      }, 20_000)
      const data = (await response.json().catch(() => ({}))) as { message?: string }
      if (!response.ok) throw new Error(data.message || "Failed to save parser review.")
      setPendingAiReports((current) => current.filter((report) => report.id !== draft.id))
      setReadyForUserReports((current) => [{
        ...draft,
        correctedOutput: draft.correctedOutput.trim(),
        metadata: {
          ...draft.metadata,
          pendingReview: false,
          pendingUserReview: true,
          aiReviewState: "ready",
        },
      }, ...current.filter((report) => report.id !== draft.id)])
      setDraft(null)
      setMessageType("success")
      setMessage("AI review completed and is ready for your review.")
      notifyParserReportCountChanged(source)
    } catch (error) {
      setMessageType("error")
      setMessage(error instanceof Error ? error.message : "Failed to save parser review.")
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      {message ? (
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
                      onClick={() => openReport(report, "ready-user")}
                      disabled={Boolean(acknowledgingId)}
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
                {draft.queue === "ready-user" ? "Completed Parser Fix" : "Complete AI Parser Review"}
              </h2>
              <button type="button" onClick={() => setDraft(null)} disabled={saving} aria-label="Close report dialog">×</button>
            </div>
            <div className="spc-parser-report-body">
              <label><span>Raw Enquiry</span><textarea value={draft.rawText} readOnly /></label>
              <label><span>Parser Output</span><textarea value={draft.parserOutput} readOnly /></label>
              {draft.aiOutput ? <label><span>AI Fix</span><textarea value={draft.aiOutput} readOnly /></label> : null}
              {draft.aiSources.length ? (
                <p className="spc-parser-report-status">
                  IMO source: <a href={draft.aiSources[0].url} target="_blank" rel="noreferrer">{draft.aiSources[0].title || draft.aiSources[0].url}</a>
                </p>
              ) : null}
              <label><span>Correct Version</span><textarea value={draft.correctedOutput} readOnly={draft.queue === "ready-user"} onChange={(event) => setDraft((current) => current ? { ...current, correctedOutput: event.target.value } : current)} /></label>
              <label><span>Note</span><input value={draft.note} readOnly={draft.queue === "ready-user"} onChange={(event) => setDraft((current) => current ? { ...current, note: event.target.value } : current)} placeholder="Optional" /></label>
            </div>
            <div className="spc-dialog-actions">
              {draft.queue === "ready-user" ? (
                <button type="button" onClick={() => setDraft(null)}>Close</button>
              ) : (
                <>
                  <button type="button" onClick={() => setDraft(null)} disabled={saving}>Cancel</button>
                  <button type="button" className="is-primary" onClick={() => void runAiReview()} disabled={aiLoading || saving}>{aiLoading ? "Reviewing..." : "AI Fix"}</button>
                  <button type="button" className="is-primary" onClick={() => void saveReview()} disabled={!canEdit || !draft.correctedOutput.trim() || saving}>
                    {saving ? "Saving..." : "Mark Ready For Review"}
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
