export type AuditDisplayLog = {
  tableName: string
  operation: "INSERT" | "UPDATE" | "DELETE"
  recordPk: Record<string, unknown>
  changedFields: string[]
  beforeRow: Record<string, unknown> | null
  afterRow: Record<string, unknown> | null
  undoOfLogId: string | null
  undoneAt: string | null
}

export const CCINFO_AUDIT_TABLES = new Set([
  "cc_companies",
  "cc_countries",
  "cc_ports",
  "cc_company_files",
  "cc_entry_files",
  "cc_entry_folders",
])

function rowFor(log: AuditDisplayLog) {
  return log.afterRow || log.beforeRow || {}
}

function textValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : ""
}

function titleFromOriginalPath(value: unknown) {
  const originalPath = textValue(value).replace(/\\/g, "/")
  if (!originalPath) return ""

  const archiveMatch = originalPath.match(/- Company Information\/([^/]+)(?:\/|$)/)
  if (archiveMatch?.[1]) return archiveMatch[1].replace(/^!+/, "")

  const manualMatch = originalPath.match(/^(company|country|port)\/([^/]+)(?:\/|$)/i)
  if (manualMatch?.[2]) return manualMatch[2]

  return ""
}

export function isCcinfoAuditLog(log: AuditDisplayLog) {
  return CCINFO_AUDIT_TABLES.has(log.tableName)
}

export function getAuditSubject(log: AuditDisplayLog) {
  const row = rowFor(log)
  const direct =
    textValue(row.name) ||
    titleFromOriginalPath(row.original_path) ||
    textValue(row.entry_name) ||
    textValue(row.country_name)

  if (direct) return direct.toUpperCase()

  const entryKind = textValue(row.entry_kind)
  const entryId = textValue(row.entry_id)
  if (entryKind && entryId) return `${entryKind.toUpperCase()} ${entryId.slice(0, 8)}`

  const fileName = textValue(row.file_name)
  if (fileName) return fileName

  const id = textValue(log.recordPk.id)
  return id ? id.slice(0, 8) : "UNKNOWN RECORD"
}

export function getAuditChangeSummary(log: AuditDisplayLog) {
  const row = rowFor(log)
  const before = log.beforeRow || {}
  const after = log.afterRow || {}

  if (log.undoOfLogId) return "Undo record created"
  if (log.undoneAt) return "Change was undone"

  if (log.tableName === "cc_company_files" || log.tableName === "cc_entry_files") {
    if (log.changedFields.includes("deleted_at")) {
      const fileName = textValue(row.file_name)
      return after.deleted_at
        ? `Deleted document ${fileName}`.trim()
        : `Restored document ${fileName}`.trim()
    }
    if (log.changedFields.includes("file_name")) {
      return `Renamed file from ${textValue(before.file_name) || "blank"} to ${textValue(after.file_name) || "blank"}`
    }
    if (log.changedFields.includes("folder_path") || log.changedFields.includes("original_path")) {
      return `Moved file ${textValue(row.file_name) || ""}`.trim()
    }
    if (log.operation === "INSERT") return `Added file ${textValue(row.file_name) || ""}`.trim()
    if (log.operation === "DELETE") return `Deleted file ${textValue(row.file_name) || ""}`.trim()
  }

  if (log.tableName === "cc_entry_folders") {
    if (log.changedFields.includes("name")) {
      return `Renamed folder from ${textValue(before.name) || "blank"} to ${textValue(after.name) || "blank"}`
    }
    if (log.operation === "INSERT") return `Added folder ${textValue(row.name) || ""}`.trim()
    if (log.operation === "DELETE") return `Deleted folder ${textValue(row.name) || ""}`.trim()
    return "Updated folder"
  }

  if (log.changedFields.includes("notes")) return "Updated information text"
  if (log.changedFields.includes("summary")) return "Updated sections or table data"
  if (log.changedFields.includes("name")) {
    return `Renamed from ${textValue(before.name) || "blank"} to ${textValue(after.name) || "blank"}`
  }

  if (log.operation === "INSERT") return "Created record"
  if (log.operation === "DELETE") return "Deleted record"
  if (log.changedFields.length) return `Updated ${log.changedFields.join(", ")}`
  return "Updated record"
}
