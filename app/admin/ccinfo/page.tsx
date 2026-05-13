"use client"

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
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
  drive_file_id?: string | null
  folder_path?: string | null
  source?: "company" | "entry"
}

type EntryFileRecord = {
  id: string
  file_name: string
  file_type: string | null
  drive_url: string | null
  drive_file_id?: string | null
  folder_path?: string | null
  source?: "entry"
}

type EntryFolderRecord = {
  id: string
  folder_path: string
  name: string
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
  background: "linear-gradient(180deg, #123f70 0%, #0d3158 34%, #08233f 100%)",
  fontFamily: "Arial, Helvetica, sans-serif",
  color: "#edf7ff",
}

const sidebarStyle: React.CSSProperties = {
  width: "280px",
  padding: "18px",
  borderRight: "1px solid rgba(210, 236, 255, 0.1)",
  background: "linear-gradient(180deg, rgba(20, 63, 106, 0.94) 0%, rgba(13, 45, 79, 0.92) 100%)",
}

const panelStyle: React.CSSProperties = {
  background: "linear-gradient(180deg, rgba(24, 76, 126, 0.88) 0%, rgba(12, 44, 77, 0.86) 100%)",
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

const compactFileBadgeStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  minWidth: "36px",
  height: "20px",
  borderRadius: "999px",
  background: "linear-gradient(180deg, rgba(112, 120, 132, 0.28) 0%, rgba(62, 69, 79, 0.18) 100%)",
  border: "1px solid rgba(190, 198, 208, 0.18)",
  color: "#e1e6eb",
  fontSize: "9px",
  fontWeight: 800,
  letterSpacing: "0.04em",
  textTransform: "uppercase",
  padding: "0 6px",
}

const fileIconStyle: React.CSSProperties = {
  width: "18px",
  height: "18px",
  display: "inline-grid",
  placeItems: "center",
  fontSize: "16px",
  lineHeight: 1,
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

type HighlightCard = {
  title: string
  info: string
  line_updates?: Record<string, string>
}

function parseHighlights(value: string | null): HighlightCard[] {
  if (!value?.trim()) return []
  try {
    const parsed = JSON.parse(value)
    if (Array.isArray(parsed)) {
      return parsed
        .map((item) => ({
          title: typeof item?.title === "string" ? item.title : "",
          info: typeof item?.info === "string" ? item.info : "",
          line_updates: item?.line_updates && typeof item.line_updates === "object" ? item.line_updates : {},
        }))
        .filter((item) => item.title.trim() || item.info.trim())
    }
  } catch {
    return value
      .split("\n")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => ({ title: "", info: item }))
  }
  return []
}

function serializeHighlights(items: HighlightCard[]) {
  return JSON.stringify(
    items
      .map((item) => ({
        title: item.title.trim(),
        info: item.info.trim(),
        line_updates: item.line_updates || {},
      }))
      .filter((item) => item.title || item.info),
  )
}

function normalizeSectionTitle(value: string) {
  return value.trim().toUpperCase()
}

function getPreviewUrl(file: { drive_file_id?: string | null; drive_url?: string | null }) {
  if (file.drive_file_id) return `https://drive.google.com/file/d/${file.drive_file_id}/preview`
  return file.drive_url || ""
}

function joinFolderPath(folderPath: string, name: string) {
  return [folderPath.trim(), name.trim()].filter(Boolean).join("/")
}

function folderDepth(folderPath: string) {
  return folderPath.split("/").filter(Boolean).length
}

function getFileTypeLabel(name: string, fileType?: string | null) {
  const ext = (name.split(".").pop() || "").toLowerCase()
  const normalized = (fileType || "").toLowerCase()
  if (ext === "xls" || ext === "xlsx" || normalized.includes("sheet")) return { icon: "📗", color: "#93f5a9", label: "Excel" }
  if (ext === "doc" || ext === "docx" || normalized.includes("word")) return { icon: "📘", color: "#98c8ff", label: "Doc" }
  if (ext === "png" || ext === "jpg" || ext === "jpeg" || ext === "webp" || normalized.startsWith("image/")) return { icon: "🟥", color: "#ffb0b0", label: "Image" }
  if (ext === "pdf" || normalized.includes("pdf")) return { icon: "📕", color: "#ffb3b3", label: "PDF" }
  return { icon: "📄", color: "#d8e8f9", label: "File" }
}

async function fetchEntryFiles(kind: RecordKind, id: string) {
  const withFolderPath = await supabase
    .from("cc_entry_files")
    .select("id,file_name,file_type,drive_url,drive_file_id,folder_path")
    .eq("entry_kind", kind)
    .eq("entry_id", id)
    .order("folder_path", { ascending: true })
    .order("file_name", { ascending: true })

  if (!withFolderPath.error) {
    return (((withFolderPath.data as EntryFileRecord[]) || []).map((file) => ({
      ...file,
      folder_path: file.folder_path || "",
      source: "entry" as const,
    })))
  }

  const legacy = await supabase
    .from("cc_entry_files")
    .select("id,file_name,file_type,drive_url,drive_file_id")
    .eq("entry_kind", kind)
    .eq("entry_id", id)
    .order("file_name", { ascending: true })

  return (((legacy.data as EntryFileRecord[]) || []).map((file) => ({
    ...file,
    folder_path: "",
    source: "entry" as const,
  })))
}

async function fetchCompanyFiles(id: string) {
  const legacy = await supabase
    .from("cc_company_files")
    .select("id,file_name,file_type,drive_url,drive_file_id")
    .eq("company_id", id)
    .order("file_name", { ascending: true })

  return (((legacy.data as CompanyFileRecord[]) || []).map((file) => ({
    ...file,
    folder_path: "",
    source: "company" as const,
  })))
}

async function fetchFolders(kind: RecordKind, id: string) {
  const result = await supabase
    .from("cc_entry_folders")
    .select("id,folder_path,name")
    .eq("entry_kind", kind)
    .eq("entry_id", id)
    .order("folder_path", { ascending: true })
    .order("name", { ascending: true })

  if (result.error) return []
  return (result.data as EntryFolderRecord[]) || []
}

function AutoSizeTextarea({
  value,
  onChange,
  onBlur,
  style,
  title,
}: {
  value: string
  onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => void
  onBlur?: (event: React.FocusEvent<HTMLTextAreaElement>) => void
  style?: React.CSSProperties
  title?: string
}) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  useLayoutEffect(() => {
    const node = textareaRef.current
    if (!node) return
    node.style.height = "0px"
    node.style.height = `${node.scrollHeight}px`
  }, [value])

  return (
    <textarea
      ref={textareaRef}
      value={value}
      onChange={onChange}
      onBlur={onBlur}
      title={title}
      rows={1}
      style={{
        ...style,
        overflow: "hidden",
        resize: "none",
      }}
    />
  )
}

