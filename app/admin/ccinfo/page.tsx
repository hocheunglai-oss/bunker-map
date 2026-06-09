"use client"

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { supabase } from "@/lib/supabase"
import { useSimpleAdminAuth } from "@/lib/useSimpleAdminAuth"
import { useIsMobile } from "@/lib/useIsMobile"
import { getAuditChangeSummary, getAuditSubject, isCcinfoAuditLog } from "@/lib/auditDisplay"

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
  original_path?: string | null
  deleted_at?: string | null
  source?: "company" | "entry"
}

type EntryFileRecord = {
  id: string
  file_name: string
  file_type: string | null
  drive_url: string | null
  drive_file_id?: string | null
  folder_path?: string | null
  deleted_at?: string | null
  source?: "entry"
}

type EntryFolderRecord = {
  id: string
  folder_path: string
  name: string
}

type FilePanelEditTarget =
  | { type: "file"; item: CompanyFileRecord | EntryFileRecord }
  | { type: "folder"; item: EntryFolderRecord }

type CcinfoActivityItem =
  | { type: "audit"; id: string; occurredAt: string; subject: string; summary: string; actorName: string | null; undone: boolean; canUndo: boolean; log: AuditLogRecord }
  | { type: "deleted-file"; id: string; occurredAt: string; subject: string; summary: string; actorName: string | null; undone: false; canUndo: true; file: CompanyFileRecord | EntryFileRecord }

type AuditOperation = "INSERT" | "UPDATE" | "DELETE"

type AuditLogRecord = {
  id: string
  occurredAt: string
  actorId: string | null
  actorName: string | null
  actorSource: string
  tableSchema: string
  tableName: string
  operation: AuditOperation
  recordPk: Record<string, unknown>
  changedFields: string[]
  beforeRow: Record<string, unknown> | null
  afterRow: Record<string, unknown> | null
  requestContext: Record<string, unknown>
  undoOfLogId: string | null
  undoneAt: string | null
  undoneByLogId: string | null
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

const pageShellStyle: React.CSSProperties = {
  minHeight: "100vh",
  background: "var(--fc-admin-page-bg)",
  fontFamily: "var(--fc-admin-font)",
  color: "var(--fc-admin-panel-text)",
}

const sidebarStyle: React.CSSProperties = {
  width: "280px",
  padding: "18px",
  borderRight: "1px solid var(--fc-admin-border-soft)",
  background: "var(--fc-admin-panel-soft-bg)",
}

const panelStyle: React.CSSProperties = {
  background: "var(--fc-admin-panel-bg)",
  border: "1px solid var(--fc-admin-border)",
  borderRadius: "18px",
  boxShadow: "0 12px 28px #00000010",
}

const buttonStyle: React.CSSProperties = {
  padding: "9px 12px",
  borderRadius: "999px",
  border: "1px solid var(--fc-admin-button-border)",
  background: "var(--fc-admin-button-bg)",
  color: "var(--fc-admin-button-text)",
  textDecoration: "none",
  fontSize: "12px",
  fontWeight: 700,
  boxShadow: "none",
  cursor: "pointer",
}

const menuButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  width: "54px",
  height: "36px",
  padding: 0,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  borderRadius: "999px",
  background: "var(--fc-admin-selected-bg)",
  color: "var(--fc-admin-panel-text)",
  border: "1px solid var(--fc-admin-selected-border)",
  lineHeight: 1,
}

function MenuGlyph() {
  return (
    <span aria-hidden="true" style={{ display: "grid", gap: "3px", width: "18px" }}>
      {[0, 1, 2].map((index) => (
        <span key={index} style={{ display: "block", height: "2px", borderRadius: "999px", background: "currentColor" }} />
      ))}
    </span>
  )
}

const searchInputStyle: React.CSSProperties = {
  width: "100%",
  padding: "16px 18px",
  borderRadius: "18px",
  border: "1px solid var(--fc-input-border)",
  background: "var(--fc-tool-input-bg)",
  color: "var(--fc-tool-input-text)",
  fontSize: "16px",
  outline: "none",
  boxSizing: "border-box",
  boxShadow: "none",
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "12px 14px",
  borderRadius: "14px",
  border: "1px solid var(--fc-input-border)",
  background: "var(--fc-tool-input-bg)",
  color: "var(--fc-tool-input-text)",
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
  lineHeight: 1.35,
  fontFamily: "var(--fc-admin-font)",
}

const compactFileBadgeStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  minWidth: "36px",
  height: "20px",
  borderRadius: "999px",
  background: "var(--fc-admin-button-bg)",
  border: "1px solid var(--fc-admin-button-border)",
  color: "var(--fc-admin-muted)",
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
      `<mark data-search-match="true" style="background: rgba(255, 243, 176, 0.55); color: inherit; padding: 0 1px; border-radius: 3px;">$1</mark>`,
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
  sections?: HighlightCard[]
  table?: string[][]
  column_widths?: number[]
  table_row_updates?: string[]
}

type SummaryMeta = {
  sections: HighlightCard[]
  mainLineUpdates: Record<string, string>
  mainBlocks: InfoBlock[]
  mainSections: HighlightCard[]
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

function compactBlocks(blocks: InfoBlock[], fallbackText: string | null | undefined = "", fallbackUpdatedAt?: string | null): InfoBlock[] {
  const uniqueStamps = new Set(blocks.map((block) => block.updated_at).filter(Boolean))
  if (blocks.length > 1 && uniqueStamps.size > 1) return blocks
  const text = blocks.length ? blocksToText(blocks) : fallbackText || ""
  if (!text) return []
  return [{ id: blocks[0]?.id || newBlockId(), content: text, updated_at: blocks[0]?.updated_at || fallbackUpdatedAt || new Date().toISOString() }]
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
  if (!value?.trim()) return { sections: [], mainLineUpdates: {}, mainBlocks: [], mainSections: [] }
  try {
    const parsed = JSON.parse(value)
    if (parsed && !Array.isArray(parsed) && typeof parsed === "object") {
      const sectionSource = Array.isArray(parsed.sections) ? parsed.sections : []
      const mainSectionSource = Array.isArray(parsed.main_sections) ? parsed.main_sections : []
      const mainLineUpdates = parsed.main_line_updates && typeof parsed.main_line_updates === "object" ? parsed.main_line_updates : {}
      return {
        sections: sectionSource
          .map((item: Partial<HighlightCard>) => ({
            title: typeof item?.title === "string" ? item.title : "",
            info: typeof item?.info === "string" ? item.info : "",
            line_updates: item?.line_updates && typeof item.line_updates === "object" ? item.line_updates : {},
            blocks: normalizeBlocks(item?.blocks, typeof item?.info === "string" ? item.info : "", item?.line_updates && typeof item.line_updates === "object" ? item.line_updates : {}),
            table: Array.isArray(item?.table) ? item.table as string[][] : undefined,
            column_widths: Array.isArray(item?.column_widths) ? item.column_widths as number[] : undefined,
            table_row_updates: Array.isArray(item?.table_row_updates) ? item.table_row_updates as string[] : undefined,
            sections: Array.isArray(item?.sections)
              ? item.sections.map((section: Partial<HighlightCard>) => ({
                  title: typeof section?.title === "string" ? section.title : "",
                  info: typeof section?.info === "string" ? section.info : "",
                  line_updates: section?.line_updates && typeof section.line_updates === "object" ? section.line_updates : {},
                  blocks: normalizeBlocks(section?.blocks, typeof section?.info === "string" ? section.info : "", section?.line_updates && typeof section.line_updates === "object" ? section.line_updates : {}),
                  table: Array.isArray(section?.table) ? section.table as string[][] : undefined,
                  column_widths: Array.isArray(section?.column_widths) ? section.column_widths as number[] : undefined,
                  table_row_updates: Array.isArray(section?.table_row_updates) ? section.table_row_updates as string[] : undefined,
                }))
              : [],
          }))
          .filter((item: HighlightCard) => item.title.trim() || item.info.trim()),
        mainLineUpdates,
        mainBlocks: normalizeBlocks(parsed.main_blocks, "", mainLineUpdates),
        mainSections: mainSectionSource
          .map((item: Partial<HighlightCard>) => ({
            title: typeof item?.title === "string" ? item.title : "",
            info: typeof item?.info === "string" ? item.info : "",
            line_updates: item?.line_updates && typeof item.line_updates === "object" ? item.line_updates : {},
            blocks: normalizeBlocks(item?.blocks, typeof item?.info === "string" ? item.info : "", item?.line_updates && typeof item.line_updates === "object" ? item.line_updates : {}),
          }))
          .filter((item: HighlightCard) => item.title.trim() || item.info.trim()),
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
            table: Array.isArray(item?.table) ? item.table as string[][] : undefined,
            column_widths: Array.isArray(item?.column_widths) ? item.column_widths as number[] : undefined,
            table_row_updates: Array.isArray(item?.table_row_updates) ? item.table_row_updates as string[] : undefined,
            sections: Array.isArray(item?.sections)
              ? item.sections.map((section: Partial<HighlightCard>) => ({
                  title: typeof section?.title === "string" ? section.title : "",
                  info: typeof section?.info === "string" ? section.info : "",
                  line_updates: section?.line_updates && typeof section.line_updates === "object" ? section.line_updates : {},
                  blocks: normalizeBlocks(section?.blocks, typeof section?.info === "string" ? section.info : "", section?.line_updates && typeof section.line_updates === "object" ? section.line_updates : {}),
                  table: Array.isArray(section?.table) ? section.table as string[][] : undefined,
                  column_widths: Array.isArray(section?.column_widths) ? section.column_widths as number[] : undefined,
                  table_row_updates: Array.isArray(section?.table_row_updates) ? section.table_row_updates as string[] : undefined,
                }))
              : [],
          }))
          .filter((item: HighlightCard) => item.title.trim() || item.info.trim()),
        mainLineUpdates: {},
        mainBlocks: [],
        mainSections: [],
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
      mainSections: [],
    }
  }
  return { sections: [], mainLineUpdates: {}, mainBlocks: [], mainSections: [] }
}

function parseHighlights(value: string | null): HighlightCard[] {
  return parseSummaryMeta(value).sections
}

