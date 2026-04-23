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
  background: "linear-gradient(180deg, #0a2c4c 0%, #06213b 32%, #041629 100%)",
  padding: "24px",
  fontFamily: "Arial, Helvetica, sans-serif",
  color: "#edf7ff",
}

const outerPanelStyle: React.CSSProperties = {
  maxWidth: "1220px",
  margin: "0 auto",
  background: "linear-gradient(180deg, rgba(6, 24, 44, 0.62) 0%, rgba(7, 27, 49, 0.54) 100%)",
  border: "1px solid rgba(210, 236, 255, 0.16)",
  borderRadius: "24px",
  padding: "22px",
  backdropFilter: "blur(18px)",
  WebkitBackdropFilter: "blur(18px)",
  boxShadow: "0 24px 70px rgba(0, 0, 0, 0.2), inset 0 1px 0 rgba(255,255,255,0.06)",
}

const sectionCardStyle: React.CSSProperties = {
  background: "linear-gradient(180deg, rgba(14, 43, 70, 0.88) 0%, rgba(7, 26, 44, 0.86) 100%)",
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

  async function buildTaiwanSnapshot(): Promise<{
    reportDate: string
    rows: TaiwanReportRow[]
    remark: string
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

    const { data: remarkData } = await supabase
      .from("remarks")
      .select("*")
      .eq("id", 1)
      .maybeSingle()

    return {
      reportDate: formatReportDate(historyData[0].recorded_at),
      rows: buildTaiwanReportRows(portsData, historyData, portsWanted),
      remark: remarkData?.content || "",
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
            Taiwan Price History
          </h1>

          <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
            <a href="/admin" style={secondaryButtonStyle}>
              ← Back To Admin
            </a>

            <a
              href="/reports/taiwan"
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
                boxShadow: published
                  ? secondaryButtonStyle.boxShadow
                  : "inset 0 1px 0 rgba(255,255,255,0.08), 0 0 0 1px rgba(80,170,255,0.06)",
              }}
            >
              {publishing ? "Publishing..." : published ? "Published" : "Publish"}
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
            <div style={{ display: "flex", flexWrap: "wrap", gap: "10px", alignItems: "end" }}>
              <label style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                <span style={{ fontSize: "13px", fontWeight: 700, color: "#dff3ff" }}>Year</span>
                <select
                  value={selectedYear}
                  onChange={(event) => setSelectedYear(event.target.value)}
                  style={{ ...controlStyle, minWidth: "160px" }}
                >
                  <option value="all">All years</option>
                  {years.map((year) => (
                    <option key={year} value={year}>
                      {year}
                    </option>
                  ))}
                </select>
              </label>

              <label style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                <span style={{ fontSize: "13px", fontWeight: 700, color: "#dff3ff" }}>Month</span>
                <select
                  value={selectedMonth}
                  onChange={(event) => setSelectedMonth(event.target.value)}
                  style={{ ...controlStyle, minWidth: "160px" }}
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
                  minWidth: "420px",
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
                    HSFO: {monthlyAverage.hsfo ?? "-"} | VLSFO KHH: {monthlyAverage.vlsfoKaohsiung ?? "-"} | VLSFO TXG: {monthlyAverage.vlsfoTaichung ?? "-"} | MGO KHH: {monthlyAverage.mgoKaohsiung ?? "-"} | MGO TXG: {monthlyAverage.mgoTaichung ?? "-"}
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
            <label style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              <span style={{ fontSize: "13px", fontWeight: 700, color: "#dff3ff" }}>Date</span>
              <input
                type="date"
                value={formDate}
                onChange={(event) => setFormDate(event.target.value)}
                style={controlStyle}
              />
            </label>

            <label style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              <span style={{ fontSize: "13px", fontWeight: 700, color: "#dff3ff" }}>HSFO</span>
              <input value={formHsfo} onChange={(event) => setFormHsfo(event.target.value)} style={{ ...controlStyle, width: "90px" }} />
            </label>

            <label style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              <span style={{ fontSize: "13px", fontWeight: 700, color: "#dff3ff" }}>VLSFO KHH</span>
              <input value={formVlsfoKaohsiung} onChange={(event) => setFormVlsfoKaohsiung(event.target.value)} style={{ ...controlStyle, width: "96px" }} />
            </label>

            <label style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              <span style={{ fontSize: "13px", fontWeight: 700, color: "#dff3ff" }}>VLSFO TXG</span>
              <input value={formVlsfoTaichung} onChange={(event) => setFormVlsfoTaichung(event.target.value)} style={{ ...controlStyle, width: "96px" }} />
            </label>

            <label style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              <span style={{ fontSize: "13px", fontWeight: 700, color: "#dff3ff" }}>MGO KHH</span>
              <input value={formMgoKaohsiung} onChange={(event) => setFormMgoKaohsiung(event.target.value)} style={{ ...controlStyle, width: "96px" }} />
            </label>

            <label style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              <span style={{ fontSize: "13px", fontWeight: 700, color: "#dff3ff" }}>MGO TXG</span>
              <input value={formMgoTaichung} onChange={(event) => setFormMgoTaichung(event.target.value)} style={{ ...controlStyle, width: "96px" }} />
            </label>

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
                    {["Date", "HSFO", "VLSFO KHH", "VLSFO TXG", "MGO KHH", "MGO TXG", "Delete"].map((label) => (
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
                      key={row.dateKey}
                      style={{
                        background: index % 2 === 0 ? "rgba(255,255,255,0.05)" : "rgba(255,255,255,0.025)",
                      }}
                    >
                      <td style={{ padding: "8px 12px", fontSize: "13px", whiteSpace: "nowrap", color: "#edf7ff" }}>
                        {dateFormatter.format(new Date(row.recorded_at))}
                      </td>
                      <td style={{ padding: "8px 12px", fontSize: "13px", color: "#edf7ff" }}>{row.hsfo ?? "-"}</td>
                      <td style={{ padding: "8px 12px", fontSize: "13px", color: "#edf7ff" }}>{row.vlsfoKaohsiung ?? "-"}</td>
                      <td style={{ padding: "8px 12px", fontSize: "13px", color: "#edf7ff" }}>{row.vlsfoTaichung ?? "-"}</td>
                      <td style={{ padding: "8px 12px", fontSize: "13px", color: "#edf7ff" }}>{row.mgoKaohsiung ?? "-"}</td>
                      <td style={{ padding: "8px 12px", fontSize: "13px", color: "#edf7ff" }}>{row.mgoTaichung ?? "-"}</td>
                      <td style={{ padding: "8px 12px" }}>
                        <button
                          onClick={() => deleteHistoryRow(row)}
                          disabled={deletingId === row.kaohsiungRow?.id || deletingId === row.taichungRow?.id}
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
                          {deletingId === row.kaohsiungRow?.id || deletingId === row.taichungRow?.id ? "Deleting..." : "Delete"}
                        </button>
                      </td>
                    </tr>
                  ))}
                  {filteredRows.length === 0 && (
                    <tr>
                      <td colSpan={7} style={{ padding: "16px", textAlign: "center", fontSize: "13px", color: "#dff3ff" }}>
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
