"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { canAccessAdminPage, isAdminRole } from "@/lib/adminPages"
import { useSimpleAdminAuth } from "@/lib/useSimpleAdminAuth"
import styles from "./systemHealth.module.css"

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
        OPEN
      </a>
    )
  }

  return <span>{value === null || value === "" ? "-" : String(value)}</span>
}

function formatDetailLabel(value: string) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toUpperCase()
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
      <div className={styles.page}>
        <div className={styles.shell}>LOADING...</div>
      </div>
    )
  }

  return (
    <div className={styles.page}>
      <div className={styles.shell}>
        <section className={styles.panel}>
          <div className={styles.pageHeader}>
            <div className={styles.titleGroup}>
              <button
                type="button"
                className={styles.backButton}
                onClick={() => router.push("/admin")}
                aria-label="Back to admin"
                title="Back to admin"
              >
                ←
              </button>
              <div>
                <h1 className={styles.pageTitle}>SYSTEM HEALTH</h1>
                <p className={styles.checkedAt}>
                  {health ? `CHECKED ${formatDate(health.checkedAt)}` : "CHECKING..."}
                </p>
              </div>
            </div>
            <div className={styles.headerActions}>
              <button type="button" onClick={loadHealth} disabled={loading} className={styles.refreshButton}>
                {loading ? "REFRESHING..." : "REFRESH"}
              </button>
            </div>
          </div>

          {message ? <div className={styles.errorMessage}>{message.toUpperCase()}</div> : null}

          <div className={styles.deploymentGrid}>
            {[
              ["COMMIT", health?.deployment.shortCommit || "-"],
              ["BRANCH", health?.deployment.branch || "-"],
              ["ENVIRONMENT", health?.deployment.environment || "-"],
              ["DEPLOYED AT", health?.deployment.deployedAt || "-"],
            ].map(([label, value]) => (
              <div key={label} className={styles.deploymentItem}>
                <div className={styles.deploymentLabel}>{label}</div>
                <div className={styles.deploymentValue}>{value}</div>
              </div>
            ))}
          </div>
        </section>

        <section className={styles.panel}>
          <div className={styles.sectionHeader}>
            <h2>CHECKS</h2>
          </div>
          <div className={styles.checkGrid}>
            {checks.map((check) => (
              <article
                key={check.id}
                className={`${styles.checkCard} ${check.id === "drive-file-content-backup" ? styles.wideCard : ""}`}
              >
                <div className={styles.checkHeader}>
                  <div className={styles.checkTitleGroup}>
                    <h3>{check.label.toUpperCase()}</h3>
                    <p>{formatDate(check.checkedAt).toUpperCase()}</p>
                  </div>
                  <StatusBadge status={check.status} />
                </div>
                <p className={styles.checkMessage}>{check.message.toUpperCase()}</p>

                {check.details && Object.keys(check.details).length ? (
                  <dl className={styles.detailList}>
                    {Object.entries(check.details).map(([key, value]) => (
                      <div key={key} className={styles.detailRow}>
                        <dt>{formatDetailLabel(key)}</dt>
                        <dd>
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
