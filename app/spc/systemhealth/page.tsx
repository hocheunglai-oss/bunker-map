"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { SpcShell } from "@/components/SpcShell"
import { useSpcAuth } from "@/lib/useSpcAuth"
import { canAccessSpcPage } from "@/lib/spcPages"

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

export default function SpcSystemHealthPage() {
  const router = useRouter()
  const { loading: authLoading, authenticated, permissions } = useSpcAuth()
  const [health, setHealth] = useState<HealthResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState("")
  const canView = canAccessSpcPage(permissions, "spc-system-health", "view")
  const checks = useMemo(() => health?.checks || [], [health])

  const loadHealth = useCallback(async (forceRefresh = false) => {
    if (!authenticated || !canView) return
    setLoading(true)
    setMessage("")
    try {
      const response = await fetch(
        forceRefresh ? "/api/spc/system-health?refresh=1" : "/api/spc/system-health",
        { cache: "no-store" },
      )
      const data = (await response.json()) as HealthResponse
      if (!response.ok) {
        setMessage(data.message || "Failed to load SPC system health.")
        return
      }
      setHealth(data)
    } catch {
      setMessage("Failed to load SPC system health.")
    } finally {
      setLoading(false)
    }
  }, [authenticated, canView])

  useEffect(() => {
    document.title = "SPC System Health"
  }, [])

  useEffect(() => {
    if (!authLoading && (!authenticated || !canView)) router.replace("/spc")
  }, [authLoading, authenticated, canView, router])

  useEffect(() => {
    void loadHealth()
  }, [loadHealth])

  if (authLoading || !authenticated || !canView) {
    return <div className="spc-loading">Loading...</div>
  }

  return (
    <SpcShell title="SPC System Health">
      {message ? <div className="spc-alert is-error">{message}</div> : null}

      <section className="spc-panel">
        <div className="spc-panel-header">
          <h2>Overview</h2>
          <button type="button" onClick={() => void loadHealth(true)} disabled={loading}>
            {loading ? "Refreshing..." : "Refresh"}
          </button>
        </div>
        <div className="spc-health-grid">
          {[
            ["COMMIT", health?.deployment.shortCommit || "-"],
            ["BRANCH", health?.deployment.branch || "-"],
            ["ENVIRONMENT", health?.deployment.environment || "-"],
            ["STATUS", health?.status || "-"],
          ].map(([label, value]) => (
            <div key={label}>
              <span>{label}</span>
              <strong>{value}</strong>
            </div>
          ))}
        </div>
      </section>

      <section className="spc-panel">
        <div className="spc-panel-header">
          <h2>Checks</h2>
        </div>
        <div className="spc-check-grid">
          {checks.map((check) => (
            <article key={check.id} className={`is-${check.status}`}>
              <div>
                <h3>{check.label}</h3>
                <span>{check.status}</span>
              </div>
              <p>{check.message}</p>
              {check.details ? (
                <dl>
                  {Object.entries(check.details).map(([key, value]) => (
                    <div key={key}>
                      <dt>{key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").toUpperCase()}</dt>
                      <dd>{value === null || value === "" ? "-" : String(value)}</dd>
                    </div>
                  ))}
                </dl>
              ) : null}
            </article>
          ))}
        </div>
      </section>
    </SpcShell>
  )
}
