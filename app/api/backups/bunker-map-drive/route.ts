import { createHash, randomUUID } from "node:crypto"
import { createReadStream, createWriteStream } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { once } from "node:events"
import { PassThrough } from "node:stream"
import { finished } from "node:stream/promises"
import { createClient } from "@supabase/supabase-js"
import type { drive_v3 } from "googleapis"
import { NextResponse } from "next/server"
import { requireAdminPagePermission } from "@/lib/adminAuth"
import { loadGoogleApis } from "@/lib/googleApis"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 300

const RETENTION_DAYS = 35
const BACKUP_FOLDER_NAME = "Bunker Map Backups"
const DAILY_FOLDER_NAME = "Daily Supabase Backups"
const BACKUP_SCHEMA_VERSION = 2
const BACKUP_INTEGRITY_SCHEMA = "bunker-map-backup-integrity/v2"
const BACKUP_FILE_SCHEMA = "bunker-map-backup/v2"
const BACKUP_STREAM_VERIFICATION_SCHEMA =
  "bunker-map-backup-stream-verification/v1"
const TRUTH_CHECKPOINT_SCHEMA = "fcuno-exchange-backup-checkpoint/v1"
const BACKUP_INVENTORY_SCHEMA = "bunker-map.backup-inventory/v1"
const BACKUP_LOCK_NAME = "daily-supabase-drive-v2"
const BACKUP_LOCK_LEASE_SECONDS = 15 * 60
const BACKUP_EXPORT_PAGE_SIZE = 500
const MAX_TEMP_BACKUP_BYTES = 400 * 1024 * 1024
const BACKUP_FILE_NAME_PATTERN =
  /^bunker-map-backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.json$/

type PreviousVerifiedBackup = {
  fileId: string
  name: string
  createdTime: string | null
  artifactSha256: string
  uploadedFileSha256: string
}

type BackupProvenance = {
  backupRunId: string
  source: "vercel-cron" | "admin-manual"
  requestedBy: string
}

type OrderConfig = {
  column: string
  ascending: boolean
}

type TableConfig = {
  key: string
  table: string
  order?: OrderConfig[]
  optional?: boolean
  omitColumns?: string[]
}

type BackupSectionManifest = Record<
  string,
  {
    rowCount: number
    sha256: string
  }
>

type BackupDataWriter = {
  stream: ReturnType<typeof createWriteStream>
  byteLength: number
}

type BackupFinalWriter = {
  stream: PassThrough
  artifactHasher: ReturnType<typeof createHash>
  fileHasher: ReturnType<typeof createHash>
  fileByteLength: number
}

type PreparedBackupData = {
  dataPath: string
  artifactPrefix: Record<string, unknown>
  counts: Record<string, number>
  sections: BackupSectionManifest
  truth: Record<string, unknown>
  truthHeadSequence: number
  truthHeadSha256: string
  databaseEpoch: number
  migrationHead: string
  inventorySha256: string
  catalogSha256: string
  liveTableCount: number
  sectionCount: number
  totalRecordCount: number
  latestCertificationRunId: string
  latestProjectionSnapshotSha256: string
  generatedAt: string
}

type StreamedBackupFile = {
  artifactSha256: string
  uploadedFileSha256: string
  fileByteLength: number
}

const TABLES: TableConfig[] = [
  { key: "admins", table: "admins", order: [{ column: "id", ascending: true }] },
  {
    key: "adminUsers",
    table: "admin_users",
    order: [{ column: "id", ascending: true }],
    omitColumns: ["password_hash"],
  },
  { key: "adminRoleDefaults", table: "admin_role_defaults", order: [{ column: "role", ascending: true }], optional: true },
  { key: "auditLogs", table: "audit_logs", order: [{ column: "id", ascending: true }] },
  { key: "officeCalendarStore", table: "office_calendar_store", order: [{ column: "key", ascending: true }] },
  { key: "emailTemplates", table: "email_templates", order: [{ column: "id", ascending: true }] },
  { key: "sharedAddressbookContacts", table: "shared_addressbook_contacts", order: [{ column: "id", ascending: true }] },
  { key: "sharedAddressbookGroups", table: "shared_addressbook_groups", order: [{ column: "id", ascending: true }] },
  { key: "sharedAddressbookGroupMembers", table: "shared_addressbook_group_members", order: [{ column: "group_id", ascending: true }, { column: "contact_id", ascending: true }] },
  { key: "outlookExchangeSyncQueue", table: "outlook_exchange_sync_queue", order: [{ column: "id", ascending: true }] },
  { key: "phonebookContacts", table: "phonebook_contacts", order: [{ column: "id", ascending: true }] },
  { key: "phonebookCompanies", table: "phonebook_companies", order: [{ column: "id", ascending: true }] },
  { key: "ccCompanies", table: "cc_companies", order: [{ column: "id", ascending: true }] },
  { key: "ccCountries", table: "cc_countries", order: [{ column: "id", ascending: true }] },
  { key: "ccPorts", table: "cc_ports", order: [{ column: "id", ascending: true }] },
  { key: "ccDocuments", table: "cc_documents", order: [{ column: "id", ascending: true }] },
  { key: "ccCompanyFiles", table: "cc_company_files", order: [{ column: "id", ascending: true }] },
  { key: "ccEntryFiles", table: "cc_entry_files", order: [{ column: "id", ascending: true }] },
  { key: "ccEntryFolders", table: "cc_entry_folders", order: [{ column: "id", ascending: true }] },
  { key: "ports", table: "ports", order: [{ column: "id", ascending: true }] },
  { key: "remarks", table: "remarks", order: [{ column: "id", ascending: true }] },
  { key: "priceHistory", table: "price_history", order: [{ column: "id", ascending: true }] },
  { key: "whatsappConversations", table: "whatsapp_conversations", order: [{ column: "id", ascending: true }] },
  { key: "whatsappMessages", table: "whatsapp_messages", order: [{ column: "id", ascending: true }] },
  {
    key: "spcUsers",
    table: "spc_users",
    order: [{ column: "id", ascending: true }],
    omitColumns: ["password_hash"],
  },
  { key: "spcEnquiries", table: "spc_enquiries", order: [{ column: "id", ascending: true }] },
  { key: "spcFixtures", table: "spc_fixtures", order: [{ column: "id", ascending: true }] },
  { key: "spcSuppliers", table: "spc_suppliers", order: [{ column: "key", ascending: true }] },
  { key: "parserReports", table: "parser_reports", order: [{ column: "id", ascending: true }] },
  { key: "openAiUsageEvents", table: "openai_usage_events", order: [{ column: "id", ascending: true }] },
  { key: "spcPresentationChunks", table: "spc_presentation_chunks", order: [{ column: "id", ascending: true }] },
]

const TRUTH_MANAGED_TABLES = new Set([
  "outlook_exchange_sync_certifications",
  "outlook_exchange_truth_snapshots",
  "outlook_exchange_truth_ledger",
])

const EXPLICITLY_EPHEMERAL_TABLES = new Set([
  "outlook_exchange_sync_lock",
  "bunker_map_backup_lock",
  "admin_sessions",
])

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

function redactPasswordHashSnapshot(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value
  const sanitized = { ...(value as Record<string, unknown>) }
  delete sanitized.password_hash
  return sanitized
}

function sanitizeBackupTableRow(
  config: TableConfig,
  row: Record<string, unknown>
) {
  const sanitized = { ...row }
  for (const column of config.omitColumns || []) delete sanitized[column]

  if (
    config.table === "audit_logs" &&
    ["admin_users", "spc_users"].includes(String(sanitized.table_name || ""))
  ) {
    sanitized.before_row = redactPasswordHashSnapshot(sanitized.before_row)
    sanitized.after_row = redactPasswordHashSnapshot(sanitized.after_row)
    if (Array.isArray(sanitized.changed_fields)) {
      sanitized.changed_fields = sanitized.changed_fields.filter(
        (field) => field !== "password_hash"
      )
    }
  }

  return sanitized
}

