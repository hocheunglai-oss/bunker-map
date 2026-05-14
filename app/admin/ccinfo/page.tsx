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
  updated_at?: string | null
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

type InfoBlock = {
  id: string
  content: string
  updated_at: string
}

type ChangeLogItem = {
  id: string
  label: string
  at: string
  entryKind: RecordKind
  entryId: string
  field: "notes" | "section"
  before: string
  after: string
  sectionIndex?: number
  sectionTitle?: string
}

const CHANGE_LOG_STORAGE_KEY = "ccinfo_recent_changes_v1"

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
  minWidth: 0,
  overflowWrap: "anywhere",
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
  width: "24px",
  height: "20px",
  display: "inline-grid",
  placeItems: "center",
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

function changeLogSubject(kind: RecordKind, name: string) {
  const label = kind === "company" ? "Company" : kind === "country" ? "Country" : "Port"
  return name.trim() || label
}

type HighlightCard = {
  title: string
  info: string
  line_updates?: Record<string, string>
  blocks?: InfoBlock[]
}

type SummaryMeta = {
  sections: HighlightCard[]
  mainLineUpdates: Record<string, string>
  mainBlocks: InfoBlock[]
}

function newBlockId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID()
  return `block-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function textToBlocks(value: string | null | undefined, updates: Record<string, string> = {}, fallbackUpdatedAt?: string | null): InfoBlock[] {
  const now = fallbackUpdatedAt || new Date().toISOString()
  const lines = (value || "").split("\n")
  const keys = buildLineTimestampKeys(lines)
  return lines.map((line, index) => ({
    id: newBlockId(),
    content: line,
    updated_at: updates[keys[index]] || updates[String(index)] || now,
  }))
}

function blocksToText(blocks: InfoBlock[]) {
  return blocks.map((block) => block.content).join("\n")
}

function normalizeBlocks(value: unknown, fallbackText: string, updates: Record<string, string> = {}): InfoBlock[] {
  if (Array.isArray(value)) {
    return value.map((block) => {
      const source = block as Partial<InfoBlock>
      return {
        id: typeof source.id === "string" && source.id ? source.id : newBlockId(),
        content: typeof source.content === "string" ? source.content : "",
        updated_at: typeof source.updated_at === "string" && source.updated_at ? source.updated_at : new Date().toISOString(),
      }
    })
  }
  if (!fallbackText) return []
  return textToBlocks(fallbackText, updates)
}

function parseSummaryMeta(value: string | null): SummaryMeta {
  if (!value?.trim()) return { sections: [], mainLineUpdates: {}, mainBlocks: [] }
  try {
    const parsed = JSON.parse(value)
    if (parsed && !Array.isArray(parsed) && typeof parsed === "object") {
      const sectionSource = Array.isArray(parsed.sections) ? parsed.sections : []
      const mainLineUpdates = parsed.main_line_updates && typeof parsed.main_line_updates === "object" ? parsed.main_line_updates : {}
      return {
        sections: sectionSource
          .map((item: Partial<HighlightCard>) => ({
            title: typeof item?.title === "string" ? item.title : "",
            info: typeof item?.info === "string" ? item.info : "",
            line_updates: item?.line_updates && typeof item.line_updates === "object" ? item.line_updates : {},
            blocks: normalizeBlocks(item?.blocks, typeof item?.info === "string" ? item.info : "", item?.line_updates && typeof item.line_updates === "object" ? item.line_updates : {}),
          }))
          .filter((item: HighlightCard) => item.title.trim() || item.info.trim()),
        mainLineUpdates,
        mainBlocks: normalizeBlocks(parsed.main_blocks, "", mainLineUpdates),
      }
    }
    if (Array.isArray(parsed)) {
      return {
        sections: parsed
          .map((item: Partial<HighlightCard>) => ({
            title: typeof item?.title === "string" ? item.title : "",
            info: typeof item?.info === "string" ? item.info : "",
            line_updates: item?.line_updates && typeof item.line_updates === "object" ? item.line_updates : {},
            blocks: normalizeBlocks(item?.blocks, typeof item?.info === "string" ? item.info : "", item?.line_updates && typeof item.line_updates === "object" ? item.line_updates : {}),
          }))
          .filter((item: HighlightCard) => item.title.trim() || item.info.trim()),
        mainLineUpdates: {},
        mainBlocks: [],
      }
    }
  } catch {
    return {
      sections: value
        .split("\n")
        .map((item) => item.trim())
        .filter(Boolean)
        .map((item) => ({ title: "", info: item, blocks: textToBlocks(item) })),
      mainLineUpdates: {},
      mainBlocks: [],
    }
  }
  return { sections: [], mainLineUpdates: {}, mainBlocks: [] }
}

function parseHighlights(value: string | null): HighlightCard[] {
  return parseSummaryMeta(value).sections
}

function serializeSummaryMeta(items: HighlightCard[], mainLineUpdates: Record<string, string>, mainBlocks: InfoBlock[] = []) {
  return JSON.stringify(
    {
      sections: items
        .map((item) => ({
          title: item.title.trim(),
          info: item.info.trim(),
          line_updates: item.line_updates || {},
          blocks: item.blocks || textToBlocks(item.info, item.line_updates || {}),
        }))
        .filter((item) => item.title || item.info),
      main_line_updates: mainLineUpdates,
      main_blocks: mainBlocks,
    },
  )
}

function lineTimestampKey(line: string, occurrence: number) {
  return `v2:${line.trim().replace(/\s+/g, " ").toUpperCase()}#${occurrence}`
}

function buildLineTimestampKeys(lines: string[]) {
  const seen = new Map<string, number>()
  return lines.map((line) => {
    const normalized = line.trim().replace(/\s+/g, " ").toUpperCase()
    const occurrence = (seen.get(normalized) || 0) + 1
    seen.set(normalized, occurrence)
    return lineTimestampKey(line, occurrence)
  })
}

function updateLineTimestamps(previousValue: string, nextValue: string, previousUpdates: Record<string, string>) {
  const previousLines = previousValue.split("\n")
  const nextLines = nextValue.split("\n")
  const previousKeys = buildLineTimestampKeys(previousLines)
  const nextKeys = buildLineTimestampKeys(nextLines)
  const now = new Date().toISOString()
  const nextUpdates: Record<string, string> = {}

  nextLines.forEach((line, index) => {
    const key = nextKeys[index]
    const previousIndex = previousKeys.indexOf(key)
    const existing = previousUpdates[key] || previousUpdates[String(previousIndex)] || previousUpdates[String(index)]
    nextUpdates[key] = previousIndex >= 0 && previousLines[previousIndex] === line && existing ? existing : now
  })

  return nextUpdates
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
  if (ext === "xls" || ext === "xlsx" || normalized.includes("sheet")) return { color: "#188038", label: "XLS" }
  if (ext === "doc" || ext === "docx" || normalized.includes("word")) return { color: "#1a73e8", label: "DOC" }
  if (ext === "png" || ext === "jpg" || ext === "jpeg" || ext === "webp" || normalized.startsWith("image/")) return { color: "#d93025", label: "IMG" }
  if (ext === "pdf" || normalized.includes("pdf")) return { color: "#c5221f", label: "PDF" }
  return { color: "#5f6368", label: "FILE" }
}

function FolderIcon() {
  return (
    <span
      style={{
        ...fileIconStyle,
        position: "relative",
        borderRadius: "4px",
        background: "linear-gradient(180deg, #fbbc04 0%, #f6a800 100%)",
        boxShadow: "inset 0 -1px 0 rgba(92,55,0,0.2)",
      }}
    >
      <span
        style={{
          position: "absolute",
          left: "2px",
          top: "-4px",
          width: "11px",
          height: "6px",
          borderRadius: "3px 3px 0 0",
          background: "#fdd663",
        }}
      />
    </span>
  )
}

function DriveFileIcon({ color, label }: { color: string; label: string }) {
  return (
    <span
      style={{
        ...fileIconStyle,
        borderRadius: "3px",
        background: color,
        color: "#fff",
        fontSize: "6px",
        fontWeight: 900,
        letterSpacing: "0.02em",
        boxShadow: "inset 0 -1px 0 rgba(0,0,0,0.18)",
      }}
    >
      {label}
    </span>
  )
}

