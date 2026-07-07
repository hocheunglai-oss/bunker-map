import { NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 60

type SheetRow = string[]
type FuelKey = "hsfo" | "vlsfo" | "lsmgo"

type SpcUserRow = {
  id: string
  username: string
  display_name: string | null
  role: string
}

type ImportRow = {
  enquiry_number: string
  title: string
  vessel_name: string | null
  product: string
  quantity: string
  delivery_date: string | null
  supplier_name: string | null
  status: "quoted"
  notes: string
  created_by_username: string
  created_by_display_name: string
  created_at: string
  updated_at: string
  fixture: {
    fixture_status: "completed"
    fixture_date: string
    supplier_trader_user_id: string | null
    supplier_trader_username: string
    supplier_trader_display_name: string
    buyer_trader_user_id: string | null
    buyer_trader_username: string
    buyer_trader_display_name: string
    account: string | null
    commission: string | null
    earliest_eta: string | null
    vessel_name: string | null
    hsfo: string | null
    vlsfo: string | null
    lsmgo: string | null
    supplier_name: string | null
    supplier_key: string | null
    price: string | null
    barging: string | null
    completed_at: string
    completed_by_username: string
    completed_by_display_name: string
    created_at: string
    updated_at: string
  }
  sourceTab: string
  sourceRow: number
  sourceGrade: string
}

type ImportSkipRow = {
  tab: string
  sourceRow: number
  date: string
  vessel: string
}

type ImportTabSummary = {
  tab: string
  sheetRows: number
  dateInWindowRows: number
  outOfWindowRows: number
  cancelledRows: number
  noGradeRows: number
  fixtureRows: number
}

const spreadsheetId = "19KHke2iBFDZzteh8hb0G7B7T-TUMa7wrjB27X2RnFA4"
const importTabs = [
  { name: "2024JUN-2025MAY", startYear: 2024, code: "2024JUN2025MAY" },
  { name: "2025JUN-2026MAY", startYear: 2025, code: "2025JUN2026MAY" },
]
const monthLabels = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"]
const monthMap = new Map(monthLabels.map((month, index) => [month, index + 1]))
const fuelColumns: Array<{ key: FuelKey; column: number; label: string }> = [
  { key: "hsfo", column: 9, label: "HSFO" },
  { key: "vlsfo", column: 10, label: "VLSFO" },
  { key: "lsmgo", column: 11, label: "LSMGO" },
]
const supplierAliases: Record<string, string> = {
  BP: "BP MARINE",
  BPSINOPEC: "BP - SINOPEC",
  "BP SINOPEC": "BP - SINOPEC",
  CHIMBUSCCO: "CHIMBUSCO",
  "CHIMBUSCCO PAN NATION": "CHIMBUSCO PAN-NATION",
  "CHIMBUSCCO PAN NATION SG": "CHIMBUSCO PAN-NATION",
  "CHIMBUSCO PAN NATION": "CHIMBUSCO PAN-NATION",
  "CHIMBUSCO PAN NATION SG": "CHIMBUSCO PAN-NATION",
  "CHIMBUSCO SG": "PETRO-CHINA",
  EASTPEC: "EASTPAC",
  EXXON: "EXXONMOBIL",
  "GLOBAL MARINE": "GLOBAL MARINE TRANSPORTATION",
  "GLOBAL MARINE FC BDN": "GLOBAL MARINE TRANSPORTATION",
  "GLOBAL MARINE TRANSPORT": "GLOBAL MARINE TRANSPORTATION",
  GMT: "GLOBAL MARINE TRANSPORTATION",
  HAIYIN: "HAI YIN",
  "ITG XIANG YU": "OPULENT",
  "MGO GO": "CNC PETROLEUM",
  "MONJASA EASTPAC": "EASTPAC",
  OPPULENT: "OPULENT",
  "PETRO CHINA": "PETRO-CHINA",
  PETROCHINA: "PETRO-CHINA",
  "PETROCHINA CHIMBUSCO SG": "PETRO-CHINA",
  "SENTEK SINGFAR": "SENTEK",
  "SENTEK SINGFAR SFI ENERGY": "SENTEK",
  "SFI ENERGY EX SINGFAR": "SENTEK",
  "SFI ENERGY": "SENTEK",
  "TFG MARINE": "TFG MARINE",
  "TIMES MARINE": "TIMES MARINE",
  VITOL: "VITOL",
}

function requireEnv(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing environment variable: ${name}`)
  return value
}

function cleanText(value: unknown) {
  return String(value ?? "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim()
}

function upperText(value: unknown) {
  return cleanText(value).toUpperCase()
}

function pad(value: number, size = 2) {
  return String(value).padStart(size, "0")
}

function parseCsv(csv: string): SheetRow[] {
  const rows: SheetRow[] = []
  let row: string[] = []
  let value = ""
  let quoted = false

  for (let index = 0; index < csv.length; index += 1) {
    const char = csv[index]
    const next = csv[index + 1]

    if (quoted) {
      if (char === '"' && next === '"') {
        value += '"'
        index += 1
      } else if (char === '"') {
        quoted = false
      } else {
        value += char
      }
      continue
    }

    if (char === '"') quoted = true
    else if (char === ",") {
      row.push(value)
      value = ""
    } else if (char === "\n") {
      row.push(value.replace(/\r$/, ""))
      rows.push(row)
      row = []
      value = ""
    } else {
      value += char
    }
  }

  if (value || row.length) {
    row.push(value.replace(/\r$/, ""))
    rows.push(row)
  }

  return rows
}

async function fetchSheetRows(sheetName: string) {
  const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}`
  const response = await fetch(url, { cache: "no-store" })
  if (!response.ok) throw new Error(`Could not read ${sheetName}.`)
  return parseCsv(await response.text())
}

function parseDate(value: unknown, startYear: number) {
  const text = cleanText(value).replace(/[,]/g, "")
  if (!text) return null

  let match = text.match(/^(\d{1,2})[\s/-]+([A-Za-z]{3,})[\s/-]+(\d{2,4})$/)
  if (match) {
    const day = Number(match[1])
    const month = monthMap.get(match[2].slice(0, 3).toUpperCase())
    let year = Number(match[3])
    if (year < 100) year += 2000
    return day >= 1 && day <= 31 && month ? `${year}-${pad(month)}-${pad(day)}` : null
  }

  match = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/)
  if (match) {
    const day = Number(match[1])
    const month = Number(match[2])
    let year = Number(match[3])
    if (year < 100) year += 2000
    return day >= 1 && day <= 31 && month >= 1 && month <= 12 ? `${year}-${pad(month)}-${pad(day)}` : null
  }

  match = text.match(/^(\d{1,2})\s+([A-Za-z]{3,})$/)
  if (match) {
    const day = Number(match[1])
    const month = monthMap.get(match[2].slice(0, 3).toUpperCase())
    const year = month && month >= 6 ? startYear : startYear + 1
    return day >= 1 && day <= 31 && month ? `${year}-${pad(month)}-${pad(day)}` : null
  }

  const date = new Date(text)
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10)
}

