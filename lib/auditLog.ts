import { createClient } from "@supabase/supabase-js"
export type AuditOperation = "INSERT" | "UPDATE" | "DELETE"

type AuditPageDefinition = {
  id: string
  label: string
  group: string
  path: string
  matchPrefixes?: string[]
}

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

export type AuditLogScope = "www" | "spc" | "all"

export type OutlookInsertionAuditOutcome =
  | "inserted"
  | "failed-restored"
  | "failed-preserved"

export type PresentedAuditLogRecord = AuditLogRecord & {
  displayOperation: AuditOperation
  pageId: string
  pageLabel: string
  recordLabel: string
  summary: string
  details: string[]
  undoable: boolean
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

const AUDIT_PREVIEW_FIELDS = [
  "id",
  "key",
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
  "port_id",
  "recorded_at",
  "hsfo",
  "vlsfo",
  "mgo",
  "deleted_at",
] as const

const AUDIT_INDEX_SELECT = [
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
  "request_context",
  "undo_of_log_id",
  "undone_at",
  "undone_by_log_id",
  ...AUDIT_PREVIEW_FIELDS.flatMap((field) => [
    `before_${field}:before_row->>${field}`,
    `after_${field}:after_row->>${field}`,
  ]),
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
  outlook_template_insertion_attempts: "email-templates",
  admin_users: "user-management",
  admin_role_defaults: "user-management",
  spc_users: "spc-user-management",
  spc_enquiries: "spc-buyer-enquiries",
  spc_fixtures: "spc-fixtures",
  spc_role_defaults: "spc-user-management",
  spc_suppliers: "spc-suppliers",
  spc_presentation_chunks: "spc-readme",
  openai_usage_events: "openai-usage",
}

const AUDIT_PAGE_LABELS: Record<string, string> = {
  "hongkong-price-history": "HONG KONG PRICE HISTORY",
  "taiwan-price-history": "TAIWAN PRICE HISTORY",
  "spc-user-management": "SPC USER MANAGEMENT",
  "spc-buyer-enquiries": "SPC ENQUIRIES",
  "spc-chrome-extension": "SPC WHATSAPP EXTENSION",
  "spc-readme": "SPC INTRODUCTION",
  "spc-fixtures": "SPC FIXTURES",
  "spc-lost-record": "SPC LOST RECORD",
  "spc-statistics": "SPC STATISTICS",
  "spc-suppliers": "SPC SUPPLIER DATABASE",
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
  outlook_template_insertion_attempts: "Outlook template insertion attempt",
  admin_users: "user",
  admin_role_defaults: "role defaults",
  spc_users: "SPC user",
  spc_enquiries: "SPC enquiry",
  spc_fixtures: "SPC fixture",
  spc_role_defaults: "SPC permission group",
  spc_suppliers: "SPC supplier",
  parser_reports: "parser report",
  openai_usage_events: "OpenAI usage event",
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
  bdn_entries: "BDN rows",
  contact: "contact",
  created_by_username: "created by",
  created_by_display_name: "created by",
  fixture_status: "fixture status",
  fixture_date: "fixture date",
  supplier_trader_username: "supplier trader",
  supplier_trader_display_name: "supplier trader",
  buyer_trader_username: "buyer trader",
  buyer_trader_display_name: "buyer trader",
  supplier_key: "supplier key",
  earliest_eta: "earliest ETA",
  price: "price",
  barging: "barging",
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

const SPC_TABLE_NAMES = new Set([
  "spc_users",
  "spc_enquiries",
  "spc_fixtures",
  "spc_role_defaults",
  "spc_suppliers",
])

const NON_UNDOABLE_TABLES = new Set([
  "admin_users",
  "openai_usage_events",
  "outlook_template_insertion_attempts",
  "spc_suppliers",
])

function isSpcAuditRecord(record: AuditLogRecord) {
  const actorId = record.actorId?.trim().toLowerCase() || ""
  const pageId = getContextText(record.requestContext, "pageId", "page_id")?.toLowerCase() || ""

  if (actorId.startsWith("spc:")) return true
  if (pageId.startsWith("spc-")) return true
  if (SPC_TABLE_NAMES.has(record.tableName)) return true

  if (record.tableName === "office_calendar_store") {
    const row = record.afterRow || record.beforeRow || {}
    return String(row.key || "") === "spc-permission-groups"
  }

  if (record.tableName === "parser_reports") {
    const row = record.afterRow || record.beforeRow || {}
    return String(row.source || "") === "spc"
  }

  return false
}

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

function mapAuditPreviewRow(row: Record<string, unknown>): AuditLogRecord {
  const previewRow = (prefix: "before" | "after") => {
    const values: Record<string, unknown> = {}
    for (const field of AUDIT_PREVIEW_FIELDS) {
      const value = row[`${prefix}_${field}`]
      if (value !== null && value !== undefined && value !== "") values[field] = value
    }
    return Object.keys(values).length ? values : null
  }

  return {
    id: String(row.id || ""),
    occurredAt: String(row.occurred_at || ""),
    actorId: typeof row.actor_id === "string" ? row.actor_id : null,
    actorName: typeof row.actor_name === "string" ? row.actor_name : null,
    actorSource: String(row.actor_source || ""),
    tableSchema: String(row.table_schema || ""),
    tableName: String(row.table_name || ""),
    operation: row.operation as AuditOperation,
    recordPk: (row.record_pk as Record<string, unknown> | null) || {},
    changedFields: (row.changed_fields as string[] | null) || [],
    beforeRow: previewRow("before"),
    afterRow: previewRow("after"),
    requestContext: (row.request_context as Record<string, unknown> | null) || {},
    undoOfLogId: typeof row.undo_of_log_id === "string" ? row.undo_of_log_id : null,
    undoneAt: typeof row.undone_at === "string" ? row.undone_at : null,
    undoneByLogId: typeof row.undone_by_log_id === "string" ? row.undone_by_log_id : null,
  }
}

export function canUndoAuditLogRecord(record: AuditLogRecord) {
  return !NON_UNDOABLE_TABLES.has(record.tableName)
}

export async function getAuditLogRecord(logId: string) {
  const supabase = getSupabaseAuditClient()
  const { data, error } = await supabase
    .from("audit_logs")
    .select(AUDIT_SELECT)
    .eq("id", logId)
    .maybeSingle()

  if (error) throw error
  return data ? mapAuditLog(data as unknown as AuditLogRow) : null
}

function getContextText(context: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = context[key]
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return null
}

function pageFromPath(pathname: string, pages: AuditPageDefinition[]) {
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
  if (key === "parser-reports") {
    return record.actorId?.trim().toLowerCase().startsWith("spc:")
      ? "spc-buyer-enquiries"
      : "enquiry-worksheet"
  }
  return key === "task-calendar" ? "task-calendar" : "event-calendar"
}

function withAuditPageLabel(page: AuditPageDefinition) {
  return {
    ...page,
    label: AUDIT_PAGE_LABELS[page.id] || page.label,
  }
}

function getAuditPage(
  record: AuditLogRecord,
  pages: AuditPageDefinition[],
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
          : record.tableName === "parser_reports"
            ? String((record.afterRow || record.beforeRow || {}).source || "") === "spc"
              ? "spc-buyer-enquiries"
              : "enquiry-worksheet"
            : TABLE_PAGE_IDS[record.tableName]

  const knownPage = pages.find((page) => page.id === pageId)
  if (knownPage) return withAuditPageLabel(knownPage)

  return {
    id: pageId || "other-admin-activity",
    label:
      AUDIT_PAGE_LABELS[pageId] ||
      getContextText(record.requestContext, "pageLabel", "page_label") ||
      "OTHER ADMIN ACTIVITY",
    group: "management",
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

type OutlookInsertionAuditCorrelation = {
  events: AuditLogRecord[]
  reservation: AuditLogRecord | null
  terminal: AuditLogRecord | null
}

function getOutlookInsertionOperationId(record: AuditLogRecord) {
  if (record.tableName !== "outlook_template_insertion_attempts") return ""
  return String(
    record.recordPk.operationId ||
      record.afterRow?.operationId ||
      "",
  ).trim().toLowerCase()
}

function getOutlookInsertionPhase(record: AuditLogRecord) {
  const phase = String(
    record.recordPk.phase ||
      record.afterRow?.phase ||
      "",
  ).trim().toLowerCase()
  return phase === "reserved" || phase === "terminal" ? phase : null
}

function getOutlookInsertionOutcome(
  record: AuditLogRecord | null,
): OutlookInsertionAuditOutcome | null {
  const outcome = String(record?.afterRow?.outcome || "").trim().toLowerCase()
  if (
    outcome === "inserted" ||
    outcome === "failed-restored" ||
    outcome === "failed-preserved"
  ) {
    return outcome
  }
  return null
}

function buildOutlookInsertionCorrelations(records: AuditLogRecord[]) {
  const correlations = new Map<string, OutlookInsertionAuditCorrelation>()
  for (const record of records) {
    const operationId = getOutlookInsertionOperationId(record)
    if (!operationId) continue
    const current = correlations.get(operationId) || {
      events: [],
      reservation: null,
      terminal: null,
    }
    const existingIndex = current.events.findIndex(
      (event) => event.id === record.id,
    )
    if (existingIndex >= 0) current.events[existingIndex] = record
    else current.events.push(record)
    const phase = getOutlookInsertionPhase(record)
    if (phase === "reserved") current.reservation = record
    if (phase === "terminal") current.terminal = record
    correlations.set(operationId, current)
  }
  return correlations
}

export function getOutlookInsertionAuditRecordLabel(
  record: AuditLogRecord,
  relatedEvents: AuditLogRecord[] = [],
) {
  const operationId = getOutlookInsertionOperationId(record)
  const correlation = buildOutlookInsertionCorrelations([
    record,
    ...relatedEvents,
  ]).get(operationId)
  const templateTitle = String(
    correlation?.reservation?.afterRow?.templateTitle ||
      record.afterRow?.templateTitle ||
      "",
  ).trim()
  if (templateTitle) return templateTitle

  return String(
    record.afterRow?.templateId ||
      record.recordPk.templateId ||
      "Outlook template insertion",
  )
}

async function loadOutlookInsertionRelatedEvents(
  records: AuditLogRecord[],
) {
  const operationIds = Array.from(
    new Set(records.map(getOutlookInsertionOperationId).filter(Boolean)),
  )
  if (operationIds.length === 0) return [] as AuditLogRecord[]

  const supabase = getSupabaseAuditClient()
  const batches = Array.from(
    { length: Math.ceil(operationIds.length / 100) },
    (_, index) => operationIds.slice(index * 100, (index + 1) * 100),
  )
  const results = await Promise.all(
    batches.map((batch) =>
      supabase
        .from("audit_logs")
        .select(AUDIT_SELECT)
        .eq("table_schema", "app")
        .eq("table_name", "outlook_template_insertion_attempts")
        .eq("operation", "INSERT")
        .in("record_pk->>operationId", batch),
    ),
  )

  const failed = results.find((result) => result.error)
  if (failed?.error) throw failed.error
  return results.flatMap((result) =>
    ((result.data || []) as unknown as AuditLogRow[]).map(mapAuditLog),
  )
}

function outlookInsertionOutcomeSummary(
  outcome: OutlookInsertionAuditOutcome,
  recordLabel: string,
) {
  if (outcome === "inserted") {
    return `Inserted Outlook template "${recordLabel}" into an Outlook message.`
  }
  if (outcome === "failed-restored") {
    return `Outlook insertion failed for template "${recordLabel}"; the original draft was restored.`
  }
  return `Outlook insertion failed for template "${recordLabel}"; newer draft edits were preserved.`
}

export function getOutlookInsertionAuditPresentation(
  record: AuditLogRecord,
  recordLabel: string,
  relatedEvents: AuditLogRecord[] = [],
) {
  const operationId = getOutlookInsertionOperationId(record)
  const correlations = buildOutlookInsertionCorrelations([
    record,
    ...relatedEvents,
  ])
  const correlation = correlations.get(operationId) || {
    events: [record],
    reservation: null,
    terminal: null,
  }
  const currentRecord =
    correlation.events.find((event) => event.id === record.id) || record
  const phase = getOutlookInsertionPhase(currentRecord)
  const outcome = getOutlookInsertionOutcome(correlation.terminal)
  const row = currentRecord.afterRow || {}
  const details: string[] = []

  if (!phase) {
    details.push(
      `Recorded a legacy server-verified Outlook draft insertion attempt for template "${recordLabel}".`,
    )
  } else if (phase === "reserved") {
    if (outcome) {
      details.push(`Status: completed as ${outcome}.`)
      details.push(outlookInsertionOutcomeSummary(outcome, recordLabel))
      if (correlation.terminal) {
        details.push(`Terminal audit event: ${correlation.terminal.id}.`)
      }
    } else {
      details.push(
        "Status: incomplete. The durable reservation has no terminal insertion outcome.",
      )
    }
  } else if (outcome) {
    details.push(`Status: ${outcome}.`)
    details.push(outlookInsertionOutcomeSummary(outcome, recordLabel))
    if (correlation.reservation) {
      details.push(
        `Reservation audit event: ${correlation.reservation.id}, recorded ${formatAuditDate(correlation.reservation.occurredAt)}.`,
      )
    }
  } else {
    details.push(
      "Status: invalid terminal event. No recognized insertion outcome was recorded.",
    )
  }

  if (row.templateRevision || currentRecord.recordPk.templateRevision) {
    details.push(
      `Template revision: ${formatValue(
        "revision",
        row.templateRevision || currentRecord.recordPk.templateRevision,
      )}.`,
    )
  }
  if (row.certificationRunId) {
    details.push(`Exchange certification run: ${String(row.certificationRunId)}.`)
  }
  if (row.sourceFingerprint) {
    details.push(`Certified projection SHA-256: ${String(row.sourceFingerprint)}.`)
  }
  if (operationId) {
    details.push(`Idempotent operation ID: ${operationId}.`)
  }

  const summary =
    phase === "reserved"
      ? outcome
        ? `Reserved Outlook insertion for template "${recordLabel}"; completed as ${outcome}.`
        : `Reserved Outlook insertion for template "${recordLabel}"; terminal status is missing (incomplete).`
      : phase === "terminal" && outcome
        ? outlookInsertionOutcomeSummary(outcome, recordLabel)
        : phase === "terminal"
          ? `Outlook insertion for template "${recordLabel}" has an invalid terminal status.`
          : `Recorded a legacy Outlook draft insertion attempt for template "${recordLabel}".`

  return { summary, details }
}

function getRecordLabel(
  record: AuditLogRecord,
  portNames: Map<string, string>,
  insertionCorrelation?: OutlookInsertionAuditCorrelation,
) {
  const row = record.afterRow || record.beforeRow || {}
  if (record.tableName === "outlook_template_insertion_attempts") {
    return getOutlookInsertionAuditRecordLabel(
      record,
      insertionCorrelation?.events,
    )
  }

  if (record.tableName === "office_calendar_store") {
    const labels: Record<string, string> = {
      "event-calendar": "event calendar",
      "task-calendar": "task calendar",
      "spc-permission-groups": "SPC permission groups",
      "parser-reports": "parser reports",
    }
    const key = typeof row.key === "string" ? row.key : ""
    return labels[key] || "shared store"
  }

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
  recordLabel: string,
  insertionCorrelation?: OutlookInsertionAuditCorrelation,
) {
  const subject = subjectFor(record, recordLabel)
  if (record.undoOfLogId) return `Undid a previous change to ${subject}.`
  if (record.tableName === "outlook_template_insertion_attempts") {
    return getOutlookInsertionAuditPresentation(
      record,
      recordLabel,
      insertionCorrelation?.events,
    ).summary
  }
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
  recordLabel: string,
  insertionCorrelation?: OutlookInsertionAuditCorrelation,
) {
  const subject = subjectFor(record, recordLabel)
  const details: string[] = []

  if (record.undoOfLogId) {
    details.push(`This change restored the previous version of ${subject}.`)
  }

  if (record.tableName === "outlook_template_insertion_attempts") {
    return getOutlookInsertionAuditPresentation(
      record,
      recordLabel,
      insertionCorrelation?.events,
    ).details
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
  pages: AuditPageDefinition[]
) {
  const [portNames, insertionEvents] = await Promise.all([
    getPortNames(records),
    loadOutlookInsertionRelatedEvents(records),
  ])
  const insertionCorrelations = buildOutlookInsertionCorrelations([
    ...records,
    ...insertionEvents,
  ])

  return records.map<PresentedAuditLogRecord>((record) => {
    const page = getAuditPage(record, pages, portNames)
    const displayOperation = getDisplayOperation(record)
    const insertionCorrelation = insertionCorrelations.get(
      getOutlookInsertionOperationId(record),
    )
    const recordLabel = getRecordLabel(
      record,
      portNames,
      insertionCorrelation,
    )

    return {
      ...record,
      displayOperation,
      pageId: page.id,
      pageLabel: page.label,
      recordLabel,
      summary: buildSummary(
        record,
        displayOperation,
        recordLabel,
        insertionCorrelation,
      ),
      details: buildDetails(
        record,
        displayOperation,
        recordLabel,
        insertionCorrelation,
      ),
      undoable: canUndoAuditLogRecord(record),
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
    return ["event-calendar", "task-calendar", "spc-permission-groups", "parser-reports"].includes(String(row.key || ""))
  }

  return true
}

export function matchesAuditScope(record: AuditLogRecord, scope: AuditLogScope) {
  if (scope === "all") return true
  return scope === "spc" ? isSpcAuditRecord(record) : !isSpcAuditRecord(record)
}

export async function listAuditLogs(options: {
  limit?: number
  tableNames?: string[]
  operations?: AuditOperation[]
  actorId?: string | null
  scope?: AuditLogScope
  includeRows?: boolean
}) {
  const supabase = getSupabaseAuditClient()
  const limit = Math.min(Math.max(options.limit || 100, 1), 500)
  const scope = options.scope || "www"
  let query = supabase
    .from("audit_logs")
    .select(options.includeRows === false ? AUDIT_INDEX_SELECT : AUDIT_SELECT)
    .or(
      "table_schema.eq.public,and(table_schema.eq.app,table_name.eq.outlook_template_insertion_attempts)"
    )
    .in("actor_source", ["app", "header"])
    .order("occurred_at", { ascending: false })
    .limit(limit)

  if (scope === "www") {
    query = query.or("actor_id.is.null,actor_id.not.like.spc:%")
  } else if (scope === "spc") {
    query = query.or(
      "actor_id.like.spc:%,table_name.in.(spc_users,spc_enquiries,spc_fixtures,spc_role_defaults,spc_suppliers)",
    )
  }

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
  const records = options.includeRows === false
    ? ((data || []) as unknown as Array<Record<string, unknown>>).map(mapAuditPreviewRow)
    : ((data || []) as unknown as AuditLogRow[]).map(mapAuditLog)

  return records
    .filter(isUserAuditRecord)
    .filter((record) => matchesAuditScope(record, scope))
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
