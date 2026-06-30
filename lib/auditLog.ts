import { createClient } from "@supabase/supabase-js"
import type { AdminPageDefinition } from "@/lib/adminPages"

export type AuditOperation = "INSERT" | "UPDATE" | "DELETE"

export type AuditLogRecord = {
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

export type PresentedAuditLogRecord = AuditLogRecord & {
  displayOperation: AuditOperation
  pageId: string
  pageLabel: string
  recordLabel: string
  summary: string
  details: string[]
}

type AuditLogRow = {
  id: string
  occurred_at: string
  actor_id: string | null
  actor_name: string | null
  actor_source: string
  table_schema: string
  table_name: string
  operation: AuditOperation
  record_pk: Record<string, unknown> | null
  changed_fields: string[] | null
  before_row: Record<string, unknown> | null
  after_row: Record<string, unknown> | null
  request_context: Record<string, unknown> | null
  undo_of_log_id: string | null
  undone_at: string | null
  undone_by_log_id: string | null
}

const AUDIT_SELECT = [
  "id",
  "occurred_at",
  "actor_id",
  "actor_name",
  "actor_source",
  "table_schema",
  "table_name",
  "operation",
  "record_pk",
  "changed_fields",
  "before_row",
  "after_row",
  "request_context",
  "undo_of_log_id",
  "undone_at",
  "undone_by_log_id",
].join(",")

const TABLE_PAGE_IDS: Record<string, string> = {
  cc_countries: "ccinfo",
  cc_companies: "ccinfo",
  cc_ports: "ccinfo",
  cc_documents: "ccinfo",
  cc_company_files: "ccinfo",
  cc_entry_files: "ccinfo",
  cc_entry_folders: "ccinfo",
  phonebook_contacts: "phonebook",
  phonebook_companies: "phonebook",
  shared_addressbook_contacts: "outlook-addressbook",
  shared_addressbook_groups: "outlook-addressbook",
  shared_addressbook_group_members: "outlook-addressbook",
  email_templates: "email-templates",
  admin_users: "user-management",
  admin_role_defaults: "user-management",
  spc_users: "spc-user-management",
  spc_enquiries: "spc-buyer-enquiries",
  spc_role_defaults: "spc-user-management",
}

const AUDIT_PAGE_LABELS: Record<string, string> = {
  "hongkong-price-history": "HONG KONG PRICE HISTORY",
  "taiwan-price-history": "TAIWAN PRICE HISTORY",
  "spc-user-management": "SPC USER MANAGEMENT",
  "spc-buyer-enquiries": "SPC ENQUIRIES",
  "spc-audit-log": "SPC AUDIT LOG",
  "spc-system-health": "SPC SYSTEM HEALTH",
  "spc-tech-stack": "SPC TECH STACK",
}

const ENTITY_NAMES: Record<string, string> = {
  ports: "price setting",
  price_history: "price history",
  remarks: "remark",
  cc_countries: "country",
  cc_companies: "company",
  cc_ports: "port",
  cc_documents: "document",
  cc_company_files: "company file",
  cc_entry_files: "file",
  cc_entry_folders: "folder",
  phonebook_contacts: "contact",
  phonebook_companies: "company",
  shared_addressbook_contacts: "address book contact",
  shared_addressbook_groups: "address book group",
  shared_addressbook_group_members: "group member",
  office_calendar_store: "calendar",
  email_templates: "email template",
  admin_users: "user",
  admin_role_defaults: "role defaults",
  spc_users: "SPC user",
  spc_enquiries: "SPC enquiry",
  spc_role_defaults: "SPC permission group",
}

const FIELD_LABELS: Record<string, string> = {
  name: "name",
  full_name: "name",
  display_name: "display name",
  username: "username",
  role: "role",
  permissions: "page access",
  password_hash: "password",
  country: "country",
  country_name: "country",
  company: "company",
  company_name: "company",
  port: "port",
  port_name: "port",
  title: "title",
  subject: "subject",
  email: "email",
  phone: "phone",
  mobile: "mobile",
  work_phone: "work phone",
  address: "address",
  notes: "notes",
  remark: "remark",
  hsfo: "HSFO price",
  vlsfo: "VLSFO price",
  mgo: "MGO price",
  hsfo_formula: "HSFO formula",
  vlsfo_formula: "VLSFO formula",
  mgo_formula: "MGO formula",
  recorded_at: "record date",
  file_name: "file name",
  folder_name: "folder name",
  group_name: "group name",
  type: "type",
  phone_e164: "phone",
  direction: "direction",
  message_type: "message type",
  status: "status",
  unread_count: "unread count",
  assigned_to: "assigned to",
  enquiry_number: "enquiry number",
  vessel_name: "vessel name",
  supplier_name: "supplier",
  created_by_username: "created by",
  created_by_display_name: "created by",
  content: "content",
  body: "content",
}

const HIDDEN_FIELDS = new Set([
  "id",
  "created_at",
  "updated_at",
  "deleted_at",
  "source_key",
  "payload",
  "metadata",
])

const NON_CREATION_INSERT_TABLES = new Set([
  "price_history",
  "remarks",
  "office_calendar_store",
  "admin_role_defaults",
])

function requireEnv(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing environment variable: ${name}`)
  return value
}

function getSupabaseAuditClient() {
  return createClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    process.env.SUPABASE_SERVICE_ROLE_KEY || requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY")
  )
}

function mapAuditLog(row: AuditLogRow): AuditLogRecord {
  return {
    id: row.id,
    occurredAt: row.occurred_at,
    actorId: row.actor_id,
    actorName: row.actor_name,
    actorSource: row.actor_source,
    tableSchema: row.table_schema,
    tableName: row.table_name,
    operation: row.operation,
    recordPk: row.record_pk || {},
    changedFields: row.changed_fields || [],
    beforeRow: row.before_row,
    afterRow: row.after_row,
    requestContext: row.request_context || {},
    undoOfLogId: row.undo_of_log_id,
    undoneAt: row.undone_at,
    undoneByLogId: row.undone_by_log_id,
  }
}

function getContextText(context: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = context[key]
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return null
}

function pageFromPath(pathname: string, pages: AdminPageDefinition[]) {
  return pages.find((page) => {
    if (pathname === page.path) return true
    return (page.matchPrefixes || []).some(
      (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
    )
  })
}

function inferPricePageId(
  record: AuditLogRecord,
  portNames: Map<string, string>
) {
  const row = record.afterRow || record.beforeRow || {}
  const directName =
    typeof row.name === "string" ? row.name : portNames.get(String(row.port_id || ""))
  const portName = directName?.trim().toLowerCase()

  if (portName === "hong kong") return "hongkong-price-history"
  if (portName === "kaohsiung" || portName === "taichung") return "taiwan-price-history"
  return "pricesetter"
}

function getRecordId(record: AuditLogRecord) {
  const row = record.afterRow || record.beforeRow || {}
  return Number(row.id ?? record.recordPk.id)
}

function inferRemarksPageId(record: AuditLogRecord) {
  const recordId = getRecordId(record)
  if (recordId === 1 || recordId === 2) return "taiwan-remarks"
  if (recordId === 101) return "taiwan-price-history"
  if (recordId === 102) return "hongkong-price-history"
  return "pricesetter"
}

function inferOfficeCalendarPageId(record: AuditLogRecord) {
  const row = record.afterRow || record.beforeRow || {}
  const key = typeof row.key === "string" ? row.key : ""
  if (key === "spc-permission-groups") return "spc-user-management"
  return key === "task-calendar" ? "task-calendar" : "event-calendar"
}

function withAuditPageLabel(page: AdminPageDefinition) {
  return {
    ...page,
    label: AUDIT_PAGE_LABELS[page.id] || page.label,
  }
}

function getAuditPage(
  record: AuditLogRecord,
  pages: AdminPageDefinition[],
  portNames: Map<string, string>
) {
  const contextPageId = getContextText(
    record.requestContext,
    "pageId",
    "page_id"
  )
  if (contextPageId) {
    const page = pages.find((candidate) => candidate.id === contextPageId)
    if (page) return withAuditPageLabel(page)
  }

  const contextPath = getContextText(
    record.requestContext,
    "pagePath",
    "page_path"
  )
  if (contextPath) {
    const page = pageFromPath(contextPath, pages)
    if (page) return withAuditPageLabel(page)
  }

  const pageId =
    record.tableName === "ports" || record.tableName === "price_history"
      ? inferPricePageId(record, portNames)
      : record.tableName === "remarks"
        ? inferRemarksPageId(record)
        : record.tableName === "office_calendar_store"
          ? inferOfficeCalendarPageId(record)
      : TABLE_PAGE_IDS[record.tableName]

  const knownPage = pages.find((page) => page.id === pageId)
  if (knownPage) return withAuditPageLabel(knownPage)

  return {
    id: pageId || "other-admin-activity",
    label:
      AUDIT_PAGE_LABELS[pageId] ||
      getContextText(record.requestContext, "pageLabel", "page_label") ||
      "OTHER ADMIN ACTIVITY",
    group: "management" as const,
    path: "/admin",
  }
}

function getDisplayOperation(record: AuditLogRecord): AuditOperation {
  if (
    record.operation === "INSERT" &&
    NON_CREATION_INSERT_TABLES.has(record.tableName)
  ) {
    return "UPDATE"
  }

  return record.operation
}

function getFieldLabel(field: string) {
  return (
    FIELD_LABELS[field] ||
    field
      .replace(/_id$/, "")
      .replace(/_/g, " ")
      .trim()
  )
}

function isTechnicalField(field: string) {
  return HIDDEN_FIELDS.has(field) || field.endsWith("_id")
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value
  )
}

function formatAuditDate(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value

  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date)
}

function formatValue(field: string, value: unknown) {
  if (value === null || value === undefined || value === "") return "blank"
  if (typeof value === "boolean") return value ? "yes" : "no"
  if (typeof value === "number") return new Intl.NumberFormat("en-US").format(value)

  if (typeof value === "string") {
    if (isUuid(value)) return "linked item"
    if (field.endsWith("_at") || /^\d{4}-\d{2}-\d{2}T/.test(value)) {
      return formatAuditDate(value)
    }
    return value.length > 180 ? `${value.slice(0, 177)}...` : value
  }

  if (Array.isArray(value)) {
    const readable = value.filter(
      (item) => ["string", "number", "boolean"].includes(typeof item)
    )
    return readable.length === value.length ? readable.join(", ") || "blank" : "updated"
  }

  if (field === "permissions") return "the selected page access"
  return "updated details"
}

function getRecordLabel(record: AuditLogRecord, portNames: Map<string, string>) {
  const row = record.afterRow || record.beforeRow || {}
  if (record.tableName === "remarks") {
    const labels: Record<number, string> = {
      1: "Taiwan remarks",
      2: "Taiwan special notice",
      101: "Taiwan price report",
      102: "Hong Kong price report",
      103: "China price report",
      104: "Compact price report",
      105: "report display settings",
    }
    return labels[getRecordId(record)] || "remark"
  }

  const preferredKeys = [
    "company_name",
    "country_name",
    "port_name",
    "name",
    "full_name",
    "display_name",
    "username",
    "email",
    "title",
    "subject",
    "file_name",
    "folder_name",
    "group_name",
    "phone_e164",
    "body",
  ]

  for (const key of preferredKeys) {
    const value = row[key]
    if (
      (typeof value === "string" || typeof value === "number") &&
      String(value).trim()
    ) {
      return String(value).trim()
    }
  }

  const portName = portNames.get(String(row.port_id || ""))
  if (record.tableName === "price_history" && portName) {
    const recordedAt = typeof row.recorded_at === "string" ? row.recorded_at : ""
    return recordedAt ? `${portName}, ${formatAuditDate(recordedAt)}` : portName
  }

  return ENTITY_NAMES[record.tableName] || "record"
}

function subjectFor(record: AuditLogRecord, recordLabel: string) {
  const entity = ENTITY_NAMES[record.tableName] || "record"
  return recordLabel === entity ? entity : `${entity} "${recordLabel}"`
}

function getChangedFields(record: AuditLogRecord) {
  return record.changedFields.filter((field) => !isTechnicalField(field))
}

function getReportPublicationSummary(record: AuditLogRecord) {
  if (record.tableName !== "remarks") return null

  const labels: Record<number, string> = {
    101: "Published the Taiwan price report.",
    102: "Published the Hong Kong price report.",
    103: "Published the China price report.",
    104: "Published the Compact price report.",
    105: "Updated report display settings.",
  }
  return labels[getRecordId(record)] || null
}

function getPriceSettingSummary(
  record: AuditLogRecord,
  recordLabel: string
) {
  if (record.tableName !== "ports" || record.operation !== "UPDATE") return null

  const priceFields = ["hsfo", "vlsfo", "mgo"].filter((field) =>
    record.changedFields.includes(field)
  )
  if (priceFields.length === 0) return null

  const changes = priceFields.map(
    (field) =>
      `${getFieldLabel(field)} from ${formatValue(field, record.beforeRow?.[field])} to ${formatValue(field, record.afterRow?.[field])}`
  )

  return `Changed ${changes.join(", ")} for "${recordLabel}".`
}

function buildSummary(
  record: AuditLogRecord,
  displayOperation: AuditOperation,
  recordLabel: string
) {
  const subject = subjectFor(record, recordLabel)
  if (record.undoOfLogId) return `Undid a previous change to ${subject}.`
  const publicationSummary = getReportPublicationSummary(record)
  if (publicationSummary) return publicationSummary
  if (record.tableName === "price_history" && record.operation === "INSERT") {
    return `Added a new price record for ${recordLabel}.`
  }
  const priceSettingSummary = getPriceSettingSummary(record, recordLabel)
  if (priceSettingSummary) return priceSettingSummary
  if (displayOperation === "INSERT") return `Created ${subject}.`
  if (displayOperation === "DELETE") return `Deleted ${subject}.`

  const fields = getChangedFields(record)
  if (record.operation === "UPDATE" && fields.length > 0) {
    const fieldNames = fields.slice(0, 3).map(getFieldLabel)
    const suffix = fields.length > 3 ? " and other details" : ""
    return `Changed ${fieldNames.join(", ")}${suffix} for ${subject}.`
  }

  return `Updated ${subject}.`
}

function buildDetails(
  record: AuditLogRecord,
  displayOperation: AuditOperation,
  recordLabel: string
) {
  const subject = subjectFor(record, recordLabel)
  const details: string[] = []

  if (record.undoOfLogId) {
    details.push(`This change restored the previous version of ${subject}.`)
  }

  const publicationSummary = getReportPublicationSummary(record)
  if (publicationSummary) {
    return [publicationSummary]
  }

  if (record.tableName === "price_history" && record.operation === "INSERT") {
    details.push(`Added a new price record for ${recordLabel}.`)
    const row = record.afterRow || {}
    for (const field of ["hsfo", "vlsfo", "mgo", "recorded_at"]) {
      const value = row[field]
      if (value === null || value === undefined || value === "") continue
      details.push(`Set ${getFieldLabel(field)} to ${formatValue(field, value)}.`)
    }
  } else if (record.operation === "UPDATE") {
    for (const field of getChangedFields(record)) {
      if (field === "password_hash") {
        details.push("Changed the password.")
        continue
      }

      const before = formatValue(field, record.beforeRow?.[field])
      const after = formatValue(field, record.afterRow?.[field])
      if (
        field === "permissions" ||
        (before === "updated details" && after === "updated details")
      ) {
        details.push(`Changed ${getFieldLabel(field)} settings.`)
      } else {
        details.push(`Changed ${getFieldLabel(field)} from ${before} to ${after}.`)
      }
    }
  } else if (displayOperation === "INSERT") {
    details.push(`Created ${subject}.`)
    const row = record.afterRow || {}
    for (const [field, value] of Object.entries(row)) {
      if (
        isTechnicalField(field) ||
        field === "password_hash" ||
        value === null ||
        value === ""
      ) {
        continue
      }
      if (recordLabel === String(value)) continue
      details.push(`Set ${getFieldLabel(field)} to ${formatValue(field, value)}.`)
    }
  } else if (displayOperation === "UPDATE") {
    details.push(`Updated ${subject}.`)
    const row = record.afterRow || {}
    for (const [field, value] of Object.entries(row)) {
      if (
        isTechnicalField(field) ||
        field === "password_hash" ||
        value === null ||
        value === ""
      ) {
        continue
      }
      details.push(`Set ${getFieldLabel(field)} to ${formatValue(field, value)}.`)
    }
  } else {
    details.push(`Deleted ${subject}.`)
  }

  return Array.from(new Set(details)).slice(0, 12)
}

async function getPortNames(records: AuditLogRecord[]) {
  const portIds = Array.from(
    new Set(
      records
        .map((record) => record.afterRow?.port_id || record.beforeRow?.port_id)
        .filter((value) => value !== null && value !== undefined)
        .map(String)
    )
  )

  if (portIds.length === 0) return new Map<string, string>()

  const supabase = getSupabaseAuditClient()
  const { data } = await supabase.from("ports").select("id,name").in("id", portIds)
  return new Map(
    ((data || []) as Array<{ id: string | number; name: string }>).map((port) => [
      String(port.id),
      port.name,
    ])
  )
}

export async function presentAuditLogs(
  records: AuditLogRecord[],
  pages: AdminPageDefinition[]
) {
  const portNames = await getPortNames(records)

  return records.map<PresentedAuditLogRecord>((record) => {
    const page = getAuditPage(record, pages, portNames)
    const displayOperation = getDisplayOperation(record)
    const recordLabel = getRecordLabel(record, portNames)

    return {
      ...record,
      displayOperation,
      pageId: page.id,
      pageLabel: page.label,
      recordLabel,
      summary: buildSummary(record, displayOperation, recordLabel),
      details: buildDetails(record, displayOperation, recordLabel),
    }
  })
}

export function matchesAuditActor(record: AuditLogRecord, actor: string | null) {
  const actorFilter = actor?.trim().toLowerCase()
  if (!actorFilter || actorFilter === "all") return true

  return [record.actorId, record.actorName]
    .filter(Boolean)
    .some((value) => value!.trim().toLowerCase() === actorFilter)
}

export function isUserAuditRecord(record: AuditLogRecord) {
  const actorId = record.actorId?.trim().toLowerCase()
  if (
    !actorId ||
    actorId === "unknown" ||
    !["app", "header"].includes(record.actorSource)
  ) {
    return false
  }

  if (record.tableName === "office_calendar_store") {
    const row = record.afterRow || record.beforeRow || {}
    return ["event-calendar", "task-calendar", "spc-permission-groups"].includes(String(row.key || ""))
  }

  return true
}

export async function listAuditLogs(options: {
  limit?: number
  tableNames?: string[]
  operations?: AuditOperation[]
  actorId?: string | null
}) {
  const supabase = getSupabaseAuditClient()
  const limit = Math.min(Math.max(options.limit || 100, 1), 500)
  let query = supabase
    .from("audit_logs")
    .select(AUDIT_SELECT)
    .eq("table_schema", "public")
    .in("actor_source", ["app", "header"])
    .order("occurred_at", { ascending: false })
    .limit(limit)

  if (options.tableNames?.length) {
    query = query.in("table_name", options.tableNames)
  }
  if (options.operations?.length === 1) {
    query = query.eq("operation", options.operations[0])
  } else if (options.operations && options.operations.length > 1) {
    query = query.in("operation", options.operations)
  }
  if (options.actorId?.trim()) {
    query = query.eq("actor_id", options.actorId.trim())
  }

  const { data, error } = await query
  if (error) throw error
  return ((data || []) as unknown as AuditLogRow[])
    .map(mapAuditLog)
    .filter(isUserAuditRecord)
}

export async function undoAuditLog(
  logId: string,
  session: { username: string | null; displayName: string | null },
) {
  const supabase = getSupabaseAuditClient()
  const actorId = session.username || "admin"
  const actorName = session.displayName || session.username || "Admin"

  const { data, error } = await supabase.rpc("undo_audit_log", {
    p_log_id: logId,
    p_actor_id: actorId,
    p_actor_name: actorName,
  })

  if (error) throw error
  return data as string | null
}
