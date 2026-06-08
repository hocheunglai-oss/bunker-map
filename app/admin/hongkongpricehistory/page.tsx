"use client"

import { useEffect, useMemo, useState } from "react"
import { supabase } from "@/lib/supabase"
import { useSimpleAdminAuth } from "@/lib/useSimpleAdminAuth"
import { buildHongKongReportRows, type HongKongReportRow } from "@/lib/hongKongReport"
import { formatReportDate } from "@/lib/taiwanReport"
import { saveReportSnapshot } from "@/lib/reportSnapshots"
import { parseSimpleFormula } from "@/lib/portPricing"

type HistoryRow = {
  id: number
  port_id: number
  hsfo: number | null
  vlsfo: number | null
  mgo: number | null
  recorded_at: string
}

const monthFormatter = new Intl.DateTimeFormat("en-GB", {
  month: "long",
  timeZone: "Asia/Hong_Kong",
})

const dateFormatter = new Intl.DateTimeFormat("en-GB", {
  year: "numeric",
  month: "short",
  day: "2-digit",
  timeZone: "Asia/Hong_Kong",
})

function getHongKongDateParts(value: string) {
  const date = new Date(value)
  const year = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    timeZone: "Asia/Hong_Kong",
  }).format(date)
  const month = new Intl.DateTimeFormat("en-CA", {
    month: "2-digit",
    timeZone: "Asia/Hong_Kong",
  }).format(date)

  return { year, month }
}

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
  const { loading: adminLoading, authenticated } = useSimpleAdminAuth()
  const [rows, setRows] = useState<HistoryRow[]>([])
  const [portId, setPortId] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [deletingId, setDeletingId] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [selectedYear, setSelectedYear] = useState("all")
  const [selectedMonth, setSelectedMonth] = useState("all")
  const [formDate, setFormDate] = useState("")
  const [formHsfo, setFormHsfo] = useState("")
  const [formVlsfo, setFormVlsfo] = useState("")
  const [formMgo, setFormMgo] = useState("")
  const [publishing, setPublishing] = useState(false)
  const [published, setPublished] = useState(false)
  const [showDeleteButtons, setShowDeleteButtons] = useState(false)

  async function buildHongKongSnapshot(): Promise<{
    reportDate: string
    rows: HongKongReportRow[]
  } | null> {
    const portsWanted = ["Hong Kong"]
    const { data: portsData } = await supabase
      .from("ports")
      .select("*")
      .in("name", portsWanted)

    if (!portsData) return null

    const portIds = portsData.map((port) => port.id)
    const { data: historyData } = await supabase
      .from("price_history")
      .select("*")
      .in("port_id", portIds)
      .order("recorded_at", { ascending: false })

    if (!historyData || historyData.length === 0) return null

    return {
      reportDate: formatReportDate(historyData[0].recorded_at),
      rows: buildHongKongReportRows(portsData, historyData, portsWanted),
    }
  }

  async function syncPortFromLatestHistory(currentPortId: number) {
    const { data: latestHistory } = await supabase
      .from("price_history")
      .select("hsfo,vlsfo,mgo,recorded_at")
      .eq("port_id", currentPortId)
      .order("recorded_at", { ascending: false })
      .limit(1)
      .maybeSingle()

    if (!latestHistory) return

    await supabase
      .from("ports")
      .update({
        hsfo: latestHistory.hsfo,
        vlsfo: latestHistory.vlsfo,
        mgo: latestHistory.mgo,
        updated_at: latestHistory.recorded_at,
      })
      .eq("id", currentPortId)

    const { data: currentPort } = await supabase
      .from("ports")
      .select("name")
      .eq("id", currentPortId)
      .maybeSingle()

    const { data: allPorts } = await supabase
      .from("ports")
      .select("id,name,type,hsfo_formula,vlsfo_formula,mgo_formula")

    if (!currentPort?.name || !allPorts) return

    const dependentIds = new Set<number>()
    const queue = [String(currentPort.name).toLowerCase()]

    while (queue.length > 0) {
      const currentName = queue.shift()
      if (!currentName) continue

      for (const candidate of allPorts) {
        if (candidate.id === currentPortId || candidate.type === "divider") continue

        const formulas = [
          candidate.hsfo_formula,
          candidate.vlsfo_formula,
          candidate.mgo_formula,
        ]

        const referencesCurrent = formulas.some((formula: string | null | undefined) => {
          const parsed = parseSimpleFormula(formula)
          return parsed?.refName === currentName
        })

        if (!referencesCurrent || dependentIds.has(candidate.id)) continue

        dependentIds.add(candidate.id)
        queue.push(String(candidate.name).toLowerCase())
      }
    }

    if (dependentIds.size > 0) {
      await supabase
        .from("ports")
        .update({ updated_at: latestHistory.recorded_at })
        .in("id", Array.from(dependentIds))
    }
  }

  useEffect(() => {
    async function load() {
      setLoading(true)

      const { data: portData } = await supabase
        .from("ports")
        .select("id")
        .eq("name", "Hong Kong")
        .limit(1)
        .single()

      if (!portData) {
        setRows([])
        setLoading(false)
        return
      }

      setPortId(portData.id)

      const { data: historyData } = await supabase
        .from("price_history")
        .select("id,port_id,hsfo,vlsfo,mgo,recorded_at")
        .eq("port_id", portData.id)
        .order("recorded_at", { ascending: false })

      setRows(historyData ?? [])
      setLoading(false)
    }

    load()
  }, [])

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
    const firstConfirm = window.confirm(
      `Delete the history record on ${dateFormatter.format(new Date(row.recorded_at))}?`
    )
    if (!firstConfirm) return

    const secondConfirm = window.confirm(
      "Please confirm again. This history record will be permanently deleted."
    )
    if (!secondConfirm) return

    setDeletingId(row.id)
    await supabase.from("price_history").delete().eq("id", row.id)
    setRows((prev) => prev.filter((item) => item.id !== row.id))
    await syncPortFromLatestHistory(row.port_id)
    setDeletingId(null)
  }

  async function addMissingRecord() {
    if (!portId || !formDate) return

    const firstConfirm = window.confirm(
      `Add a missing history record for ${formDate}?`
    )
    if (!firstConfirm) return

    setSaving(true)

    const recordedAt = `${formDate}T12:00:00+08:00`

    const { data: inserted } = await supabase
      .from("price_history")
      .insert({
        port_id: portId,
        hsfo: formHsfo ? Number(formHsfo) : null,
        vlsfo: formVlsfo ? Number(formVlsfo) : null,
        mgo: formMgo ? Number(formMgo) : null,
        recorded_at: recordedAt,
      })
      .select("id,port_id,hsfo,vlsfo,mgo,recorded_at")
      .single()

    if (inserted) {
      setRows((prev) =>
        [...prev, inserted].sort(
          (a, b) =>
            new Date(b.recorded_at).getTime() - new Date(a.recorded_at).getTime()
        )
      )
      setFormDate("")
      setFormHsfo("")
      setFormVlsfo("")
      setFormMgo("")
      await syncPortFromLatestHistory(portId)
      setPublished(false)
    }

    setSaving(false)
  }

  async function addAsLatestRecord() {
    if (!portId) return

    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Hong_Kong",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date())

    const firstConfirm = window.confirm(`Add today's price as the latest record for ${today}?`)
    if (!firstConfirm) return

    setSaving(true)

    const recordedAt = `${today}T12:00:00+08:00`
    const { data: inserted } = await supabase
      .from("price_history")
      .insert({
        port_id: portId,
        hsfo: formHsfo ? Number(formHsfo) : null,
        vlsfo: formVlsfo ? Number(formVlsfo) : null,
        mgo: formMgo ? Number(formMgo) : null,
        recorded_at: recordedAt,
      })
      .select("id,port_id,hsfo,vlsfo,mgo,recorded_at")
      .single()

    if (inserted) {
      setRows((prev) =>
        [...prev, inserted].sort(
          (a, b) =>
            new Date(b.recorded_at).getTime() - new Date(a.recorded_at).getTime()
        )
      )
      setFormHsfo("")
      setFormVlsfo("")
      setFormMgo("")
      await syncPortFromLatestHistory(portId)
      setPublished(false)
    }

    setSaving(false)
  }

  async function handlePublish() {
    setPublishing(true)
    const snapshot = await buildHongKongSnapshot()
    if (snapshot) {
      await saveReportSnapshot("hongkong", snapshot)
      setPublished(true)
    }
    setPublishing(false)
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
          <h1
            style={{
              fontSize: "30px",
              margin: 0,
              lineHeight: 1,
              textTransform: "uppercase",
            }}
          >
            Hong Kong Price History
          </h1>

          <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
            <a
              href="/admin"
              className="fc-admin-nav-button"
              style={secondaryButtonStyle}
            >
              ← Back To Admin
            </a>

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
              disabled={publishing}
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
              disabled={saving || !formDate}
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
              disabled={saving}
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
          {loading ? (
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
                        {dateFormatter.format(new Date(row.recorded_at))}
                      </td>
                      <td style={{ padding: "8px 12px", fontSize: "13px", color: "var(--fc-admin-panel-text)" }}>{row.hsfo ?? "-"}</td>
                      <td style={{ padding: "8px 12px", fontSize: "13px", color: "var(--fc-admin-panel-text)" }}>{row.vlsfo ?? "-"}</td>
                      <td style={{ padding: "8px 12px", fontSize: "13px", color: "var(--fc-admin-panel-text)" }}>{row.mgo ?? "-"}</td>
                      {showDeleteButtons && (
                        <td style={{ padding: "8px 12px" }}>
                          <button
                            onClick={() => deleteHistoryRow(row)}
                            disabled={deletingId === row.id}
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
