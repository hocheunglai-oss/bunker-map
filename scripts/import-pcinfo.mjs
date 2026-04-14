import fs from "node:fs/promises"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { createClient } from "@supabase/supabase-js"

const execFileAsync = promisify(execFile)

const DRIVE_ROOT = "/Volumes/T7 Shield"
const COUNTRY_ROOT = path.join(DRIVE_ROOT, "- Country Information")

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

async function safeReaddir(dirPath, options = { withFileTypes: true }) {
  try {
    return await fs.readdir(dirPath, options)
  } catch {
    return []
  }
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
    folderName.replace(/^!+/, "").toLowerCase().replace(/\b\w/g, (char) => char.toUpperCase()),
  )
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

function looksLikePortHeading(rawLine) {
  const trimmed = rawLine.trim()
  if (!trimmed) return false
  if (/^\s/.test(rawLine)) return false
  if (trimmed.length > 40) return false
  if (/^(GENERAL INFORMATION|PORT INFORMATION)$/i.test(trimmed)) return false
  if (/^[A-Z]{3}\s+\d{2}$/.test(trimmed)) return false
  if (/^\d/.test(trimmed)) return false
  if (/^(BP|ELF|TOTAL|EMMF|CDH|COCKETT|PETROINEOS|B@S|INEOS|ATLANTIC ENERGY|V MARINE FUELS)$/i.test(trimmed)) return false
  const letters = trimmed.replace(/[^A-Za-z]/g, "")
  if (!letters) return false
  if (trimmed !== trimmed.toUpperCase()) return false
  return true
}

function extractHeadingAndInlineNotes(rawLine) {
  const compact = rawLine.replace(/\r/g, "")
  const split = compact.match(/^([A-Z0-9()'.,\/& -]{2,}?)(?:\t+|\s{2,})(.+)$/)
  if (!split) {
    return {
      heading: compact.trim(),
      inlineNotes: "",
    }
  }
  return {
    heading: split[1].trim(),
    inlineNotes: split[2].trim(),
  }
}

function parseCountryDoc(text) {
  const normalized = text.replace(/\r/g, "").trim()
  const splitMatch = normalized.match(/\nPORT INFORMATION\n/i)

  if (!splitMatch) {
    return {
      countryInfo: normalized,
      ports: [],
    }
  }

  const splitIndex = splitMatch.index ?? normalized.length
  const countryInfo = normalized.slice(0, splitIndex).trim()
  const portSection = normalized.slice(splitIndex + splitMatch[0].length).trim()
  const lines = portSection.split("\n")

  const ports = []
  let currentName = ""
  let currentLines = []

  function pushCurrent() {
    if (!currentName) return
    const notes = currentLines.join("\n").trim()
    ports.push({
      name: formatName(currentName),
      notes: notes || "No info",
    })
  }

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) {
      if (currentLines[currentLines.length - 1] !== "") currentLines.push("")
      continue
    }

    if (looksLikePortHeading(rawLine)) {
      pushCurrent()
      const { heading, inlineNotes } = extractHeadingAndInlineNotes(rawLine)
      currentName = heading
      currentLines = inlineNotes ? [inlineNotes] : []
      continue
    }

    if (currentName) {
      currentLines.push(line)
    }
  }

  pushCurrent()

  return {
    countryInfo,
    ports,
  }
}

async function findGeneralInfoDoc(countryDir) {
  const entries = await safeReaddir(countryDir)
  const generalInfo = entries.find(
    (entry) =>
      entry.isFile() &&
      !entry.name.startsWith("~$") &&
      /general info/i.test(entry.name) &&
      /\.(doc|docx)$/i.test(entry.name),
  )

  return generalInfo ? path.join(countryDir, generalInfo.name) : null
}

async function resetTable(table) {
  while (true) {
    const { data, error } = await supabase.from(table).select("id").range(0, 499)
    if (error) throw error
    if (!data || data.length === 0) break
    const ids = data.map((item) => item.id)
    const { error: deleteError } = await supabase.from(table).delete().in("id", ids)
    if (deleteError) throw deleteError
  }
}

async function main() {
  console.log("Scanning country archive...")
  const entries = (await safeReaddir(COUNTRY_ROOT))
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))

  console.log("Resetting cc_countries and cc_ports...")
  await resetTable("cc_ports")
  await resetTable("cc_countries")

  let countryCount = 0
  let portCount = 0

  for (const entry of entries) {
    const countryDir = path.join(COUNTRY_ROOT, entry.name)
    const countryName = formatName(entry.name)
    const docPath = await findGeneralInfoDoc(countryDir)

    let countryInfo = "No info"
    let ports = []

    if (docPath) {
      const text = await extractWordText(docPath)
      if (text) {
        const parsed = parseCountryDoc(text)
        countryInfo = parsed.countryInfo || "No info"
        ports = parsed.ports
      }
    }

    const { data: countryRow, error: countryError } = await supabase
      .from("cc_countries")
      .insert({
        name: countryName,
        region: null,
        summary: null,
        notes: countryInfo,
        ports: ports.map((port) => port.name).join(", "),
        tags: [],
        status: "active",
        last_reviewed_at: null,
      })
      .select("id")
      .single()

    if (countryError || !countryRow) throw countryError || new Error(`Unable to insert country ${countryName}`)
    countryCount += 1

    for (const port of ports) {
      const { error: portError } = await supabase.from("cc_ports").insert({
        name: port.name,
        country_id: countryRow.id,
        country_name: countryName,
        summary: null,
        notes: port.notes,
        tags: [],
        status: "active",
        last_reviewed_at: null,
      })

      if (portError) throw portError
      portCount += 1
    }

    console.log(`Imported ${countryName} (${ports.length} ports)`)
  }

  console.log(`Done. Countries: ${countryCount}, Ports: ${portCount}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
