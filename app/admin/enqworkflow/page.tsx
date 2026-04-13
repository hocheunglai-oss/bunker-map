"use client"

import { useEffect, useMemo, useState } from "react"
import ports from "@/data/ports.json"
import { useSimpleAdminAuth } from "@/lib/useSimpleAdminAuth"
import { useIsMobile } from "@/lib/useIsMobile"

type EnquiryEntry = {
  id: string
  body: string
  group: string
  createdAt: string
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

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "12px 14px",
  borderRadius: "14px",
  border: "1px solid rgba(210,236,255,0.16)",
  background: "linear-gradient(180deg, rgba(255,255,255,0.12) 0%, rgba(255,255,255,0.05) 100%)",
  color: "#edf7ff",
  fontSize: "14px",
  outline: "none",
  boxSizing: "border-box",
}

const textareaStyle: React.CSSProperties = {
  ...inputStyle,
  minHeight: "130px",
  resize: "vertical",
  lineHeight: 1.6,
  fontFamily: "Arial, Helvetica, sans-serif",
}

const groupAliasMap: Record<string, string[]> = {
  Singapore: ["singapore", "sgp"],
  "Hong Kong": ["hong kong", "hk"],
  Zhoushan: ["zhoushan"],
  Shanghai: ["shanghai"],
  Busan: ["busan"],
  Ulsan: ["ulsan"],
  Japan: ["tokyo bay", "tokyo", "japan"],
  "South Korea": ["south korea", "korea"],
  China: ["china"],
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

function detectGroup(body: string) {
  const haystack = body.toLowerCase()

  for (const [label, aliases] of Object.entries(groupAliasMap)) {
    if (aliases.some((alias) => haystack.includes(alias))) {
      return label
    }
  }

  for (const port of ports) {
    if (haystack.includes(port.name.toLowerCase())) {
      return port.name
    }
  }

  return "Unsorted"
}

function formatDateTime(value: string) {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value

  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Hong_Kong",
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(parsed)
}

export default function EnquiryWorkflowPage() {
  const { loading: adminLoading, authenticated } = useSimpleAdminAuth()
  const isMobile = useIsMobile()
  const [draft, setDraft] = useState("")
  const [entries, setEntries] = useState<EnquiryEntry[]>([])
  const [copiedGroup, setCopiedGroup] = useState("")

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
      const parsed = JSON.parse(raw) as EnquiryEntry[]
      setEntries(parsed)
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
      const bucket = next.get(entry.group) || []
      bucket.push(entry)
      next.set(entry.group, bucket)
    })

    return Array.from(next.entries()).sort((left, right) => {
      if (left[0] === "Unsorted") return 1
      if (right[0] === "Unsorted") return -1
      return left[0].localeCompare(right[0])
    })
  }, [entries])

  async function handleAddEnquiry() {
    const trimmed = draft.trim()
    if (!trimmed) return

    const nextEntry: EnquiryEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      body: trimmed,
      group: detectGroup(trimmed),
      createdAt: new Date().toISOString(),
    }

    setEntries((current) => [nextEntry, ...current])
    setDraft("")
  }

  function removeEntry(id: string) {
    setEntries((current) => current.filter((entry) => entry.id !== id))
  }

  async function copyGroup(group: string, groupEntries: EnquiryEntry[]) {
    const text = groupEntries.map((entry) => entry.body).join("\n\n")
    await navigator.clipboard.writeText(text)
    setCopiedGroup(group)
    window.setTimeout(() => setCopiedGroup((current) => (current === group ? "" : current)), 1600)
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
              ← Back To Admin
            </a>
          </aside>
        )}

        <main style={{ padding: isMobile ? "18px" : "28px" }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: isMobile ? "1fr" : "minmax(0, 1.2fr) minmax(320px, 0.8fr)",
              gap: "18px",
            }}
          >
            <section style={{ ...panelStyle, padding: isMobile ? "18px" : "22px" }}>
              <div style={{ marginBottom: "14px" }} />

              <textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="Type or paste the enquiry here..."
                style={textareaStyle}
              />

              <div style={{ display: "flex", gap: "10px", marginTop: "14px", flexWrap: "wrap" }}>
                <button
                  type="button"
                  onClick={() => void handleAddEnquiry()}
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

            <aside style={{ ...panelStyle, padding: isMobile ? "18px" : "22px" }}>
              <div style={{ marginBottom: "12px" }} />

              {groupedEntries.length === 0 ? (
                <div style={{ color: "#9ebad1", fontSize: "14px", lineHeight: 1.6 }} />
              ) : (
                <div style={{ display: "grid", gap: "14px" }}>
                  {groupedEntries.map(([group, groupEntries]) => (
                    <div
                      key={group}
                      style={{
                        borderRadius: "18px",
                        border: "1px solid rgba(210,236,255,0.12)",
                        background: "linear-gradient(180deg, rgba(255,255,255,0.08) 0%, rgba(255,255,255,0.03) 100%)",
                        padding: "14px",
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "10px", marginBottom: "10px", flexWrap: "wrap" }}>
                        <div style={{ fontSize: "22px", fontWeight: 700 }}>{group}</div>
                        <button
                          type="button"
                          onClick={() => void copyGroup(group, groupEntries)}
                          style={{
                            ...buttonStyle,
                            minWidth: "100px",
                            background: copiedGroup === group
                              ? "linear-gradient(180deg, rgba(56, 214, 154, 0.34) 0%, rgba(20, 130, 93, 0.16) 100%)"
                              : buttonStyle.background,
                            color: copiedGroup === group ? "#ddffef" : buttonStyle.color,
                          }}
                        >
                          {copiedGroup === group ? "Copied" : "Copy All"}
                        </button>
                      </div>

                      <div style={{ display: "grid", gap: "10px" }}>
                        {groupEntries.map((entry) => (
                          <div
                            key={entry.id}
                            style={{
                              borderRadius: "14px",
                              border: "1px solid rgba(210,236,255,0.08)",
                              background: "rgba(6, 20, 34, 0.3)",
                              padding: "12px",
                            }}
                          >
                            <div style={{ whiteSpace: "pre-wrap", color: "#edf7ff", lineHeight: 1.65, marginBottom: "10px" }}>
                              {entry.body}
                            </div>
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                              <div style={{ color: "#98c4e4", fontSize: "12px" }}>
                                Added {formatDateTime(entry.createdAt)}
                              </div>
                              <button
                                type="button"
                                onClick={() => removeEntry(entry.id)}
                                style={{
                                  ...buttonStyle,
                                  padding: "6px 10px",
                                  fontSize: "12px",
                                  background: "linear-gradient(180deg, rgba(230, 57, 70, 0.18) 0%, rgba(170, 47, 53, 0.1) 100%)",
                                  color: "#ffd6db",
                                  border: "1px solid rgba(255, 120, 120, 0.18)",
                                }}
                              >
                                Delete
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </aside>
          </div>
        </main>
      </div>
    </div>
  )
}
