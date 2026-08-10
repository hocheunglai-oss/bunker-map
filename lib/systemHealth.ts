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
const BACKUP_STREAM_VERIFICATION_SCHEMA =
  "bunker-map-backup-stream-verification/v1"
const TRUTH_CHECKPOINT_SCHEMA = "fcuno-exchange-backup-checkpoint/v1"
const BACKUP_INVENTORY_SCHEMA = "bunker-map.backup-inventory/v1"
const MINIMUM_BACKUP_MIGRATION_HEAD = "20260723080326"
const OPENAI_USAGE_MIGRATION_HEAD = "20260723083832"
const OUTLOOK_TEMPLATE_TRUTH_MIGRATION_HEAD = "20260723124045"
const OUTLOOK_TEMPLATE_STABLE_MISSING_MIGRATION_HEAD = "20260723125759"
const ATTENDANCE_RECORD_MIGRATION_HEAD = "20260807094108"
const ATTENDANCE_MONTHLY_ROSTER_MIGRATION_HEAD = "20260810041413"
const OUTLOOK_TEMPLATE_RESOLUTION_SCHEMA =
  "fcuno.outlook-template-recipient-resolution/v1"
const OUTLOOK_TEMPLATE_TRUTH_SCHEMA =
  "fcuno.outlook-template-recipient-truth/v2"
const BACKUP_FILE_NAME_PATTERN =
  /^bunker-map-backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.json$/
const DRIVE_FILE_BACKUP_STORAGE_WARNING_PERCENT = 80
const DEFAULT_CALENDAR_ID = "fcb.bunker@gmail.com"
const CHECK_TIMEOUT_MS = 12_000
const BACKUP_CHECK_TIMEOUT_MS = 180_000
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
  {
    key: "openAiUsageEvents",
    table: "openai_usage_events",
    introducedAt: OPENAI_USAGE_MIGRATION_HEAD,
  },
  { key: "spcPresentationChunks", table: "spc_presentation_chunks" },
  {
    key: "attendancePeople",
    table: "attendance_people",
    introducedAt: ATTENDANCE_RECORD_MIGRATION_HEAD,
  },
  {
    key: "attendanceTeamAssignments",
    table: "attendance_team_assignments",
    introducedAt: ATTENDANCE_MONTHLY_ROSTER_MIGRATION_HEAD,
  },
  {
    key: "attendanceRawPunches",
    table: "attendance_raw_punches",
    introducedAt: ATTENDANCE_RECORD_MIGRATION_HEAD,
  },
  {
    key: "attendanceLeaveEntries",
    table: "attendance_leave_entries",
    introducedAt: ATTENDANCE_RECORD_MIGRATION_HEAD,
  },
  {
    key: "attendanceManualOverrides",
    table: "attendance_manual_overrides",
    introducedAt: ATTENDANCE_RECORD_MIGRATION_HEAD,
  },
  {
    key: "attendanceEntitlements",
    table: "attendance_entitlements",
    introducedAt: ATTENDANCE_RECORD_MIGRATION_HEAD,
  },
  {
    key: "attendanceMonthlyAdjustments",
    table: "attendance_monthly_adjustments",
    introducedAt: ATTENDANCE_RECORD_MIGRATION_HEAD,
  },
  {
    key: "attendanceMonthlyConfirmations",
    table: "attendance_monthly_confirmations",
    introducedAt: ATTENDANCE_RECORD_MIGRATION_HEAD,
  },
  {
    key: "attendanceReminderDispatches",
    table: "attendance_reminder_dispatches",
    introducedAt: ATTENDANCE_MONTHLY_ROSTER_MIGRATION_HEAD,
  },
  {
    key: "attendanceSyncRuns",
    table: "attendance_sync_runs",
    introducedAt: ATTENDANCE_RECORD_MIGRATION_HEAD,
  },
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
const BACKUP_EPHEMERAL_TABLES = [
  "admin_sessions",
  "bunker_map_backup_lock",
  "outlook_exchange_sync_lock",
  "spc_sessions",
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
const BACKUP_STREAM_REQUIRED_PROPERTIES = [
  "backupSchema",
  "verificationContract",
  "verificationStatus",
  "artifactSha256",
  "uploadedFileSha256",
  "fileByteLength",
  "truthHeadSequence",
  "truthHeadSha256",
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
] as const

function getBackupArtifactContract(migrationHead: string) {
  const tableSections = BACKUP_TABLE_SECTIONS.filter(
    (section) =>
      !("introducedAt" in section) ||
      migrationHead >= section.introducedAt
  )
  const requiredSectionKeys = [
    ...tableSections.map(({ key }) => key),
    ...BACKUP_TRUTH_SECTIONS.map(({ key }) => key),
    ...BACKUP_EXTERNAL_SECTION_KEYS,
  ].sort()
  const requiredDataKeys = [
    ...requiredSectionKeys,
    "googleCalendarMetadata",
  ].sort()
  const registeredTables = [
    ...tableSections.map(({ table }) => table),
    ...BACKUP_TRUTH_SECTIONS.map(({ table }) => table),
    ...BACKUP_EPHEMERAL_TABLES,
  ].sort()
  const requiredLiveTables = [
    ...tableSections
      .filter((section) => !("optional" in section && section.optional))
      .map(({ table }) => table),
    ...BACKUP_TRUTH_SECTIONS.map(({ table }) => table),
    ...BACKUP_EPHEMERAL_TABLES,
  ].sort()

  return {
    requiredSectionKeys,
    requiredDataKeys,
    registeredTables,
    requiredLiveTables,
  }
}

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

function hasExactKeySet(value: unknown, expected: readonly string[]) {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value as Record<string, unknown>).sort()) ===
      JSON.stringify([...expected].sort())
  )
}

function exactRecordValues(
  value: unknown,
  expected: Record<string, string | number | boolean>
) {
  if (!hasExactKeySet(value, Object.keys(expected))) return false
  const record = value as Record<string, unknown>
  return Object.entries(expected).every(([key, expectedValue]) =>
    record[key] === expectedValue
  )
}

