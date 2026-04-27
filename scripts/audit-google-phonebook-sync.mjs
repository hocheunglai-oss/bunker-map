import fs from "node:fs"
import path from "node:path"
import { google } from "googleapis"
import { createClient } from "@supabase/supabase-js"

function readEnv(file) {
  const out = {}
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line || line.trim().startsWith("#")) continue
    const i = line.indexOf("=")
    if (i === -1) continue
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^['"]|['"]$/g, "")
  }
  return out
}

const env = readEnv(path.join(process.cwd(), ".env.local"))

const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
const auth = new google.auth.OAuth2(
  env.GOOGLE_OAUTH_CLIENT_ID,
  env.GOOGLE_OAUTH_CLIENT_SECRET,
  env.GOOGLE_OAUTH_REDIRECT_URI || "http://127.0.0.1",
)
auth.setCredentials(JSON.parse(fs.readFileSync(path.join(process.cwd(), ".google-people-oauth-token.json"), "utf8")))
const people = google.people({ version: "v1", auth })

async function loadDbContacts() {
  const rows = []
  const pageSize = 1000
  let from = 0
  while (true) {
    const { data, error } = await supabase
      .from("phonebook_contacts")
      .select("id,full_name,company")
      .order("full_name", { ascending: true })
      .range(from, from + pageSize - 1)
    if (error) throw error
    rows.push(...(data || []))
    if (!data || data.length < pageSize) break
    from += pageSize
  }
  return rows
}

async function loadGoogleManagedIds() {
  const ids = new Set()
  let pageToken
  do {
    const res = await people.people.connections.list({
      resourceName: "people/me",
      pageSize: 1000,
      pageToken,
      personFields: "userDefined",
      sortOrder: "FIRST_NAME_ASCENDING",
    })
    for (const person of res.data.connections || []) {
      const entries = person.userDefined || []
      const isManaged = entries.some((entry) => entry.key === "BUNKER_MAP_SYNC" && entry.value === "1")
      if (!isManaged) continue
      const contactId = entries.find((entry) => entry.key === "BUNKER_MAP_CONTACT_ID")?.value
      if (contactId) ids.add(contactId)
    }
    pageToken = res.data.nextPageToken || undefined
  } while (pageToken)
  return ids
}

const dbContacts = await loadDbContacts()
const googleIds = await loadGoogleManagedIds()
const missing = dbContacts.filter((contact) => !googleIds.has(contact.id))

console.log(
  JSON.stringify(
    {
      dbCount: dbContacts.length,
      googleManagedCount: googleIds.size,
      missingCount: missing.length,
      missing,
    },
    null,
    2,
  ),
)
