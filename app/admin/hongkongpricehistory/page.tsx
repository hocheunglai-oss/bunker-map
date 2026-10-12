"use client"

import { useMemo, useRef, useState } from "react"
import { useSimpleAdminAuth } from "@/lib/useSimpleAdminAuth"
import { useReportPublication } from "@/lib/useReportPublication"
import { ReportPublicationStatus } from "@/components/ReportPublicationStatus"
import { canAccessAdminPage, isAdminRole } from "@/lib/adminPages"
import { historyPrice } from "@/lib/marketPriceHistory"
import { useMarketPriceHistory } from "@/lib/useMarketPriceHistory"
import { formatPriceHistoryDate, getPriceHistoryDateParts as getHongKongDateParts, sortAdminPriceHistoryRows as sortHistoryRows } from "@/lib/adminPriceHistory"
import {
  getMarketDateKey,
  distinctPriceHistoryDates,
  type PriceHistoryPortId,
  type PriceHistoryRecordId,
} from "@/lib/priceHistoryRecords"

type HistoryRow = {
  id: PriceHistoryRecordId
  port_id: PriceHistoryPortId
  hsfo: number | null
  vlsfo: number | null
  mgo: number | null
  recorded_at: string
}

const monthFormatter = new Intl.DateTimeFormat("en-GB", {
  month: "long",
  timeZone: "Asia/Hong_Kong",
})

function average(values: Array<number | null>) {
  const numbers = values.filter((value): value is number => value != null)
  if (numbers.length === 0) return null

  const total = numbers.reduce((sum, value) => sum + value, 0)
  return Number((total / numbers.length).toFixed(2))
}

const pageShellStyle: React.CSSProperties = {
  minHeight: "100vh",
  background:
    "var(--fc-admin-page-bg)",
  padding: "24px",
  fontFamily: "var(--fc-admin-font)",
  color: "var(--fc-admin-panel-text)",
}

const outerPanelStyle: React.CSSProperties = {
  maxWidth: "920px",
  margin: "0 auto",
  background:
    "var(--fc-admin-panel-bg)",
  border: "1px solid var(--fc-admin-border)",
  borderRadius: "24px",
  padding: "22px",
  boxShadow: "0 18px 42px #00000012",
}

const sectionCardStyle: React.CSSProperties = {
  background:
    "var(--fc-admin-panel-bg)",
  border: "1px solid var(--fc-admin-border-soft)",
  borderRadius: "22px",
  boxShadow: "0 12px 28px #00000010",
}

const controlStyle: React.CSSProperties = {
  padding: "9px 12px",
  borderRadius: "12px",
  border: "1px solid var(--fc-admin-border)",
  background: "var(--fc-tool-input-bg)",
  color: "var(--fc-admin-panel-text)",
  boxShadow: "none",
}

const secondaryButtonStyle: React.CSSProperties = {
  padding: "9px 14px",
  minWidth: "118px",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  border: "1px solid var(--fc-admin-border)",
  borderRadius: "999px",
  background: "var(--fc-admin-button-bg)",
  color: "var(--fc-admin-button-text)",
  textDecoration: "none",
  fontSize: "13px",
  fontWeight: 700,
  boxShadow: "none",
}

