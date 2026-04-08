"use client"

import { useEffect, useState } from "react"
import { supabase } from "@/lib/supabase"
import { useSimpleAdminAuth } from "@/lib/useSimpleAdminAuth"
import { loadReportSnapshot, saveReportSnapshot } from "@/lib/reportSnapshots"
import { useIsMobile } from "@/lib/useIsMobile"
import {
  buildTaiwanReportRows,
  formatReportDate,
  type TaiwanReportRow,
} from "@/lib/taiwanReport"

const portsWanted = ["Kaohsiung", "Keelung", "Taichung", "Suao", "Hualien"]

const pageStyle: React.CSSProperties = {
  minHeight: "100vh",
  padding: "32px 20px 56px",
  background:
    "radial-gradient(circle at top, #0e5aa7 0%, #073666 38%, #031b36 100%)",
  color: "#f5fbff",
  fontFamily: "Arial, Helvetica, sans-serif",
}

const shellStyle: React.CSSProperties = {
  maxWidth: "1080px",
  margin: "0 auto",
}

const cardStyle: React.CSSProperties = {
  background: "rgba(4, 24, 49, 0.72)",
  border: "1px solid rgba(173, 216, 255, 0.2)",
  borderRadius: "24px",
  boxShadow: "0 24px 60px rgba(0, 0, 0, 0.28)",
  backdropFilter: "blur(10px)",
}

const sectionTitleStyle: React.CSSProperties = {
  margin: 0,
  fontSize: "clamp(1.35rem, 2.4vw, 2rem)",
  lineHeight: 1.1,
  letterSpacing: "0.03em",
  fontWeight: 500,
}

function color(change: number | null) {
  if (change == null) return "#f5fbff"
  if (change > 0) return "#60d394"
  if (change < 0) return "#ff7b72"
  return "#f5fbff"
}

function fmt(change: number | null) {
  if (change == null) return "-"
  if (change > 0) return `+${change}`
  return String(change)
}

function arrow(change: number | null) {
  if (change == null || change === 0) return ""
  return change > 0 ? " ▲" : " ▼"
}

