"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { canAccessAdminPage, isAdminRole } from "@/lib/adminPages"
import { useSimpleAdminAuth } from "@/lib/useSimpleAdminAuth"

type AuditOperation = "INSERT" | "UPDATE" | "DELETE"

type AuditLogRecord = {
  id: string
  occurredAt: string
  actorId: string | null
  actorName: string | null
  operation: AuditOperation
  displayOperation: AuditOperation
  pageId: string
  pageLabel: string
  recordLabel: string
  summary: string
  details: string[]
  undoOfLogId: string | null
  undoneAt: string | null
}

type AuditPageOption = {
  id: string
  label: string
}

type AuditUserOption = {
  value: string
  label: string
}

type AuditResponse = {
  logs: AuditLogRecord[]
  pages: AuditPageOption[]
  users: AuditUserOption[]
  message?: string
}

const pageStyle: React.CSSProperties = {
  minHeight: "100vh",
  background: "var(--fc-admin-page-bg)",
  color: "var(--fc-admin-panel-text)",
  fontFamily: "var(--fc-admin-font)",
  padding: "18px",
}

const buttonStyle: React.CSSProperties = {
  minHeight: "34px",
  border: "1px solid var(--fc-admin-button-border)",
  borderRadius: "999px",
  background: "var(--fc-admin-button-bg)",
  color: "var(--fc-admin-button-text)",
  cursor: "pointer",
  fontSize: "12px",
  fontWeight: 800,
  padding: "8px 12px",
  boxShadow: "none",
}

const dangerButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  borderColor: "var(--fc-admin-danger-border)",
  background: "var(--fc-admin-danger-bg)",
  color: "var(--fc-admin-danger-text)",
}

const panelStyle: React.CSSProperties = {
  border: "1px solid var(--fc-admin-border)",
  borderRadius: "8px",
  background: "var(--fc-admin-panel-bg)",
  boxShadow: "0 12px 28px #0000000d",
  overflow: "hidden",
}

const sectionHeaderStyle: React.CSSProperties = {
  minHeight: "42px",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "10px",
  padding: "10px 12px",
  borderBottom: "1px solid var(--fc-admin-border-soft)",
  background: "var(--fc-admin-panel-soft-bg)",
}

const inputStyle: React.CSSProperties = {
  minHeight: "36px",
  width: "100%",
  border: "1px solid var(--fc-input-border)",
  borderRadius: "6px",
  background: "var(--fc-tool-input-bg)",
  color: "var(--fc-tool-input-text)",
  fontSize: "13px",
  outline: "none",
  padding: "0 10px",
}

const labelStyle: React.CSSProperties = {
  display: "grid",
  gap: "6px",
  color: "var(--fc-admin-muted)",
  fontSize: "11px",
  fontWeight: 900,
  textTransform: "uppercase",
}

const thStyle: React.CSSProperties = {
  padding: "9px 10px",
  color: "var(--fc-table-head-text)",
  fontSize: "11px",
  fontWeight: 900,
  textTransform: "uppercase",
  textAlign: "left",
  borderBottom: "1px solid var(--fc-admin-border)",
  background: "var(--fc-table-head-bg)",
  whiteSpace: "nowrap",
}

const tdStyle: React.CSSProperties = {
  padding: "10px",
  borderBottom: "1px solid var(--fc-admin-border-soft)",
  fontSize: "13px",
  verticalAlign: "middle",
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value))
}

function operationStyle(operation: AuditOperation): React.CSSProperties {
  const colors: Record<AuditOperation, { bg: string; text: string; border: string }> = {
    INSERT: { bg: "#e9f8ee", text: "#146b2f", border: "#b7dfc4" },
    UPDATE: { bg: "#fff6dd", text: "#765400", border: "#ead28a" },
    DELETE: { bg: "#fff0f0", text: "#9f1c27", border: "#efc1c5" },
  }
  const color = colors[operation]

  return {
    display: "inline-flex",
    alignItems: "center",
    minHeight: "24px",
    borderRadius: "999px",
    border: `1px solid ${color.border}`,
    background: color.bg,
    color: color.text,
    padding: "3px 8px",
    fontSize: "11px",
    fontWeight: 900,
  }
}

