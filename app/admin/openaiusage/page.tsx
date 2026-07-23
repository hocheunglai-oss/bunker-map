"use client"

import { useCallback, useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { canAccessAdminPage, isAdminRole } from "@/lib/adminPages"
import { useSimpleAdminAuth } from "@/lib/useSimpleAdminAuth"
import styles from "./openAiUsage.module.css"

type PageUsage = {
  pageId: string
  pagePath: string
  requests: number
  errors: number
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  reasoningTokens: number
  webSearchCalls: number
  tokenPercentage: number
  requestPercentage: number
  averageDurationMs: number
  features: string[]
  models: string[]
}

type UsageResponse = {
  generatedAt: string
  totals: {
    requests: number
    errors: number
    totalTokens: number
    inputTokens: number
    outputTokens: number
    cachedInputTokens: number
    webSearchCalls: number
  }
  pages: PageUsage[]
  message?: string
}

const numberFormat = new Intl.NumberFormat()

export default function OpenAiUsagePage() {
  const router = useRouter()
  const { loading: authLoading, authenticated, permissions, role } = useSimpleAdminAuth()
  const [days, setDays] = useState(30)
  const [data, setData] = useState<UsageResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState("")
  const canView = isAdminRole(role) || canAccessAdminPage(permissions, "openai-usage", "view")

  const loadUsage = useCallback(async () => {
    if (!authenticated || !canView) return
    setLoading(true)
    setMessage("")
    try {
      const response = await fetch(`/api/admin/openai-usage?days=${days}`, { cache: "no-store" })
      const result = (await response.json()) as UsageResponse
      if (!response.ok) throw new Error(result.message || "Could not load OpenAI usage.")
      setData(result)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not load OpenAI usage.")
    } finally {
      setLoading(false)
    }
  }, [authenticated, canView, days])

  useEffect(() => {
    document.title = "OPENAI USAGE - FC Uno"
  }, [])

  useEffect(() => {
    if (!authLoading && (!authenticated || !canView)) router.push("/admin")
  }, [authLoading, authenticated, canView, router])

  useEffect(() => {
    void loadUsage()
  }, [loadUsage])

  if (authLoading || !authenticated || !canView) return <div className={styles.page}>LOADING...</div>

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
              <select value={days} onChange={(event) => setDays(Number(event.target.value))} aria-label="Usage period">
                <option value={7}>LAST 7 DAYS</option>
                <option value={30}>LAST 30 DAYS</option>
                <option value={90}>LAST 90 DAYS</option>
              </select>
              <button type="button" onClick={() => void loadUsage()} disabled={loading}>
                {loading ? "REFRESHING..." : "REFRESH"}
              </button>
            </div>
          </header>

          {message ? <div className={styles.error}>{message.toUpperCase()}</div> : null}

          <div className={styles.metrics}>
            {[
              ["TOTAL REQUESTS", totals?.requests || 0],
              ["TOTAL TOKENS", totals?.totalTokens || 0],
              ["INPUT TOKENS", totals?.inputTokens || 0],
              ["OUTPUT TOKENS", totals?.outputTokens || 0],
              ["WEB SEARCHES", totals?.webSearchCalls || 0],
              ["ERRORS", totals?.errors || 0],
            ].map(([label, value]) => (
              <div key={label} className={styles.metric}>
                <span>{label}</span>
                <strong>{numberFormat.format(Number(value))}</strong>
              </div>
            ))}
          </div>

          <div className={styles.note}>
            Percentages use actual tokens returned by OpenAI. Billed dollars remain authoritative in the OpenAI Usage Dashboard.
          </div>

          <div className={styles.tableWrap}>
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
                {data?.pages.length ? data.pages.map((page) => (
                  <tr key={page.pageId}>
                    <td><a href={page.pagePath}>{page.pagePath}</a></td>
                    <td><strong>{page.tokenPercentage.toFixed(1)}%</strong></td>
                    <td>{numberFormat.format(page.totalTokens)}</td>
                    <td>{page.requestPercentage.toFixed(1)}%</td>
                    <td>{numberFormat.format(page.requests)}{page.errors ? ` (${page.errors} errors)` : ""}</td>
                    <td>{[page.models.join(", "), page.features.join(", ")].filter(Boolean).join(" · ") || "-"}</td>
                    <td>{numberFormat.format(page.averageDurationMs)} ms</td>
                  </tr>
                )) : (
                  <tr><td colSpan={7} className={styles.empty}>NO TRACKED OPENAI REQUESTS YET</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </div>
  )
}
