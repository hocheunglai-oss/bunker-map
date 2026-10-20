"use client"

import { useMemo, useRef, useState } from "react"
import { useSimpleAdminAuth } from "@/lib/useSimpleAdminAuth"
import { useReportPublication } from "@/lib/useReportPublication"
import { ReportPublicationStatus } from "@/components/ReportPublicationStatus"
import { canAccessAdminPage, isAdminRole } from "@/lib/adminPages"
import { historyPrice, marketPortHasName } from "@/lib/marketPriceHistory"
import { useMarketPriceHistory } from "@/lib/useMarketPriceHistory"
import { combineTaiwanPriceHistory, formatPriceHistoryDate, getPriceHistoryDateParts as getTaiwanDateParts, type CombinedTaiwanHistoryRow as CombinedHistoryRow } from "@/lib/adminPriceHistory"
import {
  type PriceHistoryRecordId,
} from "@/lib/priceHistoryRecords"

const monthFormatter = new Intl.DateTimeFormat("en-GB", {
  month: "long",
  timeZone: "Asia/Taipei",
})

function average(values: Array<number | null>) {
  const numbers = values.filter((value): value is number => value != null)
  if (numbers.length === 0) return null

  const total = numbers.reduce((sum, value) => sum + value, 0)
  return Number((total / numbers.length).toFixed(2))
}

const pageShellStyle: React.CSSProperties = {
  minHeight: "100vh",
  minWidth: 0,
  background: "var(--fc-admin-page-bg)",
  padding: "24px",
  fontFamily: "var(--fc-admin-font)",
  color: "var(--fc-admin-panel-text)",
}

const outerPanelStyle: React.CSSProperties = {
  maxWidth: "1220px",
  minWidth: 0,
  margin: "0 auto",
  background: "var(--fc-admin-panel-bg)",
  border: "1px solid var(--fc-admin-border)",
  borderRadius: "24px",
  padding: "22px",
  boxShadow: "0 18px 42px #00000012",
}