export default function AuditLogPage() {
  const router = useRouter()
  const { loading: authLoading, authenticated, permissions, role } = useSimpleAdminAuth()
  const [logs, setLogs] = useState<AuditLogRecord[]>([])
  const [pages, setPages] = useState<AuditPageOption[]>([])
  const [users, setUsers] = useState<AuditUserOption[]>([])
  const [pageId, setPageId] = useState("all")
  const [operation, setOperation] = useState("all")
  const [actor, setActor] = useState("all")
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [undoingId, setUndoingId] = useState<string | null>(null)
  const [message, setMessage] = useState("")

  const selectedLog = useMemo(
    () => logs.find((log) => log.id === selectedId) || logs[0] || null,
    [logs, selectedId]
  )
  const canEdit = isAdminRole(role) || canAccessAdminPage(permissions, "audit-log", "edit")

  const loadLogs = useCallback(async () => {
    if (!authenticated) return

    setLoading(true)
    setMessage("")

    const params = new URLSearchParams({ limit: "150" })
    if (pageId !== "all") params.set("page", pageId)
    if (operation !== "all") params.set("operation", operation)
    if (actor !== "all") params.set("actor", actor)

    try {
      const response = await fetch(`/api/admin/audit-logs?${params.toString()}`, {
        cache: "no-store",
      })
      const data = (await response.json()) as AuditResponse

      if (!response.ok) {
        setMessage(data.message || "Failed to load audit logs.")
        return
      }

      setLogs(data.logs || [])
      setPages(data.pages || [])
      setUsers(data.users || [])
      setSelectedId((current) =>
        current && data.logs.some((log) => log.id === current)
          ? current
          : data.logs[0]?.id || null
      )
    } catch {
      setMessage("Failed to load audit logs.")
    } finally {
      setLoading(false)
    }
  }, [actor, authenticated, operation, pageId])

  useEffect(() => {
    document.title = "AUDIT LOG - FC Uno"
  }, [])

  useEffect(() => {
    loadLogs()
  }, [loadLogs])

  async function handleUndo(log: AuditLogRecord) {
    if (log.undoneAt || log.undoOfLogId || !canEdit) return

    const confirmed = window.confirm(`Undo this change?\n\n${log.summary}`)
    if (!confirmed) return

    setUndoingId(log.id)
    setMessage("")

    try {
      const response = await fetch("/api/admin/audit-logs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action: "undo", id: log.id }),
      })
      const data = await response.json()

      if (!response.ok) {
        setMessage(data.message || "Undo failed.")
        return
      }

      setMessage("Undo applied.")
      await loadLogs()
    } catch {
      setMessage("Undo failed.")
    } finally {
      setUndoingId(null)
    }
  }

  if (authLoading) return <p style={{ padding: "40px" }}>Loading...</p>

  if (!authenticated) {
    return (
      <div style={pageStyle}>
        <button
          type="button"
          onClick={() => router.push("/admin")}
          className="fc-admin-nav-button"
          style={buttonStyle}
        >
          Go To Admin
        </button>
      </div>
    )
  }

  return (
    <div style={pageStyle}>
      <div style={{ display: "grid", gap: "14px" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "10px",
            flexWrap: "wrap",
          }}
        >
          <button
            type="button"
            onClick={() => router.push("/admin")}
            className="fc-admin-nav-button"
            style={buttonStyle}
          >
            Back
          </button>
          <h1 style={{ margin: 0, fontSize: "24px", color: "var(--fc-admin-heading)" }}>
            AUDIT LOG
          </h1>
        </div>

        <div style={panelStyle}>
          <div
            style={{
              padding: "12px",
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
              alignItems: "end",
              gap: "12px",
            }}
          >
            <label style={labelStyle}>
              Page
              <select
                value={pageId}
                onChange={(event) => setPageId(event.target.value)}
                style={inputStyle}
              >
                <option value="all">All pages</option>
                {pages.map((page) => (
                  <option key={page.id} value={page.id}>
                    {page.label}
                  </option>
                ))}
              </select>
            </label>

            <label style={labelStyle}>
              Operation
              <select
                value={operation}
                onChange={(event) => setOperation(event.target.value)}
                style={inputStyle}
              >
                <option value="all">All operations</option>
                <option value="INSERT">INSERT</option>
                <option value="UPDATE">UPDATE</option>
                <option value="DELETE">DELETE</option>
              </select>
            </label>

            <label style={labelStyle}>
              User
              <select
                value={actor}
                onChange={(event) => setActor(event.target.value)}
                style={inputStyle}
              >
                <option value="all">All users</option>
                {users.map((user) => (
                  <option key={user.value} value={user.value}>
                    {user.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>

        {message ? (
          <div
            style={{
              border: "1px solid var(--fc-admin-border)",
              borderRadius: "6px",
              background: "var(--fc-admin-panel-bg)",
              color: message.toLowerCase().includes("failed")
                ? "var(--fc-error)"
                : "var(--fc-success)",
              padding: "10px 12px",
              fontSize: "13px",
              fontWeight: 800,
            }}
          >
            {message}
          </div>
        ) : null}

        <div
          className="audit-layout"
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0, 1.65fr) minmax(320px, 1fr)",
            gap: "14px",
            alignItems: "start",
          }}
        >
          <div style={panelStyle}>
            <div style={sectionHeaderStyle}>
              <strong style={{ color: "var(--fc-admin-heading)", fontSize: "13px" }}>
                Changes
              </strong>
              <span style={{ color: "var(--fc-admin-muted)", fontSize: "12px", fontWeight: 800 }}>
                {loading ? "Loading..." : `${logs.length} shown`}
              </span>
            </div>

            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", minWidth: "820px" }}>
                <thead>
                  <tr>
                    <th style={thStyle}>Time</th>
                    <th style={thStyle}>User</th>
                    <th style={thStyle}>Action</th>
                    <th style={thStyle}>Page</th>
                    <th style={thStyle}>Change</th>
                    <th style={thStyle}></th>
                  </tr>
                </thead>
                <tbody>
                  {logs.map((log) => {
                    const isSelected = selectedLog?.id === log.id
                    const canUndo = canEdit && !log.undoneAt && !log.undoOfLogId

                    return (
                      <tr
                        key={log.id}
                        tabIndex={0}
                        onClick={() => setSelectedId(log.id)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault()
                            setSelectedId(log.id)
                          }
                        }}
                        style={{
                          background: isSelected
                            ? "var(--fc-admin-selected-bg)"
                            : "transparent",
                          cursor: "pointer",
                        }}
                      >
                        <td style={{ ...tdStyle, whiteSpace: "nowrap" }}>
                          {formatDate(log.occurredAt)}
                        </td>
                        <td style={tdStyle}>
                          <strong>{log.actorName || log.actorId}</strong>
                        </td>
                        <td style={tdStyle}>
                          <span style={operationStyle(log.displayOperation)}>
                            {log.displayOperation}
                          </span>
                          {log.undoneAt ? (
                            <div
                              style={{
                                marginTop: "5px",
                                color: "var(--fc-admin-muted)",
                                fontSize: "11px",
                                fontWeight: 800,
                              }}
                            >
                              Undone
                            </div>
                          ) : null}
                        </td>
                        <td style={{ ...tdStyle, fontWeight: 800 }}>
                          {log.pageLabel}
                        </td>
                        <td style={{ ...tdStyle, minWidth: "280px" }}>
                          {log.summary}
                        </td>
                        <td style={{ ...tdStyle, textAlign: "right", whiteSpace: "nowrap" }}>
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation()
                              handleUndo(log)
                            }}
                            disabled={!canUndo || undoingId === log.id}
                            style={{
                              ...dangerButtonStyle,
                              cursor: canUndo ? "pointer" : "not-allowed",
                              opacity: canUndo ? 1 : 0.5,
                            }}
                          >
                            {undoingId === log.id ? "Undoing..." : "Undo"}
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {!loading && logs.length === 0 ? (
              <div style={{ padding: "18px", color: "var(--fc-admin-muted)", fontSize: "13px" }}>
                No changes match these filters.
              </div>
            ) : null}
          </div>

          <div style={{ ...panelStyle, position: "sticky", top: "18px" }}>
            <div style={sectionHeaderStyle}>
              <strong style={{ color: "var(--fc-admin-heading)", fontSize: "13px" }}>
                Details
              </strong>
            </div>

            {selectedLog ? (
              <div style={{ padding: "14px", display: "grid", gap: "14px" }}>
                <div>
                  <span style={operationStyle(selectedLog.displayOperation)}>
                    {selectedLog.displayOperation}
                  </span>
                  <h2
                    style={{
                      margin: "10px 0 0",
                      color: "var(--fc-admin-heading)",
                      fontSize: "17px",
                      lineHeight: 1.4,
                    }}
                  >
                    {selectedLog.summary}
                  </h2>
                </div>

                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                    gap: "10px",
                    padding: "11px",
                    border: "1px solid var(--fc-admin-border-soft)",
                    borderRadius: "6px",
                    background: "var(--fc-admin-panel-soft-bg)",
                    fontSize: "12px",
                  }}
                >
                  <div>
                    <div style={{ color: "var(--fc-admin-muted)", fontWeight: 800 }}>Page</div>
                    <div style={{ marginTop: "3px", fontWeight: 900 }}>
                      {selectedLog.pageLabel}
                    </div>
                  </div>
                  <div>
                    <div style={{ color: "var(--fc-admin-muted)", fontWeight: 800 }}>User</div>
                    <div style={{ marginTop: "3px", fontWeight: 900 }}>
                      {selectedLog.actorName || selectedLog.actorId}
                    </div>
                  </div>
                  <div style={{ gridColumn: "1 / -1" }}>
                    <div style={{ color: "var(--fc-admin-muted)", fontWeight: 800 }}>Time</div>
                    <div style={{ marginTop: "3px", fontWeight: 900 }}>
                      {formatDate(selectedLog.occurredAt)}
                    </div>
                  </div>
                </div>

                <div style={{ display: "grid", gap: "8px" }}>
                  {selectedLog.details.map((detail, index) => (
                    <div
                      key={`${selectedLog.id}-${index}`}
                      style={{
                        borderLeft: "3px solid var(--fc-admin-button-border)",
                        padding: "7px 0 7px 10px",
                        color: "var(--fc-admin-panel-text)",
                        fontSize: "13px",
                        lineHeight: 1.5,
                      }}
                    >
                      {detail}
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div style={{ padding: "14px", color: "var(--fc-admin-muted)", fontSize: "13px" }}>
                Select a change to see what happened.
              </div>
            )}
          </div>
        </div>
      </div>

      <style jsx>{`
        @media (max-width: 980px) {
          .audit-layout {
            grid-template-columns: 1fr !important;
          }
        }
      `}</style>
    </div>
  )
}
