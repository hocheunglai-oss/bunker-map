"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { supabase } from "@/lib/supabase"
import { useSimpleAdminAuth } from "@/lib/useSimpleAdminAuth"
import { useIsMobile } from "@/lib/useIsMobile"

type CompanyInfoRecord = {
  id: string
  name: string
  summary: string | null
  notes: string | null
  updated_at?: string
}

type CompanyListRecord = {
  id: string
  name: string
}

const pageShellStyle: React.CSSProperties = {
  minHeight: "100vh",
  background: "linear-gradient(180deg, #0a2c4c 0%, #06213b 32%, #041629 100%)",
  fontFamily: "Arial, Helvetica, sans-serif",
  color: "#edf7ff",
}

const sidebarStyle: React.CSSProperties = {
  width: "280px",
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

const searchInputStyle: React.CSSProperties = {
  width: "100%",
  padding: "16px 18px",
  borderRadius: "18px",
  border: "1px solid rgba(210,236,255,0.18)",
  background: "linear-gradient(180deg, rgba(255,255,255,0.14) 0%, rgba(255,255,255,0.06) 100%)",
  color: "#edf7ff",
  fontSize: "16px",
  outline: "none",
  boxSizing: "border-box",
  boxShadow: "inset 0 1px 0 rgba(255,255,255,0.05)",
}

const fieldInputStyle: React.CSSProperties = {
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
  ...fieldInputStyle,
  minHeight: "420px",
  resize: "vertical",
  lineHeight: 1.75,
  fontFamily: "Arial, Helvetica, sans-serif",
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

function highlightTextHtml(text: string, query: string) {
  const escaped = escapeHtml(text || "")
  if (!query.trim()) return escaped.replace(/\n/g, "<br />")

  const regex = new RegExp(`(${escapeRegExp(query.trim())})`, "ig")
  return escaped
    .replace(
      regex,
      `<mark data-search-match="true" style="background: rgba(255, 226, 94, 0.34); color: #fff6bf; padding: 0 2px; border-radius: 4px;">$1</mark>`,
    )
    .replace(/\n/g, "<br />")
}

export default function CountryCompanyInfoPage() {
  const { loading: adminLoading, authenticated } = useSimpleAdminAuth()
  const isMobile = useIsMobile()
  const [suggestions, setSuggestions] = useState<CompanyListRecord[]>([])
  const [recordLoading, setRecordLoading] = useState(false)
  const [editingInfo, setEditingInfo] = useState(false)
  const [query, setQuery] = useState("")
  const [activeSuggestion, setActiveSuggestion] = useState(0)
  const [selectedId, setSelectedId] = useState("")
  const [form, setForm] = useState<CompanyInfoRecord>({ id: "", name: "", summary: "", notes: "" })
  const [message, setMessage] = useState("")
  const [saving, setSaving] = useState(false)
  const [searchInPage, setSearchInPage] = useState("")
  const [matchCount, setMatchCount] = useState(0)
  const [matchIndex, setMatchIndex] = useState(0)
  const infoRef = useRef<HTMLDivElement | null>(null)

  function goToPreviousMatch() {
    setMatchIndex((prev) => (matchCount ? (prev - 1 + matchCount) % matchCount : 0))
  }

  function goToNextMatch() {
    setMatchIndex((prev) => (matchCount ? (prev + 1) % matchCount : 0))
  }

  async function loadRecordById(id: string) {
    setRecordLoading(true)
    const { data, error } = await supabase
      .from("cc_companies")
      .select("id,name,summary,notes,updated_at")
      .eq("id", id)
      .single()

    if (error || !data) {
      setMessage("Unable to load company info.")
      setRecordLoading(false)
      return
    }

    setForm(data as CompanyInfoRecord)
    setRecordLoading(false)
  }

  useEffect(() => {
    if (adminLoading || !authenticated) return

    const needle = query.trim()
    if (!needle) {
      setSuggestions([])
      return
    }

    const timeout = setTimeout(async () => {
      const { data, error } = await supabase
        .from("cc_companies")
        .select("id,name")
        .ilike("name", `%${needle}%`)
        .order("name", { ascending: true })
        .limit(8)

      if (error) {
        setMessage("Unable to load company suggestions.")
        setSuggestions([])
      } else {
        setSuggestions((data as CompanyListRecord[]) || [])
      }
    }, 150)

    return () => clearTimeout(timeout)
  }, [adminLoading, authenticated, query])

  useEffect(() => {
    setActiveSuggestion(0)
  }, [query])

  useEffect(() => {
    setMatchIndex(0)
  }, [searchInPage, selectedId])

  const displayedInfoHtml = useMemo(() => {
    return highlightTextHtml(form.notes || "", editingInfo ? "" : searchInPage)
  }, [form.notes, searchInPage, editingInfo])

  useEffect(() => {
    if (!infoRef.current || editingInfo) {
      setMatchCount(0)
      return
    }

    const matches = Array.from(
      infoRef.current.querySelectorAll<HTMLElement>('mark[data-search-match="true"]'),
    )
    setMatchCount(matches.length)

    matches.forEach((match, index) => {
      if (index === matchIndex && searchInPage.trim()) {
        match.style.background = "rgba(96, 225, 255, 0.42)"
        match.style.color = "#f5fdff"
        match.scrollIntoView({ block: "nearest", behavior: "smooth" })
      } else {
        match.style.background = "rgba(255, 226, 94, 0.34)"
        match.style.color = "#fff6bf"
      }
    })
  }, [displayedInfoHtml, editingInfo, matchIndex, searchInPage])

  async function saveRecord() {
    if (!form.id) return
    setSaving(true)
    setMessage("")

    const { error } = await supabase
      .from("cc_companies")
      .update({
        name: form.name.trim(),
        summary: form.summary || null,
        notes: form.notes || null,
      })
      .eq("id", form.id)

    if (error) {
      setMessage("Unable to save.")
    } else {
      setMessage("Saved.")
    }

    setSaving(false)
  }

  async function deleteRecord() {
    if (!form.id) return
    if (!confirm(`Delete ${form.name}?`)) return

    const { error } = await supabase.from("cc_companies").delete().eq("id", form.id)
    if (error) {
      setMessage("Unable to delete.")
      return
    }

    setMessage("Deleted.")
    setSelectedId("")
    setForm({ id: "", name: "", summary: "", notes: "" })
    setQuery("")
    setSuggestions([])
    setSearchInPage("")
  }

  async function createNewRecord() {
    const { data, error } = await supabase
      .from("cc_companies")
      .insert({
        name: "New Entry",
        country: null,
        category: "company",
        summary: null,
        notes: "No info",
        contacts: null,
        tags: [],
        status: "active",
        last_reviewed_at: null,
      })
      .select("id,name,summary,notes,updated_at")
      .single()

    if (error || !data) {
      setMessage("Unable to create new entry.")
      return
    }

    setSelectedId(data.id)
    setForm(data as CompanyInfoRecord)
    setQuery("")
    setSuggestions([])
    setSearchInPage("")
    setMessage("")
  }

  async function selectSuggestion(record: CompanyListRecord) {
    setSelectedId(record.id)
    await loadRecordById(record.id)
    setQuery("")
    setSuggestions([])
    setSearchInPage("")
    setMessage("")
  }

  function handleSearchKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (!suggestions.length) return

    if (event.key === "ArrowDown") {
      event.preventDefault()
      setActiveSuggestion((prev) => (prev + 1) % suggestions.length)
    } else if (event.key === "ArrowUp") {
      event.preventDefault()
      setActiveSuggestion((prev) => (prev - 1 + suggestions.length) % suggestions.length)
    } else if (event.key === "Enter") {
      event.preventDefault()
      void selectSuggestion(suggestions[activeSuggestion] || suggestions[0])
    }
  }

  function handleSearchInPageKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter") return

    event.preventDefault()

    if (event.shiftKey) {
      goToPreviousMatch()
    } else {
      goToNextMatch()
    }
  }

  if (!adminLoading && !authenticated) return <p style={{ padding: "40px" }}>Access Denied</p>
  if (adminLoading) return <p style={{ padding: "40px" }}>Loading...</p>

  const initialMode = !selectedId

  return (
    <div style={pageShellStyle}>
      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "280px minmax(0, 1fr)", minHeight: "100vh" }}>
        {!isMobile && (
          <aside style={sidebarStyle}>
            <div style={{ fontSize: "12px", letterSpacing: "0.16em", textTransform: "uppercase", color: "#8fd7ff", marginBottom: "12px", fontWeight: 700 }}>
              Trading Tools
            </div>
            <button
              onClick={createNewRecord}
              style={{
                ...buttonStyle,
                width: "100%",
                textAlign: "left",
                background: "linear-gradient(180deg, rgba(86, 164, 255, 0.38) 0%, rgba(32, 106, 194, 0.2) 100%)",
                color: "#e7f3ff",
                border: "1px solid rgba(108, 185, 255, 0.24)",
              }}
            >
              New Entry
            </button>
            <a href="/admin" style={{ ...buttonStyle, display: "block", marginTop: "12px", textAlign: "center" }}>
              ← Back To Admin
            </a>

            {!initialMode && (
              <div style={{ ...panelStyle, marginTop: "18px", padding: "14px", display: "grid", gap: "10px" }}>
                <div style={{ fontSize: "12px", letterSpacing: "0.12em", textTransform: "uppercase", color: "#8fd7ff", fontWeight: 700 }}>
                  Search In Page
                </div>
                <input
                  value={searchInPage}
                  onChange={(event) => setSearchInPage(event.target.value)}
                  onKeyDown={handleSearchInPageKeyDown}
                  style={fieldInputStyle}
                />
                {searchInPage.trim() && (
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
                    <div style={{ color: "#b7d7f3", fontSize: "13px", fontWeight: 700 }}>
                      {matchCount === 0 ? "0/0" : `${Math.min(matchIndex + 1, matchCount)}/${matchCount}`}
                    </div>
                    <div style={{ display: "flex", gap: "6px" }}>
                      <button
                        type="button"
                        onClick={goToPreviousMatch}
                        disabled={matchCount === 0}
                        style={{ ...buttonStyle, minWidth: "34px", padding: "6px 8px", fontSize: "11px", opacity: matchCount === 0 ? 0.45 : 1 }}
                      >
                        &lt;
                      </button>
                      <button
                        type="button"
                        onClick={goToNextMatch}
                        disabled={matchCount === 0}
                        style={{ ...buttonStyle, minWidth: "34px", padding: "6px 8px", fontSize: "11px", opacity: matchCount === 0 ? 0.45 : 1 }}
                      >
                        &gt;
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </aside>
        )}

        <main style={{ padding: isMobile ? "18px" : "28px" }}>
          {initialMode ? (
            <div style={{ minHeight: "calc(100vh - 56px)", display: "grid", placeItems: "center" }}>
              <div style={{ width: "min(760px, 100%)", position: "relative" }}>
                <div style={{ textAlign: "center", marginBottom: "20px", fontSize: isMobile ? "26px" : "34px", fontWeight: 500 }}>
                  Search Country And Company Info
                </div>
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={handleSearchKeyDown}
                  placeholder="Search anything..."
                  style={searchInputStyle}
                />
                {suggestions.length > 0 && (
                  <div style={{ ...panelStyle, position: "absolute", top: "calc(100% + 12px)", left: 0, right: 0, padding: "10px", display: "grid", gap: "6px" }}>
                    {suggestions.map((item, index) => (
                      <button
                        key={item.id}
                        onClick={() => void selectSuggestion(item)}
                        style={{
                          textAlign: "left",
                          padding: "12px 14px",
                          borderRadius: "14px",
                          border: index === activeSuggestion
                            ? "1px solid rgba(73, 219, 165, 0.26)"
                            : "1px solid rgba(210,236,255,0.08)",
                          background: index === activeSuggestion
                            ? "linear-gradient(180deg, rgba(56, 214, 154, 0.16) 0%, rgba(20, 130, 93, 0.08) 100%)"
                            : "transparent",
                          color: "#edf7ff",
                          cursor: "pointer",
                        }}
                      >
                        {item.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div style={{ display: "grid", gap: "18px" }}>
              <div style={{ ...panelStyle, padding: "18px", position: "sticky", top: "18px", zIndex: 10 }}>
                <div style={{ position: "relative" }}>
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    onKeyDown={handleSearchKeyDown}
                    placeholder="Search anything..."
                    style={searchInputStyle}
                  />
                </div>
                {suggestions.length > 0 && query.trim() && (
                  <div style={{ ...panelStyle, position: "absolute", top: "calc(100% - 4px)", left: "18px", right: "18px", padding: "10px", display: "grid", gap: "6px" }}>
                    {suggestions.map((item, index) => (
                      <button
                        key={item.id}
                        onClick={() => void selectSuggestion(item)}
                        style={{
                          textAlign: "left",
                          padding: "10px 12px",
                          borderRadius: "12px",
                          border: index === activeSuggestion
                            ? "1px solid rgba(73, 219, 165, 0.26)"
                            : "1px solid rgba(210,236,255,0.08)",
                          background: index === activeSuggestion
                            ? "linear-gradient(180deg, rgba(56, 214, 154, 0.16) 0%, rgba(20, 130, 93, 0.08) 100%)"
                            : "transparent",
                          color: "#edf7ff",
                          cursor: "pointer",
                        }}
                      >
                        {item.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div style={{ ...panelStyle, padding: "20px", display: "grid", gap: "16px" }}>
                {isMobile && (
                  <div>
                    <div style={{ fontSize: "12px", letterSpacing: "0.12em", textTransform: "uppercase", color: "#8fd7ff", fontWeight: 700, marginBottom: "8px" }}>
                      Search In Page
                    </div>
                    <input
                      value={searchInPage}
                      onChange={(event) => setSearchInPage(event.target.value)}
                      onKeyDown={handleSearchInPageKeyDown}
                      style={fieldInputStyle}
                    />
                    {searchInPage.trim() && (
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "10px", marginTop: "10px", flexWrap: "wrap" }}>
                        <div style={{ color: "#b7d7f3", fontSize: "13px", fontWeight: 700 }}>
                          {matchCount === 0 ? "0/0" : `${Math.min(matchIndex + 1, matchCount)}/${matchCount}`}
                        </div>
                        <div style={{ display: "flex", gap: "8px" }}>
                          <button
                            type="button"
                            onClick={goToPreviousMatch}
                            disabled={matchCount === 0}
                            style={{ ...buttonStyle, minWidth: "34px", padding: "6px 8px", fontSize: "11px", opacity: matchCount === 0 ? 0.45 : 1 }}
                          >
                            &lt;
                          </button>
                          <button
                            type="button"
                            onClick={goToNextMatch}
                            disabled={matchCount === 0}
                            style={{ ...buttonStyle, minWidth: "34px", padding: "6px 8px", fontSize: "11px", opacity: matchCount === 0 ? 0.45 : 1 }}
                          >
                            &gt;
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                <div>
                  <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "minmax(0, 1fr) auto", gap: "12px", alignItems: "end" }}>
                    <div>
                      <div style={{ fontSize: "12px", letterSpacing: "0.12em", textTransform: "uppercase", color: "#8fd7ff", fontWeight: 700, marginBottom: "8px" }}>
                        Company Name
                      </div>
                      <input
                        value={form.name}
                        onChange={(event) => setForm({ ...form, name: event.target.value })}
                        style={fieldInputStyle}
                      />
                    </div>
                    <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", justifyContent: isMobile ? "flex-start" : "flex-end" }}>
                      <button
                        onClick={saveRecord}
                        disabled={saving || !form.id}
                        style={{
                          ...buttonStyle,
                          background: "linear-gradient(180deg, rgba(56, 214, 154, 0.34) 0%, rgba(20, 130, 93, 0.16) 100%)",
                          color: "#ddffef",
                          border: "1px solid rgba(73, 219, 165, 0.26)",
                        }}
                      >
                        {saving ? "Saving..." : "Save"}
                      </button>
                      <button
                        onClick={deleteRecord}
                        disabled={!form.id}
                        style={{
                          ...buttonStyle,
                          background: "linear-gradient(180deg, rgba(230, 57, 70, 0.24) 0%, rgba(170, 47, 53, 0.12) 100%)",
                          color: "#ffd6db",
                          border: "1px solid rgba(255, 120, 120, 0.22)",
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                </div>

                <div>
                  <div style={{ fontSize: "12px", letterSpacing: "0.12em", textTransform: "uppercase", color: "#8fd7ff", fontWeight: 700, marginBottom: "8px" }}>
                    Highlights
                  </div>
                  <textarea
                    value={form.summary || ""}
                    onChange={(event) => setForm({ ...form, summary: event.target.value })}
                    style={{ ...textareaStyle, minHeight: "120px" }}
                  />
                </div>

                <div>
                  <div style={{ fontSize: "12px", letterSpacing: "0.12em", textTransform: "uppercase", color: "#8fd7ff", fontWeight: 700, marginBottom: "8px" }}>
                    Information
                  </div>
                  {recordLoading && (
                    <div style={{ color: "#9ebad1", marginBottom: "8px" }}>Loading company info...</div>
                  )}
                  <div
                    ref={infoRef}
                    contentEditable
                    suppressContentEditableWarning
                    onFocus={() => setEditingInfo(true)}
                    onBlur={(event) => {
                      setEditingInfo(false)
                      setForm({ ...form, notes: event.currentTarget.innerText })
                    }}
                    style={{ ...textareaStyle, whiteSpace: "pre-wrap", overflowY: "auto" }}
                    dangerouslySetInnerHTML={{ __html: displayedInfoHtml }}
                  />
                </div>

                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", flexWrap: "wrap", paddingTop: "8px" }}>
                  <div style={{ color: message === "Saved." || message === "Deleted." ? "#8ff0c8" : "#ffb0b0", fontWeight: 700 }}>
                    {message}
                  </div>
                  <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
                    {isMobile && (
                      <>
                        <button
                          onClick={createNewRecord}
                          style={{
                            ...buttonStyle,
                            background: "linear-gradient(180deg, rgba(86, 164, 255, 0.38) 0%, rgba(32, 106, 194, 0.2) 100%)",
                            color: "#e7f3ff",
                            border: "1px solid rgba(108, 185, 255, 0.24)",
                          }}
                        >
                          New Entry
                        </button>
                        <a href="/admin" style={buttonStyle}>← Back To Admin</a>
                      </>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  )
}
