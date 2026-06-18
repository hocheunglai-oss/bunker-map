import fs from "node:fs"
import path from "node:path"

const backupPath = process.argv[2]
if (!backupPath) {
  console.error("Usage: npm run backup:validate -- /absolute/path/to/bunker-map-backup.json")
  process.exit(2)
}

const requiredSections = [
  "adminUsers",
  "auditLogs",
  "officeCalendarStore",
  "emailTemplates",
  "sharedAddressbookContacts",
  "sharedAddressbookGroups",
  "sharedAddressbookGroupMembers",
  "outlookExchangeSyncQueue",
  "phonebookContacts",
  "phonebookCompanies",
  "ccCompanies",
  "ccCountries",
  "ccPorts",
  "ccDocuments",
  "ccCompanyFiles",
  "ccEntryFiles",
  "ccEntryFolders",
  "ports",
  "remarks",
  "priceHistory",
  "googleContacts",
  "googleCalendarEvents",
]

function rows(data, key) {
  return Array.isArray(data[key]) ? data[key] : []
}

function idSet(data, key) {
  return new Set(rows(data, key).map((row) => row?.id).filter(Boolean))
}

function checkReferences(childRows, field, parentIds, label, errors) {
  const missing = childRows.filter((row) => row?.[field] && !parentIds.has(row[field]))
  if (missing.length) errors.push(`${label}: ${missing.length} missing parent reference(s)`)
}

function checkDuplicateIds(data, key, errors) {
  const ids = rows(data, key).map((row) => row?.id).filter(Boolean)
  const duplicates = ids.length - new Set(ids).size
  if (duplicates) errors.push(`${key}: ${duplicates} duplicate id(s)`)
}

let backup
try {
  backup = JSON.parse(fs.readFileSync(backupPath, "utf8"))
} catch (error) {
  console.error(`INVALID: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

const errors = []
const warnings = []
const data = backup?.data
const counts = backup?.counts

if (!backup || typeof backup !== "object") errors.push("Root value is not an object")
if (!data || typeof data !== "object") errors.push("Missing data object")
if (!counts || typeof counts !== "object") errors.push("Missing counts object")
if (!backup.generatedAt || Number.isNaN(Date.parse(backup.generatedAt))) errors.push("Invalid generatedAt")

for (const key of requiredSections) {
  if (!Array.isArray(data?.[key])) {
    errors.push(`${key}: section missing or not an array`)
    continue
  }
  if (counts?.[key] !== data[key].length) {
    errors.push(`${key}: declared ${counts?.[key] ?? "missing"}, actual ${data[key].length}`)
  }
  checkDuplicateIds(data, key, errors)
}

const companyIds = idSet(data || {}, "ccCompanies")
const countryIds = idSet(data || {}, "ccCountries")
const portIds = idSet(data || {}, "ports")
const sharedContactIds = idSet(data || {}, "sharedAddressbookContacts")
const sharedGroupIds = idSet(data || {}, "sharedAddressbookGroups")

checkReferences(rows(data || {}, "ccCompanyFiles"), "company_id", companyIds, "ccCompanyFiles.company_id", errors)
checkReferences(rows(data || {}, "ccPorts"), "country_id", countryIds, "ccPorts.country_id", errors)
checkReferences(rows(data || {}, "priceHistory"), "port_id", portIds, "priceHistory.port_id", errors)
checkReferences(rows(data || {}, "sharedAddressbookGroupMembers"), "contact_id", sharedContactIds, "groupMembers.contact_id", errors)
checkReferences(rows(data || {}, "sharedAddressbookGroupMembers"), "group_id", sharedGroupIds, "groupMembers.group_id", errors)

for (const key of ["ccCompanyFiles", "ccEntryFiles"]) {
  const activeWithoutDriveId = rows(data || {}, key).filter((row) => !row?.deleted_at && !row?.drive_file_id)
  if (activeWithoutDriveId.length) {
    warnings.push(`${key}: ${activeWithoutDriveId.length} active file reference(s) have no Drive file id`)
  }
}

if (Array.isArray(backup.warnings)) {
  for (const warning of backup.warnings) {
    warnings.push(`source warning: ${warning?.message || JSON.stringify(warning)}`)
  }
}

console.log(`Backup: ${path.basename(backupPath)}`)
console.log(`Generated: ${backup.generatedAt || "-"}`)
console.log(`Sections checked: ${requiredSections.length}`)
console.log(`Total records checked: ${requiredSections.reduce((sum, key) => sum + rows(data || {}, key).length, 0)}`)
console.log(`Errors: ${errors.length}`)
console.log(`Warnings: ${warnings.length}`)

for (const error of errors) console.log(`ERROR: ${error}`)
for (const warning of warnings) console.log(`WARNING: ${warning}`)

if (errors.length) {
  console.log("RESULT: INVALID")
  process.exit(1)
}

console.log("RESULT: VALID FOR RESTORE REHEARSAL")
