import { createClient } from "@supabase/supabase-js"
import {
  createSpcAuditedSupabaseClient,
  type SpcAuditContext,
} from "@/lib/spcAudit"
export type AuditOperation = "INSERT" | "UPDATE" | "DELETE"
export type AuditOutcome = "success" | "failed" | "denied"

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
  actorUserId: string | null
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
  sourceIp: string | null
  correlationId: string | null
  requestId: string | null
  platformRequestId: string | null
  actorRole: string | null
  auditAction: string | null
  auditOutcome: AuditOutcome | null
  targetType: string | null
  targetId: string | null
  targetUsername: string | null
  approvalReference: string | null
  errorCode: string | null
}

type AuditLogRow = {
  id: string
  occurred_at: string
  actor_user_id: string | null
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
  "actor_user_id",
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
  "vessel_name",
  "fixture_date",
  "supplier_name",
  "supplier_trader_display_name",
  "buyer_trader_display_name",
  "port_id",
  "recorded_at",
  "hsfo",
  "vlsfo",
  "mgo",
  "deleted_at",
  "action",
  "outcome",
  "errorCode",
  "targetType",
  "targetId",
  "targetUsername",
  "initials",
  "staff_code",
  "work_group",
  "team",
  "attendance_date",
  "work_date",
  "leave_date",
  "leave_code",
  "code",
  "period",
  "portion",
  "year",
  "month",
  "status",
] as const

const AUDIT_INDEX_SELECT = [
  "id",
  "occurred_at",
  "actor_user_id",
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
  spc_user_management_events: "spc-user-management",
  spc_mfa_test_events: "spc-mfa-test",
  admin_users: "user-management",
  admin_role_defaults: "user-management",
  spc_users: "spc-user-management",
  spc_enquiries: "spc-buyer-enquiries",
  spc_lost_reason_options: "spc-lost-record",
  spc_enquiry_revisions: "spc-buyer-enquiries",
  spc_group_delivery_jobs: "spc-chrome-extension",
  spc_group_dispatchers: "spc-chrome-extension",
  spc_delivery_routes: "spc-user-management",
  spc_fixtures: "spc-fixtures",
  spc_role_defaults: "spc-user-management",
  spc_suppliers: "spc-suppliers",
  spc_speedboard_notices: "spc-chrome-extension",
  spc_presentation_chunks: "spc-readme",
  spc_feedback: "spc-feedback",
  openai_usage_events: "openai-usage",
  attendance_people: "attendance-record",
  attendance_team_assignments: "attendance-record",
  attendance_leave_entries: "attendance-record",
  attendance_manual_overrides: "attendance-record",
  attendance_work_mode_policies: "attendance-record",
  attendance_work_mode_overrides: "attendance-record",
  attendance_entitlements: "attendance-record",
  attendance_monthly_adjustments: "attendance-record",
  attendance_monthly_confirmations: "attendance-record",
  attendance_reminder_dispatches: "attendance-record",
}