function getSupabaseClient() {
  return createClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    }
  )
}

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex")
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} did not return an object.`)
  }
  return value as Record<string, unknown>
}

function requiredNonNegativeInteger(value: unknown, label: string) {
  const parsed = typeof value === "number" ? value : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${label} is not a safe non-negative integer.`)
  }
  return parsed
}

function requiredPositiveInteger(value: unknown, label: string) {
  const parsed = requiredNonNegativeInteger(value, label)
  if (parsed < 1) throw new Error(`${label} must be greater than zero.`)
  return parsed
}

function requiredSha256(value: unknown, label: string) {
  const parsed = String(value || "")
  if (!/^[0-9a-f]{64}$/.test(parsed)) {
    throw new Error(`${label} is not a valid SHA-256 value.`)
  }
  return parsed
}

function getDeploymentCommit() {
  const candidate =
    process.env.VERCEL_GIT_COMMIT_SHA ||
    process.env.DEPLOY_COMMIT ||
    process.env.NEXT_PUBLIC_DEPLOY_COMMIT ||
    ""
  return /^[0-9a-f]{7,64}$/i.test(candidate) ? candidate : null
}

async function getDriveClient() {
  const { google } = await loadGoogleApis()
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

async function getGoogleOAuthClient(refreshToken: string) {
  const { google } = await loadGoogleApis()
  const auth = new google.auth.OAuth2(
    requireEnv("GOOGLE_OAUTH_CLIENT_ID"),
    requireEnv("GOOGLE_OAUTH_CLIENT_SECRET"),
    process.env.GOOGLE_OAUTH_REDIRECT_URI || "http://127.0.0.1"
  )
  auth.setCredentials({ refresh_token: refreshToken })
  return auth
}

async function streamGoogleContacts(
  appendRows: (rows: unknown[]) => Promise<void>
) {
  const { google } = await loadGoogleApis()
  const refreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN
  if (!refreshToken) throw new Error("GOOGLE_OAUTH_REFRESH_TOKEN is not configured.")

  const people = google.people({ version: "v1", auth: await getGoogleOAuthClient(refreshToken) })
  let pageToken: string | undefined

  do {
    const response = await people.people.connections.list({
      resourceName: "people/me",
      pageSize: 1000,
      pageToken,
      personFields: [
        "addresses",
        "biographies",
        "birthdays",
        "emailAddresses",
        "events",
        "memberships",
        "metadata",
        "names",
        "nicknames",
        "organizations",
        "phoneNumbers",
        "photos",
        "relations",
        "urls",
      ].join(","),
    })
    await appendRows(response.data.connections || [])
    pageToken = response.data.nextPageToken || undefined
  } while (pageToken)
}

async function streamGoogleCalendarEvents(
  appendRows: (rows: unknown[]) => Promise<void>
) {
  const { google } = await loadGoogleApis()
  const refreshToken = process.env.GOOGLE_CALENDAR_REFRESH_TOKEN
  if (!refreshToken) throw new Error("GOOGLE_CALENDAR_REFRESH_TOKEN is not configured.")

  const calendar = google.calendar({ version: "v3", auth: await getGoogleOAuthClient(refreshToken) })
  const calendarId =
    process.env.GOOGLE_MEETING_CALENDAR_ID ||
    process.env.GOOGLE_CALENDAR_ID ||
    "fcb.bunker@gmail.com"
  let pageToken: string | undefined

  do {
    const response = await calendar.events.list({
      calendarId,
      maxResults: 2500,
      pageToken,
      showDeleted: true,
      singleEvents: false,
    })
    await appendRows(response.data.items || [])
    pageToken = response.data.nextPageToken || undefined
  } while (pageToken)

  return calendarId
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

async function writeDataChunk(
  writer: BackupDataWriter,
  value: string | Buffer
) {
  const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8")
  writer.byteLength += chunk.byteLength
  if (writer.byteLength > MAX_TEMP_BACKUP_BYTES) {
    throw new Error(
      `Backup data exceeds the ${MAX_TEMP_BACKUP_BYTES}-byte bounded temporary-storage limit.`
    )
  }
  if (!writer.stream.write(chunk)) {
    await once(writer.stream, "drain")
  }
}

async function writeFinalChunk(
  writer: BackupFinalWriter,
  value: string | Buffer,
  includeInArtifact = true
) {
  const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8")
  writer.fileHasher.update(chunk)
  if (includeInArtifact) writer.artifactHasher.update(chunk)
  writer.fileByteLength += chunk.byteLength
  if (!writer.stream.write(chunk)) {
    await once(writer.stream, "drain")
  }
}

async function writeBackupSection(
  writer: BackupDataWriter,
  key: string,
  isFirstSection: boolean,
  producer: (
    appendRows: (rows: unknown[]) => Promise<void>
  ) => Promise<void>,
  sections: BackupSectionManifest,
  counts: Record<string, number>,
  includeInCounts = true
) {
  await writeDataChunk(
    writer,
    `${isFirstSection ? "" : ","}${JSON.stringify(key)}:[`
  )
  const sectionHasher = createHash("sha256")
  sectionHasher.update("[")
  let rowCount = 0

  const appendRows = async (rows: unknown[]) => {
    if (!rows.length) return
    const serializedRows = rows.map((row) => {
      const serialized = JSON.stringify(row)
      if (serialized === undefined) {
        throw new Error(`Backup section ${key} contains an unserializable row.`)
      }
      return serialized
    })
    const chunk = `${rowCount ? "," : ""}${serializedRows.join(",")}`
    await writeDataChunk(writer, chunk)
    sectionHasher.update(chunk)
    rowCount += rows.length
  }

  await producer(appendRows)
  await writeDataChunk(writer, "]")
  sectionHasher.update("]")
  sections[key] = {
    rowCount,
    sha256: sectionHasher.digest("hex"),
  }
  if (includeInCounts) counts[key] = rowCount
  return rowCount
}

async function streamTableRows(
  supabase: ReturnType<typeof getSupabaseClient>,
  config: TableConfig,
  appendRows: (rows: unknown[]) => Promise<void>
) {
  for (let from = 0; ; from += BACKUP_EXPORT_PAGE_SIZE) {
    let query = supabase
      .from(config.table)
      .select("*")
      .range(from, from + BACKUP_EXPORT_PAGE_SIZE - 1)
    for (const item of config.order || []) {
      query = query.order(item.column, { ascending: item.ascending })
    }

    const { data, error } = await query
    if (error) throw error

    const batch = (data || []).map((row) =>
      sanitizeBackupTableRow(config, row as Record<string, unknown>)
    )
    await appendRows(batch)
    if (batch.length < BACKUP_EXPORT_PAGE_SIZE) break
  }
}

async function getBackupInventory(
  supabase: ReturnType<typeof getSupabaseClient>
) {
  const { data, error } = await supabase.rpc("get_bunker_map_backup_inventory")
  if (error) throw error
  const inventory = asRecord(data, "Backup database inventory")
  if (inventory.schema !== BACKUP_INVENTORY_SCHEMA) {
    throw new Error("Backup database inventory returned an unsupported schema.")
  }

  const migrationHead = String(inventory.migrationHead || "")
  if (!/^\d{14}$/.test(migrationHead)) {
    throw new Error("Backup database inventory did not return a valid live migration head.")
  }
  if (
    !Array.isArray(inventory.tables) ||
    inventory.tables.some((table) => typeof table !== "string" || !table)
  ) {
    throw new Error("Backup database inventory did not return a valid public table list.")
  }
  if (
    !Array.isArray(inventory.unfencedTables) ||
    inventory.unfencedTables.some(
      (table) => typeof table !== "string" || !table
    ) ||
    inventory.unfencedTables.length > 0
  ) {
    throw new Error(
      `Backup database inventory has mutation-unfenced tables: ${
        Array.isArray(inventory.unfencedTables)
          ? inventory.unfencedTables.join(", ") || "none"
          : "inventory contract missing"
      }.`
    )
  }

  const liveTables = new Set(inventory.tables as string[])
  const catalogSha256 = requiredSha256(
    inventory.catalogSha256,
    "Backup database catalog SHA-256"
  )
  const registeredTables = new Set([
    ...TABLES.map((config) => config.table),
    ...TRUTH_MANAGED_TABLES,
    ...EXPLICITLY_EPHEMERAL_TABLES,
  ])
  const unregistered = [...liveTables]
    .filter((table) => !registeredTables.has(table))
    .sort()
  const missingRequired = TABLES
    .filter((config) => !config.optional && !liveTables.has(config.table))
    .map((config) => config.table)
    .sort()
  const missingTruth = [...TRUTH_MANAGED_TABLES]
    .filter((table) => !liveTables.has(table))
    .sort()

  if (unregistered.length || missingRequired.length || missingTruth.length) {
    throw new Error(
      `Backup table coverage is incomplete: ${JSON.stringify({
        unregistered,
        missingRequired,
        missingTruth,
      })}`
    )
  }

  return {
    migrationHead,
    catalogSha256,
    liveTables,
    registeredTables: [...registeredTables].sort(),
    explicitlyEphemeralTables: [...EXPLICITLY_EPHEMERAL_TABLES].sort(),
  }
}

async function callTruthRpc(
  supabase: ReturnType<typeof getSupabaseClient>,
  functionName:
    | "verify_outlook_exchange_truth_ledger"
    | "get_outlook_exchange_truth_checkpoint"
    | "verify_outlook_template_recipient_truth"
) {
  const { data, error } = await supabase.rpc(functionName)
  if (error) throw error
  return asRecord(data, functionName)
}

async function getBackupExportEpoch(
  supabase: ReturnType<typeof getSupabaseClient>
) {
  const { data, error } = await supabase.rpc(
    "get_bunker_map_backup_export_fence"
  )
  if (error) throw error
  const fence = asRecord(data, "Backup export fence")
  if (
    fence.schema !== "bunker-map.backup-export-fence/v1" ||
    fence.ready !== true
  ) {
    throw new Error(
      "A tracked database write transaction is active; backup export will retry from a clean fence."
    )
  }
  return requiredNonNegativeInteger(fence.epoch, "Backup export epoch")
}

function validateTruthVerification(
  verification: Record<string, unknown>,
  label: string
) {
  if (
    verification.valid !== true ||
    verification.integrityValid !== true ||
    verification.ledgerValid !== true ||
    verification.snapshotsValid !== true ||
    verification.referencesValid !== true ||
    verification.latestCertificationHasProjectionEvidence !== true ||
    verification.operationallyConsistent !== true ||
    !/^[0-9a-f]{64}$/.test(
      String(verification.latestProjectionSnapshotSha256 || "")
    ) ||
    verification.latestProjectionSnapshotSha256 !==
      verification.latestSourceFingerprint
  ) {
    throw new Error(
      `${label} failed: ${JSON.stringify({
        valid: verification.valid,
        integrityValid: verification.integrityValid,
        ledgerValid: verification.ledgerValid,
        snapshotsValid: verification.snapshotsValid,
        referencesValid: verification.referencesValid,
        latestCertificationHasProjectionEvidence:
          verification.latestCertificationHasProjectionEvidence,
        operationallyConsistent: verification.operationallyConsistent,
        firstInvalidLedgerSequence: verification.firstInvalidLedgerSequence,
        firstInvalidSnapshotSha256: verification.firstInvalidSnapshotSha256,
        firstInvalidReferenceLedgerSequence:
          verification.firstInvalidReferenceLedgerSequence,
      })}`
    )
  }

  return {
    headSequence: requiredPositiveInteger(
      verification.headSequence,
      `${label}.headSequence`
    ),
    headSha256: requiredSha256(
      verification.headSha256,
      `${label}.headSha256`
    ),
    ledgerEntries: requiredPositiveInteger(
      verification.ledgerEntries,
      `${label}.ledgerEntries`
    ),
    snapshots: requiredPositiveInteger(
      verification.snapshots,
      `${label}.snapshots`
    ),
  }
}

function validateTruthCheckpoint(
  checkpoint: Record<string, unknown>,
  label: string
) {
  const queue = asRecord(checkpoint.queue, `${label}.queue`)
  const pending = requiredNonNegativeInteger(queue.pending, `${label}.queue.pending`)
  const processing = requiredNonNegativeInteger(
    queue.processing,
    `${label}.queue.processing`
  )
  const failed = requiredNonNegativeInteger(queue.failed, `${label}.queue.failed`)
  const terminalFailed = requiredNonNegativeInteger(
    queue.terminalFailed,
    `${label}.queue.terminalFailed`
  )
  if (
    checkpoint.checkpointValid !== true ||
    checkpoint.latestCertificationHasProjectionEvidence !== true ||
    !/^[0-9a-f]{64}$/.test(
      String(checkpoint.latestProjectionSnapshotSha256 || "")
    ) ||
    checkpoint.latestProjectionSnapshotSha256 !== checkpoint.latestSourceFingerprint ||
    pending !== 0 ||
    processing !== 0 ||
    failed !== 0 ||
    terminalFailed !== 0
  ) {
    throw new Error(
      `${label} is not an operationally consistent certified checkpoint.`
    )
  }

  return {
    headSequence: requiredPositiveInteger(
      checkpoint.headSequence,
      `${label}.headSequence`
    ),
    headSha256: requiredSha256(
      checkpoint.headSha256,
      `${label}.headSha256`
    ),
    ledgerEntries: requiredPositiveInteger(
      checkpoint.ledgerEntries,
      `${label}.ledgerEntries`
    ),
    snapshots: requiredPositiveInteger(
      checkpoint.snapshots,
      `${label}.snapshots`
    ),
    certificationRunId: String(
      checkpoint.latestCertificationRunId || ""
    ),
    certifiedAt: String(checkpoint.latestCertificationAt || ""),
    sourceFingerprint: requiredSha256(
      checkpoint.latestSourceFingerprint,
      `${label}.latestSourceFingerprint`
    ),
  }
}

function validateTemplateRecipientTruth(
  verification: Record<string, unknown>,
  checkpoint: ReturnType<typeof validateTruthCheckpoint>,
  label: string
) {
  const templates = asRecord(verification.templates, `${label}.templates`)
  const queue = asRecord(verification.queue, `${label}.queue`)
  const total = requiredNonNegativeInteger(
    templates.total,
    `${label}.templates.total`
  )
  const sendable = requiredNonNegativeInteger(
    templates.sendable,
    `${label}.templates.sendable`
  )
  const missing = requiredNonNegativeInteger(
    templates.withMissingRecipients,
    `${label}.templates.withMissingRecipients`
  )
  const ambiguous = requiredNonNegativeInteger(
    templates.withAmbiguousRecipients,
    `${label}.templates.withAmbiguousRecipients`
  )
  const unresolved = requiredNonNegativeInteger(
    templates.unresolved,
    `${label}.templates.unresolved`
  )
  const stale = requiredNonNegativeInteger(
    templates.stale,
    `${label}.templates.stale`
  )
  const invalidShape = requiredNonNegativeInteger(
    templates.invalidShape,
    `${label}.templates.invalidShape`
  )
  const allTemplatesSendable = verification.allTemplatesSendable === true

  if (
    verification.schema !== "fcuno.outlook-template-recipient-truth/v2" ||
    verification.valid !== true ||
    unresolved !== 0 ||
    stale !== 0 ||
    invalidShape !== 0 ||
    sendable > total ||
    missing > total ||
    ambiguous > total ||
    sendable + missing + ambiguous < total ||
    allTemplatesSendable !==
      (sendable === total && missing === 0 && ambiguous === 0) ||
    String(verification.certificationRunId || "") !==
      checkpoint.certificationRunId ||
    String(verification.certifiedAt || "") !== checkpoint.certifiedAt ||
    String(verification.sourceFingerprint || "") !==
      checkpoint.sourceFingerprint ||
    Number(queue.pending ?? -1) !== 0 ||
    Number(queue.processing ?? -1) !== 0 ||
    Number(queue.failed ?? -1) !== 0 ||
    Number(queue.terminalFailed ?? -1) !== 0
  ) {
    throw new Error(
      `${label} is not aligned with the latest settled Exchange projection.`
    )
  }

  return {
    certificationRunId: checkpoint.certificationRunId,
    certifiedAt: checkpoint.certifiedAt,
    sourceFingerprint: checkpoint.sourceFingerprint,
    total,
    sendable,
    missing,
    ambiguous,
    unresolved,
    stale,
    invalidShape,
    allTemplatesSendable,
  }
}

function assertSameTemplateRecipientTruth(
  before: ReturnType<typeof validateTemplateRecipientTruth>,
  after: ReturnType<typeof validateTemplateRecipientTruth>
) {
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error(
      `Outlook template recipient truth changed during backup: ${JSON.stringify({
        before,
        after,
      })}`
    )
  }
}

function assertSameTruthHead(
  left: {
    headSequence: number
    headSha256: string
    ledgerEntries: number
    snapshots: number
  },
  right: {
    headSequence: number
    headSha256: string
    ledgerEntries: number
    snapshots: number
  },
  label: string
) {
  if (
    left.headSequence !== right.headSequence ||
    left.headSha256 !== right.headSha256 ||
    left.ledgerEntries !== right.ledgerEntries ||
    left.snapshots !== right.snapshots
  ) {
    throw new Error(
      `${label} changed during backup: ${JSON.stringify({ before: left, after: right })}`
    )
  }
}

async function buildBackupFile(
  supabase: ReturnType<typeof getSupabaseClient>,
  filePath: string,
  previousVerifiedBackup: PreviousVerifiedBackup | null,
  provenance: BackupProvenance,
  inventory: Awaited<ReturnType<typeof getBackupInventory>>
): Promise<PreparedBackupData> {
  const counts: Record<string, number> = {}
  const sections: BackupSectionManifest = {}

  let verificationBeforeExport: Record<string, unknown>
  let checkpointBeforeExport: Record<string, unknown>
  let templateRecipientVerificationBeforeExport: Record<string, unknown>
  let databaseEpochBefore: number
  try {
    databaseEpochBefore = await getBackupExportEpoch(supabase)
    ;[
      verificationBeforeExport,
      checkpointBeforeExport,
      templateRecipientVerificationBeforeExport,
    ] = await Promise.all([
      callTruthRpc(supabase, "verify_outlook_exchange_truth_ledger"),
      callTruthRpc(supabase, "get_outlook_exchange_truth_checkpoint"),
      callTruthRpc(supabase, "verify_outlook_template_recipient_truth"),
    ])
  } catch (error) {
    throw new Error(
      `Backup failed while capturing the Exchange truth checkpoint: ${getErrorMessage(error)}`
    )
  }

  const verifiedBefore = validateTruthVerification(
    verificationBeforeExport,
    "Exchange truth verification before export"
  )
  const checkpointBefore = validateTruthCheckpoint(
    checkpointBeforeExport,
    "Exchange truth checkpoint before export"
  )
  assertSameTruthHead(
    verifiedBefore,
    checkpointBefore,
    "Exchange truth verifier and checkpoint"
  )
  const templateRecipientTruthBefore = validateTemplateRecipientTruth(
    templateRecipientVerificationBeforeExport,
    checkpointBefore,
    "Outlook template recipient truth before export"
  )

  const generatedAt = new Date().toISOString()
  const artifactPrefix = {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    backupRunId: provenance.backupRunId,
    generatedAt,
    project: "bunker-map",
    source: provenance.source,
    requestedBy: provenance.requestedBy,
    migrationHead: inventory.migrationHead,
    deploymentCommit: getDeploymentCommit(),
    previousVerifiedBackup,
    databaseInventory: {
      schema: BACKUP_INVENTORY_SCHEMA,
      liveTables: [...inventory.liveTables].sort(),
      registeredTables: inventory.registeredTables,
      explicitlyEphemeralTables: inventory.explicitlyEphemeralTables,
      excludedCredentialFields: [
        "admin_users.password_hash",
        "spc_users.password_hash",
      ],
    },
  }
  const writer: BackupDataWriter = {
    stream: createWriteStream(filePath, { flags: "wx", mode: 0o600 }),
    byteLength: 0,
  }

  try {
    await writeDataChunk(writer, "{")
    let isFirstSection = true

    for (const tableConfig of TABLES) {
      try {
        await writeBackupSection(
          writer,
          tableConfig.key,
          isFirstSection,
          async (appendRows) => {
            if (
              tableConfig.optional &&
              !inventory.liveTables.has(tableConfig.table)
            ) {
              return
            }
            await streamTableRows(supabase, tableConfig, appendRows)
          },
          sections,
          counts
        )
      } catch (error) {
        throw new Error(
          `Backup failed while reading ${tableConfig.table}: ${getErrorMessage(error)}`
        )
      }
      isFirstSection = false
    }

    const referencedSnapshotHashes = new Set<string>()
    const certificationRunIds = new Set<string>()
    try {
      let scannedLedgerCount = 0
      let scannedLedgerHeadSequence = 0
      let scannedLedgerHeadSha256 = ""
      while (scannedLedgerHeadSequence < checkpointBefore.headSequence) {
        const { data, error } = await supabase
          .from("outlook_exchange_truth_ledger")
          .select("*")
          .gt("ledger_sequence", scannedLedgerHeadSequence)
          .lte("ledger_sequence", checkpointBefore.headSequence)
          .order("ledger_sequence", { ascending: true })
          .limit(BACKUP_EXPORT_PAGE_SIZE)
        if (error) throw error

        const batch = (data || []) as Array<Record<string, unknown>>
        if (!batch.length) break
        for (const row of batch) {
          const sequence = requiredPositiveInteger(
            row.ledger_sequence,
            "outlook_exchange_truth_ledger.ledger_sequence"
          )
          if (
            sequence <= scannedLedgerHeadSequence ||
            sequence > checkpointBefore.headSequence
          ) {
            throw new Error(
              "Truth-ledger scan order or upper bound was violated."
            )
          }
          scannedLedgerHeadSequence = sequence
          scannedLedgerHeadSha256 = requiredSha256(
            row.entry_sha256,
            "outlook_exchange_truth_ledger.entry_sha256"
          )
          const snapshotSha256 = String(row.snapshot_sha256 || "")
          if (snapshotSha256) {
            referencedSnapshotHashes.add(
              requiredSha256(
                snapshotSha256,
                "outlook_exchange_truth_ledger.snapshot_sha256"
              )
            )
          }
          if (
            row.event_type === "full_certification" ||
            row.event_type === "legacy_full_certification"
          ) {
            const runId = String(row.run_id || "")
            if (runId) certificationRunIds.add(runId)
          }
        }
        scannedLedgerCount += batch.length
        if (batch.length < BACKUP_EXPORT_PAGE_SIZE) break
      }
      if (
        scannedLedgerCount !== checkpointBefore.ledgerEntries ||
        scannedLedgerHeadSequence !== checkpointBefore.headSequence ||
        scannedLedgerHeadSha256 !== checkpointBefore.headSha256
      ) {
        throw new Error(
          `Scanned truth-ledger head does not match the checkpoint: expected ${checkpointBefore.ledgerEntries} row(s) at ${checkpointBefore.headSequence}/${checkpointBefore.headSha256}; received ${scannedLedgerCount} row(s) at ${scannedLedgerHeadSequence}/${scannedLedgerHeadSha256 || "none"}.`
        )
      }

      let unexpectedCertification = ""
      const certificationCount = await writeBackupSection(
        writer,
        "outlookExchangeSyncCertifications",
        isFirstSection,
        async (appendRows) => {
          await streamTableRows(
            supabase,
            {
              key: "outlookExchangeSyncCertifications",
              table: "outlook_exchange_sync_certifications",
              order: [{ column: "run_id", ascending: true }],
            },
            async (rows) => {
              for (const row of rows as Array<Record<string, unknown>>) {
                const runId = String(row.run_id || "")
                if (!certificationRunIds.has(runId)) {
                  unexpectedCertification = runId || "missing-run-id"
                }
              }
              await appendRows(rows)
            }
          )
        },
        sections,
        counts
      )
      isFirstSection = false
      if (
        certificationCount !== certificationRunIds.size ||
        unexpectedCertification
      ) {
        throw new Error(
          `Expected ${certificationRunIds.size} Exchange certification row(s), received ${certificationCount}; unexpected=${unexpectedCertification || "none"}.`
        )
      }

      const seenSnapshotHashes = new Set<string>()
      const snapshotCount = await writeBackupSection(
        writer,
        "outlookExchangeTruthSnapshots",
        isFirstSection,
        async (appendRows) => {
          await streamTableRows(
            supabase,
            {
              key: "outlookExchangeTruthSnapshots",
              table: "outlook_exchange_truth_snapshots",
              order: [{ column: "snapshot_sha256", ascending: true }],
            },
            async (rows) => {
              const referenced = (
                rows as Array<Record<string, unknown>>
              ).filter((row) => {
                const hash = String(row.snapshot_sha256 || "")
                if (!referencedSnapshotHashes.has(hash)) return false
                seenSnapshotHashes.add(hash)
                return true
              })
              await appendRows(referenced)
            }
          )
        },
        sections,
        counts
      )
      isFirstSection = false
      if (
        snapshotCount !== checkpointBefore.snapshots ||
        seenSnapshotHashes.size !== referencedSnapshotHashes.size
      ) {
        throw new Error(
          `Expected ${checkpointBefore.snapshots} referenced truth snapshot(s), received ${snapshotCount}.`
        )
      }

      let exportedLedgerHeadSequence = 0
      let exportedLedgerHeadSha256 = ""
      const exportedLedgerCount = await writeBackupSection(
        writer,
        "outlookExchangeTruthLedger",
        isFirstSection,
        async (appendRows) => {
          while (exportedLedgerHeadSequence < checkpointBefore.headSequence) {
            const { data, error } = await supabase
              .from("outlook_exchange_truth_ledger")
              .select("*")
              .gt("ledger_sequence", exportedLedgerHeadSequence)
              .lte("ledger_sequence", checkpointBefore.headSequence)
              .order("ledger_sequence", { ascending: true })
              .limit(BACKUP_EXPORT_PAGE_SIZE)
            if (error) throw error

            const batch = (data || []) as Array<Record<string, unknown>>
            if (!batch.length) break
            for (const row of batch) {
              const sequence = requiredPositiveInteger(
                row.ledger_sequence,
                "outlook_exchange_truth_ledger.ledger_sequence"
              )
              if (
                sequence <= exportedLedgerHeadSequence ||
                sequence > checkpointBefore.headSequence
              ) {
                throw new Error(
                  "Truth-ledger export order or upper bound was violated."
                )
              }
              exportedLedgerHeadSequence = sequence
              exportedLedgerHeadSha256 = requiredSha256(
                row.entry_sha256,
                "outlook_exchange_truth_ledger.entry_sha256"
              )
            }
            await appendRows(batch)
            if (batch.length < BACKUP_EXPORT_PAGE_SIZE) break
          }
        },
        sections,
        counts
      )
      isFirstSection = false
      if (
        exportedLedgerCount !== checkpointBefore.ledgerEntries ||
        exportedLedgerHeadSequence !== checkpointBefore.headSequence ||
        exportedLedgerHeadSha256 !== checkpointBefore.headSha256
      ) {
        throw new Error(
          `Exported truth-ledger head does not match the checkpoint: expected ${checkpointBefore.ledgerEntries} row(s) at ${checkpointBefore.headSequence}/${checkpointBefore.headSha256}; received ${exportedLedgerCount} row(s) at ${exportedLedgerHeadSequence}/${exportedLedgerHeadSha256 || "none"}.`
        )
      }
    } catch (error) {
      throw new Error(
        `Backup failed while exporting the bounded Exchange truth evidence: ${getErrorMessage(error)}`
      )
    }

    try {
      await writeBackupSection(
        writer,
        "googleContacts",
        isFirstSection,
        (appendRows) => streamGoogleContacts(appendRows),
        sections,
        counts
      )
      isFirstSection = false
    } catch (error) {
      throw new Error(
        `Backup failed while reading Google Contacts: ${getErrorMessage(error)}`
      )
    }

    let calendarId = ""
    try {
      await writeBackupSection(
        writer,
        "googleCalendarEvents",
        isFirstSection,
        async (appendRows) => {
          calendarId = await streamGoogleCalendarEvents(appendRows)
        },
        sections,
        counts
      )
      isFirstSection = false
      await writeBackupSection(
        writer,
        "googleCalendarMetadata",
        isFirstSection,
        (appendRows) => appendRows([{ calendarId }]),
        sections,
        counts,
        false
      )
    } catch (error) {
      throw new Error(
        `Backup failed while reading Google Calendar: ${getErrorMessage(error)}`
      )
    }

    let checkpointAfterExport: Record<string, unknown>
    let verificationAfterExport: Record<string, unknown>
    let templateRecipientVerificationAfterExport: Record<string, unknown>
    try {
      [
        checkpointAfterExport,
        verificationAfterExport,
        templateRecipientVerificationAfterExport,
      ] = await Promise.all([
        callTruthRpc(supabase, "get_outlook_exchange_truth_checkpoint"),
        callTruthRpc(supabase, "verify_outlook_exchange_truth_ledger"),
        callTruthRpc(supabase, "verify_outlook_template_recipient_truth"),
      ])
    } catch (error) {
      throw new Error(
        `Backup failed while rechecking the Exchange truth checkpoint: ${getErrorMessage(error)}`
      )
    }

    const checkpointAfter = validateTruthCheckpoint(
      checkpointAfterExport,
      "Exchange truth checkpoint after export"
    )
    const verifiedAfter = validateTruthVerification(
      verificationAfterExport,
      "Exchange truth verification after export"
    )
    const templateRecipientTruthAfter = validateTemplateRecipientTruth(
      templateRecipientVerificationAfterExport,
      checkpointAfter,
      "Outlook template recipient truth after export"
    )
    const inventoryAfter = await getBackupInventory(supabase)
    if (
      inventoryAfter.migrationHead !== inventory.migrationHead ||
      inventoryAfter.catalogSha256 !== inventory.catalogSha256 ||
      JSON.stringify([...inventoryAfter.liveTables].sort()) !==
        JSON.stringify([...inventory.liveTables].sort())
    ) {
      throw new Error(
        "Backup database schema or table inventory changed during export. Retry from the latest migration."
      )
    }
    const databaseEpochAfter = await getBackupExportEpoch(supabase)
    if (databaseEpochAfter !== databaseEpochBefore) {
      throw new Error(
        `Backup source changed during export: database epoch ${databaseEpochBefore} became ${databaseEpochAfter}. Retry from a fresh checkpoint.`
      )
    }
    assertSameTruthHead(
      checkpointBefore,
      checkpointAfter,
      "Exchange truth checkpoint"
    )
    assertSameTruthHead(
      checkpointBefore,
      verifiedAfter,
      "Exchange truth verification"
    )
    assertSameTemplateRecipientTruth(
      templateRecipientTruthBefore,
      templateRecipientTruthAfter
    )

    await writeDataChunk(writer, "}")
    writer.stream.end()
    await finished(writer.stream)

    const latestCertificationRunId = String(
      checkpointAfterExport.latestCertificationRunId || ""
    )
    const latestProjectionSnapshotSha256 = requiredSha256(
      checkpointAfterExport.latestProjectionSnapshotSha256,
      "Latest projection snapshot SHA-256"
    )
    if (!latestCertificationRunId) {
      throw new Error("Latest Exchange certification run ID is missing.")
    }
    const inventorySha256 = sha256(
      JSON.stringify([...inventory.liveTables].sort())
    )

    return {
      dataPath: filePath,
      artifactPrefix,
      counts,
      sections,
      truth: {
        schema: TRUTH_CHECKPOINT_SCHEMA,
        verificationBeforeExport,
        checkpointBeforeExport,
        checkpointAfterExport,
        verificationAfterExport,
        templateRecipientVerificationBeforeExport,
        templateRecipientVerificationAfterExport,
        templateRecipientTruth: templateRecipientTruthAfter,
        exportedLedger: {
          entries: counts.outlookExchangeTruthLedger,
          headSequence: checkpointBefore.headSequence,
          headSha256: checkpointBefore.headSha256,
        },
        exportedSnapshots: {
          count: counts.outlookExchangeTruthSnapshots,
        },
      },
      truthHeadSequence: checkpointBefore.headSequence,
      truthHeadSha256: checkpointBefore.headSha256,
      databaseEpoch: databaseEpochBefore,
      migrationHead: inventory.migrationHead,
      inventorySha256,
      catalogSha256: inventory.catalogSha256,
      liveTableCount: inventory.liveTables.size,
      sectionCount: Object.keys(sections).length,
      totalRecordCount: Object.values(counts).reduce(
        (total, count) => total + count,
        0
      ),
      latestCertificationRunId,
      latestProjectionSnapshotSha256,
      generatedAt,
    }
  } catch (error) {
    writer.stream.destroy()
    try {
      await finished(writer.stream)
    } catch {
      // The original export error is more useful than the stream teardown error.
    }
    throw error
  }
}

async function streamPreparedBackupToDrive(
  drive: drive_v3.Drive,
  folderId: string,
  fileName: string,
  prepared: PreparedBackupData
) {
  const body = new PassThrough()
  const writer: BackupFinalWriter = {
    stream: body,
    artifactHasher: createHash("sha256"),
    fileHasher: createHash("sha256"),
    fileByteLength: 0,
  }

  const uploadPromise = drive.files.create({
    requestBody: {
      name: fileName,
      parents: [folderId],
      appProperties: {
        backupSchema: BACKUP_FILE_SCHEMA,
        verificationContract: BACKUP_STREAM_VERIFICATION_SCHEMA,
        verificationStatus: "uploading",
        backupRunId: String(prepared.artifactPrefix.backupRunId || ""),
      },
    },
    media: {
      mimeType: "application/json",
      body,
    },
    fields: "id,name,webViewLink,createdTime,mimeType,appProperties",
    supportsAllDrives: true,
  })

  const writePromise = (async (): Promise<StreamedBackupFile> => {
    try {
      const serializedPrefix = JSON.stringify(prepared.artifactPrefix)
      if (!serializedPrefix.endsWith("}")) {
        throw new Error("Backup artifact prefix did not serialize as an object.")
      }
      await writeFinalChunk(
        writer,
        `${serializedPrefix.slice(0, -1)},"counts":${JSON.stringify(prepared.counts)},"data":`
      )
      for await (const chunk of createReadStream(prepared.dataPath)) {
        await writeFinalChunk(writer, chunk)
      }
      await writeFinalChunk(writer, ',"warnings":[]')

      // The artifact hash covers the exact compact top-level object before the
      // integrity member is added. The virtual brace is hashed but not uploaded.
      writer.artifactHasher.update("}")
      const artifactSha256 = writer.artifactHasher.digest("hex")
      const sortedSections = Object.fromEntries(
        Object.keys(prepared.sections)
          .sort()
          .map((key) => [key, prepared.sections[key]])
      )
      const integrity = {
        schema: BACKUP_INTEGRITY_SCHEMA,
        algorithm: "sha256",
        serialization: "JSON.stringify/v1",
        artifactHashScope: "top-level-without-integrity/v1",
        artifactSha256,
        sections: sortedSections,
        truth: prepared.truth,
      }
      await writeFinalChunk(
        writer,
        `,"integrity":${JSON.stringify(integrity)}}`,
        false
      )
      body.end()
      await finished(body)

      return {
        artifactSha256,
        uploadedFileSha256: writer.fileHasher.digest("hex"),
        fileByteLength: writer.fileByteLength,
      }
    } catch (error) {
      body.destroy(
        error instanceof Error ? error : new Error(getErrorMessage(error))
      )
      throw error
    }
  })()

  try {
    const [response, streamed] = await Promise.all([uploadPromise, writePromise])
    if (!response.data.id) {
      throw new Error("Drive upload did not return a file id.")
    }
    return {
      file: response.data,
      streamed,
    }
  } catch (error) {
    body.destroy(
      error instanceof Error ? error : new Error(getErrorMessage(error))
    )
    throw error
  }
}

async function inspectDriveFileBytes(
  drive: drive_v3.Drive,
  fileId: string
) {
  const response = await drive.files.get(
    {
      fileId,
      alt: "media",
      supportsAllDrives: true,
    },
    {
      responseType: "stream",
    }
  )
  const hasher = createHash("sha256")
  let fileByteLength = 0
  for await (const value of response.data as AsyncIterable<Buffer | string>) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
    hasher.update(chunk)
    fileByteLength += chunk.byteLength
  }
  return {
    uploadedFileSha256: hasher.digest("hex"),
    fileByteLength,
  }
}