export default function HongKongPriceHistoryPage() {
  const { loading: adminLoading, authenticated, role, permissions } = useSimpleAdminAuth()
  const canEdit = isAdminRole(role) || canAccessAdminPage(permissions, "hongkong-price-history", "edit")
  const history = useMarketPriceHistory("hongkong", !adminLoading && authenticated, canEdit)
  const publication = useReportPublication("hongkong", "hongkong-price-history", !adminLoading && authenticated, canEdit)
  const rows = useMemo(() => sortHistoryRows(distinctPriceHistoryDates(history.snapshot?.rows ?? [])), [history.snapshot])
  const portId = history.snapshot?.ports[0]?.id ?? null
  const loading = history.loading
  const [deletingId, setDeletingId] = useState<PriceHistoryRecordId | null>(null)
  const [saving, setSaving] = useState(false)
  const [selectedYear, setSelectedYear] = useState("all")
  const [selectedMonth, setSelectedMonth] = useState("all")
  const [formDate, setFormDate] = useState("")
  const [formHsfo, setFormHsfo] = useState("")
  const [formVlsfo, setFormVlsfo] = useState("")
  const [formMgo, setFormMgo] = useState("")
  const { publishing, published } = publication
  const [publishMessage, setPublishMessage] = useState("")
  const [showDeleteButtons, setShowDeleteButtons] = useState(false)
  const actionLock = useRef(false)
  const busy = saving || deletingId !== null || publishing || history.changing || loading

  const years = useMemo(() => {
    return [...new Set(rows.map((row) => getHongKongDateParts(row.recorded_at).year))]
      .sort((a, b) => Number(b) - Number(a))
  }, [rows])

  const filteredRows = useMemo(() => {
    return rows.filter((row) => {
      const parts = getHongKongDateParts(row.recorded_at)
      const matchesYear = selectedYear === "all" || parts.year === selectedYear
      const matchesMonth = selectedMonth === "all" || parts.month === selectedMonth
      return matchesYear && matchesMonth
    })
  }, [rows, selectedYear, selectedMonth])

  const showMonthlyAverage = selectedYear !== "all" && selectedMonth !== "all"

  const monthlyAverage = useMemo(() => {
    if (!showMonthlyAverage) return null

    return {
      hsfo: average(filteredRows.map((row) => row.hsfo)),
      vlsfo: average(filteredRows.map((row) => row.vlsfo)),
      mgo: average(filteredRows.map((row) => row.mgo)),
    }
  }, [filteredRows, showMonthlyAverage])

  async function deleteHistoryRow(row: HistoryRow) {
    if (!canEdit || !history.ready || actionLock.current) return
    const firstConfirm = window.confirm(
      `Delete the history record on ${formatPriceHistoryDate(row.recorded_at)}?`
    )
    if (!firstConfirm) return

    const secondConfirm = window.confirm(
      "Please confirm again. All history records for this market day will be permanently deleted. Current prices will follow the remaining latest day, or become empty if none remains."
    )
    if (!secondConfirm) return

    actionLock.current = true
    setDeletingId(row.id)
    publication.invalidate()
    try {
      if (await history.change(getMarketDateKey(row.recorded_at), "delete", [])) await publication.reload(true)
    } finally { setDeletingId(null); actionLock.current = false }
  }

  async function addMissingRecord() {
    await saveDay(formDate, true)
  }

  async function addAsLatestRecord() {
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Hong_Kong",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date())

    await saveDay(today, false)
  }

  async function saveDay(day: string, resetDate: boolean) {
    if (!canEdit || !portId || !day || !history.ready || actionLock.current) return
    if (!window.confirm(`Save history prices for ${day}? Any existing prices for this market day will be replaced.`)) return
    actionLock.current = true
    setSaving(true)
    setPublishMessage("")
    try {
      const values = [{ port_id: portId, hsfo: historyPrice(formHsfo), vlsfo: historyPrice(formVlsfo), mgo: historyPrice(formMgo) }]
      publication.invalidate()
      if (await history.change(day, "save", values)) {
        if (resetDate) setFormDate("")
        setFormHsfo(""); setFormVlsfo(""); setFormMgo("")
        await publication.reload(true)
      }
    } catch { setPublishMessage("Check the prices. Use positive numbers, zero or empty fields.") }
    finally { setSaving(false); actionLock.current = false }
  }

  async function handlePublish() {
    if (!canEdit || !history.ready || !publication.ready || actionLock.current) return
    if ((formDate || formHsfo || formVlsfo || formMgo) && !window.confirm("Publish saved history only? Your unsaved inputs will not be included.")) return
    actionLock.current = true
    setPublishMessage("")
    try {
      await publication.publish()
    } finally {
      actionLock.current = false
    }
  }

  if (!adminLoading && !authenticated) return <p style={{ padding: "40px" }}>Access Denied</p>
  if (adminLoading) return <p style={{ padding: "40px" }}>Loading...</p>

  return (
    <div style={pageShellStyle}>
      <div style={outerPanelStyle}>
        <div
          style={{
            position: "sticky",
            top: "0",
            zIndex: 20,
            margin: "-22px -22px 20px",
            padding: "18px 22px 14px",
            background: "var(--fc-admin-panel-bg)",
            borderBottom: "1px solid var(--fc-admin-border)",
            borderTopLeftRadius: "24px",
            borderTopRightRadius: "24px",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: "16px",
            flexWrap: "wrap",
          }}
        >
          <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
            <a
              href="/reports/hongkong"
              target="_blank"
              rel="noopener noreferrer"
              style={{
                ...secondaryButtonStyle,
                border: "1px solid var(--fc-admin-warning-border)",
                background: "var(--fc-admin-warning-bg)",
                color: "var(--fc-admin-warning-text)",
              }}
            >
              Check
            </a>

            <button
              onClick={handlePublish}
              disabled={!canEdit || busy || !history.ready || !publication.ready}
              style={{
                ...secondaryButtonStyle,
                border: published ? "1px solid var(--fc-admin-border)" : "1px solid var(--fc-admin-selected-border)",
                background: published
                  ? secondaryButtonStyle.background
                  : "var(--fc-admin-primary-button-bg)",
                color: published ? "var(--fc-admin-button-text)" : "var(--fc-admin-primary-button-text)",
                cursor: "pointer",
                boxShadow: "none",
              }}
            >
              {publishing ? "Publishing..." : published ? "Published" : "Publish"}
            </button>

            <button
              type="button"
              onClick={() => setShowDeleteButtons((prev) => !prev)}
              disabled={!canEdit || busy || !history.ready}
              style={{
                ...secondaryButtonStyle,
                cursor: "pointer",
                background: "var(--fc-admin-danger-bg)",
                border: "1px solid var(--fc-admin-danger-border)",
                color: "var(--fc-admin-danger-text)",
              }}
            >
              {showDeleteButtons ? "Hide Delete" : "Show Delete"}
            </button>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "14px" }}>
          <button onClick={() => { if (!actionLock.current) void history.reload() }} disabled={busy} style={secondaryButtonStyle}>Reload saved history</button>
          {!canEdit && <span>View only</span>}
          {history.message && <p role={history.needsReload ? "alert" : "status"}>{history.message}</p>}
        </div>
        <ReportPublicationStatus title="Hong Kong" publication={publication} busy={busy} />
        {publishMessage && (
          <div
            role="status"
            style={{
              marginBottom: "14px",
              padding: "10px 12px",
              borderRadius: "12px",
              border: published
                ? "1px solid var(--fc-admin-success-border)"
                : "1px solid var(--fc-admin-danger-border)",
              background: published
                ? "var(--fc-admin-success-bg)"
                : "var(--fc-admin-danger-bg)",
              color: published
                ? "var(--fc-admin-success-text)"
                : "var(--fc-admin-danger-text)",
              fontSize: "13px",
              fontWeight: 700,
            }}
          >
            {publishMessage}
          </div>
        )}

        <div style={{ ...sectionCardStyle, padding: "16px", marginBottom: "14px" }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "12px", alignItems: "end", justifyContent: "space-between" }}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "10px", alignItems: "end", width: "100%" }}>
              <label style={{ display: "flex", flex: "1 1 160px", minWidth: 0, flexDirection: "column", gap: "6px" }}>
                <span style={{ fontSize: "13px", fontWeight: 700, color: "var(--fc-admin-panel-text)" }}>Year</span>
                <select
                  value={selectedYear}
                  onChange={(event) => setSelectedYear(event.target.value)}
                  style={{
                    ...controlStyle,
                    width: "100%",
                  }}
                >
                  <option value="all">All years</option>
                  {years.map((year) => (
                    <option key={year} value={year}>{year}</option>
                  ))}
                </select>
              </label>

              <label style={{ display: "flex", flex: "1 1 160px", minWidth: 0, flexDirection: "column", gap: "6px" }}>
                <span style={{ fontSize: "13px", fontWeight: 700, color: "var(--fc-admin-panel-text)" }}>Month</span>
                <select
                  value={selectedMonth}
                  onChange={(event) => setSelectedMonth(event.target.value)}
                  style={{
                    ...controlStyle,
                    width: "100%",
                  }}
                >
                  <option value="all">All months</option>
                  {Array.from({ length: 12 }, (_, index) => {
                    const month = String(index + 1).padStart(2, "0")
                    return (
                      <option key={month} value={month}>
                        {monthFormatter.format(new Date(`2024-${month}-01T00:00:00+08:00`))}
                      </option>
                    )
                  })}
                </select>
              </label>

              <div
                style={{
                  minHeight: "58px",
                  flex: "2 1 280px",
                  minWidth: 0,
                  padding: "10px 12px",
                  borderRadius: "16px",
                  background: "var(--fc-admin-panel-soft-bg)",
                  border: "1px solid var(--fc-admin-border-soft)",
                  fontSize: "13px",
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "center",
                  gap: "4px",
                  overflowWrap: "anywhere",
                  boxShadow: "none",
                }}
              >
                <strong style={{ color: "var(--fc-admin-panel-text)" }}>Monthly Average</strong>
                {showMonthlyAverage && monthlyAverage ? (
                  <span style={{ color: "var(--fc-admin-panel-text)" }}>
                    HSFO: {monthlyAverage.hsfo ?? "-"} | VLSFO: {monthlyAverage.vlsfo ?? "-"} | MGO: {monthlyAverage.mgo ?? "-"}
                  </span>
                ) : (
                  <span style={{ color: "var(--fc-admin-muted)" }}>Select both year and month to show data.</span>
                )}
              </div>
            </div>
          </div>
        </div>

        <div style={{ ...sectionCardStyle, padding: "16px", marginBottom: "14px" }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "end" }}>
            {[
              { label: "Date", value: formDate, setter: setFormDate, type: "date", width: undefined },
              { label: "HSFO", value: formHsfo, setter: setFormHsfo, type: "text", width: "90px" },
              { label: "VLSFO", value: formVlsfo, setter: setFormVlsfo, type: "text", width: "90px" },
              { label: "MGO", value: formMgo, setter: setFormMgo, type: "text", width: "90px" },
            ].map((field) => (
              <label key={field.label} style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                <span style={{ fontSize: "13px", fontWeight: 700, color: "var(--fc-admin-panel-text)" }}>{field.label}</span>
                <input
                  disabled={!canEdit || busy || !history.ready}
                  type={field.type}
                  value={field.value}
                  onChange={(event) => field.setter(event.target.value)}
                  style={{
                    ...controlStyle,
                    width: field.width,
                  }}
                />
              </label>
            ))}

            <button
              onClick={addMissingRecord}
              disabled={!canEdit || busy || !history.ready || !formDate}
              style={{
                ...secondaryButtonStyle,
                background: saving || !formDate
                  ? "var(--fc-admin-warning-bg)"
                  : "var(--fc-admin-warning-bg)",
                color: saving || !formDate ? "var(--fc-admin-warning-text)" : "var(--fc-admin-warning-text)",
                border: saving || !formDate
                  ? "1px solid var(--fc-admin-warning-border)"
                  : "1px solid var(--fc-admin-warning-border)",
                cursor: saving ? "wait" : "pointer",
                height: "42px",
              }}
            >
              {saving ? "Saving..." : "Add Missing Record"}
            </button>

            <button
              onClick={addAsLatestRecord}
              disabled={!canEdit || busy || !history.ready}
              style={{
                ...secondaryButtonStyle,
                background: "var(--fc-admin-success-bg)",
                color: "var(--fc-admin-success-text)",
                border: "1px solid var(--fc-admin-success-border)",
                cursor: saving ? "wait" : "pointer",
                height: "42px",
                textDecoration: "none",
                boxShadow: "none",
              }}
            >
              {saving ? "Saving..." : "Add As Latest"}
            </button>
          </div>
        </div>

        <div style={{ ...sectionCardStyle, overflow: "hidden" }}>
          {history.needsReload ? <p role="status" style={{ padding: "14px" }}>History is not verified. Reload saved history before making changes.</p> : loading ? (
            <p style={{ margin: 0, padding: "14px", color: "var(--fc-admin-panel-text)" }}>Loading history...</p>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ background: "var(--fc-table-head-bg)", color: "var(--fc-admin-panel-text)" }}>
                    {["Date", "HSFO", "VLSFO", "MGO", ...(showDeleteButtons ? ["Delete"] : [])].map((label) => (
                      <th
                        key={label}
                        style={{
                          padding: "10px 12px",
                          textAlign: "left",
                          fontSize: "13px",
                          textTransform: "uppercase",
                          letterSpacing: "0.08em",
                        }}
                      >
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filteredRows.map((row, index) => (
                    <tr
                      key={row.id}
                      style={{
                        background: index % 2 === 0 ? "var(--fc-admin-panel-soft-bg)" : "var(--fc-admin-panel-bg)",
                      }}
                    >
                      <td style={{ padding: "8px 12px", fontSize: "13px", whiteSpace: "nowrap", color: "var(--fc-admin-panel-text)" }}>
                        {formatPriceHistoryDate(row.recorded_at)}
                      </td>
                      <td style={{ padding: "8px 12px", fontSize: "13px", color: "var(--fc-admin-panel-text)" }}>{row.hsfo ?? "-"}</td>
                      <td style={{ padding: "8px 12px", fontSize: "13px", color: "var(--fc-admin-panel-text)" }}>{row.vlsfo ?? "-"}</td>
                      <td style={{ padding: "8px 12px", fontSize: "13px", color: "var(--fc-admin-panel-text)" }}>{row.mgo ?? "-"}</td>
                      {showDeleteButtons && (
                        <td style={{ padding: "8px 12px" }}>
                          <button
                            onClick={() => deleteHistoryRow(row)}
                            disabled={!canEdit || busy || !history.ready}
                            style={{
                              background: "var(--fc-admin-danger-bg)",
                              color: "var(--fc-admin-danger-text)",
                              border: "1px solid var(--fc-admin-danger-border)",
                              borderRadius: "999px",
                              padding: "7px 12px",
                              cursor: "pointer",
                              fontSize: "12px",
                              fontWeight: 700,
                              boxShadow: "none",
                            }}
                          >
                            {deletingId === row.id ? "Deleting..." : "Delete"}
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                  {filteredRows.length === 0 && (
                    <tr>
                      <td colSpan={showDeleteButtons ? 5 : 4} style={{ padding: "16px", textAlign: "center", fontSize: "13px", color: "var(--fc-admin-panel-text)" }}>
                        No history records found for the current filters.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
