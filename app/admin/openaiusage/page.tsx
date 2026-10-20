"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { canAccessAdminPage, isAdminRole } from "@/lib/adminPages"
import { useSimpleAdminAuth } from "@/lib/useSimpleAdminAuth"
import {
  OPENAI_USAGE_DAYS,
  isSafeOpenAiUsagePagePath,
  parseOpenAiUsageReport,
  type OpenAiUsageDays,
  type OpenAiUsageReport,
} from "@/lib/openAiUsageReport"
import styles from "./openAiUsage.module.css"

const numberFormat = new Intl.NumberFormat()
const verifiedTimeFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Hong_Kong", dateStyle: "medium", timeStyle: "medium",
})

export default function OpenAiUsagePage() {
  const router = useRouter()
  const { loading: authLoading, authenticated, permissions, role, username } = useSimpleAdminAuth()
  const canView = isAdminRole(role) || canAccessAdminPage(permissions, "openai-usage", "view")

  useEffect(() => {
    document.title = "OPENAI USAGE - FC Uno"
  }, [])

  useEffect(() => {
    if (!authLoading && (!authenticated || !canView)) router.push("/admin")
  }, [authLoading, authenticated, canView, router])

  if (authLoading || !authenticated || !canView) return <div className={styles.page}>LOADING...</div>

  // A changed identity/permission or a signed-out render destroys the previous
  // owner, including its verified data and in-flight response callbacks.
  return <OpenAiUsageDashboard key={JSON.stringify([username, role, permissions["openai-usage"]])} />
}

function OpenAiUsageDashboard() {
  const [days, setDays] = useState<OpenAiUsageDays>(30)
  // Never display one period's figures under another period's selector.
  return <UsagePeriodPanel key={days} days={days} onPeriodChange={setDays} />
}

function UsagePeriodPanel({ days, onPeriodChange }: {
  days: OpenAiUsageDays
  onPeriodChange: (days: OpenAiUsageDays) => void
}) {
  const [data, setData] = useState<OpenAiUsageReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState("")
  const requestController = useRef<AbortController | null>(null)
  const lastVerifiedData = useRef<OpenAiUsageReport | null>(null)
  const loadUsage = useCallback(async () => {
    requestController.current?.abort()
    const controller = new AbortController()
    requestController.current = controller
    setLoading(true)
    setMessage("")
    try {
      const response = await fetch(`/api/admin/openai-usage?days=${days}`, { cache: "no-store", signal: controller.signal })
      if (controller.signal.aborted || requestController.current !== controller) return
      if (response.status === 401 || response.status === 403) {
        lastVerifiedData.current = null
        setData(null)
        setMessage("Your access to OpenAI usage could not be verified. Please sign in again or check your access.")
        return
      }
      if (!response.ok) throw new Error("OpenAI usage is unavailable.")
      const result: unknown = await response.json()
      if (controller.signal.aborted || requestController.current !== controller) return
      const verified = parseOpenAiUsageReport(result, days)
      lastVerifiedData.current = verified
      setData(verified)
    } catch {
      if (controller.signal.aborted || requestController.current !== controller) return
      setMessage(lastVerifiedData.current
        ? "OpenAI usage could not be refreshed. The last verified values are shown below. Please refresh to retry."
        : "OpenAI usage is unavailable. Please refresh to retry.")
    } finally {
      if (requestController.current === controller) {
        requestController.current = null
        setLoading(false)
      }
    }
  }, [days])

  useEffect(() => {
    const initialLoad = window.setTimeout(() => void loadUsage(), 0)
    return () => {
      window.clearTimeout(initialLoad)
      requestController.current?.abort()
      requestController.current = null
    }
  }, [loadUsage])

  const totals = data?.totals
  return (
    <div className={styles.page}>
      <main className={styles.shell}>
        <section className={styles.panel}>
          <header className={styles.header}>
            <div>
              <h1>OPENAI USAGE</h1>
              <p>PAGE ATTRIBUTION BY TOKENS AND REQUESTS</p>
            </div>
            <div className={styles.actions}>
              <select data-admin-view-safe="true" value={days} onChange={(event) => {
                const selected = OPENAI_USAGE_DAYS.find(value => value === Number(event.target.value))
                if (selected) onPeriodChange(selected)
              }} aria-label="Usage period">
                <option value={7}>LAST 7 DAYS</option>
                <option value={30}>LAST 30 DAYS</option>
                <option value={90}>LAST 90 DAYS</option>
              </select>
              <button type="button" onClick={() => void loadUsage()} disabled={loading}>
                {loading ? "REFRESHING..." : "REFRESH"}
              </button>
            </div>
          </header>

          {message ? <div className={styles.error} role="alert">{message}</div> : null}
          <div className={styles.verification} role="status">
            {data
              ? `${loading ? "Refreshing. " : ""}Last verified: LAST ${data.days} DAYS · ${verifiedTimeFormat.format(new Date(data.generatedAt))} HKT`
              : loading ? `Loading LAST ${days} DAYS…` : `LAST ${days} DAYS · No verified report available.`}
          </div>

          <div className={styles.metrics}>
            {[
              ["TOTAL REQUESTS", totals?.requests],
              ["TOTAL TOKENS", totals?.totalTokens],
              ["INPUT TOKENS", totals?.inputTokens],
              ["OUTPUT TOKENS", totals?.outputTokens],
              ["WEB SEARCHES", totals?.webSearchCalls],
              ["ERRORS", totals?.errors],
            ].map(([label, value]) => (
              <div key={label} className={styles.metric}>
                <span>{label}</span>
                <strong>{value === undefined ? "—" : numberFormat.format(Number(value))}</strong>
              </div>
            ))}
          </div>

          <div className={styles.note}>
            Percentages use actual tokens returned by OpenAI. Billed dollars remain authoritative in the OpenAI Usage Dashboard.
          </div>

          {!data ? <div className={styles.empty}>{loading ? "LOADING USAGE…" : "USAGE UNAVAILABLE — PLEASE REFRESH"}</div>
            : !data.pages.length ? <div className={styles.empty}>NO TRACKED OPENAI REQUESTS YET</div>
            : <div className={styles.tableWrap} tabIndex={0} role="region" aria-label="Usage by webpage">
            <table>
              <thead>
                <tr>
                  <th>WEBPAGE</th>
                  <th>TOKEN SHARE</th>
                  <th>TOKENS</th>
                  <th>REQUEST SHARE</th>
                  <th>REQUESTS</th>
                  <th>MODEL / FEATURE</th>
                  <th>AVG TIME</th>
                </tr>
              </thead>
              <tbody>
                {data.pages.map((page) => (
                  <tr key={page.pageId}>
                    <td>{isSafeOpenAiUsagePagePath(page.pagePath)
                      ? <a href={page.pagePath}>{page.pagePath}</a>
                      : page.pagePath}</td>
                    <td><strong>{page.tokenPercentage.toFixed(1)}%</strong></td>
                    <td>{numberFormat.format(page.totalTokens)}</td>
                    <td>{page.requestPercentage.toFixed(1)}%</td>
                    <td>{numberFormat.format(page.requests)}{page.errors ? ` (${page.errors} errors)` : ""}</td>
                    <td>{[page.models.join(", "), page.features.join(", ")].filter(Boolean).join(" · ") || "-"}</td>
                    <td>{numberFormat.format(page.averageDurationMs)} ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>}
        </section>
      </main>
    </div>
  )
}