const sectionCardStyle: React.CSSProperties = {
  background: "var(--fc-admin-panel-bg)",
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

const taiwanEntryGridColumns = "220px 120px repeat(4, 128px) minmax(160px, 1fr)"

export default function TaiwanPriceHistoryPage() {
  const { loading: adminLoading, authenticated, role, permissions } = useSimpleAdminAuth()
  const canEdit = isAdminRole(role) || canAccessAdminPage(permissions, "taiwan-price-history", "edit")
  const history = useMarketPriceHistory("taiwan", !adminLoading && authenticated, canEdit)
  const publication = useReportPublication("taiwan", "taiwan-price-history", !adminLoading && authenticated, canEdit)
  const rows = history.snapshot?.rows
  const kaohsiungPortId = history.snapshot?.ports.find(port => marketPortHasName(port, "Kaohsiung"))?.id ?? null
  const taichungPortId = history.snapshot?.ports.find(port => marketPortHasName(port, "Taichung"))?.id ?? null
  const loading = history.loading
  const [deletingId, setDeletingId] = useState<PriceHistoryRecordId | null>(null)
  const [saving, setSaving] = useState(false)
  const [selectedYear, setSelectedYear] = useState("all")
  const [selectedMonth, setSelectedMonth] = useState("all")
  const [formDate, setFormDate] = useState("")
  const [formHsfo, setFormHsfo] = useState("")
  const [formVlsfoKaohsiung, setFormVlsfoKaohsiung] = useState("")
  const [formVlsfoTaichung, setFormVlsfoTaichung] = useState("")
  const [formMgoKaohsiung, setFormMgoKaohsiung] = useState("")
  const [formMgoTaichung, setFormMgoTaichung] = useState("")
  const { publishing, published } = publication
  const [publishMessage, setPublishMessage] = useState("")
  const [showDeleteButtons, setShowDeleteButtons] = useState(false)
  const actionLock = useRef(false)
  const busy = saving || deletingId !== null || publishing || history.changing || loading

  const combinedRows = useMemo(() => combineTaiwanPriceHistory(rows ?? [], kaohsiungPortId, taichungPortId), [kaohsiungPortId, rows, taichungPortId])

  const years = useMemo(() => {
    return [...new Set(combinedRows.map((row) => getTaiwanDateParts(row.recorded_at).year))]
      .sort((a, b) => Number(b) - Number(a))
  }, [combinedRows])

  const filteredRows = useMemo(() => {
    return combinedRows.filter((row) => {
      const parts = getTaiwanDateParts(row.recorded_at)
      const matchesYear = selectedYear === "all" || parts.year === selectedYear
      const matchesMonth = selectedMonth === "all" || parts.month === selectedMonth
      return matchesYear && matchesMonth
    })
  }, [combinedRows, selectedMonth, selectedYear])

  const showMonthlyAverage = selectedYear !== "all" && selectedMonth !== "all"

  const monthlyAverage = useMemo(() => {
    if (!showMonthlyAverage) return null

    return {
      hsfo: average(filteredRows.map((row) => row.hsfo)),
      vlsfoKaohsiung: average(filteredRows.map((row) => row.vlsfoKaohsiung)),
      vlsfoTaichung: average(filteredRows.map((row) => row.vlsfoTaichung)),
      mgoKaohsiung: average(filteredRows.map((row) => row.mgoKaohsiung)),
      mgoTaichung: average(filteredRows.map((row) => row.mgoTaichung)),
      count: filteredRows.length,
    }
  }, [filteredRows, showMonthlyAverage])

  async function deleteHistoryRow(row: CombinedHistoryRow) {
    if (!canEdit || !history.ready || actionLock.current) return
    const firstConfirm = window.confirm(
      `Delete the history record on ${formatPriceHistoryDate(row.recorded_at)}?`
    )
    if (!firstConfirm) return

    const secondConfirm = window.confirm(
      "Please confirm again. All records for both Taiwan ports on this day will be permanently deleted. Current prices will follow the remaining latest day, or become empty if none remains."
    )
    if (!secondConfirm) return

    actionLock.current = true
    setDeletingId(row.kaohsiungRow?.id ?? row.taichungRow?.id ?? null)
    publication.invalidate()
    try {
      if (await history.change(row.dateKey, "delete", [])) await publication.reload(true)
    } finally { setDeletingId(null); actionLock.current = false }
  }

  function resetForm() {
    setFormDate("")
    setFormHsfo("")
    setFormVlsfoKaohsiung("")
    setFormVlsfoTaichung("")
    setFormMgoKaohsiung("")
    setFormMgoTaichung("")
  }

  async function addMissingRecord() {
    await saveDay(formDate, true)
  }

  async function addAsLatestRecord() {
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Taipei",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date())

    await saveDay(today, false)
  }

  async function saveDay(day: string, resetDate: boolean) {
    if (!canEdit || !day || !kaohsiungPortId || !taichungPortId || !history.ready || actionLock.current) return
    if (!window.confirm(`Save history prices for ${day}? Any existing prices for both Taiwan ports on this day will be replaced.`)) return
    actionLock.current = true
    setSaving(true)
    setPublishMessage("")
    try {
      const values = [
        { port_id: kaohsiungPortId, hsfo: historyPrice(formHsfo), vlsfo: historyPrice(formVlsfoKaohsiung), mgo: historyPrice(formMgoKaohsiung) },
        { port_id: taichungPortId, hsfo: null, vlsfo: historyPrice(formVlsfoTaichung), mgo: historyPrice(formMgoTaichung) },
      ]
      publication.invalidate()
      if (await history.change(day, "save", values)) {
        const previousDate = formDate
        resetForm()
        if (!resetDate) setFormDate(previousDate)
        await publication.reload(true)
      }
    } catch { setPublishMessage("Check the prices. Use positive numbers, zero or empty fields.") }
    finally { setSaving(false); actionLock.current = false }
  }

  async function handlePublish() {
    if (!canEdit || !history.ready || !publication.ready || actionLock.current) return
    if ((formDate || formHsfo || formVlsfoKaohsiung || formVlsfoTaichung || formMgoKaohsiung || formMgoTaichung)
      && !window.confirm("Publish saved history only? Your unsaved inputs will not be included.")) return
    actionLock.current = true
    setPublishMessage("")
    try {
      await publication.publish()
    } finally { actionLock.current = false }
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
              href="/reports/taiwan"
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
        <ReportPublicationStatus title="Taiwan" publication={publication} busy={busy} />
        {publishMessage && <p role="status">{publishMessage}</p>}

        <div style={{ ...sectionCardStyle, padding: "16px", marginBottom: "14px" }}>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: "12px",
              alignItems: "end",
              justifyContent: "space-between",
            }}
          >
            <div style={{ display: "flex", flexWrap: "wrap", gap: "10px", alignItems: "end", width: "100%" }}>
              <label style={{ display: "flex", flex: "1 1 160px", minWidth: 0, flexDirection: "column", gap: "6px" }}>
                <span style={{ fontSize: "13px", fontWeight: 700, color: "var(--fc-admin-panel-text)" }}>Year</span>
                <select
                  data-admin-view-safe="true"
                  value={selectedYear}
                  onChange={(event) => setSelectedYear(event.target.value)}
                  style={{ ...controlStyle, width: "100%" }}
                >
                  <option value="all">All years</option>
                  {years.map((year) => (
                    <option key={year} value={year}>
                      {year}
                    </option>
                  ))}
                </select>
              </label>

              <label style={{ display: "flex", flex: "1 1 160px", minWidth: 0, flexDirection: "column", gap: "6px" }}>
                <span style={{ fontSize: "13px", fontWeight: 700, color: "var(--fc-admin-panel-text)" }}>Month</span>
                <select
                  data-admin-view-safe="true"
                  value={selectedMonth}
                  onChange={(event) => setSelectedMonth(event.target.value)}
                  style={{ ...controlStyle, width: "100%" }}
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
                  flex: "2 1 420px",
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
                    HSFO: {monthlyAverage.hsfo ?? "-"} | VLSFO Kaohsiung: {monthlyAverage.vlsfoKaohsiung ?? "-"} | VLSFO Taichung: {monthlyAverage.vlsfoTaichung ?? "-"} | MGO Kaohsiung: {monthlyAverage.mgoKaohsiung ?? "-"} | MGO Taichung: {monthlyAverage.mgoTaichung ?? "-"}
                  </span>
                ) : (
                  <span style={{ color: "var(--fc-admin-muted)" }}>Select both year and month to show data.</span>
                )}
              </div>
            </div>
          </div>
        </div>

        <fieldset disabled={!canEdit || busy || !history.ready} aria-label="Taiwan history price entry" style={{ ...sectionCardStyle, margin: "0 0 14px", minWidth: 0, padding: "10px 16px 12px" }}>
          <div role="region" aria-label="Taiwan history price entry fields" tabIndex={0} style={{ overflowX: "auto", maxWidth: "100%", overscrollBehaviorX: "contain", WebkitOverflowScrolling: "touch", outlineOffset: "-2px" }}>
          <div style={{ display: "grid", gap: "2px", minWidth: "1060px" }}>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: taiwanEntryGridColumns,
                gap: "8px",
                alignItems: "end",
                marginBottom: "-2px",
              }}
            >
              <div style={{ minHeight: "1px" }} />
              <div style={{ minHeight: "1px" }} />
              <div
                style={{
                  gridColumn: "3 / span 2",
                  textAlign: "center",
                  fontSize: "12px",
                  fontWeight: 800,
                  color: "var(--fc-admin-panel-text)",
                  letterSpacing: "0.06em",
                  textTransform: "uppercase",
                  lineHeight: 1,
                }}
              >
                VLSFO
              </div>
              <div
                style={{
                  gridColumn: "5 / span 2",
                  textAlign: "center",
                  fontSize: "12px",
                  fontWeight: 800,
                  color: "var(--fc-admin-panel-text)",
                  letterSpacing: "0.06em",
                  textTransform: "uppercase",
                  lineHeight: 1,
                }}
              >
                MGO
              </div>
              <div style={{ minHeight: "1px" }} />
            </div>

            <div style={{ display: "grid", gridTemplateColumns: taiwanEntryGridColumns, gap: "8px", alignItems: "end" }}>
            <label style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
              <span style={{ fontSize: "13px", fontWeight: 700, color: "var(--fc-admin-panel-text)" }}>Date</span>
              <input
                type="date"
                value={formDate}
                onChange={(event) => setFormDate(event.target.value)}
                style={{ ...controlStyle, height: "38px" }}
              />
            </label>

            <label style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
              <span style={{ fontSize: "13px", fontWeight: 700, color: "var(--fc-admin-panel-text)", textAlign: "center" }}>HSFO</span>
              <input
                value={formHsfo}
                onChange={(event) => setFormHsfo(event.target.value)}
                style={{ ...controlStyle, width: "100%", height: "38px", textAlign: "center" }}
              />
            </label>

            <label style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
              <span style={{ fontSize: "12px", fontWeight: 700, color: "var(--fc-admin-panel-text)", textAlign: "center", letterSpacing: "0.02em", lineHeight: 1.1 }}>Kaohsiung</span>
              <input
                value={formVlsfoKaohsiung}
                aria-label="VLSFO Kaohsiung"
                onChange={(event) => setFormVlsfoKaohsiung(event.target.value)}
                style={{ ...controlStyle, width: "100%", height: "38px", textAlign: "center" }}
              />
            </label>

            <label style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
              <span style={{ fontSize: "12px", fontWeight: 700, color: "var(--fc-admin-panel-text)", textAlign: "center", letterSpacing: "0.02em", lineHeight: 1.1 }}>Taichung</span>
              <input
                value={formVlsfoTaichung}
                aria-label="VLSFO Taichung"
                onChange={(event) => setFormVlsfoTaichung(event.target.value)}
                style={{ ...controlStyle, width: "100%", height: "38px", textAlign: "center" }}
              />
            </label>

            <label style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
              <span style={{ fontSize: "12px", fontWeight: 700, color: "var(--fc-admin-panel-text)", textAlign: "center", letterSpacing: "0.02em", lineHeight: 1.1 }}>Kaohsiung</span>
              <input
                value={formMgoKaohsiung}
                aria-label="MGO Kaohsiung"
                onChange={(event) => setFormMgoKaohsiung(event.target.value)}
                style={{ ...controlStyle, width: "100%", height: "38px", textAlign: "center" }}
              />
            </label>

            <label style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
              <span style={{ fontSize: "12px", fontWeight: 700, color: "var(--fc-admin-panel-text)", textAlign: "center", letterSpacing: "0.02em", lineHeight: 1.1 }}>Taichung</span>
              <input
                value={formMgoTaichung}
                aria-label="MGO Taichung"
                onChange={(event) => setFormMgoTaichung(event.target.value)}
                style={{ ...controlStyle, width: "100%", height: "38px", textAlign: "center" }}
              />
            </label>

            <div style={{ display: "grid", gap: "6px", alignSelf: "end" }}>
              <button
                onClick={addMissingRecord}
                disabled={!canEdit || busy || !history.ready || !formDate}
                style={{
                  ...secondaryButtonStyle,
                  width: "100%",
                  background: saving || !formDate
                    ? "var(--fc-admin-warning-bg)"
                    : "var(--fc-admin-warning-bg)",
                  color: saving || !formDate ? "var(--fc-admin-warning-text)" : "var(--fc-admin-warning-text)",
                  border: saving || !formDate
                    ? "1px solid var(--fc-admin-warning-border)"
                    : "1px solid var(--fc-admin-warning-border)",
                  cursor: saving ? "wait" : "pointer",
                  height: "38px",
                }}
              >
                {saving ? "Saving..." : "Add Missing Record"}
              </button>

              <button
                onClick={addAsLatestRecord}
                disabled={!canEdit || busy || !history.ready}
                style={{
                  ...secondaryButtonStyle,
                  width: "100%",
                  background: "var(--fc-admin-success-bg)",
                  color: "var(--fc-admin-success-text)",
                  border: "1px solid var(--fc-admin-success-border)",
                  cursor: saving ? "wait" : "pointer",
                  height: "38px",
                  boxShadow: "none",
                }}
              >
                {saving ? "Saving..." : "Add As Latest"}
              </button>
            </div>
          </div>
          </div>
          </div>
        </fieldset>

        <div style={{ ...sectionCardStyle, overflow: "hidden" }}>
          {history.needsReload ? <p role="status" style={{ padding: "14px" }}>History is not verified. Reload saved history before making changes.</p> : loading ? (
            <p style={{ margin: 0, padding: "14px", color: "var(--fc-admin-panel-text)" }}>Loading history...</p>
          ) : (
            <div role="region" aria-label="Taiwan price history table" tabIndex={0} style={{ overflowX: "auto", maxWidth: "100%", overscrollBehaviorX: "contain", WebkitOverflowScrolling: "touch", outlineOffset: "-2px" }}>
              <table aria-label="Taiwan price history" style={{ width: "100%", minWidth: showDeleteButtons ? "868px" : "756px", borderCollapse: "collapse", tableLayout: "fixed", overflowWrap: "anywhere" }}>
                <colgroup>
                  <col style={{ width: "144px" }} />
                  <col style={{ width: "100px" }} />
                  {Array.from({ length: 4 }, (_, index) => <col key={index} style={{ width: "128px" }} />)}
                  {showDeleteButtons && <col style={{ width: "112px" }} />}
                </colgroup>
                <thead>
                  <tr style={{ background: "var(--fc-table-head-bg)", color: "var(--fc-admin-panel-text)" }}>
                    <th
                      rowSpan={2}
                      style={{
                        padding: "10px 12px",
                        textAlign: "left",
                        fontSize: "13px",
                        textTransform: "uppercase",
                        letterSpacing: "0.08em",
                        verticalAlign: "middle",
                      }}
                    >
                      Date
                    </th>
                    <th
                      rowSpan={2}
                      style={{
                        padding: "10px 12px",
                        textAlign: "left",
                        fontSize: "13px",
                        textTransform: "uppercase",
                        letterSpacing: "0.08em",
                        verticalAlign: "middle",
                      }}
                    >
                      HSFO
                    </th>
                    <th
                      colSpan={2}
                      style={{
                        padding: "10px 12px 6px",
                        textAlign: "center",
                        fontSize: "13px",
                        textTransform: "uppercase",
                        letterSpacing: "0.08em",
                      }}
                    >
                      VLSFO
                    </th>
                    <th
                      colSpan={2}
                      style={{
                        padding: "10px 12px 6px",
                        textAlign: "center",
                        fontSize: "13px",
                        textTransform: "uppercase",
                        letterSpacing: "0.08em",
                      }}
                    >
                      MGO
                    </th>
                    {showDeleteButtons && (
                      <th
                        rowSpan={2}
                        style={{
                          padding: "10px 12px",
                          textAlign: "left",
                          fontSize: "13px",
                          textTransform: "uppercase",
                          letterSpacing: "0.08em",
                          verticalAlign: "middle",
                        }}
                      >
                        Delete
                      </th>
                    )}
                  </tr>
                  <tr style={{ background: "var(--fc-table-head-bg)", color: "var(--fc-admin-panel-text)" }}>
                    {["Kaohsiung", "Taichung", "Kaohsiung", "Taichung"].map((label, index) => (
                      <th
                        key={`${label}-${index}`}
                        style={{
                          padding: "6px 12px 10px",
                          textAlign: "center",
                          fontSize: "11px",
                          letterSpacing: "0.03em",
                          color: "var(--fc-admin-muted)",
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
                      key={row.dateKey}
                      style={{
                        background: index % 2 === 0 ? "var(--fc-admin-panel-soft-bg)" : "var(--fc-admin-panel-bg)",
                      }}
                    >
                      <td style={{ padding: "8px 12px", fontSize: "13px", whiteSpace: "nowrap", color: "var(--fc-admin-panel-text)" }}>
                        {formatPriceHistoryDate(row.recorded_at)}
                      </td>
                      <td style={{ padding: "8px 12px", fontSize: "13px", color: "var(--fc-admin-panel-text)", textAlign: "center" }}>{row.hsfo ?? "-"}</td>
                      <td style={{ padding: "8px 12px", fontSize: "13px", color: "var(--fc-admin-panel-text)", textAlign: "center" }}>{row.vlsfoKaohsiung ?? "-"}</td>
                      <td style={{ padding: "8px 12px", fontSize: "13px", color: "var(--fc-admin-panel-text)", textAlign: "center" }}>{row.vlsfoTaichung ?? "-"}</td>
                      <td style={{ padding: "8px 12px", fontSize: "13px", color: "var(--fc-admin-panel-text)", textAlign: "center" }}>{row.mgoKaohsiung ?? "-"}</td>
                      <td style={{ padding: "8px 12px", fontSize: "13px", color: "var(--fc-admin-panel-text)", textAlign: "center" }}>{row.mgoTaichung ?? "-"}</td>
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
                            {deletingId === row.kaohsiungRow?.id || deletingId === row.taichungRow?.id ? "Deleting..." : "Delete"}
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                  {filteredRows.length === 0 && (
                    <tr>
                      <td colSpan={showDeleteButtons ? 7 : 6} style={{ padding: "16px", textAlign: "center", fontSize: "13px", color: "var(--fc-admin-panel-text)" }}>
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