const AUDIT_PAGE_LABELS: Record<string, string> = {
  "hongkong-price-history": "HONG KONG PRICE HISTORY",
  "taiwan-price-history": "TAIWAN PRICE HISTORY",
  "spc-user-management": "SPC USER MANAGEMENT",
  "spc-mfa-test": "SPC MFA TEST",
  "spc-buyer-enquiries": "SPC NEW ENQUIRY",
  "spc-today-enquiries": "SPC DAILY BRIEFING",
  "spc-chrome-extension": "SPC WHATSAPP EXTENSION",
  "spc-readme": "SPC PRESENTATION",
  "spc-feedback": "SPC FEEDBACK",
  "spc-fixtures": "SPC FIXTURES",
  "spc-lost-record": "SPC LOST RECORD",
  "spc-statistics": "SPC STATISTICS",
  "spc-suppliers": "SPC SUPPLIER DATABASE",
  "spc-audit-log": "SPC AUDIT LOG",
  "spc-system-health": "SPC SYSTEM HEALTH",
  "spc-tech-stack": "SPC TECH STACK",
  "attendance-record": "ATTENDANCE RECORD",
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
  spc_user_management_events: "SPC user-management action",
  spc_mfa_test_events: "SPC WhatsApp MFA test",
  admin_users: "user",
  admin_role_defaults: "role defaults",
  spc_users: "SPC user",
  spc_enquiries: "SPC enquiry",
  spc_lost_reason_options: "SPC lost reason",
  spc_enquiry_revisions: "SPC enquiry revision",
  spc_group_delivery_jobs: "SPC group delivery",
  spc_group_dispatchers: "SPC group dispatcher",
  spc_delivery_routes: "SPC enquiry delivery route",
  spc_whatsapp_groups: "SPC WhatsApp API group",
  spc_fixtures: "SPC fixture",
  spc_role_defaults: "SPC permission group",
  spc_suppliers: "SPC supplier",
  spc_speedboard_notices: "SPC Speed Board update notice",
  spc_feedback: "SPC feedback",
  parser_reports: "parser report",
  openai_usage_events: "OpenAI usage event",
  attendance_people: "attendance person",
  attendance_team_assignments: "attendance group assignment",
  attendance_leave_entries: "attendance leave entry",
  attendance_manual_overrides: "attendance correction",
  attendance_work_mode_policies: "attendance work-mode policy",
  attendance_work_mode_overrides: "attendance work-mode override",
  attendance_entitlements: "attendance entitlement",
  attendance_monthly_adjustments: "attendance opening record",
  attendance_monthly_confirmations: "attendance monthly confirmation",
  attendance_reminder_dispatches: "attendance reminder dispatch",
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
  category: "type",
  message: "details",
  area: "area",
  admin_response: "response",
  reviewed_by_display_name: "reviewed by",
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
  version: "version",
  recipient_role: "recipient role",
  recipient_count: "recipient count",
  initials: "initials",
  staff_code: "staff code",
  work_group: "work group",
  team: "team",
  effective_from: "effective from",
  effective_to: "effective to",
  dingtalk_user_id: "DingTalk user",
  attendance_date: "attendance date",
  work_date: "attendance date",
  leave_date: "leave date",
  leave_code: "leave code",
  code: "leave code",
  period: "day portion",
  portion: "day portion",
  units: "days",
  year: "year",
  month: "month",
  allowance: "annual allowance",
  allowance_units: "annual allowance",
  carry_forward: "carry-forward",
  opening_carry_forward_units: "carry-forward",
  holiday_attendance: "holiday attendance credit",
  confirmed: "confirmed",
  is_confirmed: "confirmed",
  reason: "reason",
}

const HIDDEN_FIELDS = new Set([
  "id",
  "created_at",
  "updated_at",
  "deleted_at",
  "source_key",
  "payload",
  "metadata",
  "token_hash",
  "claim_token_hash",
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
  "spc_enquiry_revisions",
  "spc_group_delivery_jobs",
  "spc_group_dispatchers",
  "spc_delivery_routes",
  "spc_fixtures",
  "spc_role_defaults",
  "spc_suppliers",
  "spc_speedboard_notices",
  "spc_feedback",
  "spc_user_management_events",
  "spc_mfa_test_events",
])

const NON_UNDOABLE_TABLES = new Set([
  "admin_users",
  "openai_usage_events",
  "outlook_template_insertion_attempts",
  "spc_users",
  "spc_enquiry_revisions",
  "spc_group_delivery_jobs",
  "spc_group_dispatchers",
  "spc_delivery_routes",
  "spc_user_management_events",
  "spc_mfa_test_events",
  "spc_suppliers",
  "spc_speedboard_notices",
  "spc_feedback",
])

