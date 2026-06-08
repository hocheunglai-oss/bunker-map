"use client"

import { useEffect, useMemo, useState } from "react"
import { supabase } from "@/lib/supabase"
import { useSimpleAdminAuth } from "@/lib/useSimpleAdminAuth"
import { buildTaiwanReportRows, formatReportDate, type TaiwanReportRow } from "@/lib/taiwanReport"
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

type CombinedHistoryRow = {
  dateKey: string
  recorded_at: string
  kaohsiungRow: HistoryRow | null
  taichungRow: HistoryRow | null
  hsfo: number | null
  vlsfoKaohsiung: number | null
  vlsfoTaichung: number | null
  mgoKaohsiung: number | null
  mgoTaichung: number | null
}

const TAIWAN_SPLIT_EFFECTIVE_FROM = "2026-04-21"

const monthFormatter = new Intl.DateTimeFormat("en-GB", {
  month: "long",
  timeZone: "Asia/Taipei",
})

const dateFormatter = new Intl.DateTimeFormat("en-GB", {
  year: "numeric",
  month: "short",
  day: "2-digit",
  timeZone: "Asia/Taipei",
})

function getTaiwanDateParts(value: string) {
  const date = new Date(value)
  const year = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    timeZone: "Asia/Taipei",
  }).format(date)
  const month = new Intl.DateTimeFormat("en-CA", {
    month: "2-digit",
    timeZone: "Asia/Taipei",
  }).format(date)
  const day = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    timeZone: "Asia/Taipei",
  }).format(date)

  return { year, month, day, dateKey: `${year}-${month}-${day}` }
}

function average(values: Array<number | null>) {
  const numbers = values.filter((value): value is number => value != null)
  if (numbers.length === 0) return null

  const total = numbers.reduce((sum, value) => sum + value, 0)
  return Number((total / numbers.length).toFixed(2))
}

const pageShellStyle: React.CSSProperties = {
  minHeight: "100vh",
  background: "var(--fc-admin-page-bg)",
  padding: "24px",
  fontFamily: "var(--fc-admin-font)",
  color: "var(--fc-admin-panel-text)",
}

