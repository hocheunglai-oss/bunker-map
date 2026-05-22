import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { createClient } from "@supabase/supabase-js"

const DEFAULT_SOURCE_DIR = "/Users/hocheunglai/Downloads/(No subject)"
const BOOKS = [
  ["FC-GENERAL", "FC-GENERAL.sqlite"],
  ["FC-HK SHIP AGENTS", "FC-HK SHIP AGENTS.sqlite"],
  ["FC-INTERNAL", "FC-INTERNAL.sqlite"],
  ["FC-TW SHIP AGENTS", "FC-TW SHIP AGENTS.sqlite"],
]

function loadDotEnvLocal() {
  const file = path.join(process.cwd(), ".env.local")
  if (!fs.existsSync(file)) return
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const equalIndex = trimmed.indexOf("=")
    if (equalIndex === -1) continue
    const key = trimmed.slice(0, equalIndex).trim()
    const rawValue = trimmed.slice(equalIndex + 1).trim()
    if (!key || process.env[key]) continue
    process.env[key] = rawValue.replace(/^["']|["']$/g, "")
  }
}

function requireEnv(name) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing ${name}.`)
  return value
}

function stableId(...parts) {
  return createHash("sha1").update(parts.join("\u0000")).digest("hex")
}

function sqliteJson(file, sql) {
  const output = execFileSync("sqlite3", ["-json", file, sql], { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 })
  return JSON.parse(output || "[]")
}

function prepareSqliteFile(file, sourceBook) {
  const safeName = sourceBook.toLowerCase().replace(/[^a-z0-9]+/g, "-")
  const copyPath = path.join("/private/tmp", `fcuno-${safeName}.sqlite`)
  fs.copyFileSync(file, copyPath)
  return copyPath
}

function chunk(items, size) {
  const chunks = []
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size))
  return chunks
}

async function upsertMany(supabase, table, rows, onConflict) {
  for (const rowsChunk of chunk(rows, 500)) {
    const { error } = await supabase.from(table).upsert(rowsChunk, { onConflict })
    if (error) throw new Error(`${table} upsert failed: ${error.message}`)
  }
}

function collectContacts(sourceBook, propertyRows) {
  const byCard = new Map()
  for (const row of propertyRows) {
    if (!byCard.has(row.card)) byCard.set(row.card, {})
    byCard.get(row.card)[row.name] = row.value || ""
  }

  return Array.from(byCard.entries())
    .map(([sourceCard, properties]) => {
      const primaryEmail = String(properties.PrimaryEmail || "").trim()
      const displayName = String(properties.DisplayName || primaryEmail).trim()
      if (!primaryEmail || !displayName) return null
      return {
        id: stableId(sourceBook, sourceCard),
        source_book: sourceBook,
        source_card: sourceCard,
        display_name: displayName,
        primary_email: primaryEmail,
        nickname: properties.NickName || null,
        first_name: properties.FirstName || null,
        last_name: properties.LastName || null,
        vcard: properties._vCard || null,
        properties,
      }
    })
    .filter(Boolean)
}

function collectGroups(sourceBook, listRows, listCardRows, contactIdsBySourceCard) {
  const membersByList = new Map()
  for (const row of listCardRows) {
    if (!membersByList.has(row.list)) membersByList.set(row.list, [])
    const contactId = contactIdsBySourceCard.get(row.card)
    if (contactId) membersByList.get(row.list).push(contactId)
  }

  const groups = listRows.map((row) => {
    const id = stableId(sourceBook, row.uid)
    return {
      id,
      source_book: sourceBook,
      source_uid: row.uid,
      name: row.name || row.uid,
      nickname: row.nickName || null,
      description: row.description || null,
      member_count: membersByList.get(row.uid)?.length || 0,
    }
  })

  const groupMembers = []
  for (const group of groups) {
    for (const contactId of membersByList.get(group.source_uid) || []) {
      groupMembers.push({
        group_id: group.id,
        contact_id: contactId,
        source_book: sourceBook,
      })
    }
  }

  return { groups, groupMembers }
}

async function main() {
  loadDotEnvLocal()
  const sourceDir = process.env.THUNDERBIRD_ADDRESSBOOK_DIR || DEFAULT_SOURCE_DIR
  const allContacts = []
  const allGroups = []
  const allGroupMembers = []

  for (const [sourceBook, filename] of BOOKS) {
    const file = path.join(sourceDir, filename)
    if (!fs.existsSync(file)) {
      console.warn(`Skipping missing address book: ${file}`)
      continue
    }

    const sqliteFile = prepareSqliteFile(file, sourceBook)
    const propertyRows = sqliteJson(sqliteFile, "select card,name,value from properties")
    const listRows = sqliteJson(sqliteFile, "select uid,name,nickName,description from lists")
    const listCardRows = sqliteJson(sqliteFile, "select list,card from list_cards")
    const contacts = collectContacts(sourceBook, propertyRows)
    const contactIdsBySourceCard = new Map(contacts.map((contact) => [contact.source_card, contact.id]))
    const { groups, groupMembers } = collectGroups(sourceBook, listRows, listCardRows, contactIdsBySourceCard)

    allContacts.push(...contacts)
    allGroups.push(...groups)
    allGroupMembers.push(...groupMembers)
    console.log(`${sourceBook}: ${contacts.length} contacts, ${groups.length} groups, ${groupMembers.length} group members`)
  }

  if (process.env.DRY_RUN === "1") {
    console.log(JSON.stringify({ contacts: allContacts.length, groups: allGroups.length, groupMembers: allGroupMembers.length }, null, 2))
    return
  }

  const supabase = createClient(requireEnv("NEXT_PUBLIC_SUPABASE_URL"), requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"))

  await upsertMany(supabase, "shared_addressbook_contacts", allContacts, "id")
  await upsertMany(supabase, "shared_addressbook_groups", allGroups, "id")
  await upsertMany(supabase, "shared_addressbook_group_members", allGroupMembers, "group_id,contact_id")

  console.log(JSON.stringify({ contacts: allContacts.length, groups: allGroups.length, groupMembers: allGroupMembers.length }, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
