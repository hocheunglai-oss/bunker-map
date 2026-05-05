"use client"

import { useEffect, useState } from "react"
import { loadReportSnapshot } from "@/lib/reportSnapshots"
import { supabase } from "@/lib/supabase"
import { useIsMobile } from "@/lib/useIsMobile"
import { type TaiwanReportRow } from "@/lib/taiwanReport"
import DisclaimerLink from "@/components/DisclaimerLink"

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
  background:
    "radial-gradient(circle at top left, rgba(88, 182, 255, 0.1), transparent 30%), linear-gradient(180deg, rgba(4, 24, 49, 0.84) 0%, rgba(5, 22, 40, 0.78) 100%)",
  border: "1px solid rgba(173, 216, 255, 0.18)",
  borderRadius: "24px",
  boxShadow: "0 28px 72px rgba(0, 0, 0, 0.3), inset 0 1px 0 rgba(255,255,255,0.05)",
  backdropFilter: "blur(16px)",
}

const headerCardStyle: React.CSSProperties = {
  ...cardStyle,
  background:
    "radial-gradient(circle at top left, rgba(88, 182, 255, 0.1), transparent 30%), linear-gradient(180deg, rgba(4, 24, 49, 0.84) 0%, rgba(5, 22, 40, 0.78) 100%)",
}

const sectionTitleStyle: React.CSSProperties = {
  margin: 0,
  fontSize: "clamp(1.35rem, 2.4vw, 2rem)",
  lineHeight: 1.1,
  letterSpacing: "0.04em",
  fontWeight: 600,
  textShadow: "0 10px 28px rgba(4,16,29,0.24)",
  textTransform: "uppercase",
}

const pillButtonStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "10px 18px",
  borderRadius: "999px",
  border: "1px solid rgba(210,236,255,0.18)",
  background: "linear-gradient(180deg, rgba(255,255,255,0.18) 0%, rgba(255,255,255,0.1) 100%)",
  color: "#d7e8ff",
  textDecoration: "none",
  fontWeight: 700,
  boxShadow: "inset 0 1px 0 rgba(255,255,255,0.08), 0 10px 24px rgba(8,24,44,0.16)",
}

const fuelAccentStyles = {
  hsfo: {
    color: "#8fd7ff",
    glow: "rgba(90,169,255,0.16)",
  },
  vlsfo: {
    color: "#7df0c2",
    glow: "rgba(87,227,176,0.16)",
  },
  mgo: {
    color: "#ffd166",
    glow: "rgba(255,209,102,0.16)",
  },
} as const

const taiwanMinimumQuantityRows = [
  { port: "Kaohsiung", oilFenceCharge: "89 OR 338", deliveryMode: "BARGE", hsfo: "30", vlsfo: "60", lsmgo: "25", mgoSulfur: "0.1" },
  { port: "Keelung", oilFenceCharge: "208", deliveryMode: "BARGE", hsfo: "NA", vlsfo: "60", lsmgo: "20", mgoSulfur: "0.1" },
  { port: "Taichung", oilFenceCharge: "475", deliveryMode: "BARGE", hsfo: "NA", vlsfo: "60", lsmgo: "20", mgoSulfur: "0.1" },
  { port: "Suao", oilFenceCharge: "NA", deliveryMode: "RTW", hsfo: "NA", vlsfo: "19", lsmgo: "10", mgoSulfur: "0.5" },
  { port: "Hualien", oilFenceCharge: "NA", deliveryMode: "RTW / PIPELINE", hsfo: "NA", vlsfo: "19", lsmgo: "20", mgoSulfur: "0.5" },
]

function subtleNaText(portName?: string) {
  if (portName === "Keelung" || portName === "Suao") {
    return "rgba(86, 113, 140, 0.42)"
  }

  return "rgba(70, 96, 122, 0.4)"
}

function color(change: number | null) {
  if (change == null) return "#f5fbff"
  if (change > 0) return "#60d394"
  if (change < 0) return "#ff7b72"
  return "#ffd166"
}

