import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

const backupPath = process.argv[2]
if (!backupPath) {
  console.error("Usage: npm run backup:validate -- /absolute/path/to/bunker-map-backup.json")
  process.exit(2)
}

const MINIMUM_V2_MIGRATION_HEAD = "20260723080326"
const OPENAI_USAGE_MIGRATION_HEAD = "20260723083832"
const OUTLOOK_TEMPLATE_TRUTH_MIGRATION_HEAD = "20260723124045"
const OUTLOOK_TEMPLATE_STABLE_MISSING_MIGRATION_HEAD = "20260723125759"
const ATTENDANCE_RECORD_MIGRATION_HEAD = "20260807094108"
const ATTENDANCE_MONTHLY_ROSTER_MIGRATION_HEAD = "20260810041413"
const BACKUP_INVENTORY_SCHEMA = "bunker-map.backup-inventory/v1"
const OUTLOOK_TEMPLATE_RESOLUTION_SCHEMA =
  "fcuno.outlook-template-recipient-resolution/v1"
const OUTLOOK_TEMPLATE_TRUTH_SCHEMA =
  "fcuno.outlook-template-recipient-truth/v2"

const TABLE_SECTIONS = [
  { key: "admins", table: "admins", primaryKey: ["id"] },
  { key: "adminUsers", table: "admin_users", primaryKey: ["id"] },
  {
    key: "adminRoleDefaults",
    table: "admin_role_defaults",
    primaryKey: ["role"],
    optionalTable: true,
  },
  { key: "auditLogs", table: "audit_logs", primaryKey: ["id"] },
  { key: "officeCalendarStore", table: "office_calendar_store", primaryKey: ["key"] },
  { key: "emailTemplates", table: "email_templates", primaryKey: ["id"] },
  {
    key: "sharedAddressbookContacts",
    table: "shared_addressbook_contacts",
    primaryKey: ["id"],
  },
  {
    key: "sharedAddressbookGroups",
    table: "shared_addressbook_groups",
    primaryKey: ["id"],
  },
  {
    key: "sharedAddressbookGroupMembers",
    table: "shared_addressbook_group_members",
    primaryKey: ["group_id", "contact_id"],
  },
  {
    key: "outlookExchangeSyncQueue",
    table: "outlook_exchange_sync_queue",
    primaryKey: ["id"],
  },
  { key: "phonebookContacts", table: "phonebook_contacts", primaryKey: ["id"] },
  { key: "phonebookCompanies", table: "phonebook_companies", primaryKey: ["id"] },
  { key: "ccCompanies", table: "cc_companies", primaryKey: ["id"] },
  { key: "ccCountries", table: "cc_countries", primaryKey: ["id"] },
  { key: "ccPorts", table: "cc_ports", primaryKey: ["id"] },
  { key: "ccDocuments", table: "cc_documents", primaryKey: ["id"] },
  { key: "ccCompanyFiles", table: "cc_company_files", primaryKey: ["id"] },
  { key: "ccEntryFiles", table: "cc_entry_files", primaryKey: ["id"] },
  { key: "ccEntryFolders", table: "cc_entry_folders", primaryKey: ["id"] },
  { key: "ports", table: "ports", primaryKey: ["id"] },
  { key: "remarks", table: "remarks", primaryKey: ["id"] },
  { key: "priceHistory", table: "price_history", primaryKey: ["id"] },
  {
    key: "whatsappConversations",
    table: "whatsapp_conversations",
    primaryKey: ["id"],
  },
  { key: "whatsappMessages", table: "whatsapp_messages", primaryKey: ["id"] },
  { key: "spcUsers", table: "spc_users", primaryKey: ["id"] },
  { key: "spcEnquiries", table: "spc_enquiries", primaryKey: ["id"] },
  { key: "spcFixtures", table: "spc_fixtures", primaryKey: ["id"] },
  { key: "spcSuppliers", table: "spc_suppliers", primaryKey: ["key"] },
  { key: "parserReports", table: "parser_reports", primaryKey: ["id"] },
  {
    key: "openAiUsageEvents",
    table: "openai_usage_events",
    primaryKey: ["id"],
    introducedAt: OPENAI_USAGE_MIGRATION_HEAD,
  },
  {
    key: "spcPresentationChunks",
    table: "spc_presentation_chunks",
    primaryKey: ["id"],
  },
  {
    key: "attendancePeople",
    table: "attendance_people",
    primaryKey: ["id"],
    introducedAt: ATTENDANCE_RECORD_MIGRATION_HEAD,
  },
  {
    key: "attendanceTeamAssignments",
    table: "attendance_team_assignments",
    primaryKey: ["id"],
    introducedAt: ATTENDANCE_MONTHLY_ROSTER_MIGRATION_HEAD,
  },
  {
    key: "attendanceRawPunches",
    table: "attendance_raw_punches",
    primaryKey: ["id"],
    introducedAt: ATTENDANCE_RECORD_MIGRATION_HEAD,
  },
  {
    key: "attendanceLeaveEntries",
    table: "attendance_leave_entries",
    primaryKey: ["id"],
    introducedAt: ATTENDANCE_RECORD_MIGRATION_HEAD,
  },
  {
    key: "attendanceManualOverrides",
    table: "attendance_manual_overrides",
    primaryKey: ["id"],
    introducedAt: ATTENDANCE_RECORD_MIGRATION_HEAD,
  },
  {
    key: "attendanceEntitlements",
    table: "attendance_entitlements",
    primaryKey: ["id"],
    introducedAt: ATTENDANCE_RECORD_MIGRATION_HEAD,
  },
  {
    key: "attendanceMonthlyAdjustments",
    table: "attendance_monthly_adjustments",
    primaryKey: ["id"],
    introducedAt: ATTENDANCE_RECORD_MIGRATION_HEAD,
  },
  {
    key: "attendanceMonthlyConfirmations",
    table: "attendance_monthly_confirmations",
    primaryKey: ["id"],
    introducedAt: ATTENDANCE_RECORD_MIGRATION_HEAD,
  },
  {
    key: "attendanceReminderDispatches",
    table: "attendance_reminder_dispatches",
    primaryKey: ["id"],
    introducedAt: ATTENDANCE_MONTHLY_ROSTER_MIGRATION_HEAD,
  },
  {
    key: "attendanceSyncRuns",
    table: "attendance_sync_runs",
    primaryKey: ["id"],
    introducedAt: ATTENDANCE_RECORD_MIGRATION_HEAD,
  },
]

const TRUTH_SECTIONS = [
  {
    key: "outlookExchangeSyncCertifications",
    table: "outlook_exchange_sync_certifications",
    primaryKey: ["run_id"],
  },
  {
    key: "outlookExchangeTruthSnapshots",
    table: "outlook_exchange_truth_snapshots",
    primaryKey: ["snapshot_sha256"],
  },
  {
    key: "outlookExchangeTruthLedger",
    table: "outlook_exchange_truth_ledger",
    primaryKey: ["ledger_sequence"],
  },
]

const EXTERNAL_SECTIONS = [
  { key: "googleContacts", primaryKey: ["resourceName"] },
  { key: "googleCalendarEvents", primaryKey: ["id"] },
]

const OPTIONAL_DATA_SECTIONS = ["googleCalendarMetadata"]
const TRUTH_MANAGED_TABLES = TRUTH_SECTIONS.map((section) => section.table)
const EXPLICITLY_EPHEMERAL_TABLES = [
  "admin_sessions",
  "bunker_map_backup_lock",
  "outlook_exchange_sync_lock",
  "spc_sessions",
]
const EXCLUDED_CREDENTIAL_FIELDS = [
  "admin_users.password_hash",
  "spc_users.password_hash",
]

function getBackupContract(migrationHead) {
  const tableSections = TABLE_SECTIONS.filter(
    (section) =>
      !section.introducedAt || migrationHead >= section.introducedAt
  )
  const sectionSpecs = [
    ...tableSections,
    ...TRUTH_SECTIONS,
    ...EXTERNAL_SECTIONS,
  ]
  const requiredSections = sectionSpecs.map((section) => section.key)
  const expectedDataSections = [
    ...requiredSections,
    ...OPTIONAL_DATA_SECTIONS,
  ]
  const expectedRegisteredTables = [
    ...tableSections.map((section) => section.table),
    ...TRUTH_MANAGED_TABLES,
    ...EXPLICITLY_EPHEMERAL_TABLES,
  ].sort()
  const requiredLiveTables = [
    ...tableSections
      .filter((section) => !section.optionalTable)
      .map((section) => section.table),
    ...TRUTH_MANAGED_TABLES,
    ...EXPLICITLY_EPHEMERAL_TABLES,
  ].sort()

  return {
    sectionSpecs,
    requiredSections,
    expectedDataSections,
    expectedRegisteredTables,
    requiredLiveTables,
  }
}

const TOP_LEVEL_KEYS = [
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
]

const SHA256_PATTERN = /^[0-9a-f]{64}$/
const BACKUP_FILE_NAME_PATTERN =
  /^bunker-map-backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.json$/

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

function rows(data, key) {
  return Array.isArray(data?.[key]) ? data[key] : []
}

function idSet(data, key) {
  return new Set(
    rows(data, key)
      .filter(isPlainObject)
      .map((row) => row.id)
      .filter(isPresentPrimaryKeyValue)
  )
}

function addError(errors, message) {
  if (!errors.includes(message)) errors.push(message)
}

function isPresentPrimaryKeyValue(value) {
  return value !== null && value !== undefined && value !== ""
}

function checkReferences(
  childRows,
  field,
  parentIds,
  label,
  errors,
  { required = false } = {}
) {
  let missingValues = 0
  let missingParents = 0
  for (const row of childRows) {
    if (!isPlainObject(row)) continue
    const value = row[field]
    if (!isPresentPrimaryKeyValue(value)) {
      if (required) missingValues += 1
      continue
    }
    if (!parentIds.has(value)) missingParents += 1
  }
  if (missingValues) {
    addError(errors, `${label}: ${missingValues} required reference value(s) are missing`)
  }
  if (missingParents) {
    addError(errors, `${label}: ${missingParents} missing parent reference(s)`)
  }
}

function checkDuplicateValues(values, label, errors) {
  const present = values.filter((value) => value !== null && value !== undefined && value !== "")
  const duplicates = present.length - new Set(present).size
  if (duplicates) addError(errors, `${label}: ${duplicates} duplicate value(s)`)
}