function validateStreamReceiptProperties(file: drive_v3.Schema$File) {
  const properties = file.appProperties || {}
  const artifactSha256 = requiredSha256(
    properties.artifactSha256,
    "Verified backup artifact SHA-256"
  )
  const uploadedFileSha256 = requiredSha256(
    properties.uploadedFileSha256,
    "Verified backup uploaded-file SHA-256"
  )
  const fileByteLength = requiredPositiveInteger(
    properties.fileByteLength,
    "Verified backup file byte length"
  )
  requiredPositiveInteger(
    properties.truthHeadSequence,
    "Verified backup truth head sequence"
  )
  requiredSha256(
    properties.truthHeadSha256,
    "Verified backup truth head SHA-256"
  )

  if (
    properties.backupSchema !== BACKUP_FILE_SCHEMA ||
    properties.verificationStatus !== "complete"
  ) {
    throw new Error(
      `Stored backup ${file.name || file.id || "unknown"} is not marked as a complete verified-v2 artifact.`
    )
  }

  if (
    properties.verificationContract &&
    properties.verificationContract !== BACKUP_STREAM_VERIFICATION_SCHEMA
  ) {
    throw new Error(
      `Stored backup ${file.name || file.id || "unknown"} has an unsupported verification contract.`
    )
  }

  if (properties.verificationContract === BACKUP_STREAM_VERIFICATION_SCHEMA) {
    const requiredProperties = [
      "migrationHead",
      "databaseEpoch",
      "inventorySha256",
      "catalogSha256",
      "liveTableCount",
      "sectionCount",
      "totalRecordCount",
      "backupRunId",
      "generatedAt",
      "deploymentCommit",
      "source",
      "latestCertificationRunId",
      "latestProjectionSnapshotSha256",
      "previousFileId",
      "previousFileName",
      "previousCreatedTime",
      "previousArtifactSha256",
      "previousUploadedFileSha256",
    ]
    for (const property of requiredProperties) {
      if (!properties[property]) {
        throw new Error(
          `Stored backup ${file.name || file.id || "unknown"} is missing receipt property ${property}.`
        )
      }
    }
    if (
      !/^\d{14}$/.test(properties.migrationHead || "") ||
      !/^[0-9a-f]{64}$/.test(properties.inventorySha256 || "") ||
      !/^[0-9a-f]{64}$/.test(properties.catalogSha256 || "") ||
      !/^[0-9a-f]{64}$/.test(
        properties.latestProjectionSnapshotSha256 || ""
      )
    ) {
      throw new Error(
        `Stored backup ${file.name || file.id || "unknown"} has invalid receipt metadata.`
      )
    }
    requiredPositiveInteger(
      properties.liveTableCount,
      "Verified backup live table count"
    )
    requiredNonNegativeInteger(
      properties.databaseEpoch,
      "Verified backup database epoch"
    )
    requiredPositiveInteger(
      properties.sectionCount,
      "Verified backup section count"
    )
    requiredNonNegativeInteger(
      properties.totalRecordCount,
      "Verified backup total record count"
    )
  }

  return {
    artifactSha256,
    uploadedFileSha256,
    fileByteLength,
  }
}

