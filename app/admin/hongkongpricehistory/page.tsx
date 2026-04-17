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
    "linear-gradient(180deg, #0a2c4c 0%, #06213b 32%, #041629 100%)",
  padding: "24px",
  fontFamily: "Arial, Helvetica, sans-serif",
  color: "#edf7ff",
}

const outerPanelStyle: React.CSSProperties = {
  maxWidth: "920px",
  margin: "0 auto",
  background:
    "linear-gradient(180deg, rgba(6, 24, 44, 0.62) 0%, rgba(7, 27, 49, 0.54) 100%)",
  border: "1px solid rgba(210, 236, 255, 0.16)",
  borderRadius: "24px",
  padding: "22px",
  backdropFilter: "blur(18px)",
  WebkitBackdropFilter: "blur(18px)",
  boxShadow: "0 24px 70px rgba(0, 0, 0, 0.2), inset 0 1px 0 rgba(255,255,255,0.06)",
}

const sectionCardStyle: React.CSSProperties = {
  background:
    "linear-gradient(180deg, rgba(14, 43, 70, 0.88) 0%, rgba(7, 26, 44, 0.86) 100%)",
  border: "1px solid rgba(210, 236, 255, 0.14)",
  borderRadius: "22px",
  boxShadow: "0 20px 44px rgba(0, 0, 0, 0.18), inset 0 1px 0 rgba(255,255,255,0.05)",
}

const controlStyle: React.CSSProperties = {
  padding: "9px 12px",
  borderRadius: "12px",
  border: "1px solid rgba(210,236,255,0.16)",
  background: "linear-gradient(180deg, rgba(255,255,255,0.11) 0%, rgba(255,255,255,0.05) 100%)",
  color: "#edf7ff",
  boxShadow: "inset 0 1px 0 rgba(255,255,255,0.05)",
}

