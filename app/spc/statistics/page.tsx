"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { SpcShell } from "@/components/SpcShell"
import { useSpcAuth } from "@/lib/useSpcAuth"
import { canAccessSpcPage } from "@/lib/spcPages"
import type {
  SpcChartPoint,
  SpcHitRateRow,
  SpcMonthlyVolumePoint,
  SpcStatisticsPayload,
  SpcWorkloadRow,
} from "@/lib/spcStatistics"

function hongKongYear() {
  const year = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Hong_Kong",
    year: "numeric",
  }).format(new Date())
  return Number(year) || new Date().getFullYear()
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: value % 1 === 0 ? 0 : 1 }).format(value)
}

function formatPercent(value: number) {
  return `${formatNumber(value)}%`
}

function formatDate(value: string | null | undefined) {
  if (!value) return "-"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "-"
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date).toUpperCase()
}

function maxPointValue(points: SpcChartPoint[]) {
  return Math.max(1, ...points.map((point) => point.value))
}

function EmptyRow({ colSpan }: { colSpan: number }) {
  return <tr className="spc-fixture-empty-row"><td colSpan={colSpan}>NO DATA.</td></tr>
}

function HorizontalBarChart({ title, points, valueLabel }: { title: string; points: SpcChartPoint[]; valueLabel: string }) {
  const maxValue = maxPointValue(points)
  return (
    <section className="spc-panel spc-stat-card">
      <div className="spc-panel-header">
        <h2>{title}</h2>
        <span>{valueLabel}</span>
      </div>
      <div className="spc-stat-bars">
        {points.map((point) => (
          <div className="spc-stat-bar-row" key={point.label}>
            <span>{point.label}</span>
            <div>
              <i style={{ width: `${Math.max(2, (point.value / maxValue) * 100)}%` }} />
            </div>
            <strong>{formatNumber(point.value)}</strong>
          </div>
        ))}
        {points.length === 0 ? <p className="spc-stat-empty">NO DATA.</p> : null}
      </div>
    </section>
  )
}

function MonthlyVolumeChart({
  points,
  selectedYear,
  lastYear,
}: {
  points: SpcMonthlyVolumePoint[]
  selectedYear: number
  lastYear: number
}) {
  const maxValue = Math.max(1, ...points.flatMap((point) => [point.currentYearVolume, point.lastYearVolume]))
  return (
    <section className="spc-panel spc-stat-card spc-stat-monthly-panel">
      <div className="spc-panel-header">
        <h2>GRAPH 1 · MONTHLY VOLUME</h2>
        <span>{selectedYear} / {lastYear}</span>
      </div>
      <div className="spc-stat-monthly-chart">
        {points.map((point) => (
          <div className="spc-stat-month" key={point.month}>
            <div className="spc-stat-month-bars">
              <i
                className="is-current"
                title={`${selectedYear} ${point.month}: ${formatNumber(point.currentYearVolume)}`}
                style={{ height: `${Math.max(2, (point.currentYearVolume / maxValue) * 100)}%` }}
              />
              <i
                className="is-last"
                title={`${lastYear} ${point.month}: ${formatNumber(point.lastYearVolume)}`}
                style={{ height: `${Math.max(2, (point.lastYearVolume / maxValue) * 100)}%` }}
              />
            </div>
            <span>{point.month}</span>
          </div>
        ))}
      </div>
      <div className="spc-stat-legend">
        <span><i className="is-current" />{selectedYear}</span>
        <span><i className="is-last" />{lastYear}</span>
      </div>
    </section>
  )
}

function WorkloadTable({ rows }: { rows: SpcWorkloadRow[] }) {
  return (
    <section className="spc-panel spc-stat-table-panel">
      <div className="spc-panel-header"><h2>TABLE 1 · SPC WORKLOAD</h2></div>
      <div className="spc-table-wrap">
        <table className="spc-table spc-stat-table">
          <thead><tr><th>PERIOD</th><th>ENQUIRIES</th><th>DAYS</th><th>AVG / DAY</th></tr></thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.period}>
                <td><strong>{row.period}</strong></td>
                <td>{formatNumber(row.enquiries)}</td>
                <td>{formatNumber(row.days)}</td>
                <td>{formatNumber(row.averagePerDay)}</td>
              </tr>
            ))}
            {rows.length === 0 ? <EmptyRow colSpan={4} /> : null}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function HitRateTable({ title, rows }: { title: string; rows: SpcHitRateRow[] }) {
  return (
    <section className="spc-panel spc-stat-table-panel">
      <div className="spc-panel-header"><h2>{title}</h2></div>
      <div className="spc-table-wrap">
        <table className="spc-table spc-stat-table">
          <thead><tr><th>NAME</th><th>ENQUIRIES</th><th>FIXTURES</th><th>HIT RATE</th></tr></thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label}>
                <td><strong>{row.label}</strong></td>
                <td>{formatNumber(row.enquiries)}</td>
                <td>{formatNumber(row.fixtures)}</td>
                <td>{formatPercent(row.hitRate)}</td>
              </tr>
            ))}
            {rows.length === 0 ? <EmptyRow colSpan={4} /> : null}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function SupplierCountTable({ rows }: { rows: SpcChartPoint[] }) {
  return (
    <section className="spc-panel spc-stat-table-panel">
      <div className="spc-panel-header"><h2>TABLE 4 · FIXTURES BY SUPPLIER</h2></div>
      <div className="spc-table-wrap">
        <table className="spc-table spc-stat-table">
          <thead><tr><th>SUPPLIER</th><th>FIXTURES</th></tr></thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label}>
                <td><strong>{row.label}</strong></td>
                <td>{formatNumber(row.value)}</td>
              </tr>
            ))}
            {rows.length === 0 ? <EmptyRow colSpan={2} /> : null}
          </tbody>
        </table>
      </div>
    </section>
  )
}

