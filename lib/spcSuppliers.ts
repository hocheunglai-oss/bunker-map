import fs from "node:fs/promises"
import fsSync from "node:fs"
import path from "node:path"
import { createClient } from "@supabase/supabase-js"
import { google } from "googleapis"
import type { SpcSession } from "@/lib/spcAuth"
import { createSpcAuditContext } from "@/lib/spcAudit"
import type {
  SpcSupplierBarge,
  SpcSupplierBdnEntry,
  SpcSupplierContact,
  SpcSupplierCoverage,
  SpcSupplierDataset,
  SpcSupplierInfo,
  SpcSupplierRecord,
  SpcSupplierSaveInput,
} from "@/lib/spcSupplierTypes"

const SPREADSHEET_ID = "19KHke2iBFDZzteh8hb0G7B7T-TUMa7wrjB27X2RnFA4"
const SPREADSHEET_URL = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit`
const TOKEN_PATH = path.join(process.cwd(), ".google-drive-oauth-token.json")

const SHEET_RANGES = {
  info: "INFO!A1:G1006",
  coverage: "COVERAGE!A1:AI942",
  bdn: "'SUPPLIER BDN'!A1:G963",
  contacts: "CONTACTS!A1:E1013",
  barges: "'SUPPLIER BARGES'!A1:AA1015",
} as const

const PUBLIC_CSV_SHEETS = {
  info: "INFO",
  coverage: "COVERAGE",
  bdn: "SUPPLIER BDN",
  contacts: "CONTACTS",
  barges: "SUPPLIER BARGES",
} as const

type SheetKey = keyof typeof SHEET_RANGES
type SheetRow = Array<string | number | boolean | null | undefined>
type SheetRows = SheetRow[]

type WorkbookRows = Record<SheetKey, SheetRows>

type MutableSupplierRecord = Omit<SpcSupplierRecord, "aliases" | "searchText"> & {
  aliases: Set<string>
}

function requireEnv(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing environment variable: ${name}`)
  return value
}

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
  return cleanText(row?.[index])
}