function sameTimestamp(left: unknown, right: unknown) {
  return (
    typeof left === "string" &&
    typeof right === "string" &&
    left.length > 0 &&
    right.length > 0 &&
    !Number.isNaN(Date.parse(left)) &&
    !Number.isNaN(Date.parse(right)) &&
    Date.parse(left) === Date.parse(right)
  )
}

function cleanBackupRecipientText(value: unknown) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
}

function splitBackupOutlookRecipientText(value: unknown) {
  const text = String(value || "").replace(/\r?\n/g, " ")
  const parts: string[] = []
  let current = ""
  let inQuote = false
  let angleDepth = 0

  for (let index = 0; index < text.length; index += 1) {
    const char = text.charAt(index)
    if (char === "\"" && text.charAt(index - 1) !== "\\") inQuote = !inQuote
    if (!inQuote && char === "<") angleDepth += 1
    if (!inQuote && char === ">" && angleDepth > 0) angleDepth -= 1
    if (!inQuote && angleDepth === 0 && (char === "," || char === ";")) {
      if (current.trim()) parts.push(current.trim())
      current = ""
      continue
    }
    current += char
  }

  if (current.trim()) parts.push(current.trim())
  return parts
}

function parseBackupOutlookRecipientLiteral(literal: string) {
  const trimmed = cleanBackupRecipientText(literal)
  const angleMatch = trimmed.match(/^(.*?)\s*<([^<>]+)>\s*$/)
  if (!angleMatch) {
    return {
      displayName: trimmed.includes("@") ? "" : trimmed.replace(/^"+|"+$/g, ""),
      sourceValue: trimmed.replace(/^"+|"+$/g, ""),
    }
  }
  return {
    displayName: cleanBackupRecipientText(angleMatch[1]).replace(
      /^"+|"+$/g,
      ""
    ),
    sourceValue: cleanBackupRecipientText(angleMatch[2]).replace(
      /^"+|"+$/g,
      ""
    ),
  }
}

type BackupTemplateRecipientAggregate = {
  total: number
  sendable: number
  missing: number
  ambiguous: number
  allTemplatesSendable: boolean
}

type BackupProjectionRecipientState = {
  contactsById: Map<
    string,
    {
      address: string
      displayName: string
    }
  >
  groupsById: Map<
    string,
    {
      alias: string
      address: string
      displayName: string
    }
  >
  contactSourceIds: Set<string>
  groupSourceIds: Set<string>
}

function buildBackupProjectionRecipientState(
  projection: Record<string, unknown>,
  data: Record<string, unknown>
): BackupProjectionRecipientState {
  const projectionContacts = requireArray(
    projection.contacts,
    "Backup latest Exchange projection contacts"
  )
  const projectionGroups = requireArray(
    projection.groups,
    "Backup latest Exchange projection groups"
  )
  const sharedContactsById = new Map<string, Record<string, unknown>>()
  for (const [index, value] of requireArray(
    data.sharedAddressbookContacts,
    "Backup shared address-book contacts"
  ).entries()) {
    const row = asRecord(value, `Backup shared address-book contact ${index}`)
    const id = cleanBackupRecipientText(row.id)
    if (!id || sharedContactsById.has(id)) {
      throw new Error("Latest backup contains an invalid shared contact identity.")
    }
    sharedContactsById.set(id, row)
  }
  const sharedGroupsById = new Map<string, Record<string, unknown>>()
  for (const [index, value] of requireArray(
    data.sharedAddressbookGroups,
    "Backup shared address-book groups"
  ).entries()) {
    const row = asRecord(value, `Backup shared address-book group ${index}`)
    const id = cleanBackupRecipientText(row.id)
    if (!id || sharedGroupsById.has(id)) {
      throw new Error("Latest backup contains an invalid shared group identity.")
    }
    sharedGroupsById.set(id, row)
  }

  const contactsById: BackupProjectionRecipientState["contactsById"] =
    new Map()
  const groupsById: BackupProjectionRecipientState["groupsById"] = new Map()
  const contactSourceIds = new Set<string>()
  const groupSourceIds = new Set<string>()
  const emailPattern = /^[^@\s]+@[^@\s]+$/
  const aliasPattern = /^[a-z0-9._-]{1,64}$/

  for (const [index, value] of projectionContacts.entries()) {
    const contact = asRecord(
      value,
      `Backup latest Exchange projection contact ${index}`
    )
    const sourceId = cleanBackupRecipientText(contact.sourceContactId)
    const rawAddress = cleanBackupRecipientText(contact.externalEmailAddress)
    const address = rawAddress.toLowerCase()
    if (!sourceId || contactSourceIds.has(sourceId)) {
      throw new Error(
        "Latest backup Exchange projection contains a missing or duplicate contact identity."
      )
    }
    contactSourceIds.add(sourceId)
    if (
      !emailPattern.test(address) ||
      rawAddress !== address
    ) {
      throw new Error(
        "Latest backup Exchange projection contains an unusable contact identity."
      )
    }
    const shared = sharedContactsById.get(sourceId)
    if (
      !shared ||
      cleanBackupRecipientText(shared.primary_email).toLowerCase() !== address
    ) {
      throw new Error(
        `Latest backup projected contact ${sourceId} does not match its source row.`
      )
    }
    contactsById.set(sourceId, {
      address,
      displayName: cleanBackupRecipientText(
        contact.displayName ||
          contact.directoryName ||
          shared.display_name ||
          shared.nickname ||
          address
      ),
    })
  }

  for (const [index, value] of projectionGroups.entries()) {
    const group = asRecord(
      value,
      `Backup latest Exchange projection group ${index}`
    )
    const sourceId = cleanBackupRecipientText(group.sourceGroupId)
    const rawAlias = cleanBackupRecipientText(group.alias)
    const alias = rawAlias.toLowerCase()
    const rawAddress = cleanBackupRecipientText(group.smtpAddress)
    const address = rawAddress.toLowerCase()
    const memberCount = Number(group.memberCount)
    if (!sourceId || groupSourceIds.has(sourceId)) {
      throw new Error(
        "Latest backup Exchange projection contains a missing or duplicate group identity."
      )
    }
    groupSourceIds.add(sourceId)
    if (
      rawAlias !== alias ||
      !aliasPattern.test(alias) ||
      rawAddress !== address ||
      !emailPattern.test(address) ||
      address.slice(0, address.lastIndexOf("@")) !== alias ||
      !Number.isSafeInteger(memberCount) ||
      memberCount < 0
    ) {
      throw new Error(
        "Latest backup Exchange projection contains an unusable group identity."
      )
    }
    const shared = sharedGroupsById.get(sourceId)
    if (
      !shared ||
      Number(shared.member_count) !== memberCount ||
      cleanBackupRecipientText(shared.name) !==
        cleanBackupRecipientText(group.groupName)
    ) {
      throw new Error(
        `Latest backup projected group ${sourceId} does not match its source row.`
      )
    }
    if (memberCount > 0) {
      groupsById.set(sourceId, {
        alias,
        address,
        displayName: cleanBackupRecipientText(
          group.groupName ||
            group.directoryName ||
            shared.name ||
            shared.nickname ||
            alias
        ),
      })
    }
  }

  return { contactsById, groupsById, contactSourceIds, groupSourceIds }
}