function parseEtaToDate(value: unknown, fixtureDate: string) {
  const text = cleanText(value).replace(/[,]/g, "")
  if (!text || !fixtureDate) return null

  const fixtureYear = Number(fixtureDate.slice(0, 4))
  const fixtureMonth = Number(fixtureDate.slice(5, 7))
  const matches = [...text.matchAll(/(\d{1,2})\s+([A-Za-z]{3,})(?:\s+(\d{2,4}))?/g)]
  const match = matches[matches.length - 1]
  if (!match) return null

  const day = Number(match[1])
  const month = monthMap.get(match[2].slice(0, 3).toUpperCase())
  if (!month || day < 1 || day > 31) return null

  let year = match[3] ? Number(match[3]) : fixtureYear
  if (year < 100) year += 2000
  if (!match[3] && fixtureMonth === 12 && month === 1) year += 1
  return `${year}-${pad(month)}-${pad(day)}`
}

function normalizeEta(value: unknown) {
  return upperText(value)
    .replace(/[–—]/g, "-")
    .replace(/[,]/g, "")
    .replace(/\s+\d{4}\b/g, "")
    .replace(/(\d{1,2})\s+([A-Z]{3})[A-Z]*/g, (_, day, month) => `${Number(day)} ${month}`)
    .replace(/\s+/g, " ")
    .trim()
}