async function verifyStoredBackupReceipt(
  drive: drive_v3.Drive,
  file: drive_v3.Schema$File
) {
  if (!file.id) throw new Error("Verified backup is missing its Drive file id.")
  const receipt = validateStreamReceiptProperties(file)
  const downloaded = await inspectDriveFileBytes(drive, file.id)
  if (
    downloaded.uploadedFileSha256 !== receipt.uploadedFileSha256 ||
    downloaded.fileByteLength !== receipt.fileByteLength
  ) {
    throw new Error(
      `Stored backup ${file.name || file.id} no longer matches its verified byte receipt.`
    )
  }
  return {
    artifactSha256: receipt.artifactSha256,
    uploadedFileSha256: receipt.uploadedFileSha256,
  }
}

async function markBackupVerified(
  drive: drive_v3.Drive,
  fileId: string,
  prepared: PreparedBackupData,
  streamed: StreamedBackupFile,
  previousVerifiedBackup: PreviousVerifiedBackup | null
) {
  const deploymentCommit = String(
    prepared.artifactPrefix.deploymentCommit || "none"
  )
  const response = await drive.files.update({
    fileId,
    requestBody: {
      description:
        "Verified complete FCUNO backup. Data was exported page-by-page, exact uploaded bytes were stream-downloaded and SHA-256 checked, and the immutable Exchange truth checkpoint was certified before retention pruning.",
      appProperties: {
        backupSchema: BACKUP_FILE_SCHEMA,
        verificationContract: BACKUP_STREAM_VERIFICATION_SCHEMA,
        verificationStatus: "complete",
        artifactSha256: streamed.artifactSha256,
        uploadedFileSha256: streamed.uploadedFileSha256,
        fileByteLength: String(streamed.fileByteLength),
        truthHeadSequence: String(prepared.truthHeadSequence),
        truthHeadSha256: prepared.truthHeadSha256,
        migrationHead: prepared.migrationHead,
        databaseEpoch: String(prepared.databaseEpoch),
        inventorySha256: prepared.inventorySha256,
        catalogSha256: prepared.catalogSha256,
        liveTableCount: String(prepared.liveTableCount),
        sectionCount: String(prepared.sectionCount),
        totalRecordCount: String(prepared.totalRecordCount),
        backupRunId: String(prepared.artifactPrefix.backupRunId || ""),
        generatedAt: prepared.generatedAt,
        deploymentCommit,
        source: String(prepared.artifactPrefix.source || ""),
        latestCertificationRunId: prepared.latestCertificationRunId,
        latestProjectionSnapshotSha256:
          prepared.latestProjectionSnapshotSha256,
        previousFileId: previousVerifiedBackup?.fileId || "none",
        previousFileName: previousVerifiedBackup?.name || "none",
        previousCreatedTime:
          previousVerifiedBackup?.createdTime || "none",
        previousArtifactSha256:
          previousVerifiedBackup?.artifactSha256 || "none",
        previousUploadedFileSha256:
          previousVerifiedBackup?.uploadedFileSha256 || "none",
      },
    },
    fields: "id,name,webViewLink,createdTime,mimeType,appProperties",
    supportsAllDrives: true,
  })
  return response.data
}

