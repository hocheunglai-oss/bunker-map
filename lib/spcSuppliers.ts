import { createClient } from "@supabase/supabase-js"
import * as XLSX from "xlsx"
import type { SpcAuditContext } from "@/lib/spcAudit"
import {
  displaySupplierName,
  supplierKey,
} from "@/lib/spcSupplierKeys"
import { createActiveSpcTraderResolver } from "@/lib/spcActiveTraders"
import type {
  SpcSupplierDataset,
  SpcSupplierBarge,
  SpcSupplierFixture,
  SpcSupplierInfo,
  SpcSupplierInfoInput,
  SpcSupplierLegacyFixture,
  SpcSupplierRecord,
  SaveSpcSupplierBargesInput,
  SaveSpcSupplierInput,
} from "@/lib/spcSupplierTypes"
import { listActiveSpcUserOptions, type SpcUserOption } from "@/lib/spcUsers"

const SPREADSHEET_ID = "1lr_WkDeuadBggAWki25qCLcTN76eI_K2lQFh1ZEIX7I"
const SPREADSHEET_URL = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit`
const SHEET_NAME = "Sheet1"
const BARGE_SPREADSHEET_ID = "19KHke2iBFDZzteh8hb0G7B7T-TUMa7wrjB27X2RnFA4"
const BARGE_SHEET_GID = "67085585"
const BARGE_SHEET_NAME = "SUPPLIER BARGES"
const SUPPLIER_OVERRIDE_STORE_KEY = "spc-supplier-overrides"

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

type SupplierStoreRow = {
  key: string
  payload: Record<string, unknown> | null
  updated_at: string
}

type SupplierOverrideRecord = {
  key: string
  name: string
  info: SpcSupplierInfoInput
  deleted?: boolean
  updatedAt: string
}

type StoredSupplierBarge = Omit<SpcSupplierBarge, "source">

type SupplierBargeOverrideRecord = {
  supplierKey: string
  barges: StoredSupplierBarge[]
  updatedAt: string
}

type SupplierOverrideStore = {
  records: SupplierOverrideRecord[]
  barges: SupplierBargeOverrideRecord[]
}

type MutableSupplierRecord = Omit<SpcSupplierRecord, "aliases" | "fixtures" | "searchText"> & {
  aliases: Set<string>
  fixtures: SpcSupplierFixture[]
  barges: SpcSupplierBarge[]
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

function requireEnv(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing environment variable: ${name}`)
  return value
}

