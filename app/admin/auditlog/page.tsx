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
  actorSource: string
  tableSchema: string
  tableName: string
  operation: AuditOperation
  recordPk: Record<string, unknown>
  changedFields: string[]
  beforeRow: Record<string, unknown> | null
  afterRow: Record<string, unknown> | null
  requestContext: Record<string, unknown>
  undoOfLogId: string | null
  undoneAt: string | null
  undoneByLogId: string | null
}

type AuditResponse = {
  logs: AuditLogRecord[]
  tables: string[]
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
  borderRadius: "18px",
  background: "var(--fc-admin-panel-bg)",
  boxShadow: "0 12px 28px #00000010",
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
  minHeight: "34px",
  border: "1px solid var(--fc-input-border)",
  borderRadius: "12px",
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
  padding: "10px",
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
  verticalAlign: "top",
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value))
}

function stringifyValue(value: unknown, maxLength = 180) {
  if (value === null || value === undefined) return ""

  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, typeof value === "object" ? 2 : 0)

  if (!text) return ""
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text
}

function formatPrimaryKey(recordPk: Record<string, unknown>) {
  const entries = Object.entries(recordPk)
  if (entries.length === 0) return "No primary key"

  return entries.map(([key, value]) => `${key}: ${stringifyValue(value, 80)}`).join(", ")
}