function formatTimestamp(value?: string | null) {
  if (!value) return ""
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ""
  return date.toLocaleString("en-HK", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })
}

function HoverableTextBlock({
  value,
  updates,
  fallbackUpdatedAt,
  minHeight,
  onDoubleClick,
  query,
}: {
  value: string
  updates: Record<string, string>
  fallbackUpdatedAt?: string | null
  minHeight: string
  onDoubleClick?: () => void
  query?: string
}) {
  const [hoveredLine, setHoveredLine] = useState<number | null>(null)
  const lines = (value || "").split("\n")
  const lineKeys = buildLineTimestampKeys(lines)
  const fallback = formatTimestamp(fallbackUpdatedAt)
  return (
    <div
      style={{
        minHeight,
        cursor: "default",
        whiteSpace: "pre-wrap",
        overflowWrap: "anywhere",
        wordBreak: "break-word",
        position: "relative",
        color: "#edf7ff",
        fontSize: "14px",
        lineHeight: 1.55,
        padding: "10px 12px",
        border: "1px solid rgba(143, 215, 255, 0.22)",
        borderRadius: "14px",
        background: hoveredLine !== null ? "rgba(185, 224, 255, 0.055)" : "rgba(255,255,255,0.018)",
        transition: "box-shadow 160ms ease, border-color 160ms ease, background 160ms ease",
      }}
      onMouseLeave={() => setHoveredLine(null)}
      onDoubleClick={onDoubleClick}
      title={onDoubleClick ? "Double click to edit" : undefined}
    >
      {hoveredLine !== null && (formatTimestamp(updates[lineKeys[hoveredLine]]) || formatTimestamp(updates[String(hoveredLine)]) || fallback) && (
        <div
          style={{
            position: "absolute",
            right: "12px",
            top: `${12 + hoveredLine * 22}px`,
            maxWidth: "220px",
            padding: "6px 9px",
            borderRadius: "8px",
            background: "rgba(7, 20, 35, 0.92)",
            border: "1px solid rgba(160, 210, 245, 0.18)",
            color: "#eaf7ff",
            fontSize: "10px",
            fontWeight: 700,
            boxShadow: "0 14px 30px rgba(0,0,0,0.22)",
            pointerEvents: "none",
            zIndex: 3,
          }}
        >
          {formatTimestamp(updates[lineKeys[hoveredLine]]) || formatTimestamp(updates[String(hoveredLine)]) || fallback}
        </div>
      )}
      {lines.map((line, index) => {
        const stamp = formatTimestamp(updates[lineKeys[index]]) || formatTimestamp(updates[String(index)]) || fallback
        return (
          <div
            key={`hover-line-${index}`}
            onMouseEnter={() => setHoveredLine(index)}
            style={{
              minHeight: "1.55em",
              cursor: stamp ? "default" : "default",
              overflowWrap: "anywhere",
              wordBreak: "break-word",
              borderRadius: "6px",
              padding: "0 2px",
              margin: "0 -2px",
              background: hoveredLine === index ? "rgba(185, 224, 255, 0.09)" : "transparent",
              boxShadow: hoveredLine === index ? "0 0 0 1px rgba(172, 218, 255, 0.12)" : "none",
              transition: "background 120ms ease, box-shadow 120ms ease",
            }}
          >
            {line ? <span dangerouslySetInnerHTML={{ __html: highlightTextHtml(line, query || "") }} /> : "\u00a0"}
          </div>
        )
      })}
    </div>
  )
}

function HighlightedInlineText({ value, query }: { value: string; query: string }) {
  if (!query.trim()) return <>{value}</>
  return <span dangerouslySetInnerHTML={{ __html: highlightTextHtml(value, query) }} />
}

