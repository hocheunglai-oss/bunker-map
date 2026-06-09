import { createClient } from "@supabase/supabase-js"
import type { AdminSession } from "@/lib/adminAuth"

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

export const AUDITED_TABLES = [
  "ports",
  "price_history",
  "remarks",
  "cc_countries",
  "cc_companies",
  "cc_ports",
  "cc_documents",
  "cc_company_files",
  "cc_entry_files",
  "cc_entry_folders",
  "phonebook_contacts",
  "phonebook_companies",
  "shared_addressbook_contacts",
  "shared_addressbook_groups",
  "shared_addressbook_group_members",
  "office_calendar_store",
  "email_templates",
  "admin_users",
  "admin_role_defaults",
]

const CCINFO_AUDITED_TABLES = [
  "cc_companies",
  "cc_countries",
  "cc_ports",
  "cc_company_files",
  "cc_entry_files",
  "cc_entry_folders",
]

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

export async function listAuditLogs(options: {
  tableName?: string | null
  operation?: string | null
  actor?: string | null
  limit?: number
}) {
  const supabase = getSupabaseAuditClient()
  const limit = Math.min(Math.max(options.limit || 100, 1), 500)

  let query = supabase
    .from("audit_logs")
    .select(AUDIT_SELECT)
    .order("occurred_at", { ascending: false })
    .limit(limit)

  if (options.tableName === "ccinfo") {
    query = query.in("table_name", CCINFO_AUDITED_TABLES)
  } else if (options.tableName && options.tableName !== "all") {
    query = query.eq("table_name", options.tableName)
  }

  if (
    options.operation &&
    ["INSERT", "UPDATE", "DELETE"].includes(options.operation.toUpperCase())
  ) {
    query = query.eq("operation", options.operation.toUpperCase())
  }

  const { data, error } = await query
  if (error) throw error

  const actorFilter = options.actor?.trim().toLowerCase()
  const records = ((data || []) as unknown as AuditLogRow[]).map(mapAuditLog)

  if (!actorFilter) return records

  return records.filter((record) =>
    [record.actorId, record.actorName, record.actorSource]
      .filter(Boolean)
      .some((value) => value!.toLowerCase().includes(actorFilter))
  )
}

export async function undoAuditLog(logId: string, session: AdminSession) {
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