export default function CountryCompanyInfoPage() {
  const { loading: adminLoading, authenticated } = useSimpleAdminAuth()
  const isMobile = useIsMobile()
  const filePickerRef = useRef<HTMLInputElement | null>(null)
  const suggestionRefs = useRef<Array<HTMLButtonElement | null>>([])

  const [query, setQuery] = useState("")
  const [suggestions, setSuggestions] = useState<SearchRecord[]>([])
  const [activeSuggestion, setActiveSuggestion] = useState(0)
  const [selectedKind, setSelectedKind] = useState<RecordKind | "">("")
  const [selectedId, setSelectedId] = useState("")
  const [message, setMessage] = useState("")
  const [saving, setSaving] = useState(false)
  const [recordLoading, setRecordLoading] = useState(false)
  const [backingUp, setBackingUp] = useState(false)
  const [searchInPage, setSearchInPage] = useState("")
  const [matchCount, setMatchCount] = useState(0)
  const [matchIndex, setMatchIndex] = useState(0)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuCloseTimerRef = useRef<number | null>(null)
  const [files, setFiles] = useState<CompanyFileRecord[]>([])
  const [folders, setFolders] = useState<EntryFolderRecord[]>([])
  const [currentFolderPath, setCurrentFolderPath] = useState("")
  const [draggingFileId, setDraggingFileId] = useState("")
  const [dropFolderPath, setDropFolderPath] = useState("")
  const [currentCountryPorts, setCurrentCountryPorts] = useState<CountryPortListItem[]>([])
  const [highlights, setHighlights] = useState<HighlightCard[]>([])
  const [uploadingFile, setUploadingFile] = useState(false)
  const [selectedPreviewFile, setSelectedPreviewFile] = useState<EntryFileRecord | CompanyFileRecord | null>(null)
  const [previewModalOpen, setPreviewModalOpen] = useState(false)
  const [highlightModalOpen, setHighlightModalOpen] = useState(false)
  const [highlightDraft, setHighlightDraft] = useState<HighlightCard>({ title: "", info: "" })
  const [addPortModalOpen, setAddPortModalOpen] = useState(false)
  const [addPortDraft, setAddPortDraft] = useState({ name: "", notes: "" })
  const [sectionSaving, setSectionSaving] = useState(false)
  const sectionSaveTimerRef = useRef<number | null>(null)

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
    const tokens = needle
      .toLowerCase()
      .split(/\s+/)
      .map((item) => item.trim())
      .filter(Boolean)

    const timeout = setTimeout(async () => {
      const firstToken = tokens[0] || needle
      const [companies, countries, ports] = await Promise.all([
        supabase.from("cc_companies").select("id,name").ilike("name", `%${firstToken}%`).order("name", { ascending: true }).limit(30),
        supabase.from("cc_countries").select("id,name").ilike("name", `%${firstToken}%`).order("name", { ascending: true }).limit(30),
        supabase.from("cc_ports").select("id,name,country_name").ilike("name", `%${firstToken}%`).order("name", { ascending: true }).limit(40),
      ])

      const matchesTokens = (value: string) => {
        const lower = value.toLowerCase()
        return tokens.every((token) => lower.includes(token))
      }

      const next: SearchRecord[] = []
      if (!countries.error) {
        next.push(
          ...((((countries.data as { id: string; name: string }[]) || []).filter((item) => matchesTokens(item.name)).map((item) => ({
            ...item,
            kind: "country" as const,
          })))),
        )
      }
      if (!ports.error) {
        next.push(
          ...((((ports.data as { id: string; name: string; country_name: string | null }[]) || []).filter((item) => matchesTokens(item.name)).map((item) => ({
            ...item,
            kind: "port" as const,
          })))),
        )
      }
      if (!companies.error) {
        next.push(
          ...((((companies.data as { id: string; name: string }[]) || []).filter((item) => matchesTokens(item.name)).map((item) => ({
            ...item,
            kind: "company" as const,
          })))),
        )
      }
      setSuggestions(next.slice(0, 20))
    }, 120)

    return () => clearTimeout(timeout)
  }, [adminLoading, authenticated, query])

  useEffect(() => {
    setActiveSuggestion(0)
  }, [query])

  useEffect(() => {
    if (!suggestions.length) return
    const node = suggestionRefs.current[activeSuggestion]
    if (!node) return
    node.scrollIntoView({ block: "nearest" })
  }, [activeSuggestion, suggestions.length])

  useEffect(() => {
    if (adminLoading || !authenticated || selectedId || typeof window === "undefined") return
    const params = new URLSearchParams(window.location.search)
    const kind = params.get("kind")
    const id = params.get("id")
    if ((kind === "company" || kind === "country" || kind === "port") && id) {
      void loadSelected(kind, id)
    }
  }, [adminLoading, authenticated, selectedId])

  useEffect(() => {
    setMatchIndex(0)
  }, [searchInPage, selectedId, selectedKind])

  const displayedInfoHtml = useMemo(() => highlightTextHtml(currentRecord.notes || "", searchInPage), [currentRecord.notes, searchInPage])
  const displayedCountryInfoHtml = useMemo(() => highlightTextHtml(currentCountry.notes || "", searchInPage), [currentCountry.notes, searchInPage])
  const visibleFolders = useMemo(
    () =>
      folders
        .filter((folder) => folder.folder_path === currentFolderPath)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [currentFolderPath, folders],
  )
  const visibleFiles = useMemo(
    () =>
      files
        .filter((file) => (file.folder_path || "") === currentFolderPath)
        .sort((a, b) => a.file_name.localeCompare(b.file_name)),
    [currentFolderPath, files],
  )
  const breadcrumbSegments = useMemo(() => currentFolderPath.split("/").filter(Boolean), [currentFolderPath])

  useEffect(() => {
    const parser = new DOMParser()
    const mainDoc = parser.parseFromString(`<div>${displayedInfoHtml}</div>`, "text/html")
    const countryDoc = parser.parseFromString(`<div>${displayedCountryInfoHtml}</div>`, "text/html")
    const mainMatches = Array.from(mainDoc.querySelectorAll('mark[data-search-match="true"]'))
    const countryMatches = selectedKind === "port" ? Array.from(countryDoc.querySelectorAll('mark[data-search-match="true"]')) : []
    setMatchCount(mainMatches.length + countryMatches.length)
  }, [displayedInfoHtml, displayedCountryInfoHtml, matchIndex, searchInPage, selectedKind])

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
    setFolders([])
    setCurrentFolderPath("")
    setDraggingFileId("")
    setDropFolderPath("")
    setCurrentCountryPorts([])
    setHighlights([])
    setSelectedPreviewFile(null)
    setPreviewModalOpen(false)
    setSearchInPage("")
  }

  async function loadCompany(id: string) {
    const [{ data, error }, filesResult, manualFilesResult, foldersResult] = await Promise.all([
      supabase.from("cc_companies").select("id,name,summary,notes").eq("id", id).single(),
      fetchCompanyFiles(id),
      fetchEntryFiles("company", id),
      fetchFolders("company", id),
    ])
    if (error || !data) throw error || new Error("Unable to load company")
    setCurrentRecord(data as BaseRecord)
    setCurrentCountry({ id: "", name: "", summary: "", notes: "" })
    setFiles([...filesResult, ...manualFilesResult])
    setFolders(foldersResult)
    setCurrentFolderPath("")
    setCurrentCountryPorts([])
    setHighlights(parseHighlights((data as BaseRecord).summary))
    setSelectedPreviewFile(null)
    setPreviewModalOpen(false)
  }

  async function loadCountry(id: string) {
    const [{ data, error }, filesResult, foldersResult] = await Promise.all([
      supabase.from("cc_countries").select("id,name,summary,notes,region").eq("id", id).single(),
      fetchEntryFiles("country", id),
      fetchFolders("country", id),
    ])
    if (error || !data) throw error || new Error("Unable to load country")
    const countryName = (data as CountryRecord).name
    const portsResult = await supabase
      .from("cc_ports")
      .select("id,name,summary,notes")
      .or(`country_id.eq.${id},country_name.ilike.${countryName.replace(/,/g, "\\,")}`)
      .order("name", { ascending: true })
    setCurrentRecord(data as BaseRecord)
    setCurrentCountry(data as CountryRecord)
    setFiles(filesResult)
    setFolders(foldersResult)
    setCurrentFolderPath("")
    setCurrentCountryPorts((portsResult.data as CountryPortListItem[]) || [])
    setHighlights(parseHighlights((data as BaseRecord).summary))
    setSelectedPreviewFile(null)
    setPreviewModalOpen(false)
  }

  async function loadPort(id: string) {
    const [{ data, error }, filesResult, foldersResult] = await Promise.all([
      supabase.from("cc_ports").select("id,name,summary,notes,country_id,country_name").eq("id", id).single(),
      fetchEntryFiles("port", id),
      fetchFolders("port", id),
    ])
    if (error || !data) throw error || new Error("Unable to load port")
    const port = data as PortRecord
    setCurrentRecord(port)
    setFiles(filesResult)
    setFolders(foldersResult)
    setCurrentFolderPath("")
    setCurrentCountryPorts([])
    setHighlights(parseHighlights(port.summary))
    setSelectedPreviewFile(null)
    setPreviewModalOpen(false)

    if (port.country_id) {
      const { data: countryData } = await supabase.from("cc_countries").select("id,name,summary,notes,region").eq("id", port.country_id).single()
      setCurrentCountry((countryData as CountryRecord) || { id: "", name: port.country_name || "", summary: "", notes: "" })
    } else if (port.country_name?.trim()) {
      const { data: countryData } = await supabase
        .from("cc_countries")
        .select("id,name,summary,notes,region")
        .ilike("name", port.country_name.trim())
        .limit(1)
        .maybeSingle()

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

  async function addPortUnderCountry() {
    if (selectedKind !== "country" || !selectedId) return
    if (!addPortDraft.name.trim()) {
      setMessage("Port name is required.")
      return
    }
    const countryName = currentRecord.name.trim() || currentCountry.name.trim() || "New Country"
    const { data, error } = await supabase
      .from("cc_ports")
      .insert({ name: addPortDraft.name.trim(), summary: null, notes: addPortDraft.notes || "", country_id: selectedId, country_name: countryName, tags: [], status: "active" })
      .select("id,name,summary,notes")
      .single()
    if (error || !data) {
      setMessage("Unable to add port.")
      return
    }
    const nextPort = data as CountryPortListItem
    setCurrentCountryPorts((prev) => [...prev, nextPort].sort((a, b) => a.name.localeCompare(b.name)))
    setAddPortModalOpen(false)
    setAddPortDraft({ name: "", notes: "" })
    setMessage("Port added.")
  }

  async function saveRecord() {
    if (!selectedId || !selectedKind) return
    setSaving(true)
    setMessage("")
    try {
      if (selectedKind === "company") {
        const { error } = await supabase.from("cc_companies").update({ name: currentRecord.name.trim(), summary: serializeHighlights(highlights) || null, notes: currentRecord.notes || null }).eq("id", selectedId)
        if (error) throw error
      }
      if (selectedKind === "country") {
        const { error } = await supabase.from("cc_countries").update({ name: currentRecord.name.trim(), summary: serializeHighlights(highlights) || null, notes: currentRecord.notes || null }).eq("id", selectedId)
        if (error) throw error
      }
      if (selectedKind === "port") {
        const { error } = await supabase.from("cc_ports").update({
          name: currentRecord.name.trim(),
          summary: serializeHighlights(highlights) || null,
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
    void uploadFiles(picked)
    event.target.value = ""
  }

  async function persistHighlights(nextHighlights: HighlightCard[]) {
    if (!selectedId || !selectedKind) return
    const payload = { summary: serializeHighlights(nextHighlights) || null }
    const table = selectedKind === "company" ? "cc_companies" : selectedKind === "country" ? "cc_countries" : "cc_ports"
    const { error } = await supabase.from(table).update(payload).eq("id", selectedId)
    if (error) throw error
  }

  async function saveHighlightCard() {
    if (!highlightDraft.title.trim()) {
      setHighlightModalOpen(false)
      setHighlightDraft({ title: "", info: "" })
      return
    }
    const nextHighlights = [...highlights, { title: normalizeSectionTitle(highlightDraft.title), info: "" }]
    setHighlights(nextHighlights)
    setHighlightDraft({ title: "", info: "" })
    setHighlightModalOpen(false)
    try {
      await persistHighlights(nextHighlights)
      setMessage("Highlight saved.")
    } catch {
      setMessage("Unable to save highlight.")
    }
  }

  async function saveHighlightInfo(index: number, info: string) {
    const nextHighlights = highlights.map((item, itemIndex) => (itemIndex === index ? { ...item, info } : item))
    setHighlights(nextHighlights)
    try {
      await persistHighlights(nextHighlights)
      setMessage("Section saved.")
    } catch {
      setMessage("Unable to save section.")
    }
  }

  function queueSectionSave(nextHighlights: HighlightCard[]) {
    if (sectionSaveTimerRef.current) {
      window.clearTimeout(sectionSaveTimerRef.current)
    }
    setSectionSaving(true)
    sectionSaveTimerRef.current = window.setTimeout(async () => {
      try {
        await persistHighlights(nextHighlights)
      } catch {
        setMessage("Unable to auto-save section.")
      } finally {
        setSectionSaving(false)
      }
    }, 450)
  }

  async function deleteHighlightCard(index: number) {
    if (!confirm("Delete this highlight card?")) return
    const nextHighlights = highlights.filter((_, i) => i !== index)
    setHighlights(nextHighlights)
    try {
      await persistHighlights(nextHighlights)
      setMessage("Highlight deleted.")
    } catch {
      setMessage("Unable to delete highlight.")
    }
  }

  async function moveHighlight(index: number, direction: -1 | 1) {
    const targetIndex = index + direction
    if (targetIndex < 0 || targetIndex >= highlights.length) return
    const nextHighlights = [...highlights]
    const [moved] = nextHighlights.splice(index, 1)
    nextHighlights.splice(targetIndex, 0, moved)
    setHighlights(nextHighlights)
    try {
      await persistHighlights(nextHighlights)
      setMessage("Section order updated.")
    } catch {
      setMessage("Unable to reorder sections.")
    }
  }

  async function refreshFiles(kind: RecordKind, id: string) {
    if (kind === "company") {
      const [legacyFiles, manualFiles] = await Promise.all([fetchCompanyFiles(id), fetchEntryFiles("company", id)])
      return [...legacyFiles, ...manualFiles]
    }
    return fetchEntryFiles(kind, id)
  }

  async function uploadFiles(picked: File[]) {
    if (!selectedId || !selectedKind) {
      setMessage("Open a company, country, or port before uploading.")
      return
    }
    setUploadingFile(true)
    setMessage("")
    try {
      const uploaded: EntryFileRecord[] = []
      for (const file of picked) {
        const form = new FormData()
        form.append("entryKind", selectedKind)
        form.append("entryId", selectedId)
        form.append("entryName", currentRecord.name || "Untitled")
        form.append("folderPath", currentFolderPath)
        form.append("file", file)
        const response = await fetch("/api/ccinfo/upload", { method: "POST", body: form })
        const data = await response.json()
        if (!response.ok) throw new Error(data.message || "Upload failed")
        uploaded.push(data.file as EntryFileRecord)
      }
      const refreshedFiles = await refreshFiles(selectedKind, selectedId)
      setFiles(refreshedFiles)
      const targetFile = refreshedFiles.find((file) => file.file_name === uploaded[uploaded.length - 1]?.file_name && (file.folder_path || "") === currentFolderPath)
      setSelectedPreviewFile(targetFile || refreshedFiles[0] || uploaded[0] || null)
      setMessage(`Uploaded ${picked.length} file${picked.length > 1 ? "s" : ""}.`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to upload file.")
    } finally {
      setUploadingFile(false)
    }
  }

  async function createFolder() {
    if (!selectedId || !selectedKind) return
    const name = window.prompt("New folder name")
    if (!name?.trim()) return
    try {
      const response = await fetch("/api/ccinfo/files", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entryKind: selectedKind,
          entryId: selectedId,
          folderPath: currentFolderPath,
          name: name.trim(),
        }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.message || "Unable to create folder.")
      const nextFolder = data.folder as EntryFolderRecord
      setFolders((prev) => [...prev, nextFolder].sort((a, b) => joinFolderPath(a.folder_path, a.name).localeCompare(joinFolderPath(b.folder_path, b.name))))
      setCurrentFolderPath(joinFolderPath(nextFolder.folder_path, nextFolder.name))
      setMessage("Folder created.")
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to create folder.")
    }
  }

  async function deleteFile(file: CompanyFileRecord | EntryFileRecord) {
    if (!confirm(`Delete ${file.file_name}?`)) return
    try {
      const params = new URLSearchParams({
        fileId: file.id,
        source: file.source || "entry",
      })
      const response = await fetch(`/api/ccinfo/files?${params.toString()}`, { method: "DELETE" })
      const data = await response.json()
      if (!response.ok) throw new Error(data.message || "Unable to delete file.")
      setFiles((prev) => prev.filter((item) => item.id !== file.id))
      if (selectedPreviewFile?.id === file.id) {
        setSelectedPreviewFile(null)
        setPreviewModalOpen(false)
      }
      setMessage("Upload deleted.")
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to delete file.")
    }
  }

  async function moveFileToFolder(file: CompanyFileRecord | EntryFileRecord, targetFolderPath: string) {
    if (!selectedId || !selectedKind) return
    if ((file.folder_path || "") === targetFolderPath) return
    try {
      const response = await fetch("/api/ccinfo/files", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileId: file.id,
          source: file.source || "entry",
          entryKind: selectedKind,
          entryId: selectedId,
          entryName: currentRecord.name || "Untitled",
          folderPath: targetFolderPath,
        }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.message || "Unable to move file.")
      const refreshedFiles = await refreshFiles(selectedKind, selectedId)
      setFiles(refreshedFiles)
      setMessage("File moved.")
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to move file.")
    } finally {
      setDraggingFileId("")
      setDropFolderPath("")
    }
  }

  async function downloadBackup() {
    try {
      setBackingUp(true)
      setMessage("")
      const response = await fetch("/api/ccinfo/backup")
      if (!response.ok) {
        const data = await response.json().catch(() => ({ message: "Backup failed." }))
        throw new Error(data.message || "Backup failed.")
      }
      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      const link = document.createElement("a")
      link.href = url
      link.download = `ccinfo-backup-${new Date().toISOString().slice(0, 10)}.json`
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      URL.revokeObjectURL(url)
      setMessage("Backup downloaded.")
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Backup failed.")
    } finally {
      setBackingUp(false)
    }
  }

  async function pickSuggestion(item: SearchRecord) {
    await loadSelected(item.kind, item.id)
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href)
      url.searchParams.set("kind", item.kind)
      url.searchParams.set("id", item.id)
      window.history.replaceState({}, "", url.toString())
    }
    setQuery("")
    setSuggestions([])
    setSearchInPage("")
    setMenuOpen(false)
  }

  if (!adminLoading && !authenticated) return <p style={{ padding: "40px" }}>Access Denied</p>
  if (adminLoading) return <p style={{ padding: "40px" }}>Loading...</p>

  const mainLabel =
    selectedKind === "country"
      ? "Country"
      : selectedKind === "port"
        ? "Port"
        : selectedKind === "company"
          ? "Company Name"
          : "Name"
  const informationLabel =
    selectedKind === "port"
      ? "Port Information"
      : "General Information"
  const countryInformationLabel = selectedKind === "port" ? "General Information" : "Country Information"
  const previewUrl = selectedPreviewFile ? getPreviewUrl(selectedPreviewFile) : ""
  const fileSection = !initialMode ? (
    <div style={{ ...panelStyle, padding: "12px", display: "grid", gap: "10px" }}>
      <div style={{ fontSize: "12px", letterSpacing: "0.12em", textTransform: "uppercase", color: "#8fd7ff", fontWeight: 700 }}>
        Files
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", alignItems: "center" }}>
        <button
          type="button"
          onClick={() => setCurrentFolderPath("")}
          onDragOver={(event) => {
            if (!draggingFileId) return
            event.preventDefault()
            setDropFolderPath("")
          }}
          onDrop={(event) => {
            if (!draggingFileId) return
            event.preventDefault()
            const fileId = event.dataTransfer.getData("text/plain")
            const file = files.find((item) => item.id === fileId)
            if (file) void moveFileToFolder(file, "")
          }}
          style={{
            ...buttonStyle,
            padding: "5px 8px",
            fontSize: "10px",
            background: "transparent",
            border: "none",
            boxShadow: "none",
            color: currentFolderPath ? "#b8d2e8" : "#edf7ff",
          }}
        >
          HOME
        </button>
        {breadcrumbSegments.length > 0 && <span style={{ color: "#91badb", fontSize: "11px" }}>&gt;</span>}
        {breadcrumbSegments.map((segment, index) => {
          const path = breadcrumbSegments.slice(0, index + 1).join("/")
          const active = path === currentFolderPath
          return (
            <div key={path} style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
            <button
              type="button"
              onClick={() => setCurrentFolderPath(path)}
              style={{
                ...buttonStyle,
                padding: "5px 8px",
                fontSize: "10px",
                background: "transparent",
                border: "none",
                boxShadow: "none",
                color: active ? "#edf7ff" : "#b8d2e8",
              }}
            >
              {segment}
            </button>
            {index < breadcrumbSegments.length - 1 ? <span style={{ color: "#91badb", fontSize: "11px" }}>&gt;</span> : null}
            </div>
          )
        })}
      </div>
      <div style={{ display: "grid", gap: "6px", maxHeight: isMobile ? "240px" : "56vh", overflowY: "auto", paddingRight: "2px" }}>
        {visibleFolders.length === 0 && visibleFiles.length === 0 ? (
          <div style={{ color: "#9ebad1", fontSize: "12px" }}>No linked files yet.</div>
        ) : (
          <>
            {visibleFolders.map((folder) => (
              <button
              key={folder.id}
              type="button"
              onClick={() => setCurrentFolderPath(joinFolderPath(folder.folder_path, folder.name))}
              onDragOver={(event) => {
                if (!draggingFileId) return
                event.preventDefault()
                setDropFolderPath(joinFolderPath(folder.folder_path, folder.name))
              }}
              onDragLeave={() => {
                if (dropFolderPath === joinFolderPath(folder.folder_path, folder.name)) {
                  setDropFolderPath("")
                }
              }}
              onDrop={(event) => {
                if (!draggingFileId) return
                event.preventDefault()
                const fileId = event.dataTransfer.getData("text/plain")
                const file = files.find((item) => item.id === fileId)
                if (file) void moveFileToFolder(file, joinFolderPath(folder.folder_path, folder.name))
              }}
              style={{
                display: "grid",
                gridTemplateColumns: "42px minmax(0,1fr)",
                gap: "8px",
                alignItems: "center",
                padding: "7px 8px",
                borderRadius: "10px",
                border:
                  dropFolderPath === joinFolderPath(folder.folder_path, folder.name)
                    ? "1px solid rgba(117, 226, 165, 0.34)"
                    : "1px solid rgba(210,236,255,0.08)",
                background:
                  dropFolderPath === joinFolderPath(folder.folder_path, folder.name)
                    ? "linear-gradient(180deg, rgba(95, 188, 138, 0.24) 0%, rgba(20, 98, 61, 0.12) 100%)"
                    : "rgba(255,255,255,0.03)",
                color: "#e5f1fb",
                cursor: "pointer",
                textAlign: "left",
                }}
              >
                <span style={{ ...fileIconStyle, color: "#ffd472" }}>📁</span>
                <span style={{ fontSize: "11px", lineHeight: 1.35, overflowWrap: "anywhere" }}>{folder.name}</span>
              </button>
            ))}
            {visibleFiles.map((file) => {
            const active = selectedPreviewFile?.id === file.id
            const fileTypeVisual = getFileTypeLabel(file.file_name, file.file_type)
            return (
              <div
                key={file.id}
                draggable={file.source !== "company"}
                onDragStart={(event) => {
                  if (file.source === "company") return
                  setDraggingFileId(file.id)
                  event.dataTransfer.setData("text/plain", file.id)
                  event.dataTransfer.effectAllowed = "move"
                }}
                onDragEnd={() => {
                  setDraggingFileId("")
                  setDropFolderPath("")
                }}
                style={{
                  display: "grid",
                  gridTemplateColumns: "42px minmax(0,1fr) auto",
                  gap: "8px",
                  alignItems: "center",
                  padding: "7px 8px",
                  borderRadius: "10px",
                  border: active ? "1px solid rgba(112, 199, 255, 0.32)" : "1px solid rgba(210,236,255,0.08)",
                  background: active ? "linear-gradient(180deg, rgba(78, 154, 237, 0.18) 0%, rgba(20, 55, 102, 0.18) 100%)" : "rgba(255,255,255,0.03)",
                  opacity: draggingFileId === file.id ? 0.6 : 1,
                  cursor: file.source === "company" ? "default" : "grab",
                }}
              >
                <span style={{ ...fileIconStyle, color: fileTypeVisual.color }} title={fileTypeVisual.label}>{fileTypeVisual.icon}</span>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedPreviewFile(file)
                    setPreviewModalOpen(true)
                  }}
                  style={{
                    border: "none",
                    background: "transparent",
                    color: "#e5f1fb",
                    cursor: "pointer",
                    textAlign: "left",
                    padding: 0,
                    fontSize: "11px",
                    lineHeight: 1.35,
                    overflowWrap: "anywhere",
                  }}
                >
                  {file.file_name}
                </button>
                <button
                  type="button"
                  onClick={() => void deleteFile(file)}
                  style={{ ...buttonStyle, padding: "4px 7px", fontSize: "10px", background: "linear-gradient(180deg, rgba(230, 57, 70, 0.24) 0%, rgba(170, 47, 53, 0.12) 100%)", color: "#ffd6db", border: "1px solid rgba(255, 120, 120, 0.22)" }}
                >
                  Delete
                </button>
              </div>
            )
            })}
          </>
        )}
      </div>
      {selectedPreviewFile?.drive_url && (
        <a href={selectedPreviewFile.drive_url} target="_blank" rel="noreferrer" style={{ ...buttonStyle, display: "block", textAlign: "center" }}>
          Open In Drive
        </a>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "8px" }}>
        <button onClick={() => void createFolder()} style={{ ...buttonStyle, width: "100%" }}>
          New Folder
        </button>
        <button onClick={() => filePickerRef.current?.click()} disabled={uploadingFile} style={{ ...buttonStyle, width: "100%" }}>
          {uploadingFile ? "Uploading..." : "Upload File"}
        </button>
      </div>
    </div>
  ) : null

  return (
    <div style={pageShellStyle}>
      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "260px minmax(0, 1fr) 320px", height: "100vh", overflow: "hidden" }}>
        {!isMobile && (
          <aside style={{ ...sidebarStyle, height: "100vh", overflow: "hidden" }}>
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
                    <div
                      style={{ ...panelStyle, position: "absolute", right: 0, bottom: "48px", padding: "8px", display: "grid", gap: "6px", minWidth: "150px", zIndex: 20 }}
                      onMouseEnter={() => {
                        if (menuCloseTimerRef.current) window.clearTimeout(menuCloseTimerRef.current)
                      }}
                      onMouseLeave={() => {
                        menuCloseTimerRef.current = window.setTimeout(() => setMenuOpen(false), 650)
                      }}
                    >
                      <button onClick={() => void createNew("country")} style={{ ...buttonStyle, textAlign: "left" }}>New Country</button>
                      <button onClick={() => void createNew("port")} style={{ ...buttonStyle, textAlign: "left" }}>New Port</button>
                      <button onClick={() => void createNew("company")} style={{ ...buttonStyle, textAlign: "left" }}>New Company</button>
                      <a href="/admin/ccinfo/countries" style={{ ...buttonStyle, textAlign: "left", display: "block" }}>Country Index</a>
                      <a href="/admin/ccinfo/ports" style={{ ...buttonStyle, textAlign: "left", display: "block" }}>Port Index</a>
                      <button onClick={() => void downloadBackup()} disabled={backingUp} style={{ ...buttonStyle, textAlign: "left" }}>
                        {backingUp ? "Preparing Backup..." : "Download Backup"}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </aside>
        )}

        <main style={{ padding: isMobile ? "16px" : "22px", height: "100vh", overflowY: "auto", scrollbarWidth: "thin", scrollbarColor: "rgba(175,205,230,0.35) transparent" }}>
          <div style={{ display: "grid", gap: "14px" }}>
            <div style={{ ...panelStyle, padding: "14px", position: "sticky", top: "16px", zIndex: 10 }}>
              <input
                value={query}
                onClick={() => {
                  setQuery("")
                  setSuggestions([])
                }}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleSearchKeyDown}
                placeholder="Search company, country or port..."
                style={searchInputStyle}
              />
              {suggestions.length > 0 && query.trim() && (
                <div
                  style={{
                    ...panelStyle,
                    position: "absolute",
                    top: "calc(100% - 2px)",
                    left: "14px",
                    right: "14px",
                    padding: "6px",
                    display: "grid",
                    gap: "4px",
                    maxHeight: "300px",
                    overflowY: "auto",
                  }}
                >
                  {suggestions.map((item, index) => (
                    <button
                      key={`${item.kind}-${item.id}`}
                      ref={(node) => {
                        suggestionRefs.current[index] = node
                      }}
                      onClick={() => void pickSuggestion(item)}
                      style={{
                        textAlign: "left",
                        padding: "6px 8px",
                        borderRadius: "12px",
                        border: index === activeSuggestion ? "1px solid rgba(73, 219, 165, 0.26)" : "1px solid rgba(210,236,255,0.08)",
                        background: index === activeSuggestion ? "linear-gradient(180deg, rgba(56, 214, 154, 0.16) 0%, rgba(20, 130, 93, 0.08) 100%)" : "transparent",
                        color: "#edf7ff",
                        cursor: "pointer",
                      }}
                    >
                      <div style={{ fontWeight: 700 }}>{item.name}</div>
                      <div style={{ color: "#8fc2e8", fontSize: "11px", marginTop: "1px" }}>
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
                          <button onClick={() => void createNew("country")} style={{ ...buttonStyle, textAlign: "left" }}>New Country</button>
                          <button onClick={() => void createNew("port")} style={{ ...buttonStyle, textAlign: "left" }}>New Port</button>
                          <button onClick={() => void createNew("company")} style={{ ...buttonStyle, textAlign: "left" }}>New Company</button>
                          <a href="/admin/ccinfo/countries" style={{ ...buttonStyle, textAlign: "left", display: "block" }}>Country Index</a>
                          <a href="/admin/ccinfo/ports" style={{ ...buttonStyle, textAlign: "left", display: "block" }}>Port Index</a>
                          <button onClick={() => void downloadBackup()} disabled={backingUp} style={{ ...buttonStyle, textAlign: "left" }}>
                            {backingUp ? "Preparing Backup..." : "Download Backup"}
                          </button>
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
                      <button onClick={saveRecord} disabled={saving || sectionSaving || !selectedId} style={{ ...buttonStyle, minWidth: "96px", background: "linear-gradient(180deg, rgba(56, 214, 154, 0.34) 0%, rgba(20, 130, 93, 0.16) 100%)", color: "#ddffef", border: "1px solid rgba(73, 219, 165, 0.26)" }}>{saving || sectionSaving ? "SAVING..." : "Save"}</button>
                      <button onClick={deleteRecord} disabled={!selectedId} style={{ ...buttonStyle, background: "linear-gradient(180deg, rgba(230, 57, 70, 0.24) 0%, rgba(170, 47, 53, 0.12) 100%)", color: "#ffd6db", border: "1px solid rgba(255, 120, 120, 0.22)" }}>Delete</button>
                    </div>
                  </div>

                  {selectedKind === "port" && (
                    <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "220px minmax(0, 1fr)", gap: "10px", alignItems: "end" }}>
                      <div>
                        <div style={{ fontSize: "12px", letterSpacing: "0.12em", textTransform: "uppercase", color: "#8fd7ff", fontWeight: 700, marginBottom: "6px" }}>Country</div>
                        <input value={currentCountry.name} onChange={(e) => setCurrentCountry((prev) => ({ ...prev, name: e.target.value }))} style={inputStyle} />
                      </div>
                    </div>
                  )}

                  {isMobile && fileSection}

                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "6px" }}>
                      <div style={{ fontSize: "12px", letterSpacing: "0.12em", textTransform: "uppercase", color: "#8fd7ff", fontWeight: 700 }}>{informationLabel}</div>
                      <button
                        onClick={() => {
                          setHighlightDraft({ title: "", info: "" })
                          setHighlightModalOpen(true)
                        }}
                        disabled={!selectedId}
                        style={{ ...buttonStyle, padding: "4px 10px", fontSize: "11px", lineHeight: 1, background: "linear-gradient(180deg, rgba(255, 210, 86, 0.42) 0%, rgba(191, 136, 16, 0.2) 100%)", color: "#fff2bc", border: "1px solid rgba(255, 211, 110, 0.34)" }}
                        title="Add section"
                      >
                        Add Section
                      </button>
                    </div>
                    {recordLoading && <div style={{ color: "#9ebad1", marginBottom: "8px" }}>Loading...</div>}
                    <AutoSizeTextarea
                      value={currentRecord.notes || ""}
                      onChange={(event) => setCurrentRecord((prev) => ({ ...prev, notes: event.target.value }))}
                      style={{ ...textareaStyle, minHeight: selectedKind === "port" ? "180px" : "320px" }}
                    />
                  </div>

                  {highlights.length > 0 && (
                    <div style={{ display: "grid", gap: "12px" }}>
                      {highlights.map((highlight, index) => (
                        <div key={`section-${index}`}>
                          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px", marginBottom: "6px" }}>
                            <div style={{ fontSize: "11px", letterSpacing: "0.1em", textTransform: "uppercase", color: "#7ec4f1", fontWeight: 700 }}>
                              {highlight.title || `SECTION ${index + 1}`}
                            </div>
                            <div style={{ display: "flex", gap: "6px" }}>
                              <button onClick={() => void moveHighlight(index, -1)} style={{ ...buttonStyle, padding: "3px 8px", fontSize: "10px" }}>↑</button>
                              <button onClick={() => void moveHighlight(index, 1)} style={{ ...buttonStyle, padding: "3px 8px", fontSize: "10px" }}>↓</button>
                              <button onClick={() => void deleteHighlightCard(index)} style={{ ...buttonStyle, padding: "3px 8px", fontSize: "10px" }}>x</button>
                            </div>
                          </div>
                          <AutoSizeTextarea
                            value={highlight.info}
                            onChange={(event) => {
                              const value = event.target.value
                              setHighlights((prev) => {
                                const prevItem = prev[index]
                                const prevLines = (prevItem?.info || "").split("\n")
                                const nextLines = value.split("\n")
                                const lineUpdates: Record<string, string> = { ...(prevItem?.line_updates || {}) }
                                const now = new Date().toISOString()
                                for (let i = 0; i < nextLines.length; i += 1) {
                                  if ((prevLines[i] || "") !== nextLines[i]) lineUpdates[String(i)] = now
                                }
                                const next = prev.map((item, itemIndex) => (itemIndex === index ? { ...item, info: value, line_updates: lineUpdates } : item))
                                queueSectionSave(next)
                                return next
                              })
                            }}
                            style={{ ...textareaStyle, minHeight: "calc(1em + 28px)" }}
                            title={Object.entries(highlight.line_updates || {})
                              .map(([line, date]) => `Line ${Number(line) + 1}: ${new Date(date).toLocaleString()}`)
                              .join("\n")}
                          />
                        </div>
                      ))}
                    </div>
                  )}

                  {selectedKind === "port" && (
                    <div>
                      <div style={{ fontSize: "12px", letterSpacing: "0.12em", textTransform: "uppercase", color: "#8fd7ff", fontWeight: 700, marginBottom: "6px" }}>{countryInformationLabel}</div>
                      <AutoSizeTextarea
                        value={currentCountry.notes || ""}
                        onChange={(event) => setCurrentCountry((prev) => ({ ...prev, notes: event.target.value }))}
                        style={{ ...textareaStyle, minHeight: "180px" }}
                      />
                    </div>
                  )}

                  {selectedKind === "country" && (
                    <div>
                      <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "6px" }}>
                        <div style={{ fontSize: "12px", letterSpacing: "0.12em", textTransform: "uppercase", color: "#8fd7ff", fontWeight: 700 }}>Ports</div>
                        <button onClick={() => setAddPortModalOpen(true)} style={{ ...buttonStyle, padding: "4px 10px", fontSize: "11px", lineHeight: 1, background: "linear-gradient(180deg, rgba(255, 210, 86, 0.42) 0%, rgba(191, 136, 16, 0.2) 100%)", color: "#fff2bc", border: "1px solid rgba(255, 211, 110, 0.34)" }}>
                          Add Port
                        </button>
                      </div>
                      <div style={{ ...panelStyle, padding: 0, background: "rgba(255,255,255,0.03)", overflow: "hidden" }}>
                        {currentCountryPorts.length === 0 ? (
                          <div style={{ color: "#9ebad1", padding: "12px" }}>No ports linked yet.</div>
                        ) : (
                          <div style={{ overflowX: "auto" }}>
                            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
                              <thead>
                                <tr>
                                  <th style={{ textAlign: "left", padding: "10px 12px", borderBottom: "1px solid rgba(210,236,255,0.14)", color: "#8fd7ff", fontSize: "11px", letterSpacing: "0.12em", textTransform: "uppercase" }}>Port</th>
                                  <th style={{ textAlign: "left", padding: "10px 12px", borderBottom: "1px solid rgba(210,236,255,0.14)", color: "#8fd7ff", fontSize: "11px", letterSpacing: "0.12em", textTransform: "uppercase" }}>Information</th>
                                </tr>
                              </thead>
                              <tbody>
                                {currentCountryPorts.map((port) => (
                                  <tr key={port.id}>
                                    <td style={{ verticalAlign: "top", padding: "10px 12px", borderBottom: "1px solid rgba(210,236,255,0.08)", color: "#e8f2fb", lineHeight: 1.45, whiteSpace: "nowrap", fontWeight: 700 }}>
                                      <button
                                        type="button"
                                        onClick={() => void loadSelected("port", port.id)}
                                        style={{ background: "none", border: 0, padding: 0, margin: 0, color: "#bfe6ff", fontWeight: 700, cursor: "pointer", textAlign: "left" }}
                                      >
                                        {port.name}
                                      </button>
                                    </td>
                                    <td style={{ verticalAlign: "top", padding: "10px 12px", borderBottom: "1px solid rgba(210,236,255,0.08)", color: "#e8f2fb", lineHeight: 1.45, whiteSpace: "pre-wrap" }}>
                                      {port.notes || "No information yet"}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
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
        {!isMobile && <aside style={{ ...sidebarStyle, width: "320px", height: "100vh", overflow: "hidden" }}>{fileSection}</aside>}
      </div>
      {previewModalOpen && selectedPreviewFile && previewUrl && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(1, 8, 18, 0.74)",
            display: "grid",
            placeItems: "center",
            padding: "22px",
            zIndex: 45,
          }}
          onClick={() => setPreviewModalOpen(false)}
        >
          <div
            style={{
              ...panelStyle,
              width: "min(1200px, 100%)",
              height: "min(88vh, 900px)",
              padding: "14px",
              display: "grid",
              gridTemplateRows: "auto 1fr",
              gap: "12px",
            }}
            onClick={(event) => event.stopPropagation()}
          >
            <div style={{ display: "flex", justifyContent: "space-between", gap: "12px", alignItems: "center" }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: "11px", letterSpacing: "0.12em", textTransform: "uppercase", color: "#8fd7ff", fontWeight: 700 }}>File Preview</div>
                <div style={{ fontWeight: 700, color: "#edf7ff", marginTop: "4px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{selectedPreviewFile.file_name}</div>
              </div>
              <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                {selectedPreviewFile.drive_url && (
                  <a href={selectedPreviewFile.drive_url} target="_blank" rel="noreferrer" style={buttonStyle}>
                    Open In Drive
                  </a>
                )}
                <button type="button" onClick={() => setPreviewModalOpen(false)} style={buttonStyle}>
                  Close
                </button>
              </div>
            </div>
            <div style={{ borderRadius: "16px", overflow: "hidden", border: "1px solid rgba(210,236,255,0.12)", background: "rgba(2, 10, 20, 0.34)" }}>
              <iframe src={previewUrl} title={selectedPreviewFile.file_name} style={{ width: "100%", height: "100%", border: 0 }} />
            </div>
          </div>
        </div>
      )}
      {highlightModalOpen && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(1, 8, 18, 0.58)",
            display: "grid",
            placeItems: "center",
            padding: "20px",
            zIndex: 40,
          }}
          onClick={() => {
            setHighlightModalOpen(false)
            setHighlightDraft({ title: "", info: "" })
          }}
        >
          <div
            style={{
              ...panelStyle,
              width: "min(520px, 100%)",
              padding: "18px",
              display: "grid",
              gap: "12px",
            }}
            onClick={(event) => event.stopPropagation()}
          >
            <div style={{ fontSize: "13px", letterSpacing: "0.12em", textTransform: "uppercase", color: "#ffe08a", fontWeight: 800 }}>
              Add Section
            </div>
            <div>
              <div style={{ fontSize: "12px", color: "#b9d7ee", marginBottom: "6px" }}>Section Name</div>
              <input
                value={highlightDraft.title}
                onChange={(event) => setHighlightDraft((prev) => ({ ...prev, title: event.target.value }))}
                style={inputStyle}
                placeholder="e.g. REFINERY"
              />
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
              <button
                type="button"
                onClick={() => {
                  setHighlightModalOpen(false)
                  setHighlightDraft({ title: "", info: "" })
                }}
                style={buttonStyle}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={saveHighlightCard}
                style={{
                  ...buttonStyle,
                  background: "linear-gradient(180deg, rgba(255, 210, 86, 0.42) 0%, rgba(191, 136, 16, 0.2) 100%)",
                  color: "#fff2bc",
                  border: "1px solid rgba(255, 211, 110, 0.34)",
                }}
              >
                Add
              </button>
            </div>
          </div>
        </div>
      )}
      {addPortModalOpen && (
        <div
          style={{ position: "fixed", inset: 0, background: "rgba(1, 8, 18, 0.58)", display: "grid", placeItems: "center", padding: "20px", zIndex: 40 }}
          onClick={() => {
            setAddPortModalOpen(false)
            setAddPortDraft({ name: "", notes: "" })
          }}
        >
          <div style={{ ...panelStyle, width: "min(580px, 100%)", padding: "18px", display: "grid", gap: "12px" }} onClick={(event) => event.stopPropagation()}>
            <div style={{ fontSize: "13px", letterSpacing: "0.12em", textTransform: "uppercase", color: "#ffe08a", fontWeight: 800 }}>Add Port</div>
            <div>
              <div style={{ fontSize: "12px", color: "#b9d7ee", marginBottom: "6px" }}>Port</div>
              <input value={addPortDraft.name} onChange={(event) => setAddPortDraft((prev) => ({ ...prev, name: event.target.value }))} style={inputStyle} />
            </div>
            <div>
              <div style={{ fontSize: "12px", color: "#b9d7ee", marginBottom: "6px" }}>Port Information</div>
              <textarea value={addPortDraft.notes} onChange={(event) => setAddPortDraft((prev) => ({ ...prev, notes: event.target.value }))} style={{ ...textareaStyle, minHeight: "180px" }} />
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
              <button type="button" onClick={() => setAddPortModalOpen(false)} style={buttonStyle}>Cancel</button>
              <button type="button" onClick={() => void addPortUnderCountry()} style={{ ...buttonStyle, background: "linear-gradient(180deg, rgba(255, 210, 86, 0.42) 0%, rgba(191, 136, 16, 0.2) 100%)", color: "#fff2bc", border: "1px solid rgba(255, 211, 110, 0.34)" }}>Save Port</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
