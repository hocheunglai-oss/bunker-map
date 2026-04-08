"use client"

import { Fragment, useEffect, useState } from "react"
import { supabase } from "@/lib/supabase"
import { useSimpleAdminAuth } from "@/lib/useSimpleAdminAuth"
import { loadReportSnapshot, saveReportSnapshot } from "@/lib/reportSnapshots"
import { buildHongKongReportRows, type HongKongReportRow } from "@/lib/hongKongReport"
import { formatReportDate } from "@/lib/taiwanReport"

const portsWanted = ["Hong Kong"]

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

function shortDate(value: string | null) {
  if (!value) return "-"
  const [day, month, year] = formatReportDate(value).split(" ")
  const monthNumber =
    {
      Jan: "01",
      Feb: "02",
      Mar: "03",
      Apr: "04",
      May: "05",
      Jun: "06",
      Jul: "07",
      Aug: "08",
      Sep: "09",
      Oct: "10",
      Nov: "11",
      Dec: "12",
    }[month] || month

  return `${day}/${monthNumber}/${year}`
}

export default function HongKongReport() {
  const { loading: adminLoading, authenticated } = useSimpleAdminAuth()
  const [isPreview, setIsPreview] = useState(false)
  const [rows, setRows] = useState<HongKongReportRow[]>([])
  const [reportDate, setReportDate] = useState("")
  const [publishing, setPublishing] = useState(false)
  const [published, setPublished] = useState(false)

  useEffect(() => {
    setIsPreview(new URLSearchParams(window.location.search).get("preview") === "1")
  }, [])

  async function loadLiveHongKongData() {
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

  useEffect(() => {
    async function load() {
      if (isPreview) {
        const liveData = await loadLiveHongKongData()
        if (!liveData) return
        setReportDate(liveData.reportDate)
        setRows(liveData.rows)
        return
      }

      const snapshot = await loadReportSnapshot<{
        reportDate: string
        rows: HongKongReportRow[]
      }>("hongkong")

      if (!snapshot) return

      setReportDate(snapshot.reportDate)
      setRows(snapshot.rows)
    }

    if (isPreview && adminLoading) return
    if (isPreview && !authenticated) return

    load()
  }, [isPreview, adminLoading, authenticated])

  async function handlePublish() {
    setPublishing(true)
    const liveData = await loadLiveHongKongData()

    if (liveData) {
      setReportDate(liveData.reportDate)
      setRows(liveData.rows)
      await saveReportSnapshot("hongkong", liveData)
    } else {
      await saveReportSnapshot("hongkong", { reportDate, rows })
    }

    setPublishing(false)
    setPublished(true)
  }

  if (isPreview && adminLoading) return <p style={{ padding: "40px" }}>Loading...</p>
  if (isPreview && !authenticated) return <p style={{ padding: "40px" }}>Access Denied</p>

  return (
    <div style={pageStyle}>
      <div style={shellStyle}>
        <div style={{ ...cardStyle, padding: "24px", marginBottom: "18px" }}>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "18px",
            }}
          >
            <div
              style={{
                width: "100%",
                maxWidth: "240px",
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
                style={{ width: "100%", height: "auto", maxWidth: "250px", opacity: 0.96 }}
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
              <h1 style={sectionTitleStyle}>HONG KONG MARKET REPORT</h1>
            </div>

            <div
              style={{
                flex: "0 0 auto",
                display: "grid",
                gap: "8px",
                justifyItems: "end",
              }}
            >
              {isPreview ? (
                <>
                  <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", justifyContent: "flex-end" }}>
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
                  <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", justifyContent: "flex-end" }}>
                    <a
                      href="/reports/hongkong"
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
                minWidth: "680px",
                borderCollapse: "collapse",
                fontSize: "15px",
              }}
            >
              <thead>
                <tr style={{ background: "linear-gradient(90deg, #0f4478 0%, #0b3359 100%)", color: "#f5fbff" }}>
                  <th
                    colSpan={2}
                    style={{
                      padding: "10px 16px",
                      borderRight: "1px solid rgba(255,255,255,0.14)",
                    }}
                  >
                  </th>
                  {["HSFO", "VLSFO", "MGO $0.05%"].map((label, index) => (
                    <th
                      key={label}
                      style={{
                        padding: "10px 12px",
                        fontSize: "14px",
                        fontWeight: 700,
                        borderRight: index < 2 ? "1px solid rgba(255,255,255,0.14)" : undefined,
                      }}
                    >
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => (
                  <Fragment key={row.port}>
                    <tr
                      style={{
                        textAlign: "center",
                        background: "rgba(22, 86, 148, 0.98)",
                        color: "#edf7ff",
                        boxShadow: "inset 0 1px 0 rgba(255,255,255,0.1)",
                      }}
                    >
                      <td
                        style={{
                          padding: "14px 12px",
                          borderTop: "1px solid rgba(255,255,255,0.08)",
                          textAlign: "left",
                          whiteSpace: "nowrap",
                          fontWeight: 800,
                          color: "#ffffff",
                          borderRight: "1px solid rgba(255,255,255,0.16)",
                          background: "rgba(255,255,255,0.08)",
                        }}
                      >
                        NEW
                      </td>
                      <td
                        style={{
                          padding: "14px 12px",
                          borderTop: "1px solid rgba(255,255,255,0.08)",
                          borderRight: "1px solid rgba(255,255,255,0.12)",
                          whiteSpace: "nowrap",
                          fontWeight: 700,
                          color: "#ffffff",
                          background: "rgba(255,255,255,0.06)",
                        }}
                      >
                        {shortDate(row.todayDate)}
                      </td>
                      <td style={{ padding: "14px 12px", borderTop: "1px solid rgba(255,255,255,0.08)", borderRight: "1px solid rgba(255,255,255,0.16)", fontWeight: 800, color: "#ffffff", background: "rgba(255,255,255,0.06)" }}>{row.hsfo.today ?? "-"}</td>
                      <td style={{ padding: "14px 12px", borderTop: "1px solid rgba(255,255,255,0.08)", borderRight: "1px solid rgba(255,255,255,0.16)", fontWeight: 800, color: "#ffffff", background: "rgba(255,255,255,0.06)" }}>{row.vlsfo.today ?? "-"}</td>
                      <td style={{ padding: "14px 12px", borderTop: "1px solid rgba(255,255,255,0.08)", fontWeight: 800, color: "#ffffff", background: "rgba(255,255,255,0.06)" }}>{row.mgo.today ?? "-"}</td>
                    </tr>
                    <tr
                      style={{
                        textAlign: "center",
                        background: "rgba(12, 58, 106, 0.9)",
                        color: "#edf7ff",
                      }}
                    >
                      <td
                        style={{
                          padding: "14px 12px",
                          borderTop: "1px solid rgba(255,255,255,0.08)",
                          textAlign: "left",
                          whiteSpace: "nowrap",
                          borderRight: "1px solid rgba(255,255,255,0.12)",
                          fontSize: "14px",
                        }}
                      >
                        LAST RECORD
                      </td>
                      <td
                        style={{
                          padding: "14px 12px",
                          borderTop: "1px solid rgba(255,255,255,0.08)",
                          borderRight: "1px solid rgba(255,255,255,0.12)",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {shortDate(row.last1Date)}
                      </td>
                      <td style={{ padding: "14px 12px", borderTop: "1px solid rgba(255,255,255,0.08)", borderRight: "1px solid rgba(255,255,255,0.12)" }}>{row.hsfo.last1 ?? "-"}</td>
                      <td style={{ padding: "14px 12px", borderTop: "1px solid rgba(255,255,255,0.08)", borderRight: "1px solid rgba(255,255,255,0.12)" }}>{row.vlsfo.last1 ?? "-"}</td>
                      <td style={{ padding: "14px 12px", borderTop: "1px solid rgba(255,255,255,0.08)" }}>{row.mgo.last1 ?? "-"}</td>
                    </tr>
                    <tr
                      style={{
                        textAlign: "center",
                        background:
                          index % 2 === 0
                            ? "rgba(8, 46, 88, 0.86)"
                            : "rgba(7, 37, 70, 0.86)",
                        color: "#edf7ff",
                      }}
                    >
                      <td
                        style={{
                          padding: "14px 12px",
                          borderTop: "1px solid rgba(255,255,255,0.08)",
                          textAlign: "left",
                          whiteSpace: "nowrap",
                          borderRight: "1px solid rgba(255,255,255,0.12)",
                        }}
                      />
                      <td
                        style={{
                          padding: "14px 12px",
                          borderTop: "1px solid rgba(255,255,255,0.08)",
                          borderRight: "1px solid rgba(255,255,255,0.12)",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {shortDate(row.last2Date)}
                      </td>
                      <td style={{ padding: "14px 12px", borderTop: "1px solid rgba(255,255,255,0.08)", borderRight: "1px solid rgba(255,255,255,0.12)" }}>{row.hsfo.last2 ?? "-"}</td>
                      <td style={{ padding: "14px 12px", borderTop: "1px solid rgba(255,255,255,0.08)", borderRight: "1px solid rgba(255,255,255,0.12)" }}>{row.vlsfo.last2 ?? "-"}</td>
                      <td style={{ padding: "14px 12px", borderTop: "1px solid rgba(255,255,255,0.08)" }}>{row.mgo.last2 ?? "-"}</td>
                    </tr>
                  </Fragment>
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
              Need more Hong Kong bunker information?
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