function checkSectionPrimaryKeys(data, section, errors) {
  const sectionRows = rows(data, section.key)
  const seen = new Set()
  let malformedRows = 0
  let missingKeys = 0
  let duplicateKeys = 0

  for (const row of sectionRows) {
    if (!isPlainObject(row)) {
      malformedRows += 1
      continue
    }
    const values = section.primaryKey.map((field) => row[field])
    if (values.some((value) => !isPresentPrimaryKeyValue(value))) {
      missingKeys += 1
      continue
    }
    const serialized = JSON.stringify(values)
    if (seen.has(serialized)) duplicateKeys += 1
    seen.add(serialized)
  }

  if (malformedRows) {
    addError(errors, `${section.key}: ${malformedRows} row(s) are not objects`)
  }
  if (missingKeys) {
    addError(
      errors,
      `${section.key}.${section.primaryKey.join("+")}: ${missingKeys} missing primary key(s)`
    )
  }
  if (duplicateKeys) {
    addError(
      errors,
      `${section.key}.${section.primaryKey.join("+")}: ${duplicateKeys} duplicate primary key(s)`
    )
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function sortedUniqueStrings(value) {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || item.length === 0)
  ) {
    return null
  }
  const sorted = [...value].sort()
  if (
    new Set(value).size !== value.length ||
    JSON.stringify(value) !== JSON.stringify(sorted)
  ) {
    return null
  }
  return sorted
}

function sameStrings(left, right) {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort())
}

function isValidTimestamp(value) {
  return typeof value === "string" && value.length > 0 && !Number.isNaN(Date.parse(value))
}

function sameTimestamp(left, right) {
  return (
    isValidTimestamp(left) &&
    isValidTimestamp(right) &&
    Date.parse(left) === Date.parse(right)
  )
}

function cleanRecipientText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
}

function splitOutlookRecipientText(value) {
  const text = String(value || "").replace(/\r?\n/g, " ")
  const parts = []
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

function parseOutlookRecipientLiteral(literal) {
  const trimmed = cleanRecipientText(literal)
  const angleMatch = trimmed.match(/^(.*?)\s*<([^<>]+)>\s*$/)
  if (!angleMatch) {
    return {
      displayName: trimmed.includes("@") ? "" : trimmed.replace(/^"+|"+$/g, ""),
      sourceValue: trimmed.replace(/^"+|"+$/g, ""),
    }
  }
  return {
    displayName: cleanRecipientText(angleMatch[1]).replace(/^"+|"+$/g, ""),
    sourceValue: cleanRecipientText(angleMatch[2]).replace(/^"+|"+$/g, ""),
  }
}

function hasExactKeySet(value, expected) {
  return (
    isPlainObject(value) &&
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...expected].sort())
  )
}

function validateProjectionForTemplateRecipients(projection, data, errors) {
  if (!isPlainObject(projection)) {
    addError(errors, "Outlook template truth: latest Exchange projection is not an object")
    return {
      contactsById: new Map(),
      groupsById: new Map(),
      contactSourceIds: new Set(),
      groupSourceIds: new Set(),
    }
  }

  const projectionContacts = Array.isArray(projection.contacts)
    ? projection.contacts
    : []
  const projectionGroups = Array.isArray(projection.groups)
    ? projection.groups
    : []
  if (!Array.isArray(projection.contacts) || !Array.isArray(projection.groups)) {
    addError(
      errors,
      "Outlook template truth: latest Exchange projection has no contact/group arrays"
    )
  }

  const sharedContactsById = new Map(
    rows(data, "sharedAddressbookContacts")
      .filter(isPlainObject)
      .map((row) => [cleanRecipientText(row.id), row])
      .filter(([id]) => id)
  )
  const sharedGroupsById = new Map(
    rows(data, "sharedAddressbookGroups")
      .filter(isPlainObject)
      .map((row) => [cleanRecipientText(row.id), row])
      .filter(([id]) => id)
  )
  const contactsById = new Map()
  const groupsById = new Map()
  const contactSourceIds = new Set()
  const groupSourceIds = new Set()
  const emailPattern = /^[^@\s]+@[^@\s]+$/
  const aliasPattern = /^[a-z0-9._-]{1,64}$/

  for (const [index, value] of projectionContacts.entries()) {
    const label = `latest Exchange projection contact ${index}`
    if (!isPlainObject(value)) {
      addError(errors, `${label}: expected an object`)
      continue
    }
    const sourceId = cleanRecipientText(value.sourceContactId)
    const rawAddress = cleanRecipientText(value.externalEmailAddress)
    const address = rawAddress.toLowerCase()
    if (!sourceId || contactSourceIds.has(sourceId)) {
      addError(errors, `${label}: missing or duplicate sourceContactId`)
      continue
    }
    contactSourceIds.add(sourceId)
    if (!emailPattern.test(address) || rawAddress !== address) {
      addError(errors, `${label}: unusable source identity or canonical email address`)
      continue
    }
    const shared = sharedContactsById.get(sourceId)
    if (!shared) {
      addError(errors, `${label}: source contact ${sourceId} is absent from the export`)
    } else {
      const sharedAddress = cleanRecipientText(shared.primary_email).toLowerCase()
      if (sharedAddress !== address) {
        addError(
          errors,
          `${label}: projected email does not match shared contact ${sourceId}`
        )
      }
    }
    contactsById.set(sourceId, {
      address,
      displayName: cleanRecipientText(
        value.displayName ||
          value.directoryName ||
          shared?.display_name ||
          shared?.nickname ||
          address
      ),
    })
  }

  for (const [index, value] of projectionGroups.entries()) {
    const label = `latest Exchange projection group ${index}`
    if (!isPlainObject(value)) {
      addError(errors, `${label}: expected an object`)
      continue
    }
    const sourceId = cleanRecipientText(value.sourceGroupId)
    const rawAlias = cleanRecipientText(value.alias)
    const alias = rawAlias.toLowerCase()
    const rawAddress = cleanRecipientText(value.smtpAddress)
    const address = rawAddress.toLowerCase()
    const memberCount = Number(value.memberCount)
    if (!sourceId || groupSourceIds.has(sourceId)) {
      addError(errors, `${label}: missing or duplicate sourceGroupId`)
      continue
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
      addError(
        errors,
        `${label}: unusable source identity, exact SMTP address, alias, or member count`
      )
      continue
    }
    const shared = sharedGroupsById.get(sourceId)
    if (!shared) {
      addError(errors, `${label}: source group ${sourceId} is absent from the export`)
    } else if (
      Number(shared.member_count) !== memberCount ||
      cleanRecipientText(shared.name) !== cleanRecipientText(value.groupName)
    ) {
      addError(
        errors,
        `${label}: projected identity does not match shared group ${sourceId}`
      )
    }
    if (memberCount > 0) {
      groupsById.set(sourceId, {
        alias,
        address,
        displayName: cleanRecipientText(
          value.groupName ||
            value.directoryName ||
            shared?.name ||
            shared?.nickname ||
            alias
        ),
      })
    }
  }

  return { contactsById, groupsById, contactSourceIds, groupSourceIds }
}

