import fs from "node:fs"
import { createClient } from "@supabase/supabase-js"
import { google } from "googleapis"

const backupPath = process.argv[2]
const execute = process.argv.includes("--execute")
const confirmation = process.env.GENERAL_INFO_DELETE_CONFIRM

if (!backupPath) {
  console.error("Usage: npm run ccinfo:prune-general-info -- /absolute/path/to/backup.json [--execute]")
  process.exit(2)
}
if (execute && confirmation !== "DELETE_VERIFIED_GENERAL_INFO") {
  console.error("Refusing deletion. Set GENERAL_INFO_DELETE_CONFIRM=DELETE_VERIFIED_GENERAL_INFO.")
  process.exit(2)
}

const backup = JSON.parse(fs.readFileSync(backupPath, "utf8"))
const data = backup.data || {}
const companies = new Map((data.ccCompanies || []).map((row) => [row.id, row]))
const countries = new Map((data.ccCountries || []).map((row) => [row.id, row]))
const namePattern = /general[ _-]*(?:info|information)/i

function hasImportedContent(record) {
  return [record?.summary, record?.notes].some(
    (value) => typeof value === "string" && value.replace(/\s/g, "").length >= 20
  )
}

const candidates = [
  ...(data.ccCompanyFiles || []).map((file) => ({
    ...file,
    table: "cc_company_files",
    record: companies.get(file.company_id),
  })),
  ...(data.ccEntryFiles || []).map((file) => ({
    ...file,
    table: "cc_entry_files",
    record:
      file.entry_kind === "country"
        ? countries.get(file.entry_id)
        : companies.get(file.entry_id),
  })),
].filter(
  (file) =>
    !file.deleted_at &&
    file.drive_file_id &&
    namePattern.test(file.file_name || "")
)

const verified = candidates.filter((file) => file.record && hasImportedContent(file.record))
const preserved = candidates.filter((file) => !file.record || !hasImportedContent(file.record))

console.log(`Backup generated: ${backup.generatedAt}`)
console.log(`Candidates: ${candidates.length}`)
console.log(`Verified: ${verified.length}`)
console.log(`Preserved: ${preserved.length}`)
for (const file of preserved) {
  console.log(`PRESERVE: ${file.record?.name || "UNKNOWN"} | ${file.file_name}`)
}

if (!execute) {
  console.log("DRY RUN COMPLETE")
  process.exit(0)
}

const required = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "GOOGLE_OAUTH_CLIENT_ID",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "GOOGLE_DRIVE_REFRESH_TOKEN",
]
for (const key of required) {
  if (!process.env[key]) throw new Error(`Missing environment variable: ${key}`)
}

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
)
const auth = new google.auth.OAuth2(
  process.env.GOOGLE_OAUTH_CLIENT_ID,
  process.env.GOOGLE_OAUTH_CLIENT_SECRET,
  process.env.GOOGLE_OAUTH_REDIRECT_URI || "http://127.0.0.1"
)
auth.setCredentials({ refresh_token: process.env.GOOGLE_DRIVE_REFRESH_TOKEN })
const drive = google.drive({ version: "v3", auth })
let deleted = 0
let alreadyMissing = 0
const failures = []

for (const [index, file] of verified.entries()) {
  try {
    try {
      await drive.files.delete({
        fileId: file.drive_file_id,
        supportsAllDrives: true,
      })
    } catch (error) {
      if (error?.code === 404 || error?.response?.status === 404) {
        alreadyMissing += 1
      } else {
        throw error
      }
    }

    const { error } = await supabase
      .from(file.table)
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", file.id)
    if (error) throw error
    deleted += 1
  } catch (error) {
    failures.push({
      id: file.id,
      driveFileId: file.drive_file_id,
      name: file.file_name,
      message: error instanceof Error ? error.message : String(error),
    })
  }

  if ((index + 1) % 100 === 0) {
    console.log(`Progress: ${index + 1}/${verified.length}`)
  }
}

const result = {
  completedAt: new Date().toISOString(),
  backupGeneratedAt: backup.generatedAt,
  candidates: candidates.length,
  verified: verified.length,
  preserved: preserved.length,
  deleted,
  alreadyMissing,
  failures,
}
fs.writeFileSync("general-info-prune-result.json", JSON.stringify(result, null, 2))
console.log(JSON.stringify({ ...result, failures: failures.length }, null, 2))
if (failures.length) process.exit(1)
