import { createHash } from "node:crypto"
import { createClient } from "@supabase/supabase-js"
import type { drive_v3 } from "googleapis"
import { getEmailNoticeConfigStatus } from "@/lib/emailNotice"
import { loadGoogleApis } from "@/lib/googleApis"

export type HealthStatus = "ok" | "warning" | "error"

export type HealthCheck = {
  id: string
  label: string
  status: HealthStatus
  message: string
  checkedAt: string
  details?: Record<string, string | number | boolean | null>
}

export type HealthCheckResult = Omit<HealthCheck, "id" | "label" | "checkedAt">

export type SystemHealth = {
  status: HealthStatus
  checkedAt: string
  deployment: {
    commit: string
    shortCommit: string
    branch: string
    deployedAt: string
    environment: string
  }
  checks: HealthCheck[]
}

const BACKUP_FOLDER_NAME = "Bunker Map Backups"
const DAILY_FOLDER_NAME = "Daily Supabase Backups"
const DRIVE_FILE_MANIFEST_FOLDER_NAME = "Drive File Backup Manifests"
const DRIVE_FILE_MANIFEST_PREFIX = "drive-file-backup-manifest"
const DAILY_BACKUP_WARNING_AGE_HOURS = 36
const DRIVE_FILE_BACKUP_WARNING_AGE_HOURS = 8 * 24
const EXCHANGE_CERTIFICATION_WARNING_AGE_HOURS = 36
const BACKUP_INTEGRITY_SCHEMA = "bunker-map-backup-integrity/v2"
const BACKUP_FILE_SCHEMA = "bunker-map-backup/v2"
const TRUTH_CHECKPOINT_SCHEMA = "fcuno-exchange-backup-checkpoint/v1"
const BACKUP_INVENTORY_SCHEMA = "bunker-map.backup-inventory/v1"
const MINIMUM_BACKUP_MIGRATION_HEAD = "20260723080326"
const BACKUP_FILE_NAME_PATTERN =
  /^bunker-map-backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.json$/
const DRIVE_FILE_BACKUP_STORAGE_WARNING_PERCENT = 80
const DEFAULT_CALENDAR_ID = "fcb.bunker@gmail.com"
const CHECK_TIMEOUT_MS = 12_000
const BACKUP_CHECK_TIMEOUT_MS = 25_000
const SUPABASE_HEALTH_PAGE_SIZE = 1_000

const BACKUP_TABLE_SECTIONS = [
  { key: "admins", table: "admins" },
  { key: "adminUsers", table: "admin_users" },
  { key: "adminRoleDefaults", table: "admin_role_defaults", optional: true },
  { key: "auditLogs", table: "audit_logs" },
  { key: "officeCalendarStore", table: "office_calendar_store" },
  { key: "emailTemplates", table: "email_templates" },
  { key: "sharedAddressbookContacts", table: "shared_addressbook_contacts" },
  { key: "sharedAddressbookGroups", table: "shared_addressbook_groups" },
  {
    key: "sharedAddressbookGroupMembers",
    table: "shared_addressbook_group_members",
  },
  { key: "outlookExchangeSyncQueue", table: "outlook_exchange_sync_queue" },
  { key: "phonebookContacts", table: "phonebook_contacts" },
  { key: "phonebookCompanies", table: "phonebook_companies" },
  { key: "ccCompanies", table: "cc_companies" },
  { key: "ccCountries", table: "cc_countries" },
  { key: "ccPorts", table: "cc_ports" },
  { key: "ccDocuments", table: "cc_documents" },
  { key: "ccCompanyFiles", table: "cc_company_files" },
  { key: "ccEntryFiles", table: "cc_entry_files" },
  { key: "ccEntryFolders", table: "cc_entry_folders" },
  { key: "ports", table: "ports" },
  { key: "remarks", table: "remarks" },
  { key: "priceHistory", table: "price_history" },
  { key: "whatsappConversations", table: "whatsapp_conversations" },
  { key: "whatsappMessages", table: "whatsapp_messages" },
  { key: "spcUsers", table: "spc_users" },
  { key: "spcEnquiries", table: "spc_enquiries" },
  { key: "spcFixtures", table: "spc_fixtures" },
  { key: "spcSuppliers", table: "spc_suppliers" },
  { key: "parserReports", table: "parser_reports" },
  { key: "openAiUsageEvents", table: "openai_usage_events" },
  { key: "spcPresentationChunks", table: "spc_presentation_chunks" },
] as const

const BACKUP_TRUTH_SECTIONS = [
  {
    key: "outlookExchangeSyncCertifications",
    table: "outlook_exchange_sync_certifications",
  },
  {
    key: "outlookExchangeTruthSnapshots",
    table: "outlook_exchange_truth_snapshots",
  },
  {
    key: "outlookExchangeTruthLedger",
    table: "outlook_exchange_truth_ledger",
  },
] as const

const BACKUP_EXTERNAL_SECTION_KEYS = [
  "googleContacts",
  "googleCalendarEvents",
] as const
const BACKUP_REQUIRED_SECTION_KEYS = [
  ...BACKUP_TABLE_SECTIONS.map(({ key }) => key),
  ...BACKUP_TRUTH_SECTIONS.map(({ key }) => key),
  ...BACKUP_EXTERNAL_SECTION_KEYS,
].sort()
const BACKUP_REQUIRED_DATA_KEYS = [
  ...BACKUP_REQUIRED_SECTION_KEYS,
  "googleCalendarMetadata",
].sort()
const BACKUP_EPHEMERAL_TABLES = [
  "bunker_map_backup_lock",
  "outlook_exchange_sync_lock",
].sort()
const BACKUP_REGISTERED_TABLES = [
  ...BACKUP_TABLE_SECTIONS.map(({ table }) => table),
  ...BACKUP_TRUTH_SECTIONS.map(({ table }) => table),
  ...BACKUP_EPHEMERAL_TABLES,
].sort()
const BACKUP_REQUIRED_LIVE_TABLES = [
  ...BACKUP_TABLE_SECTIONS
    .filter((section) => !("optional" in section && section.optional))
    .map(({ table }) => table),
  ...BACKUP_TRUTH_SECTIONS.map(({ table }) => table),
  ...BACKUP_EPHEMERAL_TABLES,
].sort()
const BACKUP_EXCLUDED_CREDENTIAL_FIELDS = [
  "admin_users.password_hash",
  "spc_users.password_hash",
].sort()

function requireEnv(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing environment variable: ${name}`)
  return value
}

export function getErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message?: unknown }).message || "Request failed.")
  }
  return String(error || "Request failed.")
}

function getDeployment() {
  const commit =
    process.env.DEPLOY_COMMIT ||
    process.env.NEXT_PUBLIC_DEPLOY_COMMIT ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    "unknown"

  return {
    commit,
    shortCommit: commit === "unknown" ? commit : commit.slice(0, 7),
    branch:
      process.env.DEPLOY_BRANCH ||
      process.env.VERCEL_GIT_COMMIT_REF ||
      "unknown",
    deployedAt:
      process.env.DEPLOYED_AT ||
      (process.env.VERCEL_GIT_COMMIT_SHA && process.env.VERCEL_ENV ? "vercel" : "unknown"),
    environment:
      process.env.VERCEL_ENV ||
      process.env.NODE_ENV ||
      "unknown",
  }
}

async function getOAuthClient(refreshTokenEnv: string) {
  const { google } = await loadGoogleApis()
  const auth = new google.auth.OAuth2(
    requireEnv("GOOGLE_OAUTH_CLIENT_ID"),
    requireEnv("GOOGLE_OAUTH_CLIENT_SECRET"),
    process.env.GOOGLE_OAUTH_REDIRECT_URI || "http://127.0.0.1"
  )
  auth.setCredentials({ refresh_token: requireEnv(refreshTokenEnv) })
  return auth
}

function combineStatus(checks: HealthCheck[]): HealthStatus {
  if (checks.some((check) => check.status === "error")) return "error"
  if (checks.some((check) => check.status === "warning")) return "warning"
  return "ok"
}

async function runCheck(
  id: string,
  label: string,
  fn: () => Promise<HealthCheckResult>,
  timeoutMs = CHECK_TIMEOUT_MS
): Promise<HealthCheck> {
  const checkedAt = new Date().toISOString()
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Health check timed out after ${timeoutMs / 1000} seconds.`)),
          timeoutMs,
        )
      }),
    ])
    return { id, label, checkedAt, ...result }
  } catch (error) {
    return {
      id,
      label,
      checkedAt,
      status: "error",
      message: getErrorMessage(error),
    }
  } finally {
    if (timeout) clearTimeout(timeout)
  }
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
    throw new Error(`${label} is not an object.`)
  }
  return value as Record<string, unknown>
}

