"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { canAccessAdminPage, isAdminRole } from "@/lib/adminPages"
import { useSimpleAdminAuth } from "@/lib/useSimpleAdminAuth"

type HealthStatus = "ok" | "warning" | "error"

type HealthCheck = {
  id: string
  label: string
  status: HealthStatus
  message: string
  checkedAt: string
  details?: Record<string, string | number | boolean | null>
}

type HealthResponse = {
  status: HealthStatus
  checkedAt: string
  deployment: {
    commit: string
    shortCommit: string
    branch: string
    deployedAt: string
    environment: string
  }
  checks: HealthCheck[]
  message?: string
}

const pageStyle: React.CSSProperties = {
  minHeight: "100vh",
  background: "var(--fc-admin-page-bg)",
  color: "var(--fc-admin-panel-text)",
  fontFamily: "var(--fc-admin-font)",
  padding: "18px",
}

const shellStyle: React.CSSProperties = {
  display: "grid",
  gap: "14px",
  maxWidth: "1180px",
  margin: "0 auto",
}

const panelStyle: React.CSSProperties = {
  border: "1px solid var(--fc-admin-border)",
  borderRadius: "8px",
  background: "var(--fc-admin-panel-bg)",
  boxShadow: "0 12px 28px #0000000d",
  overflow: "hidden",
}

const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "12px",
  padding: "14px",
  borderBottom: "1px solid var(--fc-admin-border-soft)",
  background: "var(--fc-admin-panel-soft-bg)",
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

const gridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
  gap: "10px",
  padding: "14px",
}

const checkGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
  gap: "10px",
  padding: "14px",
}

function statusColors(status: HealthStatus) {
  if (status === "ok") return { bg: "#e9f8ee", border: "#b7dfc4", text: "#146b2f" }
  if (status === "warning") return { bg: "#fff6dd", border: "#ead28a", text: "#765400" }
  return { bg: "#fff0f0", border: "#efc1c5", text: "#9f1c27" }
}

function StatusBadge({ status }: { status: HealthStatus }) {
  const colors = statusColors(status)
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        minHeight: "24px",
        borderRadius: "999px",
        border: `1px solid ${colors.border}`,
        background: colors.bg,
        color: colors.text,
        padding: "3px 8px",
        fontSize: "11px",
        fontWeight: 900,
        textTransform: "uppercase",
      }}
    >
      {status}
    </span>
  )
}

function formatDate(value: string | null | undefined) {
  if (!value) return "-"
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value))
}

function DetailValue({ value }: { value: string | number | boolean | null }) {
  if (typeof value === "string" && /^https?:\/\//.test(value)) {
    return (
      <a href={value} target="_blank" rel="noreferrer" style={{ color: "#1b66c9", fontWeight: 800 }}>
        Open
      </a>
    )
  }

  return <span>{value === null || value === "" ? "-" : String(value)}</span>
}