function supplierBase(value: unknown) {
  return compactText(value)
    .replace(/\s*>>.*$/i, "")
    .replace(/\s+/g, " ")
    .trim()
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

const SUPPLIER_ALIASES: Record<string, string> = {
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

function canonicalSupplierName(value: unknown) {
  const token = normaliseSupplierToken(value)
  return SUPPLIER_ALIASES[token] || token
}

function supplierKey(value: unknown) {
  return canonicalSupplierName(value).replace(/[^A-Z0-9]+/g, "")
}

function displaySupplierName(value: unknown) {
  return supplierBase(value).replace(/\s+/g, " ").trim()
}

function emptyInfo(): SpcSupplierInfo {
  return {
    payment: "",
    qualityClaim: "",
    hsfo: "",
    vlsfo: "",
    lsmgo: "",
    rowNumber: null,
  }
}

function emptyContact(): SpcSupplierContact {
  return {
    sales: "",
    salesMobile: "",
    ops: "",
    opsMobile: "",
    rowNumber: null,
  }
}

function ensureSupplier(records: Map<string, MutableSupplierRecord>, rawName: unknown) {
  const key = supplierKey(rawName)
  const name = displaySupplierName(rawName) || canonicalSupplierName(rawName)
  if (!key || !name) return null

  const existing = records.get(key)
  if (existing) {
    if (name && !existing.aliases.has(name)) existing.aliases.add(name)
    return existing
  }

  const record: MutableSupplierRecord = {
    key,
    name,
    aliases: new Set([name]),
    info: emptyInfo(),
    contact: emptyContact(),
    bdnEntries: [],
    barges: [],
    coverage: [],
    updatedAt: new Date().toISOString(),
  }
  records.set(key, record)
  return record
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

async function fetchPublicCsvSheet(sheetName: string) {
  const url = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}`
  const response = await fetch(url, { cache: "no-store" })
  if (!response.ok) throw new Error(`Could not read ${sheetName} from Google Sheets.`)
  return parseCsv(await response.text())
}

async function getGoogleAuth() {
  const auth = new google.auth.OAuth2(
    requireEnv("GOOGLE_OAUTH_CLIENT_ID"),
    requireEnv("GOOGLE_OAUTH_CLIENT_SECRET"),
    process.env.GOOGLE_OAUTH_REDIRECT_URI || "http://127.0.0.1",
  )
  const refreshToken = process.env.GOOGLE_DRIVE_REFRESH_TOKEN
  const useHostedToken = process.env.VERCEL || process.env.NODE_ENV === "production"

  if (useHostedToken) {
    if (!refreshToken) throw new Error("Google Sheets is not authorized on the hosted app.")
    auth.setCredentials({ refresh_token: refreshToken })
    return auth
  }

  if (fsSync.existsSync(TOKEN_PATH)) {
    auth.setCredentials(JSON.parse(await fs.readFile(TOKEN_PATH, "utf8")))
    return auth
  }

  if (refreshToken) {
    auth.setCredentials({ refresh_token: refreshToken })
    return auth
  }

  throw new Error("Google Sheets is not authorized. Run npm run auth:google-drive.")
}

async function readGoogleSheetWorkbook(): Promise<WorkbookRows> {
  const sheets = google.sheets({ version: "v4", auth: await getGoogleAuth() })
  const response = await sheets.spreadsheets.values.batchGet({
    spreadsheetId: SPREADSHEET_ID,
    ranges: Object.values(SHEET_RANGES),
    valueRenderOption: "FORMATTED_VALUE",
  })

  const ranges = response.data.valueRanges || []
  return {
    info: (ranges[0]?.values || []) as SheetRows,
    coverage: (ranges[1]?.values || []) as SheetRows,
    bdn: (ranges[2]?.values || []) as SheetRows,
    contacts: (ranges[3]?.values || []) as SheetRows,
    barges: (ranges[4]?.values || []) as SheetRows,
  }
}

async function readPublicCsvWorkbook(): Promise<WorkbookRows> {
  const [info, coverage, bdn, contacts, barges] = await Promise.all([
    fetchPublicCsvSheet(PUBLIC_CSV_SHEETS.info),
    fetchPublicCsvSheet(PUBLIC_CSV_SHEETS.coverage),
    fetchPublicCsvSheet(PUBLIC_CSV_SHEETS.bdn),
    fetchPublicCsvSheet(PUBLIC_CSV_SHEETS.contacts),
    fetchPublicCsvSheet(PUBLIC_CSV_SHEETS.barges),
  ])
  return { info, coverage, bdn, contacts, barges }
}

function parseInfo(records: Map<string, MutableSupplierRecord>, rows: SheetRows) {
  rows.slice(1).forEach((row, index) => {
    const supplier = cell(row, 0)
    const record = ensureSupplier(records, supplier)
    if (!record) return

    record.info = {
      payment: cell(row, 1),
      qualityClaim: cell(row, 2),
      hsfo: cell(row, 3),
      vlsfo: cell(row, 4),
      lsmgo: cell(row, 5),
      rowNumber: index + 2,
    }
  })
}

function parseBdn(records: Map<string, MutableSupplierRecord>, rows: SheetRows) {
  let activeSupplier = ""
  rows.slice(1).forEach((row, index) => {
    const rowNumber = index + 2
    const supplier = cell(row, 0)
    const sellingEntity = cell(row, 1)
    const terms = cell(row, 2)
    const bdnFuelOil = cell(row, 3)
    const bdnGasOil = cell(row, 4)
    const pop = cell(row, 5)

    if (supplier) activeSupplier = supplier
    if (!activeSupplier || ![sellingEntity, terms, bdnFuelOil, bdnGasOil, pop].some(Boolean)) return

    const record = ensureSupplier(records, activeSupplier)
    if (!record) return

    const entry: SpcSupplierBdnEntry = {
      id: `bdn-${rowNumber}`,
      rowNumber,
      supplier: displaySupplierName(activeSupplier),
      sellingEntity,
      terms,
      bdnFuelOil,
      bdnGasOil,
      pop,
    }
    record.bdnEntries.push(entry)
  })
}

function parseContacts(records: Map<string, MutableSupplierRecord>, rows: SheetRows) {
  rows.slice(1).forEach((row, index) => {
    const supplier = cell(row, 0)
    const record = ensureSupplier(records, supplier)
    if (!record) return

    record.contact = {
      sales: cell(row, 1),
      salesMobile: cell(row, 2),
      ops: cell(row, 3),
      opsMobile: cell(row, 4),
      rowNumber: index + 2,
    }
  })
}

function parseBarges(records: Map<string, MutableSupplierRecord>, rows: SheetRows) {
  rows.slice(1).forEach((row, index) => {
    const supplier = cell(row, 0)
    const grade = cell(row, 1)
    const bargeName = cell(row, 2)
    if (!supplier || ![grade, bargeName].some(Boolean)) return

    const record = ensureSupplier(records, supplier)
    if (!record) return

    const rowNumber = index + 2
    const barge: SpcSupplierBarge = {
      id: `barge-${rowNumber}`,
      rowNumber,
      supplier: displaySupplierName(supplier),
      grade,
      bargeName,
      imoNumber: cell(row, 3),
      loadMt: cell(row, 4),
      status: cell(row, 5),
    }
    record.barges.push(barge)
  })
}

function parseCoverageTrader(header: string) {
  const match = header.match(/\(([^()]+)\)/)
  return (match?.[1] || header.replace(/^FCBS\s*/i, "")).trim().toUpperCase()
}

function parseCoverage(records: Map<string, MutableSupplierRecord>, rows: SheetRows) {
  let blocks: Array<{ column: number; trader: string; header: string }> = []
  let blankRows = 0

  rows.forEach((row, index) => {
    const headerBlocks: typeof blocks = []
    for (let column = 0; column < 35; column += 4) {
      const header = cell(row, column)
      if (/\bFCBS\s*\(/i.test(header)) {
        headerBlocks.push({
          column,
          trader: parseCoverageTrader(header),
          header,
        })
      }
    }

    if (headerBlocks.length > 0) {
      blocks = headerBlocks
      blankRows = 0
      return
    }

    if (blocks.length === 0) return

    const hasBlockData = blocks.some((block) =>
      [0, 1, 2, 3].some((offset) => cell(row, block.column + offset)),
    )

    if (!hasBlockData) {
      blankRows += 1
      if (blankRows > 1) blocks = []
      return
    }

    blankRows = 0
    blocks.forEach((block) => {
      const supplier = cell(row, block.column)
      if (!supplier) return

      const record = ensureSupplier(records, supplier)
      if (!record) return

      const rowNumber = index + 1
      const coverage: SpcSupplierCoverage = {
        id: `coverage-${rowNumber}-${block.column}`,
        rowNumber,
        trader: block.trader,
        supplier: compactText(supplier),
        hsfo: cell(row, block.column + 1),
        vlsfo: cell(row, block.column + 2),
        lsmgo: cell(row, block.column + 3),
        sourceHeader: block.header,
      }
      record.coverage.push(coverage)
    })
  })
}

function recordSearchText(record: MutableSupplierRecord) {
  return [
    record.name,
    ...record.aliases,
    record.info.payment,
    record.info.qualityClaim,
    record.info.hsfo,
    record.info.vlsfo,
    record.info.lsmgo,
    record.contact.sales,
    record.contact.salesMobile,
    record.contact.ops,
    record.contact.opsMobile,
    ...record.bdnEntries.flatMap((entry) => [
      entry.sellingEntity,
      entry.terms,
      entry.bdnFuelOil,
      entry.bdnGasOil,
      entry.pop,
    ]),
    ...record.barges.flatMap((barge) => [
      barge.supplier,
      barge.grade,
      barge.bargeName,
      barge.imoNumber,
      barge.status,
    ]),
    ...record.coverage.flatMap((coverage) => [
      coverage.trader,
      coverage.supplier,
      coverage.hsfo,
      coverage.vlsfo,
      coverage.lsmgo,
    ]),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
}

function finaliseDataset(records: Map<string, MutableSupplierRecord>, source: SpcSupplierDataset["source"]) {
  const generatedAt = new Date().toISOString()
  const finalRecords = Array.from(records.values())
    .map<SpcSupplierRecord>((record) => ({
      ...record,
      aliases: Array.from(record.aliases).sort((a, b) => a.localeCompare(b)),
      bdnEntries: record.bdnEntries.sort((a, b) => a.rowNumber - b.rowNumber),
      barges: record.barges.sort((a, b) => {
        const statusOrder = a.status.localeCompare(b.status)
        if (statusOrder !== 0) return statusOrder
        return a.bargeName.localeCompare(b.bargeName)
      }),
      coverage: record.coverage.sort((a, b) => a.trader.localeCompare(b.trader) || a.rowNumber - b.rowNumber),
      searchText: recordSearchText(record),
      updatedAt: generatedAt,
    }))
    .sort((a, b) => a.name.localeCompare(b.name))

  return {
    suppliers: finalRecords.map((record) => record.name),
    records: finalRecords,
    generatedAt,
    spreadsheetUrl: SPREADSHEET_URL,
    source,
    counts: {
      suppliers: finalRecords.length,
      activeBarges: finalRecords.reduce(
        (total, record) => total + record.barges.filter((barge) => barge.status.toLowerCase() === "active").length,
        0,
      ),
      coverageRows: finalRecords.reduce((total, record) => total + record.coverage.length, 0),
      bdnRows: finalRecords.reduce((total, record) => total + record.bdnEntries.length, 0),
    },
  } satisfies SpcSupplierDataset
}

function buildDataset(workbook: WorkbookRows, source: SpcSupplierDataset["source"]) {
  const records = new Map<string, MutableSupplierRecord>()
  parseInfo(records, workbook.info)
  parseBdn(records, workbook.bdn)
  parseContacts(records, workbook.contacts)
  parseBarges(records, workbook.barges)
  parseCoverage(records, workbook.coverage)
  return finaliseDataset(records, source)
}

export async function loadSpcSupplierDataset(): Promise<SpcSupplierDataset> {
  try {
    return buildDataset(await readGoogleSheetWorkbook(), "google-sheets")
  } catch (error) {
    console.warn("spc supplier google sheets read failed, falling back to public csv", error)
    return buildDataset(await readPublicCsvWorkbook(), "public-csv")
  }
}

function supplierAuditSnapshot(record: SpcSupplierRecord | null) {
  if (!record) return null
  return {
    supplier_name: record.name,
    info: {
      payment: record.info.payment,
      quality_claim: record.info.qualityClaim,
      hsfo: record.info.hsfo,
      vlsfo: record.info.vlsfo,
      lsmgo: record.info.lsmgo,
    },
    contact: {
      sales: record.contact.sales,
      sales_mobile: record.contact.salesMobile,
      ops: record.contact.ops,
      ops_mobile: record.contact.opsMobile,
    },
    bdn_entries: record.bdnEntries.map((entry) => ({
      row_number: entry.rowNumber,
      selling_entity: entry.sellingEntity,
      terms: entry.terms,
      bdn_fuel_oil: entry.bdnFuelOil,
      bdn_gas_oil: entry.bdnGasOil,
      pop: entry.pop,
    })),
  }
}

function changedFields(before: SpcSupplierRecord, after: SpcSupplierRecord) {
  const fields: string[] = []
  if (JSON.stringify(before.info) !== JSON.stringify(after.info)) fields.push("info")
  if (JSON.stringify(before.contact) !== JSON.stringify(after.contact)) fields.push("contact")
  if (JSON.stringify(before.bdnEntries) !== JSON.stringify(after.bdnEntries)) fields.push("bdn_entries")
  return fields.length ? fields : ["supplier"]
}

async function writeSupplierAuditLog(
  session: SpcSession,
  request: Request,
  before: SpcSupplierRecord,
  after: SpcSupplierRecord,
) {
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!serviceRoleKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY is required for SPC supplier audit logging.")

  const context = createSpcAuditContext(session, request, "spc-suppliers")
  const supabase = createClient(requireEnv("NEXT_PUBLIC_SUPABASE_URL"), serviceRoleKey)
  const { error } = await supabase.from("audit_logs").insert({
    actor_id: `spc:${context.username}`,
    actor_name: context.displayName,
    actor_source: "app",
    table_schema: "public",
    table_name: "spc_suppliers",
    operation: "UPDATE",
    record_pk: { supplier: after.name },
    changed_fields: changedFields(before, after),
    before_row: supplierAuditSnapshot(before),
    after_row: supplierAuditSnapshot(after),
    request_context: {
      pageId: "spc-suppliers",
      pageLabel: "SPC SUPPLIER DATABASE",
      pagePath: "/spc/suppliers",
      source: "google-sheets",
      spreadsheetId: SPREADSHEET_ID,
    },
  })

  if (error) throw error
}

function getWritableRecord(dataset: SpcSupplierDataset, supplierKey: string) {
  const record = dataset.records.find((item) => item.key === supplierKey)
  if (!record) throw new Error("Supplier was not found.")
  return record
}

function withSaveInput(record: SpcSupplierRecord, input: SpcSupplierSaveInput): SpcSupplierRecord {
  const nextInfo = {
    ...record.info,
    payment: cleanText(input.info?.payment ?? record.info.payment),
    qualityClaim: cleanText(input.info?.qualityClaim ?? record.info.qualityClaim),
    hsfo: cleanText(input.info?.hsfo ?? record.info.hsfo),
    vlsfo: cleanText(input.info?.vlsfo ?? record.info.vlsfo),
    lsmgo: cleanText(input.info?.lsmgo ?? record.info.lsmgo),
  }
  const nextContact = {
    ...record.contact,
    sales: cleanText(input.contact?.sales ?? record.contact.sales),
    salesMobile: cleanText(input.contact?.salesMobile ?? record.contact.salesMobile),
    ops: cleanText(input.contact?.ops ?? record.contact.ops),
    opsMobile: cleanText(input.contact?.opsMobile ?? record.contact.opsMobile),
  }
  const bdnByRow = new Map((input.bdnEntries || []).map((entry) => [entry.rowNumber, entry]))

  return {
    ...record,
    info: nextInfo,
    contact: nextContact,
    bdnEntries: record.bdnEntries.map((entry) => {
      const draft = bdnByRow.get(entry.rowNumber)
      if (!draft) return entry
      return {
        ...entry,
        rowNumber: entry.rowNumber,
        sellingEntity: cleanText(draft.sellingEntity ?? entry.sellingEntity),
        terms: cleanText(draft.terms ?? entry.terms),
        bdnFuelOil: cleanText(draft.bdnFuelOil ?? entry.bdnFuelOil),
        bdnGasOil: cleanText(draft.bdnGasOil ?? entry.bdnGasOil),
        pop: cleanText(draft.pop ?? entry.pop),
      }
    }),
    updatedAt: new Date().toISOString(),
  }
}

function buildWriteRanges(before: SpcSupplierRecord, after: SpcSupplierRecord) {
  const writes: Array<{ range: string; values: string[][] }> = []

  if (after.info.rowNumber) {
    writes.push({
      range: `INFO!B${after.info.rowNumber}:F${after.info.rowNumber}`,
      values: [[after.info.payment, after.info.qualityClaim, after.info.hsfo, after.info.vlsfo, after.info.lsmgo]],
    })
  }

  if (after.contact.rowNumber) {
    writes.push({
      range: `CONTACTS!B${after.contact.rowNumber}:E${after.contact.rowNumber}`,
      values: [[after.contact.sales, after.contact.salesMobile, after.contact.ops, after.contact.opsMobile]],
    })
  }

  const beforeBdn = new Map(before.bdnEntries.map((entry) => [entry.rowNumber, entry]))
  after.bdnEntries.forEach((entry) => {
    const previous = beforeBdn.get(entry.rowNumber)
    if (!previous) return
    if (JSON.stringify(previous) === JSON.stringify(entry)) return
    writes.push({
      range: `'SUPPLIER BDN'!B${entry.rowNumber}:F${entry.rowNumber}`,
      values: [[entry.sellingEntity, entry.terms, entry.bdnFuelOil, entry.bdnGasOil, entry.pop]],
    })
  })

  return writes
}

export async function saveSpcSupplier(
  input: SpcSupplierSaveInput,
  session: SpcSession,
  request: Request,
) {
  const beforeDataset = buildDataset(await readGoogleSheetWorkbook(), "google-sheets")
  const before = getWritableRecord(beforeDataset, input.supplierKey)
  const afterDraft = withSaveInput(before, input)
  const writes = buildWriteRanges(before, afterDraft)

  if (writes.length > 0) {
    const sheets = google.sheets({ version: "v4", auth: await getGoogleAuth() })
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        valueInputOption: "USER_ENTERED",
        data: writes,
      },
    })
  }

  const afterDataset = buildDataset(await readGoogleSheetWorkbook(), "google-sheets")
  const after = getWritableRecord(afterDataset, input.supplierKey)
  if (writes.length > 0) {
    await writeSupplierAuditLog(session, request, before, after)
  }

  return {
    dataset: afterDataset,
    record: after,
    saved: writes.length > 0,
  }
}
