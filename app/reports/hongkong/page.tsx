"use client"

import { Fragment, useEffect, useState } from "react"
import { loadReportSnapshot } from "@/lib/reportSnapshots"
import { type HongKongReportRow } from "@/lib/hongKongReport"
import { formatReportDate } from "@/lib/taiwanReport"
import { useIsMobile } from "@/lib/useIsMobile"

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
  const isMobile = useIsMobile()
  const [rows, setRows] = useState<HongKongReportRow[]>([])
  const [reportDate, setReportDate] = useState("")

  useEffect(() => {
    async function load() {
      const snapshot = await loadReportSnapshot<{
        reportDate: string
        rows: HongKongReportRow[]
      }>("hongkong")

      if (!snapshot) return

      setReportDate(snapshot.reportDate)
      setRows(snapshot.rows)
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
              <h1 style={sectionTitleStyle}>HONG KONG MARKET REPORT</h1>
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
                minWidth: isMobile ? "620px" : "680px",
                borderCollapse: "collapse",
                fontSize: isMobile ? "13px" : "15px",
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
                  {["HSFO", "VLSFO", "MGO S0.05%"].map((label, index) => (
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