function fmt(change: number | null) {
  if (change == null) return "-"
  if (change > 0) return `+${change}`
  if (change === 0) return "-"
  return String(change)
}

function arrow(change: number | null) {
  if (change == null || change === 0) return ""
  return change > 0 ? " ▲" : " ▼"
}

function isHsfoUnavailablePort(portName: string) {
  return ["Keelung", "Taichung", "Hualien", "Suao"].includes(portName)
}

function unavailableHsfoColor(portName: string) {
  return subtleNaText(portName)
}

function renderUnavailableHsfo(portName: string) {
  return (
    <span
      style={{
        color: unavailableHsfoColor(portName),
        fontSize: "13px",
        fontWeight: 700,
        letterSpacing: "0.03em",
      }}
    >
      NA
    </span>
  )
}

export default function TaiwanReport() {
  const isMobile = useIsMobile()
  const [rows, setRows] = useState<TaiwanReportRow[]>([])
  const [remark, setRemark] = useState("")
  const [specialNotice, setSpecialNotice] = useState("")
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

      const { data: noticeData } = await supabase
        .from("remarks")
        .select("content")
        .eq("id", 2)
        .maybeSingle()

      setSpecialNotice(noticeData?.content || "")
    }

    load()
  }, [])

  useEffect(() => {
    if (!isMobile) return
    const resetScroll = () => {
      window.scrollTo({ top: 0, left: 0, behavior: "auto" })
      document.documentElement.scrollTop = 0
      document.body.scrollTop = 0
    }

    resetScroll()
    const frame = window.requestAnimationFrame(resetScroll)
    const timer = window.setTimeout(resetScroll, 180)

    return () => {
      window.cancelAnimationFrame(frame)
      window.clearTimeout(timer)
    }
  }, [isMobile])

  return (
    <div style={pageStyle}>
      <div style={shellStyle}>
        <div style={{ ...headerCardStyle, padding: isMobile ? "16px" : "24px", marginBottom: "18px", position: "relative", overflow: "hidden" }}>
          <div
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              height: "3px",
              background: "linear-gradient(90deg, #5aa9ff 0%, #7fd0ff 50%, #5aa9ff 100%)",
            }}
          />
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
            <a
              href="/"
              style={{
                width: isMobile ? "auto" : "100%",
                maxWidth: isMobile ? "180px" : "240px",
                textAlign: "center",
                padding: isMobile ? "0" : "8px 0",
                display: "flex",
                justifyContent: "center",
                flex: "0 0 auto",
                textDecoration: "none",
              }}
            >
              <img
                src="/logo-trans.png"
                alt="Bunker map logo"
                style={{ width: "100%", height: "auto", maxWidth: isMobile ? "180px" : "250px", opacity: 0.96 }}
              />
            </a>

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
                  background: "linear-gradient(180deg, rgba(72, 170, 255, 0.24) 0%, rgba(20, 112, 196, 0.12) 100%)",
                  border: "1px solid rgba(143,215,255,0.24)",
                  color: "#d7e8ff",
                  fontSize: "14px",
                  whiteSpace: "nowrap",
                  boxShadow: "inset 0 1px 0 rgba(255,255,255,0.08)",
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
                fontVariantNumeric: "tabular-nums",
              }}
            >
              <thead>
                <tr
                  style={{
                    background: "linear-gradient(90deg, rgba(16, 71, 126, 0.98) 0%, rgba(10, 43, 78, 0.98) 100%)",
                  }}
                >
                  <th
                    rowSpan={2}
                    style={{
                      padding: "18px 16px",
                      fontSize: "17px",
                      letterSpacing: "0.06em",
                      borderRight: "1px solid rgba(255,255,255,0.14)",
                      textTransform: "uppercase",
                    }}
                  >
                    Port
                  </th>
                  <th colSpan={3} style={{ borderRight: "1px solid rgba(255,255,255,0.14)", color: "#f5fbff", boxShadow: `inset 0 -2px 0 ${fuelAccentStyles.hsfo.glow}` }}>
                    HSFO
                  </th>
                  <th colSpan={3} style={{ borderRight: "1px solid rgba(255,255,255,0.14)", color: "#f5fbff", boxShadow: `inset 0 -2px 0 ${fuelAccentStyles.vlsfo.glow}` }}>
                    VLSFO
                  </th>
                  <th colSpan={3} style={{ color: "#f5fbff", boxShadow: `inset 0 -2px 0 ${fuelAccentStyles.mgo.glow}` }}>MGO</th>
                </tr>
                <tr
                  style={{
                    background: "linear-gradient(90deg, rgba(16, 71, 126, 0.98) 0%, rgba(10, 43, 78, 0.98) 100%)",
                  }}
                >
                  {["Today", "Last", "Change", "Today", "Last", "Change", "Today", "Last", "Change"].map(
                    (label, index) => (
                      <th
                        key={label + index}
                        style={{
                        padding: "12px 10px",
                        fontSize: "13px",
                        fontWeight: 800,
                        letterSpacing: "0.08em",
                        textTransform: "uppercase",
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
                          ? "rgba(8, 46, 88, 0.76)"
                          : "rgba(7, 37, 70, 0.68)",
                    }}
                  >
                    <td
                      style={{
                        padding: "16px 14px",
                        fontWeight: 700,
                        fontSize: "16px",
                        borderTop: "1px solid rgba(255,255,255,0.08)",
                        borderRight: "1px solid rgba(255,255,255,0.08)",
                        background: "rgba(255,255,255,0.03)",
                        letterSpacing: "0.02em",
                      }}
                    >
                      {row.port}
                    </td>

                    <td style={{ padding: "16px 10px", borderTop: "1px solid rgba(255,255,255,0.08)" }}>
                      {isHsfoUnavailablePort(row.port)
                        ? renderUnavailableHsfo(row.port)
                        : row.hsfo.today ?? "-"}
                    </td>
                    <td style={{ padding: "16px 10px", borderTop: "1px solid rgba(255,255,255,0.08)" }}>
                      {isHsfoUnavailablePort(row.port)
                        ? renderUnavailableHsfo(row.port)
                        : row.hsfo.last ?? "-"}
                    </td>
                    <td
                      style={{
                        padding: "16px 10px",
                        fontWeight: 700,
                        color: isHsfoUnavailablePort(row.port) ? unavailableHsfoColor(row.port) : color(row.hsfo.change),
                        borderTop: "1px solid rgba(255,255,255,0.08)",
                        borderRight: "1px solid rgba(255,255,255,0.08)",
                      }}
                    >
                      {isHsfoUnavailablePort(row.port)
                        ? renderUnavailableHsfo(row.port)
                        : (
                          <>
                            {fmt(row.hsfo.change)}
                            {arrow(row.hsfo.change)}
                          </>
                        )}
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

        {specialNotice.trim() && (
          <div
            style={{
              ...cardStyle,
              padding: "14px 16px",
              marginBottom: "20px",
              border: "1px solid rgba(255, 178, 84, 0.28)",
              background:
                "radial-gradient(circle at top left, rgba(255, 171, 64, 0.2), transparent 34%), linear-gradient(180deg, rgba(68, 42, 18, 0.78) 0%, rgba(24, 23, 28, 0.82) 100%)",
              boxShadow: "0 18px 42px rgba(0, 0, 0, 0.22), inset 0 1px 0 rgba(255,255,255,0.08), 0 0 0 1px rgba(255, 178, 84, 0.06)",
            }}
          >
            <div
              style={{
                fontSize: "10px",
                textTransform: "uppercase",
                letterSpacing: "0.14em",
                color: "#ffd59a",
                marginBottom: "7px",
                fontWeight: 800,
              }}
            >
              Special Notice
            </div>
            <div style={{ color: "#ffe7c2", fontSize: "13px", lineHeight: 1.55, fontWeight: 700 }}>
              {specialNotice.trim()}
            </div>
          </div>
        )}

        <div style={{ ...cardStyle, overflow: "hidden", marginBottom: "20px" }}>
          <div
            style={{
              padding: "12px 16px 0",
              fontSize: "10px",
              textTransform: "uppercase",
              letterSpacing: "0.12em",
              color: "#8dcfff",
            }}
          >
            Port Characteristics
          </div>
          <div style={{ overflowX: "auto", padding: "10px 12px 14px" }}>
            <table
              style={{
                width: "100%",
                minWidth: isMobile ? "640px" : "100%",
                borderCollapse: "separate",
                borderSpacing: 0,
                fontSize: "13px",
                fontVariantNumeric: "tabular-nums",
                overflow: "hidden",
                borderRadius: "16px",
                border: "1px solid rgba(173, 216, 255, 0.14)",
                background: "linear-gradient(180deg, rgba(255,255,255,0.03) 0%, rgba(255,255,255,0.015) 100%)",
              }}
            >
              <thead>
                <tr>
                  <th
                    rowSpan={2}
                    style={{
                      padding: "12px 10px",
                      textAlign: "center",
                      background: "linear-gradient(180deg, rgba(10, 43, 78, 0.98) 0%, rgba(8, 34, 62, 0.98) 100%)",
                      borderRight: "1px solid rgba(255,255,255,0.08)",
                      borderBottom: "1px solid rgba(255,255,255,0.08)",
                      letterSpacing: "0.06em",
                      textTransform: "uppercase",
                      fontSize: "12px",
                    }}
                  >
                    Port
                  </th>
                  <th
                    rowSpan={2}
                    style={{
                      padding: "12px 10px",
                      textAlign: "center",
                      background: "linear-gradient(180deg, rgba(10, 43, 78, 0.98) 0%, rgba(8, 34, 62, 0.98) 100%)",
                      borderRight: "1px solid rgba(255,255,255,0.08)",
                      borderBottom: "1px solid rgba(255,255,255,0.08)",
                      letterSpacing: "0.06em",
                      textTransform: "uppercase",
                      fontSize: "12px",
                    }}
                  >
                    Oil Fence Charge (USD)
                  </th>
                  <th
                    rowSpan={2}
                    style={{
                      padding: "12px 10px",
                      textAlign: "center",
                      background: "linear-gradient(180deg, rgba(10, 43, 78, 0.98) 0%, rgba(8, 34, 62, 0.98) 100%)",
                      borderRight: "1px solid rgba(255,255,255,0.08)",
                      borderBottom: "1px solid rgba(255,255,255,0.08)",
                      letterSpacing: "0.06em",
                      textTransform: "uppercase",
                      fontSize: "12px",
                    }}
                  >
                    Delivery Mode
                  </th>
                  <th
                    colSpan={3}
                    style={{
                      padding: "10px 10px 8px",
                      textAlign: "center",
                      background: "linear-gradient(180deg, rgba(10, 43, 78, 0.98) 0%, rgba(8, 34, 62, 0.98) 100%)",
                      borderBottom: "1px solid rgba(255,255,255,0.08)",
                      letterSpacing: "0.08em",
                      textTransform: "uppercase",
                      fontSize: "11px",
                      color: "#dff3ff",
                    }}
                  >
                    Minimum Quantity
                  </th>
                  <th
                    rowSpan={2}
                    style={{
                      padding: "12px 10px",
                      textAlign: "center",
                      background: "linear-gradient(180deg, rgba(10, 43, 78, 0.98) 0%, rgba(8, 34, 62, 0.98) 100%)",
                      borderBottom: "1px solid rgba(255,255,255,0.08)",
                      letterSpacing: "0.06em",
                      fontSize: "12px",
                      textTransform: "uppercase",
                    }}
                  >
                    MGO Sulfur (%)
                  </th>
                </tr>
                <tr>
                  {[
                    { label: "HSFO", glow: fuelAccentStyles.hsfo.glow },
                    { label: "VLSFO", glow: fuelAccentStyles.vlsfo.glow },
                    { label: "MGO", glow: fuelAccentStyles.mgo.glow },
                  ].map((item, index) => (
                    <th
                      key={item.label}
                      style={{
                        padding: "10px 10px",
                        textAlign: "center",
                        background: "linear-gradient(180deg, rgba(10, 43, 78, 0.98) 0%, rgba(8, 34, 62, 0.98) 100%)",
                        borderBottom: "1px solid rgba(255,255,255,0.08)",
                        borderRight: index < 2 ? "1px solid rgba(255,255,255,0.08)" : undefined,
                        boxShadow: `inset 0 -2px 0 ${item.glow}`,
                        letterSpacing: "0.06em",
                        fontSize: "12px",
                      }}
                    >
                      {item.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {taiwanMinimumQuantityRows.map((row, index) => (
                  <tr
                    key={row.port}
                    style={{
                      background: index % 2 === 0 ? "rgba(8, 46, 88, 0.52)" : "rgba(7, 37, 70, 0.4)",
                    }}
                  >
                    <td
                      style={{
                        padding: "11px 10px",
                        fontWeight: 700,
                        letterSpacing: "0.03em",
                        textAlign: "center",
                        borderTop: "1px solid rgba(255,255,255,0.06)",
                        borderRight: "1px solid rgba(255,255,255,0.06)",
                        background: "rgba(255,255,255,0.025)",
                      }}
                    >
                      {row.port}
                    </td>
                    <td style={{ padding: "11px 10px", textAlign: "center", borderTop: "1px solid rgba(255,255,255,0.06)", borderRight: "1px solid rgba(255,255,255,0.06)", color: row.oilFenceCharge === "NA" ? subtleNaText(row.port) : "#f5fbff", textTransform: "uppercase" }}>
                      {row.oilFenceCharge}
                    </td>
                    <td style={{ padding: "11px 10px", textAlign: "center", borderTop: "1px solid rgba(255,255,255,0.06)", borderRight: "1px solid rgba(255,255,255,0.06)", textTransform: "uppercase" }}>
                      {row.deliveryMode}
                    </td>
                    <td style={{ padding: "11px 10px", textAlign: "center", borderTop: "1px solid rgba(255,255,255,0.06)", borderRight: "1px solid rgba(255,255,255,0.06)", color: row.hsfo === "NA" ? subtleNaText(row.port) : "#f5fbff" }}>
                      {row.hsfo}
                    </td>
                    <td style={{ padding: "11px 10px", textAlign: "center", borderTop: "1px solid rgba(255,255,255,0.06)", borderRight: "1px solid rgba(255,255,255,0.06)" }}>
                      {row.vlsfo}
                    </td>
                    <td style={{ padding: "11px 10px", textAlign: "center", borderTop: "1px solid rgba(255,255,255,0.06)", borderRight: "1px solid rgba(255,255,255,0.06)" }}>
                      {row.lsmgo}
                    </td>
                    <td style={{ padding: "11px 10px", textAlign: "center", borderTop: "1px solid rgba(255,255,255,0.06)" }}>
                      {row.mgoSulfur}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
                      background: "linear-gradient(180deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0.025) 100%)",
                      border: "1px solid rgba(255,255,255,0.08)",
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
                        background: "linear-gradient(180deg, rgba(88, 182, 255, 0.2) 0%, rgba(28, 102, 168, 0.12) 100%)",
                        color: "#dff3ff",
                        fontSize: "10px",
                        fontWeight: 700,
                      }}
                    >
                      {index + 1}
                    </span>
                    <span style={{ lineHeight: 1.5, textTransform: "uppercase" }}>{item}</span>
                  </div>
                ))}
            </div>
          </div>
        )}

        <div style={{ textAlign: "center", marginBottom: "24px" }}>
          <a
            href="/"
            style={{
              ...pillButtonStyle,
              gap: "10px",
              color: "#ffd4d8",
              background: "linear-gradient(180deg, rgba(210, 74, 74, 0.18) 0%, rgba(170, 47, 53, 0.1) 100%)",
              border: "1px solid rgba(255, 120, 120, 0.18)",
              textTransform: "uppercase",
              letterSpacing: "0.08em",
            }}
          >
            Back To Bunker Map
          </a>
        </div>

        <div style={{ marginTop: "20px" }}>
          <DisclaimerLink centered />
        </div>
      </div>
    </div>
  )
}
