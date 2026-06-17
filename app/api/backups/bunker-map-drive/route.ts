import { Readable } from "node:stream"
import { createClient } from "@supabase/supabase-js"
import { drive_v3, google } from "googleapis"
import { NextResponse } from "next/server"
import { requireAdminPagePermission } from "@/lib/adminAuth"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 60

const RETENTION_COUNT = 12
const BACKUP_FOLDER_NAME = "Bunker Map Backups"
const WEEKLY_FOLDER_NAME = "Weekly Supabase Backups"

type OrderConfig = {
  column: string
  ascending: boolean
}

type TableConfig = {
  key: string
  table: string
  order?: OrderConfig[]
  optional?: boolean
}

const TABLES: TableConfig[] = [
  { key: "adminUsers", table: "admin_users", order: [{ column: "username", ascending: true }] },
  { key: "adminRoleDefaults", table: "admin_role_defaults", order: [{ column: "role", ascending: true }], optional: true },
  { key: "auditLogs", table: "audit_logs", order: [{ column: "occurred_at", ascending: false }] },
  { key: "officeCalendarStore", table: "office_calendar_store", order: [{ column: "key", ascending: true }] },
  { key: "emailTemplates", table: "email_templates", order: [{ column: "folder", ascending: true }, { column: "title", ascending: true }] },
  { key: "sharedAddressbookContacts", table: "shared_addressbook_contacts", order: [{ column: "display_name", ascending: true }] },
  { key: "sharedAddressbookGroups", table: "shared_addressbook_groups", order: [{ column: "name", ascending: true }] },
  { key: "sharedAddressbookGroupMembers", table: "shared_addressbook_group_members", order: [{ column: "group_id", ascending: true }, { column: "contact_id", ascending: true }] },
  { key: "outlookExchangeSyncQueue", table: "outlook_exchange_sync_queue", order: [{ column: "created_at", ascending: false }] },
  { key: "phonebookContacts", table: "phonebook_contacts", order: [{ column: "full_name", ascending: true }] },
  { key: "phonebookCompanies", table: "phonebook_companies", order: [{ column: "name", ascending: true }] },
  { key: "ccCompanies", table: "cc_companies", order: [{ column: "name", ascending: true }] },
  { key: "ccCountries", table: "cc_countries", order: [{ column: "name", ascending: true }] },
  { key: "ccPorts", table: "cc_ports", order: [{ column: "name", ascending: true }] },
  { key: "ccDocuments", table: "cc_documents", order: [{ column: "title", ascending: true }] },
  { key: "ccCompanyFiles", table: "cc_company_files", order: [{ column: "file_name", ascending: true }] },
  { key: "ccEntryFiles", table: "cc_entry_files", order: [{ column: "entry_kind", ascending: true }, { column: "file_name", ascending: true }] },
  { key: "ccEntryFolders", table: "cc_entry_folders", order: [{ column: "entry_kind", ascending: true }, { column: "folder_path", ascending: true }, { column: "name", ascending: true }] },
  { key: "ports", table: "ports", order: [{ column: "display_order", ascending: true }, { column: "name", ascending: true }] },
  { key: "remarks", table: "remarks", order: [{ column: "id", ascending: true }] },
  { key: "priceHistory", table: "price_history", order: [{ column: "recorded_at", ascending: false }] },
]