function validateTemplateRecipientVerifier(
  verification,
  checkpoint,
  aggregate,
  label,
  errors
) {
  if (!isPlainObject(verification)) {
    addError(errors, `${label}: missing or not an object`)
    return null
  }
  const templates = verification.templates
  const queue = verification.queue
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
    verification.allTemplatesSendable !== aggregate.allTemplatesSendable
  ) {
    addError(errors, `${label}: verifier did not report valid recipient truth`)
  }
  if (
    verification.certificationRunId !== checkpoint?.latestCertificationRunId ||
    verification.certifiedAt !== checkpoint?.latestCertificationAt ||
    verification.sourceFingerprint !== checkpoint?.latestSourceFingerprint
  ) {
    addError(errors, `${label}: certification anchor does not match its checkpoint`)
  }
  if (!exactObjectCounts(templates, expectedTemplateCounts)) {
    addError(errors, `${label}.templates: does not match exported email templates`)
  }
  if (
    !isPlainObject(queue) ||
    !["pending", "processing", "failed", "terminalFailed"].every(
      (key) => Number.isSafeInteger(queue[key]) && queue[key] === 0
    )
  ) {
    addError(errors, `${label}.queue: Exchange queue is not settled`)
  }

  return {
    certificationRunId: String(checkpoint?.latestCertificationRunId || ""),
    certifiedAt: String(checkpoint?.latestCertificationAt || ""),
    sourceFingerprint: String(checkpoint?.latestSourceFingerprint || ""),
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

function validateExportedTemplateRecipientTruth(
  backup,
  truth,
  certificationState,
  snapshotsByHash,
  errors
) {
  const data = isPlainObject(backup.data) ? backup.data : {}
  const latestCertification = certificationState.latestCertification
  if (!latestCertification) {
    addError(errors, "Outlook template truth: latest Exchange certification is missing")
    return
  }
  const sourceFingerprint = String(latestCertification.source_fingerprint || "")
  const projectionSnapshot = snapshotsByHash.get(sourceFingerprint)
  if (
    !projectionSnapshot ||
    projectionSnapshot.snapshot_kind !== "fcuno_exchange_projection"
  ) {
    addError(
      errors,
      "Outlook template truth: latest certification has no exported projection snapshot"
    )
    return
  }
  const projection = parseJsonText(
    projectionSnapshot.canonical_json,
    "Outlook template truth projection",
    errors
  )
  const projectionState = validateProjectionForTemplateRecipients(
    projection,
    data,
    errors
  )
  const checkpointBefore = truth.checkpointBeforeExport
  const checkpointAfter = truth.checkpointAfterExport
  const currentRunId = String(checkpointAfter?.latestCertificationRunId || "")
  const currentCertifiedAt = String(checkpointAfter?.latestCertificationAt || "")
  const currentFingerprint = String(checkpointAfter?.latestSourceFingerprint || "")
  const aggregate = {
    total: 0,
    sendable: 0,
    missing: 0,
    ambiguous: 0,
    allTemplatesSendable: true,
  }
  const emailPattern = /^[^@\s]+@[^@\s]+$/
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
  }
  for (const [templateIndex, value] of rows(data, "emailTemplates").entries()) {
    const template = isPlainObject(value) ? value : {}
    const templateId = cleanRecipientText(template.id) || String(templateIndex)
    const label = `emailTemplates[${templateId}].recipient_resolution`
    const resolution = template.recipient_resolution
    aggregate.total += 1
    let templateMissing = false
    let templateAmbiguous = false

    if (!isPlainObject(resolution)) {
      addError(errors, `${label}: missing or not an object`)
      continue
    }
    const allowedResolutionKeys =
      Object.hasOwn(resolution, "reconciliationRequired")
        ? [...resolutionKeys, "reconciliationRequired"]
        : resolutionKeys
    if (!hasExactKeySet(resolution, allowedResolutionKeys)) {
      addError(errors, `${label}: unexpected or missing fields`)
    }
    if (
      Object.hasOwn(resolution, "reconciliationRequired") &&
      resolution.reconciliationRequired !== false
    ) {
      addError(errors, `${label}: reconciliationRequired must be absent or false`)
    }
    if (
      resolution.schema !== OUTLOOK_TEMPLATE_RESOLUTION_SCHEMA ||
      resolution.certificationRunId !== currentRunId ||
      String(resolution.sourceFingerprint || "").toLowerCase() !==
        currentFingerprint
    ) {
      addError(errors, `${label}: schema or current certification anchor mismatch`)
    }
    if (!sameTimestamp(resolution.certifiedAt, currentCertifiedAt)) {
      addError(errors, `${label}.certifiedAt: not the current certification time`)
    }
    if (!isValidTimestamp(resolution.resolvedAt)) {
      addError(errors, `${label}.resolvedAt: invalid timestamp`)
    }

    const refs = resolution.refs
    const recordedCounts = resolution.counts
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
      addError(errors, `${label}: refs or counts shape is invalid`)
      continue
    }

    const actualCounts = {
      total: 0,
      resolved: 0,
      external: 0,
      ambiguous: 0,
      missing: 0,
    }
    for (const [field, column] of Object.entries(fieldColumns)) {
      const literals = splitOutlookRecipientText(String(template[column] || ""))
      const fieldRefs = refs[field]
      if (!Array.isArray(fieldRefs)) {
        addError(errors, `${label}.refs.${field}: expected an array`)
        continue
      }
      if (fieldRefs.length !== literals.length) {
        addError(
          errors,
          `${label}.refs.${field}: ${fieldRefs.length} refs do not match ${literals.length} raw recipients`
        )
      }

      for (const [position, valueRef] of fieldRefs.entries()) {
        const refLabel = `${label}.refs.${field}[${position}]`
        if (!hasExactKeySet(valueRef, refKeys)) {
          addError(errors, `${refLabel}: unexpected or missing fields`)
          continue
        }
        const ref = valueRef
        const literal = literals[position]
        const parsed = parseOutlookRecipientLiteral(literal || "")
        if (
          ref.field !== field ||
          ref.position !== position ||
          ref.literal !== literal ||
          ref.sourceValue !== parsed.sourceValue ||
          typeof ref.displayName !== "string"
        ) {
          addError(errors, `${refLabel}: field, position, literal, or sourceValue mismatch`)
        }
        if (
          !["resolved", "external", "ambiguous", "missing"].includes(ref.status)
        ) {
          addError(errors, `${refLabel}.status: unsupported value`)
          continue
        }
        actualCounts.total += 1
        actualCounts[ref.status] += 1
        if (ref.status === "missing") templateMissing = true
        if (ref.status === "ambiguous") templateAmbiguous = true

        if (ref.status === "resolved") {
          if (
            !["contact", "group"].includes(ref.kind) ||
            typeof ref.sourceId !== "string" ||
            !ref.sourceId.trim() ||
            typeof ref.resolvedAddress !== "string" ||
            !emailPattern.test(ref.resolvedAddress) ||
            ref.resolvedAddress !== ref.resolvedAddress.toLowerCase()
          ) {
            addError(errors, `${refLabel}: resolved identity/address shape is invalid`)
            continue
          }
          const candidate =
            ref.kind === "contact"
              ? projectionState.contactsById.get(ref.sourceId)
              : projectionState.groupsById.get(ref.sourceId)
          if (!candidate) {
            addError(
              errors,
              `${refLabel}: ${ref.kind} ${ref.sourceId} is absent from the latest projection`
            )
            continue
          }
          if (ref.kind === "contact") {
            if (ref.resolvedAddress !== candidate.address) {
              addError(errors, `${refLabel}: contact address is not projection-exact`)
            }
          } else {
            if (ref.resolvedAddress !== candidate.address) {
              addError(errors, `${refLabel}: group address is not projection-exact`)
            }
          }
          if (
            ref.displayName !== parsed.displayName &&
            ref.displayName !== candidate.displayName
          ) {
            addError(errors, `${refLabel}: display name is not literal- or projection-derived`)
          }
        } else if (ref.status === "external") {
          if (
            ref.kind !== "external" ||
            ref.sourceId !== null ||
            !emailPattern.test(parsed.sourceValue) ||
            ref.resolvedAddress !== parsed.sourceValue.toLowerCase() ||
            ref.displayName !== parsed.displayName
          ) {
            addError(errors, `${refLabel}: external recipient evidence is inconsistent`)
          }
        } else if (ref.status === "ambiguous") {
          const explicitAddress = parsed.sourceValue.includes("@")
          if (
            ref.kind !== "unresolved" ||
            ref.sourceId !== null ||
            ref.displayName !== parsed.displayName ||
            ref.resolvedAddress !==
              (explicitAddress ? parsed.sourceValue.toLowerCase() : null) ||
            (explicitAddress && !emailPattern.test(parsed.sourceValue))
          ) {
            addError(errors, `${refLabel}: ambiguous recipient evidence is inconsistent`)
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
            backup.migrationHead >=
              OUTLOOK_TEMPLATE_STABLE_MISSING_MIGRATION_HEAD &&
            ["contact", "group"].includes(ref.kind) &&
            Boolean(retainedSourceId) &&
            !(ref.kind === "contact"
              ? projectionState.contactSourceIds.has(retainedSourceId)
              : projectionState.groupSourceIds.has(retainedSourceId))
          if (
            ref.resolvedAddress !== null ||
            (!unresolvedMissing && !retainedMissing)
          ) {
            addError(errors, `${refLabel}: missing recipient evidence is inconsistent`)
          }
        }
      }
    }

    if (
      actualCounts.total > 10000 ||
      !Object.values(recordedCounts).every(
        (count) => Number.isSafeInteger(count) && count >= 0 && count <= 10000
      ) ||
      !exactObjectCounts(recordedCounts, actualCounts)
    ) {
      addError(errors, `${label}.counts: does not match its recipient refs`)
    }
    if (templateMissing) aggregate.missing += 1
    if (templateAmbiguous) aggregate.ambiguous += 1
    if (!templateMissing && !templateAmbiguous) aggregate.sendable += 1
  }

  aggregate.allTemplatesSendable =
    aggregate.missing === 0 && aggregate.ambiguous === 0

  const normalizedBefore = validateTemplateRecipientVerifier(
    truth.templateRecipientVerificationBeforeExport,
    checkpointBefore,
    aggregate,
    "integrity.truth.templateRecipientVerificationBeforeExport",
    errors
  )
  const normalizedAfter = validateTemplateRecipientVerifier(
    truth.templateRecipientVerificationAfterExport,
    checkpointAfter,
    aggregate,
    "integrity.truth.templateRecipientVerificationAfterExport",
    errors
  )
  if (
    normalizedBefore &&
    normalizedAfter &&
    JSON.stringify(normalizedBefore) !== JSON.stringify(normalizedAfter)
  ) {
    addError(errors, "integrity.truth: Outlook template recipient truth changed during export")
  }
  if (
    !normalizedAfter ||
    !exactObjectCounts(truth.templateRecipientTruth, normalizedAfter)
  ) {
    addError(
      errors,
      "integrity.truth.templateRecipientTruth: does not match exported templates and verifier"
    )
  }
}

function canonicalPostgresTimestamp(value) {
  if (typeof value !== "string") return null
  const match = value.match(
    /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/i
  )
  if (!match) return null

  const [, date, time, fraction = "", zone] = match
  const wholeSecond = new Date(`${date}T${time}${zone}`)
  if (Number.isNaN(wholeSecond.getTime())) return null

  return `${wholeSecond.toISOString().slice(0, 19)}.${fraction.padEnd(6, "0")}Z`
}

function parseJsonText(value, label, errors) {
  if (typeof value !== "string" || value.length === 0) {
    addError(errors, `${label}: missing JSON text`)
    return null
  }
  try {
    return JSON.parse(value)
  } catch (error) {
    addError(
      errors,
      `${label}: invalid JSON (${error instanceof Error ? error.message : String(error)})`
    )
    return null
  }
}

function exactObjectCounts(actual, expected) {
  if (!isPlainObject(actual)) return false
  const actualKeys = Object.keys(actual).sort()
  const expectedKeys = Object.keys(expected).sort()
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) return false
  return expectedKeys.every((key) => actual[key] === expected[key])
}

function validateDatabaseInventory(backup, errors) {
  const contract = getBackupContract(String(backup.migrationHead || ""))
  const inventory = backup.databaseInventory
  if (!isPlainObject(inventory)) {
    addError(errors, "databaseInventory: missing or not an object")
    return
  }

  const expectedKeys = [
    "schema",
    "liveTables",
    "registeredTables",
    "explicitlyEphemeralTables",
    "excludedCredentialFields",
  ]
  if (JSON.stringify(Object.keys(inventory)) !== JSON.stringify(expectedKeys)) {
    addError(errors, "databaseInventory: unexpected fields or field order")
  }
  if (inventory.schema !== BACKUP_INVENTORY_SCHEMA) {
    addError(
      errors,
      `databaseInventory.schema: expected ${BACKUP_INVENTORY_SCHEMA}, found ${JSON.stringify(inventory.schema)}`
    )
  }

  const liveTables = sortedUniqueStrings(inventory.liveTables)
  const registeredTables = sortedUniqueStrings(inventory.registeredTables)
  const ephemeralTables = sortedUniqueStrings(inventory.explicitlyEphemeralTables)
  const excludedFields = sortedUniqueStrings(inventory.excludedCredentialFields)

  if (!liveTables) {
    addError(errors, "databaseInventory.liveTables: expected sorted unique table names")
  }
  if (!registeredTables) {
    addError(errors, "databaseInventory.registeredTables: expected sorted unique table names")
  } else if (
    !sameStrings(registeredTables, contract.expectedRegisteredTables)
  ) {
    addError(errors, "databaseInventory.registeredTables: does not match the v2 table contract")
  }
  if (!ephemeralTables) {
    addError(
      errors,
      "databaseInventory.explicitlyEphemeralTables: expected sorted unique table names"
    )
  } else if (!sameStrings(ephemeralTables, EXPLICITLY_EPHEMERAL_TABLES)) {
    addError(
      errors,
      "databaseInventory.explicitlyEphemeralTables: does not match the v2 exclusion contract"
    )
  }
  if (!excludedFields) {
    addError(
      errors,
      "databaseInventory.excludedCredentialFields: expected sorted unique field names"
    )
  } else if (!sameStrings(excludedFields, EXCLUDED_CREDENTIAL_FIELDS)) {
    addError(
      errors,
      "databaseInventory.excludedCredentialFields: does not match the v2 credential exclusion contract"
    )
  }

  if (liveTables) {
    const missingRequired = contract.requiredLiveTables.filter(
      (table) => !liveTables.includes(table)
    )
    const unregistered = liveTables.filter(
      (table) => !contract.expectedRegisteredTables.includes(table)
    )
    if (missingRequired.length) {
      addError(
        errors,
        `databaseInventory.liveTables: missing required ${missingRequired.join(", ")}`
      )
    }
    if (unregistered.length) {
      addError(
        errors,
        `databaseInventory.liveTables: unregistered ${unregistered.join(", ")}`
      )
    }
  }
}