function numberToken(value: unknown) {
  const cleaned = cleanText(value).replace(/[^\d.]/g, "")
  if (!cleaned) return ""
  const number = Number(cleaned)
  if (!Number.isFinite(number)) return cleaned
  const [intPart, decimalRaw = ""] = cleaned.split(".")
  const intFormatted = String(Number(intPart || "0")).replace(/\B(?=(\d{3})+(?!\d))/g, ",")
  const decimal = decimalRaw.replace(/0+$/, "")
  return decimal ? `${intFormatted}.${decimal}` : intFormatted
}

function normalizeNumericText(value: unknown) {
  const text = cleanText(value).replace(/[–—]/g, "-").replace(/\s*mts?\b/gi, "")
  if (!text) return ""
  const parts = text.split("-")
  if (parts.length > 1) return parts.map(numberToken).filter(Boolean).join("-")
  return numberToken(text)
}

function hasCancelled(row: SheetRow) {
  return row.some((cell) => /\bcancell?ed\b/i.test(cleanText(cell)))
}

function hasQuantity(value: unknown) {
  return /\d/.test(cleanText(value))
}

function supplierBase(value: unknown) {
  return cleanText(value).replace(/\s*>>.*$/i, "").replace(/\s+/g, " ").trim()
}

function normaliseSupplierToken(value: unknown) {
  return supplierBase(value)
    .replace(/\([^)]*\)/g, " ")
    .replace(/&/g, " AND ")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .replace(/\bPTE\b|\bLTD\b|\bLIMITED\b|\bSINGAPORE\b/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase()
}

function canonicalSupplierName(value: unknown) {
  const token = normaliseSupplierToken(value)
  return supplierAliases[token] || token
}

function supplierKey(value: unknown) {
  return canonicalSupplierName(value).replace(/[^A-Z0-9]+/g, "")
}

function displaySupplierName(value: unknown) {
  return supplierBase(value).replace(/\s+/g, " ").trim().toUpperCase()
}

function compactPic(value: unknown) {
  return upperText(value).replace(/\([^)]*\)/g, " ").replace(/[^A-Z0-9]+/g, " ").trim().split(/\s+/)[0] || ""
}

function firstName(value: unknown) {
  return upperText(value).split(/\s+/)[0] || ""
}

function officeSuffix(user: SpcUserRow) {
  const username = user.username.toLowerCase()
  if (username.endsWith(".hk")) return "HK"
  if (username.endsWith(".sg")) return "SG"
  if (username.endsWith(".it")) return "IT"
  if (username.endsWith(".mc")) return "MC"
  if (username.endsWith(".gr")) return "GR"
  if (username.endsWith(".com")) return "US"
  return ""
}

function codeDisplay(user: SpcUserRow, fallbackPic: unknown) {
  const first = firstName(user.display_name || fallbackPic)
  const suffix = officeSuffix(user)
  return suffix ? `${first}-${suffix}` : first
}

function resolveUser(users: SpcUserRow[], pic: unknown) {
  const code = compactPic(pic)
  if (!code) return null

  const exactUsername = users.find((user) => user.username.toLowerCase().split("@")[0] === code.toLowerCase())
  if (exactUsername) return exactUsername

  const exactFirst = users.filter((user) => firstName(user.display_name || user.username) === code)
  if (exactFirst.length === 1) return exactFirst[0]

  const prefixFirst = users.filter((user) => {
    const first = firstName(user.display_name || user.username)
    return first.startsWith(code) || code.startsWith(first)
  })
  return prefixFirst.length === 1 ? prefixFirst[0] : null
}

