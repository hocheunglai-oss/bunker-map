"use client"

import { useEffect, useMemo, useState } from "react"
import { useSimpleAdminAuth } from "@/lib/useSimpleAdminAuth"
import { useIsMobile } from "@/lib/useIsMobile"

type EnquiryEntry = {
  id: string
  rawBody: string
  displayBody: string
  country: string
  agent: string
  client: string
}

const STORAGE_KEY = "bunker-map-enquiry-workflow"
const STORAGE_RESET_KEY = "bunker-map-enquiry-workflow-reset"

const pageShellStyle: React.CSSProperties = {
  minHeight: "100vh",
  background: "linear-gradient(180deg, #0a2c4c 0%, #06213b 32%, #041629 100%)",
  fontFamily: "Arial, Helvetica, sans-serif",
  color: "#edf7ff",
}

const sidebarStyle: React.CSSProperties = {
  width: "220px",
  padding: "18px",
  borderRight: "1px solid rgba(210, 236, 255, 0.1)",
  background: "linear-gradient(180deg, rgba(8, 24, 44, 0.92) 0%, rgba(5, 18, 34, 0.9) 100%)",
}

const panelStyle: React.CSSProperties = {
  background: "linear-gradient(180deg, rgba(14, 43, 70, 0.88) 0%, rgba(7, 26, 44, 0.86) 100%)",
  border: "1px solid rgba(210, 236, 255, 0.14)",
  borderRadius: "22px",
  boxShadow: "0 20px 44px rgba(0, 0, 0, 0.18), inset 0 1px 0 rgba(255,255,255,0.05)",
}

const buttonStyle: React.CSSProperties = {
  padding: "10px 14px",
  borderRadius: "999px",
  border: "1px solid rgba(210,236,255,0.16)",
  background: "linear-gradient(180deg, rgba(255,255,255,0.18) 0%, rgba(255,255,255,0.1) 100%)",
  color: "#d7e8ff",
  textDecoration: "none",
  fontSize: "13px",
  fontWeight: 700,
  boxShadow: "inset 0 1px 0 rgba(255,255,255,0.08), 0 10px 24px rgba(8,24,44,0.16)",
  cursor: "pointer",
}

const textareaStyle: React.CSSProperties = {
  width: "100%",
  padding: "12px 14px",
  borderRadius: "14px",
  border: "1px solid rgba(210,236,255,0.16)",
  background: "linear-gradient(180deg, rgba(255,255,255,0.12) 0%, rgba(255,255,255,0.05) 100%)",
  color: "#edf7ff",
  fontSize: "14px",
  outline: "none",
  boxSizing: "border-box",
  minHeight: "130px",
  resize: "vertical",
  lineHeight: 1.6,
  fontFamily: "Arial, Helvetica, sans-serif",
}

const modalBackdropStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(2, 10, 18, 0.62)",
  backdropFilter: "blur(8px)",
  WebkitBackdropFilter: "blur(8px)",
  display: "grid",
  placeItems: "center",
  zIndex: 2000,
  padding: "20px",
}

const countryPortMap: Record<string, string[]> = {
  China: [
    "china",
    "shanghai",
    "zhoushan",
    "jingtang",
    "ningbo",
    "qingdao",
    "dalian",
    "tianjin",
    "huanghua",
    "xiamen",
    "guangzhou",
    "shenzhen",
    "zhanjiang",
    "caofeidian",
    "rizhao",
  ],
  "Hong Kong": ["hong kong", "hk"],
  Singapore: ["singapore", "sgp"],
  Japan: [
    "japan",
    "tokyo bay",
    "tokyo",
    "tokuyama",
    "yokohama",
    "chiba",
    "nagoya",
    "osaka",
    "kobe",
    "mizushima",
    "sakai",
  ],
  "South Korea": [
    "south korea",
    "korea",
    "busan",
    "ulsan",
    "incheon",
    "yeosu",
    "daesan",
    "pyongtaek",
    "masan",
  ],
  Malaysia: ["malaysia", "port klang", "klang", "pasir gudang", "tanjung pelepas", "ptp"],
  Taiwan: ["taiwan", "kaohsiung", "keelung", "taichung", "mailiao", "taipei"],
  Vietnam: ["vietnam", "ho chi minh", "saigon", "vung tau", "haiphong", "hai phong"],
  Thailand: ["thailand", "laem chabang", "bangkok", "sriracha"],
  Indonesia: ["indonesia", "jakarta", "surabaya", "balikpapan", "belawan"],
  UAE: ["uae", "fujairah", "jebel ali", "dubai", "abu dhabi", "khor fakkan"],
}

function getHongKongDateParts(date: Date) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Hong_Kong",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })

  const parts = formatter.formatToParts(date)
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))

  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
  }
}

