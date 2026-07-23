import { createHash, randomUUID } from "node:crypto"
import { Readable } from "node:stream"
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
const TRUTH_CHECKPOINT_SCHEMA = "fcuno-exchange-backup-checkpoint/v1"
const BACKUP_INVENTORY_SCHEMA = "bunker-map.backup-inventory/v1"
const BACKUP_LOCK_NAME = "daily-supabase-drive-v2"
const BACKUP_LOCK_LEASE_SECONDS = 15 * 60
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

async function fetchGoogleContacts() {
  const { google } = await loadGoogleApis()
  const refreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN
  if (!refreshToken) throw new Error("GOOGLE_OAUTH_REFRESH_TOKEN is not configured.")

  const people = google.people({ version: "v1", auth: await getGoogleOAuthClient(refreshToken) })
  const contacts: unknown[] = []
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
    contacts.push(...(response.data.connections || []))
    pageToken = response.data.nextPageToken || undefined
  } while (pageToken)

  return contacts
}

async function fetchGoogleCalendarEvents() {
  const { google } = await loadGoogleApis()
  const refreshToken = process.env.GOOGLE_CALENDAR_REFRESH_TOKEN
  if (!refreshToken) throw new Error("GOOGLE_CALENDAR_REFRESH_TOKEN is not configured.")

  const calendar = google.calendar({ version: "v3", auth: await getGoogleOAuthClient(refreshToken) })
  const calendarId =
    process.env.GOOGLE_MEETING_CALENDAR_ID ||
    process.env.GOOGLE_CALENDAR_ID ||
    "fcb.bunker@gmail.com"
  const events: unknown[] = []
  let pageToken: string | undefined

  do {
    const response = await calendar.events.list({
      calendarId,
      maxResults: 2500,
      pageToken,
      showDeleted: true,
      singleEvents: false,
    })
    events.push(...(response.data.items || []))
    pageToken = response.data.nextPageToken || undefined
  } while (pageToken)

  return { calendarId, events }
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

    const batch = (data || []).map((row) => {
      if (!config.omitColumns?.length) return row
      const sanitized = { ...row } as Record<string, unknown>
      for (const column of config.omitColumns) delete sanitized[column]
      return sanitized
    })
    rows.push(...batch)
    if (batch.length < pageSize) break
    from += pageSize
  }

  return rows
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

  const liveTables = new Set(inventory.tables as string[])
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
    liveTables,
    registeredTables: [...registeredTables].sort(),
    explicitlyEphemeralTables: [...EXPLICITLY_EPHEMERAL_TABLES].sort(),
  }
}