function isSpcAuditRecord(record: AuditLogRecord) {
  const actorId = record.actorId?.trim().toLowerCase() || ""
  const pageId = getContextText(record.requestContext, "pageId", "page_id")?.toLowerCase() || ""

  if (actorId.startsWith("spc:")) return true
  if (pageId.startsWith("spc-")) return true
  if (SPC_TABLE_NAMES.has(record.tableName)) return true

  if (record.tableName === "office_calendar_store") {
    return getOfficeCalendarStoreKey(record) === "spc-permission-groups"
  }

  if (record.tableName === "parser_reports") {
    const row = record.afterRow || record.beforeRow || {}
    return String(row.source || "") === "spc"
  }

  return false
}

export function isSpcUserManagementAuditRecord(record: AuditLogRecord) {
  if (
    record.tableName === "spc_user_management_events" ||
    record.tableName === "spc_users" ||
    record.tableName === "spc_role_defaults"
  ) {
    return true
  }
  if (record.tableName === "office_calendar_store") {
    return getOfficeCalendarStoreKey(record) === "spc-permission-groups"
  }
  return (
    getContextText(record.requestContext, "pageId", "page_id") ===
    "spc-user-management"
  )
}

const SPC_INVESTIGATION_DETAIL_PREFIXES = [
  "Source IP:",
  "Request ID:",
  "Correlation ID:",
  "Vercel request ID:",
] as const

export function redactSpcUserManagementInvestigation(
  record: PresentedAuditLogRecord,
  viewerIsAdmin: boolean,
) {
  if (viewerIsAdmin || !isSpcUserManagementAuditRecord(record)) return record

  return {
    ...record,
    sourceIp: null,
    correlationId: null,
    requestId: null,
    platformRequestId: null,
    details: record.details.filter(
      (detail) =>
        !SPC_INVESTIGATION_DETAIL_PREFIXES.some((prefix) =>
          detail.startsWith(prefix),
        ),
    ),
  }
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
    actorUserId: row.actor_user_id,
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
    actorUserId: typeof row.actor_user_id === "string" ? row.actor_user_id : null,
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
  if (
    record.tableName === "office_calendar_store" &&
    ["event-calendar", "spc-permission-groups"].includes(getOfficeCalendarStoreKey(record) || "")
  ) {
    return false
  }
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

type AuditInvestigationFields = {
  sourceIp: string | null
  correlationId: string | null
  requestId: string | null
  platformRequestId: string | null
  actorRole: string | null
  auditAction: string | null
  auditOutcome: AuditOutcome | null
  targetType: string | null
  targetId: string | null
  targetUsername: string | null
  approvalReference: string | null
  errorCode: string | null
}

function getObjectText(value: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const item = value[key]
    if (typeof item === "string" && item.trim()) return item.trim()
  }
  return null
}

function getAuditInvestigationFields(
  record: AuditLogRecord,
): AuditInvestigationFields {
  const context = record.requestContext
  const event = record.afterRow || {}
  const auditOutcome =
    getContextText(context, "outcome") || getObjectText(event, "outcome")

  return {
    sourceIp: getContextText(context, "sourceIp", "source_ip"),
    correlationId: getContextText(
      context,
      "correlationId",
      "correlation_id",
    ),
    requestId:
      getContextText(context, "requestId", "request_id") ||
      getObjectText(record.recordPk, "requestId", "request_id"),
    platformRequestId: getContextText(
      context,
      "platformRequestId",
      "platform_request_id",
    ),
    actorRole: getContextText(context, "actorRole", "actor_role"),
    auditAction:
      getContextText(context, "action") || getObjectText(event, "action"),
    auditOutcome:
      auditOutcome === "success" ||
      auditOutcome === "failed" ||
      auditOutcome === "denied"
        ? auditOutcome
        : null,
    targetType:
      getContextText(context, "targetType", "target_type") ||
      getObjectText(event, "targetType", "target_type") ||
      getObjectText(record.recordPk, "targetType", "target_type"),
    targetId:
      getContextText(context, "targetId", "target_id") ||
      getObjectText(event, "targetId", "target_id") ||
      getObjectText(record.recordPk, "targetId", "target_id"),
    targetUsername:
      getContextText(context, "targetUsername", "target_username") ||
      getObjectText(event, "targetUsername", "target_username"),
    approvalReference: getContextText(
      context,
      "approvalReference",
      "approval_reference",
    ),
    errorCode: getObjectText(event, "errorCode", "error_code"),
  }
}

