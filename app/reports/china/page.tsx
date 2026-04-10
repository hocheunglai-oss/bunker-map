"use client"

import { useEffect, useMemo, useState } from "react"
import {
  chinaLeftColumnTitles,
  chinaReportSections as reportSections,
  defaultExpandablePreviewRows,
} from "@/data/reportSections"
import { loadReportSnapshot } from "@/lib/reportSnapshots"
import { type ChinaReportSection } from "@/lib/chinaReport"
import { useIsMobile } from "@/lib/useIsMobile"
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
  maxWidth: "1160px",
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

const sectionTitleStyle: React.CSSProperties = {
  margin: 0,
  fontSize: "clamp(1.28rem, 2.2vw, 1.9rem)",
  lineHeight: 1.1,
  letterSpacing: "0.08em",
  fontWeight: 600,
  textShadow: "0 10px 28px rgba(4,16,29,0.24)",
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

function formatValue(value: number | null) {
  if (value == null) return "-"
  return Number.isInteger(value) ? String(value) : value.toFixed(2)
}

const sectionCardStyle: React.CSSProperties = {
  background:
    "radial-gradient(circle at top left, rgba(88, 182, 255, 0.08), transparent 28%), linear-gradient(180deg, rgba(4, 24, 49, 0.82) 0%, rgba(5, 22, 40, 0.76) 100%)",
  border: "1px solid rgba(173, 216, 255, 0.18)",
  borderRadius: "20px",
  overflow: "hidden",
  boxShadow: "0 18px 44px rgba(0, 0, 0, 0.24), inset 0 1px 0 rgba(255,255,255,0.05)",
}

export default function ChinaReport() {
  const isMobile = useIsMobile()
  const [sections, setSections] = useState<ChinaReportSection[]>([])
  const [reportDate, setReportDate] = useState("")
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({})

  useEffect(() => {
    async function load() {
      const snapshot = await loadReportSnapshot<{
        reportDate: string
        sections: ChinaReportSection[]
      }>("china")

      if (!snapshot) return

      setReportDate(snapshot.reportDate)
      setSections(snapshot.sections)
    }

    load()
  }, [])

  const totalRows = useMemo(
    () => sections.reduce((sum, section) => sum + section.rows.length, 0),
    [sections]
  )

  const leftSections = sections.filter((section) => chinaLeftColumnTitles.includes(section.title))
  const rightSections = sections.filter((section) => !chinaLeftColumnTitles.includes(section.title))

  function toggleSection(title: string) {
    setExpandedSections((prev) => ({
      ...prev,
      [title]: !prev[title],
    }))
  }

  function visibleRows(section: ChinaReportSection) {
    if (expandedSections[section.title]) return section.rows
    const preview = defaultExpandablePreviewRows[section.title]
    if (!preview) return section.rows
    const previewSet = new Set(preview)
    return section.rows.filter((row) => previewSet.has(row.port))
  }

  return (
    <div style={pageStyle}>
      <div style={shellStyle}>
        <div style={{ ...cardStyle, padding: isMobile ? "16px" : "24px", marginBottom: "18px", position: "relative", overflow: "hidden" }}>
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
            <div
              style={{
                width: isMobile ? "auto" : "100%",
                maxWidth: isMobile ? "180px" : "220px",
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
                style={{ width: "100%", height: "auto", maxWidth: isMobile ? "180px" : "210px", opacity: 0.96 }}
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
              <h1 style={sectionTitleStyle}>CHINA MARKET REPORT</h1>
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

        {totalRows === 0 ? (
          <div style={{ ...cardStyle, padding: "18px", marginBottom: "24px", textAlign: "center", color: "#d7e9ff" }}>
            No report data available.
          </div>
        ) : (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: isMobile ? "1fr" : "minmax(0, 1fr) minmax(0, 1fr)",
              gap: "18px",
              marginBottom: "24px",
            }}
          >
            {[leftSections, rightSections].map((columnSections, columnIndex) => (
              <div key={columnIndex} style={{ display: "grid", gap: "18px", alignContent: "start" }}>
                {columnSections.map((section) => {
                  const rowsToShow = visibleRows(section)
                  const isExpandable = Boolean(defaultExpandablePreviewRows[section.title])
                  const isExpanded = Boolean(expandedSections[section.title])

                  return (
                    <div key={section.title} style={sectionCardStyle}>
                      <div
                        style={{
                          padding: "11px 16px",
                          background: "linear-gradient(90deg, rgba(16, 71, 126, 0.98) 0%, rgba(10, 43, 78, 0.98) 100%)",
                          color: "#f4fbff",
                          fontWeight: 700,
                          letterSpacing: "0.1em",
                          textTransform: "uppercase",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: "12px",
                          fontSize: "12px",
                        }}
                      >
                        <span>{section.title}</span>
                        {isExpandable && (
                          <button
                            onClick={() => toggleSection(section.title)}
                            style={{
                              width: "28px",
                              height: "28px",
                              borderRadius: "999px",
                              border: "1px solid rgba(143,215,255,0.22)",
                              background: "linear-gradient(180deg, rgba(72, 170, 255, 0.24) 0%, rgba(20, 112, 196, 0.12) 100%)",
                              color: "#d7e8ff",
                              cursor: "pointer",
                              fontSize: "17px",
                              lineHeight: 1,
                              fontWeight: 700,
                              boxShadow: "inset 0 1px 0 rgba(255,255,255,0.08)",
                            }}
                          >
                            {isExpanded ? "−" : "+"}
                          </button>
                        )}
                      </div>

                      <div
                        style={{
                          display: "grid",
                          gridTemplateColumns: isMobile
                            ? "minmax(110px, 1fr) 68px 68px 68px"
                            : "minmax(180px, 1fr) 100px 100px 100px",
                          background: "rgba(255,255,255,0.035)",
                          borderTop: "1px solid rgba(255,255,255,0.08)",
                          fontVariantNumeric: "tabular-nums",
                        }}
                      >
                        {[
                          { label: "PORT", accent: "transparent" },
                          { label: "HSFO", accent: "rgba(90,169,255,0.18)" },
                          { label: "VLSFO", accent: "rgba(87,227,176,0.18)" },
                          { label: "LSMGO", accent: "rgba(255,209,102,0.18)" },
                        ].map((item, index) => (
                          <div
                            key={item.label}
                            style={{
                              padding: isMobile ? "8px 10px" : "10px 14px",
                              fontSize: isMobile ? "10px" : "12px",
                              fontWeight: 700,
                              color: "#cfe9ff",
                              textAlign: index === 0 ? "left" : "center",
                              borderRight: index < 3 ? "1px solid rgba(255,255,255,0.12)" : undefined,
                              letterSpacing: "0.06em",
                              boxShadow: index === 0 ? undefined : `inset 0 -2px 0 ${item.accent}`,
                            }}
                          >
                            {item.label}
                          </div>
                        ))}
                      </div>

                      {rowsToShow.map((row, index) => (
                        <div
                          key={`${section.title}-${row.port}`}
                          style={{
                            display: "grid",
                            gridTemplateColumns: isMobile
                              ? "minmax(110px, 1fr) 68px 68px 68px"
                              : "minmax(180px, 1fr) 100px 100px 100px",
                            background:
                              index % 2 === 0
                                ? "rgba(8, 46, 88, 0.76)"
                                : "rgba(7, 37, 70, 0.68)",
                            borderTop: "1px solid rgba(255,255,255,0.08)",
                          }}
                        >
                          <div
                            style={{
                              padding: "11px 14px",
                              borderRight: "1px solid rgba(255,255,255,0.12)",
                              fontWeight: 600,
                              fontSize: "14px",
                              whiteSpace: "nowrap",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              background: "rgba(255,255,255,0.02)",
                            }}
                          >
                            {row.port}
                          </div>
                          <div
                            style={{
                              padding: "11px 14px",
                              borderRight: "1px solid rgba(255,255,255,0.12)",
                              textAlign: "center",
                              whiteSpace: "nowrap",
                              fontSize: "14px",
                              color: "#eef7ff",
                            }}
                          >
                            {formatValue(row.hsfo)}
                          </div>
                          <div
                            style={{
                              padding: "11px 14px",
                              borderRight: "1px solid rgba(255,255,255,0.12)",
                              textAlign: "center",
                              whiteSpace: "nowrap",
                              fontSize: "14px",
                              color: "#eef7ff",
                            }}
                          >
                            {formatValue(row.vlsfo)}
                          </div>
                          <div
                            style={{
                              padding: "11px 14px",
                              textAlign: "center",
                              whiteSpace: "nowrap",
                              fontSize: "14px",
                              color: "#eef7ff",
                            }}
                          >
                            {formatValue(row.mgo)}
                          </div>
                        </div>
                      ))}
                    </div>
                  )
                })}
              </div>
            ))}
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
              Need more China bunker information?
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
              background: "linear-gradient(180deg, rgba(56, 214, 154, 0.32) 0%, rgba(20, 130, 93, 0.14) 100%)",
              color: "#ddffef",
              border: "1px solid rgba(73, 219, 165, 0.26)",
              textTransform: "uppercase",
              letterSpacing: "0.08em",
            }}
          >
            Contact On WhatsApp
          </a>
        </div>

        <div style={{ marginTop: "20px" }}>
          <DisclaimerLink centered />
        </div>
      </div>
    </div>
  )
}
