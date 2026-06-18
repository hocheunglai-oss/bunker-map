import fs from "node:fs"
import { createClient } from "@supabase/supabase-js"

const PRODUCTION_PROJECT_REF = "gglyugbrnyvyfktgwert"
const backupPath = process.argv[2]
const recoveryUrl = process.env.RECOVERY_SUPABASE_URL
const recoveryKey = process.env.RECOVERY_SUPABASE_SERVICE_ROLE_KEY

if (!backupPath || !recoveryUrl || !recoveryKey) {
  console.error(
    "Usage: RECOVERY_SUPABASE_URL=... RECOVERY_SUPABASE_SERVICE_ROLE_KEY=... npm run backup:restore:recovery -- /absolute/path/to/backup.json"
  )
  process.exit(2)
}

if (process.env.RECOVERY_CONFIRM !== "RESTORE_TO_RECOVERY_ONLY") {
  console.error("Refusing to write. Set RECOVERY_CONFIRM=RESTORE_TO_RECOVERY_ONLY.")
  process.exit(2)
}

const recoveryRef = new URL(recoveryUrl).hostname.split(".")[0]
if (!recoveryRef || recoveryRef === PRODUCTION_PROJECT_REF) {
  console.error("Refusing to restore into the production Supabase project.")
  process.exit(2)
}

const backup = JSON.parse(fs.readFileSync(backupPath, "utf8"))
const data = backup.data || {}
const supabase = createClient(recoveryUrl, recoveryKey, {
  auth: { persistSession: false, autoRefreshToken: false },
})

const restoreOrder = [
  ["adminUsers", "admin_users"],
  ["adminRoleDefaults", "admin_role_defaults", true],
  ["officeCalendarStore", "office_calendar_store"],
  ["emailTemplates", "email_templates"],
  ["ports", "ports"],
  ["remarks", "remarks"],
  ["ccCompanies", "cc_companies"],
  ["ccCountries", "cc_countries"],
  ["ccPorts", "cc_ports"],
  ["ccDocuments", "cc_documents"],
  ["phonebookCompanies", "phonebook_companies"],
  ["phonebookContacts", "phonebook_contacts"],
  ["sharedAddressbookContacts", "shared_addressbook_contacts"],
  ["sharedAddressbookGroups", "shared_addressbook_groups"],
  ["sharedAddressbookGroupMembers", "shared_addressbook_group_members"],
  ["ccCompanyFiles", "cc_company_files"],
  ["ccEntryFiles", "cc_entry_files"],
  ["ccEntryFolders", "cc_entry_folders"],
  ["priceHistory", "price_history"],
  ["outlookExchangeSyncQueue", "outlook_exchange_sync_queue"],
]

async function restoreTable(key, table, optional = false) {
  const rows = Array.isArray(data[key]) ? data[key] : []
  if (!rows.length) {
    console.log(`${table}: 0 rows`)
    return
  }

  const pageSize = 250
  for (let offset = 0; offset < rows.length; offset += pageSize) {
    const batch = rows.slice(offset, offset + pageSize)
    const { error } = await supabase.from(table).upsert(batch)
    if (error) {
      const missing = error.code === "PGRST205" || error.message.includes("schema cache")
      if (optional && missing) {
        console.log(`${table}: skipped optional missing table`)
        return
      }
      throw new Error(`${table} at row ${offset}: ${error.message}`)
    }
  }

  const { count, error } = await supabase
    .from(table)
    .select("*", { count: "exact", head: true })
  if (error) throw new Error(`${table} count verification: ${error.message}`)
  if (count !== rows.length) {
    throw new Error(`${table} count mismatch: expected ${rows.length}, found ${count}`)
  }
  console.log(`${table}: restored and verified ${count}`)
}

console.log(`Recovery project: ${recoveryRef}`)
console.log(`Backup generated: ${backup.generatedAt}`)
console.log("This process never writes to Google Contacts, Calendar, Drive, or production Supabase.")

for (const [key, table, optional] of restoreOrder) {
  await restoreTable(key, table, optional)
}

console.log("RECOVERY RESTORE COMPLETE")