function sourceNote(row: ImportRow) {
  return {
    sourceTab: row.sourceTab,
    sourceRow: row.sourceRow,
    sourceGrade: row.sourceGrade,
    enquiryNumber: row.enquiry_number,
  }
}

async function buildImportRows(users: SpcUserRow[]) {
  const rows: ImportRow[] = []
  const summary: ImportTabSummary[] = []
  const cancelledRows: ImportSkipRow[] = []
  const noGradeRows: ImportSkipRow[] = []
  const unresolvedSupplierTraders = new Map<string, number>()
  const unresolvedBuyers = new Map<string, number>()
  const missingSupplierRows: ReturnType<typeof sourceNote>[] = []
  const missingPriceRows: ReturnType<typeof sourceNote>[] = []

  for (const tab of importTabs) {
    const sheetRows = (await fetchSheetRows(tab.name)).slice(1)
    const tabSummary = {
      tab: tab.name,
      sheetRows: sheetRows.length,
      dateInWindowRows: 0,
      outOfWindowRows: 0,
      cancelledRows: 0,
      noGradeRows: 0,
      fixtureRows: 0,
    }

    sheetRows.forEach((sheetRow, index) => {
      const sourceRow = index + 2
      if (sheetRow.every((cell) => !cleanText(cell))) return

      const fixtureDate = parseDate(sheetRow[0], tab.startYear)
      const year = fixtureDate ? Number(fixtureDate.slice(0, 4)) : 0
      if (!fixtureDate || year < 2025 || year > 2026) {
        tabSummary.outOfWindowRows += 1
        return
      }

      tabSummary.dateInWindowRows += 1
      if (hasCancelled(sheetRow)) {
        tabSummary.cancelledRows += 1
        cancelledRows.push({ tab: tab.name, sourceRow, date: fixtureDate, vessel: cleanText(sheetRow[8]) })
        return
      }

      const activeGrades = fuelColumns.filter((grade) => hasQuantity(sheetRow[grade.column]))
      if (activeGrades.length === 0) {
        tabSummary.noGradeRows += 1
        noGradeRows.push({ tab: tab.name, sourceRow, date: fixtureDate, vessel: cleanText(sheetRow[8]) })
        return
      }

      const supplierTrader = resolveUser(users, sheetRow[2])
      const buyerTrader = resolveUser(users, sheetRow[4])
      if (!supplierTrader) {
        const key = cleanText(sheetRow[2]) || "(blank)"
        unresolvedSupplierTraders.set(key, (unresolvedSupplierTraders.get(key) || 0) + activeGrades.length)
      }
      if (!buyerTrader) {
        const key = cleanText(sheetRow[4]) || "(blank)"
        unresolvedBuyers.set(key, (unresolvedBuyers.get(key) || 0) + activeGrades.length)
      }

      activeGrades.forEach((grade) => {
        const quantity = normalizeNumericText(sheetRow[grade.column])
        const supplierName = displaySupplierName(sheetRow[12])
        const supplier_key = supplierKey(supplierName) || null
        const eta = normalizeEta(sheetRow[7])
        const vesselName = upperText(sheetRow[8]) || null
        const hsfo = grade.key === "hsfo" ? quantity : null
        const vlsfo = grade.key === "vlsfo" ? quantity : null
        const lsmgo = grade.key === "lsmgo" ? quantity : null
        const price = normalizeNumericText(sheetRow[13])
        const barging = normalizeNumericText(sheetRow[14])
        const createdAt = `${fixtureDate}T00:00:00+08:00`

        const row: ImportRow = {
          enquiry_number: `SPCIMP-${tab.code}-${pad(sourceRow, 4)}-${grade.label}`,
          title: vesselName || `${grade.label} ${quantity}`,
          vessel_name: vesselName,
          product: `${grade.label} ${quantity}MTS`,
          quantity,
          delivery_date: parseEtaToDate(sheetRow[7], fixtureDate),
          supplier_name: supplierName || null,
          status: "quoted",
          notes: [
            "spc-fixture-sheet-import",
            `${(vesselName || "UNKNOWN VESSEL").toLowerCase()} / ${eta.toLowerCase()} / ${grade.label.toLowerCase()} ${quantity}mts${supplierName ? ` / ${supplierName.toLowerCase()}` : ""}`,
            "",
            "---SPC_META---",
            JSON.stringify({
              outcomeAt: createdAt,
              stemSupplierTraderUsername: supplierTrader?.username || "",
              stemSupplierTraderDisplayName: supplierTrader ? codeDisplay(supplierTrader, sheetRow[2]) : upperText(sheetRow[2]),
              fixtureSupplier: supplierName,
              eta,
              hsfo: hsfo || "",
              vlsfo: vlsfo || "",
              lsmgo: lsmgo || "",
              price,
              barging,
              source: tab.name,
              sourceRow,
              sourceGrade: grade.label,
            }),
          ].join("\n"),
          created_by_username: buyerTrader?.username || "fixture-import",
          created_by_display_name: buyerTrader ? codeDisplay(buyerTrader, sheetRow[4]) : upperText(sheetRow[4]) || "UNKNOWN",
          created_at: createdAt,
          updated_at: createdAt,
          fixture: {
            fixture_status: "completed",
            fixture_date: fixtureDate,
            supplier_trader_user_id: supplierTrader?.id || null,
            supplier_trader_username: supplierTrader?.username || "fixture-import",
            supplier_trader_display_name: supplierTrader ? codeDisplay(supplierTrader, sheetRow[2]) : upperText(sheetRow[2]) || "UNKNOWN",
            buyer_trader_user_id: buyerTrader?.id || null,
            buyer_trader_username: buyerTrader?.username || "fixture-import",
            buyer_trader_display_name: buyerTrader ? codeDisplay(buyerTrader, sheetRow[4]) : upperText(sheetRow[4]) || "UNKNOWN",
            account: upperText(sheetRow[5]) || null,
            commission: null,
            earliest_eta: eta || null,
            vessel_name: vesselName,
            hsfo,
            vlsfo,
            lsmgo,
            supplier_name: supplierName || null,
            supplier_key,
            price: price || null,
            barging: barging || null,
            completed_at: createdAt,
            completed_by_username: "fixture-import",
            completed_by_display_name: "Fixture Import",
            created_at: createdAt,
            updated_at: createdAt,
          },
          sourceTab: tab.name,
          sourceRow,
          sourceGrade: grade.label,
        }

        if (!supplierName) missingSupplierRows.push(sourceNote(row))
        if (!price) missingPriceRows.push(sourceNote(row))
        rows.push(row)
        tabSummary.fixtureRows += 1
      })
    })

    summary.push(tabSummary)
  }

  return {
    rows,
    summary,
    cancelledRows,
    noGradeRows,
    unresolvedSupplierTraders: Object.fromEntries(unresolvedSupplierTraders),
    unresolvedBuyers: Object.fromEntries(unresolvedBuyers),
    missingSupplierRows,
    missingPriceRows,
  }
}