function requireEnv(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing environment variable: ${name}`)
  return value
}

function hasCronAccess(request: Request) {
  const secret = process.env.CRON_SECRET
  if (secret && request.headers.get("authorization") === `Bearer ${secret}`) return true
  return false
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message?: unknown }).message || "Request failed.")
  }
  return String(error || "Request failed.")
}

function isMissingTableError(error: unknown) {
  if (!error || typeof error !== "object") return false
  const code = "code" in error ? String((error as { code?: unknown }).code || "") : ""
  const message = getErrorMessage(error).toLowerCase()
  return code === "PGRST205" || message.includes("could not find the table") || message.includes("does not exist")
}

function getSupabaseClient() {
  return createClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    process.env.SUPABASE_SERVICE_ROLE_KEY || requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY")
  )
}

function getDriveClient() {
  const auth = new google.auth.OAuth2(
    requireEnv("GOOGLE_OAUTH_CLIENT_ID"),
    requireEnv("GOOGLE_OAUTH_CLIENT_SECRET"),
    process.env.GOOGLE_OAUTH_REDIRECT_URI || "http://127.0.0.1"
  )
  auth.setCredentials({ refresh_token: requireEnv("GOOGLE_DRIVE_REFRESH_TOKEN") })

  return {
    drive: google.drive({ version: "v3", auth }),
    rootFolderId: process.env.GOOGLE_DRIVE_BACKUP_FOLDER_ID || requireEnv("GOOGLE_DRIVE_COMPANY_FOLDER_ID"),
    sharedDriveId: process.env.GOOGLE_DRIVE_SHARED_DRIVE_ID || null,
  }
}

async function ensureDriveFolder(
  drive: drive_v3.Drive,
  parentId: string,
  name: string,
  sharedDriveId: string | null
) {
  const escapedName = name.replace(/'/g, "\\'")
  const lookup = await drive.files.list({
    q: `trashed = false and mimeType = 'application/vnd.google-apps.folder' and name = '${escapedName}' and '${parentId}' in parents`,
    fields: "files(id,name,createdTime)",
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    corpora: sharedDriveId ? "drive" : undefined,
    driveId: sharedDriveId || undefined,
  })

  const existing = lookup.data.files?.[0]
  if (existing?.id) return existing.id

  const created = await drive.files.create({
    requestBody: {
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId],
    },
    fields: "id",
    supportsAllDrives: true,
  })

  if (!created.data.id) throw new Error(`Unable to create Drive folder: ${name}`)
  return created.data.id
}

async function fetchAllRows(
  supabase: ReturnType<typeof getSupabaseClient>,
  config: TableConfig
) {
  const rows: unknown[] = []
  const pageSize = 1000
  let from = 0

  while (true) {
    let query = supabase.from(config.table).select("*").range(from, from + pageSize - 1)
    for (const item of config.order || []) {
      query = query.order(item.column, { ascending: item.ascending })
    }

    const { data, error } = await query
    if (error) throw error

    const batch = data || []
    rows.push(...batch)
    if (batch.length < pageSize) break
    from += pageSize
  }

  return rows
}

async function buildBackupPayload() {
  const supabase = getSupabaseClient()
  const counts: Record<string, number> = {}
  const data: Record<string, unknown[]> = {}
  const warnings: Array<{ key: string; table: string; message: string }> = []

  for (const tableConfig of TABLES) {
    let rows: unknown[]
    try {
      rows = await fetchAllRows(supabase, tableConfig)
    } catch (error) {
      if (tableConfig.optional && isMissingTableError(error)) {
        rows = []
        warnings.push({
          key: tableConfig.key,
          table: tableConfig.table,
          message: getErrorMessage(error),
        })
      } else {
        throw new Error(`Backup failed while reading ${tableConfig.table}: ${getErrorMessage(error)}`)
      }
    }
    counts[tableConfig.key] = rows.length
    data[tableConfig.key] = rows
  }

  return {
    generatedAt: new Date().toISOString(),
    project: "bunker-map",
    source: "vercel-cron",
    counts,
    data,
    warnings,
  }
}

async function uploadBackupFile(
  drive: drive_v3.Drive,
  folderId: string,
  fileName: string,
  content: string
) {
  const response = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [folderId],
    },
    media: {
      mimeType: "application/json",
      body: Readable.from([content]),
    },
    fields: "id,name,webViewLink,createdTime",
    supportsAllDrives: true,
  })

  if (!response.data.id) throw new Error("Drive upload did not return a file id.")
  return response.data
}

async function pruneOldDriveBackups(
  drive: drive_v3.Drive,
  folderId: string,
  sharedDriveId: string | null
) {
  const list = await drive.files.list({
    q: `trashed = false and '${folderId}' in parents`,
    fields: "files(id,name,createdTime)",
    orderBy: "createdTime desc",
    pageSize: 100,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    corpora: sharedDriveId ? "drive" : undefined,
    driveId: sharedDriveId || undefined,
  })

  const files = list.data.files || []
  const stale = files.slice(RETENTION_COUNT)
  for (const file of stale) {
    if (!file.id) continue
    await drive.files.delete({ fileId: file.id, supportsAllDrives: true })
  }

  return stale.length
}

export async function GET(request: Request) {
  if (!hasCronAccess(request)) {
    try {
      await requireAdminPagePermission("audit-log", "view")
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unauthorized"
      return NextResponse.json(
        { message },
        { status: message === "Unauthorized" ? 401 : 403 }
      )
    }
  }

  try {
    const payload = await buildBackupPayload()
    const content = JSON.stringify(payload, null, 2)
    const stamp = new Date().toISOString().replace(/[:.]/g, "-")
    const fileName = `bunker-map-backup-${stamp}.json`
    const { drive, rootFolderId, sharedDriveId } = getDriveClient()
    const backupRootId = await ensureDriveFolder(drive, rootFolderId, BACKUP_FOLDER_NAME, sharedDriveId)
    const weeklyFolderId = await ensureDriveFolder(drive, backupRootId, WEEKLY_FOLDER_NAME, sharedDriveId)
    const uploaded = await uploadBackupFile(drive, weeklyFolderId, fileName, content)
    const pruned = await pruneOldDriveBackups(drive, weeklyFolderId, sharedDriveId)

    return NextResponse.json({
      success: true,
      file: uploaded,
      counts: payload.counts,
      warnings: payload.warnings,
      pruned,
    })
  } catch (error) {
    return NextResponse.json(
      { message: getErrorMessage(error) },
      { status: 500 }
    )
  }
}