function validateSourceWarnings(backup, errors, warnings) {
  if (!Array.isArray(backup.warnings)) {
    addError(errors, "warnings: missing or not an array")
    return
  }
  if (backup.warnings.length) {
    addError(
      errors,
      `warnings: a trusted v2 backup must have zero source warnings; found ${backup.warnings.length}`
    )
  }
  for (const [index, warning] of backup.warnings.entries()) {
    if (!isPlainObject(warning)) {
      addError(errors, `warnings[${index}]: expected an object`)
      continue
    }
    const keys = Object.keys(warning)
    const allowedKeys = new Set(["key", "table", "source", "message"])
    if (keys.some((key) => !allowedKeys.has(key))) {
      addError(errors, `warnings[${index}]: unexpected field`)
    }
    if (typeof warning.key !== "string" || !warning.key) {
      addError(errors, `warnings[${index}].key: missing`)
    }
    if (typeof warning.message !== "string" || !warning.message) {
      addError(errors, `warnings[${index}].message: missing`)
    }
    for (const key of ["table", "source"]) {
      if (
        warning[key] !== undefined &&
        (typeof warning[key] !== "string" || !warning[key])
      ) {
        addError(errors, `warnings[${index}].${key}: invalid`)
      }
    }
    warnings.push(`source warning: ${warning.message || JSON.stringify(warning)}`)
  }
}

function validateTopLevelAndManifest(backup, rawFile, errors, warnings) {
  if (!isPlainObject(backup)) {
    addError(errors, "Root value is not an object")
    return
  }

  if (backup.schemaVersion !== 2) {
    addError(errors, `schemaVersion: expected 2, found ${JSON.stringify(backup.schemaVersion)}`)
  }

  const actualTopLevelKeys = Object.keys(backup)
  if (JSON.stringify(actualTopLevelKeys) !== JSON.stringify(TOP_LEVEL_KEYS)) {
    addError(
      errors,
      `top-level keys/order: expected ${TOP_LEVEL_KEYS.join(", ")}, found ${actualTopLevelKeys.join(", ")}`
    )
  }

  if (
    typeof backup.backupRunId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      backup.backupRunId
    )
  ) {
    addError(errors, "backupRunId: expected a version-4 UUID")
  }
  if (!isValidTimestamp(backup.generatedAt)) addError(errors, "Invalid generatedAt")
  if (backup.project !== "bunker-map") {
    addError(errors, `project: expected bunker-map, found ${JSON.stringify(backup.project)}`)
  }
  if (!["vercel-cron", "admin-manual"].includes(backup.source)) {
    addError(
      errors,
      `source: expected vercel-cron or admin-manual, found ${JSON.stringify(backup.source)}`
    )
  }
  if (typeof backup.requestedBy !== "string" || !backup.requestedBy.trim()) {
    addError(errors, "requestedBy: missing")
  }
  if (backup.source === "vercel-cron" && backup.requestedBy !== "Vercel Cron") {
    addError(errors, "requestedBy: cron backups must identify Vercel Cron")
  }
  if (
    typeof backup.migrationHead !== "string" ||
    !/^\d{14}$/.test(backup.migrationHead)
  ) {
    addError(
      errors,
      `migrationHead: expected a 14-digit live database migration, found ${JSON.stringify(backup.migrationHead)}`
    )
  } else if (backup.migrationHead < MINIMUM_V2_MIGRATION_HEAD) {
    addError(
      errors,
      `migrationHead: ${backup.migrationHead} predates the minimum v2 truth migration ${MINIMUM_V2_MIGRATION_HEAD}`
    )
  }
  if (
    backup.deploymentCommit !== null &&
    !/^[0-9a-f]{7,64}$/i.test(String(backup.deploymentCommit || ""))
  ) {
    addError(errors, "deploymentCommit: expected null or a hexadecimal commit identifier")
  } else if (backup.deploymentCommit === null) {
    warnings.push("deploymentCommit: missing; code provenance cannot be independently identified")
  }
  if (backup.previousVerifiedBackup !== null) {
    const previous = backup.previousVerifiedBackup
    if (!isPlainObject(previous)) {
      addError(errors, "previousVerifiedBackup: expected null or an object")
    } else {
      const expectedPreviousKeys = [
        "fileId",
        "name",
        "createdTime",
        "artifactSha256",
        "uploadedFileSha256",
      ]
      if (JSON.stringify(Object.keys(previous)) !== JSON.stringify(expectedPreviousKeys)) {
        addError(errors, "previousVerifiedBackup: unexpected fields or field order")
      }
      if (typeof previous.fileId !== "string" || !previous.fileId) {
        addError(errors, "previousVerifiedBackup.fileId: missing")
      }
      if (
        typeof previous.name !== "string" ||
        !BACKUP_FILE_NAME_PATTERN.test(previous.name)
      ) {
        addError(errors, "previousVerifiedBackup.name: invalid backup filename")
      }
      if (previous.createdTime !== null && !isValidTimestamp(previous.createdTime)) {
        addError(errors, "previousVerifiedBackup.createdTime: invalid timestamp")
      } else if (
        previous.createdTime !== null &&
        isValidTimestamp(backup.generatedAt) &&
        Date.parse(previous.createdTime) >= Date.parse(backup.generatedAt)
      ) {
        addError(errors, "previousVerifiedBackup.createdTime: must precede generatedAt")
      }
      if (!SHA256_PATTERN.test(String(previous.artifactSha256 || ""))) {
        addError(errors, "previousVerifiedBackup.artifactSha256: invalid SHA-256")
      }
      if (!SHA256_PATTERN.test(String(previous.uploadedFileSha256 || ""))) {
        addError(errors, "previousVerifiedBackup.uploadedFileSha256: invalid SHA-256")
      }
    }
  }
  validateDatabaseInventory(backup, errors)
  if (!isPlainObject(backup.counts)) addError(errors, "Missing counts object")
  if (!isPlainObject(backup.data)) addError(errors, "Missing data object")
  validateSourceWarnings(backup, errors, warnings)

  const integrity = backup.integrity
  if (!isPlainObject(integrity)) {
    addError(errors, "Missing integrity manifest")
    return
  }
  const expectedIntegrityKeys = [
    "schema",
    "algorithm",
    "serialization",
    "artifactHashScope",
    "artifactSha256",
    "sections",
    "truth",
  ]
  if (JSON.stringify(Object.keys(integrity)) !== JSON.stringify(expectedIntegrityKeys)) {
    addError(errors, "integrity: unexpected fields or field order")
  }

  if (integrity.schema !== "bunker-map-backup-integrity/v2") {
    addError(errors, `integrity.schema: unsupported value ${JSON.stringify(integrity.schema)}`)
  }
  if (integrity.algorithm !== "sha256") {
    addError(errors, `integrity.algorithm: expected sha256, found ${JSON.stringify(integrity.algorithm)}`)
  }
  if (integrity.serialization !== "JSON.stringify/v1") {
    addError(
      errors,
      `integrity.serialization: expected JSON.stringify/v1, found ${JSON.stringify(integrity.serialization)}`
    )
  }
  if (integrity.artifactHashScope !== "top-level-without-integrity/v1") {
    addError(
      errors,
      `integrity.artifactHashScope: unexpected value ${JSON.stringify(integrity.artifactHashScope)}`
    )
  }
  if (!SHA256_PATTERN.test(String(integrity.artifactSha256 || ""))) {
    addError(errors, "integrity.artifactSha256: invalid SHA-256")
  }

  const artifactPayload = {
    schemaVersion: backup.schemaVersion,
    backupRunId: backup.backupRunId,
    generatedAt: backup.generatedAt,
    project: backup.project,
    source: backup.source,
    requestedBy: backup.requestedBy,
    migrationHead: backup.migrationHead,
    deploymentCommit: backup.deploymentCommit,
    previousVerifiedBackup: backup.previousVerifiedBackup,
    databaseInventory: backup.databaseInventory,
    counts: backup.counts,
    data: backup.data,
    warnings: backup.warnings,
  }
  const actualArtifactSha256 = sha256(JSON.stringify(artifactPayload))
  if (integrity.artifactSha256 !== actualArtifactSha256) {
    addError(
      errors,
      `integrity.artifactSha256: declared ${integrity.artifactSha256 || "missing"}, actual ${actualArtifactSha256}`
    )
  }

  const sections = integrity.sections
  if (!isPlainObject(sections)) {
    addError(errors, "integrity.sections: missing or not an object")
    return
  }

  const dataKeys = Object.keys(backup.data || {})
  const sectionKeys = Object.keys(sections)
  const missingSections = dataKeys.filter((key) => !(key in sections))
  const extraSections = sectionKeys.filter((key) => !(key in (backup.data || {})))
  if (missingSections.length) {
    addError(errors, `integrity.sections: missing ${missingSections.join(", ")}`)
  }
  if (extraSections.length) {
    addError(errors, `integrity.sections: unexpected ${extraSections.join(", ")}`)
  }

  for (const key of dataKeys) {
    const section = sections[key]
    if (!isPlainObject(section)) {
      addError(errors, `integrity.sections.${key}: missing or not an object`)
      continue
    }
    if (JSON.stringify(Object.keys(section)) !== JSON.stringify(["rowCount", "sha256"])) {
      addError(errors, `integrity.sections.${key}: unexpected fields or field order`)
    }

    const value = backup.data[key]
    if (!Array.isArray(value)) {
      addError(errors, `${key}: data section is not an array`)
      continue
    }

    if (section.rowCount !== value.length) {
      addError(
        errors,
        `integrity.sections.${key}.rowCount: declared ${section.rowCount ?? "missing"}, actual ${value.length}`
      )
    }

    const actualSectionSha256 = sha256(JSON.stringify(value))
    if (section.sha256 !== actualSectionSha256) {
      addError(
        errors,
        `integrity.sections.${key}.sha256: declared ${section.sha256 || "missing"}, actual ${actualSectionSha256}`
      )
    }
  }

  // The Drive upload verifies this separate hash over the exact pretty-printed
  // file bytes. It is intentionally printed rather than compared with the
  // compact logical-artifact hash above.
  return {
    fileSha256: sha256(rawFile),
    artifactSha256: actualArtifactSha256,
  }
}

