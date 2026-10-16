"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"
import { SpcShell } from "@/components/SpcShell"
import { useSpcAuth } from "@/lib/useSpcAuth"
import { canAccessSpcPage } from "@/lib/spcPages"
import { formatSpcOperationalTime, parseSpcHealthResponse } from "@/lib/spcOperationalResponse"
import { useSpcOperationalRead } from "@/lib/useSpcOperationalRead"

export default function SpcSystemHealthPage() {
  const router = useRouter()
  const { loading: authLoading, authenticated, permissions, actorKey, username, role, office } = useSpcAuth()
  const canView = canAccessSpcPage(permissions, "spc-system-health", "view")

  useEffect(() => {
    document.title = "SPC System Health"
  }, [])

  useEffect(() => {
    if (!authLoading && (!authenticated || !canView)) router.replace("/spc")
  }, [authLoading, authenticated, canView, router])

  if (authLoading || !authenticated || !canView) {
    return <div className="spc-loading">Loading...</div>
  }

  return <HealthPanel key={JSON.stringify([actorKey, username, role, office, permissions["spc-system-health"]])} />
}

function HealthPanel() {
  const { data: health, loading, message, refresh } = useSpcOperationalRead("/api/spc/system-health", parseSpcHealthResponse)
  const previous = Boolean(health && (message || loading || health.freshness.state === "stale"))

  return (
    <SpcShell title="SPC System Health">
      <div className="spc-operational-page">
      {message ? <div className="spc-alert is-error" role="alert">{message}</div> : null}
      {health?.freshness.state === "stale" ? <div className="spc-alert is-error" role="alert">The latest check could not finish. Showing the last successful check from {formatSpcOperationalTime(health.checkedAt)}. Current status is unknown.</div> : null}

      <section className="spc-panel">
        <div className="spc-panel-header">
          <h2>Overview</h2>
          <button type="button" onClick={refresh} disabled={loading}>
            {loading ? "Refreshing..." : "Refresh"}
          </button>
        </div>
        {health ? <p className="spc-operational-status" role="status">{previous ? "Previously checked" : "Last checked"}{" · "}{formatSpcOperationalTime(health.checkedAt)}{health.freshness.state === "cached" ? " · Cached for up to one minute" : ""}. Table access and settings only; external services and message delivery are not tested.</p> : <p className="spc-operational-status" role="status">{loading ? "Loading system checks..." : "System checks are unavailable. Please refresh to retry."}</p>}
        <div className="spc-health-grid">
          {[
            ["COMMIT", health?.deployment.shortCommit || "-"],
            ["BRANCH", health?.deployment.branch || "-"],
            ["ENVIRONMENT", health?.deployment.environment || "-"],
            ["STATUS", health ? previous ? "UNKNOWN" : health.status : "-"],
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
          {(health?.checks || []).map((check) => (
            <article key={check.id} className={`is-${check.status}`}>
              <div>
                <h3>{check.label}</h3>
                <span>{previous ? "LAST: " : ""}{check.status}</span>
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
      </div>
    </SpcShell>
  )
}