function chunkRows<T>(rows: T[], size: number) {
  const chunks: T[][] = []
  for (let index = 0; index < rows.length; index += size) chunks.push(rows.slice(index, index + size))
  return chunks
}

async function upsertHistoricalRows(rows: ImportRow[]) {
  const supabase = createClient(requireEnv("NEXT_PUBLIC_SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false },
  })

  const { data: existingSuppliers, error: supplierLoadError } = await supabase.from("spc_suppliers").select("key")
  if (supplierLoadError) throw supplierLoadError
  const supplierSet = new Set((existingSuppliers || []).map((supplier) => supplier.key))
  const supplierPayload = Array.from(
    new Map(
      rows
        .filter((row) => row.fixture.supplier_key && row.fixture.supplier_name && !supplierSet.has(row.fixture.supplier_key))
        .map((row) => [row.fixture.supplier_key, row.fixture.supplier_name]),
    ).entries(),
  ).map(([key, name]) => ({
    key,
    name,
    aliases: [name],
    notes: "Imported from SPC fixture sheets",
    created_by_username: "fixture-import",
    updated_by_username: "fixture-import",
  }))

  let suppliersInserted = 0
  for (const chunk of chunkRows(supplierPayload, 100)) {
    if (chunk.length === 0) continue
    const { error } = await supabase.from("spc_suppliers").insert(chunk)
    if (error) throw error
    suppliersInserted += chunk.length
  }

  let enquiriesUpserted = 0
  let fixturesUpserted = 0
  for (const chunk of chunkRows(rows, 100)) {
    const enquiryPayload = chunk.map(({ fixture: _fixture, sourceTab: _sourceTab, sourceRow: _sourceRow, sourceGrade: _sourceGrade, ...row }) => row)
    const { data: enquiries, error: enquiryError } = await supabase
      .from("spc_enquiries")
      .upsert(enquiryPayload, { onConflict: "enquiry_number" })
      .select("id,enquiry_number")
    if (enquiryError) throw enquiryError

    enquiriesUpserted += enquiries?.length || 0
    const enquiryIds = new Map((enquiries || []).map((enquiry) => [enquiry.enquiry_number, enquiry.id]))
    const fixturePayload = chunk.map((row) => ({
      ...row.fixture,
      enquiry_id: enquiryIds.get(row.enquiry_number),
    })).filter((fixture) => fixture.enquiry_id)

    const { data: fixtures, error: fixtureError } = await supabase
      .from("spc_fixtures")
      .upsert(fixturePayload, { onConflict: "enquiry_id" })
      .select("id")
    if (fixtureError) throw fixtureError
    fixturesUpserted += fixtures?.length || 0
  }

  return { suppliersInserted, enquiriesUpserted, fixturesUpserted }
}

