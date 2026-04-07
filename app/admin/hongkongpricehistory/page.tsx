"use client"

import { useEffect, useMemo, useState } from "react"
import { supabase } from "@/lib/supabase"
import { useSimpleAdminAuth } from "@/lib/useSimpleAdminAuth"

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
    }

    setSaving(false)
  }

  if (!adminLoading && !authenticated) return <p style={{ padding: "40px" }}>Access Denied</p>
  if (adminLoading) return <p style={{ padding: "40px" }}>Loading...</p>

  return (
    <div
      style={{
        minHeight: "100vh",
        background:
          "radial-gradient(circle at top, #114a80 0%, #0a2c4c 34%, #041629 100%)",
        padding: "24px",
        fontFamily: "Arial, Helvetica, sans-serif",
        color: "#edf7ff",
      }}
    >
      <div
        style={{
          maxWidth: "980px",
          margin: "0 auto",
          background: "rgba(6, 24, 44, 0.68)",
          border: "1px solid rgba(210, 236, 255, 0.16)",
          borderRadius: "24px",
          padding: "22px",
          backdropFilter: "blur(18px)",
          WebkitBackdropFilter: "blur(18px)",
          boxShadow: "0 24px 80px rgba(0, 0, 0, 0.24)",
        }}
      >
        <div
          style={{
            position: "sticky",
            top: "0",
            zIndex: 20,
            margin: "-22px -22px 20px",
            padding: "18px 22px 14px",
            background: "rgba(6, 24, 44, 0.92)",
            backdropFilter: "blur(18px)",
            WebkitBackdropFilter: "blur(18px)",
            borderBottom: "1px solid rgba(210, 236, 255, 0.14)",
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

          <a
            href="/admin"
            style={{
              padding: "10px 16px",
              border: "1px solid rgba(255,255,255,0.14)",
              borderRadius: "12px",
              background: "rgba(255,255,255,0.08)",
              color: "#edf7ff",
              textDecoration: "none",
              fontSize: "14px",
              fontWeight: 700,
            }}
          >
            Back To Admin Home
          </a>
        </div>

        <div
          style={{
            background:
              "linear-gradient(180deg, rgba(14, 43, 70, 0.92) 0%, rgba(7, 26, 44, 0.9) 100%)",
            border: "1px solid rgba(173, 216, 255, 0.14)",
            borderRadius: "22px",
            padding: "16px",
            marginBottom: "14px",
            boxShadow: "0 18px 40px rgba(0, 0, 0, 0.18)",
          }}
        >
          <div style={{ display: "flex", flexWrap: "wrap", gap: "12px", alignItems: "end", justifyContent: "space-between" }}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "10px", alignItems: "end" }}>
              <label style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                <span style={{ fontSize: "13px", fontWeight: 700, color: "#dff3ff" }}>Year</span>
                <select
                  value={selectedYear}
                  onChange={(event) => setSelectedYear(event.target.value)}
                  style={{
                    minWidth: "160px",
                    padding: "9px 12px",
                    borderRadius: "12px",
                    border: "1px solid rgba(173, 216, 255, 0.18)",
                    background: "rgba(255,255,255,0.06)",
                    color: "#edf7ff",
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
                    minWidth: "160px",
                    padding: "9px 12px",
                    borderRadius: "12px",
                    border: "1px solid rgba(173, 216, 255, 0.18)",
                    background: "rgba(255,255,255,0.06)",
                    color: "#edf7ff",
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
                  background: "rgba(255,255,255,0.05)",
                  border: "1px solid rgba(173, 216, 255, 0.14)",
                  fontSize: "13px",
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "center",
                  gap: "4px",
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

        <div
          style={{
            background:
              "linear-gradient(180deg, rgba(14, 43, 70, 0.92) 0%, rgba(7, 26, 44, 0.9) 100%)",
            border: "1px solid rgba(173, 216, 255, 0.14)",
            borderRadius: "22px",
            padding: "16px",
            marginBottom: "14px",
            boxShadow: "0 18px 40px rgba(0, 0, 0, 0.18)",
          }}
        >
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
                    width: field.width,
                    padding: "9px 12px",
                    borderRadius: "12px",
                    border: "1px solid rgba(173, 216, 255, 0.18)",
                    background: "rgba(255,255,255,0.06)",
                    color: "#edf7ff",
                  }}
                />
              </label>
            ))}

            <button
              onClick={addMissingRecord}
              disabled={saving || !formDate}
              style={{
                background: saving || !formDate ? "rgba(255,255,255,0.08)" : "#1fa97a",
                color: "white",
                border: "none",
                borderRadius: "12px",
                padding: "10px 16px",
                cursor: saving ? "wait" : "pointer",
                fontSize: "13px",
                height: "42px",
                fontWeight: 700,
              }}
            >
              {saving ? "Saving..." : "Add Missing Record"}
            </button>
          </div>
        </div>

        <div
          style={{
            background:
              "linear-gradient(180deg, rgba(14, 43, 70, 0.92) 0%, rgba(7, 26, 44, 0.9) 100%)",
            border: "1px solid rgba(173, 216, 255, 0.14)",
            borderRadius: "22px",
            overflow: "hidden",
            boxShadow: "0 18px 40px rgba(0, 0, 0, 0.18)",
          }}
        >
          {loading ? (
            <p style={{ margin: 0, padding: "14px", color: "#dff3ff" }}>Loading history...</p>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ background: "rgba(7, 31, 54, 0.92)", color: "white" }}>
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
                        background: index % 2 === 0 ? "rgba(255,255,255,0.04)" : "rgba(255,255,255,0.02)",
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
                            background: "rgba(230, 57, 70, 0.14)",
                            color: "#ffd4d8",
                            border: "1px solid rgba(255, 120, 120, 0.16)",
                            borderRadius: "999px",
                            padding: "7px 12px",
                            cursor: "pointer",
                            fontSize: "12px",
                            fontWeight: 700,
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