export default function SystemHealthPage() {
  const router = useRouter()
  const { loading: authLoading, authenticated, permissions, role } = useSimpleAdminAuth()
  const [health, setHealth] = useState<HealthResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState("")

  const canView = isAdminRole(role) || canAccessAdminPage(permissions, "system-health", "view")
  const checks = useMemo(() => health?.checks || [], [health])

  const loadHealth = useCallback(async () => {
    if (!authenticated || !canView) return

    setLoading(true)
    setMessage("")

    try {
      const response = await fetch("/api/admin/system-health", { cache: "no-store" })
      const data = (await response.json()) as HealthResponse
      if (!response.ok) {
        setMessage(data.message || "Failed to load system health.")
        return
      }
      setHealth(data)
    } catch {
      setMessage("Failed to load system health.")
    } finally {
      setLoading(false)
    }
  }, [authenticated, canView])

  useEffect(() => {
    document.title = "SYSTEM HEALTH - FC Uno"
  }, [])

  useEffect(() => {
    if (!authLoading && (!authenticated || !canView)) router.push("/admin")
  }, [authLoading, authenticated, canView, router])

  useEffect(() => {
    loadHealth()
  }, [loadHealth])

  if (authLoading || !authenticated || !canView) {
    return (
      <div style={pageStyle}>
        <div style={shellStyle}>Loading...</div>
      </div>
    )
  }

  return (
    <div style={pageStyle}>
      <div style={shellStyle}>
        <section style={panelStyle}>
          <div style={headerStyle}>
            <div>
              <h1 style={{ margin: 0, fontSize: "22px", fontWeight: 900, letterSpacing: 0 }}>SYSTEM HEALTH</h1>
              <p style={{ margin: "6px 0 0", color: "var(--fc-admin-muted)", fontSize: "13px", fontWeight: 700 }}>
                {health ? `Checked ${formatDate(health.checkedAt)}` : "Checking..."}
              </p>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", justifyContent: "flex-end" }}>
              {health ? <StatusBadge status={health.status} /> : null}
              <button type="button" onClick={loadHealth} disabled={loading} style={{ ...buttonStyle, opacity: loading ? 0.6 : 1 }}>
                {loading ? "Refreshing..." : "Refresh"}
              </button>
            </div>
          </div>

          {message ? (
            <div style={{ padding: "12px 14px", color: "#9f1c27", fontSize: "13px", fontWeight: 800 }}>{message}</div>
          ) : null}

          <div style={gridStyle}>
            <div>
              <div style={{ color: "var(--fc-admin-muted)", fontSize: "11px", fontWeight: 900, textTransform: "uppercase" }}>Commit</div>
              <div style={{ marginTop: "6px", fontSize: "18px", fontWeight: 900 }}>{health?.deployment.shortCommit || "-"}</div>
            </div>
            <div>
              <div style={{ color: "var(--fc-admin-muted)", fontSize: "11px", fontWeight: 900, textTransform: "uppercase" }}>Branch</div>
              <div style={{ marginTop: "6px", fontSize: "18px", fontWeight: 900 }}>{health?.deployment.branch || "-"}</div>
            </div>
            <div>
              <div style={{ color: "var(--fc-admin-muted)", fontSize: "11px", fontWeight: 900, textTransform: "uppercase" }}>Environment</div>
              <div style={{ marginTop: "6px", fontSize: "18px", fontWeight: 900 }}>{health?.deployment.environment || "-"}</div>
            </div>
            <div>
              <div style={{ color: "var(--fc-admin-muted)", fontSize: "11px", fontWeight: 900, textTransform: "uppercase" }}>Deployed At</div>
              <div style={{ marginTop: "6px", fontSize: "18px", fontWeight: 900 }}>{health?.deployment.deployedAt || "-"}</div>
            </div>
          </div>
        </section>

        <section style={panelStyle}>
          <div style={headerStyle}>
            <h2 style={{ margin: 0, fontSize: "15px", fontWeight: 900, letterSpacing: 0 }}>CHECKS</h2>
          </div>
          <div style={checkGridStyle}>
            {checks.map((check) => (
              <article
                key={check.id}
                style={{
                  minWidth: 0,
                  border: "1px solid var(--fc-admin-border-soft)",
                  borderRadius: "8px",
                  background: "#fff",
                  padding: "12px",
                }}
              >
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "10px" }}>
                  <div>
                    <h3 style={{ margin: 0, fontSize: "14px", fontWeight: 900, letterSpacing: 0 }}>{check.label}</h3>
                    <p style={{ margin: "6px 0 0", color: "var(--fc-admin-muted)", fontSize: "12px", fontWeight: 700 }}>
                      {formatDate(check.checkedAt)}
                    </p>
                  </div>
                  <StatusBadge status={check.status} />
                </div>
                <p style={{ margin: "12px 0 0", fontSize: "13px", lineHeight: 1.45, fontWeight: 750 }}>{check.message}</p>

                {check.details && Object.keys(check.details).length ? (
                  <dl style={{ display: "grid", gap: "7px", margin: "12px 0 0", fontSize: "12px" }}>
                    {Object.entries(check.details).map(([key, value]) => (
                      <div
                        key={key}
                        style={{
                          display: "grid",
                          gridTemplateColumns: "minmax(95px, 0.45fr) minmax(0, 1fr)",
                          gap: "8px",
                        }}
                      >
                        <dt style={{ color: "var(--fc-admin-muted)", fontWeight: 900 }}>{key}</dt>
                        <dd style={{ margin: 0, minWidth: 0, overflowWrap: "anywhere", fontWeight: 750 }}>
                          <DetailValue value={value} />
                        </dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
              </article>
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}