function getServiceClient() {
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!serviceRoleKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY is required for supplier database changes.")
  return createClient(requireEnv("NEXT_PUBLIC_SUPABASE_URL"), serviceRoleKey)
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

function decodeHtmlEntities(value: string) {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
}

function stripStruckHtml(value: string) {
  return decodeHtmlEntities(
    value
      .replace(/<s\b[^>]*>[\s\S]*?<\/s>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
}

function workbookCellText(sheet: XLSX.WorkSheet, row: number, column: number) {
  const cellValue = sheet[XLSX.utils.encode_cell({ r: row, c: column })] as XLSX.CellObject | undefined
  if (!cellValue) return ""
  const html = typeof cellValue.h === "string" ? cellValue.h : ""
  if (/<s\b/i.test(html)) return compactText(stripStruckHtml(html))
  return compactText(cellValue.w ?? cellValue.v)
}

function normaliseBargeGrade(value: unknown) {
  const text = compactText(value).toUpperCase()
  return fuelColumns.map((column) => column.label).find((grade) => text.includes(grade)) || ""
}

function bargeId(supplierKeyValue: string, source: Partial<StoredSupplierBarge>, index: number) {
  const existing = compactText(source.id)
  if (existing) return existing
  const namePart = supplierKey(source.bargeName || source.imo || `BARGE ${index + 1}`) || `BARGE${index + 1}`
  return `${supplierKeyValue}-BARGE-${index + 1}-${namePart}`.slice(0, 96)
}

function cleanStoredBarge(
  supplierKeyValue: string,
  source: Partial<StoredSupplierBarge>,
  index: number,
): StoredSupplierBarge | null {
  const bargeName = compactText(source.bargeName)
  const imo = compactText(source.imo).replace(/\.0$/, "")
  const grade = normaliseBargeGrade(source.grade)
  const capacity = compactText(source.capacity)
  if (!bargeName && !imo && !grade && !capacity) return null
  return {
    id: bargeId(supplierKeyValue, source, index),
    bargeName,
    imo,
    grade,
    capacity,
  }
}

function parseBargeWorkbookSheet(sheet: XLSX.WorkSheet): Array<{
  supplierName: string
  supplierKey: string
  barge: StoredSupplierBarge
}> {
  const range = sheet["!ref"] ? XLSX.utils.decode_range(sheet["!ref"]) : null
  if (!range) return []

  let headerRow = -1
  let supplierColumn = -1
  let gradeColumn = -1
  let bargeColumn = -1
  let imoColumn = -1
  let capacityColumn = -1

  for (let row = range.s.r; row <= Math.min(range.e.r, range.s.r + 20); row += 1) {
    const headers = Array.from({ length: range.e.c - range.s.c + 1 }, (_, offset) =>
      workbookCellText(sheet, row, range.s.c + offset).toUpperCase().replace(/[^A-Z0-9]/g, ""),
    )
    const supplierIndex = headers.findIndex((header) => header === "SUPPLIER")
    const gradeIndex = headers.findIndex((header) => header === "GRADE")
    const bargeIndex = headers.findIndex((header) => header.includes("BARGE") && header.includes("NAME"))
    const imoIndex = headers.findIndex((header) => header.includes("IMO"))
    const capacityIndex = headers.findIndex((header) => header.includes("LOAD") || header.includes("CAPACITY"))
    if (supplierIndex >= 0 && gradeIndex >= 0 && bargeIndex >= 0 && imoIndex >= 0) {
      headerRow = row
      supplierColumn = range.s.c + supplierIndex
      gradeColumn = range.s.c + gradeIndex
      bargeColumn = range.s.c + bargeIndex
      imoColumn = range.s.c + imoIndex
      capacityColumn = capacityIndex >= 0 ? range.s.c + capacityIndex : -1
      break
    }
  }

  if (headerRow < 0) return []

  const rows: Array<{
    supplierName: string
    supplierKey: string
    barge: StoredSupplierBarge
  }> = []
  let carriedSupplier = ""

  for (let row = headerRow + 1; row <= range.e.r; row += 1) {
    const supplierText = workbookCellText(sheet, row, supplierColumn) || carriedSupplier
    if (supplierText) carriedSupplier = supplierText
    const key = supplierKey(supplierText)
    if (!key || key === supplierKey("KENOIL")) continue

    const barge = cleanStoredBarge(key, {
      bargeName: workbookCellText(sheet, row, bargeColumn),
      imo: workbookCellText(sheet, row, imoColumn),
      grade: workbookCellText(sheet, row, gradeColumn),
      capacity: capacityColumn >= 0 ? workbookCellText(sheet, row, capacityColumn) : "",
    }, row - headerRow - 1)
    if (!barge?.bargeName) continue

    rows.push({
      supplierName: displaySupplierName(supplierText),
      supplierKey: key,
      barge,
    })
  }

  return rows
}

async function readSupplierBargeSheet() {
  const url = `https://docs.google.com/spreadsheets/d/${BARGE_SPREADSHEET_ID}/export?format=xlsx&gid=${BARGE_SHEET_GID}`
  const response = await fetch(url, { cache: "no-store" })
  if (!response.ok) throw new Error("Could not read supplier barge list from Google Sheets.")
  const workbook = XLSX.read(Buffer.from(await response.arrayBuffer()), {
    cellHTML: true,
    cellStyles: true,
    type: "buffer",
  })
  const sheetName = workbook.SheetNames.find((name) => name.toUpperCase() === BARGE_SHEET_NAME) ||
    workbook.SheetNames.find((name) => name.toUpperCase().includes("BARGE")) ||
    workbook.SheetNames[0]
  const sheet = sheetName ? workbook.Sheets[sheetName] : null
  if (!sheet) return []
  return parseBargeWorkbookSheet(sheet)
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

function cleanInfo(input: Partial<SpcSupplierInfoInput> | undefined): SpcSupplierInfoInput {
  return {
    paymentTerms: compactText(input?.paymentTerms),
    qualityClaimBar: compactText(input?.qualityClaimBar),
    supplierTrader: compactText(input?.supplierTrader),
    availableGrade: normaliseAvailableGrade(input?.availableGrade),
    foBdn: compactText(input?.foBdn),
    goBdn: compactText(input?.goBdn),
  }
}

function normaliseAvailableGrade(value: unknown) {
  const selected = new Set(
    compactText(value)
      .split(/[,\n/]+/)
      .map((grade) => grade.trim().toUpperCase())
      .filter(Boolean),
  )
  return fuelColumns
    .map((column) => column.label)
    .filter((grade) => selected.has(grade))
    .join(", ")
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
      barges: [],
      updatedAt: new Date().toISOString(),
    })
  })
  return records
}

