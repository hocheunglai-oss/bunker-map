import fs from "node:fs/promises"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { createClient } from "@supabase/supabase-js"

const execFileAsync = promisify(execFile)

const DRIVE_ROOT = "/Volumes/T7 Shield"
const COMPANY_ROOT = path.join(DRIVE_ROOT, "- Company Information")

const env = await loadEnv(path.join(process.cwd(), ".env.local"))

const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL
const supabaseKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY

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
    const value = line.slice(idx + 1).trim()
    pairs[key] = value
  }
  return pairs
}

function normalizeWhitespace(value) {
  return value.replace(/\u0000/g, "").replace(/[ \t]+/g, " ").trim()
}

function normalizeDocumentText(value) {
  return value
    .replace(/\u0000/g, "")
    .replace(/\r/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim()
}

function formatName(folderName) {
  return normalizeWhitespace(
    folderName
      .replace(/^!+/, "")
      .toLowerCase()
      .replace(/\b\w/g, (char) => char.toUpperCase())
  )
}

async function safeReaddir(dirPath, options = { withFileTypes: true }) {
  try {
    return await fs.readdir(dirPath, options)
  } catch {
    return []
  }
}

async function collectWordFiles(rootDir) {
  const results = []

  async function walk(currentDir) {
    const entries = await safeReaddir(currentDir)
    for (const entry of entries) {
      if (entry.name.startsWith("._")) continue
      const fullPath = path.join(currentDir, entry.name)
      if (entry.isDirectory()) {
        await walk(fullPath)
      } else if (/\.(docx|doc)$/i.test(entry.name)) {
        results.push(fullPath)
      }
    }
  }

  await walk(rootDir)
  return results
}

async function extractWordText(filePath) {
  try {
    const { stdout } = await execFileAsync("/usr/bin/textutil", [
      "-convert",
      "txt",
      "-stdout",
      filePath,
    ])
    return normalizeDocumentText(stdout)
  } catch {
    return ""
  }
}

async function buildCompanyRecords(onRecord) {
  const entries = (await safeReaddir(COMPANY_ROOT))
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))

  const records = []
  let processed = 0

  for (const entry of entries) {
    const folderName = entry.name
    const fullPath = path.join(COMPANY_ROOT, folderName)
    const name = formatName(folderName)
    const wordFiles = await collectWordFiles(fullPath)

    let info = "No info"

    if (wordFiles.length > 0) {
      const textBlocks = []
      for (const filePath of wordFiles) {
        const text = await extractWordText(filePath)
        if (text) textBlocks.push(text)
      }

      if (textBlocks.length > 0) {
        info = textBlocks.join("\n\n-----\n\n")
      }
    }

    const record = {
      name,
      country: null,
      category: "company",
      summary: null,
      notes: info,
      contacts: null,
      tags: [],
      status: "active",
      last_reviewed_at: null,
    }

    records.push(record)
    processed += 1

    if (onRecord) {
      await onRecord(record, processed, entries.length)
    }
  }

  return records
}

async function resetCompanies() {
  while (true) {
    const { data, error } = await supabase
      .from("cc_companies")
      .select("id")
      .range(0, 499)

    if (error) throw error
    if (!data || data.length === 0) break

    const ids = data.map((item) => item.id)
    const { error: deleteError } = await supabase
      .from("cc_companies")
      .delete()
      .in("id", ids)

    if (deleteError) throw deleteError
  }
}

async function insertCompanyRecord(record) {
  const { error } = await supabase.from("cc_companies").insert(record)
  if (error) throw error
}

async function main() {
  console.log("Scanning company archive...")
  console.log("Resetting cc_companies and importing fresh records...")
  await resetCompanies()
  const records = await buildCompanyRecords(async (record, processed, total) => {
    await insertCompanyRecord(record)
    if (processed % 50 === 0 || processed === total) {
      console.log(`Imported ${processed}/${total}`)
    }
  })
  console.log(`Built ${records.length} company info records`)
  console.log("Done.")
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
