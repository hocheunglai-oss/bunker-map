import fs from "fs"
import { execFileSync } from "child_process"
import { createClient } from "@supabase/supabase-js"

function loadEnv() {
  return Object.fromEntries(
    fs
      .readFileSync(".env.local", "utf8")
      .split("\n")
      .filter(Boolean)
      .filter((line) => !line.trim().startsWith("#"))
      .map((line) => {
        const i = line.indexOf("=")
        return [line.slice(0, i).trim(), line.slice(i + 1).trim().replace(/^['"]|['"]$/g, "")]
      }),
  )
}

const env = loadEnv()
const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY)

const sourcePath = "/Volumes/T7 Shield/- Country Information/JAPAN/!JAPAN - GENERAL INFO.doc"

const blockedExact = new Set([
  "GENERAL INFORMATION",
  "PORT INFORMATION",
  "LPG VSLS",
  "TOKYO BAY",
  "OSAKA BAY",
])

const blockedStarts = [
  "BARGE FROM",
  "ONLY ",
  "HELIOS ",
  "UNIVERSAL ",
  "TOKYO PRICE",
  "TOKYO BAY PRICE",
  "TOKYO BAY PRICES",
  "OSAKA BAY PRICE",
  "OSAKA BAY PRICES",
  "NAGOYA PRICE",
  "MAIN PORT PRICE",
  "SEE LPG",
  "EQUIPPED ",
  "OPPOSITE ",
  "PORT NAME =",
  "DEFAULT ",
  "SINANEN:",
  "KAMEI:",
  "JXTG ",
  "MC ENERGY ",
  "MITSUI ",
  "MITSUBISHI ",
  "PACIFIC ",
  "MR/LR/",
  "SUBJECT ",
  "CLOSE TO",
  "LOCATED ",
  "HIGHLY ",
  "2 BERTHS",
  "SUPPLY ",
  "ANCHORAGE ",
  "TANKER ",
  "NO SUPPLY",
  "NO BUNKER",
  "NO FACILITY",
  "DOMESTIC ",
  "PART OF ",
  "NEAR ",
  "IN SHIZUOKA",
  "WEST KYUSHU",
  "KYUSHU ",
  "ALL GRADES",
  "IF380",
  "VLSFO/",
  "MIN ",
  "B/O ",
  "DELY ",
  "SHIN KASADO",
  "HITOCHI ",
  "SUMITOMO ",
  "RYUSEKI ",
  "CHEMICAL ",
]

const monthPattern = /^(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\s+\d{1,2}$/i
const headingPattern = /^[A-Z0-9][A-Z0-9()\/\- ,'&.=]+$/

function normalizeWhitespace(text) {
  return text.replace(/\u2028|\u2029/g, "").replace(/\r/g, "").replace(/[ \t]+$/g, "")
}

function isPortHeading(rawLine, trimmed) {
  if (!trimmed || blockedExact.has(trimmed)) return false
  if (/^\s/.test(rawLine)) return false
  if (!headingPattern.test(trimmed)) return false
  if (trimmed.includes(":")) return false
  if (/[\u4e00-\u9fff]/.test(trimmed)) return false
  if (blockedStarts.some((start) => trimmed.startsWith(start))) return false
  const words = trimmed.split(/\s+/).filter(Boolean)
  if (words.length > 3) return false
  return true
}

function toTitleCase(value) {
  return value
    .toLowerCase()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .replace(/\bVsls\b/g, "VSLS")
    .replace(/\bLng\b/g, "LNG")
    .replace(/\bLpg\b/g, "LPG")
}

function extractJapanDraft() {
  const raw = execFileSync("textutil", ["-convert", "txt", "-stdout", sourcePath], { encoding: "utf8" })
  const text = normalizeWhitespace(raw)
  const [beforePorts, afterPorts = ""] = text.split(/\bPORT INFORMATION\b/)

  const countryInfo = beforePorts.replace(/^GENERAL INFORMATION\s*/i, "").trim()

  const lines = afterPorts.split("\n")
  const ports = []
  let current = null

  for (const rawLine of lines) {
    const cleanLine = normalizeWhitespace(rawLine)
    const trimmed = cleanLine.trim()
    if (!trimmed) continue

    if (monthPattern.test(trimmed)) {
      if (current) current.updatedDates.push(trimmed.toUpperCase().replace(/\s+/g, " "))
      continue
    }

    if (isPortHeading(rawLine, trimmed)) {
      if (current) ports.push(current)
      current = {
        name: toTitleCase(trimmed),
        information: [],
        updatedDates: [],
      }
      continue
    }

    if (!current) continue
    current.information.push(trimmed)
  }

  if (current) ports.push(current)

  const cleanedPorts = ports.filter((port) => {
    const normalized = port.name.toUpperCase()
    if (blockedExact.has(normalized)) return false
    if (blockedStarts.some((start) => normalized.startsWith(start))) return false
    return true
  })

  return {
    country: {
      name: "Japan",
      information: countryInfo,
    },
    ports: cleanedPorts.map((port) => ({
      name: port.name,
      information: port.information.join(" ").replace(/\s+/g, " ").trim() || "No information yet",
      updatedDates: port.updatedDates.join(", ") || "No date found",
    })),
  }
}

function writeReviewFile(draft) {
  const lines = []
  lines.push("# Japan Curated Draft")
  lines.push("")
  lines.push(`- Country count: 1`)
  lines.push(`- Port count: ${draft.ports.length}`)
  lines.push("")
  lines.push("## Country")
  lines.push("")
  lines.push(`### ${draft.country.name}`)
  lines.push("")
  lines.push(draft.country.information)
  lines.push("")
  lines.push("## Ports")
  lines.push("")
  for (const port of draft.ports) {
    lines.push(`### ${port.name}`)
    lines.push("")
    lines.push(`- Updated: ${port.updatedDates}`)
    lines.push(`- Information: ${port.information}`)
    lines.push("")
  }
  fs.mkdirSync("notes", { recursive: true })
  fs.writeFileSync("notes/japan-curated-draft.md", lines.join("\n"))
}

async function saveDraft(draft) {
  const { data: countryRow, error: countryError } = await supabase
    .from("cc_countries")
    .insert({
      name: draft.country.name,
      summary: null,
      notes: draft.country.information,
    })
    .select("id")
    .single()

  if (countryError || !countryRow) throw countryError || new Error("Unable to save Japan country")

  const payload = draft.ports.map((port) => ({
    name: port.name,
    country_id: countryRow.id,
    country_name: draft.country.name,
    summary: port.updatedDates,
    notes: port.information,
  }))

  const { error: portsError } = await supabase.from("cc_ports").insert(payload)
  if (portsError) throw portsError
}

const draft = extractJapanDraft()
writeReviewFile(draft)
await saveDraft(draft)
console.log(`Saved Japan draft with ${draft.ports.length} ports`)