function parseSupplierOverrideStore(payload: unknown): SupplierOverrideStore {
  if (!payload || typeof payload !== "object") return { records: [], barges: [] }
  const records = (payload as { records?: unknown }).records
  const barges = (payload as { barges?: unknown }).barges

  return {
    records: Array.isArray(records) ? records.flatMap((record) => {
      if (!record || typeof record !== "object") return []
      const source = record as Record<string, unknown>
      const name = displaySupplierName(compactText(source.name))
      const key = supplierKey(compactText(source.key) || name)
      if (!key || !name) return []
      return [{
        key,
        name,
        info: cleanInfo(source.info as Partial<SpcSupplierInfoInput> | undefined),
        deleted: source.deleted === true,
        updatedAt: typeof source.updatedAt === "string" ? source.updatedAt : new Date(0).toISOString(),
      }]
    }) : [],
    barges: Array.isArray(barges) ? barges.flatMap((record) => {
      if (!record || typeof record !== "object") return []
      const source = record as Record<string, unknown>
      const key = supplierKey(source.supplierKey || source.key)
      if (!key) return []
      const sourceBarges = Array.isArray(source.barges) ? source.barges : []
      return [{
        supplierKey: key,
        barges: sourceBarges.flatMap((barge, index) => {
          if (!barge || typeof barge !== "object") return []
          const clean = cleanStoredBarge(key, barge as Partial<StoredSupplierBarge>, index)
          return clean ? [clean] : []
        }),
        updatedAt: typeof source.updatedAt === "string" ? source.updatedAt : new Date(0).toISOString(),
      }]
    }) : [],
  }
}

async function loadSupplierOverrideStore(supabase: ReturnType<typeof getServiceClient>) {
  const { data, error } = await supabase
    .from("office_calendar_store")
    .select("key,payload,updated_at")
    .eq("key", SUPPLIER_OVERRIDE_STORE_KEY)
    .maybeSingle()

  if (error) throw error
  return {
    storeRow: (data as unknown as SupplierStoreRow | null) || null,
    store: parseSupplierOverrideStore(data?.payload),
  }
}

async function loadSupplierOverrides() {
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  if (!serviceRoleKey || !supabaseUrl || serviceRoleKey === "\"\"") return { records: [], barges: [] }
  const supabase = createClient(supabaseUrl, serviceRoleKey)
  const { store } = await loadSupplierOverrideStore(supabase)
  return store
}

function applySupplierOverrides(records: Map<string, MutableSupplierRecord>, store: SupplierOverrideStore) {
  store.records.forEach((override) => {
    if (override.deleted) {
      records.delete(override.key)
      return
    }

    const existing = records.get(override.key)
    const info: SpcSupplierInfo = {
      ...override.info,
      rowNumber: existing?.info.rowNumber ?? null,
    }

    if (existing) {
      existing.name = override.name
      existing.info = info
      existing.aliases.add(override.name)
      existing.updatedAt = override.updatedAt
      return
    }

    records.set(override.key, {
      key: override.key,
      name: override.name,
      aliases: new Set([override.name]),
      info,
      fixtures: [],
      barges: [],
      updatedAt: override.updatedAt,
    })
  })
}

async function writeSupplierStoreAudit(
  supabase: ReturnType<typeof getServiceClient>,
  context: SpcAuditContext,
  operation: "INSERT" | "UPDATE" | "DELETE",
  beforeRow: SupplierStoreRow | null,
  afterRow: SupplierStoreRow,
) {
  await supabase.from("audit_logs").insert({
    actor_id: `spc:${context.username}`,
    actor_name: context.displayName || context.username,
    actor_source: "app",
    table_schema: "public",
    table_name: "office_calendar_store",
    operation,
    record_pk: { key: SUPPLIER_OVERRIDE_STORE_KEY },
    changed_fields: ["payload"],
    before_row: beforeRow,
    after_row: afterRow,
    request_context: {
      pageId: context.pageId,
      pageLabel: context.pageLabel,
      pagePath: context.pagePath,
    },
  })
}

async function writeSupplierOverrideStore(
  store: SupplierOverrideStore,
  context: SpcAuditContext,
  beforeRow: SupplierStoreRow | null,
  operation: "INSERT" | "UPDATE" | "DELETE",
) {
  const supabase = getServiceClient()
  const afterRow: SupplierStoreRow = {
    key: SUPPLIER_OVERRIDE_STORE_KEY,
    payload: store,
    updated_at: new Date().toISOString(),
  }
  const { error } = await supabase.from("office_calendar_store").upsert(afterRow)
  if (error) throw error
  await writeSupplierStoreAudit(supabase, context, operation, beforeRow, afterRow)
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

function attachBarges(
  records: Map<string, MutableSupplierRecord>,
  bargeRows: Awaited<ReturnType<typeof readSupplierBargeSheet>>,
  store: SupplierOverrideStore,
) {
  bargeRows.forEach((row) => {
    const record = records.get(row.supplierKey)
    if (!record) return
    record.aliases.add(row.supplierName)
    record.barges.push({
      ...row.barge,
      source: "sheet",
    })
  })

  store.barges.forEach((override) => {
    const record = records.get(override.supplierKey)
    if (!record) return
    record.barges = override.barges.map((barge) => ({
      ...barge,
      source: "override",
    }))
    record.updatedAt = override.updatedAt
  })

  records.forEach((record) => {
    record.barges.sort((a, b) =>
      a.grade.localeCompare(b.grade) ||
      a.bargeName.localeCompare(b.bargeName) ||
      a.imo.localeCompare(b.imo),
    )
  })
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
    ...record.barges.map((barge) => [
      barge.bargeName,
      barge.imo,
      barge.grade,
      barge.capacity,
    ].join(" ")),
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
      barges: record.barges,
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
      bargeRows: finalRecords.reduce((total, record) => total + record.barges.length, 0),
    },
  }
}

