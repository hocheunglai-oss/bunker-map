"use client"

import { useEffect, useState } from "react"
import { canAccessAdminPage, isAdminRole } from "@/lib/adminPages"
import { useSimpleAdminAuth } from "@/lib/useSimpleAdminAuth"
import { useAuditBrowsing, type AuditLogRecord, type AuditOperation } from "@/lib/useAuditBrowsing"

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
  const { loading: authLoading, authenticated, permissions, role, actorKey, username } = useSimpleAdminAuth()
  const [pageId, setPageId] = useState("all")
  const [operation, setOperation] = useState("all")
  const [actor, setActor] = useState("all")
  const [actorLabel, setActorLabel] = useState("")
  const [undoing, setUndoing] = useState<{ key: string; id: string } | null>(null)
  const [notice, setNotice] = useState<{ key: string; message: string } | null>(null)
  const canView = isAdminRole(role) || canAccessAdminPage(permissions, "audit-log", "view")
  const canEdit = isAdminRole(role) || canAccessAdminPage(permissions, "audit-log", "edit")
  const owner = JSON.stringify([actorKey, username, role, canView, canEdit])
  const noticeKey = JSON.stringify([owner, pageId, operation, actor])
  const undoingId = undoing?.key === noticeKey ? undoing.id : null
  const browsing = useAuditBrowsing({ endpoint: "/api/admin/audit-logs", owner, enabled: !authLoading && authenticated && canView, page: pageId, actor, operation })
  const { logs, pages, users, selectedLog, loading, detailLoadingId, pageInfo } = browsing
  const message = browsing.message || (notice?.key === noticeKey ? notice.message : "")

  useEffect(() => {
    document.title = "AUDIT LOG - FC Uno"
  }, [])

  async function handleUndo(log: AuditLogRecord) {
    if (log.undoneAt || log.undoOfLogId || log.undoable === false || !canEdit) return

    const confirmed = window.confirm(`Undo this change?\n\n${log.summary}`)
    if (!confirmed) return

    const token = browsing.token()
    setUndoing({ key: noticeKey, id: log.id })
    setNotice(null)

    try {
      const response = await fetch("/api/admin/audit-logs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action: "undo", id: log.id }),
      })
      const data = await response.json()
      if (!browsing.isCurrent(token)) return

      if (!response.ok) {
        setNotice({ key: noticeKey, message: data.message || "Undo failed." })
        return
      }

      setNotice({ key: noticeKey, message: "Undo applied." })
      await browsing.refresh()
    } catch {
      if (browsing.isCurrent(token)) setNotice({ key: noticeKey, message: "Undo failed." })
    } finally {
      setUndoing((current) => current?.key === noticeKey && current.id === log.id ? null : current)
    }
  }

  if (authLoading) return <p style={{ padding: "40px" }}>Loading...</p>

  if (!authenticated || !canView) {
    return (
      <div style={pageStyle}>
        <p style={{ margin: 0, color: "var(--fc-admin-muted)", fontSize: "13px", fontWeight: 700 }}>
          {authenticated ? "You do not have permission to view audit records." : "Please log in from the admin homepage first."}
        </p>
      </div>
    )
  }

  return (
    <div style={pageStyle}>
      <div style={{ display: "grid", gap: "14px" }}>
        <div style={panelStyle}>
          <div
            data-admin-view-safe="true"
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
                aria-label="Page"
                value={pageId}
                onChange={(event) => setPageId(event.target.value)}
                style={inputStyle}
              >
                <option value="all">All pages</option>
                {pageId !== "all" && !pages.some((page) => page.id === pageId) ? <option value={pageId}>{pageId}</option> : null}
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
                aria-label="Operation"
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
                aria-label="User"
                value={actor}
                onChange={(event) => { setActor(event.target.value); setActorLabel(event.target.selectedOptions[0]?.text || event.target.value) }}
                style={inputStyle}
              >
                <option value="all">All users</option>
                {actor !== "all" && !users.some((user) => user.value === actor) ? <option value={actor}>{actorLabel || actor}</option> : null}
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
          <div role="status"
            style={{
              border: "1px solid var(--fc-admin-border)",
              borderRadius: "6px",
              background: "var(--fc-admin-panel-bg)",
              color: browsing.message || notice?.message !== "Undo applied."
                ? "var(--fc-error)"
                : "var(--fc-success)",
              padding: "10px 12px",
              fontSize: "13px",
              fontWeight: 800,
            }}
          >
            {message}
            {browsing.message ? <button type="button" data-admin-view-safe="true" style={{ ...buttonStyle, marginLeft: "10px" }} disabled={loading} onClick={browsing.retry}>Retry</button> : null}
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
                {loading ? "Loading..." : `${logs.length} on this page`}
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
                    const canUndo = canEdit && log.undoable !== false && !log.undoneAt && !log.undoOfLogId

                    return (
                      <tr
                        key={log.id}
                        tabIndex={0}
                        onClick={() => browsing.select(log.id)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault()
                            browsing.select(log.id)
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
                            disabled={!canUndo || loading || undoingId === log.id}
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

            {!loading && logs.length === 0 && pageInfo?.state === "exhausted" ? (
              <div style={{ padding: "18px", color: "var(--fc-admin-muted)", fontSize: "13px" }}>
                No changes match these filters.
              </div>
            ) : null}
            <div aria-live="polite" style={{ padding: "12px", display: "grid", gap: "10px", color: "var(--fc-admin-muted)", fontSize: "12px" }}>
              {pageInfo?.state === "scan-pending" ? <span>More history needs to be checked. Continue searching for matching changes.</span> : null}
              {pageInfo?.state === "exhausted" && logs.length > 0 ? <span>End of matching history.</span> : null}
              <span>Live history; new changes may appear after Refresh. User options are from the current results, not a complete staff directory.</span>
              {browsing.historyTruncated ? <span>Only the last 20 pages are kept for Previous. Refresh to restart from the newest changes.</span> : null}
              <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                <button type="button" style={buttonStyle} disabled={loading || browsing.index < 1} onClick={browsing.previous}>Previous</button>
                <button type="button" style={buttonStyle} disabled={loading || !pageInfo?.nextCursor} onClick={browsing.older}>{pageInfo?.state === "scan-pending" ? "Continue searching" : "Load older"}</button>
                <button type="button" style={buttonStyle} disabled={loading} onClick={() => { setNotice(null); void browsing.refresh() }}>Refresh</button>
              </div>
            </div>
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
                  {detailLoadingId === selectedLog.id ? (
                    <div style={{ color: "var(--fc-admin-muted)", fontSize: "13px" }}>
                      Loading details...
                    </div>
                  ) : selectedLog.details.map((detail, index) => (
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