function validateSections(backup, errors, warnings) {
  const contract = getBackupContract(String(backup.migrationHead || ""))
  const data = isPlainObject(backup?.data) ? backup.data : {}
  const counts = isPlainObject(backup?.counts) ? backup.counts : {}
  const dataKeys = Object.keys(data).sort()
  const countKeys = Object.keys(counts).sort()
  const expectedDataKeys = [
    ...contract.requiredSections,
    ...OPTIONAL_DATA_SECTIONS.filter((key) => key in data),
  ].sort()

  if (!sameStrings(dataKeys, expectedDataKeys)) {
    const missing = contract.requiredSections.filter(
      (key) => !dataKeys.includes(key)
    )
    const unexpected = dataKeys.filter(
      (key) => !contract.expectedDataSections.includes(key)
    )
    if (missing.length) addError(errors, `data: missing sections ${missing.join(", ")}`)
    if (unexpected.length) {
      addError(errors, `data: unexpected sections ${unexpected.join(", ")}`)
    }
  }
  if (!sameStrings(countKeys, contract.requiredSections)) {
    const missing = contract.requiredSections.filter(
      (key) => !countKeys.includes(key)
    )
    const unexpected = countKeys.filter(
      (key) => !contract.requiredSections.includes(key)
    )
    if (missing.length) addError(errors, `counts: missing sections ${missing.join(", ")}`)
    if (unexpected.length) {
      addError(errors, `counts: unexpected sections ${unexpected.join(", ")}`)
    }
  }

  for (const section of contract.sectionSpecs) {
    const { key } = section
    if (!Array.isArray(data[key])) {
      addError(errors, `${key}: section missing or not an array`)
      continue
    }
    if (counts[key] !== data[key].length) {
      addError(
        errors,
        `${key}: declared ${counts[key] ?? "missing"}, actual ${data[key].length}`
      )
    }
    if (!Number.isSafeInteger(counts[key]) || counts[key] < 0) {
      addError(errors, `counts.${key}: expected a non-negative safe integer`)
    }
    checkSectionPrimaryKeys(data, section, errors)
  }

  if ("googleCalendarMetadata" in data) {
    const metadata = data.googleCalendarMetadata
    if (
      !Array.isArray(metadata) ||
      metadata.length !== 1 ||
      !isPlainObject(metadata[0]) ||
      typeof metadata[0].calendarId !== "string" ||
      !metadata[0].calendarId
    ) {
      addError(
        errors,
        "googleCalendarMetadata: expected one object containing a calendarId"
      )
    }
  }

  for (const key of ["adminUsers", "spcUsers"]) {
    const exposed = rows(data, key).filter(
      (row) => isPlainObject(row) && Object.hasOwn(row, "password_hash")
    )
    if (exposed.length) {
      addError(errors, `${key}: password_hash must be excluded from backup artifacts`)
    }
  }
  for (const [index, row] of rows(data, "auditLogs").entries()) {
    if (!isPlainObject(row) || !["admin_users", "spc_users"].includes(row.table_name)) {
      continue
    }
    for (const snapshotKey of ["before_row", "after_row"]) {
      if (
        isPlainObject(row[snapshotKey]) &&
        Object.hasOwn(row[snapshotKey], "password_hash")
      ) {
        addError(
          errors,
          `auditLogs[${index}].${snapshotKey}: password_hash must be redacted`
        )
      }
    }
    if (
      Array.isArray(row.changed_fields) &&
      row.changed_fields.includes("password_hash")
    ) {
      addError(
        errors,
        `auditLogs[${index}].changed_fields: password_hash must be redacted`
      )
    }
  }

  const companyIds = idSet(data, "ccCompanies")
  const countryIds = idSet(data, "ccCountries")
  const portIds = idSet(data, "ports")
  const sharedContactIds = idSet(data, "sharedAddressbookContacts")
  const sharedGroupIds = idSet(data, "sharedAddressbookGroups")
  const auditLogIds = idSet(data, "auditLogs")
  const adminUserIds = idSet(data, "adminUsers")
  const spcUserIds = idSet(data, "spcUsers")
  const spcEnquiryIds = idSet(data, "spcEnquiries")
  const whatsappConversationIds = idSet(data, "whatsappConversations")
  const attendancePersonIds = idSet(data, "attendancePeople")
  const attendanceRawPunchIds = idSet(data, "attendanceRawPunches")

  checkReferences(
    rows(data, "attendancePeople"),
    "admin_user_id",
    adminUserIds,
    "attendancePeople.admin_user_id",
    errors
  )

  checkReferences(
    rows(data, "ccCompanyFiles"),
    "company_id",
    companyIds,
    "ccCompanyFiles.company_id",
    errors,
    { required: true }
  )
  checkReferences(
    rows(data, "ccPorts"),
    "country_id",
    countryIds,
    "ccPorts.country_id",
    errors
  )
  checkReferences(
    rows(data, "priceHistory"),
    "port_id",
    portIds,
    "priceHistory.port_id",
    errors
  )
  checkReferences(
    rows(data, "sharedAddressbookGroupMembers"),
    "contact_id",
    sharedContactIds,
    "groupMembers.contact_id",
    errors,
    { required: true }
  )
  checkReferences(
    rows(data, "sharedAddressbookGroupMembers"),
    "group_id",
    sharedGroupIds,
    "groupMembers.group_id",
    errors,
    { required: true }
  )
  checkReferences(
    rows(data, "outlookExchangeSyncQueue"),
    "audit_log_id",
    auditLogIds,
    "outlookExchangeSyncQueue.audit_log_id",
    errors
  )
  checkReferences(
    rows(data, "auditLogs"),
    "undo_of_log_id",
    auditLogIds,
    "auditLogs.undo_of_log_id",
    errors
  )
  checkReferences(
    rows(data, "auditLogs"),
    "undone_by_log_id",
    auditLogIds,
    "auditLogs.undone_by_log_id",
    errors
  )
  checkReferences(
    rows(data, "spcFixtures"),
    "enquiry_id",
    spcEnquiryIds,
    "spcFixtures.enquiry_id",
    errors,
    { required: true }
  )
  checkReferences(
    rows(data, "spcFixtures"),
    "supplier_trader_user_id",
    spcUserIds,
    "spcFixtures.supplier_trader_user_id",
    errors
  )
  checkReferences(
    rows(data, "spcFixtures"),
    "buyer_trader_user_id",
    spcUserIds,
    "spcFixtures.buyer_trader_user_id",
    errors
  )
  checkReferences(
    rows(data, "whatsappMessages"),
    "conversation_id",
    whatsappConversationIds,
    "whatsappMessages.conversation_id",
    errors,
    { required: true }
  )
  for (const [section, label] of [
    ["attendanceTeamAssignments", "attendanceTeamAssignments.person_id"],
    ["attendanceRawPunches", "attendanceRawPunches.person_id"],
    ["attendanceLeaveEntries", "attendanceLeaveEntries.person_id"],
    ["attendanceManualOverrides", "attendanceManualOverrides.person_id"],
    ["attendanceEntitlements", "attendanceEntitlements.person_id"],
    ["attendanceMonthlyAdjustments", "attendanceMonthlyAdjustments.person_id"],
    ["attendanceMonthlyConfirmations", "attendanceMonthlyConfirmations.person_id"],
    ["attendanceReminderDispatches", "attendanceReminderDispatches.person_id"],
  ]) {
    checkReferences(
      rows(data, section),
      "person_id",
      attendancePersonIds,
      label,
      errors,
      { required: true }
    )
  }
  checkReferences(
    rows(data, "attendanceManualOverrides"),
    "raw_punch_id",
    attendanceRawPunchIds,
    "attendanceManualOverrides.raw_punch_id",
    errors
  )

  const polymorphicParents = {
    company: companyIds,
    country: countryIds,
  }
  for (const key of ["ccEntryFiles", "ccEntryFolders"]) {
    let unknownKinds = 0
    let missingValues = 0
    let missingParents = 0
    for (const row of rows(data, key)) {
      if (!isPlainObject(row)) continue
      const parents = polymorphicParents[row.entry_kind]
      if (!parents) {
        unknownKinds += 1
      } else if (!isPresentPrimaryKeyValue(row.entry_id)) {
        missingValues += 1
      } else if (!parents.has(row.entry_id)) {
        missingParents += 1
      }
    }
    if (unknownKinds) {
      addError(errors, `${key}.entry_kind: ${unknownKinds} unsupported value(s)`)
    }
    if (missingValues) {
      addError(errors, `${key}.entry_id: ${missingValues} required value(s) are missing`)
    }
    if (missingParents) {
      addError(errors, `${key}.entry_id: ${missingParents} missing parent reference(s)`)
    }
  }

  for (const key of ["ccCompanyFiles", "ccEntryFiles"]) {
    const activeWithoutDriveId = rows(data, key).filter(
      (row) => isPlainObject(row) && !row.deleted_at && !row.drive_file_id
    )
    if (activeWithoutDriveId.length) {
      warnings.push(
        `${key}: ${activeWithoutDriveId.length} active file reference(s) have no Drive file id`
      )
    }
  }
}

