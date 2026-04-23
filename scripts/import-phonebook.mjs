import fs from "node:fs"
import path from "node:path"
import { createClient } from "@supabase/supabase-js"

const PROJECT_ROOT = process.cwd()
const CSV_PATH = "/Users/hocheunglai/Downloads/fcbcistem.csv"

function loadEnv() {
  return Object.fromEntries(
    fs
      .readFileSync(path.join(PROJECT_ROOT, ".env.local"), "utf8")
      .split("\n")
      .filter(Boolean)
      .filter((line) => !line.trim().startsWith("#"))
      .map((line) => {
        const idx = line.indexOf("=")
        return [line.slice(0, idx).trim(), line.slice(idx + 1).trim().replace(/^['"]|['"]$/g, "")]
      }),
  )
}

function parseCsvLine(line) {
  const values = []
  let current = ""
  let inQuotes = false

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]
    const next = line[i + 1]
    if (char === '"' && inQuotes && next === '"') {
      current += '"'
      i += 1
      continue
    }
    if (char === '"') {
      inQuotes = !inQuotes
      continue
    }
    if (char === "," && !inQuotes) {
      values.push(current)
      current = ""
      continue
    }
    current += char
  }
  values.push(current)
  return values
}

function normalizePhone(value) {
  return (value || "").trim()
}

function buildSourceKey(row) {
  return [
    row.full_name || "",
    row.company || "",
    row.mobile_phone || "",
    row.email_1 || "",
    row.email_2 || "",
  ]
    .join("|")
    .toLowerCase()
}

function buildSearchText(row) {
  return [
    row.full_name,
    row.company,
    row.mobile_phone,
    row.pager,
    row.business_phone,
    row.business_phone_2,
    row.other_phone,
    row.email_1,
    row.email_2,
    row.notes,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
}

function companySourceKey(name) {
  return (name || "").trim().toLowerCase()
}

async function main() {
  const env = loadEnv()
  const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY)

  const raw = fs.readFileSync(CSV_PATH, "utf8").replace(/^\uFEFF/, "")
  const lines = raw.split(/\r?\n/).filter(Boolean)
  if (lines.length < 2) {
    throw new Error("CSV appears empty.")
  }

  const headers = parseCsvLine(lines[0])
  const rows = lines.slice(1).map((line) => {
    const values = parseCsvLine(line)
    const source = Object.fromEntries(headers.map((header, index) => [header, values[index] || ""]))
    const row = {
      full_name: (source["Last Name"] || "").trim(),
      company: (source["Company"] || "").trim(),
      mobile_phone: normalizePhone(source["Mobile Phone"]),
      pager: normalizePhone(source["Pager"]),
      business_phone: normalizePhone(source["Business Phone"]),
      business_phone_2: normalizePhone(source["Business Phone 2"]),
      other_phone: normalizePhone(source["Other Phone"]),
      email_1: (source["E-mail Address"] || "").trim(),
      email_2: (source["E mail 2 Address"] || "").trim(),
      notes: null,
      favorite: false,
    }
    return {
      ...row,
      source_key: buildSourceKey(row),
      search_text: buildSearchText(row),
    }
  }).filter((row) => row.full_name)

  const { error: deleteError } = await supabase.from("phonebook_contacts").delete().not("id", "is", null)
  if (deleteError) throw deleteError
  const { error: deleteCompaniesError } = await supabase.from("phonebook_companies").delete().not("id", "is", null)
  if (deleteCompaniesError) throw deleteCompaniesError

  const uniqueRows = Array.from(
    new Map(rows.map((row) => [row.source_key, row])).values(),
  )

  const companies = Array.from(
    new Map(
      uniqueRows
        .map((row) => (row.company || "").trim())
        .filter(Boolean)
        .map((name) => [
          companySourceKey(name),
          {
            name,
            phone: null,
            address: null,
            email: null,
            notes: null,
            source_key: companySourceKey(name),
          },
        ]),
    ).values(),
  )

  for (let i = 0; i < companies.length; i += 200) {
    const chunk = companies.slice(i, i + 200)
    const { error } = await supabase.from("phonebook_companies").upsert(chunk, { onConflict: "source_key" })
    if (error) throw error
  }

  for (let i = 0; i < uniqueRows.length; i += 200) {
    const chunk = uniqueRows.slice(i, i + 200)
    const { error } = await supabase
      .from("phonebook_contacts")
      .upsert(chunk, { onConflict: "source_key" })
    if (error) throw error
    console.log(`Imported ${Math.min(i + chunk.length, uniqueRows.length)}/${uniqueRows.length}`)
  }

  console.log(`Imported ${uniqueRows.length} unique phonebook contacts.`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