export async function loadSpcSupplierDataset(): Promise<SpcSupplierDataset> {
  const [rows, fixtureRows, activeUsers, overrides, bargeRows] = await Promise.all([
    readSupplierSheet(),
    loadCompletedFixtures(),
    loadActiveSpcUsers(),
    loadSupplierOverrides(),
    readSupplierBargeSheet(),
  ])
  const records = buildSupplierRecords(rows)
  applySupplierOverrides(records, overrides)
  const legacyFixtures = attachFixtures(records, fixtureRows, activeUsers)
  attachBarges(records, bargeRows, overrides)
  return finaliseDataset(records, legacyFixtures)
}

export async function saveSpcSupplier(input: SaveSpcSupplierInput, context: SpcAuditContext) {
  const name = displaySupplierName(compactText(input.name))
  const key = supplierKey(name)
  if (!name || !key) throw new Error("Supplier name is required.")

  const supabase = getServiceClient()
  const { storeRow, store } = await loadSupplierOverrideStore(supabase)
  const updatedAt = new Date().toISOString()
  const originalKey = supplierKey(input.key || key)
  const nextRecords = store.records.filter((record) => record.key !== key && record.key !== originalKey)
  if (originalKey && originalKey !== key) {
    nextRecords.push({
      key: originalKey,
      name: input.key || name,
      info: cleanInfo({}),
      deleted: true,
      updatedAt,
    })
  }
  nextRecords.push({
    key,
    name,
    info: cleanInfo(input.info),
    deleted: false,
    updatedAt,
  })
  const nextBarges = store.barges.map((entry) =>
    originalKey && originalKey !== key && entry.supplierKey === originalKey
      ? { ...entry, supplierKey: key, updatedAt }
      : entry,
  )

  await writeSupplierOverrideStore(
    { records: nextRecords, barges: nextBarges },
    context,
    storeRow,
    storeRow ? "UPDATE" : "INSERT",
  )
  return loadSpcSupplierDataset()
}

export async function deleteSpcSupplier(keyInput: string, context: SpcAuditContext) {
  const key = supplierKey(keyInput)
  if (!key) throw new Error("Supplier key is required.")

  const supabase = getServiceClient()
  const { storeRow, store } = await loadSupplierOverrideStore(supabase)
  const dataset = await loadSpcSupplierDataset()
  const existing = dataset.records.find((record) => record.key === key)
  if (!existing) throw new Error("Supplier not found.")

  const updatedAt = new Date().toISOString()
  const nextRecords = store.records.filter((record) => record.key !== key)
  nextRecords.push({
    key,
    name: existing.name,
    info: cleanInfo(existing.info),
    deleted: true,
    updatedAt,
  })

  await writeSupplierOverrideStore(
    { records: nextRecords, barges: store.barges.filter((entry) => entry.supplierKey !== key) },
    context,
    storeRow,
    storeRow ? "UPDATE" : "INSERT",
  )
  return loadSpcSupplierDataset()
}

export async function saveSpcSupplierBarges(input: SaveSpcSupplierBargesInput, context: SpcAuditContext) {
  const key = supplierKey(input.supplierKey)
  if (!key) throw new Error("Supplier key is required.")

  const supabase = getServiceClient()
  const { storeRow, store } = await loadSupplierOverrideStore(supabase)
  const updatedAt = new Date().toISOString()
  const cleanedBarges = (Array.isArray(input.barges) ? input.barges : [])
    .flatMap((barge, index) => {
      const clean = cleanStoredBarge(key, barge, index)
      return clean ? [clean] : []
    })

  const nextBarges = store.barges.filter((entry) => entry.supplierKey !== key)
  nextBarges.push({
    supplierKey: key,
    barges: cleanedBarges,
    updatedAt,
  })

  await writeSupplierOverrideStore(
    { records: store.records, barges: nextBarges },
    context,
    storeRow,
    storeRow ? "UPDATE" : "INSERT",
  )
  return loadSpcSupplierDataset()
}
