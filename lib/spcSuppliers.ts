import { createClient } from "@supabase/supabase-js"
import {
  displaySupplierName,
  supplierKey,
} from "@/lib/spcSupplierKeys"
import { createActiveSpcTraderResolver } from "@/lib/spcActiveTraders"
import type {
  SpcSupplierDataset,
  SpcSupplierFixture,
  SpcSupplierInfo,
  SpcSupplierLegacyFixture,
  SpcSupplierRecord,
} from "@/lib/spcSupplierTypes"
import { listActiveSpcUserOptions, type SpcUserOption } from "@/lib/spcUsers"

const SPREADSHEET_ID = "1lr_WkDeuadBggAWki25qCLcTN76eI_K2lQFh1ZEIX7I"
const SPREADSHEET_URL = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit`
const SHEET_NAME = "Sheet1"

type FuelKey = "hsfo" | "vlsfo" | "lsmgo"
type SheetRow = Array<string | number | boolean | null | undefined>
type SheetRows = SheetRow[]

type FixtureRow = {
  id: string
  fixture_status: string
  fixture_date: string | null
  vessel_name: string | null
  hsfo: string | null
  vlsfo: string | null
  lsmgo: string | null
  supplier_name: string | null
  price: string | null
  barging: string | null
  supplier_trader_username: string | null
  supplier_trader_display_name: string | null
  buyer_trader_username: string | null
  buyer_trader_display_name: string | null
  created_at: string
  enquiry?: {
    enquiry_number: string | null
  } | null
}

type MutableSupplierRecord = Omit<SpcSupplierRecord, "aliases" | "fixtures" | "searchText"> & {
  aliases: Set<string>
  fixtures: SpcSupplierFixture[]
}

const fuelColumns: Array<{ key: FuelKey; label: string }> = [
  { key: "hsfo", label: "HSFO" },
  { key: "vlsfo", label: "VLSFO" },
  { key: "lsmgo", label: "LSMGO" },
]

function cleanText(value: unknown) {
  return String(value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\u00a0/g, " ")
    .trim()
}

function compactText(value: unknown) {
  return cleanText(value).replace(/\s+/g, " ").trim()
}

function cell(row: SheetRow | undefined, index: number) {
  return compactText(row?.[index])
}

function parseCsv(csv: string): SheetRows {
  const rows: SheetRows = []
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

    if (char === '"') {
      quoted = true
    } else if (char === ",") {
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

async function readSupplierSheet() {
  const url = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(SHEET_NAME)}`
  const response = await fetch(url, { cache: "no-store" })
  if (!response.ok) throw new Error("Could not read supplier list from Google Sheets.")
  return parseCsv(await response.text())
}

function emptyInfo(row: SheetRow | undefined, rowNumber: number): SpcSupplierInfo {
  return {
    paymentTerms: cell(row, 1),
    qualityClaimBar: cell(row, 2),
    supplierTrader: cell(row, 3),
    availableGrade: cell(row, 4),
    foBdn: cell(row, 5),
    goBdn: cell(row, 6),
    rowNumber,
  }
}

function buildSupplierRecords(rows: SheetRows) {
  const records = new Map<string, MutableSupplierRecord>()
  rows.slice(1).forEach((row, index) => {
    const name = displaySupplierName(cell(row, 0))
    const key = supplierKey(name)
    if (!key || !name) return
    const existing = records.get(key)
    if (existing) {
      existing.aliases.add(name)
      existing.info = emptyInfo(row, index + 2)
      return
    }
    records.set(key, {
      key,
      name,
      aliases: new Set([name]),
      info: emptyInfo(row, index + 2),
      fixtures: [],
      updatedAt: new Date().toISOString(),
    })
  })
  return records
}

function parseGradeValues(value: unknown) {
  const text = compactText(value)
  const map: Partial<Record<FuelKey, string>> = {}
  if (!text) return { encoded: false, map }
  const parts = text.split("/").map((part) => part.trim()).filter(Boolean)
  let encoded = parts.length > 0
  parts.forEach((part) => {
    const match = part.match(/^(HSFO|VLSFO|LSMGO)\s*[:=]\s*(.+)$/i)
    if (!match) {
      encoded = false
      return
    }
    const key = fuelColumns.find((column) => column.label === match[1].toUpperCase())?.key
    if (key) map[key] = compactText(match[2])
  })
  return { encoded, map: encoded ? map : {} }
}

function gradeValue(value: unknown, key: FuelKey | null, fallbackPlain = true) {
  const text = compactText(value)
  if (!key) return text
  const parsed = parseGradeValues(text)
  if (parsed.encoded) return compactText(parsed.map[key])
  return fallbackPlain ? text : ""
}

function fixtureFuelLines(row: FixtureRow) {
  const lines = fuelColumns
    .map(({ key, label }) => ({
      key,
      grade: label,
      quantity: compactText(row[key]),
      recordedSupplier: gradeValue(row.supplier_name, key),
      price: gradeValue(row.price, key, false) || compactText(row.price),
      barging: gradeValue(row.barging, key, false) || compactText(row.barging),
    }))
    .filter((line) => line.quantity || line.recordedSupplier)

  if (lines.length > 0) return lines
  return [{
    key: null,
    grade: "",
    quantity: "",
    recordedSupplier: compactText(row.supplier_name),
    price: compactText(row.price),
    barging: compactText(row.barging),
  }]
}

