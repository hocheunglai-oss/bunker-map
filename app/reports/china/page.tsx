"use client"

import { useEffect, useMemo, useState } from "react"
import {
  chinaReportSections as reportSections,
  defaultExpandablePreviewRows,
} from "@/data/reportSections"
import { loadReportSnapshot } from "@/lib/reportSnapshots"
import { type ChinaReportSection } from "@/lib/chinaReport"
import { useIsMobile } from "@/lib/useIsMobile"
import DisclaimerLink from "@/components/DisclaimerLink"
import { buildFallbackKey, loadReportFallbacks, type FallbackMap } from "@/lib/reportFallbacks"

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

const headerCardStyle: React.CSSProperties = {
  ...cardStyle,
  background:
    "radial-gradient(circle at top left, rgba(88, 182, 255, 0.1), transparent 30%), linear-gradient(180deg, rgba(4, 24, 49, 0.84) 0%, rgba(5, 22, 40, 0.78) 100%)",
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

function formatValue(value: number | null, fallback: string) {
  if (value == null) return fallback
  return Number.isInteger(value) ? String(value) : value.toFixed(2)
}

function balanceRemainingSections(
  sections: ChinaReportSection[],
  initialColumns: [ChinaReportSection[], ChinaReportSection[]],
  rowCount: (section: ChinaReportSection) => number
) {
  const columns: [ChinaReportSection[], ChinaReportSection[]] = [[...initialColumns[0]], [...initialColumns[1]]]
  const counts = columns.map((columnSections) =>
    columnSections.reduce((sum, section) => sum + rowCount(section) + 1, 0)
  )
  const pinnedTitles = new Set(columns.flat().map((section) => section.title))
  const remainingSections = sections.filter((section) => !pinnedTitles.has(section.title))

  for (const section of [...remainingSections].sort((a, b) => rowCount(b) - rowCount(a))) {
    const columnIndex = counts[0] <= counts[1] ? 0 : 1
    columns[columnIndex].push(section)
    counts[columnIndex] += rowCount(section) + 1
  }

  return columns
}

function getSection(sections: ChinaReportSection[], title: string) {
  return sections.find((section) => section.title === title)
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
  const [fallbacks, setFallbacks] = useState<FallbackMap>({})
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

  useEffect(() => {
    async function load() {
      setFallbacks(await loadReportFallbacks())
    }
    load()
  }, [])

  function fuelFallback(port: string, fuel: "hsfo" | "vlsfo" | "mgo") {
    return fallbacks[buildFallbackKey(port, fuel)] || "-"
  }

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

  const totalRows = useMemo(
    () => sections.reduce((sum, section) => sum + section.rows.length, 0),
    [sections]
  )

  const [leftSections, rightSections] = useMemo(
    () => {
      const chinaEast = getSection(sections, "CHINA (EAST)")
      const chinaNorth = getSection(sections, "CHINA (NORTH)")
      const chinaSouth = getSection(sections, "CHINA (SOUTH)")

      return balanceRemainingSections(
        sections,
        [chinaEast ? [chinaEast] : [], [chinaNorth, chinaSouth].filter(Boolean) as ChinaReportSection[]],
        (section) => section.rows.length
      )
    },
    [sections]
  )

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
                maxWidth: isMobile ? "180px" : "220px",
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
                style={{ width: "100%", height: "auto", maxWidth: isMobile ? "180px" : "210px", opacity: 0.96 }}
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
                            {formatValue(row.hsfo, fuelFallback(row.port, "hsfo"))}
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
                            {formatValue(row.vlsfo, fuelFallback(row.port, "vlsfo"))}
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
                            {formatValue(row.mgo, fuelFallback(row.port, "mgo"))}
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

        <div style={{ marginTop: "20px" }}>
          <DisclaimerLink centered />
        </div>
      </div>
    </div>
  )
}