function getRecordLabel(log: AuditLogRecord) {
  const row = log.afterRow || log.beforeRow || {}
  const preferredKeys = [
    "name",
    "full_name",
    "display_name",
    "title",
    "subject",
    "file_name",
    "key",
    "source_key",
    "id",
  ]

  for (const key of preferredKeys) {
    const value = row[key]
    if (typeof value === "string" && value.trim()) return value
  }

  return formatPrimaryKey(log.recordPk)
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

function ChangedFields({ log }: { log: AuditLogRecord }) {
  if (log.operation !== "UPDATE") {
    const row = log.afterRow || log.beforeRow || {}
    return (
      <pre
        style={{
          margin: 0,
          maxHeight: "420px",
          overflow: "auto",
          whiteSpace: "pre-wrap",
          fontSize: "12px",
          color: "var(--fc-admin-panel-text)",
        }}
      >
        {JSON.stringify(row, null, 2)}
      </pre>
    )
  }

  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", minWidth: "680px" }}>
        <thead>
          <tr>
            <th style={thStyle}>Field</th>
            <th style={thStyle}>Before</th>
            <th style={thStyle}>After</th>
          </tr>
        </thead>
        <tbody>
          {log.changedFields.map((field) => (
            <tr key={field}>
              <td style={{ ...tdStyle, width: "180px", fontWeight: 900 }}>{field}</td>
              <td style={tdStyle}>{stringifyValue(log.beforeRow?.[field]) || "Blank"}</td>
              <td style={tdStyle}>{stringifyValue(log.afterRow?.[field]) || "Blank"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default function AuditLogPage() {
  const router = useRouter()
  const { loading: authLoading, authenticated, permissions, role } = useSimpleAdminAuth()
  const [logs, setLogs] = useState<AuditLogRecord[]>([])
  const [tables, setTables] = useState<string[]>([])
  const [tableName, setTableName] = useState("all")
  const [operation, setOperation] = useState("all")
  const [actor, setActor] = useState("")
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
    if (tableName !== "all") params.set("table", tableName)
    if (operation !== "all") params.set("operation", operation)
    if (actor.trim()) params.set("actor", actor.trim())

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
      setTables(data.tables || [])
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
  }, [actor, authenticated, operation, tableName])

  useEffect(() => {
    document.title = "Audit Log - FC Uno"
  }, [])

  useEffect(() => {
    loadLogs()
  }, [loadLogs])

  async function handleUndo(log: AuditLogRecord) {
    if (log.undoneAt || log.undoOfLogId) return
    if (!canEdit) return

    const confirmed = window.confirm(
      `Undo this ${log.operation.toLowerCase()} on ${log.tableName}?`
    )
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
        <button type="button" onClick={() => router.push("/admin")} style={buttonStyle}>
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
            justifyContent: "space-between",
            alignItems: "center",
            gap: "12px",
            flexWrap: "wrap",
          }}
        >
          <div>
            <h1 style={{ margin: 0, fontSize: "24px", color: "var(--fc-admin-heading)" }}>
              Audit Log
            </h1>
            <p style={{ margin: "5px 0 0", color: "var(--fc-admin-muted)", fontSize: "13px" }}>
              Recent database changes with reversible row snapshots.
            </p>
          </div>
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
            <button type="button" onClick={() => router.push("/admin")} style={buttonStyle}>
              Back
            </button>
            <button type="button" onClick={loadLogs} disabled={loading} style={buttonStyle}>
              {loading ? "Refreshing..." : "Refresh"}
            </button>
          </div>
        </div>

        <div style={panelStyle}>
          <div
            style={{
              ...sectionHeaderStyle,
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))",
              alignItems: "end",
            }}
          >
            <label style={labelStyle}>
              Table
              <select
                value={tableName}
                onChange={(event) => setTableName(event.target.value)}
                style={inputStyle}
              >
                <option value="all">All tables</option>
                {tables.map((table) => (
                  <option key={table} value={table}>
                    {table}
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
                <option value="INSERT">Insert</option>
                <option value="UPDATE">Update</option>
                <option value="DELETE">Delete</option>
              </select>
            </label>

            <label style={labelStyle}>
              User
              <input
                value={actor}
                onChange={(event) => setActor(event.target.value)}
                placeholder="Name or username"
                style={inputStyle}
              />
            </label>
          </div>
        </div>

        {message ? (
          <div
            style={{
              border: "1px solid var(--fc-admin-border)",
              borderRadius: "12px",
              background: "var(--fc-admin-panel-bg)",
              color: message.includes("failed") || message.includes("Failed")
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
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 520px), 1fr))",
            gap: "14px",
          }}
        >
          <div style={panelStyle}>
            <div style={sectionHeaderStyle}>
              <strong style={{ color: "var(--fc-admin-heading)", fontSize: "13px" }}>
                Changes
              </strong>
              <span style={{ color: "var(--fc-admin-muted)", fontSize: "12px", fontWeight: 800 }}>
                {logs.length} shown
              </span>
            </div>

            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", minWidth: "920px" }}>
                <thead>
                  <tr>
                    <th style={thStyle}>Time</th>
                    <th style={thStyle}>User</th>
                    <th style={thStyle}>Action</th>
                    <th style={thStyle}>Table</th>
                    <th style={thStyle}>Record</th>
                    <th style={thStyle}>Fields</th>
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
                        style={{
                          background: isSelected ? "var(--fc-admin-selected-bg)" : "transparent",
                        }}
                      >
                        <td style={tdStyle}>{formatDate(log.occurredAt)}</td>
                        <td style={tdStyle}>
                          <div style={{ fontWeight: 900 }}>{log.actorName || "Unknown"}</div>
                          <div style={{ color: "var(--fc-admin-muted)", fontSize: "11px" }}>
                            {log.actorSource}
                          </div>
                        </td>
                        <td style={tdStyle}>
                          <span style={operationStyle(log.operation)}>{log.operation}</span>
                          {log.undoOfLogId ? (
                            <div style={{ marginTop: "6px", color: "var(--fc-admin-muted)", fontSize: "11px", fontWeight: 800 }}>
                              Undo record
                            </div>
                          ) : null}
                          {log.undoneAt ? (
                            <div style={{ marginTop: "6px", color: "var(--fc-admin-muted)", fontSize: "11px", fontWeight: 800 }}>
                              Undone
                            </div>
                          ) : null}
                        </td>
                        <td style={tdStyle}>{log.tableName}</td>
                        <td style={{ ...tdStyle, maxWidth: "240px" }}>{getRecordLabel(log)}</td>
                        <td style={{ ...tdStyle, maxWidth: "220px" }}>
                          {log.operation === "UPDATE" && log.changedFields.length > 0
                            ? log.changedFields.join(", ")
                            : formatPrimaryKey(log.recordPk)}
                        </td>
                        <td style={{ ...tdStyle, textAlign: "right", whiteSpace: "nowrap" }}>
                          <button
                            type="button"
                            onClick={() => setSelectedId(log.id)}
                            style={{ ...buttonStyle, marginRight: "6px" }}
                          >
                            View
                          </button>
                          <button
                            type="button"
                            onClick={() => handleUndo(log)}
                            disabled={!canUndo || undoingId === log.id}
                            style={dangerButtonStyle}
                          >
                            {undoingId === log.id ? "Undoing..." : "Undo"}
                          </button>
                        </td>
                      </tr>
                    )
                  })}

                  {logs.length === 0 ? (
                    <tr>
                      <td colSpan={7} style={{ ...tdStyle, color: "var(--fc-admin-muted)" }}>
                        No audit records found.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </div>

          <div style={panelStyle}>
            <div style={sectionHeaderStyle}>
              <strong style={{ color: "var(--fc-admin-heading)", fontSize: "13px" }}>
                Details
              </strong>
            </div>

            {selectedLog ? (
              <div style={{ padding: "12px", display: "grid", gap: "12px" }}>
                <div style={{ display: "grid", gap: "8px", fontSize: "13px" }}>
                  <div>
                    <strong>Record</strong>
                    <div style={{ color: "var(--fc-admin-muted)", marginTop: "3px" }}>
                      {getRecordLabel(selectedLog)}
                    </div>
                  </div>
                  <div>
                    <strong>Primary key</strong>
                    <div style={{ color: "var(--fc-admin-muted)", marginTop: "3px" }}>
                      {formatPrimaryKey(selectedLog.recordPk)}
                    </div>
                  </div>
                  <div>
                    <strong>Audit id</strong>
                    <div style={{ color: "var(--fc-admin-muted)", marginTop: "3px", wordBreak: "break-all" }}>
                      {selectedLog.id}
                    </div>
                  </div>
                </div>

                <div
                  style={{
                    borderTop: "1px solid var(--fc-admin-border-soft)",
                    paddingTop: "12px",
                  }}
                >
                  <ChangedFields log={selectedLog} />
                </div>
              </div>
            ) : (
              <div style={{ padding: "12px", color: "var(--fc-admin-muted)", fontSize: "13px" }}>
                Select a change to inspect it.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
