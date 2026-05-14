import { createClient } from "@supabase/supabase-js"
import fs from "node:fs"

function readEnv(file) {
  if (!fs.existsSync(file)) return {}
  const out = {}
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line || line.trim().startsWith("#")) continue
    const i = line.indexOf("=")
    if (i === -1) continue
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^['"]|['"]$/g, "")
  }
  return out
}

const env = { ...process.env, ...readEnv(".env.local") }
const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL
const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY || env.NEXT_PUBLIC_SUPABASE_ANON_KEY

if (!supabaseUrl || !serviceRoleKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.")
  process.exit(1)
}

const supabase = createClient(supabaseUrl, serviceRoleKey)

async function fetchAll(table, columns) {
  const rows = []
  const pageSize = 500
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from(table)
      .select(columns)
      .range(from, from + pageSize - 1)
    if (error) throw error
    rows.push(...(data || []))
    if (!data || data.length < pageSize) break
  }
  return rows
}

async function uppercaseTable(table, columns) {
  const rows = await fetchAll(table, ["id", ...columns].join(","))
  const updates = []
  for (const row of rows) {
    const patch = { id: row.id }
    let changed = false
    for (const column of columns) {
      const value = row[column]
      patch[column] = value
      if (typeof value === "string" && value !== value.toUpperCase()) {
        patch[column] = value.toUpperCase()
        changed = true
      }
    }
    if (!changed) continue
    updates.push(patch)
  }

  for (let i = 0; i < updates.length; i += 250) {
    const { error } = await supabase.from(table).upsert(updates.slice(i, i + 250), { onConflict: "id" })
    if (error) throw error
  }

  console.log(`${table}: checked ${rows.length}, updated ${updates.length}`)
}

await uppercaseTable("cc_countries", ["name"])
await uppercaseTable("cc_ports", ["name", "country_name"])
await uppercaseTable("cc_companies", ["name"])
