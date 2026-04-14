"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { supabase } from "@/lib/supabase"
import { useSimpleAdminAuth } from "@/lib/useSimpleAdminAuth"
import { useIsMobile } from "@/lib/useIsMobile"

type RecordKind = "company" | "country" | "port"

type SearchRecord = {
  id: string
  name: string
  kind: RecordKind
  country_name?: string | null
}

type BaseRecord = {
  id: string
  name: string
  summary: string | null
  notes: string | null
}

type CompanyFileRecord = {
  id: string
  file_name: string
  file_type: string | null
  drive_url: string | null
}

type CountryRecord = BaseRecord & {
  region?: string | null
}

type PortRecord = BaseRecord & {
  country_id: string | null
  country_name: string | null
}

type CountryPortListItem = {
  id: string
  name: string
  summary: string | null
  notes: string | null
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
  borderRadius: "18px",
  boxShadow: "0 20px 44px rgba(0, 0, 0, 0.18), inset 0 1px 0 rgba(255,255,255,0.05)",
}

const buttonStyle: React.CSSProperties = {
  padding: "9px 12px",
  borderRadius: "999px",
  border: "1px solid rgba(210,236,255,0.16)",
  background: "linear-gradient(180deg, rgba(255,255,255,0.18) 0%, rgba(255,255,255,0.1) 100%)",
  color: "#d7e8ff",
  textDecoration: "none",
  fontSize: "12px",
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
  minHeight: "220px",
  resize: "vertical",
  lineHeight: 1.55,
  fontFamily: "Arial, Helvetica, sans-serif",
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function escapeHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
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

function kindLabel(kind: RecordKind) {
  if (kind === "company") return "Company"
  if (kind === "country") return "Country"
  return "Port"
}

export default function CountryCompanyInfoPage() {
  const { loading: adminLoading, authenticated } = useSimpleAdminAuth()
  const isMobile = useIsMobile()
  const filePickerRef = useRef<HTMLInputElement | null>(null)
  const infoRef = useRef<HTMLDivElement | null>(null)
  const countryInfoRef = useRef<HTMLDivElement | null>(null)

  const [query, setQuery] = useState("")
  const [suggestions, setSuggestions] = useState<SearchRecord[]>([])
  const [activeSuggestion, setActiveSuggestion] = useState(0)
  const [selectedKind, setSelectedKind] = useState<RecordKind | "">("")
  const [selectedId, setSelectedId] = useState("")
  const [message, setMessage] = useState("")
  const [saving, setSaving] = useState(false)
  const [recordLoading, setRecordLoading] = useState(false)
  const [searchInPage, setSearchInPage] = useState("")
  const [matchCount, setMatchCount] = useState(0)
  const [matchIndex, setMatchIndex] = useState(0)
  const [menuOpen, setMenuOpen] = useState(false)
  const [editingInfo, setEditingInfo] = useState(false)
  const [editingCountryInfo, setEditingCountryInfo] = useState(false)
  const [files, setFiles] = useState<CompanyFileRecord[]>([])
  const [currentCountryPorts, setCurrentCountryPorts] = useState<CountryPortListItem[]>([])

  const [currentRecord, setCurrentRecord] = useState<BaseRecord>({
    id: "",
    name: "",
    summary: "",
    notes: "",
  })
  const [currentCountry, setCurrentCountry] = useState<CountryRecord>({
    id: "",
    name: "",
    summary: "",
    notes: "",
  })

  const initialMode = !selectedId

  useEffect(() => {
    if (adminLoading || !authenticated) return
    const needle = query.trim()
    if (!needle) {
      setSuggestions([])
      return
    }

    const timeout = setTimeout(async () => {
      const [companies, countries, ports] = await Promise.all([
        supabase.from("cc_companies").select("id,name").ilike("name", `%${needle}%`).order("name", { ascending: true }).limit(4),
        supabase.from("cc_countries").select("id,name").ilike("name", `%${needle}%`).order("name", { ascending: true }).limit(4),
        supabase.from("cc_ports").select("id,name,country_name").ilike("name", `%${needle}%`).order("name", { ascending: true }).limit(6),
      ])

      const next: SearchRecord[] = []
      if (!companies.error) next.push(...(((companies.data as { id: string; name: string }[]) || []).map((item) => ({ ...item, kind: "company" as const }))))
      if (!countries.error) next.push(...(((countries.data as { id: string; name: string }[]) || []).map((item) => ({ ...item, kind: "country" as const }))))
      if (!ports.error) next.push(...(((ports.data as { id: string; name: string; country_name: string | null }[]) || []).map((item) => ({ ...item, kind: "port" as const }))))
      setSuggestions(next.slice(0, 10))
    }, 120)

    return () => clearTimeout(timeout)
  }, [adminLoading, authenticated, query])

  useEffect(() => {
    setActiveSuggestion(0)
  }, [query])

  useEffect(() => {
    setMatchIndex(0)
  }, [searchInPage, selectedId, selectedKind])

  const displayedInfoHtml = useMemo(
    () => highlightTextHtml(currentRecord.notes || "", editingInfo ? "" : searchInPage),
    [currentRecord.notes, searchInPage, editingInfo],
  )

  const displayedCountryInfoHtml = useMemo(
    () => highlightTextHtml(currentCountry.notes || "", editingCountryInfo ? "" : searchInPage),
    [currentCountry.notes, searchInPage, editingCountryInfo],
  )

  useEffect(() => {
    if (editingInfo || editingCountryInfo) {
      setMatchCount(0)
      return
    }

    const mainMatches = infoRef.current ? Array.from(infoRef.current.querySelectorAll<HTMLElement>('mark[data-search-match="true"]')) : []
    const countryMatches =
      selectedKind === "port" && countryInfoRef.current
        ? Array.from(countryInfoRef.current.querySelectorAll<HTMLElement>('mark[data-search-match="true"]'))
        : []

    const allMatches = [...mainMatches, ...countryMatches]
    setMatchCount(allMatches.length)

    allMatches.forEach((match, index) => {
      if (index === matchIndex && searchInPage.trim()) {
        match.style.background = "rgba(96, 225, 255, 0.42)"
        match.style.color = "#f5fdff"
        match.scrollIntoView({ block: "nearest", behavior: "smooth" })
      } else {
        match.style.background = "rgba(255, 226, 94, 0.34)"
        match.style.color = "#fff6bf"
      }
    })
  }, [displayedInfoHtml, displayedCountryInfoHtml, editingInfo, editingCountryInfo, matchIndex, searchInPage, selectedKind])

  function goToPreviousMatch() {
    setMatchIndex((prev) => (matchCount ? (prev - 1 + matchCount) % matchCount : 0))
  }

  function goToNextMatch() {
    setMatchIndex((prev) => (matchCount ? (prev + 1) % matchCount : 0))
  }

  function resetSelection() {
    setSelectedId("")
    setSelectedKind("")
    setCurrentRecord({ id: "", name: "", summary: "", notes: "" })
    setCurrentCountry({ id: "", name: "", summary: "", notes: "" })
    setFiles([])
    setCurrentCountryPorts([])
    setSearchInPage("")
  }

  async function loadCompany(id: string) {
    const [{ data, error }, filesResult] = await Promise.all([
      supabase.from("cc_companies").select("id,name,summary,notes").eq("id", id).single(),
      supabase.from("cc_company_files").select("id,file_name,file_type,drive_url").eq("company_id", id).order("file_name", { ascending: true }),
    ])
    if (error || !data) throw error || new Error("Unable to load company")
    setCurrentRecord(data as BaseRecord)
    setCurrentCountry({ id: "", name: "", summary: "", notes: "" })
    setFiles((filesResult.data as CompanyFileRecord[]) || [])
    setCurrentCountryPorts([])
  }

  async function loadCountry(id: string) {
    const [{ data, error }, portsResult] = await Promise.all([
      supabase.from("cc_countries").select("id,name,summary,notes,region").eq("id", id).single(),
      supabase.from("cc_ports").select("id,name,summary,notes").eq("country_id", id).order("name", { ascending: true }),
    ])
    if (error || !data) throw error || new Error("Unable to load country")
    setCurrentRecord(data as BaseRecord)
    setCurrentCountry(data as CountryRecord)
    setFiles([])
    setCurrentCountryPorts((portsResult.data as CountryPortListItem[]) || [])
  }

  async function loadPort(id: string) {
    const { data, error } = await supabase.from("cc_ports").select("id,name,summary,notes,country_id,country_name").eq("id", id).single()
    if (error || !data) throw error || new Error("Unable to load port")
    const port = data as PortRecord
    setCurrentRecord(port)
    setFiles([])
    setCurrentCountryPorts([])

    if (port.country_id) {
      const { data: countryData } = await supabase.from("cc_countries").select("id,name,summary,notes,region").eq("id", port.country_id).single()
      setCurrentCountry((countryData as CountryRecord) || { id: "", name: port.country_name || "", summary: "", notes: "" })
    } else {
      setCurrentCountry({ id: "", name: port.country_name || "", summary: "", notes: "" })
    }
  }

  async function loadSelected(kind: RecordKind, id: string) {
    setRecordLoading(true)
    setMessage("")
    setMenuOpen(false)
    try {
      if (kind === "company") await loadCompany(id)
      if (kind === "country") await loadCountry(id)
      if (kind === "port") await loadPort(id)
      setSelectedKind(kind)
      setSelectedId(id)
    } catch {
      setMessage("Unable to load entry.")
    } finally {
      setRecordLoading(false)
    }
  }

  async function createNew(kind: RecordKind) {
    setMenuOpen(false)
    setMessage("")
    if (kind === "company") {
      const { data, error } = await supabase.from("cc_companies").insert({ name: "New Company", category: "company", summary: null, notes: "No info", contacts: null, tags: [], status: "active" }).select("id").single()
      if (error || !data) return setMessage("Unable to create company.")
      await loadSelected("company", data.id)
      return
    }
    if (kind === "country") {
      const { data, error } = await supabase.from("cc_countries").insert({ name: "New Country", summary: null, notes: "No info", tags: [], status: "active" }).select("id").single()
      if (error || !data) return setMessage("Unable to create country.")
      await loadSelected("country", data.id)
      return
    }
    const { data, error } = await supabase.from("cc_ports").insert({ name: "New Port", summary: null, notes: "No info", country_name: null, tags: [], status: "active" }).select("id").single()
    if (error || !data) return setMessage("Unable to create port.")
    await loadSelected("port", data.id)
  }

  async function saveRecord() {
    if (!selectedId || !selectedKind) return
    setSaving(true)
    setMessage("")
    try {
      if (selectedKind === "company") {
        const { error } = await supabase.from("cc_companies").update({ name: currentRecord.name.trim(), summary: currentRecord.summary || null, notes: currentRecord.notes || null }).eq("id", selectedId)
        if (error) throw error
      }
      if (selectedKind === "country") {
        const { error } = await supabase.from("cc_countries").update({ name: currentRecord.name.trim(), summary: currentRecord.summary || null, notes: currentRecord.notes || null }).eq("id", selectedId)
        if (error) throw error
      }
      if (selectedKind === "port") {
        const { error } = await supabase.from("cc_ports").update({
          name: currentRecord.name.trim(),
          summary: currentRecord.summary || null,
          notes: currentRecord.notes || null,
          country_id: currentCountry.id || null,
          country_name: currentCountry.name || null,
        }).eq("id", selectedId)
        if (error) throw error

        if (currentCountry.id) {
          const { error: countryError } = await supabase.from("cc_countries").update({
            name: currentCountry.name.trim(),
            summary: currentCountry.summary || null,
            notes: currentCountry.notes || null,
          }).eq("id", currentCountry.id)
          if (countryError) throw countryError
        }
      }
      setMessage("Saved.")
    } catch {
      setMessage("Unable to save.")
    } finally {
      setSaving(false)
    }
  }

  async function deleteRecord() {
    if (!selectedId || !selectedKind) return
    if (!confirm(`Delete ${currentRecord.name}?`)) return
    try {
      const table = selectedKind === "company" ? "cc_companies" : selectedKind === "country" ? "cc_countries" : "cc_ports"
      const { error } = await supabase.from(table).delete().eq("id", selectedId)
      if (error) throw error
      setMessage("Deleted.")
      resetSelection()
    } catch {
      setMessage("Unable to delete.")
    }
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
      const pick = suggestions[activeSuggestion] || suggestions[0]
      void pickSuggestion(pick)
    }
  }

  function handleSearchInPageKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter") return
    event.preventDefault()
    if (event.shiftKey) goToPreviousMatch()
    else goToNextMatch()
  }

  function handleUploadSelection(event: React.ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(event.target.files || [])
    if (picked.length === 0) return
    setMessage(`Selected ${picked.length} file${picked.length > 1 ? "s" : ""}. Upload linking will be the next step.`)
    event.target.value = ""
  }

  async function pickSuggestion(item: SearchRecord) {
    await loadSelected(item.kind, item.id)
    setQuery("")
    setSuggestions([])
    setSearchInPage("")
    setMenuOpen(false)
  }

  if (!adminLoading && !authenticated) return <p style={{ padding: "40px" }}>Access Denied</p>
  if (adminLoading) return <p style={{ padding: "40px" }}>Loading...</p>

  const mainLabel = selectedKind ? `${kindLabel(selectedKind)} Name` : "Name"

  return (
    <div style={pageShellStyle}>
      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "260px minmax(0, 1fr)", minHeight: "100vh" }}>
        {!isMobile && (
          <aside style={sidebarStyle}>
            <div style={{ display: "flex", flexDirection: "column", minHeight: "calc(100vh - 36px)" }}>
              <div style={{ fontSize: "12px", letterSpacing: "0.16em", textTransform: "uppercase", color: "#8fd7ff", fontWeight: 700, marginBottom: "12px" }}>
                Country And Company Info
              </div>
              <input ref={filePickerRef} type="file" multiple style={{ display: "none" }} onChange={handleUploadSelection} />
              <a href="/admin" style={{ ...buttonStyle, display: "block", textAlign: "center", marginBottom: "16px" }}>
                ← Back To Admin
              </a>

              {!initialMode && (
                <div style={{ ...panelStyle, padding: "12px", display: "grid", gap: "10px" }}>
                  <div style={{ fontSize: "12px", letterSpacing: "0.12em", textTransform: "uppercase", color: "#8fd7ff", fontWeight: 700 }}>
                    Search In Page
                  </div>
                  <input value={searchInPage} onChange={(e) => setSearchInPage(e.target.value)} onKeyDown={handleSearchInPageKeyDown} style={inputStyle} />
                  {searchInPage.trim() && (
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
                      <div style={{ color: "#b7d7f3", fontSize: "13px", fontWeight: 700 }}>
                        {matchCount === 0 ? "0/0" : `${Math.min(matchIndex + 1, matchCount)}/${matchCount}`}
                      </div>
                      <div style={{ display: "flex", gap: "6px" }}>
                        <button type="button" onClick={goToPreviousMatch} disabled={matchCount === 0} style={{ ...buttonStyle, minWidth: "34px", padding: "6px 8px", fontSize: "11px", opacity: matchCount === 0 ? 0.45 : 1 }}>&lt;</button>
                        <button type="button" onClick={goToNextMatch} disabled={matchCount === 0} style={{ ...buttonStyle, minWidth: "34px", padding: "6px 8px", fontSize: "11px", opacity: matchCount === 0 ? 0.45 : 1 }}>&gt;</button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              <div style={{ marginTop: "auto", display: "flex", justifyContent: "flex-end" }}>
                <div style={{ position: "relative" }}>
                  <button
                    onClick={() => setMenuOpen((prev) => !prev)}
                    style={{
                      ...buttonStyle,
                      width: "42px",
                      height: "42px",
                      padding: 0,
                      borderRadius: "50%",
                      background: "linear-gradient(180deg, rgba(86, 164, 255, 0.38) 0%, rgba(32, 106, 194, 0.2) 100%)",
                      color: "#e7f3ff",
                      border: "1px solid rgba(108, 185, 255, 0.24)",
                      fontSize: "22px",
                      fontWeight: 700,
                      lineHeight: 1,
                    }}
                  >
                    ≡
                  </button>
                  {menuOpen && (
                    <div style={{ ...panelStyle, position: "absolute", right: 0, bottom: "48px", padding: "8px", display: "grid", gap: "6px", minWidth: "150px", zIndex: 20 }}>
                      <button onClick={() => void createNew("port")} style={{ ...buttonStyle, textAlign: "left" }}>New Port</button>
                      <button onClick={() => void createNew("country")} style={{ ...buttonStyle, textAlign: "left" }}>New Country</button>
                      <button onClick={() => void createNew("company")} style={{ ...buttonStyle, textAlign: "left" }}>New Company</button>
                      <a href="/admin/ccinfo/ports" style={{ ...buttonStyle, textAlign: "left", display: "block" }}>Port Index</a>
                      <a href="/admin/ccinfo/countries" style={{ ...buttonStyle, textAlign: "left", display: "block" }}>Country Index</a>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </aside>
        )}

        <main style={{ padding: isMobile ? "16px" : "22px" }}>
          <div style={{ display: "grid", gap: "14px" }}>
            <div style={{ ...panelStyle, padding: "14px", position: "sticky", top: "16px", zIndex: 10 }}>
              <input value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={handleSearchKeyDown} placeholder="Search company, country or port..." style={searchInputStyle} />
              {suggestions.length > 0 && query.trim() && (
                <div style={{ ...panelStyle, position: "absolute", top: "calc(100% - 2px)", left: "14px", right: "14px", padding: "8px", display: "grid", gap: "6px" }}>
                  {suggestions.map((item, index) => (
                    <button
                      key={`${item.kind}-${item.id}`}
                      onClick={() => void pickSuggestion(item)}
                      style={{
                        textAlign: "left",
                        padding: "10px 12px",
                        borderRadius: "12px",
                        border: index === activeSuggestion ? "1px solid rgba(73, 219, 165, 0.26)" : "1px solid rgba(210,236,255,0.08)",
                        background: index === activeSuggestion ? "linear-gradient(180deg, rgba(56, 214, 154, 0.16) 0%, rgba(20, 130, 93, 0.08) 100%)" : "transparent",
                        color: "#edf7ff",
                        cursor: "pointer",
                      }}
                    >
                      <div style={{ fontWeight: 700 }}>{item.name}</div>
                      <div style={{ color: "#8fc2e8", fontSize: "12px", marginTop: "2px" }}>
                        {kindLabel(item.kind)}{item.kind === "port" && item.country_name ? ` • ${item.country_name}` : ""}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div style={{ ...panelStyle, padding: "16px", display: "grid", gap: "12px" }}>
              {initialMode ? (
                <div style={{ minHeight: isMobile ? "unset" : "calc(100vh - 180px)", display: "grid", placeItems: "center", color: "#93b9d6", textAlign: "center", padding: "20px" }}>
                  <div>
                      <div style={{ fontSize: "14px", lineHeight: 1.6 }}>Search a company, country, or port to open the entry.</div>
                  </div>
                </div>
              ) : (
                <>
                  {isMobile && (
                    <div>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "10px" }}>
                        <button
                          onClick={() => setMenuOpen((prev) => !prev)}
                          style={{
                            ...buttonStyle,
                            width: "42px",
                            height: "42px",
                            padding: 0,
                            borderRadius: "50%",
                            background: "linear-gradient(180deg, rgba(86, 164, 255, 0.38) 0%, rgba(32, 106, 194, 0.2) 100%)",
                            color: "#e7f3ff",
                            border: "1px solid rgba(108, 185, 255, 0.24)",
                            fontSize: "22px",
                            fontWeight: 700,
                            lineHeight: 1,
                          }}
                        >
                          ≡
                        </button>
                      </div>
                      {menuOpen && (
                        <div style={{ ...panelStyle, padding: "8px", display: "grid", gap: "6px", marginBottom: "10px" }}>
                          <button onClick={() => void createNew("port")} style={{ ...buttonStyle, textAlign: "left" }}>New Port</button>
                          <button onClick={() => void createNew("country")} style={{ ...buttonStyle, textAlign: "left" }}>New Country</button>
                          <button onClick={() => void createNew("company")} style={{ ...buttonStyle, textAlign: "left" }}>New Company</button>
                          <a href="/admin/ccinfo/ports" style={{ ...buttonStyle, textAlign: "left", display: "block" }}>Port Index</a>
                          <a href="/admin/ccinfo/countries" style={{ ...buttonStyle, textAlign: "left", display: "block" }}>Country Index</a>
                        </div>
                      )}
                      <input ref={filePickerRef} type="file" multiple style={{ display: "none" }} onChange={handleUploadSelection} />
                      <div style={{ marginBottom: "10px" }}>
                        <div style={{ fontSize: "12px", letterSpacing: "0.12em", textTransform: "uppercase", color: "#8fd7ff", fontWeight: 700, marginBottom: "8px" }}>Search In Page</div>
                        <input value={searchInPage} onChange={(e) => setSearchInPage(e.target.value)} onKeyDown={handleSearchInPageKeyDown} style={inputStyle} />
                      </div>
                    </div>
                  )}

                  <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "minmax(0,1fr) auto", gap: "10px", alignItems: "end" }}>
                    <div>
                      <div style={{ fontSize: "12px", letterSpacing: "0.12em", textTransform: "uppercase", color: "#8fd7ff", fontWeight: 700, marginBottom: "6px" }}>{mainLabel}</div>
                      <input value={currentRecord.name} onChange={(e) => setCurrentRecord((prev) => ({ ...prev, name: e.target.value }))} style={inputStyle} />
                    </div>
                    <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", justifyContent: isMobile ? "flex-start" : "flex-end" }}>
                      <button onClick={saveRecord} disabled={saving || !selectedId} style={{ ...buttonStyle, background: "linear-gradient(180deg, rgba(56, 214, 154, 0.34) 0%, rgba(20, 130, 93, 0.16) 100%)", color: "#ddffef", border: "1px solid rgba(73, 219, 165, 0.26)" }}>{saving ? "Saving..." : "Save"}</button>
                      <button onClick={deleteRecord} disabled={!selectedId} style={{ ...buttonStyle, background: "linear-gradient(180deg, rgba(230, 57, 70, 0.24) 0%, rgba(170, 47, 53, 0.12) 100%)", color: "#ffd6db", border: "1px solid rgba(255, 120, 120, 0.22)" }}>Delete</button>
                    </div>
                  </div>

                  {selectedKind === "port" && (
                    <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "220px minmax(0, 1fr)", gap: "10px", alignItems: "end" }}>
                      <div>
                        <div style={{ fontSize: "12px", letterSpacing: "0.12em", textTransform: "uppercase", color: "#8fd7ff", fontWeight: 700, marginBottom: "6px" }}>Country</div>
                        <input value={currentCountry.name} onChange={(e) => setCurrentCountry((prev) => ({ ...prev, name: e.target.value }))} style={inputStyle} />
                      </div>
                      <div style={{ color: "#95b8d3", fontSize: "13px" }}>Saving a port will also save the linked country information below.</div>
                    </div>
                  )}

                  <div>
                    <div style={{ fontSize: "12px", letterSpacing: "0.12em", textTransform: "uppercase", color: "#8fd7ff", fontWeight: 700, marginBottom: "6px" }}>Highlights</div>
                    <textarea value={currentRecord.summary || ""} onChange={(e) => setCurrentRecord((prev) => ({ ...prev, summary: e.target.value }))} style={{ ...textareaStyle, minHeight: "100px" }} />
                  </div>

                  <div>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", marginBottom: "6px", flexWrap: "wrap" }}>
                      <div style={{ fontSize: "12px", letterSpacing: "0.12em", textTransform: "uppercase", color: "#8fd7ff", fontWeight: 700 }}>Files</div>
                    </div>
                    <div style={{ ...panelStyle, padding: "12px", background: "rgba(255,255,255,0.03)", display: "grid", gap: "8px" }}>
                      {selectedKind !== "company" ? (
                        <button onClick={() => filePickerRef.current?.click()} style={{ ...buttonStyle, justifySelf: "start" }}>Upload File</button>
                      ) : files.length === 0 ? (
                        <div style={{ color: "#9ebad1" }}>No linked files yet.</div>
                      ) : (
                        files.map((file) => (
                          <a
                            key={file.id}
                            href={file.drive_url || "#"}
                            target="_blank"
                            rel="noreferrer"
                            style={{ display: "grid", gridTemplateColumns: "68px minmax(0,1fr)", gap: "10px", alignItems: "center", padding: "8px 10px", borderRadius: "12px", border: "1px solid rgba(210,236,255,0.08)", background: "rgba(255,255,255,0.03)", color: "#e5f1fb", textDecoration: "none" }}
                          >
                            <div style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", height: "28px", borderRadius: "999px", background: "linear-gradient(180deg, rgba(112, 120, 132, 0.28) 0%, rgba(62, 69, 79, 0.18) 100%)", border: "1px solid rgba(190, 198, 208, 0.18)", color: "#e1e6eb", fontSize: "11px", fontWeight: 800, letterSpacing: "0.08em", textTransform: "uppercase", padding: "0 10px" }}>
                              {(file.file_type || "file").replace(".", "").slice(0, 6)}
                            </div>
                            <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{file.file_name}</div>
                          </a>
                        ))
                      )}
                    </div>
                  </div>

                  <div>
                    <div style={{ fontSize: "12px", letterSpacing: "0.12em", textTransform: "uppercase", color: "#8fd7ff", fontWeight: 700, marginBottom: "6px" }}>Information</div>
                    {recordLoading && <div style={{ color: "#9ebad1", marginBottom: "8px" }}>Loading...</div>}
                    <div
                      ref={infoRef}
                      contentEditable
                      suppressContentEditableWarning
                      onFocus={() => setEditingInfo(true)}
                      onBlur={(event) => {
                        setEditingInfo(false)
                        setCurrentRecord((prev) => ({ ...prev, notes: event.currentTarget.innerText }))
                      }}
                      style={{ ...textareaStyle, whiteSpace: "pre-wrap", overflowY: "auto", minHeight: selectedKind === "port" ? "180px" : "320px" }}
                      dangerouslySetInnerHTML={{ __html: displayedInfoHtml }}
                    />
                  </div>

                  {selectedKind === "port" && (
                    <div>
                      <div style={{ fontSize: "12px", letterSpacing: "0.12em", textTransform: "uppercase", color: "#8fd7ff", fontWeight: 700, marginBottom: "6px" }}>Country Information</div>
                      <div
                        ref={countryInfoRef}
                        contentEditable
                        suppressContentEditableWarning
                        onFocus={() => setEditingCountryInfo(true)}
                        onBlur={(event) => {
                          setEditingCountryInfo(false)
                          setCurrentCountry((prev) => ({ ...prev, notes: event.currentTarget.innerText }))
                        }}
                        style={{ ...textareaStyle, whiteSpace: "pre-wrap", overflowY: "auto", minHeight: "180px" }}
                        dangerouslySetInnerHTML={{ __html: displayedCountryInfoHtml }}
                      />
                    </div>
                  )}

                  {selectedKind === "country" && (
                    <div>
                      <div style={{ fontSize: "12px", letterSpacing: "0.12em", textTransform: "uppercase", color: "#8fd7ff", fontWeight: 700, marginBottom: "6px" }}>Ports</div>
                      <div style={{ ...panelStyle, padding: "12px", background: "rgba(255,255,255,0.03)", display: "grid", gap: "10px" }}>
                        {currentCountryPorts.length === 0 ? (
                          <div style={{ color: "#9ebad1" }}>No ports linked yet.</div>
                        ) : (
                          currentCountryPorts.map((port) => (
                            <div key={port.id} style={{ border: "1px solid rgba(210,236,255,0.08)", borderRadius: "14px", padding: "10px 12px", background: "rgba(255,255,255,0.03)" }}>
                              <div style={{ fontWeight: 700, marginBottom: "6px" }}>{port.name}</div>
                              <div style={{ color: "#9ebad1", fontSize: "12px", marginBottom: "6px" }}>Updated: {port.summary || "No date found"}</div>
                              <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.5, color: "#e8f2fb" }}>{port.notes || "No information yet"}</div>
                            </div>
                          ))
                        )}
                      </div>
                    </div>
                  )}

                  <div style={{ color: message === "Saved." || message === "Deleted." ? "#8ff0c8" : "#ffb0b0", fontWeight: 700 }}>
                    {message}
                  </div>
                </>
              )}
            </div>
          </div>
        </main>
      </div>
    </div>
  )
}
