"use client"

import { useCallback, useEffect, useState } from "react"
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
        <span>{lastYear} / {selectedYear}</span>
      </div>
      <div className="spc-stat-monthly-chart">
        {points.map((point) => (
          <div className="spc-stat-month" key={point.month}>
            <div className="spc-stat-month-bars">
              <div className="spc-stat-month-bar">
                <span className="spc-stat-month-value">{formatNumber(point.lastYearVolume)}</span>
                <i
                  className="is-last"
                  title={`${lastYear} ${point.month}: ${formatNumber(point.lastYearVolume)}`}
                  style={{ height: `${Math.max(2, (point.lastYearVolume / maxValue) * 88)}%` }}
                />
              </div>
              <div className="spc-stat-month-bar">
                <span className="spc-stat-month-value">{formatNumber(point.currentYearVolume)}</span>
                <i
                  className="is-current"
                  title={`${selectedYear} ${point.month}: ${formatNumber(point.currentYearVolume)}`}
                  style={{ height: `${Math.max(2, (point.currentYearVolume / maxValue) * 88)}%` }}
                />
              </div>
            </div>
            <span className="spc-stat-month-label">{point.month}</span>
          </div>
        ))}
      </div>
      <div className="spc-stat-legend">
        <span><i className="is-last" />{lastYear}</span>
        <span><i className="is-current" />{selectedYear}</span>
      </div>
    </section>
  )
}

function WorkloadTable({ rows, windowLabel }: { rows: SpcWorkloadRow[]; windowLabel: string }) {
  return (
    <section className="spc-panel spc-stat-table-panel">
      <div className="spc-panel-header"><h2>TABLE 1 · SPC WORKLOAD</h2><span>{windowLabel}</span></div>
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

function HitRateTable({ title, rows, windowLabel }: { title: string; rows: SpcHitRateRow[]; windowLabel: string }) {
  return (
    <section className="spc-panel spc-stat-table-panel">
      <div className="spc-panel-header"><h2>{title}</h2><span>{windowLabel}</span></div>
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

function SupplierTraderCountTable({ rows, windowLabel }: { rows: SpcChartPoint[]; windowLabel: string }) {
  return (
    <section className="spc-panel spc-stat-table-panel">
      <div className="spc-panel-header"><h2>TABLE 4 · FIXTURES BY SUPPLIER TRADER</h2><span>{windowLabel}</span></div>
      <div className="spc-table-wrap">
        <table className="spc-table spc-stat-table">
          <thead><tr><th>SUPPLIER TRADER</th><th>FIXTURES</th></tr></thead>
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
  const [year] = useState(hongKongYear)
  const [statistics, setStatistics] = useState<SpcStatisticsPayload | null>(null)
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState("")

  const canView = authenticated && canAccessSpcPage(permissions, "spc-statistics", "view")
  const hasPermissionSnapshot = Object.prototype.hasOwnProperty.call(permissions, "spc-statistics")

  const loadData = useCallback(async (forceRefresh = false) => {
    if (!canView) return
    setLoading(true)
    setMessage("")
    try {
      const params = new URLSearchParams({ year: String(year) })
      if (forceRefresh) params.set("refresh", "1")
      const response = await fetch(`/api/spc/statistics?${params.toString()}`, { cache: "no-store" })
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

  const windowLabel = statistics?.windowLabel || "LAST 90 DAYS"

  return (
    <SpcShell title="SPC STATISTICS">
      <div className="spc-statistics-page">
        <div className="spc-stat-toolbar">
          <div className="spc-stat-controls">
            <button type="button" className="spc-fixture-refresh-button" onClick={() => void loadData(true)} disabled={loading}>
              {loading ? "REFRESHING..." : "REFRESH"}
            </button>
          </div>
        </div>

        {message ? <div className="spc-alert is-error">{message}</div> : null}

        <MonthlyVolumeChart
          points={statistics?.monthlyVolume || []}
          selectedYear={statistics?.selectedYear || year}
          lastYear={statistics?.lastYear || year - 1}
        />

        <div className="spc-stat-chart-grid">
          <HorizontalBarChart title="GRAPH 2 · VOLUME BY SUPPLIER" points={statistics?.volumeBySupplier || []} valueLabel={`${windowLabel} · MTS`} />
          <HorizontalBarChart title="GRAPH 3 · FIXTURES BY SUPPLIER" points={statistics?.fixturesBySupplier || []} valueLabel={`${windowLabel} · COUNT`} />
          <HorizontalBarChart title="GRAPH 4 · VOLUME BY OFFICE" points={statistics?.volumeByOffice || []} valueLabel={`${windowLabel} · MTS`} />
          <HorizontalBarChart title="GRAPH 5 · FIXTURES BY OFFICE" points={statistics?.fixturesByOffice || []} valueLabel={`${windowLabel} · COUNT`} />
        </div>

        <div className="spc-stat-table-grid">
          <WorkloadTable rows={statistics?.workload || []} windowLabel={windowLabel} />
          <HitRateTable title="TABLE 2 · BUYER OFFICE HIT RATE" rows={statistics?.buyerOfficeHitRate || []} windowLabel={windowLabel} />
          <HitRateTable title="TABLE 3 · BUYER TRADER HIT RATE" rows={statistics?.buyerTraderHitRate || []} windowLabel={windowLabel} />
          <SupplierTraderCountTable rows={statistics?.supplierTraderFixtureCount || []} windowLabel={windowLabel} />
        </div>
      </div>
    </SpcShell>
  )
}