async function callTruthRpc(
  supabase: ReturnType<typeof getSupabaseClient>,
  functionName: "verify_outlook_exchange_truth_ledger" | "get_outlook_exchange_truth_checkpoint"
) {
  const { data, error } = await supabase.rpc(functionName)
  if (error) throw error
  return asRecord(data, functionName)
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

async function fetchBoundedTruthLedger(
  supabase: ReturnType<typeof getSupabaseClient>,
  headSequence: number
) {
  const rows: Array<Record<string, unknown>> = []
  const pageSize = 1000
  let lastSequence = 0

  while (lastSequence < headSequence) {
    const { data, error } = await supabase
      .from("outlook_exchange_truth_ledger")
      .select("*")
      .gt("ledger_sequence", lastSequence)
      .lte("ledger_sequence", headSequence)
      .order("ledger_sequence", { ascending: true })
      .limit(pageSize)

    if (error) throw error
    const batch = (data || []) as Array<Record<string, unknown>>
    if (!batch.length) break

    for (const row of batch) {
      const sequence = requiredPositiveInteger(
        row.ledger_sequence,
        "outlook_exchange_truth_ledger.ledger_sequence"
      )
      if (sequence <= lastSequence || sequence > headSequence) {
        throw new Error("Truth-ledger export order or upper bound was violated.")
      }
      lastSequence = sequence
      rows.push(row)
    }

    if (batch.length < pageSize) break
  }

  return rows
}

async function fetchBoundedTruthSnapshots(
  supabase: ReturnType<typeof getSupabaseClient>,
  referencedSnapshotHashes: Set<string>
) {
  const allRows = (await fetchAllRows(supabase, {
    key: "outlookExchangeTruthSnapshots",
    table: "outlook_exchange_truth_snapshots",
    order: [{ column: "snapshot_sha256", ascending: true }],
  })) as Array<Record<string, unknown>>

  return allRows.filter((row) =>
    referencedSnapshotHashes.has(String(row.snapshot_sha256 || ""))
  )
}

async function fetchBoundedTruthCertifications(
  supabase: ReturnType<typeof getSupabaseClient>
) {
  return (await fetchAllRows(supabase, {
    key: "outlookExchangeSyncCertifications",
    table: "outlook_exchange_sync_certifications",
    order: [{ column: "run_id", ascending: true }],
  })) as Array<Record<string, unknown>>
}

async function buildBackupPayload(
  supabase: ReturnType<typeof getSupabaseClient>,
  previousVerifiedBackup: PreviousVerifiedBackup | null,
  provenance: BackupProvenance,
  inventory: Awaited<ReturnType<typeof getBackupInventory>>
) {
  const counts: Record<string, number> = {}
  const data: Record<string, unknown[]> = {}
  const warnings: Array<{ key: string; table?: string; source?: string; message: string }> = []

  let verificationBeforeExport: Record<string, unknown>
  let checkpointBeforeExport: Record<string, unknown>
  try {
    verificationBeforeExport = await callTruthRpc(
      supabase,
      "verify_outlook_exchange_truth_ledger"
    )
    checkpointBeforeExport = await callTruthRpc(
      supabase,
      "get_outlook_exchange_truth_checkpoint"
    )
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

  for (const tableConfig of TABLES) {
    if (tableConfig.optional && !inventory.liveTables.has(tableConfig.table)) {
      counts[tableConfig.key] = 0
      data[tableConfig.key] = []
      continue
    }

    let rows: unknown[]
    try {
      rows = await fetchAllRows(supabase, tableConfig)
    } catch (error) {
      throw new Error(`Backup failed while reading ${tableConfig.table}: ${getErrorMessage(error)}`)
    }
    counts[tableConfig.key] = rows.length
    data[tableConfig.key] = rows
  }

  let truthLedger: Array<Record<string, unknown>>
  let truthSnapshots: Array<Record<string, unknown>>
  let truthCertifications: Array<Record<string, unknown>>
  try {
    truthLedger = await fetchBoundedTruthLedger(
      supabase,
      checkpointBefore.headSequence
    )
    if (truthLedger.length !== checkpointBefore.ledgerEntries) {
      throw new Error(
        `Expected ${checkpointBefore.ledgerEntries} ledger rows at the checkpoint, received ${truthLedger.length}.`
      )
    }

    const ledgerHead = truthLedger.at(-1)
    if (
      requiredPositiveInteger(
        ledgerHead?.ledger_sequence,
        "Exported truth-ledger head sequence"
      ) !== checkpointBefore.headSequence ||
      requiredSha256(
        ledgerHead?.entry_sha256,
        "Exported truth-ledger head SHA-256"
      ) !== checkpointBefore.headSha256
    ) {
      throw new Error("Exported truth-ledger head does not match the checkpoint.")
    }

    const referencedSnapshotHashes = new Set(
      truthLedger
        .map((row) => String(row.snapshot_sha256 || ""))
        .filter(Boolean)
    )
    const certificationRunIds = new Set(
      truthLedger
        .filter((row) =>
          row.event_type === "full_certification" ||
          row.event_type === "legacy_full_certification"
        )
        .map((row) => String(row.run_id || ""))
        .filter(Boolean)
    )

    ;[truthSnapshots, truthCertifications] = await Promise.all([
      fetchBoundedTruthSnapshots(supabase, referencedSnapshotHashes),
      fetchBoundedTruthCertifications(supabase),
    ])

    if (truthSnapshots.length !== checkpointBefore.snapshots) {
      throw new Error(
        `Expected ${checkpointBefore.snapshots} truth snapshots at the checkpoint, received ${truthSnapshots.length}.`
      )
    }
    if (
      truthCertifications.length !== certificationRunIds.size ||
      truthCertifications.some(
        (row) => !certificationRunIds.has(String(row.run_id || ""))
      )
    ) {
      throw new Error(
        `Expected ${certificationRunIds.size} Exchange certification rows at the checkpoint, received ${truthCertifications.length}.`
      )
    }
  } catch (error) {
    throw new Error(
      `Backup failed while exporting the bounded Exchange truth evidence: ${getErrorMessage(error)}`
    )
  }

  counts.outlookExchangeSyncCertifications = truthCertifications.length
  data.outlookExchangeSyncCertifications = truthCertifications
  counts.outlookExchangeTruthSnapshots = truthSnapshots.length
  data.outlookExchangeTruthSnapshots = truthSnapshots
  counts.outlookExchangeTruthLedger = truthLedger.length
  data.outlookExchangeTruthLedger = truthLedger

  try {
    const contacts = await fetchGoogleContacts()
    counts.googleContacts = contacts.length
    data.googleContacts = contacts
  } catch (error) {
    throw new Error(
      `Backup failed while reading Google Contacts: ${getErrorMessage(error)}`
    )
  }

  try {
    const { calendarId, events } = await fetchGoogleCalendarEvents()
    counts.googleCalendarEvents = events.length
    data.googleCalendarEvents = events
    data.googleCalendarMetadata = [{ calendarId }]
  } catch (error) {
    throw new Error(
      `Backup failed while reading Google Calendar: ${getErrorMessage(error)}`
    )
  }

  let checkpointAfterExport: Record<string, unknown>
  let verificationAfterExport: Record<string, unknown>
  try {
    checkpointAfterExport = await callTruthRpc(
      supabase,
      "get_outlook_exchange_truth_checkpoint"
    )
    verificationAfterExport = await callTruthRpc(
      supabase,
      "verify_outlook_exchange_truth_ledger"
    )
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

  const artifact = {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    backupRunId: provenance.backupRunId,
    generatedAt: new Date().toISOString(),
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
    counts,
    data,
    warnings,
  }

  const sections = Object.fromEntries(
    Object.keys(data)
      .sort()
      .map((key) => [
        key,
        {
          rowCount: Array.isArray(data[key]) ? data[key].length : 0,
          sha256: sha256(JSON.stringify(data[key])),
        },
      ])
  )

  return {
    ...artifact,
    integrity: {
      schema: BACKUP_INTEGRITY_SCHEMA,
      algorithm: "sha256",
      serialization: "JSON.stringify/v1",
      artifactHashScope: "top-level-without-integrity/v1",
      artifactSha256: sha256(JSON.stringify(artifact)),
      sections,
      truth: {
        schema: TRUTH_CHECKPOINT_SCHEMA,
        verificationBeforeExport,
        checkpointBeforeExport,
        checkpointAfterExport,
        verificationAfterExport,
        exportedLedger: {
          entries: truthLedger.length,
          headSequence: checkpointBefore.headSequence,
          headSha256: checkpointBefore.headSha256,
        },
        exportedSnapshots: {
          count: truthSnapshots.length,
        },
      },
    },
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
    fields: "id,name,webViewLink,createdTime,mimeType,appProperties",
    supportsAllDrives: true,
  })

  if (!response.data.id) throw new Error("Drive upload did not return a file id.")
  return response.data
}

async function downloadDriveFileBytes(
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
  const chunks: Buffer[] = []
  for await (const chunk of response.data as AsyncIterable<Buffer | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

function validateStoredBackupBytes(
  bytes: Buffer,
  file: drive_v3.Schema$File
) {
  let backup: Record<string, unknown>
  try {
    backup = asRecord(
      JSON.parse(bytes.toString("utf8")),
      "Stored backup artifact"
    )
  } catch (error) {
    throw new Error(
      `Stored backup JSON is invalid: ${getErrorMessage(error)}`
    )
  }

  const integrity = asRecord(backup.integrity, "Stored backup integrity manifest")
  const truth = asRecord(integrity.truth, "Stored backup truth checkpoint")
  const verificationAfter = asRecord(
    truth.verificationAfterExport,
    "Stored backup truth verification"
  )
  const checkpointAfter = asRecord(
    truth.checkpointAfterExport,
    "Stored backup final checkpoint"
  )
  const exportedLedger = asRecord(
    truth.exportedLedger,
    "Stored backup exported ledger"
  )
  const backupData = asRecord(backup.data, "Stored backup data")
  const sections = asRecord(integrity.sections, "Stored backup sections")
  const artifact = { ...backup }
  delete artifact.integrity
  const artifactSha256 = sha256(JSON.stringify(artifact))
  const uploadedFileSha256 = sha256(bytes)

  if (
    backup.schemaVersion !== BACKUP_SCHEMA_VERSION ||
    backup.project !== "bunker-map" ||
    !/^\d{14}$/.test(String(backup.migrationHead || "")) ||
    !Array.isArray(backup.warnings) ||
    backup.warnings.length !== 0 ||
    integrity.schema !== BACKUP_INTEGRITY_SCHEMA ||
    integrity.artifactSha256 !== artifactSha256 ||
    truth.schema !== TRUTH_CHECKPOINT_SCHEMA ||
    verificationAfter.integrityValid !== true ||
    verificationAfter.referencesValid !== true ||
    verificationAfter.operationallyConsistent !== true ||
    checkpointAfter.checkpointValid !== true ||
    checkpointAfter.latestCertificationHasProjectionEvidence !== true ||
    file.appProperties?.backupSchema !== BACKUP_FILE_SCHEMA ||
    file.appProperties?.verificationStatus !== "complete" ||
    file.appProperties?.artifactSha256 !== artifactSha256 ||
    file.appProperties?.uploadedFileSha256 !== uploadedFileSha256 ||
    file.appProperties?.fileByteLength !== String(bytes.byteLength) ||
    file.appProperties?.truthHeadSequence !==
      String(exportedLedger.headSequence || "") ||
    file.appProperties?.truthHeadSha256 !==
      String(exportedLedger.headSha256 || "")
  ) {
    throw new Error(
      `Stored backup ${file.name || file.id || "unknown"} failed its verified predecessor contract.`
    )
  }

  const dataKeys = Object.keys(backupData).sort()
  const sectionKeys = Object.keys(sections).sort()
  if (JSON.stringify(dataKeys) !== JSON.stringify(sectionKeys)) {
    throw new Error("Stored backup sections do not match its data.")
  }
  for (const key of dataKeys) {
    const rows = backupData[key]
    const section = asRecord(sections[key], `Stored backup section ${key}`)
    if (
      !Array.isArray(rows) ||
      section.rowCount !== rows.length ||
      section.sha256 !== sha256(JSON.stringify(rows))
    ) {
      throw new Error(`Stored backup section ${key} failed verification.`)
    }
  }

  return {
    artifactSha256,
    uploadedFileSha256,
  }
}

async function markBackupVerified(
  drive: drive_v3.Drive,
  fileId: string,
  metadata: {
    artifactSha256: string
    uploadedFileSha256: string
    fileByteLength: number
    truthHeadSequence: number
    truthHeadSha256: string
  }
) {
  const response = await drive.files.update({
    fileId,
    requestBody: {
      description:
        "Verified complete FCUNO backup. Exact uploaded bytes were downloaded and SHA-256 checked before retention pruning.",
      appProperties: {
        backupSchema: BACKUP_FILE_SCHEMA,
        verificationStatus: "complete",
        artifactSha256: metadata.artifactSha256,
        uploadedFileSha256: metadata.uploadedFileSha256,
        fileByteLength: String(metadata.fileByteLength),
        truthHeadSequence: String(metadata.truthHeadSequence),
        truthHeadSha256: metadata.truthHeadSha256,
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
  const stale = verifiedBackups.filter((file) => {
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

async function createBackup(provenance: BackupProvenance) {
  const supabase = getSupabaseClient()
  let lockAcquired = false
  try {
    await acquireBackupLock(supabase, provenance.backupRunId)
    lockAcquired = true

    const { drive, rootFolderId, sharedDriveId } = await getDriveClient()
    const backupRootId = await ensureDriveFolder(drive, rootFolderId, BACKUP_FOLDER_NAME, sharedDriveId)
    const dailyFolderId = await ensureDriveFolder(drive, backupRootId, DAILY_FOLDER_NAME, sharedDriveId)
    const [candidates, verifiedBackups, inventory] = await Promise.all([
      listDriveBackupCandidates(drive, dailyFolderId, sharedDriveId),
      listVerifiedDriveBackups(drive, dailyFolderId, sharedDriveId),
      getBackupInventory(supabase),
    ])
    const previousFile = verifiedBackups[0]
    if (candidates.length > 0 && !previousFile) {
      throw new Error(
        "Existing backup files were found but none has a valid verified-v2 marker; refusing to reset the trusted backup chain."
      )
    }

    let previousHashes: ReturnType<typeof validateStoredBackupBytes> | null = null
    if (previousFile?.id) {
      const previousBytes = await downloadDriveFileBytes(drive, previousFile.id)
      previousHashes = validateStoredBackupBytes(previousBytes, previousFile)
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

    const payload = await buildBackupPayload(
      supabase,
      previousVerifiedBackup,
      provenance,
      inventory
    )
    const content = JSON.stringify(payload, null, 2)
    const contentBytes = Buffer.from(content, "utf8")
    const uploadedFileSha256 = sha256(contentBytes)
    const stamp = new Date().toISOString().replace(/[:.]/g, "-")
    const fileName = `bunker-map-backup-${stamp}.json`
    const generatedIntegrity = asRecord(
      payload.integrity,
      "Generated backup integrity manifest"
    )
    const generatedTruth = asRecord(
      generatedIntegrity.truth,
      "Generated backup truth checkpoint"
    )
    const generatedLedger = asRecord(
      generatedTruth.exportedLedger,
      "Generated backup exported ledger"
    )
    validateStoredBackupBytes(contentBytes, {
      name: fileName,
      mimeType: "application/json",
      appProperties: {
        backupSchema: BACKUP_FILE_SCHEMA,
        verificationStatus: "complete",
        artifactSha256: String(generatedIntegrity.artifactSha256 || ""),
        uploadedFileSha256,
        fileByteLength: String(contentBytes.byteLength),
        truthHeadSequence: String(generatedLedger.headSequence || ""),
        truthHeadSha256: String(generatedLedger.headSha256 || ""),
      },
    })

    const uploaded = await uploadBackupFile(drive, dailyFolderId, fileName, content)
    if (!uploaded.id) throw new Error("Drive upload did not return a file id.")

    const downloadedBytes = await downloadDriveFileBytes(drive, uploaded.id)
    const downloadedFileSha256 = sha256(downloadedBytes)
    if (
      !downloadedBytes.equals(contentBytes) ||
      downloadedFileSha256 !== uploadedFileSha256
    ) {
      throw new Error(
        `Drive verification failed for ${fileName}: uploaded bytes do not match the generated artifact.`
      )
    }

    const integrity = asRecord(payload.integrity, "Backup integrity manifest")
    const truth = asRecord(integrity.truth, "Backup truth checkpoint")
    const exportedLedger = asRecord(
      truth.exportedLedger,
      "Backup exported truth ledger"
    )
    const verifiedFile = await markBackupVerified(drive, uploaded.id, {
      artifactSha256: requiredSha256(
        integrity.artifactSha256,
        "Backup artifact SHA-256"
      ),
      uploadedFileSha256,
      fileByteLength: contentBytes.byteLength,
      truthHeadSequence: requiredPositiveInteger(
        exportedLedger.headSequence,
        "Backup truth head sequence"
      ),
      truthHeadSha256: requiredSha256(
        exportedLedger.headSha256,
        "Backup truth head SHA-256"
      ),
    })

    const pruned = await pruneOldDriveBackups(drive, dailyFolderId, sharedDriveId)

    return NextResponse.json({
      success: true,
      file: verifiedFile,
      counts: payload.counts,
      warnings: payload.warnings,
      integrity: {
        schema: integrity.schema,
        artifactSha256: integrity.artifactSha256,
        uploadedFileSha256,
        fileByteLength: contentBytes.byteLength,
        verificationStatus: "complete",
        retentionDays: RETENTION_DAYS,
      },
      pruned,
    })
  } catch (error) {
    return NextResponse.json(
      { message: getErrorMessage(error) },
      { status: 500 }
    )
  } finally {
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
