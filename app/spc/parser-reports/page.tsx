"use client"

import { useCallback, useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { SpcShell } from "@/components/SpcShell"
import { canAccessSpcPage } from "@/lib/spcPages"
import { useSpcAuth } from "@/lib/useSpcAuth"

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

type ReportDraft = ParserReport & {
  aiOutput: string
  aiSources: Array<{ title?: string; url: string }>
}

function vesselName(report: ParserReport) {
  const draft = report.metadata?.draft
  if (draft && typeof draft === "object" && "vesselName" in draft) {
    const value = String((draft as { vesselName?: unknown }).vesselName || "").trim()
    if (value) return value.toUpperCase()
  }
  return report.rawText.split(/[\n/]/)[0]?.replace(/^\s*(?:vessel|mv|mt)\s*[:=-]?\s*/i, "").trim().toUpperCase() || "UNNAMED VESSEL"
}

export default function SpcParserReportsPage() {
  const router = useRouter()
  const { loading: authLoading, authenticated, permissions } = useSpcAuth()
  const [reports, setReports] = useState<ParserReport[]>([])
  const [draft, setDraft] = useState<ReportDraft | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [aiLoading, setAiLoading] = useState(false)
  const [message, setMessage] = useState("")
  const canView = canAccessSpcPage(permissions, "spc-parser-reports", "view")
  const canEdit = canAccessSpcPage(permissions, "spc-parser-reports", "edit")

  const loadReports = useCallback(async () => {
    if (!authenticated || !canView) return
    setLoading(true)
    try {
      const response = await fetch("/api/parser-reports?source=spc", { cache: "no-store" })
      const data = (await response.json()) as { reports?: ParserReport[]; message?: string }
      if (!response.ok) throw new Error(data.message || "Failed to load parser reports.")
      setReports(data.reports || [])
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to load parser reports.")
    } finally {
      setLoading(false)
    }
  }, [authenticated, canView])

  useEffect(() => { document.title = "SPC Parser Report" }, [])
  useEffect(() => {
    if (!authLoading && (!authenticated || !canView)) router.replace("/spc")
  }, [authLoading, authenticated, canView, router])
  useEffect(() => { void loadReports() }, [loadReports])

  function openReport(report: ParserReport) {
    setDraft({ ...report, correctedOutput: report.parserOutput, aiOutput: "", aiSources: [] })
    setMessage("")
  }

  async function runAiReview() {
    if (!draft || aiLoading) return
    setAiLoading(true)
    setMessage("")
    try {
      const storedDraft = draft.metadata?.draft
      const fields = storedDraft && typeof storedDraft === "object" ? storedDraft : {}
      const response = await fetch("/api/parser-ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "spc",
          context: draft.context || "new-enquiry",
          rawText: draft.rawText,
          parserOutput: draft.parserOutput,
          currentOutput: draft.correctedOutput,
          fields,
          manualVlsfoMaxRemarks: Array.isArray(draft.metadata?.manualVlsfoMaxRemarks)
            ? draft.metadata.manualVlsfoMaxRemarks
            : [],
        }),
      })
      const data = (await response.json()) as {
        correctedOutput?: string
        imoSources?: Array<{ title?: string; url: string }>
        message?: string
      }
      if (!response.ok || !data.correctedOutput) throw new Error(data.message || "AI review failed.")
      setDraft((current) => current ? {
        ...current,
        correctedOutput: data.correctedOutput || current.correctedOutput,
        aiOutput: data.correctedOutput || "",
        aiSources: (data.imoSources || []).filter((source) => source?.url),
      } : current)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "AI review failed.")
    } finally {
      setAiLoading(false)
    }
  }

  async function saveReview() {
    if (!draft || !draft.correctedOutput.trim() || saving || !canEdit) return
    setSaving(true)
    setMessage("")
    try {
      const response = await fetch("/api/parser-reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "review",
          source: "spc",
          id: draft.id,
          correctedOutput: draft.correctedOutput,
          note: draft.note,
        }),
      })
      const data = (await response.json()) as { message?: string }
      if (!response.ok) throw new Error(data.message || "Failed to save parser review.")
      setReports((current) => current.filter((report) => report.id !== draft.id))
      setDraft(null)
      setMessage("Review saved.")
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to save parser review.")
    } finally {
      setSaving(false)
    }
  }

  if (authLoading || !authenticated || !canView) return <div className="spc-loading">Loading...</div>

  return (
    <SpcShell title="SPC Parser Report">
      {message ? <div className="spc-alert">{message}</div> : null}
      <section className="spc-panel spc-parser-report-page">
        <div className="spc-panel-header"><h2>Parser Report</h2></div>
        <div className="spc-parser-report-list">
          {loading ? <p className="spc-empty">Loading reports...</p> : reports.map((report) => (
            <button key={report.id} type="button" onClick={() => openReport(report)}>
              {vesselName(report)}
            </button>
          ))}
          {!loading && reports.length === 0 ? <p className="spc-empty">No parser reports awaiting review.</p> : null}
        </div>
      </section>

      {draft ? (
        <div className="spc-dialog-backdrop" role="dialog" aria-modal="true" aria-labelledby="spc-parser-review-title">
          <div className="spc-dialog spc-parser-report-dialog">
            <div className="spc-dialog-header">
              <h2 id="spc-parser-review-title">Report Parser Output</h2>
              <button type="button" onClick={() => setDraft(null)} disabled={saving} aria-label="Close report dialog">×</button>
            </div>
            <div className="spc-parser-report-body">
              <label><span>Raw Enquiry</span><textarea value={draft.rawText} readOnly /></label>
              <label><span>Parser Output</span><textarea value={draft.parserOutput} readOnly /></label>
              {draft.aiOutput ? <label><span>AI Fix</span><textarea value={draft.aiOutput} readOnly /></label> : null}
              {draft.aiSources.length ? <p className="spc-parser-report-status">IMO source: <a href={draft.aiSources[0].url} target="_blank" rel="noreferrer">{draft.aiSources[0].title || draft.aiSources[0].url}</a></p> : null}
              <label><span>Correct Version</span><textarea value={draft.correctedOutput} onChange={(event) => setDraft((current) => current ? { ...current, correctedOutput: event.target.value } : current)} /></label>
              <label><span>Note</span><input value={draft.note} onChange={(event) => setDraft((current) => current ? { ...current, note: event.target.value } : current)} placeholder="Optional" /></label>
            </div>
            <div className="spc-dialog-actions">
              <button type="button" onClick={() => setDraft(null)} disabled={saving}>Cancel</button>
              <button type="button" className="is-primary" onClick={() => void runAiReview()} disabled={aiLoading || saving}>{aiLoading ? "Reviewing..." : "AI Fix"}</button>
              <button type="button" className="is-primary" onClick={() => void saveReview()} disabled={!draft.correctedOutput.trim() || saving}>{saving ? "Saving..." : "Submit Report"}</button>
            </div>
          </div>
        </div>
      ) : null}
    </SpcShell>
  )
}