export default function SpcStatisticsPage() {
  const router = useRouter()
  const { loading: authLoading, authenticated, permissions } = useSpcAuth()
  const [year, setYear] = useState(hongKongYear)
  const [statistics, setStatistics] = useState<SpcStatisticsPayload | null>(null)
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState("")

  const canView = authenticated && canAccessSpcPage(permissions, "spc-statistics", "view")
  const hasPermissionSnapshot = Object.prototype.hasOwnProperty.call(permissions, "spc-statistics")
  const yearOptions = useMemo(() => {
    const options = new Set([year, year - 1, ...(statistics?.yearOptions || [])])
    return Array.from(options).sort((a, b) => b - a)
  }, [statistics, year])

  const loadData = useCallback(async () => {
    if (!canView) return
    setLoading(true)
    setMessage("")
    try {
      const response = await fetch(`/api/spc/statistics?year=${year}`, { cache: "no-store" })
      const data = (await response.json()) as SpcStatisticsPayload & { message?: string }
      if (!response.ok) throw new Error(data.message || "Failed to load SPC statistics.")
      setStatistics(data)
    } catch (error) {
      setMessage(error instanceof Error ? error.message.toUpperCase() : "FAILED TO LOAD SPC STATISTICS.")
    } finally {
      setLoading(false)
    }
  }, [canView, year])

  useEffect(() => {
    document.title = "SPC STATISTICS"
  }, [])

  useEffect(() => {
    if (!authLoading && !authenticated) router.replace("/spc")
    if (!authLoading && authenticated && hasPermissionSnapshot && !canView) router.replace("/spc")
  }, [authLoading, authenticated, canView, hasPermissionSnapshot, router])

  useEffect(() => {
    void loadData()
  }, [loadData])

  if (authLoading || !authenticated || !hasPermissionSnapshot || !canView) {
    return <div className="spc-loading">LOADING...</div>
  }

  return (
    <SpcShell title="SPC STATISTICS">
      <div className="spc-statistics-page">
        <section className="spc-panel spc-stat-toolbar-panel">
          <div className="spc-stat-toolbar">
            <div>
              <h1>STATISTICS</h1>
              <span>{formatDate(statistics?.generatedAt)}</span>
            </div>
            <div className="spc-stat-controls">
              <select value={year} onChange={(event) => setYear(Number(event.target.value))} aria-label="Statistics year">
                {yearOptions.map((option) => (
                  <option key={option} value={option}>{option}</option>
                ))}
              </select>
              <button type="button" className="spc-fixture-refresh-button" onClick={() => void loadData()} disabled={loading}>
                {loading ? "REFRESHING..." : "REFRESH"}
              </button>
            </div>
          </div>
        </section>

        {message ? <div className="spc-alert is-error">{message}</div> : null}

        <section className="spc-stat-summary-grid" aria-label="Statistics source counts">
          {[
            ["GRAPH FIXTURES", statistics?.sourceCounts.graphFixtures || 0],
            ["IMPORTED FIXTURES", statistics?.sourceCounts.importedFixtures || 0],
            ["TABLE ENQUIRIES", statistics?.sourceCounts.nativeEnquiries || 0],
            ["TABLE FIXTURES", statistics?.sourceCounts.nativeFixtures || 0],
          ].map(([label, value]) => (
            <article className="spc-panel" key={label}>
              <span>{label}</span>
              <strong>{formatNumber(Number(value))}</strong>
            </article>
          ))}
        </section>

        <MonthlyVolumeChart
          points={statistics?.monthlyVolume || []}
          selectedYear={statistics?.selectedYear || year}
          lastYear={statistics?.lastYear || year - 1}
        />

        <div className="spc-stat-chart-grid">
          <HorizontalBarChart title="GRAPH 2 · VOLUME BY SUPPLIER" points={statistics?.volumeBySupplier || []} valueLabel="MTS" />
          <HorizontalBarChart title="GRAPH 3 · FIXTURES BY SUPPLIER" points={statistics?.fixturesBySupplier || []} valueLabel="COUNT" />
          <HorizontalBarChart title="GRAPH 4 · VOLUME BY OFFICE" points={statistics?.volumeByOffice || []} valueLabel="MTS" />
          <HorizontalBarChart title="GRAPH 5 · FIXTURES BY OFFICE" points={statistics?.fixturesByOffice || []} valueLabel="COUNT" />
        </div>

        <div className="spc-stat-table-grid">
          <WorkloadTable rows={statistics?.workload || []} />
          <HitRateTable title="TABLE 2 · BUYER OFFICE HIT RATE" rows={statistics?.buyerOfficeHitRate || []} />
          <HitRateTable title="TABLE 3 · BUYER TRADER HIT RATE" rows={statistics?.buyerTraderHitRate || []} />
          <SupplierCountTable rows={statistics?.supplierFixtureCount || []} />
        </div>
      </div>
    </SpcShell>
  )
}