function serializeSummaryMeta(items: HighlightCard[], mainLineUpdates: Record<string, string>, mainBlocks: InfoBlock[] = [], mainSections: HighlightCard[] = []) {
  return JSON.stringify(
    {
      sections: items
        .map((item) => ({
          title: item.title.trim(),
          info: item.info.trim(),
          line_updates: item.line_updates || {},
          blocks: item.blocks || textToBlocks(item.info, item.line_updates || {}),
          table: item.table,
          column_widths: item.column_widths,
          table_row_updates: item.table_row_updates,
          sections: (item.sections || []).map((section) => ({
            title: section.title.trim(),
            info: section.info.trim(),
            line_updates: section.line_updates || {},
            blocks: section.blocks || textToBlocks(section.info, section.line_updates || {}),
            table: section.table,
            column_widths: section.column_widths,
            table_row_updates: section.table_row_updates,
          })),
        }))
        .filter((item) => item.title || item.info),
      main_line_updates: mainLineUpdates,
      main_blocks: mainBlocks,
      main_sections: mainSections.map((section) => ({
        title: section.title.trim(),
        info: section.info.trim(),
        line_updates: section.line_updates || {},
        blocks: section.blocks || textToBlocks(section.info, section.line_updates || {}),
        table: section.table,
        column_widths: section.column_widths,
        table_row_updates: section.table_row_updates,
      })),
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

function rebaseFolderPath(currentPath: string, sourcePath: string, targetParentPath: string) {
  const folderName = sourcePath.split("/").filter(Boolean).pop() || sourcePath
  const nextRoot = [targetParentPath, folderName].filter(Boolean).join("/")
  if (currentPath === sourcePath) return nextRoot
  if (currentPath.startsWith(`${sourcePath}/`)) return `${nextRoot}${currentPath.slice(sourcePath.length)}`
  return currentPath
}

function canMoveFolderToPath(sourcePath: string, targetParentPath: string) {
  const currentParentPath = sourcePath.split("/").filter(Boolean).slice(0, -1).join("/")
  if (!sourcePath || currentParentPath === targetParentPath) return false
  if (targetParentPath === sourcePath || targetParentPath.startsWith(`${sourcePath}/`)) return false
  return true
}

function deriveFolderPathFromOriginalPath(originalPath?: string | null) {
  if (!originalPath) return ""
  const normalized = originalPath.replace(/\\/g, "/")
  const companyRootMatch = normalized.match(/- Company Information\/[^/]+\/(.+)$/)
  if (companyRootMatch?.[1]) {
    const relative = companyRootMatch[1]
    const segments = relative.split("/").filter(Boolean)
    return segments.slice(0, -1).join("/")
  }
  const genericMatch = normalized.match(/company\/[^/]+\/(.+)$/)
  if (genericMatch?.[1]) {
    const relative = genericMatch[1]
    const segments = relative.split("/").filter(Boolean)
    return segments.slice(0, -1).join("/")
  }
  return ""
}

function deriveVirtualFoldersFromFiles(files: Array<CompanyFileRecord | EntryFileRecord>) {
  const seen = new Map<string, EntryFolderRecord>()
  for (const file of files) {
    const folderPath = (file.folder_path || "").trim()
    if (!folderPath) continue
    const segments = folderPath.split("/").filter(Boolean)
    let parent = ""
    for (const segment of segments) {
      const id = `virtual:${joinFolderPath(parent, segment)}`
      if (!seen.has(id)) {
        seen.set(id, { id, folder_path: parent, name: segment })
      }
      parent = joinFolderPath(parent, segment)
    }
  }
  return Array.from(seen.values()).sort((a, b) => joinFolderPath(a.folder_path, a.name).localeCompare(joinFolderPath(b.folder_path, b.name)))
}

function mergeFolderRecords(realFolders: EntryFolderRecord[], files: Array<CompanyFileRecord | EntryFileRecord>) {
  const virtualFolders = deriveVirtualFoldersFromFiles(files)
  const seen = new Set<string>()
  const merged: EntryFolderRecord[] = []
  for (const folder of [...realFolders, ...virtualFolders]) {
    const key = joinFolderPath(folder.folder_path, folder.name)
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(folder)
  }
  return merged.sort((a, b) => joinFolderPath(a.folder_path, a.name).localeCompare(joinFolderPath(b.folder_path, b.name)))
}

function getFileTypeLabel(name: string, fileType?: string | null) {
  const ext = (name.split(".").pop() || "").toLowerCase()
  const normalized = (fileType || "").toLowerCase()
  if (ext === "xls" || ext === "xlsx" || normalized.includes("sheet") || normalized.includes("excel")) return { color: "#0f9d58", label: "XLS" }
  if (ext === "doc" || ext === "docx" || normalized.includes("word")) return { color: "#4285f4", label: "DOC" }
  if (ext === "pdf" || normalized.includes("pdf")) return { color: "#db4437", label: "PDF" }
  if (ext === "ppt" || ext === "pptx" || normalized.includes("presentation")) return { color: "#f4b400", label: "PPT" }
  if (ext === "png" || ext === "jpg" || ext === "jpeg" || ext === "webp" || normalized.startsWith("image/")) return { color: "#a142f4", label: "IMG" }
  return { color: "#5f6368", label: "FILE" }
}

function FolderIcon() {
  return (
    <span
      style={{
        ...fileIconStyle,
        position: "relative",
        borderRadius: "4px",
        background: "var(--fc-admin-warning-bg)",
        boxShadow: "none",
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
          background: "var(--fc-admin-warning-text)",
        }}
      />
    </span>
  )
}

function DriveFileIcon({ color, label }: { color: string; label: string }) {
  const isSheet = label === "XLS"
  const isGeneric = label === "FILE"
  return (
    <span
      style={{
        width: "24px",
        height: "20px",
        display: "inline-grid",
        placeItems: "center",
        position: "relative",
        borderRadius: "4px",
        background: color,
        color: "#fff",
        fontSize: "6px",
        fontWeight: 900,
        letterSpacing: "0.01em",
        boxShadow: "0 1px 2px #00000018",
        overflow: "hidden",
      }}
      title={label}
    >
      <span
        style={{
          position: "absolute",
          top: 0,
          right: 0,
          width: 0,
          height: 0,
          borderTop: "6px solid #ffffffcc",
          borderLeft: "6px solid #00000020",
        }}
      />
      <span style={{ display: "grid", gap: "1px", width: "12px", marginTop: isGeneric ? "-1px" : "-4px" }}>
        {isSheet ? (
          <>
            <span style={{ height: "1px", background: "#ffffffcc", boxShadow: "5px 0 0 #ffffffcc" }} />
            <span style={{ height: "1px", background: "#ffffffcc", boxShadow: "5px 0 0 #ffffffcc" }} />
            <span style={{ height: "1px", background: "#ffffffcc", boxShadow: "5px 0 0 #ffffffcc" }} />
          </>
        ) : (
          <>
            <span style={{ height: "1px", borderRadius: "999px", background: "#ffffffcc" }} />
            <span style={{ height: "1px", borderRadius: "999px", background: "#ffffffcc", width: "80%" }} />
            <span style={{ height: "1px", borderRadius: "999px", background: "#ffffffcc", width: "62%" }} />
          </>
        )}
      </span>
      <span style={{ position: "absolute", left: "3px", right: "3px", bottom: "2px", textAlign: "center", fontSize: label.length > 3 ? "5px" : "6px", lineHeight: 1 }}>
        {label}
      </span>
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
        color: "var(--fc-admin-panel-text)",
        fontSize: "14px",
        lineHeight: 1.35,
        padding: "8px 10px",
        border: "1px solid var(--fc-admin-selected-border)",
        borderRadius: "14px",
        background: "var(--fc-admin-panel-soft-bg)",
        transition: "box-shadow 160ms ease, border-color 160ms ease, background 160ms ease",
      }}
      onMouseLeave={() => setHoveredLine(null)}
      onDoubleClick={onDoubleClick}
      title={onDoubleClick ? "Double click to edit" : undefined}
    >
      {lines.map((line, index) => {
        return (
          <div
            key={`hover-line-${index}`}
            onMouseEnter={() => setHoveredLine(index)}
            style={{
              minHeight: "1.35em",
              cursor: "default",
              overflowWrap: "anywhere",
              wordBreak: "break-word",
              borderRadius: "6px",
              padding: "0 1px",
              margin: 0,
              background: "transparent",
              boxShadow: "none",
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
  onInsertBlock,
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
  onInsertBlock?: (index: number) => void
  query?: string
}) {
  const editable = Boolean(onBlockDoubleClick || onInsertBlock || onBlockSave || onBlockCancel || onBlockDelete)
  const instanceIdRef = useRef(`ccinfo-text-${Math.random().toString(36).slice(2)}`)
  const blockNodeRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const [selectedBlockId, setSelectedBlockId] = useState("")
  const [actionPanelTop, setActionPanelTop] = useState(6)
  const selectedIndex = blocks.findIndex((block) => block.id === selectedBlockId)
  const selectedBlock = selectedIndex >= 0 ? blocks[selectedIndex] : undefined
  const selectedStamp = selectedBlock ? (formatTimestamp(selectedBlock.updated_at) || formatTimestamp(fallbackUpdatedAt)) : ""

  useEffect(() => {
    function handleExternalSelection(event: Event) {
      const detail = (event as CustomEvent<{ instanceId?: string }>).detail
      if (detail?.instanceId !== instanceIdRef.current && !editingBlockId) {
        setSelectedBlockId("")
      }
    }
    window.addEventListener("ccinfo-text-block-selected", handleExternalSelection)
    return () => window.removeEventListener("ccinfo-text-block-selected", handleExternalSelection)
  }, [editingBlockId])

  useEffect(() => {
    if (editingBlockId && blocks.some((block) => block.id === editingBlockId)) {
      setSelectedBlockId(editingBlockId)
      return
    }
    if (!blocks.length || !blocks.some((block) => block.id === selectedBlockId)) {
      setSelectedBlockId("")
    }
  }, [blocks, editingBlockId, selectedBlockId])

  function selectBlock(blockId: string) {
    setSelectedBlockId(blockId)
    window.dispatchEvent(new CustomEvent("ccinfo-text-block-selected", { detail: { instanceId: instanceIdRef.current } }))
  }

  useLayoutEffect(() => {
    const node = selectedBlockId ? blockNodeRefs.current[selectedBlockId] : null
    if (!node) {
      setActionPanelTop(6)
      return
    }
    setActionPanelTop(Math.max(6, node.offsetTop))
  }, [selectedBlockId, blocks])

  const insertNearSelected = (placement: "above" | "below") => {
    if (!onInsertBlock) return
    const activeIndex = selectedIndex >= 0 ? selectedIndex : blocks.length - 1
    const insertAt = blocks.length === 0 ? 0 : placement === "above" ? activeIndex : activeIndex + 1
    onInsertBlock(insertAt)
  }
  const showControls = editable && (Boolean(selectedBlock) || Boolean(editingBlockId) || blocks.length === 0)

  const textBox = (
    <div
      style={{
        minHeight,
        cursor: "default",
        whiteSpace: "pre-wrap",
        overflowWrap: "anywhere",
        wordBreak: "break-word",
        position: "relative",
        color: "var(--fc-admin-panel-text)",
        fontSize: "13px",
        lineHeight: 1.28,
        padding: "5px 8px",
        border: "1px solid var(--fc-admin-selected-border)",
        borderRadius: "12px",
        background: "var(--fc-admin-panel-soft-bg)",
      }}
      onDoubleClick={onDoubleClick}
      title={onDoubleClick ? "Double click to edit" : undefined}
    >
      {blocks.length === 0 ? <div style={{ minHeight: "1.55em", color: "var(--fc-admin-muted)" }}>Double click or use Add Below to start.</div> : null}
      {blocks.map((block, index) => {
        const selected = block.id === selectedBlockId
        const editing = editingBlockId === block.id
        return (
          <div
            key={block.id}
            ref={(node) => {
              blockNodeRefs.current[block.id] = node
            }}
            onClick={() => selectBlock(block.id)}
            onDoubleClick={(event) => {
              if (!onBlockDoubleClick) return
              event.stopPropagation()
              selectBlock(block.id)
              onBlockDoubleClick(block)
            }}
            style={{
              minHeight: "1.35em",
              borderRadius: "9px",
              padding: editing ? "1px 2px" : "2px 4px",
              margin: 0,
              position: "relative",
              background: selected ? "#e7f2ff" : "transparent",
              boxShadow: editing ? "inset 0 -2px 0 var(--fc-admin-link)" : "none",
              cursor: onBlockDoubleClick ? "text" : "default",
              transition: "background 120ms ease, box-shadow 120ms ease",
            }}
          >
            {editing ? (
              <AutoSizeTextarea
                value={block.content}
                onChange={(event) => onBlockChange?.(block.id, event.target.value)}
                autoFocus
                style={{
                  ...textareaStyle,
                  minHeight: "1.45em",
                  maxHeight: "62vh",
                  padding: "1px 2px",
                  border: "none",
                  borderRadius: "6px",
                  background: "transparent",
                  lineHeight: 1.45,
                  boxShadow: "none",
                }}
              />
            ) : (
              block.content ? <HighlightedInlineText value={block.content} query={query || ""} /> : "\u00a0"
            )}
          </div>
        )
      })}
    </div>
  )

  if (!showControls) return textBox

  return (
    <div style={{ position: "relative" }}>
      {textBox}
      <div style={{ position: "absolute", top: `${actionPanelTop}px`, right: "6px", width: "174px", display: "grid", gap: "7px", border: "1px solid var(--fc-admin-border-soft)", borderRadius: "12px", background: "var(--fc-admin-panel-bg)", padding: "9px", boxShadow: "0 12px 26px #00000018", zIndex: 6 }}>
        <div style={{ color: "var(--fc-admin-muted)", fontSize: "11px", lineHeight: 1.35 }}>
          {selectedStamp ? `Updated ${selectedStamp}` : "No update recorded"}
        </div>
        {onInsertBlock ? (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0,1fr))", gap: "6px" }}>
            <button type="button" onClick={() => insertNearSelected("above")} style={{ ...buttonStyle, padding: "5px 8px", fontSize: "10px" }}>Add Above</button>
            <button type="button" onClick={() => insertNearSelected("below")} style={{ ...buttonStyle, padding: "5px 8px", fontSize: "10px" }}>Add Below</button>
          </div>
        ) : null}
        {editingBlockId ? (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0,1fr))", gap: "6px" }}>
            <button type="button" onClick={onBlockSave} style={{ ...buttonStyle, padding: "5px 8px", fontSize: "10px", background: "var(--fc-admin-success-bg)", color: "var(--fc-admin-success-text)" }}>Save</button>
            <button type="button" onClick={onBlockCancel} style={{ ...buttonStyle, padding: "5px 8px", fontSize: "10px" }}>Cancel</button>
            {selectedBlock && onBlockDelete ? (
              <button
                type="button"
                onClick={() => {
                  if (confirm("Delete this row?")) onBlockDelete(selectedBlock.id)
                }}
                style={{ ...buttonStyle, gridColumn: "1 / -1", padding: "5px 8px", fontSize: "10px", background: "var(--fc-admin-danger-bg)", color: "var(--fc-admin-danger-text)", border: "1px solid var(--fc-admin-danger-border)" }}
              >
                Delete Row
              </button>
            ) : null}
          </div>
        ) : (
          <div style={{ color: "var(--fc-admin-muted)", fontSize: "11px", lineHeight: 1.35 }}>Double click text to edit.</div>
        )}
      </div>
    </div>
  )
}

function SimpleTable({
  table,
  columnWidths,
  rowUpdates,
  onSave,
  readOnly = false,
}: {
  table: string[][]
  columnWidths?: number[]
  rowUpdates?: string[]
  onSave?: (table: string[][], columnWidths: number[], rowUpdates: string[]) => void
  readOnly?: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [draftRows, setDraftRows] = useState<string[][]>(table.length ? table : [["", ""], ["", ""]])
  const [draftWidths, setDraftWidths] = useState<number[]>(columnWidths || [])
  const [draftRowUpdates, setDraftRowUpdates] = useState<string[]>(rowUpdates || [])
  const [selectedCell, setSelectedCell] = useState({ row: 0, column: 0 })
  const [copied, setCopied] = useState(false)
  const tableRef = useRef<HTMLTableElement | null>(null)
  const dragStateRef = useRef<{ startX: number; startWidths: number[]; index: number; tableWidth: number } | null>(null)
  useEffect(() => {
    setDraftRows(table.length ? table : [["", ""], ["", ""]])
    setDraftWidths(columnWidths || [])
    setDraftRowUpdates(rowUpdates || [])
    setSelectedCell({ row: 0, column: 0 })
  }, [table, columnWidths, rowUpdates])
  useEffect(() => {
    function handleMove(event: MouseEvent) {
      const state = dragStateRef.current
      if (!state) return
      const deltaPercent = (event.clientX - state.startX) / Math.max(state.tableWidth, 1) * 100
      const next = [...state.startWidths]
      const current = next[state.index] || 0
      const neighbor = next[state.index + 1] || 0
      const currentNext = Math.max(8, Math.min(current + deltaPercent, current + neighbor - 8))
      const neighborNext = current + neighbor - currentNext
      next[state.index] = Math.round(currentNext)
      next[state.index + 1] = Math.round(neighborNext)
      setDraftWidths(next)
    }
    function handleUp() {
      dragStateRef.current = null
    }
    window.addEventListener("mousemove", handleMove)
    window.addEventListener("mouseup", handleUp)
    return () => {
      window.removeEventListener("mousemove", handleMove)
      window.removeEventListener("mouseup", handleUp)
    }
  }, [])
  const rows = editing ? draftRows : table.length ? table : [["", ""], ["", ""]]
  const columnCount = Math.max(2, ...rows.map((row) => row.length))
  const widths = Array.from({ length: columnCount }).map((_, index) => (editing ? draftWidths[index] : columnWidths?.[index]) || Math.round(100 / columnCount))
  const displayRowUpdates = editing ? draftRowUpdates : rowUpdates || []
  const activeRow = Math.min(selectedCell.row, Math.max(rows.length - 1, 0))
  const activeColumn = Math.min(selectedCell.column, Math.max(columnCount - 1, 0))
  const normalizeWidths = (nextWidths: number[]) => {
    const safeWidths = nextWidths.map((width) => Math.max(6, Number.isFinite(width) ? width : 0))
    const total = safeWidths.reduce((sum, width) => sum + width, 0)
    if (!total) return Array.from({ length: Math.max(nextWidths.length, 1) }).map(() => Math.round(100 / Math.max(nextWidths.length, 1)))
    return safeWidths.map((width) => Number((width / total * 100).toFixed(2)))
  }
  const beginEditing = () => {
    setDraftRows(rows.map((row) => [...row]))
    setDraftWidths(widths)
    setDraftRowUpdates(displayRowUpdates.length ? [...displayRowUpdates] : rows.map(() => ""))
    setSelectedCell({ row: activeRow, column: activeColumn })
    setEditing(true)
  }
  const updateRowTimestamp = (rowIndex: number, source: string[] = draftRowUpdates) => {
    const nextUpdates = [...source]
    nextUpdates[rowIndex] = new Date().toISOString()
    setDraftRowUpdates(nextUpdates)
    return nextUpdates
  }
  const updateCell = (rowIndex: number, columnIndex: number, value: string) => {
    const next = rows.map((row) => [...row])
    while (next[rowIndex].length < columnCount) next[rowIndex].push("")
    next[rowIndex][columnIndex] = value
    setDraftRows(next)
    setSelectedCell({ row: rowIndex, column: columnIndex })
    updateRowTimestamp(rowIndex)
  }
  const insertRow = (placement: "above" | "below") => {
    const insertAt = placement === "above" ? activeRow : activeRow + 1
    const nextRows = rows.map((row) => Array.from({ length: columnCount }).map((_, index) => row[index] || ""))
    nextRows.splice(insertAt, 0, Array.from({ length: columnCount }, () => ""))
    const nextUpdates = [...displayRowUpdates]
    nextUpdates.splice(insertAt, 0, new Date().toISOString())
    setDraftRows(nextRows)
    setDraftRowUpdates(nextUpdates)
    setSelectedCell({ row: insertAt, column: activeColumn })
  }
  const insertColumn = (placement: "left" | "right") => {
    const nextCount = columnCount + 1
    const insertAt = placement === "left" ? activeColumn : activeColumn + 1
    setDraftRows(rows.map((row) => {
      const nextRow = Array.from({ length: columnCount }).map((_, index) => row[index] || "")
      nextRow.splice(insertAt, 0, "")
      return nextRow
    }))
    const nextWidths = [...widths]
    const currentWidth = nextWidths[activeColumn] || Math.round(100 / columnCount)
    const splitWidth = Math.max(6, currentWidth / 2)
    nextWidths[activeColumn] = splitWidth
    nextWidths.splice(insertAt, 0, splitWidth)
    setDraftWidths(normalizeWidths(nextWidths.slice(0, nextCount)))
    setDraftRowUpdates(displayRowUpdates.length ? [...displayRowUpdates] : rows.map(() => ""))
    setSelectedCell({ row: activeRow, column: insertAt })
  }
  const deleteSelectedRow = () => {
    if (rows.length <= 1) return
    const nextRows = rows.filter((_, index) => index !== activeRow)
    setDraftRows(nextRows)
    setDraftRowUpdates(displayRowUpdates.filter((_, index) => index !== activeRow))
    setSelectedCell({ row: Math.max(0, Math.min(activeRow, nextRows.length - 1)), column: activeColumn })
  }
  const deleteColumn = () => {
    if (columnCount <= 1) return
    const nextCount = columnCount - 1
    setDraftRows(rows.map((row) => Array.from({ length: columnCount }).map((_, index) => row[index] || "").filter((_, index) => index !== activeColumn)))
    const nextWidths = [...widths]
    const removedWidth = nextWidths[activeColumn] || 0
    nextWidths.splice(activeColumn, 1)
    const absorbIndex = Math.max(0, Math.min(activeColumn, nextWidths.length - 1))
    nextWidths[absorbIndex] = (nextWidths[absorbIndex] || 0) + removedWidth
    setDraftWidths(normalizeWidths(nextWidths.slice(0, nextCount)))
    setDraftRowUpdates(displayRowUpdates.length ? [...displayRowUpdates] : rows.map(() => ""))
    setSelectedCell({ row: activeRow, column: Math.max(0, Math.min(activeColumn, nextCount - 1)) })
  }
  const copyTable = async () => {
    const text = rows.map((row) => Array.from({ length: columnCount }).map((_, index) => row[index] || "").join("\t")).join("\n")
    await navigator.clipboard?.writeText(text)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1400)
  }
  const pasteTable = async () => {
    const text = await navigator.clipboard?.readText()
    if (!text?.trim()) return
    const incomingRows = text
      .trimEnd()
      .split(/\r?\n/)
      .map((line) => line.split("\t"))
    const nextRows = rows.map((row) => Array.from({ length: columnCount }).map((_, index) => row[index] || ""))
    const requiredRows = activeRow + incomingRows.length
    const requiredColumns = activeColumn + Math.max(...incomingRows.map((row) => row.length))
    while (nextRows.length < requiredRows) nextRows.push(Array.from({ length: Math.max(columnCount, requiredColumns) }, () => ""))
    const nextColumnCount = Math.max(columnCount, requiredColumns)
    const now = new Date().toISOString()
    const nextUpdates = displayRowUpdates.length ? [...displayRowUpdates] : rows.map(() => "")
    for (let rowIndex = 0; rowIndex < nextRows.length; rowIndex += 1) {
      while (nextRows[rowIndex].length < nextColumnCount) nextRows[rowIndex].push("")
    }
    incomingRows.forEach((incomingRow, rowOffset) => {
      const targetRow = activeRow + rowOffset
      incomingRow.forEach((cell, columnOffset) => {
        nextRows[targetRow][activeColumn + columnOffset] = cell
      })
      nextUpdates[targetRow] = now
    })
    setDraftRows(nextRows)
    setDraftWidths(normalizeWidths(Array.from({ length: nextColumnCount }).map((_, index) => widths[index] || Math.round(100 / nextColumnCount))))
    setDraftRowUpdates(nextUpdates)
    setSelectedCell({ row: activeRow, column: activeColumn })
  }
  const save = () => {
    onSave?.(draftRows, widths, draftRowUpdates)
    setEditing(false)
  }
  return (
    <div style={{ display: "grid", gap: "8px", overflowX: "auto" }}>
      <table ref={tableRef} style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px", tableLayout: "fixed" }}>
        <colgroup>
          {widths.map((width, index) => <col key={`col-${index}`} style={{ width: `${width}%` }} />)}
        </colgroup>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={`table-row-${rowIndex}`}>
              {Array.from({ length: columnCount }).map((_, columnIndex) => {
                const selected = editing && rowIndex === activeRow && columnIndex === activeColumn
                return (
                <td key={`table-cell-${rowIndex}-${columnIndex}`} onClick={() => setSelectedCell({ row: rowIndex, column: columnIndex })} style={{ border: selected ? "1px solid var(--fc-admin-link)" : "1px solid var(--fc-admin-selected-border)", padding: 0, background: selected ? "#e7f2ff" : rowIndex === 0 ? "var(--fc-admin-selected-bg)" : "var(--fc-admin-panel-soft-bg)", position: "relative" }}>
                  <input
                    value={row[columnIndex] || ""}
                    disabled={readOnly || !editing}
                    onFocus={() => setSelectedCell({ row: rowIndex, column: columnIndex })}
                    onChange={(event) => updateCell(rowIndex, columnIndex, event.target.value)}
                    style={{ width: "100%", border: "none", background: selected ? "#e7f2ff" : "#ffffff", color: "var(--fc-admin-panel-text)", padding: "7px 8px", outline: "none", boxSizing: "border-box", fontSize: "12px", fontWeight: rowIndex === 0 ? 800 : 500 }}
                  />
                      {!readOnly && editing && rowIndex === 0 && columnIndex < columnCount - 1 ? (
                        <span
                          onMouseDown={(event) => {
                            if (!tableRef.current) return
                            dragStateRef.current = {
                              startX: event.clientX,
                              startWidths: [...widths],
                              index: columnIndex,
                              tableWidth: tableRef.current.getBoundingClientRect().width,
                            }
                            event.preventDefault()
                          }}
                          style={{
                            position: "absolute",
                            top: 0,
                            right: "-3px",
                            width: "6px",
                            height: "100%",
                            cursor: "col-resize",
                            background: "transparent",
                            zIndex: 2,
                          }}
                        />
                      ) : null}
                </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {!readOnly && editing && (
        <div style={{ display: "grid", gap: "8px" }}>
          <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
            <button type="button" onClick={() => insertRow("above")} style={{ ...buttonStyle, padding: "4px 9px", fontSize: "10px" }}>Row Above</button>
            <button type="button" onClick={() => insertRow("below")} style={{ ...buttonStyle, padding: "4px 9px", fontSize: "10px" }}>Row Below</button>
            <button type="button" onClick={() => insertColumn("left")} style={{ ...buttonStyle, padding: "4px 9px", fontSize: "10px" }}>Col Left</button>
            <button type="button" onClick={() => insertColumn("right")} style={{ ...buttonStyle, padding: "4px 9px", fontSize: "10px" }}>Col Right</button>
            <button type="button" onClick={deleteSelectedRow} style={{ ...buttonStyle, padding: "4px 9px", fontSize: "10px" }}>Delete Row</button>
            <button type="button" onClick={deleteColumn} style={{ ...buttonStyle, padding: "4px 9px", fontSize: "10px" }}>Delete Column</button>
            <button type="button" onClick={() => void pasteTable()} style={{ ...buttonStyle, padding: "4px 9px", fontSize: "10px" }}>Paste</button>
            <button type="button" onClick={save} style={{ ...buttonStyle, padding: "4px 9px", fontSize: "10px", background: "var(--fc-admin-success-bg)", color: "var(--fc-admin-success-text)" }}>Save</button>
            <button type="button" onClick={() => setEditing(false)} style={{ ...buttonStyle, padding: "4px 9px", fontSize: "10px" }}>Cancel</button>
          </div>
          <div style={{ color: "var(--fc-admin-muted)", fontSize: "11px" }}>Drag the header borders to resize columns.</div>
        </div>
      )}
      {!readOnly && !editing && (
        <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
          <button type="button" onClick={beginEditing} style={{ ...buttonStyle, padding: "4px 9px", fontSize: "10px" }}>Edit</button>
          <button type="button" onClick={() => void copyTable()} style={{ ...buttonStyle, padding: "4px 9px", fontSize: "10px", background: copied ? "var(--fc-admin-success-bg)" : buttonStyle.background, color: copied ? "var(--fc-admin-success-text)" : buttonStyle.color }}>{copied ? "Copied" : "Copy Table"}</button>
        </div>
      )}
    </div>
  )
}

async function fetchEntryFiles(kind: RecordKind, id: string) {
  const withFolderPath = await supabase
    .from("cc_entry_files")
    .select("id,file_name,file_type,drive_url,drive_file_id,folder_path,deleted_at")
    .eq("entry_kind", kind)
    .eq("entry_id", id)
    .is("deleted_at", null)
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
    .select("id,file_name,file_type,drive_url,drive_file_id,deleted_at")
    .eq("entry_kind", kind)
    .eq("entry_id", id)
    .is("deleted_at", null)
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
    .select("id,file_name,file_type,drive_url,drive_file_id,original_path,deleted_at")
    .eq("company_id", id)
    .is("deleted_at", null)
    .order("file_name", { ascending: true })

  return (((legacy.data as CompanyFileRecord[]) || []).map((file) => ({
    ...file,
    folder_path: deriveFolderPathFromOriginalPath(file.original_path),
    source: "company" as const,
  })))
}

async function fetchDeletedEntryFiles(kind: RecordKind, id: string) {
  const result = await supabase
    .from("cc_entry_files")
    .select("id,file_name,file_type,drive_url,drive_file_id,folder_path,deleted_at")
    .eq("entry_kind", kind)
    .eq("entry_id", id)
    .not("deleted_at", "is", null)
    .order("deleted_at", { ascending: false })

  return (((result.data as EntryFileRecord[]) || []).map((file) => ({
    ...file,
    folder_path: file.folder_path || "",
    source: "entry" as const,
  })))
}

async function fetchDeletedCompanyFiles(id: string) {
  const result = await supabase
    .from("cc_company_files")
    .select("id,file_name,file_type,drive_url,drive_file_id,original_path,deleted_at")
    .eq("company_id", id)
    .not("deleted_at", "is", null)
    .order("deleted_at", { ascending: false })

  return (((result.data as CompanyFileRecord[]) || []).map((file) => ({
    ...file,
    folder_path: deriveFolderPathFromOriginalPath(file.original_path),
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
  autoFocus,
}: {
  value: string
  onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => void
  onBlur?: (event: React.FocusEvent<HTMLTextAreaElement>) => void
  style?: React.CSSProperties
  title?: string
  autoFocus?: boolean
}) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  useLayoutEffect(() => {
    const node = textareaRef.current
    if (!node) return
    const computed = window.getComputedStyle(node)
    const fontSize = Number.parseFloat(computed.fontSize) || 14
    const lineHeight = Number.parseFloat(computed.lineHeight) || fontSize * 1.55
    const maxHeight = style?.maxHeight ? window.innerHeight * 0.62 : Number.POSITIVE_INFINITY
    node.style.height = "0px"
    node.style.height = `${Math.min(node.scrollHeight + lineHeight, maxHeight)}px`
    node.style.overflowY = node.scrollHeight + lineHeight > maxHeight ? "auto" : "hidden"
  }, [style?.maxHeight, value])

  return (
    <textarea
      ref={textareaRef}
      value={value}
      onChange={onChange}
      onBlur={onBlur}
      title={title}
      autoFocus={autoFocus}
      rows={1}
      style={{
        ...style,
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
  const highlightTitleInputRef = useRef<HTMLInputElement | null>(null)
  const addPortNameInputRef = useRef<HTMLInputElement | null>(null)

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

  useEffect(() => {
    document.title = "Country & Company Info - FC Uno"
  }, [])
  const [matchCount, setMatchCount] = useState(0)
  const [matchIndex, setMatchIndex] = useState(0)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuCloseTimerRef = useRef<number | null>(null)
  const [files, setFiles] = useState<Array<CompanyFileRecord | EntryFileRecord>>([])
  const [deletedFiles, setDeletedFiles] = useState<Array<CompanyFileRecord | EntryFileRecord>>([])
  const [folders, setFolders] = useState<EntryFolderRecord[]>([])
  const [currentFolderPath, setCurrentFolderPath] = useState("")
  const [draggingFileId, setDraggingFileId] = useState("")
  const [draggingFolderPath, setDraggingFolderPath] = useState("")
  const [dropFolderPath, setDropFolderPath] = useState<string | null>(null)
  const [currentCountryPorts, setCurrentCountryPorts] = useState<CountryPortListItem[]>([])
  const [countryOptions, setCountryOptions] = useState<Array<{ id: string; name: string }>>([])
  const [countryDropdownOpen, setCountryDropdownOpen] = useState(false)
  const [highlights, setHighlights] = useState<HighlightCard[]>([])
  const [uploadingFile, setUploadingFile] = useState(false)
  const [selectedPreviewFile, setSelectedPreviewFile] = useState<EntryFileRecord | CompanyFileRecord | null>(null)
  const [previewModalOpen, setPreviewModalOpen] = useState(false)
  const [filePanelEditTarget, setFilePanelEditTarget] = useState<FilePanelEditTarget | null>(null)
  const [filePanelNameDraft, setFilePanelNameDraft] = useState("")
  const [highlightModalOpen, setHighlightModalOpen] = useState(false)
  const [highlightModalMode, setHighlightModalMode] = useState<"tab" | "section" | "table">("section")
  const [highlightDraft, setHighlightDraft] = useState<HighlightCard>({ title: "", info: "" })
  const [recordModalOpen, setRecordModalOpen] = useState(false)
  const [recordNameDraft, setRecordNameDraft] = useState("")
  const [addPortModalOpen, setAddPortModalOpen] = useState(false)
  const [addPortDraft, setAddPortDraft] = useState({ name: "", notes: "", countryId: "", countryName: "" })
  const [editingCountryPortId, setEditingCountryPortId] = useState("")
  const [countryPortDraft, setCountryPortDraft] = useState({ name: "", notes: "" })
  const [sectionSaving, setSectionSaving] = useState(false)
  const [sectionSaveState, setSectionSaveState] = useState<"saving" | "saved">("saved")
  const [mainInfoLineUpdates, setMainInfoLineUpdates] = useState<Record<string, string>>({})
  const [mainInfoBlocks, setMainInfoBlocks] = useState<InfoBlock[]>([])
  const [mainSections, setMainSections] = useState<HighlightCard[]>([])
  const [countryMainBlocks, setCountryMainBlocks] = useState<InfoBlock[]>([])
  const [countrySections, setCountrySections] = useState<HighlightCard[]>([])
  const [countryTabs, setCountryTabs] = useState<HighlightCard[]>([])
  const [mainInfoEditing, setMainInfoEditing] = useState(false)
  const [countryInfoEditing, setCountryInfoEditing] = useState(false)
  const [sectionEditing, setSectionEditing] = useState<Record<number, boolean>>({})
  const [activeInfoTab, setActiveInfoTab] = useState("general")
  const [draggingTabIndex, setDraggingTabIndex] = useState<number | null>(null)
  const [dropTabIndex, setDropTabIndex] = useState<number | null>(null)
  const [dropTabSide, setDropTabSide] = useState<"left" | "right">("left")
  const [editingMainBlockId, setEditingMainBlockId] = useState("")
  const [editingSectionBlock, setEditingSectionBlock] = useState<{ sectionIndex: number; blockId: string } | null>(null)
  const [editingNestedSectionBlock, setEditingNestedSectionBlock] = useState<{ tabIndex: number; sectionIndex: number; blockId: string } | null>(null)
  const [editingMainSectionBlock, setEditingMainSectionBlock] = useState<{ sectionIndex: number; blockId: string } | null>(null)
  const [editingCountryBlockId, setEditingCountryBlockId] = useState("")
  const [recentAuditLogs, setRecentAuditLogs] = useState<AuditLogRecord[]>([])
  const [auditLoading, setAuditLoading] = useState(false)
  const [auditActionId, setAuditActionId] = useState("")
  const mainEditStartRef = useRef<{ notes: string; updates: Record<string, string>; blocks: InfoBlock[] } | null>(null)
  const sectionEditStartRef = useRef<Record<number, HighlightCard>>({})
  const mainSectionEditStartRef = useRef<Record<number, HighlightCard>>({})
  const nestedSectionEditStartRef = useRef<Record<string, HighlightCard>>({})
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
  const filteredAddPortCountryOptions = countryOptions
    .filter((country) => country.name.includes(addPortDraft.countryName.trim().toUpperCase()))
    .slice(0, 12)

  useEffect(() => {
    if (!highlightModalOpen) return
    window.setTimeout(() => highlightTitleInputRef.current?.focus(), 30)
  }, [highlightModalOpen])

  useEffect(() => {
    if (!addPortModalOpen) return
    window.setTimeout(() => addPortNameInputRef.current?.focus(), 30)
  }, [addPortModalOpen])

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

  useEffect(() => {
    if (!authenticated) {
      setRecentAuditLogs([])
      return
    }
    void loadRecentAuditLogs()
  }, [authenticated])

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
  const activityItems = useMemo<CcinfoActivityItem[]>(() => {
    const auditedDeletedFileIds = new Set(
      recentAuditLogs
        .filter((log) => (
          (log.tableName === "cc_company_files" || log.tableName === "cc_entry_files") &&
          log.changedFields.includes("deleted_at") &&
          Boolean(log.afterRow?.deleted_at)
        ))
        .map((log) => `${log.tableName}:${String(log.recordPk.id || log.afterRow?.id || "")}`)
        .filter((value) => !value.endsWith(":")),
    )
    const auditItems = recentAuditLogs.map((log) => ({
      type: "audit" as const,
      id: log.id,
      occurredAt: log.occurredAt,
      subject: getAuditSubject(log),
      summary: getAuditChangeSummary(log),
      actorName: log.actorName,
      undone: Boolean(log.undoneAt),
      canUndo: !log.undoOfLogId && !log.undoneAt,
      log,
    }))
    const deletedItems = deletedFiles
      .filter((file) => !auditedDeletedFileIds.has(`${file.source === "company" ? "cc_company_files" : "cc_entry_files"}:${file.id}`))
      .map((file) => ({
        type: "deleted-file" as const,
        id: file.id,
        occurredAt: file.deleted_at || "",
        subject: (currentRecord.name || "CURRENT RECORD").toUpperCase(),
        summary: `Deleted document ${file.file_name}`,
        actorName: null,
        undone: false as const,
        canUndo: true as const,
        file,
      }))

    return [...auditItems, ...deletedItems]
      .sort((a, b) => (b.occurredAt || "").localeCompare(a.occurredAt || ""))
      .slice(0, 80)
  }, [currentRecord.name, deletedFiles, recentAuditLogs])

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

  useEffect(() => {
    const marks = Array.from(document.querySelectorAll('mark[data-search-match="true"]')) as HTMLElement[]
    marks.forEach((mark, index) => {
      if (index === matchIndex && searchInPage.trim()) {
        mark.style.background = "rgba(255, 204, 102, 0.95)"
        mark.style.outline = "2px solid rgba(196, 116, 0, 0.35)"
        mark.style.scrollMarginBlock = "160px"
      } else {
        mark.style.background = "rgba(255, 243, 176, 0.55)"
        mark.style.outline = "none"
      }
    })
    if (!marks.length || !searchInPage.trim()) return
    const active = marks[Math.min(matchIndex, marks.length - 1)]
    if (active) {
      active.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" })
    }
  }, [matchIndex, matchCount, searchInPage, activeInfoTab, selectedId])

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

  async function loadRecentAuditLogs() {
    setAuditLoading(true)
    try {
      const response = await fetch("/api/admin/audit-logs?table=ccinfo&limit=300")
      const payload = await response.json()
      if (!response.ok) throw new Error(payload.message || "Unable to load audit logs.")
      const logs = ((payload.logs || []) as AuditLogRecord[])
        .filter((log) => isCcinfoAuditLog(log))
        .slice(0, 60)
      setRecentAuditLogs(logs)
    } catch (error) {
      setRecentAuditLogs([])
      setMessage(error instanceof Error ? error.message : "Unable to load audit logs.")
    } finally {
      setAuditLoading(false)
    }
  }

  async function refreshRecentChanges() {
    await loadRecentAuditLogs()
    if (selectedKind && selectedId) {
      setDeletedFiles(await refreshDeletedFiles(selectedKind, selectedId))
    }
  }

  async function undoAuditEntry(logId: string) {
    setAuditActionId(logId)
    try {
      const response = await fetch("/api/admin/audit-logs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "undo", id: logId }),
      })
      const payload = await response.json()
      if (!response.ok) throw new Error(payload.message || "Unable to undo change.")
      if (selectedKind && selectedId) {
        await loadSelected(selectedKind, selectedId)
        await loadRecentAuditLogs()
      }
      setMessage("Undo complete.")
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to undo change.")
    } finally {
      setAuditActionId("")
    }
  }

  function addChangeLog(_: unknown) {}

  function addSimpleChangeLog(_: string) {}

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

  function insertMainBlock(index: number) {
    const source = mainInfoBlocks.length ? mainInfoBlocks : textToBlocks(currentRecord.notes || "", mainInfoLineUpdates, currentRecord.updated_at)
    const block = { id: newBlockId(), content: "", updated_at: new Date().toISOString() }
    const nextBlocks = [...source]
    nextBlocks.splice(index, 0, block)
    setMainInfoBlocks(nextBlocks)
    mainEditStartRef.current = { notes: currentRecord.notes || "", updates: { ...mainInfoLineUpdates }, blocks: source.map((item) => ({ ...item })) }
    setEditingMainBlockId(block.id)
  }

  function insertSectionBlock(index: number, blockIndex: number) {
    const highlight = highlights[index]
    if (!highlight) return
    const sourceBlocks = highlight.blocks?.length ? highlight.blocks : textToBlocks(highlight.info || "", highlight.line_updates || {}, currentRecord.updated_at)
    const block = { id: newBlockId(), content: "", updated_at: new Date().toISOString() }
    const blocks = [...sourceBlocks]
    blocks.splice(blockIndex, 0, block)
    setHighlights((prev) => prev.map((item, itemIndex) => (itemIndex === index ? { ...item, blocks, info: blocksToText(blocks) } : item)))
    sectionEditStartRef.current[index] = { ...highlight, blocks: sourceBlocks.map((item) => ({ ...item })), info: blocksToText(sourceBlocks), line_updates: { ...(highlight.line_updates || {}) } }
    setEditingSectionBlock({ sectionIndex: index, blockId: block.id })
  }

  function insertNestedSectionBlock(tabIndex: number, sectionIndex: number, blockIndex: number) {
    const tab = highlights[tabIndex]
    const section = tab?.sections?.[sectionIndex]
    if (!tab || !section) return
    const sourceBlocks = section.blocks?.length ? section.blocks : textToBlocks(section.info || "", section.line_updates || {}, currentRecord.updated_at)
    const block = { id: newBlockId(), content: "", updated_at: new Date().toISOString() }
    const blocks = [...sourceBlocks]
    blocks.splice(blockIndex, 0, block)
    const snapshotKey = `${tabIndex}:${sectionIndex}`
    nestedSectionEditStartRef.current[snapshotKey] = { ...section, blocks: sourceBlocks.map((item) => ({ ...item })), info: blocksToText(sourceBlocks), line_updates: { ...(section.line_updates || {}) } }
    setHighlights((prev) =>
      prev.map((item, itemIndex) => {
        if (itemIndex !== tabIndex) return item
        const sections = [...(item.sections || [])]
        sections[sectionIndex] = { ...sections[sectionIndex], blocks, info: blocksToText(blocks) }
        return { ...item, sections }
      }),
    )
    setEditingNestedSectionBlock({ tabIndex, sectionIndex, blockId: block.id })
  }

  function updateNestedSectionBlock(tabIndex: number, sectionIndex: number, blockId: string, value: string) {
    const now = new Date().toISOString()
    setHighlights((prev) =>
      prev.map((item, itemIndex) => {
        if (itemIndex !== tabIndex) return item
        const sections = [...(item.sections || [])]
        const section = sections[sectionIndex]
        if (!section) return item
        const sourceBlocks = section.blocks?.length ? section.blocks : textToBlocks(section.info || "", section.line_updates || {}, currentRecord.updated_at)
        const blocks = sourceBlocks.map((block) => (block.id === blockId ? { ...block, content: value, updated_at: now } : block))
        sections[sectionIndex] = { ...section, blocks, info: blocksToText(blocks) }
        return { ...item, sections }
      }),
    )
  }

  function startNestedSectionBlockEditing(tabIndex: number, sectionIndex: number, block: InfoBlock) {
    const section = highlights[tabIndex]?.sections?.[sectionIndex]
    if (!section) return
    const blocks = section.blocks?.length ? section.blocks : textToBlocks(section.info || "", section.line_updates || {}, currentRecord.updated_at)
    const snapshotKey = `${tabIndex}:${sectionIndex}`
    nestedSectionEditStartRef.current[snapshotKey] = { ...section, blocks: blocks.map((item) => ({ ...item })), info: blocksToText(blocks), line_updates: { ...(section.line_updates || {}) } }
    setHighlights((prev) =>
      prev.map((item, itemIndex) => {
        if (itemIndex !== tabIndex) return item
        const sections = [...(item.sections || [])]
        sections[sectionIndex] = { ...section, blocks, info: blocksToText(blocks) }
        return { ...item, sections }
      }),
    )
    setEditingNestedSectionBlock({ tabIndex, sectionIndex, blockId: block.id })
  }


  async function finishNestedSectionEditing() {
    if (editingNestedSectionBlock) {
      delete nestedSectionEditStartRef.current[`${editingNestedSectionBlock.tabIndex}:${editingNestedSectionBlock.sectionIndex}`]
    }
    setEditingNestedSectionBlock(null)
    await persistHighlights(highlights)
  }

  function cancelNestedSectionEditing() {
    if (editingNestedSectionBlock) {
      const { tabIndex, sectionIndex } = editingNestedSectionBlock
      const snapshotKey = `${tabIndex}:${sectionIndex}`
      const before = nestedSectionEditStartRef.current[snapshotKey]
      if (before) {
        setHighlights((prev) =>
          prev.map((item, itemIndex) => {
            if (itemIndex !== tabIndex) return item
            const sections = [...(item.sections || [])]
            sections[sectionIndex] = { ...before, blocks: before.blocks?.map((block) => ({ ...block })) }
            return { ...item, sections }
          }),
        )
      }
      delete nestedSectionEditStartRef.current[snapshotKey]
    }
    setEditingNestedSectionBlock(null)
  }

  async function deleteNestedSectionBlock(tabIndex: number, sectionIndex: number, blockId: string) {
    const nextHighlights = highlights.map((item, itemIndex) => {
      if (itemIndex !== tabIndex) return item
      const sections = [...(item.sections || [])]
      const section = sections[sectionIndex]
      if (!section) return item
      const sourceBlocks = section.blocks?.length ? section.blocks : textToBlocks(section.info || "", section.line_updates || {}, currentRecord.updated_at)
      const blocks = sourceBlocks.filter((block) => block.id !== blockId)
      sections[sectionIndex] = { ...section, blocks, info: blocksToText(blocks) }
      return { ...item, sections }
    })
    setHighlights(nextHighlights)
    setEditingNestedSectionBlock(null)
    delete nestedSectionEditStartRef.current[`${tabIndex}:${sectionIndex}`]
    try {
      await persistHighlights(nextHighlights)
      setMessage("Section saved.")
    } catch {
      setMessage("Unable to save section.")
    }
  }

  async function moveNestedSection(tabIndex: number, sectionIndex: number, direction: -1 | 1) {
    const targetIndex = sectionIndex + direction
    const tab = highlights[tabIndex]
    const sections = [...(tab?.sections || [])]
    if (!tab || targetIndex < 0 || targetIndex >= sections.length) return
    const [moved] = sections.splice(sectionIndex, 1)
    sections.splice(targetIndex, 0, moved)
    const nextHighlights = highlights.map((item, itemIndex) => (itemIndex === tabIndex ? { ...item, sections } : item))
    setHighlights(nextHighlights)
    try {
      await persistHighlights(nextHighlights)
      setMessage("Section order updated.")
    } catch {
      setMessage("Unable to reorder sections.")
    }
  }

  async function deleteNestedSection(tabIndex: number, sectionIndex: number) {
    if (!confirm("Delete this section?")) return
    const nextHighlights = highlights.map((item, itemIndex) => {
      if (itemIndex !== tabIndex) return item
      return { ...item, sections: (item.sections || []).filter((_, index) => index !== sectionIndex) }
    })
    setHighlights(nextHighlights)
    try {
      await persistHighlights(nextHighlights)
      setMessage("Section deleted.")
    } catch {
      setMessage("Unable to delete section.")
    }
  }

  function renameNestedSection(tabIndex: number, sectionIndex: number) {
    const section = highlights[tabIndex]?.sections?.[sectionIndex]
    if (!section) return
    const nextTitle = prompt("Section name", section.title || `SECTION ${sectionIndex + 1}`)?.trim()
    if (!nextTitle) return
    const nextHighlights = highlights.map((item, itemIndex) => {
      if (itemIndex !== tabIndex) return item
      const sections = [...(item.sections || [])]
      sections[sectionIndex] = { ...section, title: normalizeSectionTitle(nextTitle) }
      return { ...item, sections }
    })
    setHighlights(nextHighlights)
    void persistHighlights(nextHighlights)
  }

  function updateMainSectionBlock(sectionIndex: number, blockId: string, value: string) {
    const now = new Date().toISOString()
    setMainSections((prev) =>
      prev.map((section, itemIndex) => {
        if (itemIndex !== sectionIndex) return section
        const sourceBlocks = section.blocks?.length ? section.blocks : textToBlocks(section.info || "", section.line_updates || {}, currentRecord.updated_at)
        const blocks = sourceBlocks.map((block) => (block.id === blockId ? { ...block, content: value, updated_at: now } : block))
        return { ...section, blocks, info: blocksToText(blocks) }
      }),
    )
  }

  function startMainSectionBlockEditing(sectionIndex: number, block: InfoBlock) {
    const section = mainSections[sectionIndex]
    if (!section) return
    const blocks = section.blocks?.length ? section.blocks : textToBlocks(section.info || "", section.line_updates || {}, currentRecord.updated_at)
    mainSectionEditStartRef.current[sectionIndex] = { ...section, blocks: blocks.map((item) => ({ ...item })), info: blocksToText(blocks), line_updates: { ...(section.line_updates || {}) } }
    setMainSections((prev) => prev.map((item, itemIndex) => (itemIndex === sectionIndex ? { ...section, blocks, info: blocksToText(blocks) } : item)))
    setEditingMainSectionBlock({ sectionIndex, blockId: block.id })
  }

  function insertMainSectionBlock(sectionIndex: number, blockIndex: number) {
    const section = mainSections[sectionIndex]
    if (!section) return
    const sourceBlocks = section.blocks?.length ? section.blocks : textToBlocks(section.info || "", section.line_updates || {}, currentRecord.updated_at)
    const block = { id: newBlockId(), content: "", updated_at: new Date().toISOString() }
    const blocks = [...sourceBlocks]
    blocks.splice(blockIndex, 0, block)
    mainSectionEditStartRef.current[sectionIndex] = { ...section, blocks: sourceBlocks.map((item) => ({ ...item })), info: blocksToText(sourceBlocks), line_updates: { ...(section.line_updates || {}) } }
    setMainSections((prev) => prev.map((item, itemIndex) => (itemIndex === sectionIndex ? { ...section, blocks, info: blocksToText(blocks) } : item)))
    setEditingMainSectionBlock({ sectionIndex, blockId: block.id })
  }

  async function finishMainSectionEditing() {
    if (editingMainSectionBlock) {
      delete mainSectionEditStartRef.current[editingMainSectionBlock.sectionIndex]
    }
    setEditingMainSectionBlock(null)
    await persistMainSections(mainSections)
  }

  function cancelMainSectionEditing(sectionIndex: number) {
    const before = mainSectionEditStartRef.current[sectionIndex]
    if (before) {
      setMainSections((prev) => prev.map((item, itemIndex) => (itemIndex === sectionIndex ? { ...before, blocks: before.blocks?.map((block) => ({ ...block })) } : item)))
    }
    delete mainSectionEditStartRef.current[sectionIndex]
    setEditingMainSectionBlock(null)
  }

  function updateMainSectionTable(sectionIndex: number, table: string[][], columnWidths: number[], rowUpdates: string[]) {
    const nextSections = mainSections.map((section, index) => (index === sectionIndex ? { ...section, table, column_widths: columnWidths, table_row_updates: rowUpdates } : section))
    setMainSections(nextSections)
    void persistMainSections(nextSections)
  }

  function updateNestedSectionTable(tabIndex: number, sectionIndex: number, table: string[][], columnWidths: number[], rowUpdates: string[]) {
    const nextHighlights = highlights.map((tab, index) => {
      if (index !== tabIndex) return tab
      return { ...tab, sections: (tab.sections || []).map((section, nestedIndex) => (nestedIndex === sectionIndex ? { ...section, table, column_widths: columnWidths, table_row_updates: rowUpdates } : section)) }
    })
    setHighlights(nextHighlights)
    void persistHighlights(nextHighlights)
  }

  async function deleteMainSectionBlock(sectionIndex: number, blockId: string) {
    const nextSections = mainSections.map((section, itemIndex) => {
      if (itemIndex !== sectionIndex) return section
      const sourceBlocks = section.blocks?.length ? section.blocks : textToBlocks(section.info || "", section.line_updates || {}, currentRecord.updated_at)
      const blocks = sourceBlocks.filter((block) => block.id !== blockId)
      return { ...section, blocks, info: blocksToText(blocks) }
    })
    setMainSections(nextSections)
    setEditingMainSectionBlock(null)
    delete mainSectionEditStartRef.current[sectionIndex]
    try {
      await persistMainSections(nextSections)
      setMessage("Section saved.")
    } catch {
      setMessage("Unable to save section.")
    }
  }

  function renameMainSection(sectionIndex: number) {
    const section = mainSections[sectionIndex]
    if (!section) return
    const nextTitle = prompt("Section name", section.title || `SECTION ${sectionIndex + 1}`)?.trim()
    if (!nextTitle) return
    const nextSections = mainSections.map((item, itemIndex) => (itemIndex === sectionIndex ? { ...item, title: normalizeSectionTitle(nextTitle) } : item))
    setMainSections(nextSections)
    void persistMainSections(nextSections)
  }

  async function moveMainSection(sectionIndex: number, direction: -1 | 1) {
    const targetIndex = sectionIndex + direction
    if (targetIndex < 0 || targetIndex >= mainSections.length) return
    const nextSections = [...mainSections]
    const [moved] = nextSections.splice(sectionIndex, 1)
    nextSections.splice(targetIndex, 0, moved)
    setMainSections(nextSections)
    try {
      await persistMainSections(nextSections)
      setMessage("Section order updated.")
    } catch {
      setMessage("Unable to reorder sections.")
    }
  }

  async function deleteMainSection(sectionIndex: number) {
    if (!confirm("Delete this section?")) return
    const nextSections = mainSections.filter((_, index) => index !== sectionIndex)
    setMainSections(nextSections)
    try {
      await persistMainSections(nextSections)
      setMessage("Section deleted.")
    } catch {
      setMessage("Unable to delete section.")
    }
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
    setDraggingFolderPath("")
    setDropFolderPath(null)
    setCurrentCountryPorts([])
    setHighlights([])
    setMainInfoLineUpdates({})
    setMainInfoBlocks([])
    setMainSections([])
    setCountryMainBlocks([])
    setCountrySections([])
    setCountryTabs([])
    setMainInfoEditing(false)
    setCountryInfoEditing(false)
    setSectionEditing({})
    setEditingMainBlockId("")
    setEditingSectionBlock(null)
    setEditingNestedSectionBlock(null)
    setEditingMainSectionBlock(null)
    setEditingCountryBlockId("")
    setSelectedPreviewFile(null)
    setPreviewModalOpen(false)
    setFilePanelEditTarget(null)
    setFilePanelNameDraft("")
    setRecordModalOpen(false)
    setSearchInPage("")
    setActiveInfoTab("general")
  }

  async function loadCompany(id: string) {
    const [{ data, error }, filesResult, manualFilesResult, deletedLegacyFilesResult, deletedManualFilesResult, foldersResult] = await Promise.all([
      supabase.from("cc_companies").select("id,name,summary,notes,updated_at").eq("id", id).single(),
      fetchCompanyFiles(id),
      fetchEntryFiles("company", id),
      fetchDeletedCompanyFiles(id),
      fetchDeletedEntryFiles("company", id),
      fetchFolders("company", id),
    ])
    if (error || !data) throw error || new Error("Unable to load company")
    setCurrentRecord(data as BaseRecord)
    setCurrentCountry({ id: "", name: "", summary: "", notes: "" })
    const mergedFiles = [...filesResult, ...manualFilesResult]
    setFiles(mergedFiles)
    setDeletedFiles([...deletedLegacyFilesResult, ...deletedManualFilesResult].sort((a, b) => (b.deleted_at || "").localeCompare(a.deleted_at || "")))
    setFolders(mergeFolderRecords(foldersResult, mergedFiles))
    setCurrentFolderPath("")
    setCurrentCountryPorts([])
    const summaryMeta = parseSummaryMeta((data as BaseRecord).summary)
    setHighlights(summaryMeta.sections)
    setMainInfoLineUpdates(summaryMeta.mainLineUpdates)
    setMainInfoBlocks(compactBlocks(summaryMeta.mainBlocks, (data as BaseRecord).notes || "", (data as BaseRecord).updated_at))
    setMainSections(summaryMeta.mainSections)
    setCountryMainBlocks([])
    setCountrySections([])
    setCountryTabs([])
    setMainInfoEditing(false)
    setCountryInfoEditing(false)
    setSectionEditing({})
    setEditingMainBlockId("")
    setEditingSectionBlock(null)
    setEditingNestedSectionBlock(null)
    setEditingMainSectionBlock(null)
    setSelectedPreviewFile(null)
    setPreviewModalOpen(false)
    setFilePanelEditTarget(null)
    setFilePanelNameDraft("")
    setRecordModalOpen(false)
    setActiveInfoTab("general")
  }

  async function loadCountry(id: string) {
    const [{ data, error }, filesResult, deletedFilesResult, foldersResult] = await Promise.all([
      supabase.from("cc_countries").select("id,name,summary,notes,region,updated_at").eq("id", id).single(),
      fetchEntryFiles("country", id),
      fetchDeletedEntryFiles("country", id),
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
    setDeletedFiles(deletedFilesResult)
    setFolders(foldersResult)
    setCurrentFolderPath("")
    setCurrentCountryPorts((portsResult.data as CountryPortListItem[]) || [])
    const summaryMeta = parseSummaryMeta((data as BaseRecord).summary)
    setHighlights(summaryMeta.sections)
    setMainInfoLineUpdates(summaryMeta.mainLineUpdates)
    setMainInfoBlocks(compactBlocks(summaryMeta.mainBlocks, (data as BaseRecord).notes || "", (data as BaseRecord).updated_at))
    setMainSections(summaryMeta.mainSections)
    setCountryMainBlocks([])
    setCountrySections([])
    setCountryTabs([])
    setMainInfoEditing(false)
    setCountryInfoEditing(false)
    setSectionEditing({})
    setEditingMainBlockId("")
    setEditingSectionBlock(null)
    setEditingNestedSectionBlock(null)
    setEditingMainSectionBlock(null)
    setSelectedPreviewFile(null)
    setPreviewModalOpen(false)
    setFilePanelEditTarget(null)
    setFilePanelNameDraft("")
    setRecordModalOpen(false)
    setActiveInfoTab("general")
  }

  async function loadPort(id: string) {
    const [{ data, error }, filesResult, deletedFilesResult, foldersResult] = await Promise.all([
      supabase.from("cc_ports").select("id,name,summary,notes,country_id,country_name,updated_at").eq("id", id).single(),
      fetchEntryFiles("port", id),
      fetchDeletedEntryFiles("port", id),
      fetchFolders("port", id),
    ])
    if (error || !data) throw error || new Error("Unable to load port")
    const port = data as PortRecord
    setCurrentRecord(port)
    setFiles(filesResult)
    setDeletedFiles(deletedFilesResult)
    setFolders(foldersResult)
    setCurrentFolderPath("")
    setCurrentCountryPorts([])
    const summaryMeta = parseSummaryMeta(port.summary)
    setHighlights(summaryMeta.sections)
    setMainInfoLineUpdates(summaryMeta.mainLineUpdates)
    setMainInfoBlocks(compactBlocks(summaryMeta.mainBlocks, port.notes || "", port.updated_at))
    setMainSections(summaryMeta.mainSections)
    setMainInfoEditing(false)
    setCountryInfoEditing(false)
    setSectionEditing({})
    setEditingMainBlockId("")
    setEditingSectionBlock(null)
    setEditingNestedSectionBlock(null)
    setEditingMainSectionBlock(null)
    setEditingCountryBlockId("")
    setSelectedPreviewFile(null)
    setPreviewModalOpen(false)
    setFilePanelEditTarget(null)
    setFilePanelNameDraft("")
    setRecordModalOpen(false)
    setActiveInfoTab("general")

    if (port.country_id) {
      const { data: countryData } = await supabase.from("cc_countries").select("id,name,summary,notes,region,updated_at").eq("id", port.country_id).single()
      const country = (countryData as CountryRecord) || { id: "", name: port.country_name || "", summary: "", notes: "" }
      const countryMeta = parseSummaryMeta(country.summary)
      setCurrentCountry(country)
      setCountryMainBlocks(compactBlocks(countryMeta.mainBlocks, country.notes || "", country.updated_at))
      setCountrySections(countryMeta.mainSections)
      setCountryTabs(countryMeta.sections)
    } else if (port.country_name?.trim()) {
      const { data: countryData } = await supabase
        .from("cc_countries")
        .select("id,name,summary,notes,region,updated_at")
        .ilike("name", port.country_name.trim())
        .limit(1)
        .maybeSingle()

      const country = (countryData as CountryRecord) || { id: "", name: port.country_name || "", summary: "", notes: "" }
      const countryMeta = parseSummaryMeta(country.summary)
      setCurrentCountry(country)
      setCountryMainBlocks(compactBlocks(countryMeta.mainBlocks, country.notes || "", country.updated_at))
      setCountrySections(countryMeta.mainSections)
      setCountryTabs(countryMeta.sections)
    } else {
      setCurrentCountry({ id: "", name: port.country_name || "", summary: "", notes: "" })
      setCountryMainBlocks([])
      setCountrySections([])
      setCountryTabs([])
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
    setAddPortDraft({ name: "", notes: "", countryId: "", countryName: "" })
    setAddPortModalOpen(true)
  }

  function openRecordModal() {
    if (!selectedId || !selectedKind) return
    setRecordNameDraft(currentRecord.name.trim())
    setRecordModalOpen(true)
  }

  async function saveRecordNameFromModal() {
    if (!selectedId || !selectedKind) return
    const currentName = currentRecord.name.trim()
    const nextName = recordNameDraft.trim().toUpperCase()
    if (!nextName || nextName === currentName) return
    const table = selectedKind === "company" ? "cc_companies" : selectedKind === "country" ? "cc_countries" : "cc_ports"
    setSaving(true)
    try {
      const { error } = await supabase.from(table).update({ name: nextName }).eq("id", selectedId)
      if (error) throw error
      setCurrentRecord((prev) => ({ ...prev, name: nextName }))
      if (selectedKind === "country") {
        setCurrentCountry((prev) => ({ ...prev, name: nextName }))
        await supabase.from("cc_ports").update({ country_name: nextName }).eq("country_id", selectedId)
        await supabase.from("cc_ports").update({ country_name: nextName }).eq("country_name", currentName)
      }
      setMessage("Renamed.")
      setRecordModalOpen(false)
    } catch {
      setMessage("Unable to rename.")
    } finally {
      setSaving(false)
    }
  }

  function openAddPortForCurrentCountry() {
    if (selectedKind !== "country" || !selectedId) return
    setAddPortDraft({ name: "", notes: "", countryId: selectedId, countryName: currentRecord.name.trim().toUpperCase() })
    setAddPortModalOpen(true)
  }

  async function addPort() {
    if (!addPortDraft.name.trim()) {
      setMessage("Port name is required.")
      return
    }
    const matchedCountry = countryOptions.find((country) => country.id === addPortDraft.countryId || country.name === addPortDraft.countryName.trim().toUpperCase())
    if (!matchedCountry) {
      setMessage("Country is required. Please select an existing country.")
      return
    }
    const { data, error } = await supabase
      .from("cc_ports")
      .insert({ name: addPortDraft.name.trim().toUpperCase(), summary: null, notes: addPortDraft.notes || "", country_id: matchedCountry.id, country_name: matchedCountry.name, tags: [], status: "active" })
      .select("id,name,summary,notes")
      .single()
    if (error || !data) {
      setMessage("Unable to add port.")
      return
    }
    const nextPort = data as CountryPortListItem
    if (selectedKind === "country" && selectedId === matchedCountry.id) {
      setCurrentCountryPorts((prev) => [...prev, nextPort].sort((a, b) => a.name.localeCompare(b.name)))
    }
    setAddPortModalOpen(false)
    setAddPortDraft({ name: "", notes: "", countryId: "", countryName: "" })
    addSimpleChangeLog(`${matchedCountry.name} New Port Added`)
    setMessage("Port added.")
    await loadSelected("port", nextPort.id)
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
    const nextTitle = prompt("Tab name", current.title || `TAB ${index + 1}`)?.trim()
    if (!nextTitle) return
    const normalizedTitle = normalizeSectionTitle(nextTitle)
    if (normalizedTitle === current.title) return
    const nextHighlights = highlights.map((item, itemIndex) => (itemIndex === index ? { ...item, title: normalizedTitle } : item))
    setHighlights(nextHighlights)
    void persistHighlights(nextHighlights)
  }

  async function saveRecord() {
    if (!selectedId || !selectedKind) return
    setSaving(true)
    setMessage("")
    try {
      if (selectedKind === "company") {
        const { error } = await supabase.from("cc_companies").update({ name: currentRecord.name.trim().toUpperCase(), summary: serializeSummaryMeta(highlights, mainInfoLineUpdates, mainInfoBlocks, mainSections), notes: currentRecord.notes || null }).eq("id", selectedId)
        if (error) throw error
      }
      if (selectedKind === "country") {
        const { error } = await supabase.from("cc_countries").update({ name: currentRecord.name.trim().toUpperCase(), summary: serializeSummaryMeta(highlights, mainInfoLineUpdates, mainInfoBlocks, mainSections), notes: currentRecord.notes || null }).eq("id", selectedId)
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
          summary: serializeSummaryMeta(highlights, mainInfoLineUpdates, mainInfoBlocks, mainSections),
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
      if (selectedKind === "country") {
        const deletePorts = confirm(`Also delete all ports under ${currentRecord.name}?`)
        if (deletePorts) {
          const extraWarning = confirm(`Final warning: this will permanently delete ${currentRecord.name} and all ports under this country. Continue?`)
          if (!extraWarning) return
          const { error: portError } = await supabase
            .from("cc_ports")
            .delete()
            .or(`country_id.eq.${selectedId},country_name.eq.${currentRecord.name.replace(/,/g, "\\,")}`)
          if (portError) throw portError
        }
      }
      const table = selectedKind === "company" ? "cc_companies" : selectedKind === "country" ? "cc_countries" : "cc_ports"
      const { error } = await supabase.from(table).delete().eq("id", selectedId)
      if (error) throw error
      setMessage("Deleted.")
      setRecordModalOpen(false)
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
    const payload = { summary: serializeSummaryMeta(nextHighlights, mainInfoLineUpdates, mainInfoBlocks, mainSections) }
    const table = selectedKind === "company" ? "cc_companies" : selectedKind === "country" ? "cc_countries" : "cc_ports"
    const { error } = await supabase.from(table).update(payload).eq("id", selectedId)
    if (error) throw error
  }

  async function persistMainSections(nextSections: HighlightCard[]) {
    if (!selectedId || !selectedKind) return
    const table = selectedKind === "company" ? "cc_companies" : selectedKind === "country" ? "cc_countries" : "cc_ports"
    const { error } = await supabase.from(table).update({ summary: serializeSummaryMeta(highlights, mainInfoLineUpdates, mainInfoBlocks, nextSections) }).eq("id", selectedId)
    if (error) throw error
  }

  async function saveHighlightCard() {
    if (!highlightDraft.title.trim()) {
      setHighlightModalOpen(false)
      setHighlightDraft({ title: "", info: "" })
      return
    }
    const firstBlock = { id: newBlockId(), content: "", updated_at: new Date().toISOString() }
    if ((highlightModalMode === "section" || highlightModalMode === "table") && activeInfoTab === "general") {
      const nextSection: HighlightCard = highlightModalMode === "table"
        ? { title: normalizeSectionTitle(highlightDraft.title || "TABLE"), info: "", blocks: [], table: [["", ""], ["", ""]], table_row_updates: [new Date().toISOString(), new Date().toISOString()] }
        : { title: normalizeSectionTitle(highlightDraft.title), info: "", blocks: [firstBlock] }
      const nextSections = [...mainSections, nextSection]
      setMainSections(nextSections)
      if (highlightModalMode === "section") setEditingMainSectionBlock({ sectionIndex: nextSections.length - 1, blockId: firstBlock.id })
      setHighlightDraft({ title: "", info: "" })
      setHighlightModalOpen(false)
      try {
        await persistMainSections(nextSections)
        if (selectedKind) addSimpleChangeLog(`${changeLogSubject(selectedKind, currentRecord.name)} New Section Added`)
        setMessage("Section saved.")
      } catch {
        setMessage("Unable to save section.")
      }
      return
    }
    if ((highlightModalMode === "section" || highlightModalMode === "table") && activeInfoTab.startsWith("section-")) {
      const tabIndex = Number(activeInfoTab.replace("section-", ""))
      const nextHighlights = highlights.map((item, itemIndex) => {
        if (itemIndex !== tabIndex) return item
        const nextSection: HighlightCard = highlightModalMode === "table"
          ? { title: normalizeSectionTitle(highlightDraft.title || "TABLE"), info: "", blocks: [], table: [["", ""], ["", ""]], table_row_updates: [new Date().toISOString(), new Date().toISOString()] }
          : { title: normalizeSectionTitle(highlightDraft.title), info: "", blocks: [firstBlock] }
        return {
          ...item,
          sections: [...(item.sections || []), nextSection],
        }
      })
      setHighlights(nextHighlights)
      if (highlightModalMode === "section") setEditingNestedSectionBlock({ tabIndex, sectionIndex: (highlights[tabIndex]?.sections || []).length, blockId: firstBlock.id })
      setHighlightDraft({ title: "", info: "" })
      setHighlightModalOpen(false)
      try {
        await persistHighlights(nextHighlights)
        if (selectedKind) addSimpleChangeLog(`${changeLogSubject(selectedKind, currentRecord.name)} New Section Added`)
        setMessage("Section saved.")
      } catch {
        setMessage("Unable to save section.")
      }
      return
    }
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
        const { error } = await supabase.from(table).update({ notes: nextNotes, summary: serializeSummaryMeta(highlights, nextLineUpdates, nextBlocks, mainSections) }).eq("id", selectedId)
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
      const { error } = await supabase.from(table).update({ notes: nextNotes, summary: serializeSummaryMeta(highlights, nextLineUpdates, nextBlocks, mainSections) }).eq("id", selectedId)
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
    if (!confirm("Delete this tab?")) return
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

  async function refreshDeletedFiles(kind: RecordKind, id: string) {
    if (kind === "company") {
      const [legacyFiles, manualFiles] = await Promise.all([fetchDeletedCompanyFiles(id), fetchDeletedEntryFiles("company", id)])
      return [...legacyFiles, ...manualFiles].sort((a, b) => (b.deleted_at || "").localeCompare(a.deleted_at || ""))
    }
    return fetchDeletedEntryFiles(kind, id)
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
      setDeletedFiles(await refreshDeletedFiles(selectedKind, selectedId))
      setFolders((prev) => mergeFolderRecords(prev.filter((folder) => !folder.id.startsWith("virtual:")), refreshedFiles))
      const targetFile = refreshedFiles.find((file) => file.file_name === uploaded[uploaded.length - 1]?.file_name && (file.folder_path || "") === currentFolderPath)
      setSelectedPreviewFile(targetFile || refreshedFiles[0] || uploaded[0] || null)
      addSimpleChangeLog(`${changeLogSubject(selectedKind, currentRecord.name)} File Uploaded`)
      void loadRecentAuditLogs()
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
      setFolders((prev) => mergeFolderRecords([...prev.filter((folder) => !folder.id.startsWith("virtual:")), nextFolder], files))
      setCurrentFolderPath(joinFolderPath(nextFolder.folder_path, nextFolder.name))
      void loadRecentAuditLogs()
      setMessage("Folder created.")
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to create folder.")
    }
  }

  function openFilePanelEditor(target: FilePanelEditTarget) {
    setFilePanelEditTarget(target)
    setFilePanelNameDraft(target.type === "folder" ? target.item.name : target.item.file_name)
  }

  async function renameFile(file: CompanyFileRecord | EntryFileRecord, nextNameInput?: string) {
    const nextName = (nextNameInput ?? window.prompt("File name", file.file_name) ?? "").trim()
    if (!nextName || nextName === file.file_name) return
    try {
      const response = await fetch("/api/ccinfo/files", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "renameFile",
          fileId: file.id,
          source: file.source || "entry",
          name: nextName,
          entryKind: selectedKind,
          entryId: selectedId,
          entryName: currentRecord.name || "Untitled",
        }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.message || "Unable to rename file.")
      if (selectedId && selectedKind) {
        const refreshedFiles = await refreshFiles(selectedKind, selectedId)
        setFiles(refreshedFiles)
        setFolders((prev) => mergeFolderRecords(prev.filter((item) => !item.id.startsWith("virtual:")), refreshedFiles))
        setDeletedFiles(await refreshDeletedFiles(selectedKind, selectedId))
        setSelectedPreviewFile((current) => {
          if (current?.id !== file.id) return current
          return refreshedFiles.find((item) => item.id === file.id) || null
        })
      }
      setFilePanelEditTarget(null)
      void loadRecentAuditLogs()
      setMessage("File renamed.")
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to rename file.")
    }
  }

  async function renameFolder(folder: EntryFolderRecord, nextNameInput?: string) {
    const nextName = (nextNameInput ?? window.prompt("Folder name", folder.name) ?? "").trim()
    if (!nextName || nextName === folder.name) return
    const folderPath = joinFolderPath(folder.folder_path, folder.name)
    try {
      const response = await fetch("/api/ccinfo/files", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "renameFolder",
          folderId: folder.id,
          source: folder.id.startsWith("virtual:") ? "company" : "entry",
          folderPath,
          name: nextName,
          entryKind: selectedKind,
          entryId: selectedId,
          entryName: currentRecord.name || "Untitled",
        }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.message || "Unable to rename folder.")
      const refreshedFiles = selectedId && selectedKind ? await refreshFiles(selectedKind, selectedId) : files
      setFiles(refreshedFiles)
      setFolders((prev) => mergeFolderRecords(prev.filter((item) => !item.id.startsWith("virtual:")).map((item) => item.id === folder.id ? { ...item, name: nextName } : item), refreshedFiles))
      const nextPath = joinFolderPath(folder.folder_path, nextName)
      if (currentFolderPath === folderPath) setCurrentFolderPath(nextPath)
      setFilePanelEditTarget(null)
      void loadRecentAuditLogs()
      setMessage("Folder renamed.")
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to rename folder.")
    }
  }

  async function deleteFolder(folder: EntryFolderRecord) {
    const folderPath = joinFolderPath(folder.folder_path, folder.name)
    if (folder.id.startsWith("virtual:")) {
      if (!confirm(`Move all files inside ${folder.name} to Recently Deleted?`)) return
      try {
        const response = await fetch("/api/ccinfo/files", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "deleteFolderContents",
            source: "company",
            entryKind: selectedKind,
            entryId: selectedId,
            folderPath,
          }),
        })
        const data = await response.json()
        if (!response.ok) throw new Error(data.message || "Unable to delete folder contents.")
        if (selectedId && selectedKind) {
          const refreshedFiles = await refreshFiles(selectedKind, selectedId)
          setFiles(refreshedFiles)
          setFolders((prev) => mergeFolderRecords(prev.filter((item) => !item.id.startsWith("virtual:")), refreshedFiles))
          setDeletedFiles(await refreshDeletedFiles(selectedKind, selectedId))
        }
        if (currentFolderPath === folderPath || currentFolderPath.startsWith(`${folderPath}/`)) {
          setCurrentFolderPath(folder.folder_path || "")
        }
        setFilePanelEditTarget(null)
        void loadRecentAuditLogs()
        setMessage("Folder contents moved to Recently Deleted.")
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Unable to delete folder contents.")
      }
      return
    }

    const hasNestedFolders = folders.some((item) => joinFolderPath(item.folder_path, item.name).startsWith(`${folderPath}/`))
    const hasNestedFiles = files.some((item) => (item.folder_path || "").startsWith(folderPath))
    if (hasNestedFolders || hasNestedFiles) {
      setMessage("Move or delete files and subfolders inside this folder first.")
      return
    }
    if (!confirm(`Delete folder ${folder.name}?`)) return
    try {
      const params = new URLSearchParams({ folderId: folder.id })
      const response = await fetch(`/api/ccinfo/files?${params.toString()}`, { method: "DELETE" })
      const data = await response.json()
      if (!response.ok) throw new Error(data.message || "Unable to delete folder.")
      setFolders((prev) => prev.filter((item) => item.id !== folder.id))
      if (currentFolderPath === folderPath) {
        setCurrentFolderPath(folder.folder_path || "")
      }
      setFilePanelEditTarget(null)
      void loadRecentAuditLogs()
      setMessage("Folder deleted.")
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to delete folder.")
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
      if (selectedId && selectedKind) {
        setDeletedFiles(await refreshDeletedFiles(selectedKind, selectedId))
      }
      if (selectedPreviewFile?.id === file.id) {
        setSelectedPreviewFile(null)
        setPreviewModalOpen(false)
      }
      setFilePanelEditTarget(null)
      void loadRecentAuditLogs()
      setMessage("File moved to Recently Deleted.")
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to delete file.")
    }
  }

  async function saveFilePanelEdit() {
    if (!filePanelEditTarget) return
    if (filePanelEditTarget.type === "folder") {
      await renameFolder(filePanelEditTarget.item, filePanelNameDraft)
      return
    }
    await renameFile(filePanelEditTarget.item, filePanelNameDraft)
  }

  async function deleteFilePanelTarget() {
    if (!filePanelEditTarget) return
    if (filePanelEditTarget.type === "folder") {
      await deleteFolder(filePanelEditTarget.item)
      return
    }
    await deleteFile(filePanelEditTarget.item)
  }

  async function restoreFile(file: CompanyFileRecord | EntryFileRecord) {
    try {
      const response = await fetch("/api/ccinfo/files", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "restore",
          fileId: file.id,
          source: file.source || "entry",
        }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.message || "Unable to restore file.")
      if (selectedId && selectedKind) {
        const refreshedFiles = await refreshFiles(selectedKind, selectedId)
        setFiles(refreshedFiles)
        setFolders((prev) => mergeFolderRecords(prev.filter((folder) => !folder.id.startsWith("virtual:")), refreshedFiles))
        setDeletedFiles(await refreshDeletedFiles(selectedKind, selectedId))
      }
      void loadRecentAuditLogs()
      setMessage("File restored.")
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to restore file.")
    }
  }

  async function undoDeletedFile(file: CompanyFileRecord | EntryFileRecord) {
    const actionId = `deleted-file:${file.id}`
    setAuditActionId(actionId)
    try {
      await restoreFile(file)
    } finally {
      setAuditActionId("")
    }
  }

  function folderHasFileSource(folderPath: string, source: "company" | "entry") {
    return files.some((file) => {
      const fileFolderPath = file.folder_path || ""
      return file.source === source && (fileFolderPath === folderPath || fileFolderPath.startsWith(`${folderPath}/`))
    })
  }

  function folderMoveSources(folder: EntryFolderRecord) {
    const folderPath = joinFolderPath(folder.folder_path, folder.name)
    const sources: Array<"company" | "entry"> = []
    if (selectedKind === "company" && folderHasFileSource(folderPath, "company")) sources.push("company")
    if (!folder.id.startsWith("virtual:") || folderHasFileSource(folderPath, "entry")) sources.push("entry")
    return sources
  }

  async function moveFolderToPath(folder: EntryFolderRecord, targetFolderPath: string) {
    if (!selectedId || !selectedKind) return
    const folderPath = joinFolderPath(folder.folder_path, folder.name)
    if (!canMoveFolderToPath(folderPath, targetFolderPath)) return
    try {
      const sources = folderMoveSources(folder)
      for (const source of sources) {
        const response = await fetch("/api/ccinfo/files", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "moveFolder",
            folderId: folder.id,
            source,
            entryKind: selectedKind,
            entryId: selectedId,
            entryName: currentRecord.name || "Untitled",
            folderPath,
            targetFolderPath,
          }),
        })
        const data = await response.json()
        if (!response.ok) throw new Error(data.message || "Unable to move folder.")
      }
      const refreshedFiles = await refreshFiles(selectedKind, selectedId)
      const refreshedFolders = mergeFolderRecords((await fetchFolders(selectedKind, selectedId)).filter((item) => !item.id.startsWith("virtual:")), refreshedFiles)
      setFiles(refreshedFiles)
      setFolders(refreshedFolders)
      setDeletedFiles(await refreshDeletedFiles(selectedKind, selectedId))
      if (currentFolderPath === folderPath || currentFolderPath.startsWith(`${folderPath}/`)) {
        setCurrentFolderPath(rebaseFolderPath(currentFolderPath, folderPath, targetFolderPath))
      }
      void loadRecentAuditLogs()
      setMessage("Folder moved.")
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to move folder.")
    } finally {
      setDraggingFolderPath("")
      setDropFolderPath(null)
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
      setFolders((prev) => mergeFolderRecords(prev.filter((folder) => !folder.id.startsWith("virtual:")), refreshedFiles))
      setDeletedFiles(await refreshDeletedFiles(selectedKind, selectedId))
      void loadRecentAuditLogs()
      setMessage("File moved.")
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to move file.")
    } finally {
      setDraggingFileId("")
      setDropFolderPath(null)
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

  async function openPortInline(id: string) {
    await loadSelected("port", id)
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href)
      url.searchParams.set("kind", "port")
      url.searchParams.set("id", id)
      window.history.replaceState({}, "", url.toString())
    }
    setSearchInPage("")
  }

  async function openCountryInline(id: string) {
    await loadSelected("country", id)
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href)
      url.searchParams.set("kind", "country")
      url.searchParams.set("id", id)
      window.history.replaceState({}, "", url.toString())
    }
    setSearchInPage("")
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
  const recordDeleteLabel =
    selectedKind === "country"
      ? "Delete this Country"
      : selectedKind === "port"
        ? "Delete this Port"
        : selectedKind === "company"
          ? "Delete this Company"
          : "Delete this Entry"
  const informationLabel =
    selectedKind === "port"
      ? "Port Information"
      : "General Information"
  const mainInfoTabLabel = selectedKind === "port" ? "PORT INFORMATION" : "GENERAL INFORMATION"
  const fixedTabBackground = "var(--fc-admin-button-bg)"
  const fixedTabActiveBackground = "var(--fc-admin-selected-bg)"
  const userTabBackground = "var(--fc-admin-button-bg)"
  const userTabActiveBackground = "var(--fc-admin-selected-bg)"
  const countryInformationLabel = selectedKind === "port" ? "General Information" : "Country Information"
  const previewUrl = selectedPreviewFile ? getPreviewUrl(selectedPreviewFile) : ""
  const draggingFolder = draggingFolderPath ? folders.find((folder) => joinFolderPath(folder.folder_path, folder.name) === draggingFolderPath) : null
  const canDropOnFolderPath = (targetFolderPath: string) => Boolean(draggingFileId) || Boolean(draggingFolderPath && canMoveFolderToPath(draggingFolderPath, targetFolderPath))
  const handleFolderPathDragOver = (event: React.DragEvent, targetFolderPath: string) => {
    if (!canDropOnFolderPath(targetFolderPath)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = "move"
    setDropFolderPath(targetFolderPath)
  }
  const handleFolderPathDrop = (event: React.DragEvent, targetFolderPath: string) => {
    if (!canDropOnFolderPath(targetFolderPath)) return
    event.preventDefault()
    const fileId = event.dataTransfer.getData("application/x-ccinfo-file") || event.dataTransfer.getData("text/plain")
    if (draggingFileId || fileId) {
      const file = files.find((item) => item.id === (fileId || draggingFileId))
      if (file) void moveFileToFolder(file, targetFolderPath)
      return
    }
    if (draggingFolder) void moveFolderToPath(draggingFolder, targetFolderPath)
  }
  const clearFolderDropTarget = (targetFolderPath: string) => {
    if (dropFolderPath === targetFolderPath) setDropFolderPath(null)
  }
  const folderDropButtonStyle = (targetFolderPath: string, active: boolean): React.CSSProperties => {
    const isDropTarget = dropFolderPath === targetFolderPath && canDropOnFolderPath(targetFolderPath)
    return {
      ...buttonStyle,
      padding: "5px 8px",
      fontSize: "10px",
      background: isDropTarget ? "var(--fc-admin-success-bg)" : "#ffffff",
      border: isDropTarget ? "1px dashed var(--fc-admin-success-border)" : "none",
      boxShadow: isDropTarget ? "0 0 0 3px #2f9e4430" : "none",
      color: isDropTarget || active ? "var(--fc-admin-panel-text)" : "var(--fc-admin-muted)",
      transform: isDropTarget ? "translateY(-1px)" : "none",
    }
  }
  const fileSection = !initialMode ? (
    <div style={{ ...panelStyle, padding: "12px", display: "grid", gap: "10px" }}>
      <div style={{ fontSize: "12px", letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--fc-admin-link)", fontWeight: 700 }}>
        Files
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", alignItems: "center" }}>
        <button
          type="button"
          onClick={() => setCurrentFolderPath("")}
          onDragOver={(event) => handleFolderPathDragOver(event, "")}
          onDragLeave={() => clearFolderDropTarget("")}
          onDrop={(event) => handleFolderPathDrop(event, "")}
          style={folderDropButtonStyle("", !currentFolderPath)}
        >
          HOME
        </button>
        {breadcrumbSegments.length > 0 && <span style={{ color: "var(--fc-admin-muted)", fontSize: "11px" }}>&gt;</span>}
        {breadcrumbSegments.map((segment, index) => {
          const path = breadcrumbSegments.slice(0, index + 1).join("/")
          const active = path === currentFolderPath
          return (
            <div key={path} style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
            <button
              type="button"
              onClick={() => setCurrentFolderPath(path)}
              onDragOver={(event) => handleFolderPathDragOver(event, path)}
              onDragLeave={() => clearFolderDropTarget(path)}
              onDrop={(event) => handleFolderPathDrop(event, path)}
              style={folderDropButtonStyle(path, active)}
            >
              {segment}
            </button>
            {index < breadcrumbSegments.length - 1 ? <span style={{ color: "var(--fc-admin-muted)", fontSize: "11px" }}>&gt;</span> : null}
            </div>
          )
        })}
      </div>
      <div style={{ display: "grid", gap: "6px", maxHeight: isMobile ? "240px" : "56vh", overflowY: "auto", paddingRight: "2px" }}>
        {visibleFolders.length === 0 && visibleFiles.length === 0 ? (
          <div style={{ color: "var(--fc-admin-muted)", fontSize: "12px" }}>No linked files yet.</div>
        ) : (
          <>
            {visibleFolders.map((folder) => {
              const folderPath = joinFolderPath(folder.folder_path, folder.name)
              return (
                <div
                  key={folder.id}
                  onClick={() => setCurrentFolderPath(folderPath)}
                  onDoubleClick={() => setCurrentFolderPath(folderPath)}
                  draggable
                  onDragStart={(event) => {
                    setDraggingFolderPath(folderPath)
                    event.dataTransfer.setData("application/x-ccinfo-folder", folderPath)
                    event.dataTransfer.effectAllowed = "move"
                  }}
                  onDragEnd={() => {
                    setDraggingFolderPath("")
                    setDropFolderPath(null)
                  }}
                  onDragOver={(event) => handleFolderPathDragOver(event, folderPath)}
                  onDragLeave={() => clearFolderDropTarget(folderPath)}
                  onDrop={(event) => handleFolderPathDrop(event, folderPath)}
                  style={{
                    display: "grid",
                    gridTemplateColumns: isMobile ? "32px minmax(0,1fr)" : "42px minmax(0,1fr) auto",
                    gap: "8px",
                    alignItems: "center",
                    padding: "7px 8px",
                    borderRadius: "10px",
                    border:
                      dropFolderPath === folderPath && canDropOnFolderPath(folderPath)
                        ? "1px dashed var(--fc-admin-success-border)"
                        : "1px solid var(--fc-admin-border-soft)",
                    background:
                      dropFolderPath === folderPath && canDropOnFolderPath(folderPath)
                        ? "var(--fc-admin-success-bg)"
                        : "var(--fc-tool-input-bg)",
                    color: "var(--fc-admin-panel-text)",
                    cursor: "pointer",
                    boxShadow: dropFolderPath === folderPath && canDropOnFolderPath(folderPath) ? "0 0 0 3px #2f9e4430" : "none",
                    opacity: draggingFolderPath === folderPath ? 0.62 : 1,
                    transform: dropFolderPath === folderPath && canDropOnFolderPath(folderPath) ? "translateY(-1px)" : "none",
                  }}
                >
                  <FolderIcon />
                  <span style={{ fontSize: "11px", lineHeight: 1.35, overflowWrap: "anywhere" }}>
                    <HighlightedInlineText value={folder.name} query={searchInPage} />
                  </span>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation()
                      openFilePanelEditor({ type: "folder", item: folder })
                    }}
                    style={{ ...buttonStyle, padding: "4px 7px", fontSize: "10px" }}
                  >
                    Edit
                  </button>
                </div>
              )
            })}
            {visibleFiles.map((file) => {
            const active = selectedPreviewFile?.id === file.id
            const fileTypeVisual = getFileTypeLabel(file.file_name, file.file_type)
            return (
              <div
                key={file.id}
                onClick={() => setSelectedPreviewFile(file)}
                onDoubleClick={() => {
                  setSelectedPreviewFile(file)
                  if (file.drive_url) {
                    window.open(file.drive_url, "_blank", "noopener,noreferrer")
                    return
                  }
                  setPreviewModalOpen(true)
                }}
                draggable
                onDragStart={(event) => {
                  setDraggingFileId(file.id)
                  event.dataTransfer.setData("application/x-ccinfo-file", file.id)
                  event.dataTransfer.setData("text/plain", file.id)
                  event.dataTransfer.effectAllowed = "move"
                }}
                onDragEnd={() => {
                  setDraggingFileId("")
                  setDropFolderPath(null)
                }}
                style={{
                  display: "grid",
                  gridTemplateColumns: isMobile ? "32px minmax(0,1fr)" : "42px minmax(0,1fr) auto",
                  gap: "8px",
                  alignItems: "center",
                  padding: "7px 8px",
                  borderRadius: "10px",
                  border: active ? "1px solid var(--fc-admin-selected-border)" : "1px solid var(--fc-admin-border-soft)",
                  background: active ? "var(--fc-admin-selected-bg)" : "var(--fc-tool-input-bg)",
                  opacity: draggingFileId === file.id ? 0.6 : 1,
                  cursor: "grab",
                }}
              >
                <DriveFileIcon color={fileTypeVisual.color} label={fileTypeVisual.label} />
                <button
                  type="button"
                  onClick={() => {
                    setSelectedPreviewFile(file)
                  }}
                  style={{
                    border: "none",
                    background: "transparent",
                    color: "var(--fc-admin-panel-text)",
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
                    onClick={() => openFilePanelEditor({ type: "file", item: file })}
                    style={{ ...buttonStyle, padding: "4px 7px", fontSize: "10px" }}
                  >
                    Edit
                  </button>
                )}
                {isMobile && (
                  <button
                    type="button"
                    onClick={() => openFilePanelEditor({ type: "file", item: file })}
                    style={{ ...buttonStyle, gridColumn: "2", justifySelf: "start", padding: "4px 7px", fontSize: "10px" }}
                  >
                    Edit
                  </button>
                )}
              </div>
            )
            })}
          </>
        )}
      </div>
      <a
        href={selectedPreviewFile?.drive_url || "#"}
        target={selectedPreviewFile?.drive_url ? "_blank" : undefined}
        rel={selectedPreviewFile?.drive_url ? "noreferrer" : undefined}
        onClick={(event) => {
          if (!selectedPreviewFile?.drive_url) event.preventDefault()
        }}
        aria-disabled={selectedPreviewFile?.drive_url ? undefined : true}
        style={{
          ...buttonStyle,
          display: "block",
          textAlign: "center",
          opacity: selectedPreviewFile?.drive_url ? 1 : 0.55,
          pointerEvents: "auto",
        }}
      >
          Open In Drive
      </a>
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
              <div style={{ fontSize: "12px", letterSpacing: "0.16em", textTransform: "uppercase", color: "var(--fc-admin-link)", fontWeight: 700, marginBottom: "12px" }}>
                Country And Company Info
              </div>
              <input ref={filePickerRef} type="file" multiple style={{ display: "none" }} onChange={handleUploadSelection} />
              <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 54px", gap: "8px", alignItems: "center", marginBottom: "16px" }}>
                <a href="/admin" className="fc-admin-nav-button" style={{ ...buttonStyle, display: "block", textAlign: "center" }}>
                  Back
                </a>
                <div style={{ position: "relative" }}>
                  <button
                    onClick={() => setMenuOpen((prev) => !prev)}
                    className="fc-admin-menu-button"
                    aria-label="Open menu"
                    style={menuButtonStyle}
                  >
                    <MenuGlyph />
                  </button>
                  {menuOpen && (
                    <div
                      style={{ ...panelStyle, position: "absolute", right: 0, top: "48px", padding: "8px", display: "grid", gap: "6px", minWidth: "150px", zIndex: 20 }}
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

              {!initialMode && (
                <div style={{ ...panelStyle, padding: "12px", display: "grid", gap: "10px" }}>
                  <div style={{ fontSize: "12px", letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--fc-admin-link)", fontWeight: 700 }}>
                    Search In Page
                  </div>
                  <input value={searchInPage} onChange={(e) => setSearchInPage(e.target.value)} onKeyDown={handleSearchInPageKeyDown} disabled={initialMode} placeholder={initialMode ? "Open an entry first" : ""} style={{ ...inputStyle, opacity: initialMode ? 0.58 : 1 }} />
                  {searchInPage.trim() && (
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
                      <div style={{ color: "var(--fc-admin-muted)", fontSize: "13px", fontWeight: 700 }}>
                        {matchCount === 0 ? "0/0" : `${Math.min(matchIndex + 1, matchCount)}/${matchCount}`}
                      </div>
                      <div style={{ display: "flex", gap: "6px" }}>
                        <button type="button" onClick={goToPreviousMatch} disabled={matchCount === 0} style={{ ...buttonStyle, minWidth: "34px", padding: "6px 8px", fontSize: "11px", opacity: matchCount === 0 ? 0.45 : 1 }}>&lt;</button>
                        <button type="button" onClick={goToNextMatch} disabled={matchCount === 0} style={{ ...buttonStyle, minWidth: "34px", padding: "6px 8px", fontSize: "11px", opacity: matchCount === 0 ? 0.45 : 1 }}>&gt;</button>
                      </div>
                    </div>
                  )}
                  <div style={{ display: "grid", gap: "8px", borderTop: "1px solid var(--fc-admin-border-soft)", paddingTop: "10px" }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
                      <div style={{ fontSize: "10px", letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--fc-admin-link)", fontWeight: 800 }}>Recent Changes</div>
                      <button
                        type="button"
                        onClick={() => void refreshRecentChanges()}
                        disabled={auditLoading}
                        aria-label="Refresh recent changes"
                        title="Refresh recent changes"
                        style={{ ...buttonStyle, minHeight: "28px", padding: "4px 10px", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: "10px", opacity: auditLoading ? 0.55 : 1 }}
                      >
                        {auditLoading ? "Refreshing..." : "Refresh"}
                      </button>
                    </div>

                    <div style={{ display: "grid", gap: "6px", maxHeight: isMobile ? "260px" : "calc(100vh - 310px)", overflowY: "auto", paddingRight: "2px" }}>
                      {auditLoading && <div style={{ color: "var(--fc-admin-muted)", fontSize: "11px" }}>Loading changes...</div>}
                      {!auditLoading && activityItems.length === 0 && <div style={{ color: "var(--fc-admin-muted)", fontSize: "11px" }}>No recent changes yet.</div>}
                      {activityItems.map((entry) => {
                        const actionId = entry.type === "audit" ? entry.id : `deleted-file:${entry.id}`
                        const actionBusy = auditActionId === actionId || (entry.type === "audit" && auditActionId === entry.id)
                        return (
                        <div key={`${entry.type}-${entry.id}`} style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) auto", gap: "8px", alignItems: "center", padding: "6px 7px", borderRadius: "10px", background: entry.type === "deleted-file" ? "var(--fc-tool-input-bg)" : "var(--fc-admin-panel-soft-bg)", border: entry.type === "deleted-file" ? "1px solid var(--fc-admin-warning-border)" : "1px solid transparent" }}>
                          <div style={{ minWidth: 0 }}>
                            <div style={{ color: "var(--fc-admin-panel-text)", fontSize: "11px", fontWeight: 800, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {entry.subject}
                            </div>
                            <div style={{ color: "var(--fc-admin-muted)", fontSize: "10px", marginTop: "2px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {entry.summary}
                            </div>
                            <div style={{ color: "var(--fc-admin-muted)", fontSize: "10px", marginTop: "2px" }}>
                              {formatTimestamp(entry.occurredAt)}{entry.actorName ? ` · ${entry.actorName}` : ""}{entry.undone ? " · undone" : ""}
                            </div>
                          </div>
                          {entry.canUndo ? (
                            <button
                              type="button"
                              aria-label="Undo change"
                              title="Undo change"
                              onClick={() => {
                                if (entry.type === "audit") {
                                  void undoAuditEntry(entry.id)
                                } else {
                                  void undoDeletedFile(entry.file)
                                }
                              }}
                              disabled={actionBusy}
                              style={{ ...buttonStyle, width: "28px", height: "28px", padding: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: "14px", opacity: actionBusy ? 0.6 : 1 }}
                            >
                              {actionBusy ? "..." : "↩"}
                            </button>
                          ) : null}
                        </div>
                        )
                      })}
                    </div>
                  </div>
                </div>
              )}

              <div style={{ marginTop: "auto", display: "none", justifyContent: "flex-end" }}>
                <div style={{ position: "relative" }}>
                  <button
                    onClick={() => setMenuOpen((prev) => !prev)}
                    className="fc-admin-menu-button"
                    aria-label="Open menu"
                    style={menuButtonStyle}
                  >
                    <MenuGlyph />
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

        <main style={{ padding: isMobile ? "12px" : "0 22px 22px", height: isMobile ? "auto" : "100vh", overflowY: isMobile ? "visible" : "auto", minWidth: 0, maxWidth: "100vw", boxSizing: "border-box", scrollbarWidth: "thin", scrollbarColor: "#b9cde6 #f5f5f7" }}>
          <div style={{ display: "grid", gap: "14px", minWidth: 0 }}>
            <div style={{ ...panelStyle, padding: isMobile ? "10px" : "14px", position: "sticky", top: 0, zIndex: 10, minWidth: 0, borderTopLeftRadius: isMobile ? "18px" : 0, borderTopRightRadius: isMobile ? "18px" : 0 }}>
              <div style={{ display: "grid", gridTemplateColumns: isMobile ? "minmax(0,1fr) 54px" : "1fr", gap: "8px", alignItems: "center" }}>
                <input
                  value={query}
                  onClick={() => {
                    setQuery("")
                    setSuggestions([])
                  }}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={handleSearchKeyDown}
                  placeholder={isMobile ? "Search..." : "Search company, country or port..."}
                  style={searchInputStyle}
                />
                {isMobile && (
                  <button
                    onClick={() => setMenuOpen((prev) => !prev)}
                    className="fc-admin-menu-button"
                    aria-label="Open menu"
                    style={menuButtonStyle}
                  >
                    <MenuGlyph />
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
                        border: index === activeSuggestion ? "1px solid var(--fc-admin-success-border)" : "1px solid var(--fc-admin-border-soft)",
                        background: index === activeSuggestion ? "var(--fc-admin-selected-bg)" : "#ffffff",
                        color: "var(--fc-admin-panel-text)",
                        cursor: "pointer",
                      }}
                    >
                      <div style={{ fontWeight: 700 }}>{item.name}</div>
                      <div style={{ color: "var(--fc-admin-muted)", fontSize: "11px", marginTop: "1px" }}>
                        {kindLabel(item.kind)}{item.kind === "port" && item.country_name ? ` • ${item.country_name}` : ""}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div style={{ ...panelStyle, padding: isMobile ? "12px" : "16px", display: "grid", gap: "12px", minWidth: 0 }}>
              {initialMode ? (
                <div style={{ minHeight: isMobile ? "unset" : "calc(100vh - 180px)", display: "grid", placeItems: "center", color: "var(--fc-admin-muted)", textAlign: "center", padding: "20px" }}>
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
                        <div style={{ fontSize: "12px", letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--fc-admin-link)", fontWeight: 700, marginBottom: "8px" }}>Search In Page</div>
                        <input value={searchInPage} onChange={(e) => setSearchInPage(e.target.value)} onKeyDown={handleSearchInPageKeyDown} style={inputStyle} />
                      </div>
                    </div>
                  )}

                  <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "minmax(0,1fr) auto", gap: "10px", alignItems: "end" }}>
                    <div>
                      <div style={{ fontSize: "12px", letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--fc-admin-link)", fontWeight: 700, marginBottom: "6px" }}>{mainLabel}</div>
                      <input
                        value={currentRecord.name}
                        readOnly
                        onDoubleClick={openRecordModal}
                        title="Double click to edit or delete"
                        style={{ ...inputStyle, cursor: selectedId ? "text" : "default" }}
                      />
                      {selectedKind === "port" && currentCountry.name ? (
                        <button
                          type="button"
                          onClick={() => {
                            if (currentCountry.id) void openCountryInline(currentCountry.id)
                          }}
                          disabled={!currentCountry.id}
                          style={{ border: "none", background: "#ffffff", color: currentCountry.id ? "var(--fc-admin-link)" : "var(--fc-admin-muted)", padding: "7px 0 0", fontSize: "11px", letterSpacing: "0.08em", textTransform: "uppercase", fontWeight: 800, cursor: currentCountry.id ? "pointer" : "default" }}
                        >
                          COUNTRY: {currentCountry.name}
                        </button>
                      ) : null}
                    </div>
                    <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", justifyContent: isMobile ? "flex-start" : "flex-end" }}>
                      <button onClick={saveRecord} disabled={saving || sectionSaving || !selectedId} style={{ ...buttonStyle, minWidth: "96px", background: "var(--fc-admin-success-bg)", color: "var(--fc-admin-success-text)", border: "1px solid var(--fc-admin-success-border)" }}>
                        {saving || sectionSaveState === "saving" ? "Saving" : "Saved"}
                      </button>
                    </div>
                  </div>

                  {selectedKind === "port" && false && (
                    <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "220px minmax(0, 1fr)", gap: "10px", alignItems: "end" }}>
                      <div style={{ position: "relative" }}>
                        <div style={{ fontSize: "12px", letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--fc-admin-link)", fontWeight: 700, marginBottom: "6px" }}>Country</div>
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
                              <div style={{ padding: "8px", color: "var(--fc-admin-muted)", fontSize: "12px" }}>No matching country</div>
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
                                  style={{ ...buttonStyle, borderRadius: "10px", padding: "7px 9px", textAlign: "left", background: country.id === currentCountry.id ? "var(--fc-admin-selected-bg)" : "var(--fc-admin-panel-soft-bg)" }}
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

                  <div style={{ display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap", borderBottom: "1px solid var(--fc-admin-border-soft)", paddingBottom: "8px" }}>
                    <button type="button" onClick={() => setActiveInfoTab("general")} style={{ ...buttonStyle, borderRadius: "12px 12px 0 0", background: fixedTabBackground, color: "var(--fc-admin-muted)", outline: activeInfoTab === "general" ? "2px solid var(--fc-admin-link)" : "none", outlineOffset: "1px" }}>
                      {mainInfoTabLabel}
                    </button>
                    {selectedKind === "port" && (
                      <>
                        <button type="button" onClick={() => setActiveInfoTab("country-general")} style={{ ...buttonStyle, borderRadius: "12px 12px 0 0", background: fixedTabBackground, color: "var(--fc-admin-muted)", outline: activeInfoTab === "country-general" ? "2px solid var(--fc-admin-link)" : "none", outlineOffset: "1px" }}>
                          GENERAL INFORMATION
                        </button>
                        {countryTabs.map((tab, index) => (
                          <button key={`country-tab-${index}`} type="button" onClick={() => setActiveInfoTab(`country-section-${index}`)} style={{ ...buttonStyle, borderRadius: "12px 12px 0 0", background: fixedTabBackground, color: "var(--fc-admin-muted)", outline: activeInfoTab === `country-section-${index}` ? "2px solid var(--fc-admin-link)" : "none", outlineOffset: "1px" }}>
                            {(tab.title || `TAB ${index + 1}`).toUpperCase()}
                          </button>
                        ))}
                      </>
                    )}
                    {selectedKind === "country" && (
                      <button type="button" onClick={() => setActiveInfoTab("ports")} style={{ ...buttonStyle, borderRadius: "12px 12px 0 0", background: fixedTabBackground, color: "var(--fc-admin-muted)", outline: activeInfoTab === "ports" ? "2px solid var(--fc-admin-link)" : "none", outlineOffset: "1px" }}>
                        PORTS
                      </button>
                    )}
                    {highlights.map((highlight, index) => (
                      <div
                        key={`tab-${index}`}
                        draggable
                        onDragStart={() => setDraggingTabIndex(index)}
                        onDragEnd={() => {
                          setDraggingTabIndex(null)
                          setDropTabIndex(null)
                        }}
                        onDragOver={(event) => {
                          event.preventDefault()
                          const bounds = event.currentTarget.getBoundingClientRect()
                          setDropTabSide(event.clientX < bounds.left + bounds.width / 2 ? "left" : "right")
                          setDropTabIndex(index)
                        }}
                        onDragLeave={() => setDropTabIndex(null)}
                        onDrop={() => {
                          if (draggingTabIndex !== null) {
                            const targetIndex = dropTabSide === "right" ? index + (draggingTabIndex < index ? 0 : 1) : index - (draggingTabIndex < index ? 1 : 0)
                            void moveHighlightToIndex(draggingTabIndex, Math.max(0, Math.min(highlights.length - 1, targetIndex)))
                          }
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
                          background: userTabBackground,
                          outline: activeInfoTab === `section-${index}` ? "2px solid var(--fc-admin-link)" : "none",
                          outlineOffset: "1px",
                          boxShadow: dropTabIndex === index ? `${dropTabSide === "left" ? "inset 3px 0 0 var(--fc-admin-link)" : "inset -3px 0 0 var(--fc-admin-link)"}, ${buttonStyle.boxShadow}` : buttonStyle.boxShadow,
                          transform: draggingTabIndex === index ? "translateY(2px) scale(0.98)" : dropTabIndex === index ? "translateY(-2px)" : "none",
                          opacity: draggingTabIndex === index ? 0.62 : 1,
                          transition: "transform 120ms ease, box-shadow 120ms ease, opacity 120ms ease",
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "8px",
                          cursor: "pointer",
                        }}
                      >
                        <span>{(highlight.title || `Section ${index + 1}`).toUpperCase()}</span>
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation()
                            void deleteHighlightCard(index)
                          }}
                          title="Delete tab"
                          style={{ border: "none", width: "17px", height: "17px", borderRadius: "999px", background: "var(--fc-admin-button-bg)", color: "var(--fc-admin-button-text)", fontSize: "12px", lineHeight: "15px", cursor: "pointer", padding: 0 }}
                        >
                          ×
                        </button>
                      </div>
                    ))}
                    <button
                      type="button"
                      onClick={() => {
                        setHighlightDraft({ title: "", info: "" })
                        setHighlightModalMode("tab")
                        setHighlightModalOpen(true)
                      }}
                      disabled={!selectedId}
                      style={{ ...buttonStyle, borderRadius: "12px 12px 0 0", padding: "6px 12px", background: "var(--fc-admin-panel-soft-bg)", color: "var(--fc-admin-button-text)", border: "1px solid var(--fc-admin-border)" }}
                    >
                      +
                    </button>
                  </div>

                  {activeInfoTab === "general" && (
                  <div>
                    {recordLoading && <div style={{ color: "var(--fc-admin-muted)", marginBottom: "8px" }}>Loading...</div>}
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
                      onInsertBlock={insertMainBlock}
                    />
                    {mainSections.length > 0 && (
                      <div style={{ display: "grid", gap: "12px", marginTop: "12px" }}>
                        {mainSections.map((section, sectionIndex) => (
                          <div key={`main-section-${sectionIndex}`} style={{ borderRadius: "14px", background: "var(--fc-admin-panel-soft-bg)", padding: "10px 12px" }}>
                            <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) auto", alignItems: "center", gap: "8px", marginBottom: "8px" }}>
                              <button type="button" onDoubleClick={() => renameMainSection(sectionIndex)} style={{ border: "none", background: "#ffffff", color: "var(--fc-admin-link)", textAlign: "left", padding: 0, fontSize: "11px", letterSpacing: "0.12em", textTransform: "uppercase", fontWeight: 800, cursor: "text" }}>
                                <HighlightedInlineText value={section.title || `SECTION ${sectionIndex + 1}`} query={searchInPage} />
                              </button>
                              <div style={{ display: "flex", gap: "5px" }}>
                                <button type="button" onClick={() => void moveMainSection(sectionIndex, -1)} style={{ ...buttonStyle, padding: "3px 7px", fontSize: "10px" }}>↑</button>
                                <button type="button" onClick={() => void moveMainSection(sectionIndex, 1)} style={{ ...buttonStyle, padding: "3px 7px", fontSize: "10px" }}>↓</button>
                                <button type="button" onClick={() => void deleteMainSection(sectionIndex)} style={{ ...buttonStyle, padding: "3px 7px", fontSize: "10px" }}>x</button>
                              </div>
                            </div>
                            <div>
                              {section.table ? (
                                <SimpleTable table={section.table} columnWidths={section.column_widths} rowUpdates={section.table_row_updates} onSave={(table, widths, rowUpdates) => updateMainSectionTable(sectionIndex, table, widths, rowUpdates)} />
                              ) : (
                                <BlockTextBlock
                                  blocks={section.blocks?.length ? section.blocks : textToBlocks(section.info || "", section.line_updates || {}, currentRecord.updated_at)}
                                  fallbackUpdatedAt={currentRecord.updated_at}
                                  minHeight="calc(1em + 28px)"
                                  query={searchInPage}
                                  editingBlockId={editingMainSectionBlock?.sectionIndex === sectionIndex ? editingMainSectionBlock.blockId : ""}
                                  onBlockDoubleClick={(block) => startMainSectionBlockEditing(sectionIndex, block)}
                                  onBlockChange={(blockId, value) => updateMainSectionBlock(sectionIndex, blockId, value)}
                                  onBlockSave={() => void finishMainSectionEditing()}
                                  onBlockCancel={() => cancelMainSectionEditing(sectionIndex)}
                                  onBlockDelete={(blockId) => void deleteMainSectionBlock(sectionIndex, blockId)}
                                  onInsertBlock={(blockIndex) => insertMainSectionBlock(sectionIndex, blockIndex)}
                                />
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  )}

                  {activeInfoTab.startsWith("section-") && highlights.length > 0 && (
                    <div style={{ display: "grid", gap: "12px" }}>
                      {highlights.map((highlight, index) => activeInfoTab === `section-${index}` ? (
                        <div key={`section-${index}`}>
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
                            onInsertBlock={(blockIndex) => insertSectionBlock(index, blockIndex)}
                          />
                          {(highlight.sections || []).length > 0 && (
                            <div style={{ display: "grid", gap: "12px", marginTop: "12px" }}>
                              {(highlight.sections || []).map((section, sectionIndex) => (
                                <div key={`nested-section-${index}-${sectionIndex}`} style={{ borderRadius: "14px", background: "var(--fc-admin-panel-soft-bg)", padding: "10px 12px" }}>
                                  <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) auto", alignItems: "center", gap: "8px", marginBottom: "8px" }}>
                                    <button
                                      type="button"
                                      onDoubleClick={(event) => {
                                        event.stopPropagation()
                                        renameNestedSection(index, sectionIndex)
                                      }}
                                      style={{ border: "none", background: "#ffffff", color: "var(--fc-admin-link)", textAlign: "left", padding: 0, fontSize: "11px", letterSpacing: "0.12em", textTransform: "uppercase", fontWeight: 800, cursor: "text" }}
                                      title="Double click to rename section"
                                    >
                                      <HighlightedInlineText value={section.title || `SECTION ${sectionIndex + 1}`} query={searchInPage} />
                                    </button>
                                    <div style={{ display: "flex", gap: "5px" }}>
                                      <button type="button" onClick={() => void moveNestedSection(index, sectionIndex, -1)} style={{ ...buttonStyle, padding: "3px 7px", fontSize: "10px" }}>↑</button>
                                      <button type="button" onClick={() => void moveNestedSection(index, sectionIndex, 1)} style={{ ...buttonStyle, padding: "3px 7px", fontSize: "10px" }}>↓</button>
                                      <button type="button" onClick={() => void deleteNestedSection(index, sectionIndex)} style={{ ...buttonStyle, padding: "3px 7px", fontSize: "10px" }}>x</button>
                                    </div>
                                  </div>
                                  <div>
                                    {section.table ? (
                                      <SimpleTable table={section.table} columnWidths={section.column_widths} rowUpdates={section.table_row_updates} onSave={(table, widths, rowUpdates) => updateNestedSectionTable(index, sectionIndex, table, widths, rowUpdates)} />
                                    ) : (
                                      <BlockTextBlock
                                        blocks={section.blocks?.length ? section.blocks : textToBlocks(section.info || "", section.line_updates || {}, currentRecord.updated_at)}
                                        fallbackUpdatedAt={currentRecord.updated_at}
                                        minHeight="calc(1em + 28px)"
                                        query={searchInPage}
                                        editingBlockId={editingNestedSectionBlock?.tabIndex === index && editingNestedSectionBlock.sectionIndex === sectionIndex ? editingNestedSectionBlock.blockId : ""}
                                        onBlockDoubleClick={(block) => startNestedSectionBlockEditing(index, sectionIndex, block)}
                                        onBlockChange={(blockId, value) => updateNestedSectionBlock(index, sectionIndex, blockId, value)}
                                        onBlockSave={() => void finishNestedSectionEditing()}
                                        onBlockCancel={cancelNestedSectionEditing}
                                        onBlockDelete={(blockId) => void deleteNestedSectionBlock(index, sectionIndex, blockId)}
                                        onInsertBlock={(blockIndex) => insertNestedSectionBlock(index, sectionIndex, blockIndex)}
                                      />
                                    )}
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      ) : null)}
                    </div>
                  )}

                  {selectedKind === "port" && activeInfoTab === "country-general" && (
                    <div>
                      <BlockTextBlock
                        blocks={countryMainBlocks.length ? countryMainBlocks : textToBlocks(currentCountry.notes || "", {}, currentCountry.updated_at)}
                        fallbackUpdatedAt={currentCountry.updated_at}
                        minHeight="calc(1em + 28px)"
                        query={searchInPage}
                      />
                      {countrySections.length > 0 && (
                        <div style={{ display: "grid", gap: "12px", marginTop: "12px" }}>
                          {countrySections.map((section, sectionIndex) => (
                            <div key={`country-main-section-${sectionIndex}`} style={{ borderRadius: "14px", background: "var(--fc-admin-panel-soft-bg)", padding: "10px 12px" }}>
                              <div style={{ color: "var(--fc-admin-link)", padding: "0 0 8px", fontSize: "11px", letterSpacing: "0.12em", textTransform: "uppercase", fontWeight: 800 }}>
                                <HighlightedInlineText value={section.title || `SECTION ${sectionIndex + 1}`} query={searchInPage} />
                              </div>
                              <BlockTextBlock blocks={section.blocks?.length ? section.blocks : textToBlocks(section.info || "", section.line_updates || {}, currentCountry.updated_at)} fallbackUpdatedAt={currentCountry.updated_at} minHeight="calc(1em + 28px)" query={searchInPage} />
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {selectedKind === "port" && activeInfoTab.startsWith("country-section-") && (
                    <div>
                      {countryTabs.map((tab, index) => activeInfoTab === `country-section-${index}` ? (
                        <div key={`country-section-view-${index}`}>
                          <BlockTextBlock blocks={tab.blocks?.length ? tab.blocks : textToBlocks(tab.info || "", tab.line_updates || {}, currentCountry.updated_at)} fallbackUpdatedAt={currentCountry.updated_at} minHeight="calc(1em + 28px)" query={searchInPage} />
                          {(tab.sections || []).length > 0 && (
                            <div style={{ display: "grid", gap: "12px", marginTop: "12px" }}>
                              {(tab.sections || []).map((section, sectionIndex) => (
                                <div key={`country-nested-${index}-${sectionIndex}`} style={{ borderRadius: "14px", background: "var(--fc-admin-panel-soft-bg)", padding: "10px 12px" }}>
                                  <div style={{ color: "var(--fc-admin-link)", padding: "0 0 8px", fontSize: "11px", letterSpacing: "0.12em", textTransform: "uppercase", fontWeight: 800 }}>
                                    <HighlightedInlineText value={section.title || `SECTION ${sectionIndex + 1}`} query={searchInPage} />
                                  </div>
                                  <BlockTextBlock blocks={section.blocks?.length ? section.blocks : textToBlocks(section.info || "", section.line_updates || {}, currentCountry.updated_at)} fallbackUpdatedAt={currentCountry.updated_at} minHeight="calc(1em + 28px)" query={searchInPage} />
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      ) : null)}
                    </div>
                  )}

                  {selectedKind === "port" && false && (
                    <div>
                      <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "6px" }}>
                        <div style={{ fontSize: "12px", letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--fc-admin-link)", fontWeight: 700 }}>{countryInformationLabel}</div>
                        {countryInfoEditing && (
                          <button
                            type="button"
                            onClick={() => {
                              setCountryInfoEditing(false)
                              void saveRecord()
                            }}
                            style={{ ...buttonStyle, marginLeft: "auto", padding: "4px 10px", fontSize: "11px", background: "var(--fc-admin-success-bg)", color: "var(--fc-admin-success-text)" }}
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
                        <button onClick={openAddPortForCurrentCountry} style={{ ...buttonStyle, padding: "4px 10px", fontSize: "11px", lineHeight: 1, background: "var(--fc-admin-warning-bg)", color: "var(--fc-admin-warning-text)", border: "1px solid var(--fc-admin-warning-border)" }}>
                          Add Port
                        </button>
                      </div>
                      <div style={{ ...panelStyle, padding: 0, background: "var(--fc-tool-input-bg)", overflow: "hidden" }}>
                        {currentCountryPorts.length === 0 ? (
                          <div style={{ color: "var(--fc-admin-muted)", padding: "12px" }}>No ports linked yet.</div>
                        ) : isMobile ? (
                          <div style={{ display: "grid", gap: "8px", padding: "10px" }}>
                            {currentCountryPorts.map((port) => (
                              <div key={port.id} style={{ borderBottom: "1px solid var(--fc-admin-border-soft)", paddingBottom: "10px", display: "grid", gap: "6px" }}>
                                {editingCountryPortId === port.id ? (
                                  <>
                                    <input value={countryPortDraft.name} onChange={(event) => setCountryPortDraft((prev) => ({ ...prev, name: event.target.value.toUpperCase() }))} style={inputStyle} />
                                    <AutoSizeTextarea value={countryPortDraft.notes} onChange={(event) => setCountryPortDraft((prev) => ({ ...prev, notes: event.target.value }))} style={{ ...textareaStyle, minHeight: "1.55em", padding: "2px 4px", border: "none", borderRadius: "6px", background: "var(--fc-admin-selected-bg)", fontSize: "12px" }} />
                                    <div style={{ display: "flex", gap: "8px" }}>
                                      <button type="button" onClick={() => void saveCountryPortEditing()} style={{ ...buttonStyle, padding: "2px 6px", fontSize: "9px", background: "var(--fc-admin-success-bg)", color: "var(--fc-admin-success-text)" }}>Save</button>
                                      <button type="button" onClick={() => setEditingCountryPortId("")} style={{ ...buttonStyle, padding: "2px 6px", fontSize: "9px" }}>Cancel</button>
                                    </div>
                                  </>
                                ) : (
                                  <>
                                    <a href={`/admin/ccinfo?kind=port&id=${port.id}`} onClick={(event) => { event.preventDefault(); void openPortInline(port.id) }} style={{ color: "var(--fc-admin-link)", fontWeight: 800, fontSize: "12px", textDecoration: "none" }}>
                                      <HighlightedInlineText value={port.name} query={searchInPage} />
                                    </a>
                                    <div onDoubleClick={() => startCountryPortEditing(port)} style={{ color: "var(--fc-admin-panel-text)", fontSize: "12px", lineHeight: 1.45, whiteSpace: "pre-wrap", overflowWrap: "anywhere", cursor: "text" }}>
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
                                  <th style={{ textAlign: "left", padding: "10px 12px", borderBottom: "1px solid var(--fc-admin-border-soft)", color: "var(--fc-admin-link)", fontSize: "11px", letterSpacing: "0.12em", textTransform: "uppercase" }}>Port</th>
                                  <th style={{ textAlign: "left", padding: "10px 12px", borderBottom: "1px solid var(--fc-admin-border-soft)", color: "var(--fc-admin-link)", fontSize: "11px", letterSpacing: "0.12em", textTransform: "uppercase" }}>Information</th>
                                </tr>
                              </thead>
                              <tbody>
                                {currentCountryPorts.map((port) => (
                                  <tr key={port.id}>
                                    <td style={{ verticalAlign: "top", padding: "10px 12px", borderBottom: "1px solid var(--fc-admin-border-soft)", color: "var(--fc-admin-panel-text)", lineHeight: 1.45, whiteSpace: "nowrap", fontWeight: 700 }}>
                                      {editingCountryPortId === port.id ? (
                                        <input value={countryPortDraft.name} onChange={(event) => setCountryPortDraft((prev) => ({ ...prev, name: event.target.value.toUpperCase() }))} style={{ ...inputStyle, padding: "7px 9px", fontSize: "12px" }} />
                                      ) : (
                                        <a href={`/admin/ccinfo?kind=port&id=${port.id}`} onClick={(event) => { event.preventDefault(); void openPortInline(port.id) }} style={{ color: "var(--fc-admin-link)", fontWeight: 700, textDecoration: "none" }}>
                                        <HighlightedInlineText value={port.name} query={searchInPage} />
                                        </a>
                                      )}
                                    </td>
                                    <td onDoubleClick={() => startCountryPortEditing(port)} style={{ verticalAlign: "top", padding: "10px 12px", borderBottom: "1px solid var(--fc-admin-border-soft)", color: "var(--fc-admin-panel-text)", lineHeight: 1.45, whiteSpace: "pre-wrap", cursor: "text" }}>
                                      {editingCountryPortId === port.id ? (
                                        <div style={{ display: "grid", gap: "8px" }}>
                                          <AutoSizeTextarea value={countryPortDraft.notes} onChange={(event) => setCountryPortDraft((prev) => ({ ...prev, notes: event.target.value }))} style={{ ...textareaStyle, minHeight: "1.55em", padding: "2px 4px", border: "none", borderRadius: "6px", background: "var(--fc-admin-selected-bg)", fontSize: "12px" }} />
                                          <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
                                            <button type="button" onClick={() => void saveCountryPortEditing()} style={{ ...buttonStyle, padding: "2px 6px", fontSize: "9px", background: "var(--fc-admin-success-bg)", color: "var(--fc-admin-success-text)" }}>Save</button>
                                            <button type="button" onClick={() => setEditingCountryPortId("")} style={{ ...buttonStyle, padding: "2px 6px", fontSize: "9px" }}>Cancel</button>
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

                  <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                    <button
                      type="button"
                      onClick={() => {
                        if (activeInfoTab !== "general" && !activeInfoTab.startsWith("section-")) {
                          setMessage("Please select a tab before adding a section.")
                          return
                        }
                        setHighlightDraft({ title: "", info: "" })
                        setHighlightModalMode("section")
                        setHighlightModalOpen(true)
                      }}
                      disabled={!selectedId}
                      style={{ ...buttonStyle, padding: "6px 12px", fontSize: "11px", background: "var(--fc-admin-warning-bg)", color: "var(--fc-admin-warning-text)", border: "1px solid var(--fc-admin-warning-border)" }}
                    >
                      Add Section
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (activeInfoTab !== "general" && !activeInfoTab.startsWith("section-")) {
                          setMessage("Please select a tab before adding a table.")
                          return
                        }
                        setHighlightDraft({ title: "TABLE", info: "" })
                        setHighlightModalMode("table")
                        setHighlightModalOpen(true)
                      }}
                      disabled={!selectedId}
                      style={{ ...buttonStyle, padding: "6px 12px", fontSize: "11px", background: "var(--fc-admin-warning-bg)", color: "var(--fc-admin-warning-text)", border: "1px solid var(--fc-admin-warning-border)" }}
                    >
                      Add Table
                    </button>
                  </div>

                  {isMobile && fileSection}

                </>
              )}
            </div>
          </div>
        </main>
        {!isMobile && <aside style={{ ...sidebarStyle, width: "320px", height: "100vh", overflow: "hidden" }}>{fileSection}</aside>}
      </div>
      {filePanelEditTarget && (
        <div
          style={{ position: "fixed", inset: 0, background: "#1d1d1f", display: "grid", placeItems: "center", padding: "20px", zIndex: 46 }}
          onClick={() => setFilePanelEditTarget(null)}
        >
          <div
            style={{ ...panelStyle, width: "min(480px, 100%)", padding: "18px", display: "grid", gap: "14px" }}
            onClick={(event) => event.stopPropagation()}
          >
            <div>
              <div style={{ color: "var(--fc-admin-link)", fontSize: "11px", letterSpacing: "0.14em", textTransform: "uppercase", fontWeight: 900 }}>
                {filePanelEditTarget.type === "folder" ? "Folder" : "File"}
              </div>
              <h2 style={{ margin: "5px 0 0", color: "var(--fc-admin-heading)", fontSize: "20px" }}>Edit</h2>
            </div>
            <label style={{ display: "grid", gap: "6px", color: "var(--fc-admin-muted)", fontSize: "11px", fontWeight: 900, textTransform: "uppercase" }}>
              Name
              <input
                value={filePanelNameDraft}
                onChange={(event) => setFilePanelNameDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void saveFilePanelEdit()
                  if (event.key === "Escape") setFilePanelEditTarget(null)
                }}
                style={inputStyle}
                autoFocus
              />
            </label>
            <div style={{ display: "flex", gap: "8px", justifyContent: "space-between", flexWrap: "wrap" }}>
              <button type="button" onClick={() => void deleteFilePanelTarget()} style={{ ...buttonStyle, background: "var(--fc-admin-danger-bg)", color: "var(--fc-admin-danger-text)", border: "1px solid var(--fc-admin-danger-border)" }}>
                Delete
              </button>
              <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                <button type="button" onClick={() => setFilePanelEditTarget(null)} style={buttonStyle}>Cancel</button>
                <button type="button" onClick={() => void saveFilePanelEdit()} style={{ ...buttonStyle, background: "var(--fc-admin-success-bg)", color: "var(--fc-admin-success-text)", border: "1px solid var(--fc-admin-success-border)" }}>
                  Rename
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {previewModalOpen && selectedPreviewFile && previewUrl && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "#1d1d1f",
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
                <div style={{ fontSize: "11px", letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--fc-admin-link)", fontWeight: 700 }}>File Preview</div>
                <div style={{ fontWeight: 700, color: "var(--fc-admin-panel-text)", marginTop: "4px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{selectedPreviewFile.file_name}</div>
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
            <div style={{ borderRadius: "16px", overflow: "hidden", border: "1px solid var(--fc-admin-border-soft)", background: "#ffffff" }}>
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
            background: "#1d1d1f",
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
            <div style={{ fontSize: "13px", letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--fc-admin-warning-text)", fontWeight: 800 }}>
              {highlightModalMode === "tab" ? "Add Tab" : highlightModalMode === "table" ? "Add Table" : "Add Section"}
            </div>
            <div>
              <div style={{ fontSize: "12px", color: "var(--fc-admin-muted)", marginBottom: "6px" }}>{highlightModalMode === "tab" ? "Tab Name" : highlightModalMode === "table" ? "Table Name" : "Section Name"}</div>
              <input
                ref={highlightTitleInputRef}
                value={highlightDraft.title}
                onChange={(event) => setHighlightDraft((prev) => ({ ...prev, title: event.target.value }))}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault()
                    void saveHighlightCard()
                  }
                }}
                style={inputStyle}
                placeholder={highlightModalMode === "tab" ? "e.g. OPERATIONS" : highlightModalMode === "table" ? "e.g. SUPPLIERS" : "e.g. REFINERY"}
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
                  background: "var(--fc-admin-warning-bg)",
                  color: "var(--fc-admin-warning-text)",
                  border: "1px solid var(--fc-admin-warning-border)",
                }}
              >
                Add
              </button>
            </div>
          </div>
        </div>
      )}
      {recordModalOpen && (
        <div
          style={{ position: "fixed", inset: 0, background: "#1d1d1f", display: "grid", placeItems: "center", padding: "20px", zIndex: 42 }}
          onClick={() => setRecordModalOpen(false)}
        >
          <div style={{ ...panelStyle, width: "min(520px, 100%)", padding: "18px", display: "grid", gap: "12px" }} onClick={(event) => event.stopPropagation()}>
            <div style={{ fontSize: "13px", letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--fc-admin-link)", fontWeight: 800 }}>
              Edit {mainLabel}
            </div>
            <div>
              <div style={{ fontSize: "12px", color: "var(--fc-admin-muted)", marginBottom: "6px" }}>{mainLabel}</div>
              <input
                value={recordNameDraft}
                onChange={(event) => setRecordNameDraft(event.target.value.toUpperCase())}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault()
                    void saveRecordNameFromModal()
                  }
                  if (event.key === "Escape") setRecordModalOpen(false)
                }}
                style={inputStyle}
                autoFocus
              />
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", gap: "8px", flexWrap: "wrap" }}>
              <button
                type="button"
                onClick={() => void deleteRecord()}
                disabled={!selectedId}
                style={{ ...buttonStyle, background: "var(--fc-admin-danger-bg)", color: "var(--fc-admin-danger-text)", border: "1px solid var(--fc-admin-danger-border)" }}
              >
                {recordDeleteLabel}
              </button>
              <div style={{ display: "flex", gap: "8px" }}>
                <button type="button" onClick={() => setRecordModalOpen(false)} style={buttonStyle}>Cancel</button>
                <button
                  type="button"
                  onClick={() => void saveRecordNameFromModal()}
                  disabled={saving || !recordNameDraft.trim()}
                  style={{ ...buttonStyle, background: "var(--fc-admin-success-bg)", color: "var(--fc-admin-success-text)", border: "1px solid var(--fc-admin-success-border)" }}
                >
                  {saving ? "Saving" : "Save"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {addPortModalOpen && (
        <div
          style={{ position: "fixed", inset: 0, background: "#1d1d1f", display: "grid", placeItems: "center", padding: "20px", zIndex: 40 }}
          onClick={() => {
            setAddPortModalOpen(false)
            setAddPortDraft({ name: "", notes: "", countryId: "", countryName: "" })
          }}
        >
          <div style={{ ...panelStyle, width: "min(580px, 100%)", padding: "18px", display: "grid", gap: "12px" }} onClick={(event) => event.stopPropagation()}>
            <div style={{ fontSize: "13px", letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--fc-admin-warning-text)", fontWeight: 800 }}>Add Port</div>
            <div>
              <div style={{ fontSize: "12px", color: "var(--fc-admin-muted)", marginBottom: "6px" }}>Port</div>
              <input ref={addPortNameInputRef} value={addPortDraft.name} onChange={(event) => setAddPortDraft((prev) => ({ ...prev, name: event.target.value.toUpperCase() }))} style={inputStyle} />
            </div>
            <div style={{ position: "relative" }}>
              <div style={{ fontSize: "12px", color: "var(--fc-admin-muted)", marginBottom: "6px" }}>Country</div>
              <input
                value={addPortDraft.countryName}
                onFocus={() => setCountryDropdownOpen(true)}
                onChange={(event) => setAddPortDraft((prev) => ({ ...prev, countryName: event.target.value.toUpperCase(), countryId: "" }))}
                onBlur={() => window.setTimeout(() => setCountryDropdownOpen(false), 160)}
                style={inputStyle}
                placeholder="SELECT COUNTRY"
              />
              {countryDropdownOpen && (
                <div style={{ ...panelStyle, position: "absolute", top: "calc(100% + 6px)", left: 0, right: 0, zIndex: 60, padding: "6px", display: "grid", gap: "4px", maxHeight: "240px", overflowY: "auto" }}>
                  {filteredAddPortCountryOptions.length === 0 ? (
                    <div style={{ padding: "8px", color: "var(--fc-admin-muted)", fontSize: "12px" }}>No matching country</div>
                  ) : (
                    filteredAddPortCountryOptions.map((country) => (
                      <button
                        type="button"
                        key={country.id}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => {
                          setAddPortDraft((prev) => ({ ...prev, countryId: country.id, countryName: country.name }))
                          setCountryDropdownOpen(false)
                        }}
                        style={{ ...buttonStyle, borderRadius: "10px", padding: "7px 9px", textAlign: "left", background: country.id === addPortDraft.countryId ? "var(--fc-admin-selected-bg)" : "var(--fc-admin-panel-soft-bg)" }}
                      >
                        {country.name}
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
            <div>
              <div style={{ fontSize: "12px", color: "var(--fc-admin-muted)", marginBottom: "6px" }}>Port Information</div>
              <textarea value={addPortDraft.notes} onChange={(event) => setAddPortDraft((prev) => ({ ...prev, notes: event.target.value }))} style={{ ...textareaStyle, minHeight: "180px" }} />
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
              <button type="button" onClick={() => setAddPortModalOpen(false)} style={buttonStyle}>Cancel</button>
              <button type="button" onClick={() => void addPort()} style={{ ...buttonStyle, background: "var(--fc-admin-warning-bg)", color: "var(--fc-admin-warning-text)", border: "1px solid var(--fc-admin-warning-border)" }}>Save Port</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