function verifyBackupTemplateRecipientVerifier(
  value: unknown,
  checkpoint: Record<string, unknown>,
  aggregate: BackupTemplateRecipientAggregate,
  label: string
) {
  const verification = asRecord(value, label)
  const expectedTemplateCounts = {
    total: aggregate.total,
    unresolved: 0,
    stale: 0,
    invalidShape: 0,
    withMissingRecipients: aggregate.missing,
    withAmbiguousRecipients: aggregate.ambiguous,
    sendable: aggregate.sendable,
  }
  if (
    verification.schema !== OUTLOOK_TEMPLATE_TRUTH_SCHEMA ||
    verification.valid !== true ||
    verification.sourceTruthValid !== true ||
    verification.allTemplatesSendable !== aggregate.allTemplatesSendable ||
    verification.certificationRunId !== checkpoint.latestCertificationRunId ||
    verification.certifiedAt !== checkpoint.latestCertificationAt ||
    verification.sourceFingerprint !== checkpoint.latestSourceFingerprint ||
    !exactRecordValues(verification.templates, expectedTemplateCounts)
  ) {
    throw new Error(`${label} does not match the exported Outlook templates.`)
  }
  const queue = asRecord(verification.queue, `${label} Exchange queue`)
  if (
    !["pending", "processing", "failed", "terminalFailed"].every(
      (key) => Number.isSafeInteger(queue[key]) && queue[key] === 0
    )
  ) {
    throw new Error(`${label} was not captured against a settled Exchange queue.`)
  }

  return {
    certificationRunId: String(checkpoint.latestCertificationRunId || ""),
    certifiedAt: String(checkpoint.latestCertificationAt || ""),
    sourceFingerprint: String(checkpoint.latestSourceFingerprint || ""),
    total: aggregate.total,
    sendable: aggregate.sendable,
    missing: aggregate.missing,
    ambiguous: aggregate.ambiguous,
    unresolved: 0,
    stale: 0,
    invalidShape: 0,
    allTemplatesSendable: aggregate.allTemplatesSendable,
  }
}