async function listDriveBackupCandidates(
  drive: drive_v3.Drive,
  folderId: string,
  sharedDriveId: string | null
) {
  const files: drive_v3.Schema$File[] = []
  let pageToken: string | undefined
  do {
    const list = await drive.files.list({
      q: `trashed = false and mimeType = 'application/json' and '${folderId}' in parents and name contains 'bunker-map-backup-'`,
      fields: "nextPageToken,files(id,name,createdTime,mimeType,appProperties)",
      orderBy: "createdTime desc",
      pageSize: 1000,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      corpora: sharedDriveId ? "drive" : undefined,
      driveId: sharedDriveId || undefined,
    })
    files.push(...(list.data.files || []))
    pageToken = list.data.nextPageToken || undefined
  } while (pageToken)

  return files
    .filter((file) =>
      Boolean(file.id) &&
      BACKUP_FILE_NAME_PATTERN.test(file.name || "") &&
      file.mimeType === "application/json"
    )
    .sort((left, right) => {
      const createdOrder = String(right.createdTime || "").localeCompare(
        String(left.createdTime || "")
      )
      if (createdOrder) return createdOrder
      const nameOrder = String(right.name || "").localeCompare(
        String(left.name || "")
      )
      if (nameOrder) return nameOrder
      return String(right.id || "").localeCompare(String(left.id || ""))
    })
}

