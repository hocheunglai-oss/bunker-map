"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { SpcShell } from "@/components/SpcShell"
import { useSpcAuth } from "@/lib/useSpcAuth"
import { canAccessSpcPage } from "@/lib/spcPages"
import { useAuditBrowsing } from "@/lib/useAuditBrowsing"

const browsingButtonStyle: React.CSSProperties = {
  minHeight: "36px", padding: "8px 12px", borderRadius: "999px",
  border: "1px solid var(--fc-admin-button-border)", background: "var(--fc-admin-button-bg)",
  color: "var(--fc-admin-button-text)", fontSize: "12px", fontWeight: 800,
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value))
}

export default function SpcAuditLogPage() {
  const router = useRouter()
  const { loading: authLoading, authenticated, permissions, actorKey, username, role } = useSpcAuth()
  const [pageId, setPageId] = useState("all")
  const [actor, setActor] = useState("all")
  const [actorLabel, setActorLabel] = useState("")
  const [undoing, setUndoing] = useState<{ key: string; id: string } | null>(null)
  const [notice, setNotice] = useState<{ key: string; message: string } | null>(null)

  const canView = canAccessSpcPage(permissions, "spc-audit-log", "view")
  const canEdit = canAccessSpcPage(permissions, "spc-audit-log", "edit")
  const owner = JSON.stringify([actorKey, username, role, canView, canEdit])
  const noticeKey = JSON.stringify([owner, pageId, actor])
  const undoingId = undoing?.key === noticeKey ? undoing.id : null
  const browsing = useAuditBrowsing({ endpoint: "/api/spc/audit-logs", owner, enabled: !authLoading && authenticated && canView, page: pageId, actor })
  const { logs, pages, users, selectedLog, loading, detailLoadingId, pageInfo } = browsing
  const message = browsing.message || (notice?.key === noticeKey ? notice.message : "")

  async function undoSelected() {
    if (!selectedLog || !canEdit || !selectedLog.undoable) return
    if (!window.confirm(`Undo this change?\n\n${selectedLog.summary}`)) return
    const logId = selectedLog.id
    const token = browsing.token()
    setUndoing({ key: noticeKey, id: logId })
    setNotice(null)
    try {
      const response = await fetch("/api/spc/audit-logs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "undo", id: selectedLog.id }),
      })
      const data = (await response.json().catch(() => ({}))) as { message?: string }
      if (!browsing.isCurrent(token)) return
      if (!response.ok) {
        setNotice({ key: noticeKey, message: data.message || "Failed to undo SPC audit log." })
        return
      }
      setNotice({ key: noticeKey, message: "Undo applied." })
      await browsing.refresh()
    } catch {
      if (browsing.isCurrent(token)) setNotice({ key: noticeKey, message: "Failed to undo SPC audit log." })
    } finally {
      setUndoing((current) => current?.key === noticeKey && current.id === logId ? null : current)
    }
  }

  useEffect(() => {
    document.title = "SPC Audit Log"
  }, [])

  useEffect(() => {
    if (!authLoading && (!authenticated || !canView)) router.replace("/spc")
  }, [authLoading, authenticated, canView, router])

  if (authLoading || !authenticated || !canView) {
    return <div className="spc-loading">Loading...</div>
  }

  return (
    <SpcShell title="SPC Audit Log">
      {message ? <div className={`spc-alert${browsing.message || notice?.message !== "Undo applied." ? " is-error" : ""}`} role="status">{message} {browsing.message ? <button type="button" style={browsingButtonStyle} disabled={loading} onClick={browsing.retry}>Retry</button> : null}</div> : null}

      <section className="spc-panel">
        <div className="spc-panel-header spc-filter-header">
          <h2>Filters</h2>
          <button type="button" onClick={() => { setNotice(null); void browsing.refresh() }} disabled={loading}>
            {loading ? "Refreshing..." : "Refresh"}
          </button>
        </div>
        <div className="spc-filter-grid">
          <label>
            <span>Page</span>
            <select aria-label="Page" value={pageId} onChange={(event) => setPageId(event.target.value)}>
              <option value="all">All Pages</option>
              {pageId !== "all" && !pages.some((page) => page.id === pageId) ? <option value={pageId}>{pageId}</option> : null}
              {pages.map((page) => (
                <option key={page.id} value={page.id}>{page.label}</option>
              ))}
            </select>
          </label>
          <label>
            <span>User</span>
            <select aria-label="User" value={actor} onChange={(event) => { setActor(event.target.value); setActorLabel(event.target.selectedOptions[0]?.text || event.target.value) }}>
              <option value="all">All Users</option>
              {actor !== "all" && !users.some((user) => user.value === actor) ? <option value={actor}>{actorLabel || actor}</option> : null}
              {users.map((user) => (
                <option key={user.value} value={user.value}>{user.label}</option>
              ))}
            </select>
          </label>
        </div>
      </section>

      <div className="spc-audit-grid">
        <section className="spc-panel">
          <div className="spc-audit-list">
            {logs.map((log) => (
              <button
                key={log.id}
                type="button"
                onClick={() => browsing.select(log.id)}
                className={selectedLog?.id === log.id ? "is-active" : ""}
              >
                <strong>{log.summary}</strong>
                <span>{log.pageLabel} · {log.actorName || log.actorId || "Unknown user"}</span>
                <small>{formatDate(log.occurredAt)}</small>
              </button>
            ))}
            {loading && logs.length === 0 ? <p className="spc-empty">Loading SPC audit records...</p> : null}
            {!loading && logs.length === 0 && pageInfo?.state === "exhausted" ? <p className="spc-empty">No SPC audit records match these filters.</p> : null}
          </div>
          <div aria-live="polite" style={{ display: "grid", gap: "10px", padding: "12px", overflowWrap: "anywhere" }}>
            <small>{logs.length} on this page. Live history; Refresh checks for new changes.</small>
            {pageInfo?.state === "scan-pending" ? <p style={{ margin: 0 }}>More history needs to be checked. Continue searching for matching changes.</p> : null}
            {pageInfo?.state === "exhausted" && logs.length > 0 ? <small>End of matching history.</small> : null}
            <small>User options are from the current results, not a complete staff directory.</small>
            {browsing.historyTruncated ? <small>Only the last 20 pages are kept for Previous. Refresh to restart from the newest changes.</small> : null}
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
              <button type="button" style={browsingButtonStyle} disabled={loading || browsing.index < 1} onClick={browsing.previous}>Previous</button>
              <button type="button" style={browsingButtonStyle} disabled={loading || !pageInfo?.nextCursor} onClick={browsing.older}>{pageInfo?.state === "scan-pending" ? "Continue searching" : "Load older"}</button>
            </div>
          </div>
        </section>

        <section className="spc-panel">
          <div className="spc-panel-header">
            <h2>Details</h2>
            <button
              type="button"
              onClick={() => void undoSelected()}
              disabled={
                !selectedLog ||
                loading ||
                !canEdit ||
                !selectedLog.undoable ||
                Boolean(selectedLog.undoOfLogId) ||
                Boolean(selectedLog.undoneAt) ||
                undoingId === selectedLog.id
              }
            >
              {undoingId === selectedLog?.id ? "Undoing..." : "Undo"}
            </button>
          </div>
          {selectedLog ? (
            <div className="spc-audit-detail">
              <h3>{selectedLog.summary}</h3>
              <p>{selectedLog.pageLabel} · {selectedLog.displayOperation} · {formatDate(selectedLog.occurredAt)}</p>
              {detailLoadingId === selectedLog.id ? (
                <p className="spc-empty">Loading details...</p>
              ) : (
                <ul>
                  {selectedLog.details.map((detail) => (
                    <li key={detail}>{detail}</li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            <p className="spc-empty">Select a record.</p>
          )}
        </section>
      </div>
    </SpcShell>
  )
}