async function loadCompletedFixtures() {
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  if (!serviceRoleKey || !supabaseUrl || serviceRoleKey === "\"\"") return []

  const supabase = createClient(supabaseUrl, serviceRoleKey)
  const { data, error } = await supabase
    .from("spc_fixtures")
    .select(`
      id,
      fixture_status,
      fixture_date,
      vessel_name,
      hsfo,
      vlsfo,
      lsmgo,
      supplier_name,
      price,
      barging,
      supplier_trader_username,
      supplier_trader_display_name,
      buyer_trader_username,
      buyer_trader_display_name,
      created_at,
      enquiry:spc_enquiries!spc_fixtures_enquiry_id_fkey(enquiry_number)
    `)
    .eq("fixture_status", "completed")
    .order("fixture_date", { ascending: false })
    .range(0, 4999)

  if (error) throw error
  return (data || []) as unknown as FixtureRow[]
}

async function loadActiveSpcUsers() {
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  if (!serviceRoleKey || !supabaseUrl || serviceRoleKey === "\"\"") return []
  return listActiveSpcUserOptions()
}

function fixtureSearchText(fixture: SpcSupplierFixture) {
  return [
    fixture.fixtureDate,
    fixture.vesselName,
    fixture.grade,
    fixture.quantity,
    fixture.supplierName,
    fixture.recordedSupplier,
    fixture.price,
    fixture.barging,
    fixture.buyerTrader,
    fixture.supplierTrader,
    fixture.enquiryNumber,
  ].filter(Boolean).join(" ").toLowerCase()
}

function attachFixtures(
  records: Map<string, MutableSupplierRecord>,
  fixtureRows: FixtureRow[],
  activeUsers: SpcUserOption[],
) {
  const legacyFixtures: SpcSupplierLegacyFixture[] = []
  const activeTraders = createActiveSpcTraderResolver(activeUsers)

  fixtureRows.forEach((row) => {
    fixtureFuelLines(row).forEach((line) => {
      const rawSupplier = compactText(line.recordedSupplier)
      if (!rawSupplier) return
      const standardName = displaySupplierName(rawSupplier)
      const key = supplierKey(standardName)
      const record = records.get(key)
      const baseFixture: Omit<SpcSupplierFixture, "supplierName" | "renamed"> = {
        id: `${row.id}-${line.grade || "supplier"}`,
        fixtureDate: row.fixture_date,
        vesselName: row.vessel_name,
        grade: line.grade,
        quantity: line.quantity,
        recordedSupplier: rawSupplier,
        price: line.price || null,
        barging: line.barging || null,
        buyerTrader: activeTraders.displayNameOrRetired(row.buyer_trader_username, row.buyer_trader_display_name),
        supplierTrader: activeTraders.displayNameOrRetired(row.supplier_trader_username, row.supplier_trader_display_name),
        enquiryNumber: compactText(row.enquiry?.enquiry_number),
        fixtureStatus: row.fixture_status,
      }

      if (record) {
        record.fixtures.push({
          ...baseFixture,
          supplierName: record.name,
          renamed: record.name.toUpperCase() !== rawSupplier.toUpperCase(),
        })
        if (standardName && standardName !== record.name) record.aliases.add(standardName)
        if (rawSupplier && rawSupplier !== record.name) record.aliases.add(rawSupplier)
        return
      }

      legacyFixtures.push({
        ...baseFixture,
        supplierName: standardName || rawSupplier,
        legacySupplier: rawSupplier,
        renamed: true,
      })
    })
  })

  records.forEach((record) => {
    record.fixtures.sort((a, b) =>
      (b.fixtureDate || "").localeCompare(a.fixtureDate || "") ||
      (b.enquiryNumber || "").localeCompare(a.enquiryNumber || "") ||
      a.vesselName?.localeCompare(b.vesselName || "") || 0,
    )
  })

  return legacyFixtures.sort((a, b) =>
    (b.fixtureDate || "").localeCompare(a.fixtureDate || "") ||
    a.legacySupplier.localeCompare(b.legacySupplier),
  )
}

function recordSearchText(record: MutableSupplierRecord) {
  return [
    record.name,
    ...record.aliases,
    record.info.paymentTerms,
    record.info.qualityClaimBar,
    record.info.supplierTrader,
    record.info.availableGrade,
    record.info.foBdn,
    record.info.goBdn,
    ...record.fixtures.map(fixtureSearchText),
  ].filter(Boolean).join(" ").toLowerCase()
}

function finaliseDataset(records: Map<string, MutableSupplierRecord>, legacyFixtures: SpcSupplierLegacyFixture[]): SpcSupplierDataset {
  const generatedAt = new Date().toISOString()
  const finalRecords = Array.from(records.values())
    .map<SpcSupplierRecord>((record) => ({
      ...record,
      aliases: Array.from(record.aliases).sort((a, b) => a.localeCompare(b)),
      fixtures: record.fixtures,
      searchText: recordSearchText(record),
      updatedAt: generatedAt,
    }))
    .sort((a, b) => a.name.localeCompare(b.name))

  return {
    suppliers: finalRecords.map((record) => record.name),
    records: finalRecords,
    legacyFixtures,
    generatedAt,
    spreadsheetUrl: SPREADSHEET_URL,
    source: "public-csv",
    counts: {
      suppliers: finalRecords.length,
      fixtureRows: finalRecords.reduce((total, record) => total + record.fixtures.length, 0),
      legacyFixtureRows: legacyFixtures.length,
    },
  }
}

export async function loadSpcSupplierDataset(): Promise<SpcSupplierDataset> {
  const [rows, fixtureRows, activeUsers] = await Promise.all([
    readSupplierSheet(),
    loadCompletedFixtures(),
    loadActiveSpcUsers(),
  ])
  const records = buildSupplierRecords(rows)
  const legacyFixtures = attachFixtures(records, fixtureRows, activeUsers)
  return finaliseDataset(records, legacyFixtures)
}