export default function TaiwanReport() {
  const isMobile = useIsMobile()
  const { loading: adminLoading, authenticated } = useSimpleAdminAuth()
  const [isPreview, setIsPreview] = useState(false)
  const [rows, setRows] = useState<TaiwanReportRow[]>([])
  const [remark, setRemark] = useState("")
  const [reportDate, setReportDate] = useState("")
  const [publishing, setPublishing] = useState(false)
  const [published, setPublished] = useState(false)

  useEffect(() => {
    setIsPreview(new URLSearchParams(window.location.search).get("preview") === "1")
  }, [])

  async function loadLiveTaiwanData() {
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

  useEffect(() => {
    async function load() {
      if (isPreview) {
        const liveData = await loadLiveTaiwanData()
        if (!liveData) return
        setReportDate(liveData.reportDate)
        setRows(liveData.rows)
        setRemark(liveData.remark)
        return
      }

      const snapshot = await loadReportSnapshot<{
        reportDate: string
        rows: TaiwanReportRow[]
        remark: string
      }>("taiwan")

      if (!snapshot) return

      setReportDate(snapshot.reportDate)
      setRows(snapshot.rows)
      setRemark(snapshot.remark)
    }

    if (isPreview && adminLoading) return
    if (isPreview && !authenticated) return

    load()
  }, [isPreview, adminLoading, authenticated])

  async function handlePublish() {
    setPublishing(true)
    const liveData = await loadLiveTaiwanData()

    if (liveData) {
      setReportDate(liveData.reportDate)
      setRows(liveData.rows)
      setRemark(liveData.remark)
      await saveReportSnapshot("taiwan", liveData)
    } else {
      await saveReportSnapshot("taiwan", {
        reportDate,
        rows,
        remark,
      })
    }

    setPublishing(false)
    setPublished(true)
  }

  if (isPreview && adminLoading) return <p style={{ padding: "40px" }}>Loading...</p>
  if (isPreview && !authenticated) return <p style={{ padding: "40px" }}>Access Denied</p>

  return (
    <div style={pageStyle}>
      <div style={shellStyle}>
        <div style={{ ...cardStyle, padding: isMobile ? "16px" : "24px", marginBottom: "18px" }}>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              flexDirection: isMobile ? "column" : "row",
              alignItems: "center",
              justifyContent: isMobile ? "center" : "space-between",
              gap: "18px",
            }}
          >
            <div
              style={{
                width: "100%",
                maxWidth: isMobile ? "180px" : "240px",
                textAlign: "center",
                padding: "8px 0",
                display: "flex",
                justifyContent: "center",
                flex: "0 0 auto",
              }}
            >
              <img
                src="/logo-trans.png"
                alt="Bunker map logo"
                style={{ width: "100%", height: "auto", maxWidth: isMobile ? "180px" : "250px", opacity: 0.96 }}
              />
            </div>

            <div
              style={{
                flex: "1 1 320px",
                display: "flex",
                justifyContent: "center",
                textAlign: "center",
              }}
            >
              <h1 style={sectionTitleStyle}>TAIWAN MARKET REPORT</h1>
            </div>

            <div
              style={{
                flex: isMobile ? "1 1 100%" : "0 0 auto",
                display: "grid",
                gap: "8px",
                justifyItems: isMobile ? "stretch" : "end",
              }}
            >
              {isPreview ? (
                <>
                  <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", justifyContent: isMobile ? "stretch" : "flex-end" }}>
                    <button
                      onClick={handlePublish}
                      disabled={publishing || rows.length === 0 || published}
                      style={{
                        padding: "8px 12px",
                        borderRadius: "999px",
                        border: published ? "1px solid rgba(255,255,255,0.12)" : "none",
                        background: published
                          ? "rgba(255,255,255,0.08)"
                          : "linear-gradient(135deg, #1f7acb 0%, #0a4f87 100%)",
                        color: "#fff",
                        fontSize: "14px",
                        fontWeight: 700,
                        cursor: published ? "default" : "pointer",
                      }}
                    >
                      {publishing ? "Publishing..." : published ? "Published" : "Publish"}
                    </button>
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        padding: "8px 12px",
                        borderRadius: "999px",
                        background: "rgba(255,255,255,0.06)",
                        border: "1px solid rgba(255,255,255,0.08)",
                        color: "#d7e9ff",
                        fontSize: "14px",
                        whiteSpace: "nowrap",
                      }}
                    >
                      Report Date: {reportDate || "-"}
                    </span>
                  </div>
                  <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", justifyContent: isMobile ? "stretch" : "flex-end" }}>
                    <a
                      href="/reports/taiwan"
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{
                        padding: "8px 12px",
                        borderRadius: "999px",
                        border: "none",
                        background: "#c53939",
                        color: "#fff",
                        fontSize: "14px",
                        fontWeight: 700,
                        textDecoration: "none",
                      }}
                    >
                      Check
                    </a>
                    <a
                      href="/admin"
                      style={{
                        padding: "8px 12px",
                        borderRadius: "999px",
                        border: "1px solid rgba(255,255,255,0.12)",
                        background: "rgba(255,255,255,0.08)",
                        color: "#fff",
                        fontSize: "14px",
                        fontWeight: 700,
                        textDecoration: "none",
                      }}
                    >
                      Back To Admin
                    </a>
                  </div>
                </>
              ) : (
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    padding: "8px 12px",
                    borderRadius: "999px",
                    background: "rgba(255,255,255,0.06)",
                    border: "1px solid rgba(255,255,255,0.08)",
                    color: "#d7e9ff",
                    fontSize: "14px",
                    whiteSpace: "nowrap",
                  }}
                >
                  Report Date: {reportDate || "-"}
                </span>
              )}
            </div>
          </div>
        </div>

        <div style={{ ...cardStyle, overflow: "hidden", marginBottom: "24px" }}>
          <div style={{ overflowX: "auto" }}>
            <table
              style={{
                width: "100%",
                minWidth: isMobile ? "760px" : "860px",
                borderCollapse: "collapse",
                fontSize: isMobile ? "13px" : "15px",
              }}
            >
              <thead>
                <tr
                  style={{
                    background: "linear-gradient(90deg, #0f4478 0%, #0b3359 100%)",
                  }}
                >
                  <th
                    rowSpan={2}
                    style={{
                      padding: "18px 16px",
                      fontSize: "18px",
                      borderRight: "1px solid rgba(255,255,255,0.14)",
                    }}
                  >
                    Port
                  </th>
                  <th colSpan={3} style={{ borderRight: "1px solid rgba(255,255,255,0.14)" }}>
                    HSFO
                  </th>
                  <th colSpan={3} style={{ borderRight: "1px solid rgba(255,255,255,0.14)" }}>
                    VLSFO
                  </th>
                  <th colSpan={3}>LSMGO</th>
                </tr>
                <tr
                  style={{
                    background: "linear-gradient(90deg, #0f4478 0%, #0b3359 100%)",
                  }}
                >
                  {["Today", "Last", "Change", "Today", "Last", "Change", "Today", "Last", "Change"].map(
                    (label, index) => (
                      <th
                        key={label + index}
                        style={{
                          padding: "12px 10px",
                          borderRight:
                            index === 2 || index === 5
                              ? "1px solid rgba(255,255,255,0.14)"
                              : undefined,
                        }}
                      >
                        {label}
                      </th>
                    )
                  )}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => (
                  <tr
                    key={row.port}
                    style={{
                      textAlign: "center",
                      background:
                        index % 2 === 0
                          ? "rgba(8, 46, 88, 0.86)"
                          : "rgba(7, 37, 70, 0.86)",
                    }}
                  >
                    <td
                      style={{
                        padding: "16px 14px",
                        fontWeight: 700,
                        fontSize: "16px",
                        borderTop: "1px solid rgba(255,255,255,0.08)",
                        borderRight: "1px solid rgba(255,255,255,0.08)",
                      }}
                    >
                      {row.port}
                    </td>

                    <td style={{ padding: "16px 10px", borderTop: "1px solid rgba(255,255,255,0.08)" }}>
                      {row.hsfo.today ?? "-"}
                    </td>
                    <td style={{ padding: "16px 10px", borderTop: "1px solid rgba(255,255,255,0.08)" }}>
                      {row.hsfo.last ?? "-"}
                    </td>
                    <td
                      style={{
                        padding: "16px 10px",
                        fontWeight: 700,
                        color: color(row.hsfo.change),
                        borderTop: "1px solid rgba(255,255,255,0.08)",
                        borderRight: "1px solid rgba(255,255,255,0.08)",
                      }}
                    >
                      {fmt(row.hsfo.change)}
                      {arrow(row.hsfo.change)}
                    </td>

                    <td style={{ padding: "16px 10px", borderTop: "1px solid rgba(255,255,255,0.08)" }}>
                      {row.vlsfo.today ?? "-"}
                    </td>
                    <td style={{ padding: "16px 10px", borderTop: "1px solid rgba(255,255,255,0.08)" }}>
                      {row.vlsfo.last ?? "-"}
                    </td>
                    <td
                      style={{
                        padding: "16px 10px",
                        fontWeight: 700,
                        color: color(row.vlsfo.change),
                        borderTop: "1px solid rgba(255,255,255,0.08)",
                        borderRight: "1px solid rgba(255,255,255,0.08)",
                      }}
                    >
                      {fmt(row.vlsfo.change)}
                      {arrow(row.vlsfo.change)}
                    </td>

                    <td style={{ padding: "16px 10px", borderTop: "1px solid rgba(255,255,255,0.08)" }}>
                      {row.mgo.today ?? "-"}
                    </td>
                    <td style={{ padding: "16px 10px", borderTop: "1px solid rgba(255,255,255,0.08)" }}>
                      {row.mgo.last ?? "-"}
                    </td>
                    <td
                      style={{
                        padding: "16px 10px",
                        fontWeight: 700,
                        color: color(row.mgo.change),
                        borderTop: "1px solid rgba(255,255,255,0.08)",
                      }}
                    >
                      {fmt(row.mgo.change)}
                      {arrow(row.mgo.change)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div style={{ textAlign: "center", marginBottom: "24px" }}>
          <a
            href="/"
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              gap: "10px",
              padding: "12px 22px",
              borderRadius: "999px",
              background: "#f05454",
              color: "#fff",
              textDecoration: "none",
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              boxShadow: "0 10px 24px rgba(240, 84, 84, 0.24)",
            }}
          >
            Back To Bunker Map
          </a>
        </div>

        {remark && (
          <div style={{ ...cardStyle, padding: "14px 16px", marginBottom: "20px" }}>
            <div
              style={{
                fontSize: "10px",
                textTransform: "uppercase",
                letterSpacing: "0.12em",
                color: "#8dcfff",
                marginBottom: "6px",
              }}
            >
              Remarks
            </div>
            <div style={{ display: "grid", gap: "6px" }}>
              {remark
                .split(/\n+/)
                .map((item) => item.trim())
                .filter(Boolean)
                .map((item, index) => (
                  <div
                    key={`${item}-${index}`}
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: "8px",
                      padding: "8px 10px",
                      borderRadius: "12px",
                      background: "rgba(255,255,255,0.04)",
                      border: "1px solid rgba(255,255,255,0.06)",
                      color: "#e8f4ff",
                      fontSize: "13px",
                    }}
                  >
                    <span
                      style={{
                        width: "20px",
                        height: "20px",
                        flexShrink: 0,
                        borderRadius: "999px",
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        background: "rgba(141, 207, 255, 0.14)",
                        color: "#dff3ff",
                        fontSize: "10px",
                        fontWeight: 700,
                      }}
                    >
                      {index + 1}
                    </span>
                    <span style={{ lineHeight: 1.5 }}>{item}</span>
                  </div>
                ))}
            </div>
          </div>
        )}

        <div
          style={{
            ...cardStyle,
            padding: "20px 24px",
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "18px",
          }}
        >
          <div style={{ flex: "1 1 320px" }}>
            <div style={{ fontSize: "20px", fontWeight: 700, marginBottom: "6px" }}>
              Need more Taiwan bunker information?
            </div>
            <div style={{ color: "#d7e9ff", lineHeight: 1.6, fontSize: "15px" }}>
              Contact us directly on WhatsApp for further details.
            </div>
          </div>

          <a
            href="https://wa.me/85266885575"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              minWidth: "220px",
              padding: "14px 22px",
              borderRadius: "999px",
              background: "linear-gradient(135deg, #25d366 0%, #0cb955 100%)",
              color: "#fff",
              textDecoration: "none",
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              boxShadow: "0 14px 30px rgba(37, 211, 102, 0.25)",
            }}
          >
            Contact On WhatsApp
          </a>
        </div>
      </div>
    </div>
  )
}