async function loadUsers() {
  const supabase = createClient(requireEnv("NEXT_PUBLIC_SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false },
  })
  const { data, error } = await supabase
    .from("spc_users")
    .select("id,username,display_name,role")
    .eq("is_active", true)
  if (error) throw error
  return (data || []) as SpcUserRow[]
}

export async function POST(request: Request) {
  try {
    const url = new URL(request.url)
    if (url.searchParams.get("confirm") !== "2025-2026") {
      return NextResponse.json({ message: "Not found." }, { status: 404 })
    }

    const apply = url.searchParams.get("apply") === "1"
    const users = await loadUsers()
    const parsed = await buildImportRows(users)
    const writeResult = apply ? await upsertHistoricalRows(parsed.rows) : null

    return NextResponse.json({
      apply,
      spreadsheetId,
      tabs: importTabs.map((tab) => tab.name),
      totalFixtureRows: parsed.rows.length,
      byYear: parsed.rows.reduce<Record<string, number>>((counts, row) => {
        const year = row.fixture.fixture_date.slice(0, 4)
        counts[year] = (counts[year] || 0) + 1
        return counts
      }, {}),
      summary: parsed.summary,
      skipped: {
        cancelledRows: parsed.cancelledRows,
        noGradeRows: parsed.noGradeRows.length,
      },
      unresolved: {
        supplierTraders: parsed.unresolvedSupplierTraders,
        buyers: parsed.unresolvedBuyers,
      },
      missing: {
        supplierRows: parsed.missingSupplierRows,
        priceRows: parsed.missingPriceRows,
      },
      sample: parsed.rows.slice(0, 5).map((row) => ({
        enquiryNumber: row.enquiry_number,
        date: row.fixture.fixture_date,
        vessel: row.vessel_name,
        product: row.product,
        supplier: row.supplier_name,
        price: row.fixture.price,
        supplierTrader: row.fixture.supplier_trader_display_name,
        buyerTrader: row.fixture.buyer_trader_display_name,
      })),
      writeResult,
    })
  } catch (error) {
    return NextResponse.json(
      { message: error instanceof Error ? error.message : "Historical fixture import failed." },
      { status: 500 },
    )
  }
}
