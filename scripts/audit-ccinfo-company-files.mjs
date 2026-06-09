import fs from "node:fs/promises"
import path from "node:path"
import { createClient } from "@supabase/supabase-js"

const DRIVE_ROOT = "/Volumes/T7 Shield"
const COMPANY_ROOT = path.join(DRIVE_ROOT, "- Company Information")
const env = await loadEnv(path.join(process.cwd(), ".env.local"))

const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL
const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY || env.NEXT_PUBLIC_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseKey) {
  console.error("Missing Supabase env vars in .env.local")
  process.exit(1)
}

const supabase = createClient(supabaseUrl, supabaseKey)

async function loadEnv(filePath) {
  const raw = await fs.readFile(filePath, "utf8")
  const pairs = {}
  for (const line of raw.split("\n")) {
    if (!line || line.trim().startsWith("#")) continue
    const idx = line.indexOf("=")
    if (idx === -1) continue
    const key = line.slice(0, idx).trim()
    let value = line.slice(idx + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    pairs[key] = value
  }
  return pairs
}

function normalizeWhitespace(value) {
  return value.replace(/\u0000/g, "").replace(/[ \t]+/g, " ").trim()
}

function formatName(folderName) {
  return normalizeWhitespace(
    folderName
      .replace(/^!+/, "")
      .toLowerCase()
      .replace(/\b\w/g, (char) => char.toUpperCase()),
  )
}

function nameKey(value) {
  return normalizeWhitespace(value).toUpperCase()
}

function shouldSkipEntry(name) {
  const lower = name.toLowerCase()
  return (
    name.startsWith("._") ||
    name.startsWith("~$") ||
    name === ".DS_Store" ||
    lower === "thumbs.db" ||
    lower.endsWith(".tmp")
  )
}

async function safeReaddir(dirPath, options = { withFileTypes: true }) {
  try {
    return await fs.readdir(dirPath, options)
  } catch {
    return []
  }
}

async function collectFiles(rootDir) {
  const files = []

  async function walk(currentDir) {
    const entries = await safeReaddir(currentDir)
    for (const entry of entries) {
      if (shouldSkipEntry(entry.name)) continue
      const fullPath = path.join(currentDir, entry.name)
      if (entry.isDirectory()) {
        await walk(fullPath)
      } else {
        try {
          await fs.access(fullPath)
          files.push(fullPath)
        } catch {
          console.warn(`Skipping unreadable local file: ${fullPath}`)
        }
      }
    }
  }

  await walk(rootDir)
  return files.sort((a, b) => a.localeCompare(b))
}

async function fetchAll(table, select, order = "name") {
  const rows = []
  const batchSize = 1000
  let from = 0

  while (true) {
    const query = supabase.from(table).select(select).range(from, from + batchSize - 1)
    if (order) query.order(order, { ascending: true })
    const { data, error } = await query
    if (error) throw error
    const batch = data || []
    rows.push(...batch)
    if (batch.length < batchSize) break
    from += batchSize
  }

  return rows
}

async function main() {
  const entries = (await safeReaddir(COMPANY_ROOT))
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))

  const companies = await fetchAll("cc_companies", "id,name")
  const companyFiles = await fetchAll("cc_company_files", "id,company_id,file_name,original_path,drive_file_id,drive_url,deleted_at", "original_path")
  const companyByName = new Map(companies.map((company) => [nameKey(company.name), company]))
  const fileKeys = new Set(companyFiles.map((file) => `${file.company_id}:${file.original_path}`))

  const missing = []
  const localKeys = new Set()
  const companySummaries = []

  for (const entry of entries) {
    const companyName = formatName(entry.name)
    const company = companyByName.get(nameKey(companyName))
    const companyDir = path.join(COMPANY_ROOT, entry.name)
    const files = await collectFiles(companyDir)
    const nestedFolders = new Set(
      files
        .map((filePath) => path.dirname(path.relative(companyDir, filePath)))
        .filter((folderPath) => folderPath && folderPath !== "."),
    )

    if (!company) {
      companySummaries.push({ companyName, localFiles: files.length, dbFiles: 0, nestedFolders: nestedFolders.size, missing: files.length, missingCompany: true })
      missing.push(...files.slice(0, 20).map((filePath) => ({ companyName, filePath, reason: "missing company record" })))
      continue
    }

    const companyDbFiles = companyFiles.filter((file) => file.company_id === company.id && !file.deleted_at)
    let companyMissing = 0
    for (const filePath of files) {
      localKeys.add(`${company.id}:${filePath}`)
      if (!fileKeys.has(`${company.id}:${filePath}`)) {
        companyMissing += 1
        missing.push({ companyName, filePath, reason: "missing file link" })
      }
    }
    companySummaries.push({
      companyName,
      localFiles: files.length,
      dbFiles: companyDbFiles.length,
      nestedFolders: nestedFolders.size,
      missing: companyMissing,
      missingCompany: false,
    })
  }

  const orphaned = companyFiles.filter((file) => file.original_path && !localKeys.has(`${file.company_id}:${file.original_path}`))
  const important = companySummaries.filter((item) => ["SGS", "TAIMIN PETROLEUM"].includes(nameKey(item.companyName)))
  const companiesWithMissing = companySummaries.filter((item) => item.missing > 0)

  console.log(JSON.stringify({
    scannedAt: new Date().toISOString(),
    localCompanyFolders: entries.length,
    supabaseCompanies: companies.length,
    localFiles: companySummaries.reduce((sum, item) => sum + item.localFiles, 0),
    supabaseFileRows: companyFiles.length,
    companiesWithMissing: companiesWithMissing.length,
    missingFiles: missing.length,
    orphanedRows: orphaned.length,
    important,
    missingExamples: missing.slice(0, 40),
    orphanedExamples: orphaned.slice(0, 20).map((file) => ({
      company_id: file.company_id,
      file_name: file.file_name,
      original_path: file.original_path,
      deleted_at: file.deleted_at,
    })),
  }, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