function getActiveResetKey(date: Date) {
  const { year, month, day, hour, minute } = getHongKongDateParts(date)
  const beforeReset = hour < 10 || (hour === 10 && minute < 30)
  const utcDate = new Date(Date.UTC(year, month - 1, day))

  if (beforeReset) {
    utcDate.setUTCDate(utcDate.getUTCDate() - 1)
  }

  return utcDate.toISOString().slice(0, 10)
}

function cleanWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim()
}

function splitSegments(value: string) {
  return value
    .split(/\s*\/\s*|\n+/)
    .map((segment) => segment.trim())
    .filter(Boolean)
}

function extractField(rawBody: string, field: "agent" | "client") {
  const regex = new RegExp(`${field}\\s*:\\s*([^/\\n]+)`, "i")
  const match = rawBody.match(regex)
  return cleanWhitespace(match?.[1] || "")
}

function buildVisibleBody(rawBody: string) {
  return splitSegments(rawBody)
    .filter((segment) => !/^(agent|client)\s*:/i.test(segment))
    .join(" / ")
}

function detectCountry(rawBody: string) {
  const haystack = rawBody.toLowerCase()

  for (const [country, aliases] of Object.entries(countryPortMap)) {
    if (aliases.some((alias) => haystack.includes(alias))) {
      return country
    }
  }

  return "Unsorted"
}

function buildEnquiryEntry(rawBody: string, id?: string): EnquiryEntry {
  const cleaned = rawBody
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" / ")

  return {
    id: id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    rawBody: cleaned,
    displayBody: buildVisibleBody(cleaned),
    country: detectCountry(cleaned),
    agent: extractField(cleaned, "agent"),
    client: extractField(cleaned, "client"),
  }
}

function normalizeStoredEntry(value: unknown): EnquiryEntry | null {
  if (!value || typeof value !== "object") return null

  const record = value as Record<string, unknown>
  const rawBody =
    typeof record.rawBody === "string"
      ? record.rawBody
      : typeof record.body === "string"
        ? record.body
        : ""

  if (!rawBody.trim()) return null

  return buildEnquiryEntry(rawBody, typeof record.id === "string" ? record.id : undefined)
}

function buildStemText(entry: EnquiryEntry) {
  const lines = [entry.displayBody]

  if (entry.agent) {
    lines.push(`agent: ${entry.agent}`)
  }

  lines.push("")
  lines.push("buy - sell")
  lines.push(` - ${entry.client || ""}`)

  return lines.join("\n")
}

function CompactIconButton({
  label,
  title,
  onClick,
}: {
  label: string
  title: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={title}
      title={title}
      style={{
        width: "24px",
        height: "24px",
        borderRadius: "999px",
        border: "1px solid rgba(210,236,255,0.14)",
        background: "rgba(255,255,255,0.06)",
        color: "#d8ebfb",
        fontSize: "11px",
        fontWeight: 800,
        cursor: "pointer",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 0,
      }}
    >
      {label}
    </button>
  )
}