function validateTruthSnapshots(data, errors) {
  const snapshots = rows(data, "outlookExchangeTruthSnapshots")
  const byHash = new Map()

  checkDuplicateValues(
    snapshots.map((snapshot) => snapshot?.snapshot_sha256),
    "outlookExchangeTruthSnapshots.snapshot_sha256",
    errors
  )

  for (const [index, snapshot] of snapshots.entries()) {
    const label = `outlookExchangeTruthSnapshots[${index}]`
    const snapshotSha256 = String(snapshot?.snapshot_sha256 || "")
    if (!SHA256_PATTERN.test(snapshotSha256)) {
      addError(errors, `${label}.snapshot_sha256: invalid SHA-256`)
      continue
    }
    byHash.set(snapshotSha256, snapshot)

    if (snapshot.schema_version !== 1) {
      addError(errors, `${label}.schema_version: expected 1`)
    }
    if (!isValidTimestamp(snapshot.created_at)) {
      addError(errors, `${label}.created_at: invalid timestamp`)
    }
    if (typeof snapshot.canonical_json !== "string") {
      addError(errors, `${label}.canonical_json: missing`)
      continue
    }

    const actualHash = sha256(snapshot.canonical_json)
    if (snapshotSha256 !== actualHash) {
      addError(
        errors,
        `${label}.snapshot_sha256: declared ${snapshotSha256}, actual ${actualHash}`
      )
    }

    const actualByteLength = Buffer.byteLength(snapshot.canonical_json, "utf8")
    if (snapshot.byte_length !== actualByteLength) {
      addError(
        errors,
        `${label}.byte_length: declared ${snapshot.byte_length ?? "missing"}, actual ${actualByteLength}`
      )
    }

    const canonical = parseJsonText(snapshot.canonical_json, `${label}.canonical_json`, errors)
    if (!isPlainObject(canonical)) {
      if (canonical !== null) addError(errors, `${label}.canonical_json: expected an object`)
      continue
    }

    if (snapshot.snapshot_kind === "fcuno_raw") {
      const expectedKeys = ["contacts", "groups", "members", "schema"].sort()
      if (JSON.stringify(Object.keys(canonical).sort()) !== JSON.stringify(expectedKeys)) {
        addError(errors, `${label}: raw snapshot has unexpected canonical JSON fields`)
      }
      if (canonical.schema !== "fcuno.addressbook.raw/v1") {
        addError(errors, `${label}: invalid raw snapshot schema`)
      }
      if (
        !Array.isArray(canonical.contacts) ||
        !Array.isArray(canonical.groups) ||
        !Array.isArray(canonical.members)
      ) {
        addError(errors, `${label}: raw snapshot collections must be arrays`)
      } else {
        const expectedCounts = {
          contacts: canonical.contacts.length,
          groups: canonical.groups.length,
          members: canonical.members.length,
        }
        if (!exactObjectCounts(snapshot.item_counts, expectedCounts)) {
          addError(errors, `${label}.item_counts: does not match raw snapshot arrays`)
        }
      }
    } else if (snapshot.snapshot_kind === "fcuno_exchange_projection") {
      const projectionKeys = [
        "contacts",
        "groups",
        "members",
        "invalidContacts",
        "skippedInvalidContacts",
        "duplicateContacts",
      ]
      if (JSON.stringify(Object.keys(canonical).sort()) !== JSON.stringify([...projectionKeys].sort())) {
        addError(errors, `${label}: projection snapshot has unexpected canonical JSON fields`)
      }
      if (!projectionKeys.every((key) => Array.isArray(canonical[key]))) {
        addError(errors, `${label}: projection snapshot collections must be arrays`)
      } else {
        const expectedCounts = Object.fromEntries(
          projectionKeys.map((key) => [key, canonical[key].length])
        )
        if (!exactObjectCounts(snapshot.item_counts, expectedCounts)) {
          addError(errors, `${label}.item_counts: does not match projection arrays`)
        }
      }
    } else {
      addError(errors, `${label}.snapshot_kind: unsupported value ${snapshot.snapshot_kind}`)
    }
  }

  return byHash
}