function getNumber(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function requireNonNegativeSafeInteger(value: unknown, label: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${label} is not a non-negative safe integer.`)
  }
  return Number(value)
}

function requirePositiveSafeInteger(value: unknown, label: string) {
  const parsed = requireNonNegativeSafeInteger(value, label)
  if (parsed < 1) throw new Error(`${label} must be greater than zero.`)
  return parsed
}

function requireSha256(value: unknown, label: string) {
  const parsed = String(value || "")
  if (!/^[0-9a-f]{64}$/.test(parsed)) {
    throw new Error(`${label} is not a valid SHA-256 value.`)
  }
  return parsed
}

function requireArray(value: unknown, label: string) {
  if (!Array.isArray(value)) throw new Error(`${label} is not an array.`)
  return value
}

function sameStringSet(left: string[], right: readonly string[]) {
  return (
    JSON.stringify([...left].sort()) === JSON.stringify([...right].sort())
  )
}

function requireSortedUniqueStrings(value: unknown, label: string) {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || !item)
  ) {
    throw new Error(`${label} is not a string array.`)
  }
  const parsed = value as string[]
  if (
    new Set(parsed).size !== parsed.length ||
    JSON.stringify(parsed) !== JSON.stringify([...parsed].sort())
  ) {
    throw new Error(`${label} is not sorted and unique.`)
  }
  return parsed
}

function requireExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string
) {
  if (JSON.stringify(Object.keys(value)) !== JSON.stringify(expected)) {
    throw new Error(`${label} has unexpected fields or field order.`)
  }
}

function getLedgerHashMaterial(row: Record<string, unknown>) {
  return [
    "fcuno-exchange-truth/v1",
    `ledgerSequence=${row.ledger_sequence}`,
    `entryId=${row.entry_id}`,
    `eventKey=${row.event_key}`,
    `eventType=${row.event_type}`,
    `occurredAt=${row.occurred_at_canonical}`,
    `runId=${row.run_id || ""}`,
    `auditLogId=${row.audit_log_id || ""}`,
    `queueRowId=${row.queue_row_id || ""}`,
    `snapshotSha256=${row.snapshot_sha256 || ""}`,
    `previousEntrySha256=${row.previous_entry_sha256 || ""}`,
    `payloadSha256=${row.payload_sha256}`,
  ].join("\n")
}

async function getCurrentBackupInventory() {
  const { data, error } = await getSupabaseClient().rpc(
    "get_bunker_map_backup_inventory"
  )
  if (error) throw error
  const inventory = asRecord(data, "Live backup database inventory")
  if (inventory.schema !== BACKUP_INVENTORY_SCHEMA) {
    throw new Error("Live backup database inventory has an unsupported schema.")
  }
  const migrationHead = String(inventory.migrationHead || "")
  if (!/^\d{14}$/.test(migrationHead)) {
    throw new Error("Live backup database inventory has no migration head.")
  }
  const liveTables = requireSortedUniqueStrings(
    inventory.tables,
    "Live backup database tables"
  )
  const missingRequired = BACKUP_REQUIRED_LIVE_TABLES.filter(
    (table) => !liveTables.includes(table)
  )
  const unregistered = liveTables.filter(
    (table) => !BACKUP_REGISTERED_TABLES.includes(table)
  )
  if (missingRequired.length || unregistered.length) {
    throw new Error(
      `Live database is outside the backup table contract: missing=${missingRequired.join(",") || "none"}; unregistered=${unregistered.join(",") || "none"}.`
    )
  }
  return { migrationHead, liveTables }
}

async function listActiveDriveFileIds(
  supabase: ReturnType<typeof getSupabaseClient>,
  table: "cc_company_files" | "cc_entry_files",
) {
  const fileIds: string[] = []

  for (let from = 0; ; from += SUPABASE_HEALTH_PAGE_SIZE) {
    const { data, error } = await supabase
      .from(table)
      .select("id,drive_file_id")
      .not("drive_file_id", "is", null)
      .is("deleted_at", null)
      .order("id", { ascending: true })
      .range(from, from + SUPABASE_HEALTH_PAGE_SIZE - 1)

    if (error) throw error

    const rows = data || []
    fileIds.push(
      ...rows
        .map((row) => row.drive_file_id)
        .filter((fileId): fileId is string => typeof fileId === "string" && Boolean(fileId)),
    )

    if (rows.length < SUPABASE_HEALTH_PAGE_SIZE) break
  }

  return fileIds
}

async function checkSupabase(): Promise<HealthCheckResult> {
  const supabase = getSupabaseClient()
  const { count, error } = await supabase
    .from("ports")
    .select("id", { count: "exact", head: true })

  if (error) throw error

  return {
    status: "ok",
    message: "Supabase reachable",
    details: {
      ports: count || 0,
    },
  }
}

async function checkOptionalSchema(): Promise<HealthCheckResult> {
  const supabase = getSupabaseClient()
  const { error } = await supabase
    .from("admin_role_defaults")
    .select("role", { count: "exact", head: true })

  if (!error) {
    return {
      status: "ok",
      message: "Optional admin role defaults table present",
    }
  }

  const message = getErrorMessage(error)
  if (message.toLowerCase().includes("could not find the table") || message.toLowerCase().includes("does not exist")) {
    return {
      status: "warning",
      message: "Optional admin role defaults table is not present",
      details: {
        table: "admin_role_defaults",
      },
    }
  }

  throw error
}

function escapeDriveQueryValue(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")
}

async function findDriveFolder(drive: drive_v3.Drive, parentId: string, name: string, sharedDriveId: string | null) {
  const lookup = await drive.files.list({
    q: `trashed = false and mimeType = 'application/vnd.google-apps.folder' and name = '${escapeDriveQueryValue(name)}' and '${parentId}' in parents`,
    fields: "files(id,name,createdTime)",
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    corpora: sharedDriveId ? "drive" : undefined,
    driveId: sharedDriveId || undefined,
  })

  return lookup.data.files?.[0] || null
}

async function readDriveFileBytes(drive: drive_v3.Drive, fileId: string) {
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

async function readDriveJsonFile(drive: drive_v3.Drive, fileId: string) {
  const bytes = await readDriveFileBytes(drive, fileId)
  return {
    bytes,
    value: JSON.parse(bytes.toString("utf8")) as Record<string, unknown>,
  }
}

function verifyBackupArtifact(
  backup: Record<string, unknown>,
  bytes: Buffer,
  appProperties: Record<string, string> | null | undefined
) {
  requireExactKeys(
    backup,
    [
      "schemaVersion",
      "backupRunId",
      "generatedAt",
      "project",
      "source",
      "requestedBy",
      "migrationHead",
      "deploymentCommit",
      "previousVerifiedBackup",
      "databaseInventory",
      "counts",
      "data",
      "warnings",
      "integrity",
    ],
    "Backup"
  )

  const integrity = asRecord(backup.integrity, "Backup integrity manifest")
  if (
    backup.schemaVersion !== 2 ||
    backup.project !== "bunker-map" ||
    integrity.schema !== BACKUP_INTEGRITY_SCHEMA ||
    integrity.algorithm !== "sha256" ||
    integrity.serialization !== "JSON.stringify/v1" ||
    integrity.artifactHashScope !== "top-level-without-integrity/v1"
  ) {
    throw new Error("Latest backup does not use the required v2 integrity format.")
  }
  requireExactKeys(
    integrity,
    [
      "schema",
      "algorithm",
      "serialization",
      "artifactHashScope",
      "artifactSha256",
      "sections",
      "truth",
    ],
    "Backup integrity manifest"
  )

  const backupRunId = String(backup.backupRunId || "")
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      backupRunId
    )
  ) {
    throw new Error("Latest backup run ID is not a version-4 UUID.")
  }
  const generatedAt = String(backup.generatedAt || "")
  if (!generatedAt || Number.isNaN(Date.parse(generatedAt))) {
    throw new Error("Latest backup has an invalid generated timestamp.")
  }
  const source = String(backup.source || "")
  const requestedBy = String(backup.requestedBy || "")
  if (
    !["vercel-cron", "admin-manual"].includes(source) ||
    !requestedBy.trim() ||
    (source === "vercel-cron" && requestedBy !== "Vercel Cron")
  ) {
    throw new Error("Latest backup provenance is invalid.")
  }

  const migrationHead = String(backup.migrationHead || "")
  if (
    !/^\d{14}$/.test(migrationHead) ||
    migrationHead < MINIMUM_BACKUP_MIGRATION_HEAD
  ) {
    throw new Error("Latest backup predates the required v2 migration contract.")
  }
  if (
    backup.deploymentCommit !== null &&
    !/^[0-9a-f]{7,64}$/i.test(String(backup.deploymentCommit || ""))
  ) {
    throw new Error("Latest backup has invalid deployment provenance.")
  }

  const sourceWarnings = requireArray(backup.warnings, "Backup warnings")
  if (sourceWarnings.length) {
    throw new Error(
      `Latest backup contains ${sourceWarnings.length} source warning(s) and is not trusted for recovery.`
    )
  }

  const inventory = asRecord(
    backup.databaseInventory,
    "Backup database inventory"
  )
  requireExactKeys(
    inventory,
    [
      "schema",
      "liveTables",
      "registeredTables",
      "explicitlyEphemeralTables",
      "excludedCredentialFields",
    ],
    "Backup database inventory"
  )
  if (inventory.schema !== BACKUP_INVENTORY_SCHEMA) {
    throw new Error("Latest backup has an unsupported database inventory.")
  }
  const liveTables = requireSortedUniqueStrings(
    inventory.liveTables,
    "Backup live tables"
  )
  const registeredTables = requireSortedUniqueStrings(
    inventory.registeredTables,
    "Backup registered tables"
  )
  const ephemeralTables = requireSortedUniqueStrings(
    inventory.explicitlyEphemeralTables,
    "Backup ephemeral tables"
  )
  const excludedCredentialFields = requireSortedUniqueStrings(
    inventory.excludedCredentialFields,
    "Backup excluded credential fields"
  )
  if (
    !sameStringSet(registeredTables, BACKUP_REGISTERED_TABLES) ||
    !sameStringSet(ephemeralTables, BACKUP_EPHEMERAL_TABLES) ||
    !sameStringSet(
      excludedCredentialFields,
      BACKUP_EXCLUDED_CREDENTIAL_FIELDS
    ) ||
    BACKUP_REQUIRED_LIVE_TABLES.some((table) => !liveTables.includes(table)) ||
    liveTables.some((table) => !BACKUP_REGISTERED_TABLES.includes(table))
  ) {
    throw new Error("Latest backup database inventory is incomplete.")
  }

  const artifact = { ...backup }
  delete artifact.integrity
  const expectedArtifactSha256 = sha256(JSON.stringify(artifact))
  const artifactSha256 = String(integrity.artifactSha256 || "")
  if (artifactSha256 !== expectedArtifactSha256) {
    throw new Error("Latest backup artifact SHA-256 does not match its contents.")
  }

  let previousVerifiedBackup: Record<string, unknown> | null = null
  if (backup.previousVerifiedBackup !== null) {
    const previous = asRecord(
      backup.previousVerifiedBackup,
      "Previous verified backup anchor"
    )
    requireExactKeys(
      previous,
      [
        "fileId",
        "name",
        "createdTime",
        "artifactSha256",
        "uploadedFileSha256",
      ],
      "Previous verified backup anchor"
    )
    if (
      !String(previous.fileId || "") ||
      !BACKUP_FILE_NAME_PATTERN.test(String(previous.name || "")) ||
      (previous.createdTime !== null &&
        Number.isNaN(Date.parse(String(previous.createdTime || "")))) ||
      !/^[0-9a-f]{64}$/.test(String(previous.artifactSha256 || "")) ||
      !/^[0-9a-f]{64}$/.test(String(previous.uploadedFileSha256 || ""))
    ) {
      throw new Error("Latest backup has an invalid previous-backup chain anchor.")
    }
    if (
      previous.createdTime !== null &&
      Date.parse(String(previous.createdTime)) >= Date.parse(generatedAt)
    ) {
      throw new Error("Latest backup predecessor does not predate the backup.")
    }
    previousVerifiedBackup = previous
  }

  const data = asRecord(backup.data, "Backup data")
  const counts = asRecord(backup.counts, "Backup counts")
  const sections = asRecord(integrity.sections, "Backup section manifest")
  const dataKeys = Object.keys(data).sort()
  const countKeys = Object.keys(counts).sort()
  const sectionKeys = Object.keys(sections).sort()
  if (
    !sameStringSet(dataKeys, BACKUP_REQUIRED_DATA_KEYS) ||
    !sameStringSet(countKeys, BACKUP_REQUIRED_SECTION_KEYS) ||
    JSON.stringify(dataKeys) !== JSON.stringify(sectionKeys)
  ) {
    throw new Error("Latest backup section manifest does not match its data sections.")
  }

  for (const key of dataKeys) {
    const rows = data[key]
    if (!Array.isArray(rows)) {
      throw new Error(`Latest backup section ${key} is not an array.`)
    }
    const section = asRecord(sections[key], `Backup section manifest ${key}`)
    requireExactKeys(section, ["rowCount", "sha256"], `Backup section ${key}`)
    if (
      section.rowCount !== rows.length ||
      String(section.sha256 || "") !== sha256(JSON.stringify(rows))
    ) {
      throw new Error(`Latest backup section ${key} failed its SHA-256 check.`)
    }
    if (key !== "googleCalendarMetadata") {
      if (
        requireNonNegativeSafeInteger(
          counts[key],
          `Backup count ${key}`
        ) !== rows.length
      ) {
        throw new Error(`Latest backup count ${key} does not match its rows.`)
      }
    }
  }

  const calendarMetadata = requireArray(
    data.googleCalendarMetadata,
    "Backup Google Calendar metadata"
  )
  if (
    calendarMetadata.length !== 1 ||
    typeof asRecord(
      calendarMetadata[0],
      "Backup Google Calendar metadata row"
    ).calendarId !== "string"
  ) {
    throw new Error("Latest backup has invalid Google Calendar metadata.")
  }

  for (const key of ["adminUsers", "spcUsers"]) {
    for (const row of requireArray(data[key], `Backup section ${key}`)) {
      const record = asRecord(row, `Backup section ${key} row`)
      if (Object.prototype.hasOwnProperty.call(record, "password_hash")) {
        throw new Error(`Latest backup exposes ${key}.password_hash.`)
      }
    }
  }

  const truth = asRecord(integrity.truth, "Backup truth checkpoint")
  requireExactKeys(
    truth,
    [
      "schema",
      "verificationBeforeExport",
      "checkpointBeforeExport",
      "checkpointAfterExport",
      "verificationAfterExport",
      "exportedLedger",
      "exportedSnapshots",
    ],
    "Backup truth checkpoint"
  )
  const verificationBefore = asRecord(
    truth.verificationBeforeExport,
    "Backup truth verification before export"
  )
  const verificationAfter = asRecord(
    truth.verificationAfterExport,
    "Backup truth verification after export"
  )
  const checkpointBefore = asRecord(
    truth.checkpointBeforeExport,
    "Backup truth checkpoint before export"
  )
  const checkpointAfter = asRecord(
    truth.checkpointAfterExport,
    "Backup truth checkpoint after export"
  )
  const exportedLedger = asRecord(
    truth.exportedLedger,
    "Backup exported truth ledger"
  )
  const exportedSnapshots = asRecord(
    truth.exportedSnapshots,
    "Backup exported truth snapshots"
  )

  if (
    truth.schema !== TRUTH_CHECKPOINT_SCHEMA ||
    verificationBefore.valid !== true ||
    verificationBefore.integrityValid !== true ||
    verificationBefore.ledgerValid !== true ||
    verificationBefore.snapshotsValid !== true ||
    verificationBefore.referencesValid !== true ||
    verificationBefore.operationallyConsistent !== true ||
    verificationAfter.valid !== true ||
    verificationAfter.integrityValid !== true ||
    verificationAfter.ledgerValid !== true ||
    verificationAfter.snapshotsValid !== true ||
    verificationAfter.referencesValid !== true ||
    verificationAfter.operationallyConsistent !== true ||
    checkpointBefore.checkpointValid !== true ||
    checkpointAfter.checkpointValid !== true ||
    verificationBefore.latestCertificationHasProjectionEvidence !== true ||
    verificationAfter.latestCertificationHasProjectionEvidence !== true ||
    checkpointBefore.latestCertificationHasProjectionEvidence !== true ||
    checkpointAfter.latestCertificationHasProjectionEvidence !== true
  ) {
    throw new Error("Latest backup does not contain valid Exchange truth evidence.")
  }
  for (const [label, verification] of [
    ["before", verificationBefore],
    ["after", verificationAfter],
  ] as const) {
    if (
      verification.firstInvalidLedgerSequence != null ||
      verification.firstInvalidSnapshotSha256 != null ||
      verification.firstInvalidReferenceLedgerSequence != null
    ) {
      throw new Error(
        `Latest backup Exchange truth verification ${label} reports invalid evidence.`
      )
    }
    const queue = asRecord(
      verification.queue,
      `Backup Exchange queue ${label} export`
    )
    if (
      getNumber(queue.pending) +
        getNumber(queue.processing) +
        getNumber(queue.failed) +
        getNumber(queue.terminalFailed) !==
      0
    ) {
      throw new Error("Latest backup was captured while Exchange work was unresolved.")
    }
  }

  const stableHead =
    String(verificationBefore.headSequence || "") ===
      String(checkpointBefore.headSequence || "") &&
    String(verificationAfter.headSequence || "") ===
      String(checkpointBefore.headSequence || "") &&
    String(checkpointAfter.headSequence || "") ===
      String(checkpointBefore.headSequence || "") &&
    String(verificationBefore.headSha256 || "") ===
      String(checkpointBefore.headSha256 || "") &&
    String(verificationAfter.headSha256 || "") ===
      String(checkpointBefore.headSha256 || "") &&
    String(checkpointAfter.headSha256 || "") ===
      String(checkpointBefore.headSha256 || "") &&
    String(exportedLedger.headSequence || "") ===
      String(checkpointBefore.headSequence || "") &&
    String(exportedLedger.headSha256 || "") ===
      String(checkpointBefore.headSha256 || "")

  if (!stableHead) {
    throw new Error("Latest backup Exchange truth checkpoints do not agree.")
  }

  const ledgerRows = requireArray(
    data.outlookExchangeTruthLedger,
    "Backup Exchange truth ledger"
  ).map((row, index) =>
    asRecord(row, `Backup Exchange truth ledger row ${index}`)
  )
  const snapshotRows = requireArray(
    data.outlookExchangeTruthSnapshots,
    "Backup Exchange truth snapshots"
  ).map((row, index) =>
    asRecord(row, `Backup Exchange truth snapshot row ${index}`)
  )
  const auditLogIds = new Set(
    requireArray(data.auditLogs, "Backup audit logs").map((row, index) =>
      String(asRecord(row, `Backup audit log row ${index}`).id || "")
    )
  )
  const queueRowIds = new Set(
    requireArray(data.outlookExchangeSyncQueue, "Backup Exchange queue").map(
      (row, index) =>
        String(asRecord(row, `Backup Exchange queue row ${index}`).id || "")
    )
  )
  const snapshotsByHash = new Map<string, Record<string, unknown>>()
  for (const [index, snapshot] of snapshotRows.entries()) {
    const hash = requireSha256(
      snapshot.snapshot_sha256,
      `Backup Exchange truth snapshot ${index}`
    )
    if (snapshotsByHash.has(hash)) {
      throw new Error("Latest backup contains duplicate Exchange truth snapshots.")
    }
    const canonicalJson = String(snapshot.canonical_json || "")
    if (
      !canonicalJson ||
      sha256(canonicalJson) !== hash ||
      snapshot.byte_length !== Buffer.byteLength(canonicalJson, "utf8")
    ) {
      throw new Error(`Latest backup Exchange truth snapshot ${index} is invalid.`)
    }
    JSON.parse(canonicalJson)
    snapshotsByHash.set(hash, snapshot)
  }

  let previousEntrySha256: string | null = null
  let previousLedgerSequence: number | null = null
  const referencedSnapshots = new Set<string>()
  for (const [index, row] of ledgerRows.entries()) {
    const sequence = requirePositiveSafeInteger(
      row.ledger_sequence,
      `Backup Exchange truth ledger sequence ${index}`
    )
    if (
      previousLedgerSequence !== null &&
      sequence <= previousLedgerSequence
    ) {
      throw new Error(
        "Latest backup Exchange truth ledger is not strictly ordered."
      )
    }
    const payloadCanonicalJson = String(row.payload_canonical_json || "")
    JSON.parse(payloadCanonicalJson)
    if (
      requireSha256(
        row.payload_sha256,
        `Backup Exchange truth ledger payload ${sequence}`
      ) !== sha256(payloadCanonicalJson) ||
      (row.previous_entry_sha256 || null) !== previousEntrySha256
    ) {
      throw new Error(`Latest backup Exchange truth ledger row ${sequence} is invalid.`)
    }
    const snapshotSha256 = String(row.snapshot_sha256 || "")
    if (snapshotSha256) {
      requireSha256(
        snapshotSha256,
        `Backup Exchange truth ledger snapshot ${sequence}`
      )
      if (!snapshotsByHash.has(snapshotSha256)) {
        throw new Error(
          `Latest backup Exchange truth ledger row ${sequence} has no snapshot.`
        )
      }
      referencedSnapshots.add(snapshotSha256)
    }
    const auditLogId = String(row.audit_log_id || "")
    if (auditLogId && !auditLogIds.has(auditLogId)) {
      throw new Error(
        `Latest backup Exchange truth ledger row ${sequence} has no audit row.`
      )
    }
    const queueRowId = String(row.queue_row_id || "")
    if (queueRowId && !queueRowIds.has(queueRowId)) {
      throw new Error(
        `Latest backup Exchange truth ledger row ${sequence} has no queue row.`
      )
    }
    const hashMaterial = getLedgerHashMaterial(row)
    const entrySha256 = requireSha256(
      row.entry_sha256,
      `Backup Exchange truth ledger entry ${sequence}`
    )
    if (
      row.hash_material !== hashMaterial ||
      entrySha256 !== sha256(hashMaterial)
    ) {
      throw new Error(
        `Latest backup Exchange truth ledger row ${sequence} failed its hash chain.`
      )
    }
    previousEntrySha256 = entrySha256
    previousLedgerSequence = sequence
  }
  if (
    snapshotRows.length !== referencedSnapshots.size ||
    snapshotRows.some(
      (snapshot) => !referencedSnapshots.has(String(snapshot.snapshot_sha256))
    )
  ) {
    throw new Error("Latest backup contains unreferenced Exchange truth snapshots.")
  }

  const ledgerHead = ledgerRows.at(-1)
  const ledgerHeadSequence = requirePositiveSafeInteger(
    ledgerHead?.ledger_sequence,
    "Backup exported truth-ledger head sequence"
  )
  const ledgerHeadSha256 = requireSha256(
    ledgerHead?.entry_sha256,
    "Backup exported truth-ledger head hash"
  )
  if (
    requirePositiveSafeInteger(
      exportedLedger.entries,
      "Backup exported truth-ledger count"
    ) !== ledgerRows.length ||
    requirePositiveSafeInteger(
      exportedLedger.headSequence,
      "Backup exported truth-ledger manifest head"
    ) !== ledgerHeadSequence ||
    requireSha256(
      exportedLedger.headSha256,
      "Backup exported truth-ledger manifest hash"
    ) !== ledgerHeadSha256 ||
    requirePositiveSafeInteger(
      checkpointBefore.ledgerEntries,
      "Backup truth checkpoint ledger count"
    ) !== ledgerRows.length ||
    requirePositiveSafeInteger(
      checkpointBefore.snapshots,
      "Backup truth checkpoint snapshot count"
    ) !== snapshotRows.length ||
    requirePositiveSafeInteger(
      exportedSnapshots.count,
      "Backup exported truth snapshot count"
    ) !== snapshotRows.length
  ) {
    throw new Error("Latest backup Exchange truth rows do not match its checkpoint.")
  }

  const certifications = requireArray(
    data.outlookExchangeSyncCertifications,
    "Backup Exchange certifications"
  )
    .map((row, index) =>
      asRecord(row, `Backup Exchange certification row ${index}`)
    )
    .sort(
      (left, right) =>
        Date.parse(String(left.certified_at || "")) -
        Date.parse(String(right.certified_at || ""))
    )
  const latestCertification = certifications.at(-1)
  if (!latestCertification) {
    throw new Error("Latest backup contains no Exchange full certification.")
  }
  const latestCertificationRunId = String(latestCertification.run_id || "")
  const latestSourceFingerprint = requireSha256(
    latestCertification.source_fingerprint,
    "Backup latest Exchange source fingerprint"
  )
  const latestProjection = ledgerRows.find(
    (row) => row.event_key === `projection:${latestCertificationRunId}`
  )
  if (
    !latestProjection ||
    latestProjection.event_type !== "full_projection_evidence" ||
    latestProjection.run_id !== latestCertificationRunId ||
    latestProjection.snapshot_sha256 !== latestSourceFingerprint
  ) {
    throw new Error("Latest backup certification has no matching projection evidence.")
  }
  const projectionPayload = asRecord(
    JSON.parse(String(latestProjection.payload_canonical_json || "")),
    "Backup latest Exchange projection evidence payload"
  )
  const projectionSummary = asRecord(
    projectionPayload.verificationSummary,
    "Backup latest Exchange projection verification summary"
  )
  if (
    projectionPayload.schema !== "fcuno.exchange.projection-evidence/v1" ||
    projectionPayload.runId !== latestCertificationRunId ||
    projectionPayload.sourceFingerprint !== latestSourceFingerprint ||
    projectionPayload.projectionSnapshotSha256 !== latestSourceFingerprint ||
    projectionSummary.status !== "match" ||
    projectionSummary.mismatchCount !== 0 ||
    projectionSummary.sourceFenceStable !== true
  ) {
    throw new Error("Latest backup projection evidence is not an exact match.")
  }
  for (const state of [
    verificationBefore,
    verificationAfter,
    checkpointBefore,
    checkpointAfter,
  ]) {
    if (
      state.latestCertificationRunId !== latestCertificationRunId ||
      state.latestSourceFingerprint !== latestSourceFingerprint ||
      state.latestProjectionSnapshotSha256 !== latestSourceFingerprint
    ) {
      throw new Error("Latest backup Exchange certification checkpoint is inconsistent.")
    }
  }

  const uploadedFileSha256 = sha256(bytes)
  if (
    appProperties?.backupSchema !== BACKUP_FILE_SCHEMA ||
    appProperties?.verificationStatus !== "complete" ||
    appProperties?.artifactSha256 !== artifactSha256 ||
    appProperties?.uploadedFileSha256 !== uploadedFileSha256 ||
    appProperties?.fileByteLength !== String(bytes.byteLength) ||
    appProperties?.truthHeadSequence !==
      String(checkpointBefore.headSequence || "") ||
    appProperties?.truthHeadSha256 !==
      String(checkpointBefore.headSha256 || "")
  ) {
    throw new Error("Latest backup Drive verification metadata is incomplete or mismatched.")
  }

  return {
    artifactSha256,
    uploadedFileSha256,
    fileByteLength: bytes.byteLength,
    truthHeadSequence: String(ledgerHeadSequence),
    truthHeadSha256: ledgerHeadSha256,
    sectionCount: dataKeys.length,
    migrationHead,
    deploymentCommit: String(backup.deploymentCommit || ""),
    backupRunId,
    generatedAt,
    source,
    requestedBy,
    warningCount: sourceWarnings.length,
    liveTableCount: liveTables.length,
    liveTables,
    latestCertificationRunId,
    latestProjectionSnapshotSha256: latestSourceFingerprint,
    previousVerifiedBackup,
    previousBackupAnchored:
      previousVerifiedBackup !== null,
  }
}

async function checkDriveBackup(): Promise<HealthCheckResult> {
  const { google } = await loadGoogleApis()
  const auth = await getOAuthClient("GOOGLE_DRIVE_REFRESH_TOKEN")
  const drive = google.drive({ version: "v3", auth })
  const rootFolderId = process.env.GOOGLE_DRIVE_BACKUP_FOLDER_ID || requireEnv("GOOGLE_DRIVE_COMPANY_FOLDER_ID")
  const sharedDriveId = process.env.GOOGLE_DRIVE_SHARED_DRIVE_ID || null
  const backupRoot = await findDriveFolder(drive, rootFolderId, BACKUP_FOLDER_NAME, sharedDriveId)
  if (!backupRoot?.id) {
    return {
      status: "warning",
      message: "Backup root folder has not been created yet",
      details: {
        folder: BACKUP_FOLDER_NAME,
      },
    }
  }

  const dailyFolder = await findDriveFolder(drive, backupRoot.id, DAILY_FOLDER_NAME, sharedDriveId)
  if (!dailyFolder?.id) {
    return {
      status: "warning",
      message: "Daily backup folder has not been created yet",
      details: {
        folder: DAILY_FOLDER_NAME,
      },
    }
  }

  const candidates: drive_v3.Schema$File[] = []
  let pageToken: string | undefined
  do {
    const list = await drive.files.list({
      q: `trashed = false and mimeType = 'application/json' and '${dailyFolder.id}' in parents and name contains 'bunker-map-backup-'`,
      fields: "nextPageToken,files(id,name,createdTime,webViewLink,mimeType,appProperties)",
      orderBy: "createdTime desc",
      pageSize: 1000,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      corpora: sharedDriveId ? "drive" : undefined,
      driveId: sharedDriveId || undefined,
    })
    candidates.push(...(list.data.files || []))
    pageToken = list.data.nextPageToken || undefined
  } while (pageToken)

  const verifiedCandidates = candidates
    .filter((file) =>
      BACKUP_FILE_NAME_PATTERN.test(file.name || "") &&
      file.mimeType === "application/json" &&
      file.appProperties?.backupSchema === BACKUP_FILE_SCHEMA &&
      file.appProperties?.verificationStatus === "complete"
    )
    .sort((left, right) =>
      String(right.createdTime || "").localeCompare(
        String(left.createdTime || "")
      ) ||
      String(right.name || "").localeCompare(String(left.name || "")) ||
      String(right.id || "").localeCompare(String(left.id || ""))
    )
  const unverifiedCandidateCount = candidates.filter(
    (file) =>
      BACKUP_FILE_NAME_PATTERN.test(file.name || "") &&
      file.mimeType === "application/json" &&
      (file.appProperties?.backupSchema !== BACKUP_FILE_SCHEMA ||
        file.appProperties?.verificationStatus !== "complete")
  ).length
  const latest = verifiedCandidates[0]

  if (!latest?.createdTime) {
    return {
      status: "warning",
      message: "No verified daily backup file found yet",
    }
  }

  const ageHours = Math.round((Date.now() - new Date(latest.createdTime).getTime()) / 36_000) / 100
  if (!latest.id) {
    throw new Error("Latest verified daily backup is missing its Drive file id.")
  }

  let verified: ReturnType<typeof verifyBackupArtifact>
  try {
    const downloaded = await readDriveJsonFile(drive, latest.id)
    verified = verifyBackupArtifact(
      downloaded.value,
      downloaded.bytes,
      latest.appProperties
    )
    if (
      Date.parse(verified.generatedAt) >
      Date.parse(String(latest.createdTime || ""))
    ) {
      throw new Error("Latest backup was generated after its Drive creation time.")
    }

    const expectedPredecessor = verifiedCandidates[1] || null
    const predecessorAnchor = verified.previousVerifiedBackup
    if (!predecessorAnchor) {
      if (expectedPredecessor) {
        throw new Error(
          "Latest backup is missing its immediate verified predecessor anchor."
        )
      }
    } else {
      if (
        !expectedPredecessor?.id ||
        expectedPredecessor.id !== String(predecessorAnchor.fileId || "")
      ) {
        throw new Error(
          "Latest backup does not anchor the immediate preceding verified file."
        )
      }
      if (
        expectedPredecessor.name !== predecessorAnchor.name ||
        (expectedPredecessor.createdTime || null) !==
          (predecessorAnchor.createdTime || null) ||
        expectedPredecessor.appProperties?.artifactSha256 !==
          predecessorAnchor.artifactSha256 ||
        expectedPredecessor.appProperties?.uploadedFileSha256 !==
          predecessorAnchor.uploadedFileSha256
      ) {
        throw new Error(
          "Latest backup predecessor anchor does not match Drive metadata."
        )
      }

      const predecessorDownload = await readDriveJsonFile(
        drive,
        expectedPredecessor.id
      )
      const predecessorVerified = verifyBackupArtifact(
        predecessorDownload.value,
        predecessorDownload.bytes,
        expectedPredecessor.appProperties
      )
      if (
        predecessorVerified.artifactSha256 !==
          predecessorAnchor.artifactSha256 ||
        predecessorVerified.uploadedFileSha256 !==
          predecessorAnchor.uploadedFileSha256 ||
        Date.parse(predecessorVerified.generatedAt) >
          Date.parse(String(expectedPredecessor.createdTime || "")) ||
        Date.parse(predecessorVerified.generatedAt) >=
          Date.parse(verified.generatedAt)
      ) {
        throw new Error(
          "Latest backup predecessor bytes do not match the chain anchor."
        )
      }
    }
  } catch (error) {
    return {
      status: "error",
      message: "Latest daily backup failed integrity verification",
      details: {
        name: latest.name || "",
        createdTime: latest.createdTime,
        ageHours,
        webViewLink: latest.webViewLink || "",
        error: getErrorMessage(error),
      },
    }
  }

  let currentInventory: Awaited<ReturnType<typeof getCurrentBackupInventory>>
  try {
    currentInventory = await getCurrentBackupInventory()
  } catch (error) {
    return {
      status: "error",
      message: "Live database failed the backup inventory contract",
      details: {
        name: latest.name || "",
        createdTime: latest.createdTime,
        webViewLink: latest.webViewLink || "",
        error: getErrorMessage(error),
      },
    }
  }
  if (verified.migrationHead > currentInventory.migrationHead) {
    return {
      status: "error",
      message: "Latest backup migration is ahead of the live database",
      details: {
        backupMigrationHead: verified.migrationHead,
        liveMigrationHead: currentInventory.migrationHead,
      },
    }
  }
  const databaseInventoryCurrent =
    verified.migrationHead === currentInventory.migrationHead &&
    sameStringSet(verified.liveTables, currentInventory.liveTables)
  const stale = ageHours > DAILY_BACKUP_WARNING_AGE_HOURS
  const provenanceIncomplete = !verified.deploymentCommit
  return {
    status:
      stale ||
      unverifiedCandidateCount > 0 ||
      !databaseInventoryCurrent ||
      provenanceIncomplete
        ? "warning"
        : "ok",
    message: stale
      ? "Latest verified daily backup is older than expected"
      : unverifiedCandidateCount > 0
        ? "Latest verified daily backup passed, but unverified backup files need review"
        : !databaseInventoryCurrent
          ? "Latest verified daily backup predates the live database schema"
          : provenanceIncomplete
            ? "Latest verified daily backup passed integrity checks but has no deployment commit"
            : "Latest verified daily backup passed all integrity checks",
    details: {
      name: latest.name || "",
      createdTime: latest.createdTime,
      ageHours,
      webViewLink: latest.webViewLink || "",
      artifactSha256: verified.artifactSha256,
      uploadedFileSha256: verified.uploadedFileSha256,
      fileByteLength: verified.fileByteLength,
      truthHeadSequence: verified.truthHeadSequence,
      truthHeadSha256: verified.truthHeadSha256,
      sectionCount: verified.sectionCount,
      migrationHead: verified.migrationHead,
      liveMigrationHead: currentInventory.migrationHead,
      databaseInventoryCurrent,
      deploymentCommit: verified.deploymentCommit,
      backupRunId: verified.backupRunId,
      generatedAt: verified.generatedAt,
      source: verified.source,
      requestedBy: verified.requestedBy,
      sourceWarnings: verified.warningCount,
      unverifiedBackupFiles: unverifiedCandidateCount,
      liveTableCount: verified.liveTableCount,
      latestCertificationRunId: verified.latestCertificationRunId,
      latestProjectionSnapshotSha256:
        verified.latestProjectionSnapshotSha256,
      previousBackupAnchored: verified.previousBackupAnchored,
      immediatePredecessorVerified: verified.previousBackupAnchored
        ? true
        : null,
    },
  }
}

async function checkDriveFileContentBackup(): Promise<HealthCheckResult> {
  const supabase = getSupabaseClient()
  const [companyFileIds, entryFileIds] = await Promise.all([
    listActiveDriveFileIds(supabase, "cc_company_files"),
    listActiveDriveFileIds(supabase, "cc_entry_files"),
  ])
  const companyFileCount = companyFileIds.length
  const entryFileCount = entryFileIds.length
  const total = companyFileCount + entryFileCount

  if (!total) {
    return {
      status: "ok",
      message: "No active Google Drive upload records found",
      details: {
        activeCompanyFiles: companyFileCount,
        activeEntryFiles: entryFileCount,
      },
    }
  }

  const { google } = await loadGoogleApis()
  const auth = await getOAuthClient("GOOGLE_DRIVE_REFRESH_TOKEN")
  const drive = google.drive({ version: "v3", auth })
  const rootFolderId = process.env.GOOGLE_DRIVE_BACKUP_FOLDER_ID || requireEnv("GOOGLE_DRIVE_COMPANY_FOLDER_ID")
  const sharedDriveId = process.env.GOOGLE_DRIVE_SHARED_DRIVE_ID || null
  const backupRoot = await findDriveFolder(drive, rootFolderId, BACKUP_FOLDER_NAME, sharedDriveId)
  if (!backupRoot?.id) {
    return {
      status: "warning",
      message: "Drive file backup has not run yet",
      details: {
        activeCompanyFiles: companyFileCount,
        activeEntryFiles: entryFileCount,
        firstBackupMissing: true,
        missingFolder: BACKUP_FOLDER_NAME,
      },
    }
  }

  const manifestFolder = await findDriveFolder(drive, backupRoot.id, DRIVE_FILE_MANIFEST_FOLDER_NAME, sharedDriveId)
  if (!manifestFolder?.id) {
    return {
      status: "warning",
      message: "Drive file backup has not run yet",
      details: {
        activeCompanyFiles: companyFileCount,
        activeEntryFiles: entryFileCount,
        firstBackupMissing: true,
        missingFolder: DRIVE_FILE_MANIFEST_FOLDER_NAME,
      },
    }
  }

  const latestManifest = await drive.files.list({
    q: `trashed = false and '${manifestFolder.id}' in parents and name contains '${DRIVE_FILE_MANIFEST_PREFIX}'`,
    fields: "files(id,name,createdTime,webViewLink)",
    orderBy: "createdTime desc",
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    corpora: sharedDriveId ? "drive" : undefined,
    driveId: sharedDriveId || undefined,
  })
  const latest = latestManifest.data.files?.[0]
  if (!latest?.createdTime) {
    return {
      status: "warning",
      message: "Drive file backup has not run yet",
      details: {
        activeCompanyFiles: companyFileCount,
        activeEntryFiles: entryFileCount,
        firstBackupMissing: true,
      },
    }
  }

  const ageHours = Math.round((Date.now() - new Date(latest.createdTime).getTime()) / 36_000) / 100
  const stale = ageHours > DRIVE_FILE_BACKUP_WARNING_AGE_HOURS
  let manifestCounts: Record<string, unknown> = {}
  let manifestGcs: Record<string, unknown> = {}
  let manifestFileIds = new Set<string>()

  try {
    if (latest.id) {
      const { value: manifest } = await readDriveJsonFile(drive, latest.id)
      manifestCounts = (manifest.counts || {}) as Record<string, unknown>
      manifestGcs = (manifest.gcs || {}) as Record<string, unknown>
      const manifestFiles = Array.isArray(manifest.files) ? manifest.files : []
      manifestFileIds = new Set(
        manifestFiles
          .map((file) => (file && typeof file === "object" ? String((file as Record<string, unknown>).id || "") : ""))
          .filter(Boolean)
      )
    }
  } catch (error) {
    return {
      status: "warning",
      message: "Latest Drive file backup manifest could not be read",
      details: {
        activeCompanyFiles: companyFileCount,
        activeEntryFiles: entryFileCount,
        name: latest.name || "",
        createdTime: latest.createdTime,
        ageHours,
        webViewLink: latest.webViewLink || "",
        error: getErrorMessage(error),
      },
    }
  }

  const failedFiles = Number(manifestCounts.failed || 0)
  const totalFiles = Number(manifestCounts.totalFiles || 0)
  const uploadedFiles = Number(manifestCounts.uploaded || 0)
  const skippedFiles = Number(manifestCounts.skipped || 0)
  const estimatedStorageBytes = Number(manifestCounts.estimatedCurrentStorageBytes || 0)
  const freeTierLimitBytes = Number(manifestGcs.freeTierStorageLimitBytes || 0)
  const estimatedStorageGiB = Math.round((estimatedStorageBytes / 1024 / 1024 / 1024) * 1000) / 1000
  const freeTierLimitGiB = Math.round((freeTierLimitBytes / 1024 / 1024 / 1024) * 1000) / 1000
  const freeTierRemainingGiB = Math.round(((freeTierLimitBytes - estimatedStorageBytes) / 1024 / 1024 / 1024) * 1000) / 1000
  const freeTierUsedPercent = freeTierLimitBytes
    ? Math.round((estimatedStorageBytes / freeTierLimitBytes) * 10_000) / 100
    : 0
  const storageNearFreeTier = freeTierLimitBytes > 0 && freeTierUsedPercent >= DRIVE_FILE_BACKUP_STORAGE_WARNING_PERCENT
  const freeTierUnavailable = freeTierLimitBytes <= 0
  const activeFileIds = [...companyFileIds, ...entryFileIds]
  const coveredFiles = activeFileIds.filter((fileId) => manifestFileIds.has(fileId)).length
  const missingFiles = activeFileIds.length - coveredFiles
  const coverageComplete = missingFiles === 0

  return {
    status: stale || failedFiles > 0 || !coverageComplete || storageNearFreeTier || freeTierUnavailable ? "warning" : "ok",
    message:
      failedFiles > 0
        ? "Latest Drive file backup completed with file errors"
        : !coverageComplete
          ? "Drive file backup does not cover every active CCINFO file"
        : stale
          ? "Latest Drive file backup is older than expected"
          : freeTierUnavailable
            ? "Drive file backup bucket is not in a Cloud Storage Always Free storage region"
            : storageNearFreeTier
              ? "Drive file backup storage is close to the free-tier storage limit"
              : "Latest Drive file backup manifest found",
    details: {
      activeCompanyFiles: companyFileCount,
      activeEntryFiles: entryFileCount,
      activeFiles: activeFileIds.length,
      coveredFiles,
      missingFiles,
      coverage: `${coveredFiles} / ${activeFileIds.length}`,
      totalFiles,
      uploadedFiles,
      skippedFiles,
      failedFiles,
      estimatedStorageGiB,
      freeTierLimitGiB,
      freeTierRemainingGiB,
      freeTierUsedPercent,
      gcsLocation: String(manifestGcs.location || ""),
      name: latest.name || "",
      createdTime: latest.createdTime,
      ageHours,
      webViewLink: latest.webViewLink || "",
    },
  }
}

async function checkGoogleCalendar(): Promise<HealthCheckResult> {
  const { google } = await loadGoogleApis()
  const calendar = google.calendar({ version: "v3", auth: await getOAuthClient("GOOGLE_CALENDAR_REFRESH_TOKEN") })
  const calendarId = process.env.GOOGLE_CALENDAR_ID || DEFAULT_CALENDAR_ID
  await calendar.events.list({
    calendarId,
    maxResults: 1,
    singleEvents: true,
    orderBy: "startTime",
    timeMin: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
  })

  return {
    status: "ok",
    message: "Google Calendar reachable",
    details: {
      calendarId,
    },
  }
}

async function checkGoogleContacts(): Promise<HealthCheckResult> {
  const { google } = await loadGoogleApis()
  const people = google.people({ version: "v1", auth: await getOAuthClient("GOOGLE_OAUTH_REFRESH_TOKEN") })
  await people.people.connections.list({
    resourceName: "people/me",
    pageSize: 1,
    personFields: "names,emailAddresses",
  })

  return {
    status: "ok",
    message: "Google Contacts reachable",
  }
}

async function checkExchangeTruth(): Promise<HealthCheckResult> {
  const supabase = getSupabaseClient()
  const [checkpointResponse, verificationResponse] = await Promise.all([
    supabase.rpc("get_outlook_exchange_truth_checkpoint"),
    supabase.rpc("verify_outlook_exchange_truth_ledger"),
  ])
  if (checkpointResponse.error) throw checkpointResponse.error
  if (verificationResponse.error) throw verificationResponse.error

  const checkpoint = asRecord(
    checkpointResponse.data,
    "Exchange truth checkpoint"
  )
  const verification = asRecord(
    verificationResponse.data,
    "Exchange truth verification"
  )
  const queue = asRecord(checkpoint.queue, "Exchange truth queue status")
  const pending = getNumber(queue.pending)
  const processing = getNumber(queue.processing)
  const failed = getNumber(queue.failed)
  const terminalFailed = getNumber(queue.terminalFailed)
  const latestCertificationAt = String(
    checkpoint.latestCertificationAt || ""
  )
  const latestCertificationTimestamp = latestCertificationAt
    ? new Date(latestCertificationAt).getTime()
    : Number.NaN
  const certificationAgeHours = Number.isFinite(latestCertificationTimestamp)
    ? Math.round((Date.now() - latestCertificationTimestamp) / 36_000) / 100
    : null

  const integrityValid =
    checkpoint.checkpointValid === true &&
    verification.valid === true &&
    verification.integrityValid === true &&
    verification.ledgerValid === true &&
    verification.snapshotsValid === true &&
    verification.referencesValid === true &&
    verification.firstInvalidLedgerSequence == null &&
    verification.firstInvalidSnapshotSha256 == null &&
    verification.firstInvalidReferenceLedgerSequence == null &&
    String(verification.headSequence || "") ===
      String(checkpoint.headSequence || "") &&
    String(verification.headSha256 || "") ===
      String(checkpoint.headSha256 || "") &&
    getNumber(checkpoint.headSequence) > 0 &&
    /^[0-9a-f]{64}$/.test(String(checkpoint.headSha256 || ""))
  const hasProjectionEvidence =
    checkpoint.latestCertificationHasProjectionEvidence === true &&
    verification.latestCertificationHasProjectionEvidence === true &&
    verification.latestProjectionSnapshotSha256 ===
      verification.latestSourceFingerprint
  const operationallyConsistent =
    verification.operationallyConsistent === true
  const certificationStale =
    certificationAgeHours === null ||
    certificationAgeHours > EXCHANGE_CERTIFICATION_WARNING_AGE_HOURS
  const hasFailedWork = failed > 0 || terminalFailed > 0
  const hasInFlightWork = pending > 0 || processing > 0

  let status: HealthStatus = "ok"
  let message = "Exchange truth checkpoint is valid and the projection is current"
  if (!integrityValid) {
    status = "error"
    message = "Latest Exchange truth checkpoint failed verification"
  } else if (!hasProjectionEvidence) {
    status = "error"
    message = "Latest Exchange certification has no projection evidence"
  } else if (!operationallyConsistent || hasFailedWork) {
    status = "error"
    message = hasFailedWork
      ? "Exchange truth checkpoint is valid but delivery has failed queue rows"
      : "Exchange truth is cryptographically valid but not operationally consistent"
  } else if (
    hasInFlightWork ||
    certificationStale
  ) {
    status = "warning"
    message = hasInFlightWork
      ? "Exchange truth checkpoint is valid while delivery work is still in progress"
      : "Exchange truth checkpoint is valid but its full certification is older than expected"
  }

  return {
    status,
    message,
    details: {
      checkpointValid: checkpoint.checkpointValid === true,
      fullLedgerValid: verification.ledgerValid === true,
      snapshotsValid: verification.snapshotsValid === true,
      referencesValid: verification.referencesValid === true,
      operationallyConsistent,
      headSequence: getNumber(checkpoint.headSequence),
      headSha256: String(checkpoint.headSha256 || ""),
      headEventType: String(checkpoint.headEventType || ""),
      headOccurredAt: String(checkpoint.headOccurredAt || ""),
      ledgerEntries: getNumber(checkpoint.ledgerEntries),
      snapshots: getNumber(checkpoint.snapshots),
      latestCertificationRunId: String(
        checkpoint.latestCertificationRunId || ""
      ),
      latestCertificationAt,
      certificationAgeHours,
      latestCertificationHasProjectionEvidence: hasProjectionEvidence,
      pending,
      processing,
      failed,
      terminalFailed,
      projectionCurrent:
        hasProjectionEvidence &&
        operationallyConsistent &&
        pending === 0 &&
        processing === 0 &&
        failed === 0,
      dailyBackupPerformsFullChainVerification: true,
    },
  }
}

async function checkExchangeConfig(): Promise<HealthCheckResult> {
  const names = [
    "EXCHANGE_SYNC_WEBHOOK_URL",
    "EXCHANGE_APP_ID",
    "EXCHANGE_TENANT_ID",
    "EXCHANGE_ORGANIZATION",
    "EXCHANGE_CERT_PFX_BASE64",
    "EXCHANGE_CERT_PASSWORD",
  ]
  const missing = names.filter((name) => !process.env[name])

  return {
    status: missing.length ? "warning" : "ok",
    message: missing.length ? "Exchange sync configuration incomplete" : "Exchange sync configuration present",
    details: {
      missing: missing.join(", "),
    },
  }
}

async function checkEmailNoticeConfig(): Promise<HealthCheckResult> {
  const config = getEmailNoticeConfigStatus()

  return {
    status: config.missing.length ? "warning" : "ok",
    message: config.missing.length ? "Exchange notice email configuration incomplete" : "Exchange notice email configured",
    details: {
      from: config.from,
      smtpHost: config.host,
      smtpPort: config.port,
      smtpUser: config.user,
      missing: config.missing.join(", "),
    },
  }
}

async function checkCronConfig(): Promise<HealthCheckResult> {
  const missing = !process.env.CRON_SECRET

  return {
    status: missing ? "warning" : "ok",
    message: missing ? "CRON_SECRET is not configured" : "Cron secret configured",
    details: {
      dailyBackupSchedule: "0 19 * * * UTC",
      hongKongTime: "Daily 03:00",
    },
  }
}

export async function getSystemHealth(): Promise<SystemHealth> {
  const checks = await Promise.all([
    runCheck("supabase", "Supabase", checkSupabase),
    runCheck("schema", "Optional Schema", checkOptionalSchema),
    runCheck(
      "backup",
      "Daily Backup",
      checkDriveBackup,
      BACKUP_CHECK_TIMEOUT_MS
    ),
    runCheck("drive-file-content-backup", "Drive File Content Backup", checkDriveFileContentBackup),
    runCheck("calendar", "Google Calendar", checkGoogleCalendar),
    runCheck("contacts", "Google Contacts", checkGoogleContacts),
    runCheck("exchange-truth", "Exchange Truth Chain", checkExchangeTruth),
    runCheck("exchange", "Exchange Sync", checkExchangeConfig),
    runCheck("email-notice", "Notice Email", checkEmailNoticeConfig),
    runCheck("cron", "Vercel Cron", checkCronConfig),
  ])

  return {
    status: combineStatus(checks),
    checkedAt: new Date().toISOString(),
    deployment: getDeployment(),
    checks,
  }
}