export default function EnquiryWorkflowPage() {
  const { loading: adminLoading, authenticated } = useSimpleAdminAuth()
  const isMobile = useIsMobile()
  const [draft, setDraft] = useState("")
  const [entries, setEntries] = useState<EnquiryEntry[]>([])
  const [copiedGroup, setCopiedGroup] = useState("")
  const [hoveredEntryId, setHoveredEntryId] = useState("")
  const [editingEntry, setEditingEntry] = useState<EnquiryEntry | null>(null)
  const [editingDraft, setEditingDraft] = useState("")
  const [stemEntry, setStemEntry] = useState<EnquiryEntry | null>(null)

  useEffect(() => {
    if (typeof window === "undefined") return

    const storedResetKey = window.localStorage.getItem(STORAGE_RESET_KEY)
    const activeResetKey = getActiveResetKey(new Date())

    if (storedResetKey !== activeResetKey) {
      window.localStorage.setItem(STORAGE_RESET_KEY, activeResetKey)
      window.localStorage.removeItem(STORAGE_KEY)
      setEntries([])
      return
    }

    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return

    try {
      const parsed = JSON.parse(raw) as unknown[]
      setEntries(parsed.map(normalizeStoredEntry).filter((entry): entry is EnquiryEntry => entry != null))
    } catch {
      window.localStorage.removeItem(STORAGE_KEY)
    }
  }, [])

  useEffect(() => {
    if (typeof window === "undefined") return
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries))
  }, [entries])

  useEffect(() => {
    if (typeof window === "undefined") return

    function syncResetWindow() {
      const activeResetKey = getActiveResetKey(new Date())
      const storedResetKey = window.localStorage.getItem(STORAGE_RESET_KEY)

      if (storedResetKey !== activeResetKey) {
        window.localStorage.setItem(STORAGE_RESET_KEY, activeResetKey)
        window.localStorage.removeItem(STORAGE_KEY)
        setEntries([])
      }
    }

    syncResetWindow()
    const timer = window.setInterval(syncResetWindow, 60 * 1000)
    return () => window.clearInterval(timer)
  }, [])

  const groupedEntries = useMemo(() => {
    const next = new Map<string, EnquiryEntry[]>()

    entries.forEach((entry) => {
      const bucket = next.get(entry.country) || []
      bucket.push(entry)
      next.set(entry.country, bucket)
    })

    return Array.from(next.entries()).sort((left, right) => {
      if (left[0] === "Unsorted") return 1
      if (right[0] === "Unsorted") return -1
      return left[0].localeCompare(right[0])
    })
  }, [entries])

  function handleAddEnquiry() {
    const trimmed = draft.trim()
    if (!trimmed) return

    setEntries((current) => [buildEnquiryEntry(trimmed), ...current])
    setDraft("")
  }

  function removeEntry(id: string) {
    setEntries((current) => current.filter((entry) => entry.id !== id))
  }

  function openEdit(entry: EnquiryEntry) {
    setEditingEntry(entry)
    setEditingDraft(entry.rawBody)
  }

  function saveEdit() {
    if (!editingEntry || !editingDraft.trim()) return

    const nextEntry = buildEnquiryEntry(editingDraft, editingEntry.id)
    setEntries((current) => current.map((entry) => (entry.id === editingEntry.id ? nextEntry : entry)))
    setEditingEntry(null)
    setEditingDraft("")
  }

  async function copyGroup(country: string, groupEntries: EnquiryEntry[]) {
    const text = groupEntries.map((entry) => entry.rawBody).join("\n")
    await navigator.clipboard.writeText(text)
    setCopiedGroup(country)
    window.setTimeout(() => setCopiedGroup((current) => (current === country ? "" : current)), 1600)
  }

  if (!adminLoading && !authenticated) return <p style={{ padding: "40px" }}>Access Denied</p>
  if (adminLoading) return <p style={{ padding: "40px" }}>Loading...</p>

  return (
    <div style={pageShellStyle}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: isMobile ? "1fr" : "220px minmax(0, 1fr)",
          minHeight: "100vh",
        }}
      >
        {!isMobile && (
          <aside style={sidebarStyle}>
            <a
              href="/admin"
              style={{ ...buttonStyle, display: "block", textAlign: "center", marginBottom: "18px" }}
            >
              Back
            </a>
          </aside>
        )}

        <main style={{ padding: isMobile ? "18px" : "28px" }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: isMobile ? "1fr" : "minmax(0, 1.05fr) minmax(320px, 0.95fr)",
              gap: "14px",
            }}
          >
            <section style={{ ...panelStyle, padding: isMobile ? "18px" : "20px" }}>
              <textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                    event.preventDefault()
                    handleAddEnquiry()
                  }
                }}
                placeholder="Type or paste the enquiry here..."
                style={textareaStyle}
              />

              <div style={{ display: "flex", gap: "10px", marginTop: "12px", flexWrap: "wrap" }}>
                <button
                  type="button"
                  onClick={handleAddEnquiry}
                  style={{
                    ...buttonStyle,
                    background: "linear-gradient(180deg, rgba(56, 214, 154, 0.34) 0%, rgba(20, 130, 93, 0.16) 100%)",
                    color: "#ddffef",
                    border: "1px solid rgba(73, 219, 165, 0.26)",
                  }}
                >
                  Add Enquiry
                </button>
              </div>
            </section>

            <aside style={{ ...panelStyle, padding: isMobile ? "14px" : "16px" }}>
              {groupedEntries.length > 0 && (
                <div style={{ display: "grid", gap: "8px" }}>
                  {groupedEntries.map(([country, groupEntries]) => (
                    <div
                      key={country}
                      style={{
                        borderRadius: "14px",
                        border: "1px solid rgba(210,236,255,0.1)",
                        background: "rgba(255,255,255,0.04)",
                        padding: "8px 10px",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: "8px",
                          marginBottom: "6px",
                        }}
                      >
                        <div style={{ fontSize: "16px", fontWeight: 700, color: "#eef7ff" }}>
                          {country}
                        </div>
                        <CompactIconButton
                          label={copiedGroup === country ? "✓" : "⧉"}
                          title="Copy all"
                          onClick={() => void copyGroup(country, groupEntries)}
                        />
                      </div>

                      <div style={{ display: "grid", gap: "4px" }}>
                        {groupEntries.map((entry) => {
                          const hasHiddenDetails = Boolean(entry.agent || entry.client)

                          return (
                            <div
                              key={entry.id}
                              style={{
                                position: "relative",
                                borderRadius: "10px",
                                background: "rgba(4, 16, 29, 0.28)",
                                padding: "6px 8px",
                              }}
                              onMouseEnter={() => setHoveredEntryId(entry.id)}
                              onMouseLeave={() => setHoveredEntryId("")}
                            >
                              <div
                                style={{
                                  display: "grid",
                                  gridTemplateColumns: "minmax(0, 1fr) auto",
                                  gap: "8px",
                                  alignItems: "start",
                                }}
                              >
                                <div
                                  style={{
                                    color: "#edf7ff",
                                    fontSize: "12px",
                                    lineHeight: 1.35,
                                    whiteSpace: "normal",
                                    wordBreak: "break-word",
                                  }}
                                >
                                  {entry.displayBody}
                                </div>

                                <div style={{ display: "flex", gap: "4px", alignItems: "center" }}>
                                  <CompactIconButton
                                    label="S"
                                    title="Stem"
                                    onClick={() => setStemEntry(entry)}
                                  />
                                  <CompactIconButton
                                    label="E"
                                    title="Edit"
                                    onClick={() => openEdit(entry)}
                                  />
                                  <CompactIconButton
                                    label="D"
                                    title="Delete"
                                    onClick={() => removeEntry(entry.id)}
                                  />
                                </div>
                              </div>

                              {hasHiddenDetails && hoveredEntryId === entry.id && (
                                <div
                                  style={{
                                    position: "absolute",
                                    right: "8px",
                                    top: "calc(100% + 6px)",
                                    zIndex: 20,
                                    minWidth: "180px",
                                    maxWidth: "260px",
                                    borderRadius: "12px",
                                    border: "1px solid rgba(210,236,255,0.18)",
                                    background: "linear-gradient(180deg, rgba(9, 25, 42, 0.96) 0%, rgba(6, 18, 30, 0.96) 100%)",
                                    boxShadow: "0 18px 40px rgba(0,0,0,0.28)",
                                    padding: "8px 10px",
                                    color: "#d9ebfb",
                                    fontSize: "12px",
                                    lineHeight: 1.45,
                                    whiteSpace: "pre-wrap",
                                  }}
                                >
                                  {entry.agent ? `agent: ${entry.agent}` : ""}
                                  {entry.agent && entry.client ? "\n" : ""}
                                  {entry.client ? `client: ${entry.client}` : ""}
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </aside>
          </div>
        </main>
      </div>

      {editingEntry && (
        <div style={modalBackdropStyle} onClick={() => setEditingEntry(null)}>
          <div
            style={{ ...panelStyle, width: "min(720px, 100%)", padding: "18px" }}
            onClick={(event) => event.stopPropagation()}
          >
            <textarea
              value={editingDraft}
              onChange={(event) => setEditingDraft(event.target.value)}
              style={{ ...textareaStyle, minHeight: "220px" }}
            />
            <div style={{ display: "flex", gap: "10px", justifyContent: "flex-end", marginTop: "12px" }}>
              <button type="button" onClick={() => setEditingEntry(null)} style={buttonStyle}>
                Cancel
              </button>
              <button
                type="button"
                onClick={saveEdit}
                style={{
                  ...buttonStyle,
                  background: "linear-gradient(180deg, rgba(56, 214, 154, 0.34) 0%, rgba(20, 130, 93, 0.16) 100%)",
                  color: "#ddffef",
                  border: "1px solid rgba(73, 219, 165, 0.26)",
                }}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {stemEntry && (
        <div style={modalBackdropStyle} onClick={() => setStemEntry(null)}>
          <div
            style={{ ...panelStyle, width: "min(620px, 100%)", padding: "18px" }}
            onClick={(event) => event.stopPropagation()}
          >
            <pre
              style={{
                margin: 0,
                whiteSpace: "pre-wrap",
                color: "#edf7ff",
                fontSize: "14px",
                lineHeight: 1.6,
                fontFamily: "Arial, Helvetica, sans-serif",
              }}
            >
              {buildStemText(stemEntry)}
            </pre>
            <div style={{ display: "flex", justifyContent: "space-between", gap: "10px", marginTop: "14px" }}>
              <button type="button" onClick={() => setStemEntry(null)} style={buttonStyle}>
                Close
              </button>
              <button
                type="button"
                onClick={async () => {
                  await navigator.clipboard.writeText(buildStemText(stemEntry))
                }}
                style={{
                  ...buttonStyle,
                  background: "linear-gradient(180deg, rgba(86, 164, 255, 0.38) 0%, rgba(32, 106, 194, 0.2) 100%)",
                  color: "#e7f3ff",
                  border: "1px solid rgba(108, 185, 255, 0.24)",
                }}
              >
                Copy
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