function ledgerHashMaterial(row) {
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

function validateTruthLedger(data, snapshotsByHash, errors) {
  const ledger = [...rows(data, "outlookExchangeTruthLedger")].sort(
    (a, b) => Number(a?.ledger_sequence || 0) - Number(b?.ledger_sequence || 0)
  )
  const auditIds = idSet(data, "auditLogs")
  const queueIds = idSet(data, "outlookExchangeSyncQueue")

  if (!ledger.length) addError(errors, "outlookExchangeTruthLedger: ledger is empty")

  checkDuplicateValues(
    ledger.map((row) => row?.ledger_sequence),
    "outlookExchangeTruthLedger.ledger_sequence",
    errors
  )
  checkDuplicateValues(
    ledger.map((row) => row?.entry_id),
    "outlookExchangeTruthLedger.entry_id",
    errors
  )
  checkDuplicateValues(
    ledger.map((row) => row?.event_key),
    "outlookExchangeTruthLedger.event_key",
    errors
  )
  checkDuplicateValues(
    ledger.map((row) => row?.entry_sha256),
    "outlookExchangeTruthLedger.entry_sha256",
    errors
  )

  let previous = null
  const referencedSnapshots = new Set()
  const byEventKey = new Map()

  for (const [index, row] of ledger.entries()) {
    const label = `outlookExchangeTruthLedger[sequence=${row?.ledger_sequence ?? "missing"}]`
    if (!isPlainObject(row)) {
      addError(errors, `${label}: ledger row is not an object`)
      continue
    }
    const sequence = row?.ledger_sequence
    if (!Number.isSafeInteger(sequence) || sequence <= 0) {
      addError(errors, `${label}.ledger_sequence: expected a positive safe integer`)
    }
    if (
      index > 0 &&
      isPlainObject(ledger[index - 1]) &&
      sequence <= ledger[index - 1].ledger_sequence
    ) {
      addError(errors, `${label}.ledger_sequence: not strictly increasing`)
    }

    if (!row?.entry_id) addError(errors, `${label}.entry_id: missing`)
    if (typeof row?.event_key !== "string" || !row.event_key || row.event_key.includes("\n")) {
      addError(errors, `${label}.event_key: invalid`)
    } else {
      byEventKey.set(row.event_key, row)
    }
    if (typeof row?.event_type !== "string" || !row.event_type || row.event_type.includes("\n")) {
      addError(errors, `${label}.event_type: invalid`)
    }

    if (!isValidTimestamp(row?.occurred_at)) {
      addError(errors, `${label}.occurred_at: invalid timestamp`)
    }
    if (!isValidTimestamp(row?.created_at)) {
      addError(errors, `${label}.created_at: invalid timestamp`)
    }

    const expectedCanonicalTimestamp = canonicalPostgresTimestamp(row?.occurred_at)
    if (!expectedCanonicalTimestamp || row?.occurred_at_canonical !== expectedCanonicalTimestamp) {
      addError(
        errors,
        `${label}.occurred_at_canonical: declared ${row?.occurred_at_canonical ?? "missing"}, actual ${expectedCanonicalTimestamp ?? "invalid occurred_at"}`
      )
    }

    parseJsonText(row?.payload_canonical_json, `${label}.payload_canonical_json`, errors)
    const actualPayloadSha256 =
      typeof row?.payload_canonical_json === "string"
        ? sha256(row.payload_canonical_json)
        : null
    if (!SHA256_PATTERN.test(String(row?.payload_sha256 || ""))) {
      addError(errors, `${label}.payload_sha256: invalid SHA-256`)
    } else if (row.payload_sha256 !== actualPayloadSha256) {
      addError(
        errors,
        `${label}.payload_sha256: declared ${row.payload_sha256}, actual ${actualPayloadSha256}`
      )
    }

    const expectedPreviousHash = previous?.entry_sha256 || null
    if ((row?.previous_entry_sha256 || null) !== expectedPreviousHash) {
      addError(
        errors,
        `${label}.previous_entry_sha256: declared ${row?.previous_entry_sha256 ?? "null"}, expected ${expectedPreviousHash ?? "null"}`
      )
    }

    if (row?.snapshot_sha256) {
      referencedSnapshots.add(row.snapshot_sha256)
      if (!snapshotsByHash.has(row.snapshot_sha256)) {
        addError(errors, `${label}.snapshot_sha256: missing snapshot ${row.snapshot_sha256}`)
      }
    }
    if (row?.audit_log_id && !auditIds.has(row.audit_log_id)) {
      addError(errors, `${label}.audit_log_id: missing audit row ${row.audit_log_id}`)
    }
    if (row?.queue_row_id && !queueIds.has(row.queue_row_id)) {
      addError(errors, `${label}.queue_row_id: missing queue row ${row.queue_row_id}`)
    }

    const expectedHashMaterial = ledgerHashMaterial(row)
    if (row?.hash_material !== expectedHashMaterial) {
      addError(errors, `${label}.hash_material: does not match the v1 canonical material`)
    }

    const actualEntrySha256 = sha256(expectedHashMaterial)
    if (!SHA256_PATTERN.test(String(row?.entry_sha256 || ""))) {
      addError(errors, `${label}.entry_sha256: invalid SHA-256`)
    } else if (row.entry_sha256 !== actualEntrySha256) {
      addError(
        errors,
        `${label}.entry_sha256: declared ${row.entry_sha256}, actual ${actualEntrySha256}`
      )
    }

    previous = row
  }

  const unreferencedSnapshots = [...snapshotsByHash.keys()].filter(
    (hash) => !referencedSnapshots.has(hash)
  )
  if (unreferencedSnapshots.length) {
    addError(
      errors,
      `outlookExchangeTruthSnapshots: ${unreferencedSnapshots.length} snapshot(s) are outside the exported ledger prefix`
    )
  }

  return { ledger, byEventKey, referencedSnapshots }
}

function validateCertificationPairing(data, ledgerState, snapshotsByHash, errors, warnings) {
  const certifications = [...rows(data, "outlookExchangeSyncCertifications")].sort(
    (a, b) => Date.parse(a?.certified_at || 0) - Date.parse(b?.certified_at || 0)
  )
  checkDuplicateValues(
    certifications.map((row) => row?.run_id),
    "outlookExchangeSyncCertifications.run_id",
    errors
  )

  const certificationByRunId = new Map()
  for (const [index, certification] of certifications.entries()) {
    const label = `outlookExchangeSyncCertifications[${index}]`
    if (!isPlainObject(certification)) {
      addError(errors, `${label}: certification row is not an object`)
      continue
    }
    const runId = certification.run_id
    if (!runId) {
      addError(errors, `${label}.run_id: missing`)
      continue
    }
    certificationByRunId.set(runId, certification)

    if (certification.sync_mode !== "full") addError(errors, `${label}.sync_mode: expected full`)
    if (!isValidTimestamp(certification.certified_at)) {
      addError(errors, `${label}.certified_at: invalid timestamp`)
    }
    if (!isValidTimestamp(certification.created_at)) {
      addError(errors, `${label}.created_at: invalid timestamp`)
    }
    if (!SHA256_PATTERN.test(String(certification.source_fingerprint || ""))) {
      addError(errors, `${label}.source_fingerprint: invalid SHA-256`)
    }
    if (
      !Number.isSafeInteger(certification.queue_high_water_sequence) ||
      certification.queue_high_water_sequence < 0
    ) {
      addError(errors, `${label}.queue_high_water_sequence: invalid`)
    }
    if (
      certification.queue_high_water_updated_at !== null &&
      !isValidTimestamp(certification.queue_high_water_updated_at)
    ) {
      addError(errors, `${label}.queue_high_water_updated_at: invalid timestamp`)
    }
    if (!isPlainObject(certification.result)) {
      addError(errors, `${label}.result: expected an object`)
    } else if (certification.result.certified !== true) {
      addError(errors, `${label}.result.certified: expected true`)
    }

    const currentReceipt = ledgerState.byEventKey.get(`certification:${runId}`)
    const legacyReceipt = ledgerState.byEventKey.get(`legacy-certification:${runId}`)
    if (currentReceipt && legacyReceipt) {
      addError(errors, `${label}: both legacy and current certification receipts exist`)
    }
    const receipt = currentReceipt || legacyReceipt
    if (!receipt) {
      addError(errors, `${label}: missing certification truth-ledger receipt`)
      continue
    }

    if (currentReceipt) {
      if (receipt.event_type !== "full_certification" || receipt.run_id !== runId) {
        addError(errors, `${label}: certification receipt type/run ID mismatch`)
      }

      const rawSnapshot = snapshotsByHash.get(receipt.snapshot_sha256)
      if (!rawSnapshot || rawSnapshot.snapshot_kind !== "fcuno_raw") {
        addError(errors, `${label}: certification receipt does not reference an FCUNO raw snapshot`)
      }

      const receiptPayload = parseJsonText(
        receipt.payload_canonical_json,
        `${label}.receipt.payload_canonical_json`,
        errors
      )
      if (receiptPayload) {
        if (receiptPayload.schema !== "fcuno.exchange.full-certification/v1") {
          addError(errors, `${label}: certification receipt payload schema mismatch`)
        }
        if (receiptPayload?.certification?.run_id !== runId) {
          addError(errors, `${label}: certification receipt payload run ID mismatch`)
        }
        if (receiptPayload.rawSourceSnapshotSha256 !== receipt.snapshot_sha256) {
          addError(errors, `${label}: certification receipt raw snapshot hash mismatch`)
        }
      }
    } else {
      if (
        receipt.event_type !== "legacy_full_certification" ||
        receipt.run_id !== runId ||
        receipt.snapshot_sha256 !== null
      ) {
        addError(errors, `${label}: legacy certification receipt type/run/snapshot mismatch`)
      }
      const legacyPayload = parseJsonText(
        receipt.payload_canonical_json,
        `${label}.legacyReceipt.payload_canonical_json`,
        errors
      )
      if (
        legacyPayload &&
        (legacyPayload.run_id !== runId ||
          legacyPayload.source_fingerprint !== certification.source_fingerprint)
      ) {
        addError(errors, `${label}: legacy certification receipt payload mismatch`)
      }
    }

    const projection = ledgerState.byEventKey.get(`projection:${runId}`)
    if (projection) {
      if (!currentReceipt) {
        addError(errors, `${label}: projection evidence is paired to a legacy-only receipt`)
        continue
      }
      validateProjectionEvidence(
        certification,
        receipt,
        projection,
        snapshotsByHash,
        errors,
        label
      )
    }
  }

  for (const row of ledgerState.ledger) {
    if (!isPlainObject(row)) continue
    if (
      [
        "full_certification",
        "legacy_full_certification",
        "full_projection_evidence",
      ].includes(row.event_type) &&
      (!row.run_id || !certificationByRunId.has(row.run_id))
    ) {
      addError(
        errors,
        `outlookExchangeTruthLedger[sequence=${row.ledger_sequence}]: ${row.event_type} has no certification row`
      )
    }
    if (
      row.event_type === "full_projection_evidence" &&
      row.run_id &&
      row.event_key !== `projection:${row.run_id}`
    ) {
      addError(
        errors,
        `outlookExchangeTruthLedger[sequence=${row.ledger_sequence}]: projection event key does not match its run ID`
      )
    }
  }

  const latestCertification = certifications.at(-1) || null
  const latestProjection = latestCertification
    ? ledgerState.byEventKey.get(`projection:${latestCertification.run_id}`)
    : null

  if (!latestCertification) {
    addError(errors, "outlookExchangeSyncCertifications: no full certification is present")
  } else if (!latestProjection) {
    addError(
      errors,
      `latest certification ${latestCertification.run_id}: missing full projection evidence`
    )
  }

  const legacyWithoutProjection = certifications.filter(
    (certification) =>
      certification !== latestCertification &&
      !ledgerState.byEventKey.has(`projection:${certification.run_id}`)
  )
  if (legacyWithoutProjection.length) {
    warnings.push(
      `Exchange truth: ${legacyWithoutProjection.length} legacy certification(s) predate projection-evidence capture`
    )
  }

  return { certifications, latestCertification, latestProjection }
}

function validateProjectionEvidence(
  certification,
  certificationReceipt,
  projection,
  snapshotsByHash,
  errors,
  label
) {
  if (
    projection.event_type !== "full_projection_evidence" ||
    projection.run_id !== certification.run_id
  ) {
    addError(errors, `${label}: projection evidence type/run ID mismatch`)
  }

  const projectionSnapshot = snapshotsByHash.get(projection.snapshot_sha256)
  if (!projectionSnapshot || projectionSnapshot.snapshot_kind !== "fcuno_exchange_projection") {
    addError(errors, `${label}: projection evidence does not reference a projection snapshot`)
  }
  if (projection.snapshot_sha256 !== certification.source_fingerprint) {
    addError(errors, `${label}: projection snapshot does not match source fingerprint`)
  }

  const payload = parseJsonText(
    projection.payload_canonical_json,
    `${label}.projection.payload_canonical_json`,
    errors
  )
  if (!payload) return

  if (payload.schema !== "fcuno.exchange.projection-evidence/v1") {
    addError(errors, `${label}: projection evidence payload schema mismatch`)
  }
  if (payload.runId !== certification.run_id) {
    addError(errors, `${label}: projection evidence payload run ID mismatch`)
  }
  if (
    payload.sourceFingerprint !== certification.source_fingerprint ||
    payload.projectionSnapshotSha256 !== projection.snapshot_sha256
  ) {
    addError(errors, `${label}: projection evidence source fingerprint mismatch`)
  }
  if (payload.rawSourceSnapshotSha256 !== certificationReceipt.snapshot_sha256) {
    addError(errors, `${label}: projection evidence raw snapshot mismatch`)
  }
  if (
    payload.certificationLedgerSequence !== certificationReceipt.ledger_sequence ||
    payload.certificationLedgerSha256 !== certificationReceipt.entry_sha256
  ) {
    addError(errors, `${label}: projection evidence certification anchor mismatch`)
  }
  if (payload?.verificationSummary?.status !== "match") {
    addError(errors, `${label}: projection verification status is not match`)
  }
  if (payload?.verificationSummary?.mismatchCount !== 0) {
    addError(errors, `${label}: projection verification mismatch count is not zero`)
  }
  if (payload?.verificationSummary?.sourceFenceStable !== true) {
    addError(errors, `${label}: projection evidence source fence is not stable`)
  }

  if (!exactObjectCounts(payload.projectionCounts, projectionSnapshot?.item_counts || {})) {
    addError(errors, `${label}: projection evidence counts do not match its snapshot`)
  }
  const summary = payload.verificationSummary
  const snapshotCounts = projectionSnapshot?.item_counts
  if (
    !isPlainObject(summary) ||
    !isPlainObject(snapshotCounts) ||
    summary.sourceFingerprint !== certification.source_fingerprint ||
    summary.verifiedManagedContacts !== snapshotCounts.contacts ||
    summary.verifiedManagedGroups !== snapshotCounts.groups ||
    summary.verifiedMembershipGroups !== snapshotCounts.groups ||
    summary.verifiedMemberships !== snapshotCounts.members
  ) {
    addError(errors, `${label}: projection verification counts/fingerprint do not match`)
  }
  if (
    typeof payload.workerVersion !== "string" ||
    !/^fcuno-exchange-runbook\/\d{4}-\d{2}-\d{2}\.\d+$/.test(payload.workerVersion)
  ) {
    addError(errors, `${label}: projection evidence worker version is invalid`)
  }
}

function sameTruthHead(left, right) {
  return (
    left?.headSequence === right?.headSequence &&
    left?.headSha256 === right?.headSha256 &&
    left?.ledgerEntries === right?.ledgerEntries &&
    left?.snapshots === right?.snapshots
  )
}

function validateTruthManifest(backup, ledgerState, certificationState, snapshotsByHash, errors) {
  const truth = backup?.integrity?.truth
  if (!isPlainObject(truth)) {
    addError(errors, "integrity.truth: missing or not an object")
    return
  }
  if (truth.schema !== "fcuno-exchange-backup-checkpoint/v1") {
    addError(errors, `integrity.truth.schema: unsupported value ${JSON.stringify(truth.schema)}`)
  }
  const requiresTemplateRecipientTruth =
    typeof backup.migrationHead === "string" &&
    /^\d{14}$/.test(backup.migrationHead) &&
    backup.migrationHead >= OUTLOOK_TEMPLATE_TRUTH_MIGRATION_HEAD
  const expectedTruthKeys = [
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
  ]
  if (JSON.stringify(Object.keys(truth)) !== JSON.stringify(expectedTruthKeys)) {
    addError(errors, "integrity.truth: unexpected fields or field order")
  }

  const verificationBefore = truth.verificationBeforeExport
  const verificationAfter = truth.verificationAfterExport
  const checkpointBefore = truth.checkpointBeforeExport
  const checkpointAfter = truth.checkpointAfterExport
  const exportedLedger = truth.exportedLedger
  const exportedSnapshots = truth.exportedSnapshots

  for (const [label, verification] of [
    ["verificationBeforeExport", verificationBefore],
    ["verificationAfterExport", verificationAfter],
  ]) {
    if (!isPlainObject(verification)) {
      addError(errors, `integrity.truth.${label}: missing or not an object`)
      continue
    }
    if (
      verification.integrityValid !== true ||
      verification.valid !== true ||
      verification.ledgerValid !== true ||
      verification.snapshotsValid !== true ||
      verification.referencesValid !== true ||
      verification.operationallyConsistent !== true
    ) {
      addError(
        errors,
        `integrity.truth.${label}: database verifier did not report valid and operationally consistent evidence`
      )
    }
    if (
      verification.firstInvalidLedgerSequence !== null &&
      verification.firstInvalidLedgerSequence !== undefined
    ) {
      addError(errors, `integrity.truth.${label}: reports an invalid ledger sequence`)
    }
    if (
      verification.firstInvalidSnapshotSha256 !== null &&
      verification.firstInvalidSnapshotSha256 !== undefined
    ) {
      addError(errors, `integrity.truth.${label}: reports an invalid snapshot`)
    }
    if (
      verification.firstInvalidReferenceLedgerSequence !== null &&
      verification.firstInvalidReferenceLedgerSequence !== undefined
    ) {
      addError(errors, `integrity.truth.${label}: reports an invalid ledger reference`)
    }
  }

  for (const [label, checkpoint] of [
    ["checkpointBeforeExport", checkpointBefore],
    ["checkpointAfterExport", checkpointAfter],
  ]) {
    if (!isPlainObject(checkpoint)) {
      addError(errors, `integrity.truth.${label}: missing or not an object`)
    } else if (checkpoint.checkpointValid !== true) {
      addError(errors, `integrity.truth.${label}: database checkpoint was not valid`)
    }
  }

  if (!isPlainObject(exportedLedger)) {
    addError(errors, "integrity.truth.exportedLedger: missing or not an object")
  } else if (
    JSON.stringify(Object.keys(exportedLedger)) !==
    JSON.stringify(["entries", "headSequence", "headSha256"])
  ) {
    addError(errors, "integrity.truth.exportedLedger: unexpected fields or field order")
  }
  if (!isPlainObject(exportedSnapshots)) {
    addError(errors, "integrity.truth.exportedSnapshots: missing or not an object")
  } else if (JSON.stringify(Object.keys(exportedSnapshots)) !== JSON.stringify(["count"])) {
    addError(errors, "integrity.truth.exportedSnapshots: unexpected fields or field order")
  }

  if (!sameTruthHead(verificationBefore, verificationAfter)) {
    addError(errors, "integrity.truth: verifier head/counts changed during export")
  }
  if (!sameTruthHead(checkpointBefore, checkpointAfter)) {
    addError(errors, "integrity.truth: checkpoint head/counts changed during export")
  }
  if (
    verificationBefore?.headSequence !== checkpointBefore?.headSequence ||
    verificationBefore?.headSha256 !== checkpointBefore?.headSha256 ||
    verificationBefore?.ledgerEntries !== checkpointBefore?.ledgerEntries ||
    verificationBefore?.snapshots !== checkpointBefore?.snapshots
  ) {
    addError(errors, "integrity.truth: verifier and checkpoint disagree before export")
  }

  const ledger = ledgerState.ledger
  const head = ledger.at(-1) || null
  if (exportedLedger?.entries !== ledger.length) {
    addError(
      errors,
      `integrity.truth.exportedLedger.entries: declared ${exportedLedger?.entries ?? "missing"}, actual ${ledger.length}`
    )
  }
  if (exportedLedger?.headSequence !== head?.ledger_sequence) {
    addError(
      errors,
      `integrity.truth.exportedLedger.headSequence: declared ${exportedLedger?.headSequence ?? "missing"}, actual ${head?.ledger_sequence ?? "missing"}`
    )
  }
  if (exportedLedger?.headSha256 !== head?.entry_sha256) {
    addError(errors, "integrity.truth.exportedLedger.headSha256: does not match exported tail")
  }
  if (
    checkpointBefore?.ledgerEntries !== ledger.length ||
    checkpointBefore?.headSequence !== head?.ledger_sequence ||
    checkpointBefore?.headSha256 !== head?.entry_sha256
  ) {
    addError(errors, "integrity.truth: exported ledger is not the complete captured prefix")
  }

  if (exportedSnapshots?.count !== snapshotsByHash.size) {
    addError(
      errors,
      `integrity.truth.exportedSnapshots.count: declared ${exportedSnapshots?.count ?? "missing"}, actual ${snapshotsByHash.size}`
    )
  }
  if (
    verificationBefore?.snapshots !== snapshotsByHash.size ||
    checkpointBefore?.snapshots !== snapshotsByHash.size
  ) {
    addError(errors, "integrity.truth: exported snapshots do not match the captured checkpoint")
  }

  const latestCertification = certificationState.latestCertification
  const latestProjection = certificationState.latestProjection
  if (latestCertification) {
    for (const [label, state] of [
      ["verificationBeforeExport", verificationBefore],
      ["verificationAfterExport", verificationAfter],
      ["checkpointBeforeExport", checkpointBefore],
      ["checkpointAfterExport", checkpointAfter],
    ]) {
      if (state?.latestCertificationRunId !== latestCertification.run_id) {
        addError(errors, `integrity.truth.${label}: latest certification run ID mismatch`)
      }
      if (
        !isValidTimestamp(state?.latestCertificationAt) ||
        Date.parse(state.latestCertificationAt) !== Date.parse(latestCertification.certified_at)
      ) {
        addError(errors, `integrity.truth.${label}: latest certification timestamp mismatch`)
      }
      if (state?.latestSourceFingerprint !== latestCertification.source_fingerprint) {
        addError(errors, `integrity.truth.${label}: latest source fingerprint mismatch`)
      }
      if (state?.latestCertificationHasProjectionEvidence !== true) {
        addError(errors, `integrity.truth.${label}: latest certification lacks projection evidence`)
      }
      if (state?.latestProjectionSnapshotSha256 !== latestProjection?.snapshot_sha256) {
        addError(errors, `integrity.truth.${label}: latest projection snapshot mismatch`)
      }
    }
  }

  const queue = verificationBefore?.queue
  if (
    !isPlainObject(queue) ||
    Number(queue.pending || 0) +
      Number(queue.processing || 0) +
      Number(queue.failed || 0) +
      Number(queue.terminalFailed || 0) >
      0
  ) {
    addError(
      errors,
      `integrity.truth.verificationBeforeExport.queue: backup was not quiescent (pending=${queue?.pending ?? "missing"}, processing=${queue?.processing ?? "missing"}, failed=${queue?.failed ?? "missing"}, terminalFailed=${queue?.terminalFailed ?? "missing"})`
    )
  }

  if (requiresTemplateRecipientTruth) {
    validateExportedTemplateRecipientTruth(
      backup,
      truth,
      certificationState,
      snapshotsByHash,
      errors
    )
  }
}

let rawFile
let backup
try {
  rawFile = fs.readFileSync(backupPath, "utf8")
  backup = JSON.parse(rawFile)
} catch (error) {
  console.error(`INVALID: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

const errors = []
const warnings = []
const safeBackup = isPlainObject(backup) ? backup : {}
const backupContract = getBackupContract(String(safeBackup.migrationHead || ""))
function runValidationStep(label, callback, fallback) {
  try {
    return callback()
  } catch (error) {
    addError(
      errors,
      `${label}: malformed input could not be inspected safely (${error instanceof Error ? error.message : String(error)})`
    )
    return fallback
  }
}

const hashes = runValidationStep(
  "top-level manifest",
  () => validateTopLevelAndManifest(backup, rawFile, errors, warnings) || {},
  {}
)
runValidationStep(
  "data sections",
  () => validateSections(safeBackup, errors, warnings),
  undefined
)
const snapshotsByHash = runValidationStep(
  "truth snapshots",
  () => validateTruthSnapshots(safeBackup.data || {}, errors),
  new Map()
)
const ledgerState = runValidationStep(
  "truth ledger",
  () => validateTruthLedger(safeBackup.data || {}, snapshotsByHash, errors),
  { ledger: [], byEventKey: new Map(), referencedSnapshots: new Set() }
)
const certificationState = runValidationStep(
  "truth certifications",
  () =>
    validateCertificationPairing(
      safeBackup.data || {},
      ledgerState,
      snapshotsByHash,
      errors,
      warnings
    ),
  { certifications: [], latestCertification: null, latestProjection: null }
)
runValidationStep(
  "truth manifest",
  () =>
    validateTruthManifest(
      safeBackup,
      ledgerState,
      certificationState,
      snapshotsByHash,
      errors
    ),
  undefined
)

console.log(`Backup: ${path.basename(backupPath)}`)
console.log(`Schema version: ${safeBackup.schemaVersion ?? "-"}`)
console.log(`Generated: ${safeBackup.generatedAt || "-"}`)
console.log(`Migration head: ${safeBackup.migrationHead || "-"}`)
console.log(`Deployment commit: ${safeBackup.deploymentCommit || "-"}`)
console.log(
  `Previous verified backup: ${safeBackup.previousVerifiedBackup?.name || "none (first v2 artifact)"}`
)
console.log(`File SHA-256: ${hashes.fileSha256 || sha256(rawFile)}`)
console.log(`Artifact SHA-256: ${hashes.artifactSha256 || "-"}`)
console.log(`Sections checked: ${backupContract.requiredSections.length}`)
console.log(
  `Total required records checked: ${backupContract.requiredSections.reduce(
    (sum, key) => sum + rows(safeBackup.data || {}, key).length,
    0
  )}`
)
console.log(`Truth snapshots checked: ${snapshotsByHash.size}`)
console.log(`Truth ledger entries checked: ${ledgerState.ledger.length}`)
console.log(
  `Truth head: ${ledgerState.ledger.at(-1)?.ledger_sequence || "-"} / ${ledgerState.ledger.at(-1)?.entry_sha256 || "-"}`
)
console.log(`Errors: ${errors.length}`)
console.log(`Warnings: ${warnings.length}`)

for (const error of errors) console.log(`ERROR: ${error}`)
for (const warning of warnings) console.log(`WARNING: ${warning}`)

if (errors.length) {
  console.log("RESULT: INVALID")
  process.exit(1)
}

console.log("RESULT: VALID")