const outerPanelStyle: React.CSSProperties = {
  maxWidth: "1220px",
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

const taiwanEntryGridColumns = "220px 120px repeat(4, 128px) minmax(196px, 1fr)"

export default function TaiwanPriceHistoryPage() {
  const { loading: adminLoading, authenticated } = useSimpleAdminAuth()
  const [rows, setRows] = useState<HistoryRow[]>([])
  const [kaohsiungPortId, setKaohsiungPortId] = useState<number | null>(null)
  const [taichungPortId, setTaichungPortId] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [deletingId, setDeletingId] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [selectedYear, setSelectedYear] = useState("all")
  const [selectedMonth, setSelectedMonth] = useState("all")
  const [formDate, setFormDate] = useState("")
  const [formHsfo, setFormHsfo] = useState("")
  const [formVlsfoKaohsiung, setFormVlsfoKaohsiung] = useState("")
  const [formVlsfoTaichung, setFormVlsfoTaichung] = useState("")
  const [formMgoKaohsiung, setFormMgoKaohsiung] = useState("")
  const [formMgoTaichung, setFormMgoTaichung] = useState("")
  const [publishing, setPublishing] = useState(false)
  const [published, setPublished] = useState(false)
  const [showDeleteButtons, setShowDeleteButtons] = useState(false)

  async function buildTaiwanSnapshot(): Promise<{
    reportDate: string
    rows: TaiwanReportRow[]
    remark: string
    specialNotice: string
  } | null> {
    const portsWanted = ["Kaohsiung", "Keelung", "Taichung", "Suao", "Hualien"]
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

    const { data: remarksData } = await supabase
      .from("remarks")
      .select("*")
      .in("id", [1, 2])

    const remarkData = remarksData?.find((item) => item.id === 1)
    const noticeData = remarksData?.find((item) => item.id === 2)

    return {
      reportDate: formatReportDate(historyData[0].recorded_at),
      rows: buildTaiwanReportRows(portsData, historyData, portsWanted),
      remark: remarkData?.content || "",
      specialNotice: noticeData?.content || "",
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
        .select("id,name")
        .in("name", ["Kaohsiung", "Taichung"])

      const kaohsiung = portData?.find((port) => port.name === "Kaohsiung") ?? null
      const taichung = portData?.find((port) => port.name === "Taichung") ?? null

      if (!kaohsiung || !taichung) {
        setRows([])
        setLoading(false)
        return
      }

      setKaohsiungPortId(kaohsiung.id)
      setTaichungPortId(taichung.id)

      const { data: historyData } = await supabase
        .from("price_history")
        .select("id,port_id,hsfo,vlsfo,mgo,recorded_at")
        .in("port_id", [kaohsiung.id, taichung.id])
        .order("recorded_at", { ascending: false })

      setRows(historyData ?? [])
      setLoading(false)
    }

    load()
  }, [])

  const combinedRows = useMemo<CombinedHistoryRow[]>(() => {
    const grouped = new Map<
      string,
      { recorded_at: string; kaohsiungRow: HistoryRow | null; taichungRow: HistoryRow | null }
    >()

    for (const row of rows) {
      const { dateKey } = getTaiwanDateParts(row.recorded_at)
      const current = grouped.get(dateKey) ?? {
        recorded_at: row.recorded_at,
        kaohsiungRow: null,
        taichungRow: null,
      }

      if (new Date(row.recorded_at) > new Date(current.recorded_at)) {
        current.recorded_at = row.recorded_at
      }

      if (row.port_id === kaohsiungPortId) current.kaohsiungRow = row
      if (row.port_id === taichungPortId) current.taichungRow = row
      grouped.set(dateKey, current)
    }

    return Array.from(grouped.entries())
      .map(([dateKey, value]) => {
        const isBeforeSplit = dateKey < TAIWAN_SPLIT_EFFECTIVE_FROM
        const khh = value.kaohsiungRow
        const txg = value.taichungRow

        return {
          dateKey,
          recorded_at: value.recorded_at,
          kaohsiungRow: khh,
          taichungRow: txg,
          hsfo: khh?.hsfo ?? null,
          vlsfoKaohsiung: khh?.vlsfo ?? null,
          vlsfoTaichung: txg?.vlsfo ?? (isBeforeSplit ? khh?.vlsfo ?? null : null),
          mgoKaohsiung: khh?.mgo ?? null,
          mgoTaichung: txg?.mgo ?? (isBeforeSplit ? khh?.mgo ?? null : null),
        }
      })
      .sort((a, b) => new Date(b.recorded_at).getTime() - new Date(a.recorded_at).getTime())
  }, [kaohsiungPortId, rows, taichungPortId])

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
    const firstConfirm = window.confirm(
      `Delete the history record on ${dateFormatter.format(new Date(row.recorded_at))}?`
    )
    if (!firstConfirm) return

    const secondConfirm = window.confirm(
      "Please confirm again. This history record will be permanently deleted."
    )
    if (!secondConfirm) return

    const idsToDelete = [row.kaohsiungRow?.id, row.taichungRow?.id].filter(
      (value): value is number => value != null
    )

    if (idsToDelete.length === 0) return

    setDeletingId(idsToDelete[0])
    await supabase.from("price_history").delete().in("id", idsToDelete)
    setRows((prev) => prev.filter((item) => !idsToDelete.includes(item.id)))
    if (kaohsiungPortId) await syncPortFromLatestHistory(kaohsiungPortId)
    if (taichungPortId) await syncPortFromLatestHistory(taichungPortId)
    setDeletingId(null)
  }

  async function insertTaiwanHistory(recordedAt: string) {
    if (!kaohsiungPortId || !taichungPortId) return []

    const { data } = await supabase
      .from("price_history")
      .insert([
        {
          port_id: kaohsiungPortId,
          hsfo: formHsfo ? Number(formHsfo) : null,
          vlsfo: formVlsfoKaohsiung ? Number(formVlsfoKaohsiung) : null,
          mgo: formMgoKaohsiung ? Number(formMgoKaohsiung) : null,
          recorded_at: recordedAt,
        },
        {
          port_id: taichungPortId,
          hsfo: null,
          vlsfo: formVlsfoTaichung ? Number(formVlsfoTaichung) : null,
          mgo: formMgoTaichung ? Number(formMgoTaichung) : null,
          recorded_at: recordedAt,
        },
      ])
      .select("id,port_id,hsfo,vlsfo,mgo,recorded_at")

    return data ?? []
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
    if (!formDate) return
    const firstConfirm = window.confirm(`Add a missing history record for ${formDate}?`)
    if (!firstConfirm) return

    setSaving(true)
    const inserted = await insertTaiwanHistory(`${formDate}T12:00:00+08:00`)

    if (inserted.length > 0) {
      setRows((prev) =>
        [...prev, ...inserted].sort(
          (a, b) => new Date(b.recorded_at).getTime() - new Date(a.recorded_at).getTime()
        )
      )
      resetForm()
      if (kaohsiungPortId) await syncPortFromLatestHistory(kaohsiungPortId)
      if (taichungPortId) await syncPortFromLatestHistory(taichungPortId)
      setPublished(false)
    }

    setSaving(false)
  }

  async function addAsLatestRecord() {
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Taipei",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date())

    const firstConfirm = window.confirm(`Add today's price as the latest record for ${today}?`)
    if (!firstConfirm) return

    setSaving(true)
    const inserted = await insertTaiwanHistory(`${today}T12:00:00+08:00`)

    if (inserted.length > 0) {
      setRows((prev) =>
        [...prev, ...inserted].sort(
          (a, b) => new Date(b.recorded_at).getTime() - new Date(a.recorded_at).getTime()
        )
      )
      setFormHsfo("")
      setFormVlsfoKaohsiung("")
      setFormVlsfoTaichung("")
      setFormMgoKaohsiung("")
      setFormMgoTaichung("")
      if (kaohsiungPortId) await syncPortFromLatestHistory(kaohsiungPortId)
      if (taichungPortId) await syncPortFromLatestHistory(taichungPortId)
      setPublished(false)
    }

    setSaving(false)
  }

  async function handlePublish() {
    setPublishing(true)
    const snapshot = await buildTaiwanSnapshot()
    if (snapshot) {
      await saveReportSnapshot("taiwan", snapshot)
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
            Taiwan Price History
          </h1>

          <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
            <a href="/admin" className="fc-admin-nav-button" style={secondaryButtonStyle}>
              ← Back To Admin
            </a>

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

        <div style={{ ...sectionCardStyle, padding: "10px 16px 12px", marginBottom: "14px", overflowX: "auto" }}>
          <div style={{ display: "grid", gap: "2px" }}>
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
                onChange={(event) => setFormVlsfoKaohsiung(event.target.value)}
                style={{ ...controlStyle, width: "100%", height: "38px", textAlign: "center" }}
              />
            </label>

            <label style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
              <span style={{ fontSize: "12px", fontWeight: 700, color: "var(--fc-admin-panel-text)", textAlign: "center", letterSpacing: "0.02em", lineHeight: 1.1 }}>Taichung</span>
              <input
                value={formVlsfoTaichung}
                onChange={(event) => setFormVlsfoTaichung(event.target.value)}
                style={{ ...controlStyle, width: "100%", height: "38px", textAlign: "center" }}
              />
            </label>

            <label style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
              <span style={{ fontSize: "12px", fontWeight: 700, color: "var(--fc-admin-panel-text)", textAlign: "center", letterSpacing: "0.02em", lineHeight: 1.1 }}>Kaohsiung</span>
              <input
                value={formMgoKaohsiung}
                onChange={(event) => setFormMgoKaohsiung(event.target.value)}
                style={{ ...controlStyle, width: "100%", height: "38px", textAlign: "center" }}
              />
            </label>

            <label style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
              <span style={{ fontSize: "12px", fontWeight: 700, color: "var(--fc-admin-panel-text)", textAlign: "center", letterSpacing: "0.02em", lineHeight: 1.1 }}>Taichung</span>
              <input
                value={formMgoTaichung}
                onChange={(event) => setFormMgoTaichung(event.target.value)}
                style={{ ...controlStyle, width: "100%", height: "38px", textAlign: "center" }}
              />
            </label>

            <div style={{ display: "grid", gap: "6px", alignSelf: "end" }}>
              <button
                onClick={addMissingRecord}
                disabled={saving || !formDate}
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
                disabled={saving}
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

        <div style={{ ...sectionCardStyle, overflow: "hidden" }}>
          {loading ? (
            <p style={{ margin: 0, padding: "14px", color: "var(--fc-admin-panel-text)" }}>Loading history...</p>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
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
                        {dateFormatter.format(new Date(row.recorded_at))}
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
                            disabled={deletingId === row.kaohsiungRow?.id || deletingId === row.taichungRow?.id}
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