function readableAuditCode(value: string | null, fallback: string) {
  return value?.replace(/[._:-]+/g, " ").trim() || fallback
}

function buildSpcInvestigationDetails(
  record: AuditLogRecord,
  investigation: AuditInvestigationFields,
) {
  if (
    !isSpcUserManagementAuditRecord(record) ||
    !Object.values(investigation).some(Boolean)
  ) {
    return []
  }

  const details = [
    `Actor: ${record.actorName || record.actorId || "not recorded"}${
      record.actorName && record.actorId ? ` (${record.actorId})` : ""
    }.`,
  ]
  if (investigation.actorRole) {
    details.push(`Actor role: ${investigation.actorRole}.`)
  }
  if (investigation.auditOutcome) {
    details.push(`Outcome: ${investigation.auditOutcome.toUpperCase()}.`)
  }
  if (investigation.auditAction) {
    details.push(
      `Action: ${readableAuditCode(investigation.auditAction, "unspecified")}.`,
    )
  }

  const targetName = investigation.targetUsername || investigation.targetId
  if (investigation.targetType || targetName) {
    details.push(
      `Target: ${readableAuditCode(investigation.targetType, "record")}${
        targetName ? ` "${targetName}"` : ""
      }.`,
    )
  }

  const occurredAt = new Date(record.occurredAt)
  if (!Number.isNaN(occurredAt.getTime())) {
    details.push(`Occurred at (UTC): ${occurredAt.toISOString()}.`)
  }
  if (investigation.sourceIp) {
    details.push(`Source IP: ${investigation.sourceIp}.`)
  }
  if (investigation.requestId) {
    details.push(`Request ID: ${investigation.requestId}.`)
  }
  if (investigation.correlationId) {
    details.push(`Correlation ID: ${investigation.correlationId}.`)
  }
  if (investigation.platformRequestId) {
    details.push(`Vercel request ID: ${investigation.platformRequestId}.`)
  }
  if (investigation.approvalReference) {
    details.push(`Approval reference: ${investigation.approvalReference}.`)
  }
  if (investigation.errorCode) {
    details.push(`Error code: ${investigation.errorCode}.`)
  }
  return details
}

function getOfficeCalendarStoreKey(record: AuditLogRecord) {
  const row = record.afterRow || record.beforeRow || {}
  const key = row.key ?? record.recordPk.key
  return typeof key === "string" ? key : ""
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
  const key = getOfficeCalendarStoreKey(record)
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
  if (record.tableName === "spc_user_management_events") {
    const investigation = getAuditInvestigationFields(record)
    return (
      investigation.targetUsername ||
      investigation.targetId ||
      readableAuditCode(investigation.targetType, "SPC user-management action")
    )
  }
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
    const key = getOfficeCalendarStoreKey(record)
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

  if (record.tableName.startsWith("attendance_")) {
    const staff =
      getContextText(record.requestContext, "staffCode", "staff_code") ||
      (typeof row.staff_code === "string" ? row.staff_code : "")
    const code = typeof row.code === "string" ? row.code : ""
    const date =
      (typeof row.leave_date === "string" && row.leave_date) ||
      (typeof row.work_date === "string" && row.work_date) ||
      ([row.year, row.month].every((value) => value !== null && value !== undefined)
        ? `${row.year}-${String(row.month).padStart(2, "0")}`
        : "")
    const label = [staff, code, date].filter(Boolean).join(" · ")
    if (label) return label
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
    "vessel_name",
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
  const fields = record.changedFields.filter((field) => !isTechnicalField(field))
  if (record.requestContext?.passwordChanged === true && !fields.includes("password_hash")) {
    fields.push("password_hash")
  }
  return fields
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

function asAuditObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function asAuditObjectArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          Boolean(item) && typeof item === "object" && !Array.isArray(item),
      )
    : []
}