const secondaryButtonStyle: React.CSSProperties = {
  padding: "9px 14px",
  minWidth: "118px",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  border: "1px solid rgba(210,236,255,0.16)",
  borderRadius: "999px",
  background: "linear-gradient(180deg, rgba(255,255,255,0.18) 0%, rgba(255,255,255,0.1) 100%)",
  color: "#d7e8ff",
  textDecoration: "none",
  fontSize: "13px",
  fontWeight: 700,
  boxShadow: "inset 0 1px 0 rgba(255,255,255,0.05)",
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
            background: "linear-gradient(180deg, rgba(6, 24, 44, 0.62) 0%, rgba(7, 27, 49, 0.54) 100%)",
            backdropFilter: "blur(18px)",
            WebkitBackdropFilter: "blur(18px)",
            borderBottom: "1px solid rgba(210, 236, 255, 0.16)",
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
                border: "1px solid rgba(255, 120, 120, 0.16)",
                background: "linear-gradient(180deg, rgba(210, 74, 74, 0.18) 0%, rgba(170, 47, 53, 0.1) 100%)",
                color: "#ffd4d8",
              }}
            >
              Check
            </a>

            <button
              onClick={handlePublish}
              disabled={publishing}
              style={{
                ...secondaryButtonStyle,
                border: published ? "1px solid rgba(210,236,255,0.16)" : "1px solid rgba(80, 170, 255, 0.18)",
                background: published
                  ? secondaryButtonStyle.background
                  : "linear-gradient(180deg, rgba(72, 170, 255, 0.34) 0%, rgba(20, 112, 196, 0.18) 100%)",
                color: published ? "#d7e8ff" : "#e2f3ff",
                cursor: "pointer",
                boxShadow: published ? secondaryButtonStyle.boxShadow : "inset 0 1px 0 rgba(255,255,255,0.08), 0 0 0 1px rgba(80,170,255,0.06)",
              }}
            >
              {publishing ? "Publishing..." : published ? "Published" : "Publish"}
            </button>
          </div>
        </div>

        <div style={{ ...sectionCardStyle, padding: "16px", marginBottom: "14px" }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "12px", alignItems: "end", justifyContent: "space-between" }}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "10px", alignItems: "end" }}>
              <label style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                <span style={{ fontSize: "13px", fontWeight: 700, color: "#dff3ff" }}>Year</span>
                <select
                  value={selectedYear}
                  onChange={(event) => setSelectedYear(event.target.value)}
                  style={{
                    ...controlStyle,
                    minWidth: "160px",
                  }}
                >
                  <option value="all">All years</option>
                  {years.map((year) => (
                    <option key={year} value={year}>{year}</option>
                  ))}
                </select>
              </label>

              <label style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                <span style={{ fontSize: "13px", fontWeight: 700, color: "#dff3ff" }}>Month</span>
                <select
                  value={selectedMonth}
                  onChange={(event) => setSelectedMonth(event.target.value)}
                  style={{
                    ...controlStyle,
                    minWidth: "160px",
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
                  minWidth: "280px",
                  padding: "10px 12px",
                  borderRadius: "16px",
                  background: "linear-gradient(180deg, rgba(255,255,255,0.08) 0%, rgba(255,255,255,0.04) 100%)",
                  border: "1px solid rgba(210,236,255,0.14)",
                  fontSize: "13px",
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "center",
                  gap: "4px",
                  boxShadow: "inset 0 1px 0 rgba(255,255,255,0.05)",
                }}
              >
                <strong style={{ color: "#dff3ff" }}>Monthly Average</strong>
                {showMonthlyAverage && monthlyAverage ? (
                  <span style={{ color: "#edf7ff" }}>
                    HSFO: {monthlyAverage.hsfo ?? "-"} | VLSFO: {monthlyAverage.vlsfo ?? "-"} | MGO: {monthlyAverage.mgo ?? "-"}
                  </span>
                ) : (
                  <span style={{ color: "#9db9cf" }}>Select both year and month to show data.</span>
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
                <span style={{ fontSize: "13px", fontWeight: 700, color: "#dff3ff" }}>{field.label}</span>
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
                  ? "linear-gradient(180deg, rgba(236, 193, 79, 0.16) 0%, rgba(176, 132, 26, 0.08) 100%)"
                  : "linear-gradient(180deg, rgba(236, 193, 79, 0.28) 0%, rgba(176, 132, 26, 0.14) 100%)",
                color: saving || !formDate ? "#f3dfac" : "#ffe7a6",
                border: saving || !formDate
                  ? "1px solid rgba(236, 193, 79, 0.16)"
                  : "1px solid rgba(236, 193, 79, 0.24)",
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
                background: "linear-gradient(180deg, rgba(56, 214, 154, 0.26) 0%, rgba(20, 130, 93, 0.12) 100%)",
                color: "#ddffef",
                border: "1px solid rgba(73, 219, 165, 0.22)",
                cursor: saving ? "wait" : "pointer",
                height: "42px",
                textDecoration: "none",
                boxShadow: "inset 0 1px 0 rgba(255,255,255,0.06), 0 0 0 1px rgba(73,219,165,0.04)",
              }}
            >
              {saving ? "Saving..." : "Add As Latest"}
            </button>
          </div>
        </div>

        <div style={{ ...sectionCardStyle, overflow: "hidden" }}>
          {loading ? (
            <p style={{ margin: 0, padding: "14px", color: "#dff3ff" }}>Loading history...</p>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ background: "rgba(7, 31, 54, 0.88)", color: "white" }}>
                    {["Date", "HSFO", "VLSFO", "MGO", "Delete"].map((label) => (
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
                        background: index % 2 === 0 ? "rgba(255,255,255,0.05)" : "rgba(255,255,255,0.025)",
                      }}
                    >
                      <td style={{ padding: "8px 12px", fontSize: "13px", whiteSpace: "nowrap", color: "#edf7ff" }}>
                        {dateFormatter.format(new Date(row.recorded_at))}
                      </td>
                      <td style={{ padding: "8px 12px", fontSize: "13px", color: "#edf7ff" }}>{row.hsfo ?? "-"}</td>
                      <td style={{ padding: "8px 12px", fontSize: "13px", color: "#edf7ff" }}>{row.vlsfo ?? "-"}</td>
                      <td style={{ padding: "8px 12px", fontSize: "13px", color: "#edf7ff" }}>{row.mgo ?? "-"}</td>
                      <td style={{ padding: "8px 12px" }}>
                        <button
                          onClick={() => deleteHistoryRow(row)}
                          disabled={deletingId === row.id}
                          style={{
                            background: "linear-gradient(180deg, rgba(230, 57, 70, 0.18) 0%, rgba(230, 57, 70, 0.1) 100%)",
                            color: "#ffd4d8",
                            border: "1px solid rgba(255, 120, 120, 0.16)",
                            borderRadius: "999px",
                            padding: "7px 12px",
                            cursor: "pointer",
                            fontSize: "12px",
                            fontWeight: 700,
                            boxShadow: "inset 0 1px 0 rgba(255,255,255,0.05)",
                          }}
                        >
                          {deletingId === row.id ? "Deleting..." : "Delete"}
                        </button>
                      </td>
                    </tr>
                  ))}
                  {filteredRows.length === 0 && (
                    <tr>
                      <td colSpan={5} style={{ padding: "16px", textAlign: "center", fontSize: "13px", color: "#dff3ff" }}>
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