async function listVerifiedDriveBackups(
  drive: drive_v3.Drive,
  folderId: string,
  sharedDriveId: string | null
) {
  return (await listDriveBackupCandidates(drive, folderId, sharedDriveId))
    .filter((file) =>
      file.appProperties?.backupSchema === BACKUP_FILE_SCHEMA &&
      file.appProperties?.verificationStatus === "complete" &&
      /^[0-9a-f]{64}$/.test(file.appProperties?.artifactSha256 || "") &&
      /^[0-9a-f]{64}$/.test(file.appProperties?.uploadedFileSha256 || "")
    )
}

async function pruneOldDriveBackups(
  drive: drive_v3.Drive,
  folderId: string,
  sharedDriveId: string | null
) {
  const verifiedBackups = await listVerifiedDriveBackups(
    drive,
    folderId,
    sharedDriveId
  )
  const retentionCutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000
  // The newest artifact and its immediate predecessor are the minimum
  // independently verifiable chain. Keep both even after a long backup outage.
  const stale = verifiedBackups.slice(2).filter((file) => {
    const createdAt = new Date(String(file.createdTime || "")).getTime()
    return Number.isFinite(createdAt) && createdAt < retentionCutoff
  })
  let deleted = 0
  for (const file of stale) {
    if (!file.id) continue
    await drive.files.update({
      fileId: file.id,
      requestBody: { trashed: true },
      supportsAllDrives: true,
    })
    deleted += 1
  }

  return deleted
}

