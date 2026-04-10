"use client"

import { useEffect, useState } from "react"
import { loadReportSnapshot } from "@/lib/reportSnapshots"
import { useIsMobile } from "@/lib/useIsMobile"
import { type TaiwanReportRow } from "@/lib/taiwanReport"

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

const pillButtonStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "10px 18px",
  borderRadius: "999px",
  border: "1px solid rgba(210,236,255,0.16)",
  background: "linear-gradient(180deg, rgba(255,255,255,0.18) 0%, rgba(255,255,255,0.1) 100%)",
  color: "#d7e8ff",
  textDecoration: "none",
  fontWeight: 700,
  boxShadow: "inset 0 1px 0 rgba(255,255,255,0.05)",
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
  const [rows, setRows] = useState<TaiwanReportRow[]>([])
  const [remark, setRemark] = useState("")
  const [reportDate, setReportDate] = useState("")

  useEffect(() => {
    async function load() {
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

    load()
  }, [])

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
              gap: isMobile ? "10px" : "18px",
            }}
          >
            <div
              style={{
                width: isMobile ? "auto" : "100%",
                maxWidth: isMobile ? "180px" : "240px",
                textAlign: "center",
                padding: isMobile ? "0" : "8px 0",
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
                flex: isMobile ? "0 1 auto" : "1 1 320px",
                display: "flex",
                justifyContent: "center",
                textAlign: "center",
              }}
            >
              <h1 style={sectionTitleStyle}>TAIWAN POSTED PRICE</h1>
            </div>

            <div
              style={{
                flex: isMobile ? "1 1 100%" : "0 0 auto",
                display: "grid",
                gap: "8px",
                justifyItems: isMobile ? "stretch" : "end",
              }}
            >
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  padding: "8px 12px",
                  borderRadius: "999px",
                  background: "linear-gradient(180deg, rgba(255,255,255,0.18) 0%, rgba(255,255,255,0.1) 100%)",
                  border: "1px solid rgba(210,236,255,0.16)",
                  color: "#d7e8ff",
                  fontSize: "14px",
                  whiteSpace: "nowrap",
                }}
              >
                Report Date: {reportDate || "-"}
              </span>
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
              ...pillButtonStyle,
              gap: "10px",
              color: "#ffd4d8",
              background: "linear-gradient(180deg, rgba(210, 74, 74, 0.18) 0%, rgba(170, 47, 53, 0.1) 100%)",
              border: "1px solid rgba(255, 120, 120, 0.16)",
              textTransform: "uppercase",
              letterSpacing: "0.08em",
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
              ...pillButtonStyle,
              minWidth: "220px",
              background: "linear-gradient(180deg, rgba(56, 214, 154, 0.26) 0%, rgba(20, 130, 93, 0.12) 100%)",
              color: "#ddffef",
              border: "1px solid rgba(73, 219, 165, 0.22)",
              textTransform: "uppercase",
              letterSpacing: "0.08em",
            }}
          >
            Contact On WhatsApp
          </a>
        </div>
      </div>
    </div>
  )
}
