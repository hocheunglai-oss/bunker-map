"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { SpcShell } from "@/components/SpcShell"
import { useSpcAuth } from "@/lib/useSpcAuth"
import { canAccessSpcPage } from "@/lib/spcPages"

type AuditOperation = "INSERT" | "UPDATE" | "DELETE"

type AuditLogRecord = {
  id: string
  occurredAt: string
  actorId: string | null
  actorName: string | null
  displayOperation: AuditOperation
  pageId: string
  pageLabel: string
  recordLabel: string
  summary: string
  details: string[]
  undoOfLogId: string | null
  undoneAt: string | null
  undoable: boolean
}

type AuditResponse = {
  logs: AuditLogRecord[]
  pages: Array<{ id: string; label: string }>
  users: Array<{ value: string; label: string }>
  message?: string
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value))
}

export default function SpcAuditLogPage() {
  const router = useRouter()
  const { loading: authLoading, authenticated, permissions } = useSpcAuth()
  const [logs, setLogs] = useState<AuditLogRecord[]>([])
  const [pages, setPages] = useState<Array<{ id: string; label: string }>>([])
  const [users, setUsers] = useState<Array<{ value: string; label: string }>>([])
  const [pageId, setPageId] = useState("all")
  const [operation, setOperation] = useState("all")
  const [actor, setActor] = useState("all")
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [undoingId, setUndoingId] = useState<string | null>(null)
  const [message, setMessage] = useState("")

  const canView = canAccessSpcPage(permissions, "spc-audit-log", "view")
  const canEdit = canAccessSpcPage(permissions, "spc-audit-log", "edit")
  const selectedLog = useMemo(
    () => logs.find((log) => log.id === selectedId) || logs[0] || null,
    [logs, selectedId],
  )

  const loadLogs = useCallback(async () => {
    if (!authenticated || !canView) return
    setLoading(true)
    setMessage("")

    const params = new URLSearchParams({ limit: "150" })
    if (pageId !== "all") params.set("page", pageId)
    if (operation !== "all") params.set("operation", operation)
    if (actor !== "all") params.set("actor", actor)

    try {
      const response = await fetch(`/api/spc/audit-logs?${params.toString()}`, { cache: "no-store" })
      const data = (await response.json()) as AuditResponse
      if (!response.ok) {
        setMessage(data.message || "Failed to load SPC audit logs.")
        return
      }
      setLogs(data.logs || [])
      setPages(data.pages || [])
      setUsers(data.users || [])
      setSelectedId((current) =>
        current && data.logs.some((log) => log.id === current) ? current : data.logs[0]?.id || null,
      )
    } catch {
      setMessage("Failed to load SPC audit logs.")
    } finally {
      setLoading(false)
    }
  }, [actor, authenticated, canView, operation, pageId])

  async function undoSelected() {
    if (!selectedLog || !canEdit || !selectedLog.undoable) return
    if (!window.confirm(`Undo this change?\n\n${selectedLog.summary}`)) return
    setUndoingId(selectedLog.id)
    setMessage("")
    try {
      const response = await fetch("/api/spc/audit-logs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "undo", id: selectedLog.id }),
      })
      const data = (await response.json().catch(() => ({}))) as { message?: string }
      if (!response.ok) {
        setMessage(data.message || "Failed to undo SPC audit log.")
        return
      }
      await loadLogs()
    } catch {
      setMessage("Failed to undo SPC audit log.")
    } finally {
      setUndoingId(null)
    }
  }

  useEffect(() => {
    document.title = "SPC Audit Log"
  }, [])

  useEffect(() => {
    if (!authLoading && (!authenticated || !canView)) router.replace("/spc")
  }, [authLoading, authenticated, canView, router])

  useEffect(() => {
    void loadLogs()
  }, [loadLogs])

  if (authLoading || !authenticated || !canView) {
    return <div className="spc-loading">Loading...</div>
  }

  return (
    <SpcShell title="SPC Audit Log">
      <div className="spc-page-heading">
        <div>
          <h1>Audit Log</h1>
          <p>{logs.length} SPC user actions</p>
        </div>
      </div>

      {message ? <div className="spc-alert is-error">{message}</div> : null}

      <section className="spc-panel">
        <div className="spc-panel-header spc-filter-header">
          <h2>Filters</h2>
          <button type="button" onClick={() => void loadLogs()} disabled={loading}>
            {loading ? "Refreshing..." : "Refresh"}
          </button>
        </div>
        <div className="spc-filter-grid">
          <label>
            <span>Page</span>
            <select value={pageId} onChange={(event) => setPageId(event.target.value)}>
              <option value="all">All Pages</option>
              {pages.map((page) => (
                <option key={page.id} value={page.id}>{page.label}</option>
              ))}
            </select>
          </label>
          <label>
            <span>Action</span>
            <select value={operation} onChange={(event) => setOperation(event.target.value)}>
              <option value="all">All Actions</option>
              <option value="INSERT">Created</option>
              <option value="UPDATE">Updated</option>
              <option value="DELETE">Deleted</option>
            </select>
          </label>
          <label>
            <span>User</span>
            <select value={actor} onChange={(event) => setActor(event.target.value)}>
              <option value="all">All Users</option>
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
                onClick={() => setSelectedId(log.id)}
                className={selectedLog?.id === log.id ? "is-active" : ""}
              >
                <strong>{log.summary}</strong>
                <span>{log.pageLabel} · {log.actorName || log.actorId || "Unknown user"}</span>
                <small>{formatDate(log.occurredAt)}</small>
              </button>
            ))}
            {!loading && logs.length === 0 ? <p className="spc-empty">No SPC audit records found.</p> : null}
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
              <ul>
                {selectedLog.details.map((detail) => (
                  <li key={detail}>{detail}</li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="spc-empty">Select a record.</p>
          )}
        </section>
      </div>
    </SpcShell>
  )
}