function BlockTextBlock({
  blocks,
  fallbackUpdatedAt,
  minHeight,
  onDoubleClick,
  onBlockDoubleClick,
  editingBlockId,
  onBlockChange,
  onBlockSave,
  onBlockCancel,
  onBlockDelete,
  query,
}: {
  blocks: InfoBlock[]
  fallbackUpdatedAt?: string | null
  minHeight: string
  onDoubleClick?: () => void
  onBlockDoubleClick?: (block: InfoBlock) => void
  editingBlockId?: string
  onBlockChange?: (blockId: string, value: string) => void
  onBlockSave?: () => void
  onBlockCancel?: () => void
  onBlockDelete?: (blockId: string) => void
  query?: string
}) {
  const [hoveredBlockId, setHoveredBlockId] = useState("")
  return (
    <div
      style={{
        minHeight,
        cursor: "default",
        whiteSpace: "pre-wrap",
        overflowWrap: "anywhere",
        wordBreak: "break-word",
        position: "relative",
        color: "#edf7ff",
        fontSize: "14px",
        lineHeight: 1.55,
        padding: "10px 12px",
        border: "1px solid rgba(143, 215, 255, 0.22)",
        borderRadius: "14px",
        background: hoveredBlockId ? "rgba(185, 224, 255, 0.055)" : "rgba(255,255,255,0.018)",
      }}
      onMouseLeave={() => setHoveredBlockId("")}
      onDoubleClick={onDoubleClick}
      title={onDoubleClick ? "Double click to edit" : undefined}
    >
      {blocks.length === 0 ? <div style={{ minHeight: "1.55em" }}>&nbsp;</div> : null}
      {blocks.map((block) => {
        const stamp = formatTimestamp(block.updated_at) || formatTimestamp(fallbackUpdatedAt)
        return (
          <div
            key={block.id}
            onMouseEnter={() => setHoveredBlockId(block.id)}
            onDoubleClick={(event) => {
              if (!onBlockDoubleClick) return
              event.stopPropagation()
              onBlockDoubleClick(block)
            }}
            style={{
              minHeight: "1.55em",
              borderRadius: "6px",
              padding: "0 2px",
              margin: "0 -2px",
              position: "relative",
              background: hoveredBlockId === block.id ? "rgba(185, 224, 255, 0.09)" : "transparent",
              boxShadow: hoveredBlockId === block.id ? "0 0 0 1px rgba(172, 218, 255, 0.12)" : "none",
            }}
          >
            {editingBlockId === block.id ? (
              <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) auto", gap: "8px", alignItems: "start", padding: "4px 0" }}>
                <AutoSizeTextarea
                  value={block.content}
                  onChange={(event) => onBlockChange?.(block.id, event.target.value)}
                  style={{ ...textareaStyle, minHeight: "calc(1em + 28px)", padding: "7px 9px" }}
                />
                <div style={{ display: "grid", gap: "5px" }}>
                  <button type="button" onClick={onBlockSave} style={{ ...buttonStyle, padding: "4px 8px", fontSize: "10px", background: "linear-gradient(180deg, rgba(56, 214, 154, 0.34) 0%, rgba(20, 130, 93, 0.16) 100%)", color: "#ddffef" }}>Save</button>
                  <button type="button" onClick={onBlockCancel} style={{ ...buttonStyle, padding: "4px 8px", fontSize: "10px" }}>Cancel</button>
                  <button type="button" onClick={() => onBlockDelete?.(block.id)} style={{ ...buttonStyle, padding: "4px 8px", fontSize: "10px", background: "linear-gradient(180deg, rgba(230, 57, 70, 0.24) 0%, rgba(170, 47, 53, 0.12) 100%)", color: "#ffd6db" }}>x</button>
                </div>
              </div>
            ) : (
              <>
            {hoveredBlockId === block.id && stamp ? (
              <span style={{ position: "absolute", right: 0, top: "-26px", padding: "5px 8px", borderRadius: "8px", background: "rgba(7, 20, 35, 0.92)", color: "#eaf7ff", fontSize: "10px", fontWeight: 700, zIndex: 3 }}>
                {stamp}
              </span>
            ) : null}
            {block.content ? <HighlightedInlineText value={block.content} query={query || ""} /> : "\u00a0"}
              </>
            )}
          </div>
        )
      })}
    </div>
  )
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
    const computed = window.getComputedStyle(node)
    const fontSize = Number.parseFloat(computed.fontSize) || 14
    const lineHeight = Number.parseFloat(computed.lineHeight) || fontSize * 1.55
    node.style.height = "0px"
    node.style.height = `${node.scrollHeight + lineHeight}px`
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
  const [countryOptions, setCountryOptions] = useState<Array<{ id: string; name: string }>>([])
  const [countryDropdownOpen, setCountryDropdownOpen] = useState(false)
  const [highlights, setHighlights] = useState<HighlightCard[]>([])
  const [uploadingFile, setUploadingFile] = useState(false)
  const [selectedPreviewFile, setSelectedPreviewFile] = useState<EntryFileRecord | CompanyFileRecord | null>(null)
  const [previewModalOpen, setPreviewModalOpen] = useState(false)
  const [highlightModalOpen, setHighlightModalOpen] = useState(false)
  const [highlightDraft, setHighlightDraft] = useState<HighlightCard>({ title: "", info: "" })
  const [addPortModalOpen, setAddPortModalOpen] = useState(false)
  const [addPortDraft, setAddPortDraft] = useState({ name: "", notes: "" })
  const [editingCountryPortId, setEditingCountryPortId] = useState("")
  const [countryPortDraft, setCountryPortDraft] = useState({ name: "", notes: "" })
  const [sectionSaving, setSectionSaving] = useState(false)
  const [sectionSaveState, setSectionSaveState] = useState<"saving" | "saved">("saved")
  const [mainInfoLineUpdates, setMainInfoLineUpdates] = useState<Record<string, string>>({})
  const [mainInfoBlocks, setMainInfoBlocks] = useState<InfoBlock[]>([])
  const [mainInfoEditing, setMainInfoEditing] = useState(false)
  const [countryInfoEditing, setCountryInfoEditing] = useState(false)
  const [sectionEditing, setSectionEditing] = useState<Record<number, boolean>>({})
  const [activeInfoTab, setActiveInfoTab] = useState("general")
  const [draggingTabIndex, setDraggingTabIndex] = useState<number | null>(null)
  const [dropTabIndex, setDropTabIndex] = useState<number | null>(null)
  const [editingMainBlockId, setEditingMainBlockId] = useState("")
  const [editingSectionBlock, setEditingSectionBlock] = useState<{ sectionIndex: number; blockId: string } | null>(null)
  const [changeLog, setChangeLog] = useState<ChangeLogItem[]>([])
  const mainEditStartRef = useRef<{ notes: string; updates: Record<string, string>; blocks: InfoBlock[] } | null>(null)
  const sectionEditStartRef = useRef<Record<number, HighlightCard>>({})
  const sectionSaveTimerRef = useRef<number | null>(null)
  const recordAutoSaveTimerRef = useRef<number | null>(null)

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
    if (typeof window === "undefined") return
    try {
      const stored = window.localStorage.getItem(CHANGE_LOG_STORAGE_KEY)
      if (stored) setChangeLog(JSON.parse(stored).slice(0, 10))
    } catch {
      setChangeLog([])
    }
  }, [])

  useEffect(() => {
    if (typeof window === "undefined") return
    window.localStorage.setItem(CHANGE_LOG_STORAGE_KEY, JSON.stringify(changeLog.slice(0, 10)))
  }, [changeLog])

  useEffect(() => {
    if (adminLoading || !authenticated) return
    void loadCountryOptions()
  }, [adminLoading, authenticated])

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
  const highlightedSectionHtml = useMemo(
    () => highlights.map((section) => `${highlightTextHtml(section.title || "", searchInPage)} ${highlightTextHtml(section.info || "", searchInPage)}`).join(" "),
    [highlights, searchInPage],
  )
  const highlightedFileHtml = useMemo(
    () => [...files.map((file) => file.file_name), ...folders.map((folder) => folder.name)].map((name) => highlightTextHtml(name, searchInPage)).join(" "),
    [files, folders, searchInPage],
  )
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
    const sectionDoc = parser.parseFromString(`<div>${highlightedSectionHtml}</div>`, "text/html")
    const fileDoc = parser.parseFromString(`<div>${highlightedFileHtml}</div>`, "text/html")
    const mainMatches = Array.from(mainDoc.querySelectorAll('mark[data-search-match="true"]'))
    const countryMatches = selectedKind === "port" ? Array.from(countryDoc.querySelectorAll('mark[data-search-match="true"]')) : []
    const sectionMatches = Array.from(sectionDoc.querySelectorAll('mark[data-search-match="true"]'))
    const fileMatches = Array.from(fileDoc.querySelectorAll('mark[data-search-match="true"]'))
    setMatchCount(mainMatches.length + countryMatches.length + sectionMatches.length + fileMatches.length)
  }, [displayedInfoHtml, displayedCountryInfoHtml, highlightedSectionHtml, highlightedFileHtml, searchInPage, selectedKind])

  function goToPreviousMatch() {
    setMatchIndex((prev) => (matchCount ? (prev - 1 + matchCount) % matchCount : 0))
  }

  function goToNextMatch() {
    setMatchIndex((prev) => (matchCount ? (prev + 1) % matchCount : 0))
  }

  async function loadCountryOptions() {
    const { data } = await supabase.from("cc_countries").select("id,name").order("name", { ascending: true })
    setCountryOptions(((data as Array<{ id: string; name: string }>) || []).map((item) => ({ id: item.id, name: item.name.toUpperCase() })))
  }

  function addChangeLog(item: Omit<ChangeLogItem, "id" | "at">) {
    setChangeLog((prev) => [{ ...item, id: `${Date.now()}-${Math.random()}`, at: new Date().toISOString() }, ...prev].slice(0, 10))
  }

  function addSimpleChangeLog(label: string) {
    if (!selectedKind || !selectedId) return
    addChangeLog({
      label,
      entryKind: selectedKind,
      entryId: selectedId,
      field: "notes",
      before: currentRecord.notes || "",
      after: currentRecord.notes || "",
    })
  }

  async function undoChangeLogItem(entry: ChangeLogItem) {
    const table = entry.entryKind === "company" ? "cc_companies" : entry.entryKind === "country" ? "cc_countries" : "cc_ports"
    if (entry.field === "notes") {
      const { error } = await supabase.from(table).update({ notes: entry.before }).eq("id", entry.entryId)
      if (error) return setMessage("Unable to undo.")
      if (entry.entryId === selectedId) setCurrentRecord((prev) => ({ ...prev, notes: entry.before }))
    } else if (entry.sectionIndex !== undefined) {
      const next = [...highlights]
      if (entry.entryId === selectedId && next[entry.sectionIndex]) {
        next[entry.sectionIndex] = { ...next[entry.sectionIndex], info: entry.before }
        setHighlights(next)
        await persistHighlights(next)
      }
    }
    setMessage("Undo complete.")
  }

  async function finishMainInfoEditing() {
    if (!selectedId || !selectedKind) return
    const before = mainEditStartRef.current
    const nextNotes = blocksToText(mainInfoBlocks)
    setCurrentRecord((prev) => ({ ...prev, notes: nextNotes }))
    setMainInfoEditing(false)
    setCountryInfoEditing(false)
    setEditingMainBlockId("")
    if (before && (before.notes !== nextNotes || JSON.stringify(before.blocks) !== JSON.stringify(mainInfoBlocks))) {
      addChangeLog({
        label: `${changeLogSubject(selectedKind, currentRecord.name)} ${informationLabel} updated`,
        entryKind: selectedKind,
        entryId: selectedId,
        field: "notes",
        before: before.notes,
        after: nextNotes,
      })
    }
    mainEditStartRef.current = null
    await queueMainInfoAutoSaveNow(nextNotes, mainInfoLineUpdates, mainInfoBlocks)
  }

  async function saveMainInfoBlocks(nextBlocks: InfoBlock[]) {
    if (!selectedId || !selectedKind) return
    const nextNotes = blocksToText(nextBlocks)
    setMainInfoBlocks(nextBlocks)
    setCurrentRecord((prev) => ({ ...prev, notes: nextNotes }))
    await queueMainInfoAutoSaveNow(nextNotes, mainInfoLineUpdates, nextBlocks)
  }

  function startMainBlockEditing(block: InfoBlock) {
    const blocks = mainInfoBlocks.length ? mainInfoBlocks : textToBlocks(currentRecord.notes || "", mainInfoLineUpdates, currentRecord.updated_at)
    setMainInfoBlocks(blocks)
    mainEditStartRef.current = { notes: currentRecord.notes || "", updates: { ...mainInfoLineUpdates }, blocks: blocks.map((item) => ({ ...item })) }
    setEditingMainBlockId(block.id)
  }

  function cancelMainBlockEditing() {
    if (mainEditStartRef.current) {
      setMainInfoBlocks(mainEditStartRef.current.blocks.map((block) => ({ ...block })))
    }
    mainEditStartRef.current = null
    setEditingMainBlockId("")
  }

  function updateMainBlock(blockId: string, value: string) {
    const now = new Date().toISOString()
    setMainInfoBlocks((prev) => {
      const source = prev.length ? prev : textToBlocks(currentRecord.notes || "", mainInfoLineUpdates, currentRecord.updated_at)
      return source.map((block) => (block.id === blockId ? { ...block, content: value, updated_at: now } : block))
    })
  }

  async function deleteMainBlock(blockId: string) {
    const source = mainInfoBlocks.length ? mainInfoBlocks : textToBlocks(currentRecord.notes || "", mainInfoLineUpdates, currentRecord.updated_at)
    const nextBlocks = source.filter((block) => block.id !== blockId)
    setEditingMainBlockId("")
    mainEditStartRef.current = null
    await saveMainInfoBlocks(nextBlocks)
  }

  async function finishSectionEditing(index: number) {
    if (!selectedKind) return
    const before = sectionEditStartRef.current[index]
    setSectionEditing((prev) => ({ ...prev, [index]: false }))
    if (before) {
      const current = highlights[index]
      if (current && (before.info !== current.info || JSON.stringify(before.line_updates || {}) !== JSON.stringify(current.line_updates || {}))) {
        addChangeLog({
          label: `${changeLogSubject(selectedKind, currentRecord.name)} ${current.title || `Section ${index + 1}`} updated`,
          entryKind: selectedKind as RecordKind,
          entryId: selectedId,
          field: "section",
          before: before.info,
          after: current.info,
          sectionIndex: index,
          sectionTitle: current.title,
        })
      }
    }
    delete sectionEditStartRef.current[index]
    setEditingSectionBlock(null)
    await persistHighlights(highlights)
  }

  function startSectionBlockEditing(index: number, block: InfoBlock) {
    const highlight = highlights[index]
    if (!highlight) return
    const blocks = highlight.blocks?.length ? highlight.blocks : textToBlocks(highlight.info || "", highlight.line_updates || {}, currentRecord.updated_at)
    setHighlights((prev) => prev.map((item, itemIndex) => (itemIndex === index ? { ...item, blocks, info: blocksToText(blocks) } : item)))
    sectionEditStartRef.current[index] = { ...highlight, blocks: blocks.map((item) => ({ ...item })), info: blocksToText(blocks), line_updates: { ...(highlight.line_updates || {}) } }
    setEditingSectionBlock({ sectionIndex: index, blockId: block.id })
  }

  function updateSectionBlock(index: number, blockId: string, value: string) {
    const now = new Date().toISOString()
    setHighlights((prev) =>
      prev.map((item, itemIndex) => {
        if (itemIndex !== index) return item
        const sourceBlocks = item.blocks?.length ? item.blocks : textToBlocks(item.info || "", item.line_updates || {}, currentRecord.updated_at)
        const blocks = sourceBlocks.map((block) => (block.id === blockId ? { ...block, content: value, updated_at: now } : block))
        return { ...item, blocks, info: blocksToText(blocks) }
      }),
    )
  }

  function cancelSectionBlockEditing(index: number) {
    const before = sectionEditStartRef.current[index]
    if (before) {
      setHighlights((prev) => prev.map((item, itemIndex) => (itemIndex === index ? { ...before, blocks: before.blocks?.map((block) => ({ ...block })) } : item)))
    }
    delete sectionEditStartRef.current[index]
    setEditingSectionBlock(null)
  }

  async function deleteSectionBlock(index: number, blockId: string) {
    const nextHighlights = highlights.map((item, itemIndex) => {
      if (itemIndex !== index) return item
      const sourceBlocks = item.blocks?.length ? item.blocks : textToBlocks(item.info || "", item.line_updates || {}, currentRecord.updated_at)
      const blocks = sourceBlocks.filter((block) => block.id !== blockId)
      return { ...item, blocks, info: blocksToText(blocks) }
    })
    setHighlights(nextHighlights)
    setEditingSectionBlock(null)
    delete sectionEditStartRef.current[index]
    try {
      await persistHighlights(nextHighlights)
      setMessage("Section saved.")
    } catch {
      setMessage("Unable to save section.")
    }
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
    setMainInfoLineUpdates({})
    setMainInfoBlocks([])
    setMainInfoEditing(false)
    setCountryInfoEditing(false)
    setSectionEditing({})
    setEditingMainBlockId("")
    setEditingSectionBlock(null)
    setSelectedPreviewFile(null)
    setPreviewModalOpen(false)
    setSearchInPage("")
    setActiveInfoTab("general")
  }

  async function loadCompany(id: string) {
    const [{ data, error }, filesResult, manualFilesResult, foldersResult] = await Promise.all([
      supabase.from("cc_companies").select("id,name,summary,notes,updated_at").eq("id", id).single(),
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
    const summaryMeta = parseSummaryMeta((data as BaseRecord).summary)
    setHighlights(summaryMeta.sections)
    setMainInfoLineUpdates(summaryMeta.mainLineUpdates)
    setMainInfoBlocks(summaryMeta.mainBlocks.length ? summaryMeta.mainBlocks : textToBlocks((data as BaseRecord).notes || "", summaryMeta.mainLineUpdates, (data as BaseRecord).updated_at))
    setMainInfoEditing(false)
    setCountryInfoEditing(false)
    setSectionEditing({})
    setEditingMainBlockId("")
    setEditingSectionBlock(null)
    setSelectedPreviewFile(null)
    setPreviewModalOpen(false)
    setActiveInfoTab("general")
  }

  async function loadCountry(id: string) {
    const [{ data, error }, filesResult, foldersResult] = await Promise.all([
      supabase.from("cc_countries").select("id,name,summary,notes,region,updated_at").eq("id", id).single(),
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
    const summaryMeta = parseSummaryMeta((data as BaseRecord).summary)
    setHighlights(summaryMeta.sections)
    setMainInfoLineUpdates(summaryMeta.mainLineUpdates)
    setMainInfoBlocks(summaryMeta.mainBlocks.length ? summaryMeta.mainBlocks : textToBlocks((data as BaseRecord).notes || "", summaryMeta.mainLineUpdates, (data as BaseRecord).updated_at))
    setMainInfoEditing(false)
    setCountryInfoEditing(false)
    setSectionEditing({})
    setEditingMainBlockId("")
    setEditingSectionBlock(null)
    setSelectedPreviewFile(null)
    setPreviewModalOpen(false)
    setActiveInfoTab("general")
  }

  async function loadPort(id: string) {
    const [{ data, error }, filesResult, foldersResult] = await Promise.all([
      supabase.from("cc_ports").select("id,name,summary,notes,country_id,country_name,updated_at").eq("id", id).single(),
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
    const summaryMeta = parseSummaryMeta(port.summary)
    setHighlights(summaryMeta.sections)
    setMainInfoLineUpdates(summaryMeta.mainLineUpdates)
    setMainInfoBlocks(summaryMeta.mainBlocks.length ? summaryMeta.mainBlocks : textToBlocks(port.notes || "", summaryMeta.mainLineUpdates, port.updated_at))
    setMainInfoEditing(false)
    setCountryInfoEditing(false)
    setSectionEditing({})
    setEditingMainBlockId("")
    setEditingSectionBlock(null)
    setSelectedPreviewFile(null)
    setPreviewModalOpen(false)
    setActiveInfoTab("general")

    if (port.country_id) {
      const { data: countryData } = await supabase.from("cc_countries").select("id,name,summary,notes,region,updated_at").eq("id", port.country_id).single()
      setCurrentCountry((countryData as CountryRecord) || { id: "", name: port.country_name || "", summary: "", notes: "" })
    } else if (port.country_name?.trim()) {
      const { data: countryData } = await supabase
        .from("cc_countries")
        .select("id,name,summary,notes,region,updated_at")
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
      const { data, error } = await supabase.from("cc_companies").insert({ name: "NEW COMPANY", category: "company", summary: null, notes: "No info", contacts: null, tags: [], status: "active" }).select("id").single()
      if (error || !data) return setMessage("Unable to create company.")
      await loadSelected("company", data.id)
      addChangeLog({ label: "NEW COMPANY added", entryKind: "company", entryId: data.id, field: "notes", before: "", after: "No info" })
      return
    }
    if (kind === "country") {
      const { data, error } = await supabase.from("cc_countries").insert({ name: "NEW COUNTRY", summary: null, notes: "No info", tags: [], status: "active" }).select("id").single()
      if (error || !data) return setMessage("Unable to create country.")
      await loadSelected("country", data.id)
      addChangeLog({ label: "NEW COUNTRY added", entryKind: "country", entryId: data.id, field: "notes", before: "", after: "No info" })
      return
    }
    const { data, error } = await supabase.from("cc_ports").insert({ name: "NEW PORT", summary: null, notes: "No info", country_name: null, tags: [], status: "active" }).select("id").single()
    if (error || !data) return setMessage("Unable to create port.")
    await loadSelected("port", data.id)
    addChangeLog({ label: "NEW PORT added", entryKind: "port", entryId: data.id, field: "notes", before: "", after: "No info" })
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
      .insert({ name: addPortDraft.name.trim().toUpperCase(), summary: null, notes: addPortDraft.notes || "", country_id: selectedId, country_name: countryName.toUpperCase(), tags: [], status: "active" })
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
    addSimpleChangeLog(`${changeLogSubject("country", currentRecord.name)} New Port Added`)
    setMessage("Port added.")
  }

  function startCountryPortEditing(port: CountryPortListItem) {
    setEditingCountryPortId(port.id)
    setCountryPortDraft({ name: port.name || "", notes: port.notes || "" })
  }

  async function saveCountryPortEditing() {
    if (!editingCountryPortId) return
    const name = countryPortDraft.name.trim().toUpperCase()
    if (!name) {
      setMessage("Port name is required.")
      return
    }
    const { error } = await supabase
      .from("cc_ports")
      .update({ name, notes: countryPortDraft.notes || null })
      .eq("id", editingCountryPortId)
    if (error) {
      setMessage("Unable to save port.")
      return
    }
    setCurrentCountryPorts((prev) =>
      prev
        .map((port) => (port.id === editingCountryPortId ? { ...port, name, notes: countryPortDraft.notes || null } : port))
        .sort((a, b) => a.name.localeCompare(b.name)),
    )
    setEditingCountryPortId("")
    setCountryPortDraft({ name: "", notes: "" })
    addSimpleChangeLog(`${changeLogSubject("country", currentRecord.name)} Port Updated`)
    setMessage("Port saved.")
  }

  function renameHighlight(index: number) {
    const current = highlights[index]
    if (!current) return
    const nextTitle = prompt("Tab name", current.title || `SECTION ${index + 1}`)?.trim()
    if (!nextTitle) return
    const nextHighlights = highlights.map((item, itemIndex) => (itemIndex === index ? { ...item, title: normalizeSectionTitle(nextTitle) } : item))
    setHighlights(nextHighlights)
    void persistHighlights(nextHighlights)
  }

  async function saveRecord() {
    if (!selectedId || !selectedKind) return
    setSaving(true)
    setMessage("")
    try {
      if (selectedKind === "company") {
        const { error } = await supabase.from("cc_companies").update({ name: currentRecord.name.trim().toUpperCase(), summary: serializeSummaryMeta(highlights, mainInfoLineUpdates, mainInfoBlocks), notes: currentRecord.notes || null }).eq("id", selectedId)
        if (error) throw error
      }
      if (selectedKind === "country") {
        const { error } = await supabase.from("cc_countries").update({ name: currentRecord.name.trim().toUpperCase(), summary: serializeSummaryMeta(highlights, mainInfoLineUpdates, mainInfoBlocks), notes: currentRecord.notes || null }).eq("id", selectedId)
        if (error) throw error
      }
      if (selectedKind === "port") {
        const matchedCountry = countryOptions.find((country) => country.name.toUpperCase() === currentCountry.name.trim().toUpperCase())
        if (!matchedCountry && currentCountry.name.trim()) {
          setMessage("Please select an existing country.")
          return
        }
        const { error } = await supabase.from("cc_ports").update({
          name: currentRecord.name.trim().toUpperCase(),
          summary: serializeSummaryMeta(highlights, mainInfoLineUpdates, mainInfoBlocks),
          notes: currentRecord.notes || null,
          country_id: matchedCountry?.id || null,
          country_name: matchedCountry?.name || null,
        }).eq("id", selectedId)
        if (error) throw error

        if (matchedCountry?.id) {
          const { error: countryError } = await supabase.from("cc_countries").update({
            name: matchedCountry.name,
            summary: currentCountry.summary || null,
            notes: currentCountry.notes || null,
          }).eq("id", matchedCountry.id)
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
    if (event.key === "Escape") {
      event.preventDefault()
      setQuery("")
      setSuggestions([])
      return
    }
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
    if (event.key === "Escape") {
      event.preventDefault()
      setSearchInPage("")
      return
    }
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
    const payload = { summary: serializeSummaryMeta(nextHighlights, mainInfoLineUpdates, mainInfoBlocks) }
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
    const firstBlock = { id: newBlockId(), content: "", updated_at: new Date().toISOString() }
    const nextHighlights = [...highlights, { title: normalizeSectionTitle(highlightDraft.title), info: "", blocks: [firstBlock] }]
    setHighlights(nextHighlights)
    setActiveInfoTab(`section-${nextHighlights.length - 1}`)
    setEditingSectionBlock({ sectionIndex: nextHighlights.length - 1, blockId: firstBlock.id })
    setHighlightDraft({ title: "", info: "" })
    setHighlightModalOpen(false)
    try {
      await persistHighlights(nextHighlights)
      if (selectedKind) addSimpleChangeLog(`${changeLogSubject(selectedKind, currentRecord.name)} New Section Added`)
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
    setSectionSaveState("saving")
    sectionSaveTimerRef.current = window.setTimeout(async () => {
      try {
        await persistHighlights(nextHighlights)
        setSectionSaveState("saved")
      } catch {
        setMessage("Unable to auto-save section.")
        setSectionSaveState("saved")
      } finally {
        setSectionSaving(false)
        if (sectionSaveTimerRef.current) window.clearTimeout(sectionSaveTimerRef.current)
        sectionSaveTimerRef.current = window.setTimeout(() => setSectionSaveState("saved"), 1200)
      }
    }, 450)
  }

  function queueMainInfoAutoSave(nextNotes: string, nextLineUpdates: Record<string, string>, nextBlocks = mainInfoBlocks) {
    if (!selectedId || !selectedKind) return
    if (recordAutoSaveTimerRef.current) {
      window.clearTimeout(recordAutoSaveTimerRef.current)
    }
    setSectionSaveState("saving")
    setSectionSaving(true)
    recordAutoSaveTimerRef.current = window.setTimeout(async () => {
      try {
        const table = selectedKind === "company" ? "cc_companies" : selectedKind === "country" ? "cc_countries" : "cc_ports"
        const { error } = await supabase.from(table).update({ notes: nextNotes, summary: serializeSummaryMeta(highlights, nextLineUpdates, nextBlocks) }).eq("id", selectedId)
        if (error) throw error
        setSectionSaveState("saved")
      } catch {
        setMessage("Unable to auto-save information.")
        setSectionSaveState("saved")
      } finally {
        setSectionSaving(false)
        if (recordAutoSaveTimerRef.current) window.clearTimeout(recordAutoSaveTimerRef.current)
        recordAutoSaveTimerRef.current = window.setTimeout(() => setSectionSaveState("saved"), 1200)
      }
    }, 450)
  }

  async function queueMainInfoAutoSaveNow(nextNotes: string, nextLineUpdates: Record<string, string>, nextBlocks = mainInfoBlocks) {
    if (!selectedId || !selectedKind) return
    setSectionSaveState("saving")
    setSectionSaving(true)
    try {
      const table = selectedKind === "company" ? "cc_companies" : selectedKind === "country" ? "cc_countries" : "cc_ports"
      const { error } = await supabase.from(table).update({ notes: nextNotes, summary: serializeSummaryMeta(highlights, nextLineUpdates, nextBlocks) }).eq("id", selectedId)
      if (error) throw error
      setSectionSaveState("saved")
    } catch {
      setMessage("Unable to save information.")
      setSectionSaveState("saved")
    } finally {
      setSectionSaving(false)
    }
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
    setSectionEditing({})
    try {
      await persistHighlights(nextHighlights)
      setMessage("Section order updated.")
    } catch {
      setMessage("Unable to reorder sections.")
    }
  }

  async function moveHighlightToIndex(index: number, targetIndex: number) {
    if (index === targetIndex || targetIndex < 0 || targetIndex >= highlights.length) return
    const nextHighlights = [...highlights]
    const [moved] = nextHighlights.splice(index, 1)
    nextHighlights.splice(targetIndex, 0, moved)
    setHighlights(nextHighlights)
    setSectionEditing({})
    setActiveInfoTab(`section-${targetIndex}`)
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
      addSimpleChangeLog(`${changeLogSubject(selectedKind, currentRecord.name)} File Uploaded`)
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
                gridTemplateColumns: isMobile ? "32px minmax(0,1fr)" : "42px minmax(0,1fr)",
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
                <FolderIcon />
                <span style={{ fontSize: "11px", lineHeight: 1.35, overflowWrap: "anywhere" }}>
                  <HighlightedInlineText value={folder.name} query={searchInPage} />
                </span>
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
                  gridTemplateColumns: isMobile ? "32px minmax(0,1fr)" : "42px minmax(0,1fr) auto",
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
                <DriveFileIcon color={fileTypeVisual.color} label={fileTypeVisual.label} />
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
                  <HighlightedInlineText value={file.file_name} query={searchInPage} />
                </button>
                {!isMobile && (
                  <button
                    type="button"
                    onClick={() => void deleteFile(file)}
                    style={{ ...buttonStyle, padding: "4px 7px", fontSize: "10px", background: "linear-gradient(180deg, rgba(230, 57, 70, 0.24) 0%, rgba(170, 47, 53, 0.12) 100%)", color: "#ffd6db", border: "1px solid rgba(255, 120, 120, 0.22)" }}
                  >
                    Delete
                  </button>
                )}
                {isMobile && (
                  <button
                    type="button"
                    onClick={() => void deleteFile(file)}
                    style={{ ...buttonStyle, gridColumn: "2", justifySelf: "start", padding: "4px 7px", fontSize: "10px", background: "linear-gradient(180deg, rgba(230, 57, 70, 0.24) 0%, rgba(170, 47, 53, 0.12) 100%)", color: "#ffd6db", border: "1px solid rgba(255, 120, 120, 0.22)" }}
                  >
                    Delete
                  </button>
                )}
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
  const filteredCountryOptions = countryOptions
    .filter((country) => country.name.includes(currentCountry.name.trim().toUpperCase()))
    .slice(0, 12)

  return (
    <div style={pageShellStyle}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: isMobile ? "minmax(0, 1fr)" : "260px minmax(0, 1fr) 320px",
          height: isMobile ? "auto" : "100vh",
          minHeight: "100vh",
          overflow: isMobile ? "visible" : "hidden",
          maxWidth: "100vw",
        }}
      >
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
                  <input value={searchInPage} onChange={(e) => setSearchInPage(e.target.value)} onKeyDown={handleSearchInPageKeyDown} disabled={initialMode} placeholder={initialMode ? "Open an entry first" : ""} style={{ ...inputStyle, opacity: initialMode ? 0.58 : 1 }} />
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
                  <div style={{ display: "grid", gap: "6px", borderTop: "1px solid rgba(210,236,255,0.1)", paddingTop: "8px" }}>
                      <div style={{ fontSize: "10px", letterSpacing: "0.12em", textTransform: "uppercase", color: "#8fd7ff", fontWeight: 800 }}>Recent Changes</div>
                      {changeLog.length === 0 && <div style={{ color: "#91badb", fontSize: "11px" }}>No recent changes yet.</div>}
                      {changeLog.map((entry) => (
                        <div key={entry.id} style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) auto", gap: "8px", alignItems: "center", padding: "6px 7px", borderRadius: "10px", background: "rgba(255,255,255,0.04)" }}>
                          <div style={{ minWidth: 0 }}>
                            <div style={{ color: "#eaf7ff", fontSize: "11px", fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{entry.label}</div>
                            <div style={{ color: "#91badb", fontSize: "10px", marginTop: "2px" }}>{formatTimestamp(entry.at)}</div>
                          </div>
                        </div>
                      ))}
                  </div>
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
                      <a href="/admin/ccinfo/companies" style={{ ...buttonStyle, textAlign: "left", display: "block" }}>Company Index</a>
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

        <main style={{ padding: isMobile ? "12px" : "0 22px 22px", height: isMobile ? "auto" : "100vh", overflowY: isMobile ? "visible" : "auto", minWidth: 0, maxWidth: "100vw", boxSizing: "border-box", scrollbarWidth: "thin", scrollbarColor: "rgba(175,205,230,0.35) transparent" }}>
          <div style={{ display: "grid", gap: "14px", minWidth: 0 }}>
            <div style={{ ...panelStyle, padding: isMobile ? "10px" : "14px", position: "sticky", top: 0, zIndex: 10, minWidth: 0, borderTopLeftRadius: isMobile ? "18px" : 0, borderTopRightRadius: isMobile ? "18px" : 0 }}>
              <div style={{ display: "grid", gridTemplateColumns: isMobile ? "minmax(0,1fr) 42px" : "1fr", gap: "8px", alignItems: "center" }}>
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
                {isMobile && (
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
                )}
              </div>
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

            <div style={{ ...panelStyle, padding: isMobile ? "12px" : "16px", display: "grid", gap: "12px", minWidth: 0 }}>
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
                      {menuOpen && (
                        <div style={{ ...panelStyle, padding: "8px", display: "grid", gap: "6px", marginBottom: "10px" }}>
                          <button onClick={() => void createNew("country")} style={{ ...buttonStyle, textAlign: "left" }}>New Country</button>
                          <button onClick={() => void createNew("port")} style={{ ...buttonStyle, textAlign: "left" }}>New Port</button>
                          <button onClick={() => void createNew("company")} style={{ ...buttonStyle, textAlign: "left" }}>New Company</button>
                          <a href="/admin/ccinfo/countries" style={{ ...buttonStyle, textAlign: "left", display: "block" }}>Country Index</a>
                          <a href="/admin/ccinfo/ports" style={{ ...buttonStyle, textAlign: "left", display: "block" }}>Port Index</a>
                          <a href="/admin/ccinfo/companies" style={{ ...buttonStyle, textAlign: "left", display: "block" }}>Company Index</a>
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
                      <input value={currentRecord.name} onChange={(e) => setCurrentRecord((prev) => ({ ...prev, name: e.target.value.toUpperCase() }))} style={inputStyle} />
                    </div>
                    <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", justifyContent: isMobile ? "flex-start" : "flex-end" }}>
                      <button onClick={saveRecord} disabled={saving || sectionSaving || !selectedId} style={{ ...buttonStyle, minWidth: "96px", background: "linear-gradient(180deg, rgba(56, 214, 154, 0.34) 0%, rgba(20, 130, 93, 0.16) 100%)", color: "#ddffef", border: "1px solid rgba(73, 219, 165, 0.26)" }}>
                        {saving || sectionSaveState === "saving" ? "Saving" : "Saved"}
                      </button>
                      <button onClick={deleteRecord} disabled={!selectedId} style={{ ...buttonStyle, background: "linear-gradient(180deg, rgba(230, 57, 70, 0.24) 0%, rgba(170, 47, 53, 0.12) 100%)", color: "#ffd6db", border: "1px solid rgba(255, 120, 120, 0.22)" }}>Delete</button>
                    </div>
                  </div>

                  {selectedKind === "port" && (
                    <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "220px minmax(0, 1fr)", gap: "10px", alignItems: "end" }}>
                      <div style={{ position: "relative" }}>
                        <div style={{ fontSize: "12px", letterSpacing: "0.12em", textTransform: "uppercase", color: "#8fd7ff", fontWeight: 700, marginBottom: "6px" }}>Country</div>
                        <input
                          value={currentCountry.name}
                          onFocus={() => setCountryDropdownOpen(true)}
                          onChange={(e) => {
                            const nextName = e.target.value.toUpperCase()
                            const matched = countryOptions.find((country) => country.name === nextName)
                            setCurrentCountry((prev) => ({ ...prev, id: matched?.id || "", name: nextName }))
                            setCountryDropdownOpen(true)
                          }}
                          onBlur={() => {
                            window.setTimeout(() => setCountryDropdownOpen(false), 160)
                            const matched = countryOptions.find((country) => country.name === currentCountry.name.trim().toUpperCase())
                            if (matched) setCurrentCountry((prev) => ({ ...prev, id: matched.id, name: matched.name }))
                            else if (currentCountry.name.trim()) setMessage("Please select an existing country.")
                          }}
                          style={inputStyle}
                        />
                        {countryDropdownOpen && (
                          <div style={{ ...panelStyle, position: "absolute", top: "calc(100% + 6px)", left: 0, right: 0, zIndex: 30, padding: "6px", display: "grid", gap: "4px", maxHeight: "260px", overflowY: "auto" }}>
                            {filteredCountryOptions.length === 0 ? (
                              <div style={{ padding: "8px", color: "#91badb", fontSize: "12px" }}>No matching country</div>
                            ) : (
                              filteredCountryOptions.map((country) => (
                                <button
                                  type="button"
                                  key={country.id}
                                  onMouseDown={(event) => event.preventDefault()}
                                  onClick={() => {
                                    setCurrentCountry((prev) => ({ ...prev, id: country.id, name: country.name }))
                                    setCountryDropdownOpen(false)
                                  }}
                                  style={{ ...buttonStyle, borderRadius: "10px", padding: "7px 9px", textAlign: "left", background: country.id === currentCountry.id ? "linear-gradient(180deg, rgba(56, 214, 154, 0.24) 0%, rgba(20, 130, 93, 0.12) 100%)" : "rgba(255,255,255,0.04)" }}
                                >
                                  {country.name}
                                </button>
                              ))
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  <div style={{ display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap", borderBottom: "1px solid rgba(210,236,255,0.12)", paddingBottom: "8px" }}>
                    <button type="button" onClick={() => setActiveInfoTab("general")} style={{ ...buttonStyle, borderRadius: "12px 12px 0 0", background: activeInfoTab === "general" ? "linear-gradient(180deg, rgba(86, 164, 255, 0.38) 0%, rgba(32, 106, 194, 0.2) 100%)" : "rgba(255,255,255,0.05)" }}>
                      GENERAL
                    </button>
                    {selectedKind === "country" && (
                      <button type="button" onClick={() => setActiveInfoTab("ports")} style={{ ...buttonStyle, borderRadius: "12px 12px 0 0", background: activeInfoTab === "ports" ? "linear-gradient(180deg, rgba(86, 164, 255, 0.38) 0%, rgba(32, 106, 194, 0.2) 100%)" : "rgba(255,255,255,0.05)" }}>
                        PORTS
                      </button>
                    )}
                    {highlights.map((highlight, index) => (
                      <button
                        key={`tab-${index}`}
                        type="button"
                        draggable
                        onDragStart={() => setDraggingTabIndex(index)}
                        onDragEnd={() => {
                          setDraggingTabIndex(null)
                          setDropTabIndex(null)
                        }}
                        onDragOver={(event) => {
                          event.preventDefault()
                          setDropTabIndex(index)
                        }}
                        onDragLeave={() => setDropTabIndex(null)}
                        onDrop={() => {
                          if (draggingTabIndex !== null) void moveHighlightToIndex(draggingTabIndex, index)
                          setDraggingTabIndex(null)
                          setDropTabIndex(null)
                        }}
                        onClick={() => setActiveInfoTab(`section-${index}`)}
                        onDoubleClick={(event) => {
                          event.stopPropagation()
                          renameHighlight(index)
                        }}
                        style={{
                          ...buttonStyle,
                          borderRadius: "12px 12px 0 0",
                          background: activeInfoTab === `section-${index}` ? "linear-gradient(180deg, rgba(86, 164, 255, 0.38) 0%, rgba(32, 106, 194, 0.2) 100%)" : "rgba(255,255,255,0.05)",
                          boxShadow: dropTabIndex === index ? "0 0 0 2px rgba(255, 224, 138, 0.75), inset 0 -3px 0 #ffe08a" : buttonStyle.boxShadow,
                          transform: draggingTabIndex === index ? "translateY(2px) scale(0.98)" : dropTabIndex === index ? "translateY(-2px)" : "none",
                          opacity: draggingTabIndex === index ? 0.62 : 1,
                          transition: "transform 120ms ease, box-shadow 120ms ease, opacity 120ms ease",
                        }}
                      >
                        {(highlight.title || `Section ${index + 1}`).toUpperCase()}
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={() => {
                        setHighlightDraft({ title: "", info: "" })
                        setHighlightModalOpen(true)
                      }}
                      disabled={!selectedId}
                      style={{ ...buttonStyle, borderRadius: "12px 12px 0 0", padding: "6px 12px", background: "rgba(255,255,255,0.05)", color: "#fff2bc", border: "1px solid rgba(210,236,255,0.16)" }}
                    >
                      +
                    </button>
                  </div>

                  {activeInfoTab === "general" && (
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "6px", flexWrap: "wrap" }}>
                      <div style={{ fontSize: "12px", letterSpacing: "0.12em", textTransform: "uppercase", color: "#8fd7ff", fontWeight: 700 }}>{informationLabel}</div>
                    </div>
                    {recordLoading && <div style={{ color: "#9ebad1", marginBottom: "8px" }}>Loading...</div>}
                    <BlockTextBlock
                      blocks={mainInfoBlocks.length ? mainInfoBlocks : textToBlocks(currentRecord.notes || "", mainInfoLineUpdates, currentRecord.updated_at)}
                      fallbackUpdatedAt={currentRecord.updated_at}
                      minHeight="calc(1em + 28px)"
                      query={searchInPage}
                      editingBlockId={editingMainBlockId}
                      onBlockDoubleClick={startMainBlockEditing}
                      onBlockChange={updateMainBlock}
                      onBlockSave={() => void finishMainInfoEditing()}
                      onBlockCancel={cancelMainBlockEditing}
                      onBlockDelete={(blockId) => void deleteMainBlock(blockId)}
                    />
                  </div>
                  )}

                  {activeInfoTab.startsWith("section-") && highlights.length > 0 && (
                    <div style={{ display: "grid", gap: "12px" }}>
                      {highlights.map((highlight, index) => activeInfoTab === `section-${index}` ? (
                        <div key={`section-${index}`}>
                          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px", marginBottom: "6px" }}>
                            <button
                              type="button"
                              onDoubleClick={(event) => {
                                event.stopPropagation()
                                renameHighlight(index)
                              }}
                              style={{ border: "none", background: "transparent", padding: 0, fontSize: "11px", letterSpacing: "0.1em", textTransform: "uppercase", color: "#7ec4f1", fontWeight: 700, cursor: "text", textAlign: "left" }}
                              title="Double click to rename section"
                            >
                              <HighlightedInlineText value={highlight.title || `SECTION ${index + 1}`} query={searchInPage} />
                            </button>
                            <div style={{ display: "flex", gap: "6px" }}>
                              <button onClick={() => void moveHighlight(index, -1)} style={{ ...buttonStyle, padding: "3px 8px", fontSize: "10px" }}>↑</button>
                              <button onClick={() => void moveHighlight(index, 1)} style={{ ...buttonStyle, padding: "3px 8px", fontSize: "10px" }}>↓</button>
                              <button onClick={() => void deleteHighlightCard(index)} style={{ ...buttonStyle, padding: "3px 8px", fontSize: "10px" }}>x</button>
                            </div>
                          </div>
                          <BlockTextBlock
                            blocks={highlight.blocks?.length ? highlight.blocks : textToBlocks(highlight.info || "", highlight.line_updates || {}, currentRecord.updated_at)}
                            fallbackUpdatedAt={currentRecord.updated_at}
                            minHeight="calc(1em + 28px)"
                            query={searchInPage}
                            editingBlockId={editingSectionBlock?.sectionIndex === index ? editingSectionBlock.blockId : ""}
                            onBlockDoubleClick={(block) => startSectionBlockEditing(index, block)}
                            onBlockChange={(blockId, value) => updateSectionBlock(index, blockId, value)}
                            onBlockSave={() => void finishSectionEditing(index)}
                            onBlockCancel={() => cancelSectionBlockEditing(index)}
                            onBlockDelete={(blockId) => void deleteSectionBlock(index, blockId)}
                          />
                        </div>
                      ) : null)}
                    </div>
                  )}

                  {selectedKind === "port" && (
                    <div>
                      <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "6px" }}>
                        <div style={{ fontSize: "12px", letterSpacing: "0.12em", textTransform: "uppercase", color: "#8fd7ff", fontWeight: 700 }}>{countryInformationLabel}</div>
                        {countryInfoEditing && (
                          <button
                            type="button"
                            onClick={() => {
                              setCountryInfoEditing(false)
                              void saveRecord()
                            }}
                            style={{ ...buttonStyle, marginLeft: "auto", padding: "4px 10px", fontSize: "11px", background: "linear-gradient(180deg, rgba(56, 214, 154, 0.34) 0%, rgba(20, 130, 93, 0.16) 100%)", color: "#ddffef" }}
                          >
                            Finish Editing
                          </button>
                        )}
                      </div>
                      {countryInfoEditing ? (
                        <AutoSizeTextarea
                          value={currentCountry.notes || ""}
                          onChange={(event) => setCurrentCountry((prev) => ({ ...prev, notes: event.target.value }))}
                          style={{ ...textareaStyle, minHeight: "calc(1em + 28px)" }}
                        />
                      ) : (
                        <HoverableTextBlock
                          value={currentCountry.notes || ""}
                          updates={{}}
                          fallbackUpdatedAt={currentCountry.updated_at}
                          minHeight="calc(1em + 28px)"
                          query={searchInPage}
                          onDoubleClick={() => setCountryInfoEditing(true)}
                        />
                      )}
                    </div>
                  )}

                  {selectedKind === "country" && activeInfoTab === "ports" && (
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
                        ) : isMobile ? (
                          <div style={{ display: "grid", gap: "8px", padding: "10px" }}>
                            {currentCountryPorts.map((port) => (
                              <div key={port.id} onDoubleClick={() => startCountryPortEditing(port)} style={{ borderBottom: "1px solid rgba(210,236,255,0.08)", paddingBottom: "10px", display: "grid", gap: "6px" }}>
                                {editingCountryPortId === port.id ? (
                                  <>
                                    <input value={countryPortDraft.name} onChange={(event) => setCountryPortDraft((prev) => ({ ...prev, name: event.target.value.toUpperCase() }))} style={inputStyle} />
                                    <AutoSizeTextarea value={countryPortDraft.notes} onChange={(event) => setCountryPortDraft((prev) => ({ ...prev, notes: event.target.value }))} style={{ ...textareaStyle, minHeight: "calc(1em + 28px)" }} />
                                    <div style={{ display: "flex", gap: "8px" }}>
                                      <button type="button" onClick={() => void saveCountryPortEditing()} style={{ ...buttonStyle, padding: "5px 10px", fontSize: "11px", background: "linear-gradient(180deg, rgba(56, 214, 154, 0.34) 0%, rgba(20, 130, 93, 0.16) 100%)", color: "#ddffef" }}>Finish Editing</button>
                                      <button type="button" onClick={() => setEditingCountryPortId("")} style={{ ...buttonStyle, padding: "5px 10px", fontSize: "11px" }}>Cancel</button>
                                    </div>
                                  </>
                                ) : (
                                  <>
                                    <div style={{ color: "#bfe6ff", fontWeight: 800, fontSize: "12px" }}>
                                      <HighlightedInlineText value={port.name} query={searchInPage} />
                                    </div>
                                    <div style={{ color: "#e8f2fb", fontSize: "12px", lineHeight: 1.45, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                                      <HighlightedInlineText value={port.notes || "No information yet"} query={searchInPage} />
                                    </div>
                                  </>
                                )}
                              </div>
                            ))}
                          </div>
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
                                  <tr key={port.id} onDoubleClick={() => startCountryPortEditing(port)} style={{ cursor: "text" }}>
                                    <td style={{ verticalAlign: "top", padding: "10px 12px", borderBottom: "1px solid rgba(210,236,255,0.08)", color: "#e8f2fb", lineHeight: 1.45, whiteSpace: "nowrap", fontWeight: 700 }}>
                                      {editingCountryPortId === port.id ? (
                                        <input value={countryPortDraft.name} onChange={(event) => setCountryPortDraft((prev) => ({ ...prev, name: event.target.value.toUpperCase() }))} style={{ ...inputStyle, padding: "7px 9px", fontSize: "12px" }} />
                                      ) : (
                                        <span style={{ color: "#bfe6ff", fontWeight: 700 }}>
                                        <HighlightedInlineText value={port.name} query={searchInPage} />
                                        </span>
                                      )}
                                    </td>
                                    <td style={{ verticalAlign: "top", padding: "10px 12px", borderBottom: "1px solid rgba(210,236,255,0.08)", color: "#e8f2fb", lineHeight: 1.45, whiteSpace: "pre-wrap" }}>
                                      {editingCountryPortId === port.id ? (
                                        <div style={{ display: "grid", gap: "8px" }}>
                                          <AutoSizeTextarea value={countryPortDraft.notes} onChange={(event) => setCountryPortDraft((prev) => ({ ...prev, notes: event.target.value }))} style={{ ...textareaStyle, minHeight: "calc(1em + 28px)", padding: "7px 9px", fontSize: "12px" }} />
                                          <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
                                            <button type="button" onClick={() => void saveCountryPortEditing()} style={{ ...buttonStyle, padding: "4px 9px", fontSize: "10px", background: "linear-gradient(180deg, rgba(56, 214, 154, 0.34) 0%, rgba(20, 130, 93, 0.16) 100%)", color: "#ddffef" }}>Finish Editing</button>
                                            <button type="button" onClick={() => setEditingCountryPortId("")} style={{ ...buttonStyle, padding: "4px 9px", fontSize: "10px" }}>Cancel</button>
                                          </div>
                                        </div>
                                      ) : (
                                        <HighlightedInlineText value={port.notes || "No information yet"} query={searchInPage} />
                                      )}
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

                  <button
                    type="button"
                    onClick={() => {
                      setHighlightDraft({ title: "", info: "" })
                      setHighlightModalOpen(true)
                    }}
                    disabled={!selectedId}
                    style={{ ...buttonStyle, justifySelf: "start", padding: "6px 12px", fontSize: "11px", background: "linear-gradient(180deg, rgba(255, 210, 86, 0.42) 0%, rgba(191, 136, 16, 0.2) 100%)", color: "#fff2bc", border: "1px solid rgba(255, 211, 110, 0.34)" }}
                  >
                    Add Section
                  </button>

                  {isMobile && fileSection}

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