function auditText(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

function auditIdentity(item: Record<string, unknown>, fallback: string) {
  return (
    auditText(item.userId) ||
    auditText(item.username).toLowerCase() ||
    auditText(item.role).toUpperCase() ||
    fallback
  )
}

function mapAuditItems(value: unknown) {
  return new Map(
    asAuditObjectArray(value).map((item, index) => [
      auditIdentity(item, String(index)),
      item,
    ]),
  )
}

function auditUsername(item: Record<string, unknown> | undefined) {
  return auditText(item?.username) || "user"
}

function auditRole(item: Record<string, unknown> | undefined) {
  return auditText(item?.role).toUpperCase() || "DEFAULT"
}

function auditPermission(value: unknown) {
  const permission = auditText(value).toUpperCase()
  return permission === "VIEW" || permission === "EDIT" ? permission : "NONE"
}

function auditPageLabel(pageId: string) {
  return (
    AUDIT_PAGE_LABELS[pageId] ||
    pageId
      .replace(/^spc-/, "")
      .replace(/-/g, " ")
      .toUpperCase()
  )
}

function getSpcUserManagementChanges(record: AuditLogRecord) {
  if (
    record.tableName !== "office_calendar_store" ||
    getOfficeCalendarStoreKey(record) !== "spc-permission-groups"
  ) {
    return null
  }

  const beforePayload = asAuditObject(record.beforeRow?.payload)
  const afterPayload = asAuditObject(record.afterRow?.payload)
  const details: string[] = []

  const beforeRoles = mapAuditItems(beforePayload.userRoles)
  const afterRoles = mapAuditItems(afterPayload.userRoles)
  for (const identity of new Set([...beforeRoles.keys(), ...afterRoles.keys()])) {
    const before = beforeRoles.get(identity)
    const after = afterRoles.get(identity)
    const username = auditUsername(after || before)
    if (!before && after) {
      details.push(`Assigned the ${auditRole(after)} role to ${username}.`)
    } else if (before && !after) {
      details.push(`Removed the ${auditRole(before)} role assignment from ${username}.`)
    } else if (before && after && auditRole(before) !== auditRole(after)) {
      details.push(
        `Changed ${username}'s role from ${auditRole(before)} to ${auditRole(after)}.`,
      )
    }
  }

  const beforeProfiles = mapAuditItems(beforePayload.userProfiles)
  const afterProfiles = mapAuditItems(afterPayload.userProfiles)
  for (const identity of new Set([...beforeProfiles.keys(), ...afterProfiles.keys()])) {
    const before = beforeProfiles.get(identity)
    const after = afterProfiles.get(identity)
    const username = auditUsername(after || before)
    if (!before && after) {
      const office = auditText(after.office)
      if (office) details.push(`Set ${username}'s office to ${office}.`)
      if (after.mustChangePassword === true) {
        details.push(`Required ${username} to change password on the next login.`)
      }
    } else if (before && !after) {
      details.push(`Removed the saved user-management profile for ${username}.`)
    } else if (before && after) {
      const beforeOffice = auditText(before.office)
      const afterOffice = auditText(after.office)
      if (beforeOffice !== afterOffice) {
        details.push(
          `Changed ${username}'s office from ${beforeOffice || "blank"} to ${afterOffice || "blank"}.`,
        )
      }
      if (before.mustChangePassword !== after.mustChangePassword) {
        details.push(
          after.mustChangePassword === true
            ? `Required ${username} to change password on the next login.`
            : `Removed the next-login password change requirement for ${username}.`,
        )
      }
    }
  }

  const beforeGroups = mapAuditItems(beforePayload.groups)
  const afterGroups = mapAuditItems(afterPayload.groups)
  for (const identity of new Set([...beforeGroups.keys(), ...afterGroups.keys()])) {
    const before = beforeGroups.get(identity)
    const after = afterGroups.get(identity)
    const role = auditRole(after || before)
    if (!before && after) {
      details.push(`Added the ${role} permission group.`)
      continue
    }
    if (before && !after) {
      details.push(`Removed the ${role} permission group.`)
      continue
    }
    const beforePermissions = asAuditObject(before?.permissions)
    const afterPermissions = asAuditObject(after?.permissions)
    for (const pageId of new Set([
      ...Object.keys(beforePermissions),
      ...Object.keys(afterPermissions),
    ])) {
      const beforePermission = auditPermission(beforePermissions[pageId])
      const afterPermission = auditPermission(afterPermissions[pageId])
      if (beforePermission === afterPermission) continue
      details.push(
        `Changed ${auditPageLabel(pageId)} access for ${role} from ${beforePermission} to ${afterPermission}.`,
      )
    }
  }

  const beforeOffices = new Set(
    (Array.isArray(beforePayload.offices) ? beforePayload.offices : [])
      .map(auditText)
      .filter(Boolean),
  )
  const afterOffices = new Set(
    (Array.isArray(afterPayload.offices) ? afterPayload.offices : [])
      .map(auditText)
      .filter(Boolean),
  )
  for (const office of afterOffices) {
    if (!beforeOffices.has(office)) details.push(`Added the ${office} office.`)
  }
  for (const office of beforeOffices) {
    if (!afterOffices.has(office)) details.push(`Removed the ${office} office.`)
  }

  const uniqueDetails = Array.from(new Set(details)).slice(0, 12)
  if (uniqueDetails.length === 0) {
    return {
      summary: "Updated SPC user management settings.",
      details: ["Updated SPC user management settings."],
    }
  }

  const firstChange = uniqueDetails[0].replace(/\.$/, "")
  return {
    summary:
      uniqueDetails.length === 1
        ? uniqueDetails[0]
        : `${firstChange} and ${uniqueDetails.length - 1} other user-management ${uniqueDetails.length === 2 ? "change" : "changes"}.`,
    details: uniqueDetails,
  }
}

function getDeletedFixtureDetails(record: AuditLogRecord, recordLabel: string) {
  if (record.tableName !== "spc_fixtures" || record.operation !== "DELETE") {
    return null
  }

  const row = record.beforeRow || record.afterRow || {}
  const details = [`Deleted SPC fixture "${recordLabel}".`]
  const fixtureFieldLabels: Record<string, string> = {
    hsfo: "HSFO quantity",
    vlsfo: "VLSFO quantity",
    lsmgo: "LSMGO quantity",
  }
  for (const field of [
    "fixture_date",
    "earliest_eta",
    "supplier_name",
    "supplier_trader_display_name",
    "buyer_trader_display_name",
    "account",
    "hsfo",
    "vlsfo",
    "lsmgo",
    "price",
    "barging",
  ]) {
    const value = row[field]
    if (value === null || value === undefined || value === "") continue
    details.push(
      `${fixtureFieldLabels[field] || getFieldLabel(field)}: ${formatValue(field, value)}.`,
    )
  }
  return details.slice(0, 12)
}

function getSpcMfaTestPresentation(record: AuditLogRecord) {
  if (record.tableName !== "spc_mfa_test_events") return null

  const row = record.afterRow || {}
  const status = auditText(row.status)
  const target = auditText(row.target_username) || "MFA_TEST"
  const statusSummaries: Record<string, string> = {
    challenge_created: `Created a WhatsApp MFA test challenge for ${target}.`,
    delivery_accepted: `WhatsApp accepted the MFA test code for ${target}.`,
    delivery_failed: `SPC could not confirm WhatsApp accepted the MFA test code for ${target}.`,
    activation_failed: `SPC could not activate the WhatsApp MFA test challenge for ${target}.`,
    verification_requested: `Started WhatsApp MFA test verification for ${target}.`,
    verified: `Verified the WhatsApp MFA test code for ${target}.`,
    mismatch: `Rejected an incorrect WhatsApp MFA test code for ${target}.`,
    locked: `Locked the WhatsApp MFA test challenge for ${target}.`,
    expired: `Rejected an expired WhatsApp MFA test code for ${target}.`,
    already_used: `Rejected a reused WhatsApp MFA test code for ${target}.`,
    unavailable: `Rejected an unavailable WhatsApp MFA test challenge for ${target}.`,
  }
  const summary = statusSummaries[status] || `Recorded a WhatsApp MFA test event for ${target}.`
  const details = [summary]
  const phoneHint = auditText(row.phone_hint)
  if (/^\+[0-9]{1,2}•+[0-9]{4}$/.test(phoneHint)) {
    details.push(`Masked WhatsApp destination: ${phoneHint}.`)
  }
  const messageId = auditText(row.whatsapp_message_id)
  if (messageId) details.push(`WhatsApp message ID: ${messageId}.`)
  return { summary, details }
}

function buildSummary(
  record: AuditLogRecord,
  displayOperation: AuditOperation,
  recordLabel: string,
  insertionCorrelation?: OutlookInsertionAuditCorrelation,
) {
  const subject = subjectFor(record, recordLabel)
  if (record.undoOfLogId) return `Undid a previous change to ${subject}.`
  const mfaTestPresentation = getSpcMfaTestPresentation(record)
  if (mfaTestPresentation) return mfaTestPresentation.summary
  if (record.tableName === "spc_user_management_events") {
    const investigation = getAuditInvestigationFields(record)
    const outcome = investigation.auditOutcome === "denied" ? "Denied" : "Failed"
    const action = readableAuditCode(investigation.auditAction, "user-management action")
    const target =
      recordLabel === "SPC user-management action" ? "" : ` for "${recordLabel}"`
    return `${outcome} ${action}${target}.`
  }
  const userManagementChanges = getSpcUserManagementChanges(record)
  if (userManagementChanges) return userManagementChanges.summary
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
  const investigation = getAuditInvestigationFields(record)
  const finish = (items: string[]) =>
    Array.from(
      new Set([
        ...items,
        ...buildSpcInvestigationDetails(record, investigation),
      ]),
    ).slice(0, 24)

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

  const mfaTestPresentation = getSpcMfaTestPresentation(record)
  if (mfaTestPresentation) return finish(mfaTestPresentation.details)

  const userManagementChanges = getSpcUserManagementChanges(record)
  if (userManagementChanges) return finish(userManagementChanges.details)

  if (record.tableName === "spc_user_management_events") {
    return finish([])
  }

  const deletedFixtureDetails = getDeletedFixtureDetails(record, recordLabel)
  if (deletedFixtureDetails) return deletedFixtureDetails

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

  return finish(details)
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
    const investigation = getAuditInvestigationFields(record)

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
      ...investigation,
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
    return ["event-calendar", "task-calendar", "spc-permission-groups", "parser-reports"].includes(
      getOfficeCalendarStoreKey(record),
    )
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
      "table_schema.eq.public,and(table_schema.eq.app,table_name.in.(outlook_template_insertion_attempts,spc_user_management_events,spc_mfa_test_events))"
    )
    .in("actor_source", ["app", "header"])
    .order("occurred_at", { ascending: false })
    .limit(limit)

  if (scope === "www") {
    query = query.or("actor_id.is.null,actor_id.not.like.spc:%")
  } else if (scope === "spc") {
    query = query.or(
      "actor_id.like.spc:%,table_name.in.(spc_users,spc_enquiries,spc_enquiry_revisions,spc_delivery_routes,spc_group_delivery_jobs,spc_group_dispatchers,spc_fixtures,spc_role_defaults,spc_suppliers,spc_speedboard_notices,spc_user_management_events,spc_mfa_test_events)",
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
  auditContext?: SpcAuditContext,
) {
  const supabase = auditContext
    ? createSpcAuditedSupabaseClient(auditContext)
    : getSupabaseAuditClient()
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