async function acquireBackupLock(
  supabase: ReturnType<typeof getSupabaseClient>,
  runId: string
) {
  const { data, error } = await supabase.rpc("claim_bunker_map_backup_lock", {
    p_lock_name: BACKUP_LOCK_NAME,
    p_run_id: runId,
    p_lease_seconds: BACKUP_LOCK_LEASE_SECONDS,
  })
  if (error) throw error
  if (data !== true) {
    throw new Error(
      "Another verified backup is already running. Wait for it to finish before retrying."
    )
  }
}

async function releaseBackupLock(
  supabase: ReturnType<typeof getSupabaseClient>,
  runId: string
) {
  const { data, error } = await supabase.rpc("release_bunker_map_backup_lock", {
    p_lock_name: BACKUP_LOCK_NAME,
    p_run_id: runId,
  })
  if (error) throw error
  if (data !== true) {
    throw new Error("The serialized backup lock was not owned at release time.")
  }
}

async function trashBackupFile(
  drive: drive_v3.Drive,
  fileId: string
) {
  await drive.files.update({
    fileId,
    requestBody: { trashed: true },
    supportsAllDrives: true,
  })
}

async function createBackup(provenance: BackupProvenance) {
  const supabase = getSupabaseClient()
  let lockAcquired = false
  let tempDirectory: string | null = null
  let drive: drive_v3.Drive | null = null
  let uploadedFileId: string | null = null
  let uploadVerified = false
  try {
    await acquireBackupLock(supabase, provenance.backupRunId)
    lockAcquired = true

    const driveContext = await getDriveClient()
    drive = driveContext.drive
    const { rootFolderId, sharedDriveId } = driveContext
    const backupRootId = await ensureDriveFolder(
      drive,
      rootFolderId,
      BACKUP_FOLDER_NAME,
      sharedDriveId
    )
    const dailyFolderId = await ensureDriveFolder(
      drive,
      backupRootId,
      DAILY_FOLDER_NAME,
      sharedDriveId
    )
    const [initialCandidates, inventory] = await Promise.all([
      listDriveBackupCandidates(drive, dailyFolderId, sharedDriveId),
      getBackupInventory(supabase),
    ])

    const orphanedUploads = initialCandidates.filter(
      (file) =>
        file.id &&
        file.appProperties?.backupSchema === BACKUP_FILE_SCHEMA &&
        file.appProperties?.verificationContract ===
          BACKUP_STREAM_VERIFICATION_SCHEMA &&
        file.appProperties?.verificationStatus === "uploading"
    )
    for (const orphan of orphanedUploads) {
      await trashBackupFile(drive, orphan.id!)
    }
    const orphanedIds = new Set(orphanedUploads.map((file) => file.id))
    const candidates = initialCandidates.filter(
      (file) => !orphanedIds.has(file.id)
    )
    const verifiedBackups = candidates.filter(
      (file) =>
        file.appProperties?.backupSchema === BACKUP_FILE_SCHEMA &&
        file.appProperties?.verificationStatus === "complete" &&
        /^[0-9a-f]{64}$/.test(
          file.appProperties?.artifactSha256 || ""
        ) &&
        /^[0-9a-f]{64}$/.test(
          file.appProperties?.uploadedFileSha256 || ""
        )
    )
    const previousFile = verifiedBackups[0]
    if (candidates.length > 0 && !previousFile) {
      throw new Error(
        "Existing backup files were found but none has a valid verified-v2 marker; refusing to reset the trusted backup chain."
      )
    }

    let previousHashes: Awaited<
      ReturnType<typeof verifyStoredBackupReceipt>
    > | null = null
    if (previousFile?.id) {
      previousHashes = await verifyStoredBackupReceipt(drive, previousFile)
    }
    const previousVerifiedBackup: PreviousVerifiedBackup | null =
      previousFile?.id && previousHashes
        ? {
            fileId: previousFile.id,
            name: previousFile.name || "",
            createdTime: previousFile.createdTime || null,
            artifactSha256: previousHashes.artifactSha256,
            uploadedFileSha256: previousHashes.uploadedFileSha256,
          }
        : null

    tempDirectory = await mkdtemp(
      join(tmpdir(), "bunker-map-backup-")
    )
    const dataPath = join(tempDirectory, "data.json")
    const prepared = await buildBackupFile(
      supabase,
      dataPath,
      previousVerifiedBackup,
      provenance,
      inventory
    )
    const stamp = prepared.generatedAt.replace(/[:.]/g, "-")
    const fileName = `bunker-map-backup-${stamp}.json`
    const { file: uploaded, streamed } =
      await streamPreparedBackupToDrive(
        drive,
        dailyFolderId,
        fileName,
        prepared
      )
    if (!uploaded.id) {
      throw new Error("Drive upload did not return a file id.")
    }
    uploadedFileId = uploaded.id

    const downloaded = await inspectDriveFileBytes(drive, uploaded.id)
    if (
      downloaded.uploadedFileSha256 !== streamed.uploadedFileSha256 ||
      downloaded.fileByteLength !== streamed.fileByteLength
    ) {
      throw new Error(
        `Drive verification failed for ${fileName}: streamed upload and downloaded byte receipts do not match.`
      )
    }

    const verifiedFile = await markBackupVerified(
      drive,
      uploaded.id,
      prepared,
      streamed,
      previousVerifiedBackup
    )
    uploadVerified = true

    const pruned = await pruneOldDriveBackups(drive, dailyFolderId, sharedDriveId)

    return NextResponse.json({
      success: true,
      file: verifiedFile,
      counts: prepared.counts,
      warnings: [],
      integrity: {
        schema: BACKUP_INTEGRITY_SCHEMA,
        verificationContract: BACKUP_STREAM_VERIFICATION_SCHEMA,
        artifactSha256: streamed.artifactSha256,
        uploadedFileSha256: streamed.uploadedFileSha256,
        fileByteLength: streamed.fileByteLength,
        verificationStatus: "complete",
        retentionDays: RETENTION_DAYS,
      },
      recoveredOrphanedUploads: orphanedUploads.length,
      pruned,
    })
  } catch (error) {
    if (drive && uploadedFileId && !uploadVerified) {
      try {
        await trashBackupFile(drive, uploadedFileId)
      } catch (cleanupError) {
        console.error(
          "Failed to trash an unverified backup upload:",
          getErrorMessage(cleanupError)
        )
      }
    }
    return NextResponse.json(
      { message: getErrorMessage(error) },
      { status: 500 }
    )
  } finally {
    if (tempDirectory) {
      try {
        await rm(tempDirectory, { recursive: true, force: true })
      } catch (error) {
        console.error(
          "Failed to remove the bounded backup workspace:",
          getErrorMessage(error)
        )
      }
    }
    if (lockAcquired) {
      try {
        await releaseBackupLock(supabase, provenance.backupRunId)
      } catch (error) {
        console.error(
          "Failed to release the serialized backup lock:",
          getErrorMessage(error)
        )
      }
    }
  }
}

export async function GET(request: Request) {
  if (!hasCronAccess(request)) {
    return NextResponse.json({ message: "Unauthorized" }, { status: 401 })
  }
  return createBackup({
    backupRunId: randomUUID(),
    source: "vercel-cron",
    requestedBy: "Vercel Cron",
  })
}

export async function POST() {
  let session: Awaited<ReturnType<typeof requireAdminPagePermission>>
  try {
    session = await requireAdminPagePermission("system-health", "edit")
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unauthorized"
    return NextResponse.json(
      { message },
      { status: message === "Unauthorized" ? 401 : 403 }
    )
  }
  return createBackup({
    backupRunId: randomUUID(),
    source: "admin-manual",
    requestedBy:
      session.displayName || session.username || "Authenticated administrator",
  })
}
