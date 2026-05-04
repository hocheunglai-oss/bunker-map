import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { google } from "googleapis"
import { createClient } from "@supabase/supabase-js"

const PROJECT_ROOT = process.cwd()
const TOKEN_PATH = path.join(PROJECT_ROOT, ".google-drive-oauth-token.json")
const OUTPUT_ROOT = path.join(PROJECT_ROOT, "backups", "bunker-map")
const RETENTION_COUNT = 12
const BACKUP_FOLDER_NAME = "Bunker Map Backups"
const WEEKLY_FOLDER_NAME = "Weekly Supabase Backups"

const TABLES = [
  { key: "phonebookContacts", table: "phonebook_contacts", order: [{ column: "full_name", ascending: true }] },
  { key: "phonebookCompanies", table: "phonebook_companies", order: [{ column: "name", ascending: true }] },
  { key: "ccCompanies", table: "cc_companies", order: [{ column: "name", ascending: true }] },
  { key: "ccCountries", table: "cc_countries", order: [{ column: "name", ascending: true }] },
  { key: "ccPorts", table: "cc_ports", order: [{ column: "name", ascending: true }] },
  { key: "ccCompanyFiles", table: "cc_company_files", order: [{ column: "file_name", ascending: true }] },
  { key: "ccEntryFiles", table: "cc_entry_files", order: [{ column: "entry_kind", ascending: true }, { column: "file_name", ascending: true }] },
  { key: "ccEntryFolders", table: "cc_entry_folders", order: [{ column: "entry_kind", ascending: true }, { column: "folder_path", ascending: true }, { column: "name", ascending: true }] },
  { key: "ports", table: "ports", order: [{ column: "display_order", ascending: true }, { column: "name", ascending: true }] },
  { key: "remarks", table: "remarks", order: [{ column: "id", ascending: true }] },
  { key: "priceHistory", table: "price_history", order: [{ column: "recorded_at", ascending: false }] },
]

function loadEnv() {
  return Object.fromEntries(
    fs
      .readFileSync(path.join(PROJECT_ROOT, ".env.local"), "utf8")
      .split("\n")
      .filter(Boolean)
      .filter((line) => !line.trim().startsWith("#"))
      .map((line) => {
        const idx = line.indexOf("=")
        return [line.slice(0, idx).trim(), line.slice(idx + 1).trim().replace(/^['"]|['"]$/g, "")]
      }),
  )
}

async function getDriveClient(env) {
  const auth = new google.auth.OAuth2(
    env.GOOGLE_OAUTH_CLIENT_ID,
    env.GOOGLE_OAUTH_CLIENT_SECRET,
    env.GOOGLE_OAUTH_REDIRECT_URI || "http://127.0.0.1",
  )
  auth.setCredentials(JSON.parse(await fsp.readFile(TOKEN_PATH, "utf8")))
  return {
    drive: google.drive({ version: "v3", auth }),
    rootFolderId: env.GOOGLE_DRIVE_BACKUP_FOLDER_ID || env.GOOGLE_DRIVE_COMPANY_FOLDER_ID,
    sharedDriveId: env.GOOGLE_DRIVE_SHARED_DRIVE_ID || null,
  }
}

async function ensureDriveFolder(drive, parentId, name, sharedDriveId) {
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

async function fetchAllRows(supabase, config) {
  const rows = []
  const pageSize = 1000
  let from = 0

  while (true) {
    let query = supabase.from(config.table).select("*").range(from, from + pageSize - 1)
    for (const item of config.order) {
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

async function buildBackupPayload(supabase) {
  const payload = {
    generatedAt: new Date().toISOString(),
    project: "bunker-map",
    counts: {},
    data: {},
  }

  for (const tableConfig of TABLES) {
    const rows = await fetchAllRows(supabase, tableConfig)
    payload.counts[tableConfig.key] = rows.length
    payload.data[tableConfig.key] = rows
    console.log(`Fetched ${rows.length} rows from ${tableConfig.table}`)
  }

  return payload
}

async function uploadBackupFile(drive, folderId, sharedDriveId, filePath) {
  const response = await drive.files.create({
    requestBody: {
      name: path.basename(filePath),
      parents: [folderId],
    },
    media: {
      mimeType: "application/json",
      body: fs.createReadStream(filePath),
    },
    fields: "id,name,webViewLink,createdTime",
    supportsAllDrives: true,
  })

  if (!response.data.id) throw new Error("Drive upload did not return a file id.")
  return response.data
}

async function pruneOldDriveBackups(drive, folderId, sharedDriveId) {
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
    console.log(`Deleted old Drive backup ${file.name || file.id}`)
  }
}

async function pruneOldLocalBackups() {
  await fsp.mkdir(OUTPUT_ROOT, { recursive: true })
  const entries = await fsp.readdir(OUTPUT_ROOT, { withFileTypes: true })
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.startsWith("bunker-map-backup-") && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort()
    .reverse()

  const stale = files.slice(RETENTION_COUNT)
  for (const name of stale) {
    await fsp.unlink(path.join(OUTPUT_ROOT, name))
    console.log(`Deleted old local backup ${name}`)
  }
}

async function main() {
  const env = loadEnv()
  if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    throw new Error("Missing Supabase env vars in .env.local")
  }

  const { drive, rootFolderId, sharedDriveId } = await getDriveClient(env)
  if (!rootFolderId) {
    throw new Error("Missing GOOGLE_DRIVE_BACKUP_FOLDER_ID or GOOGLE_DRIVE_COMPANY_FOLDER_ID in .env.local")
  }

  const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
  const payload = await buildBackupPayload(supabase)

  await fsp.mkdir(OUTPUT_ROOT, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const fileName = `bunker-map-backup-${stamp}.json`
  const filePath = path.join(OUTPUT_ROOT, fileName)
  await fsp.writeFile(filePath, JSON.stringify(payload, null, 2), "utf8")

  const backupRootId = await ensureDriveFolder(drive, rootFolderId, BACKUP_FOLDER_NAME, sharedDriveId)
  const weeklyFolderId = await ensureDriveFolder(drive, backupRootId, WEEKLY_FOLDER_NAME, sharedDriveId)
  const uploaded = await uploadBackupFile(drive, weeklyFolderId, sharedDriveId, filePath)

  await pruneOldDriveBackups(drive, weeklyFolderId, sharedDriveId)
  await pruneOldLocalBackups()

  console.log(`Backup uploaded: ${uploaded.name}`)
  console.log(uploaded.webViewLink || `https://drive.google.com/file/d/${uploaded.id}/view`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