function verifyBackupTemplateRecipientTruth(
  data: Record<string, unknown>,
  truth: Record<string, unknown>,
  latestCertification: Record<string, unknown>,
  latestProjectionSnapshot: Record<string, unknown>,
  checkpointBefore: Record<string, unknown>,
  checkpointAfter: Record<string, unknown>,
  migrationHead: string
) {
  const projection = asRecord(
    JSON.parse(String(latestProjectionSnapshot.canonical_json || "")),
    "Backup latest Exchange projection"
  )
  const projectionState = buildBackupProjectionRecipientState(projection, data)
  const currentRunId = String(checkpointAfter.latestCertificationRunId || "")
  const currentCertifiedAt = String(
    checkpointAfter.latestCertificationAt || ""
  )
  const currentFingerprint = String(
    checkpointAfter.latestSourceFingerprint || ""
  )
  if (
    currentRunId !== String(latestCertification.run_id || "") ||
    currentFingerprint !== String(latestCertification.source_fingerprint || "") ||
    !sameTimestamp(currentCertifiedAt, latestCertification.certified_at)
  ) {
    throw new Error(
      "Latest backup Outlook template truth is not anchored to its exported certification."
    )
  }

  const aggregate: BackupTemplateRecipientAggregate = {
    total: 0,
    sendable: 0,
    missing: 0,
    ambiguous: 0,
    allTemplatesSendable: true,
  }
  const resolutionKeys = [
    "schema",
    "certificationRunId",
    "certifiedAt",
    "sourceFingerprint",
    "resolvedAt",
    "refs",
    "counts",
  ]
  const refKeys = [
    "field",
    "position",
    "literal",
    "displayName",
    "sourceValue",
    "kind",
    "sourceId",
    "resolvedAddress",
    "status",
  ]
  const fieldColumns = {
    to: "to_recipients",
    cc: "cc_recipients",
    bcc: "bcc_recipients",
  } as const
  const emailPattern = /^[^@\s]+@[^@\s]+$/
  const templates = requireArray(
    data.emailTemplates,
    "Backup Outlook email templates"
  )

  for (const [templateIndex, value] of templates.entries()) {
    const template = asRecord(value, `Backup Outlook template ${templateIndex}`)
    const templateId =
      cleanBackupRecipientText(template.id) || String(templateIndex)
    const label = `Backup Outlook template ${templateId} recipient evidence`
    const resolution = asRecord(template.recipient_resolution, label)
    aggregate.total += 1
    let templateMissing = false
    let templateAmbiguous = false

    const allowedResolutionKeys = Object.prototype.hasOwnProperty.call(
      resolution,
      "reconciliationRequired"
    )
      ? [...resolutionKeys, "reconciliationRequired"]
      : resolutionKeys
    if (
      !hasExactKeySet(resolution, allowedResolutionKeys) ||
      (Object.prototype.hasOwnProperty.call(
        resolution,
        "reconciliationRequired"
      ) &&
        resolution.reconciliationRequired !== false) ||
      resolution.schema !== OUTLOOK_TEMPLATE_RESOLUTION_SCHEMA ||
      resolution.certificationRunId !== currentRunId ||
      String(resolution.sourceFingerprint || "").toLowerCase() !==
        currentFingerprint ||
      !sameTimestamp(resolution.certifiedAt, currentCertifiedAt)
    ) {
      throw new Error(`${label} does not use the current certification anchor.`)
    }
    const resolvedAt = String(resolution.resolvedAt || "")
    if (!resolvedAt || Number.isNaN(Date.parse(resolvedAt))) {
      throw new Error(`${label} has an invalid resolution timestamp.`)
    }

    const refs = asRecord(resolution.refs, `${label} refs`)
    const recordedCounts = asRecord(resolution.counts, `${label} counts`)
    if (
      !hasExactKeySet(refs, ["to", "cc", "bcc"]) ||
      !hasExactKeySet(recordedCounts, [
        "total",
        "resolved",
        "external",
        "ambiguous",
        "missing",
      ])
    ) {
      throw new Error(`${label} has an invalid refs/counts shape.`)
    }
    const actualCounts: Record<
      "total" | "resolved" | "external" | "ambiguous" | "missing",
      number
    > = {
      total: 0,
      resolved: 0,
      external: 0,
      ambiguous: 0,
      missing: 0,
    }

    for (const [field, column] of Object.entries(fieldColumns) as Array<
      ["to" | "cc" | "bcc", "to_recipients" | "cc_recipients" | "bcc_recipients"]
    >) {
      const literals = splitBackupOutlookRecipientText(template[column])
      const fieldRefs = requireArray(refs[field], `${label} ${field} refs`)
      if (fieldRefs.length !== literals.length) {
        throw new Error(`${label} ${field} refs do not match the raw recipients.`)
      }

      for (const [position, valueRef] of fieldRefs.entries()) {
        const ref = asRecord(
          valueRef,
          `${label} ${field} recipient ${position}`
        )
        const refLabel = `${label} ${field} recipient ${position}`
        const literal = literals[position]
        const parsed = parseBackupOutlookRecipientLiteral(literal)
        if (
          !hasExactKeySet(ref, refKeys) ||
          ref.field !== field ||
          ref.position !== position ||
          ref.literal !== literal ||
          ref.sourceValue !== parsed.sourceValue ||
          typeof ref.displayName !== "string"
        ) {
          throw new Error(`${refLabel} does not match its raw literal.`)
        }
        const status = String(ref.status || "") as
          | "resolved"
          | "external"
          | "ambiguous"
          | "missing"
        if (
          !["resolved", "external", "ambiguous", "missing"].includes(status)
        ) {
          throw new Error(`${refLabel} has an unsupported status.`)
        }
        actualCounts.total += 1
        actualCounts[status] += 1
        if (status === "missing") templateMissing = true
        if (status === "ambiguous") templateAmbiguous = true

        if (status === "resolved") {
          const kind = String(ref.kind || "")
          const sourceId =
            typeof ref.sourceId === "string" ? ref.sourceId.trim() : ""
          const resolvedAddress =
            typeof ref.resolvedAddress === "string"
              ? ref.resolvedAddress
              : ""
          if (
            !["contact", "group"].includes(kind) ||
            !sourceId ||
            ref.sourceId !== sourceId ||
            !emailPattern.test(resolvedAddress) ||
            resolvedAddress !== resolvedAddress.toLowerCase()
          ) {
            throw new Error(`${refLabel} has an invalid resolved identity.`)
          }
          const candidate =
            kind === "contact"
              ? projectionState.contactsById.get(sourceId)
              : projectionState.groupsById.get(sourceId)
          if (!candidate) {
            throw new Error(
              `${refLabel} source identity is absent from the latest projection.`
            )
          }
          if (kind === "contact") {
            if (
              !("address" in candidate) ||
              resolvedAddress !== candidate.address
            ) {
              throw new Error(
                `${refLabel} contact address is not projection-exact.`
              )
            }
          } else {
            if (
              !("alias" in candidate) ||
              !("address" in candidate) ||
              resolvedAddress !== candidate.address
            ) {
              throw new Error(
                `${refLabel} group address is not projection-exact.`
              )
            }
          }
          if (
            ref.displayName !== parsed.displayName &&
            ref.displayName !== candidate.displayName
          ) {
            throw new Error(
              `${refLabel} display name is not literal- or projection-derived.`
            )
          }
        } else if (status === "external") {
          if (
            ref.kind !== "external" ||
            ref.sourceId !== null ||
            !emailPattern.test(parsed.sourceValue) ||
            ref.resolvedAddress !== parsed.sourceValue.toLowerCase() ||
            ref.displayName !== parsed.displayName
          ) {
            throw new Error(`${refLabel} external evidence is inconsistent.`)
          }
        } else if (status === "ambiguous") {
          const explicitAddress = parsed.sourceValue.includes("@")
          if (
            ref.kind !== "unresolved" ||
            ref.sourceId !== null ||
            ref.displayName !== parsed.displayName ||
            ref.resolvedAddress !==
              (explicitAddress ? parsed.sourceValue.toLowerCase() : null) ||
            (explicitAddress && !emailPattern.test(parsed.sourceValue))
          ) {
            throw new Error(`${refLabel} ambiguous evidence is inconsistent.`)
          }
        } else {
          const unresolvedMissing =
            ref.kind === "unresolved" &&
            ref.sourceId === null &&
            !parsed.sourceValue.includes("@") &&
            ref.displayName === parsed.displayName
          const retainedSourceId =
            typeof ref.sourceId === "string" &&
            ref.sourceId === ref.sourceId.trim() &&
            ref.sourceId.length > 0
              ? ref.sourceId
              : ""
          const retainedMissing =
            migrationHead >=
              OUTLOOK_TEMPLATE_STABLE_MISSING_MIGRATION_HEAD &&
            ["contact", "group"].includes(String(ref.kind || "")) &&
            Boolean(retainedSourceId) &&
            !(ref.kind === "contact"
              ? projectionState.contactSourceIds.has(retainedSourceId)
              : projectionState.groupSourceIds.has(retainedSourceId))
          if (
            ref.resolvedAddress !== null ||
            (!unresolvedMissing && !retainedMissing)
          ) {
            throw new Error(`${refLabel} missing evidence is inconsistent.`)
          }
        }
      }
    }

    const expectedCounts = {
      total: actualCounts.total,
      resolved: actualCounts.resolved,
      external: actualCounts.external,
      ambiguous: actualCounts.ambiguous,
      missing: actualCounts.missing,
    }
    if (
      actualCounts.total > 10000 ||
      !Object.values(recordedCounts).every(
        (count) =>
          Number.isSafeInteger(count) &&
          Number(count) >= 0 &&
          Number(count) <= 10000
      ) ||
      !exactRecordValues(recordedCounts, expectedCounts)
    ) {
      throw new Error(`${label} counts do not match its recipient refs.`)
    }
    if (templateMissing) aggregate.missing += 1
    if (templateAmbiguous) aggregate.ambiguous += 1
    if (!templateMissing && !templateAmbiguous) aggregate.sendable += 1
  }

  aggregate.allTemplatesSendable =
    aggregate.missing === 0 && aggregate.ambiguous === 0

  const normalizedBefore = verifyBackupTemplateRecipientVerifier(
    truth.templateRecipientVerificationBeforeExport,
    checkpointBefore,
    aggregate,
    "Backup Outlook template verifier before export"
  )
  const normalizedAfter = verifyBackupTemplateRecipientVerifier(
    truth.templateRecipientVerificationAfterExport,
    checkpointAfter,
    aggregate,
    "Backup Outlook template verifier after export"
  )
  if (
    JSON.stringify(normalizedBefore) !== JSON.stringify(normalizedAfter) ||
    !exactRecordValues(truth.templateRecipientTruth, normalizedAfter)
  ) {
    throw new Error(
      "Latest backup Outlook template recipient truth changed during export."
    )
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
  const inventoryUnfencedTables = requireSortedUniqueStrings(
    inventory.unfencedTables,
    "Live mutation-unfenced backup tables"
  )
  const unfencedTables = inventoryUnfencedTables.filter(
    (table) => !BACKUP_EPHEMERAL_TABLES.includes(table)
  )
  const catalogSha256 = requireSha256(
    inventory.catalogSha256,
    "Live backup database catalog SHA-256"
  )
  const missingRequired = BACKUP_REQUIRED_LIVE_TABLES.filter(
    (table) => !liveTables.includes(table)
  )
  const unregistered = liveTables.filter(
    (table) => !BACKUP_REGISTERED_TABLES.includes(table)
  )
  if (
    missingRequired.length ||
    unregistered.length ||
    unfencedTables.length
  ) {
    throw new Error(
      `Live database is outside the backup table contract: missing=${missingRequired.join(",") || "none"}; unregistered=${unregistered.join(",") || "none"}; unfenced=${unfencedTables.join(",") || "none"}.`
    )
  }
  return { migrationHead, liveTables, catalogSha256 }
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

async function checkAttendanceSync(): Promise<HealthCheckResult> {
  const supabase = getSupabaseClient()
  const configured = Boolean(
    process.env.DINGTALK_CLIENT_ID && process.env.DINGTALK_CLIENT_SECRET
  )
  const [
    activeResponse,
    mappedResponse,
    currentGroupResponse,
    latestResponse,
  ] = await Promise.all([
    supabase
      .from("attendance_people")
      .select("id", { count: "exact", head: true })
      .eq("is_active", true),
    supabase
      .from("attendance_people")
      .select("id", { count: "exact", head: true })
      .eq("is_active", true)
      .not("dingtalk_user_id", "is", null),
    supabase
      .from("attendance_team_assignments")
      .select("person_id", { count: "exact", head: true })
      .is("effective_to", null),
    supabase
      .from("attendance_sync_runs")
      .select(
        "started_at,completed_at,status,window_from,window_to,people_requested,records_fetched,records_inserted,error_summary"
      )
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ])

  if (activeResponse.error) throw activeResponse.error
  if (mappedResponse.error) throw mappedResponse.error
  if (currentGroupResponse.error) throw currentGroupResponse.error
  if (latestResponse.error) throw latestResponse.error

  const activePeople = activeResponse.count || 0
  const mappedPeople = mappedResponse.count || 0
  const currentGroupAssignments = currentGroupResponse.count || 0
  const latest = latestResponse.data
  const startedAt = latest?.started_at ? Date.parse(latest.started_at) : 0
  const ageMinutes = startedAt
    ? Math.max(0, Math.round((Date.now() - startedAt) / 60_000))
    : null
  const stale = ageMinutes !== null && ageMinutes > 60
  const incompleteMappings = mappedPeople < activePeople
  const latestStatus = String(latest?.status || "never")
  const unhealthyRun = ["failed", "partial"].includes(latestStatus)

  const warnings: string[] = []
  if (!configured) warnings.push("DingTalk credentials are not configured")
  if (!activePeople) warnings.push("no active attendance people are configured")
  if (incompleteMappings) {
    warnings.push(`${activePeople - mappedPeople} active people need a DingTalk user mapping`)
  }
  if (currentGroupAssignments !== activePeople) {
    warnings.push("active attendance people and current group history do not match")
  }
  if (configured && mappedPeople && !latest) warnings.push("the automatic sync has not run yet")
  if (stale) warnings.push("the latest automatic sync is older than one hour")
  if (unhealthyRun) warnings.push(`the latest automatic sync is ${latestStatus}`)

  return {
    status: warnings.length ? "warning" : "ok",
    message: warnings.length
      ? `Attendance sync needs attention: ${warnings.join("; ")}`
      : "Attendance sync is configured, current, and covers every active mapped person",
    details: {
      configured,
      activePeople,
      mappedPeople,
      currentGroupAssignments,
      latestStatus,
      latestStartedAt: latest?.started_at || null,
      latestCompletedAt: latest?.completed_at || null,
      latestWindowFrom: latest?.window_from || null,
      latestWindowTo: latest?.window_to || null,
      latestPeopleRequested: latest?.people_requested || 0,
      latestRecordsFetched: latest?.records_fetched || 0,
      latestRecordsInserted: latest?.records_inserted || 0,
      latestError: latest?.error_summary || null,
      ageMinutes,
    },
  }
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

async function readDriveFileDigest(
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
  for await (const chunk of response.data as AsyncIterable<Uint8Array | string>) {
    hasher.update(chunk)
    fileByteLength +=
      typeof chunk === "string"
        ? Buffer.byteLength(chunk, "utf8")
        : chunk.byteLength
    if (!Number.isSafeInteger(fileByteLength)) {
      throw new Error("Drive backup byte length exceeds the safe integer range.")
    }
  }
  return {
    uploadedFileSha256: hasher.digest("hex"),
    fileByteLength,
  }
}

function requireStreamBackupProperties(
  file: drive_v3.Schema$File,
  label: string
) {
  const properties = file.appProperties
  if (!properties) {
    throw new Error(`${label} has no Drive verification metadata.`)
  }
  for (const key of BACKUP_STREAM_REQUIRED_PROPERTIES) {
    if (
      !Object.prototype.hasOwnProperty.call(properties, key) ||
      typeof properties[key] !== "string" ||
      !properties[key]
    ) {
      throw new Error(`${label} is missing Drive verification property ${key}.`)
    }
  }
  return properties
}

function requireCanonicalAppPropertyInteger(
  value: string,
  label: string,
  { positive = false }: { positive?: boolean } = {}
) {
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new Error(`${label} is not a canonical non-negative integer.`)
  }
  const parsed = Number(value)
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 0 ||
    (positive && parsed < 1)
  ) {
    throw new Error(
      positive
        ? `${label} must be a positive safe integer.`
        : `${label} is not a non-negative safe integer.`
    )
  }
  return parsed
}

function requireTimestamp(value: string, label: string) {
  if (!value || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} is not a valid timestamp.`)
  }
  return value
}

function requireUuidV4(value: string, label: string) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value
    )
  ) {
    throw new Error(`${label} is not a version-4 UUID.`)
  }
  return value
}

function parseStreamedBackupPredecessor(
  properties: Record<string, string>,
  generatedAt: string,
  label: string
) {
  const values = [
    properties.previousFileId,
    properties.previousFileName,
    properties.previousCreatedTime,
    properties.previousArtifactSha256,
    properties.previousUploadedFileSha256,
  ]
  if (values.every((value) => value === "none")) return null
  if (values.some((value) => value === "none")) {
    throw new Error(`${label} has an incomplete previous-backup chain anchor.`)
  }

  const fileId = properties.previousFileId
  const name = properties.previousFileName
  const createdTime = requireTimestamp(
    properties.previousCreatedTime,
    `${label} previous-backup creation time`
  )
  const artifactSha256 = requireSha256(
    properties.previousArtifactSha256,
    `${label} previous-backup artifact SHA-256`
  )
  const uploadedFileSha256 = requireSha256(
    properties.previousUploadedFileSha256,
    `${label} previous-backup uploaded-file SHA-256`
  )
  if (
    !fileId ||
    !BACKUP_FILE_NAME_PATTERN.test(name) ||
    Date.parse(createdTime) >= Date.parse(generatedAt)
  ) {
    throw new Error(`${label} has an invalid previous-backup chain anchor.`)
  }

  return {
    fileId,
    name,
    createdTime,
    artifactSha256,
    uploadedFileSha256,
  }
}

async function verifyStreamedBackupFile(
  drive: drive_v3.Drive,
  file: drive_v3.Schema$File,
  label: string
) {
  if (!file.id) throw new Error(`${label} is missing its Drive file id.`)
  const properties = requireStreamBackupProperties(file, label)
  if (
    properties.backupSchema !== BACKUP_FILE_SCHEMA ||
    properties.verificationContract !== BACKUP_STREAM_VERIFICATION_SCHEMA ||
    properties.verificationStatus !== "complete"
  ) {
    throw new Error(`${label} does not use the required streaming verification contract.`)
  }

  const artifactSha256 = requireSha256(
    properties.artifactSha256,
    `${label} artifact SHA-256`
  )
  const uploadedFileSha256 = requireSha256(
    properties.uploadedFileSha256,
    `${label} uploaded-file SHA-256`
  )
  const fileByteLength = requireCanonicalAppPropertyInteger(
    properties.fileByteLength,
    `${label} file byte length`,
    { positive: true }
  )
  const truthHeadSequence = requireCanonicalAppPropertyInteger(
    properties.truthHeadSequence,
    `${label} truth-head sequence`,
    { positive: true }
  )
  const truthHeadSha256 = requireSha256(
    properties.truthHeadSha256,
    `${label} truth-head SHA-256`
  )
  const migrationHead = properties.migrationHead
  if (
    !/^\d{14}$/.test(migrationHead) ||
    migrationHead < MINIMUM_BACKUP_MIGRATION_HEAD
  ) {
    throw new Error(`${label} predates the required v2 migration contract.`)
  }
  const databaseEpoch = requireCanonicalAppPropertyInteger(
    properties.databaseEpoch,
    `${label} database export epoch`
  )
  const inventorySha256 = requireSha256(
    properties.inventorySha256,
    `${label} database-inventory SHA-256`
  )
  const catalogSha256 = requireSha256(
    properties.catalogSha256,
    `${label} database-catalog SHA-256`
  )
  const liveTableCount = requireCanonicalAppPropertyInteger(
    properties.liveTableCount,
    `${label} live-table count`,
    { positive: true }
  )
  const sectionCount = requireCanonicalAppPropertyInteger(
    properties.sectionCount,
    `${label} section count`,
    { positive: true }
  )
  const totalRecordCount = requireCanonicalAppPropertyInteger(
    properties.totalRecordCount,
    `${label} total-record count`
  )
  const backupRunId = requireUuidV4(
    properties.backupRunId,
    `${label} backup run ID`
  )
  const generatedAt = requireTimestamp(
    properties.generatedAt,
    `${label} generated timestamp`
  )
  const deploymentCommit =
    properties.deploymentCommit === "none"
      ? ""
      : properties.deploymentCommit
  if (
    deploymentCommit &&
    !/^[0-9a-f]{7,64}$/i.test(deploymentCommit)
  ) {
    throw new Error(`${label} has invalid deployment provenance.`)
  }
  const source = properties.source
  if (!["vercel-cron", "admin-manual"].includes(source)) {
    throw new Error(`${label} has invalid source provenance.`)
  }
  const latestCertificationRunId = requireUuidV4(
    properties.latestCertificationRunId,
    `${label} latest Exchange certification run ID`
  )
  const latestProjectionSnapshotSha256 = requireSha256(
    properties.latestProjectionSnapshotSha256,
    `${label} latest Exchange projection snapshot SHA-256`
  )

  const backupContract = getBackupArtifactContract(migrationHead)
  if (
    sectionCount !== backupContract.requiredDataKeys.length ||
    liveTableCount < backupContract.requiredLiveTables.length ||
    liveTableCount > backupContract.registeredTables.length
  ) {
    throw new Error(`${label} metadata does not match the backup inventory contract.`)
  }

  const previousVerifiedBackup = parseStreamedBackupPredecessor(
    properties,
    generatedAt,
    label
  )
  const downloaded = await readDriveFileDigest(drive, file.id)
  if (
    downloaded.uploadedFileSha256 !== uploadedFileSha256 ||
    downloaded.fileByteLength !== fileByteLength
  ) {
    throw new Error(`${label} bytes do not match its Drive verification metadata.`)
  }

  return {
    artifactSha256,
    uploadedFileSha256,
    fileByteLength,
    truthHeadSequence: String(truthHeadSequence),
    truthHeadSha256,
    sectionCount,
    migrationHead,
    databaseEpoch,
    deploymentCommit,
    backupRunId,
    generatedAt,
    source,
    requestedBy:
      source === "vercel-cron"
        ? "Vercel Cron"
        : "Authenticated administrator",
    warningCount: 0,
    liveTableCount,
    liveTables: [] as string[],
    latestCertificationRunId,
    latestProjectionSnapshotSha256,
    previousVerifiedBackup,
    previousBackupAnchored: previousVerifiedBackup !== null,
    verificationContract: BACKUP_STREAM_VERIFICATION_SCHEMA,
    inventorySha256,
    catalogSha256,
    totalRecordCount,
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
  const backupContract = getBackupArtifactContract(migrationHead)
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
    !sameStringSet(registeredTables, backupContract.registeredTables) ||
    !sameStringSet(ephemeralTables, BACKUP_EPHEMERAL_TABLES) ||
    !sameStringSet(
      excludedCredentialFields,
      BACKUP_EXCLUDED_CREDENTIAL_FIELDS
    ) ||
    backupContract.requiredLiveTables.some(
      (table) => !liveTables.includes(table)
    ) ||
    liveTables.some((table) => !backupContract.registeredTables.includes(table))
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
    !sameStringSet(dataKeys, backupContract.requiredDataKeys) ||
    !sameStringSet(countKeys, backupContract.requiredSectionKeys) ||
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
  for (const [index, row] of requireArray(
    data.auditLogs,
    "Backup audit logs"
  ).entries()) {
    const record = asRecord(row, `Backup audit log row ${index}`)
    if (!["admin_users", "spc_users"].includes(String(record.table_name || ""))) {
      continue
    }
    for (const snapshotKey of ["before_row", "after_row"] as const) {
      if (!record[snapshotKey]) continue
      const snapshot = asRecord(
        record[snapshotKey],
        `Backup audit log row ${index}.${snapshotKey}`
      )
      if (Object.prototype.hasOwnProperty.call(snapshot, "password_hash")) {
        throw new Error(
          `Latest backup exposes auditLogs.${snapshotKey}.password_hash.`
        )
      }
    }
    if (
      Array.isArray(record.changed_fields) &&
      record.changed_fields.includes("password_hash")
    ) {
      throw new Error("Latest backup exposes auditLogs.changed_fields.password_hash.")
    }
  }

  const truth = asRecord(integrity.truth, "Backup truth checkpoint")
  const requiresTemplateRecipientTruth =
    migrationHead >= OUTLOOK_TEMPLATE_TRUTH_MIGRATION_HEAD
  requireExactKeys(
    truth,
    [
      "schema",
      "verificationBeforeExport",
      "checkpointBeforeExport",
      "checkpointAfterExport",
      "verificationAfterExport",
      ...(requiresTemplateRecipientTruth
        ? [
            "templateRecipientVerificationBeforeExport",
            "templateRecipientVerificationAfterExport",
            "templateRecipientTruth",
          ]
        : []),
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
  if (requiresTemplateRecipientTruth) {
    const latestProjectionSnapshot = snapshotsByHash.get(
      latestSourceFingerprint
    )
    if (
      !latestProjectionSnapshot ||
      latestProjectionSnapshot.snapshot_kind !== "fcuno_exchange_projection" ||
      latestProjectionSnapshot.schema_version !== 1
    ) {
      throw new Error(
        "Latest backup Outlook template truth has no exact Exchange projection snapshot."
      )
    }
    verifyBackupTemplateRecipientTruth(
      data,
      truth,
      latestCertification,
      latestProjectionSnapshot,
      checkpointBefore,
      checkpointAfter,
      migrationHead
    )
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

  let verified:
    | ReturnType<typeof verifyBackupArtifact>
    | Awaited<ReturnType<typeof verifyStreamedBackupFile>>
  try {
    const verificationContract =
      latest.appProperties?.verificationContract || ""
    if (
      verificationContract &&
      verificationContract !== BACKUP_STREAM_VERIFICATION_SCHEMA
    ) {
      throw new Error(
        `Latest backup uses unsupported verification contract ${verificationContract}.`
      )
    }

    if (verificationContract === BACKUP_STREAM_VERIFICATION_SCHEMA) {
      const streamVerified = await verifyStreamedBackupFile(
        drive,
        latest,
        "Latest backup"
      )
      if (
        Date.parse(streamVerified.generatedAt) >
        Date.parse(String(latest.createdTime || ""))
      ) {
        throw new Error("Latest backup was generated after its Drive creation time.")
      }

      const expectedPredecessor = verifiedCandidates[1] || null
      const predecessorAnchor = streamVerified.previousVerifiedBackup
      if (!predecessorAnchor) {
        if (expectedPredecessor) {
          throw new Error(
            "Latest backup is missing its immediate verified predecessor anchor."
          )
        }
      } else {
        if (
          !expectedPredecessor?.id ||
          expectedPredecessor.id !== predecessorAnchor.fileId
        ) {
          throw new Error(
            "Latest backup does not anchor the immediate preceding verified file."
          )
        }
        if (
          expectedPredecessor.name !== predecessorAnchor.name ||
          (expectedPredecessor.createdTime || null) !==
            predecessorAnchor.createdTime ||
          expectedPredecessor.appProperties?.artifactSha256 !==
            predecessorAnchor.artifactSha256 ||
          expectedPredecessor.appProperties?.uploadedFileSha256 !==
            predecessorAnchor.uploadedFileSha256
        ) {
          throw new Error(
            "Latest backup predecessor anchor does not match Drive metadata."
          )
        }
        const predecessorContract =
          expectedPredecessor.appProperties?.verificationContract || ""
        if (
          predecessorContract &&
          predecessorContract !== BACKUP_STREAM_VERIFICATION_SCHEMA
        ) {
          throw new Error(
            `Latest backup predecessor uses unsupported verification contract ${predecessorContract}.`
          )
        }
        let predecessorVerified:
          | Awaited<ReturnType<typeof verifyStreamedBackupFile>>
          | ReturnType<typeof verifyBackupArtifact>
        if (predecessorContract === BACKUP_STREAM_VERIFICATION_SCHEMA) {
          predecessorVerified = await verifyStreamedBackupFile(
            drive,
            expectedPredecessor,
            "Latest backup predecessor"
          )
        } else {
          const predecessorDownload = await readDriveJsonFile(
            drive,
            expectedPredecessor.id
          )
          predecessorVerified = verifyBackupArtifact(
            predecessorDownload.value,
            predecessorDownload.bytes,
            expectedPredecessor.appProperties
          )
        }
        if (
          predecessorVerified.artifactSha256 !==
            predecessorAnchor.artifactSha256 ||
          predecessorVerified.uploadedFileSha256 !==
            predecessorAnchor.uploadedFileSha256 ||
          Date.parse(predecessorVerified.generatedAt) >
            Date.parse(String(expectedPredecessor.createdTime || "")) ||
          Date.parse(predecessorVerified.generatedAt) >=
            Date.parse(streamVerified.generatedAt)
        ) {
          throw new Error(
            "Latest backup predecessor bytes do not match the chain anchor."
          )
        }
      }
      verified = streamVerified
    } else {
      const downloaded = await readDriveJsonFile(drive, latest.id)
      const legacyVerified = verifyBackupArtifact(
        downloaded.value,
        downloaded.bytes,
        latest.appProperties
      )
      if (
        Date.parse(legacyVerified.generatedAt) >
        Date.parse(String(latest.createdTime || ""))
      ) {
        throw new Error("Latest backup was generated after its Drive creation time.")
      }

      const expectedPredecessor = verifiedCandidates[1] || null
      const predecessorAnchor = legacyVerified.previousVerifiedBackup
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
            Date.parse(legacyVerified.generatedAt)
        ) {
          throw new Error(
            "Latest backup predecessor bytes do not match the chain anchor."
          )
        }
      }
      verified = legacyVerified
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
  const currentInventorySha256 = sha256(
    JSON.stringify([...currentInventory.liveTables].sort())
  )
  const databaseInventoryCurrent =
    verified.migrationHead === currentInventory.migrationHead &&
    ("verificationContract" in verified
      ? verified.verificationContract ===
          BACKUP_STREAM_VERIFICATION_SCHEMA &&
        verified.inventorySha256 === currentInventorySha256 &&
        verified.catalogSha256 === currentInventory.catalogSha256 &&
        verified.liveTableCount === currentInventory.liveTables.length
      : sameStringSet(verified.liveTables, currentInventory.liveTables))
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
      databaseEpoch:
        "databaseEpoch" in verified ? verified.databaseEpoch : null,
      catalogSha256:
        "catalogSha256" in verified ? verified.catalogSha256 : null,
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

async function checkOutlookTemplateRecipientTruth(): Promise<HealthCheckResult> {
  const supabase = getSupabaseClient()
  const { data, error } = await supabase.rpc(
    "verify_outlook_template_recipient_truth"
  )
  if (error) throw error

  const verification = asRecord(
    data,
    "Outlook template recipient verification"
  )
  const templates = asRecord(
    verification.templates,
    "Outlook template recipient counts"
  )
  const valid = verification.valid === true
  const missing = getNumber(templates.withMissingRecipients)
  const ambiguous = getNumber(templates.withAmbiguousRecipients)

  return {
    status: valid ? "ok" : "error",
    message: !valid
      ? "Outlook templates are not aligned with the latest certified Exchange projection"
      : "Outlook templates use the latest certified Exchange recipient projection; unresolved recipients remain visible as normal send blocks",
    details: {
      certificationRunId: String(verification.certificationRunId || ""),
      certifiedAt: String(verification.certifiedAt || ""),
      sourceFingerprint: String(verification.sourceFingerprint || ""),
      totalTemplates: getNumber(templates.total),
      sendableTemplates: getNumber(templates.sendable),
      unresolvedTemplates: getNumber(templates.unresolved),
      staleTemplates: getNumber(templates.stale),
      invalidShapeTemplates: getNumber(templates.invalidShape),
      templatesWithMissingRecipients: missing,
      templatesWithAmbiguousRecipients: ambiguous,
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
      attendanceSyncSchedule: "Every 15 minutes",
      hongKongTime: "Daily 03:00",
    },
  }
}

export async function getSystemHealth(): Promise<SystemHealth> {
  const checks = await Promise.all([
    runCheck("supabase", "Supabase", checkSupabase),
    runCheck("schema", "Optional Schema", checkOptionalSchema),
    runCheck("attendance-sync", "Attendance Sync", checkAttendanceSync),
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
    runCheck(
      "outlook-template-recipient-truth",
      "Outlook Template Recipient Truth",
      checkOutlookTemplateRecipientTruth
    ),
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
