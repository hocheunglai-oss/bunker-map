import type { SpcSession } from "@/lib/spcAuth"
import { createSpcAuditContext, createSpcAuditedSupabaseClient } from "@/lib/spcAudit"
import {
  formatSpcEnquiry,
  parseSpcEnquiryText,
  readSpcEnquiryMeta,
} from "@/lib/spcEnquiryText"
import { displaySupplierName, supplierKey } from "@/lib/spcSupplierKeys"
import { listActiveSpcUserOptions, type SpcUserOption } from "@/lib/spcUsers"
import { cleanSpcImo } from "@/lib/spcVesselIdentity"

export type SpcFixtureStatus = "pending" | "completed" | "cancelled"

export type SpcFixture = {
  id: string
  enquiryId: string
  enquiryNumber: string
  enquiryTitle: string
  fixtureStatus: SpcFixtureStatus
  fixtureDate: string | null
  supplierTraderUserId: string | null
  supplierTraderUsername: string
  supplierTraderDisplayName: string
  buyerTraderUserId: string | null
  buyerTraderUsername: string
  buyerTraderDisplayName: string
  account: string | null
  commission: string | null
  earliestEta: string | null
  vesselName: string | null
  vesselImo: string | null
  hsfo: string | null
  vlsfo: string | null
  lsmgo: string | null
  supplierName: string | null
  supplierKey: string | null
  price: string | null
  barging: string | null
  completedAt: string | null
  completedByUsername: string | null
  completedByDisplayName: string | null
  createdAt: string
  updatedAt: string
}

export type SpcFixtureInput = {
  fixtureDate?: string
  supplierTrader?: string
  buyerTrader?: string
  account?: string
  commission?: string
  earliestEta?: string
  vesselName?: string
  hsfo?: string
  vlsfo?: string
  lsmgo?: string
  supplierName?: string
  price?: string
  barging?: string
}

type FuelKey = "hsfo" | "vlsfo" | "lsmgo"

type SpcFixtureEnquiryRow = {
  id: string
  enquiry_number: string
  title: string
  vessel_name: string | null
  port: string | null
  product: string | null
  quantity: string | null
  delivery_date: string | null
  supplier_name: string | null
  status: string
  notes: string | null
  created_by_username: string
  created_by_display_name: string
  created_at: string
  updated_at: string
}

type SpcFixtureRow = {
  id: string
  enquiry_id: string
  fixture_status: SpcFixtureStatus
  fixture_date: string | null
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
  vessel_imo: string | null
  hsfo: string | null
  vlsfo: string | null
  lsmgo: string | null
  supplier_name: string | null
  supplier_key: string | null
  price: string | null
  barging: string | null
  completed_at: string | null
  completed_by_username: string | null
  completed_by_display_name: string | null
  created_at: string
  updated_at: string
  enquiry?: SpcFixtureEnquiryRow | null
}

function cleanString(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim()
}

function optionalString(value: unknown) {
  const cleaned = cleanString(value)
  return cleaned || null
}

function cleanDate(value: unknown) {
  const cleaned = cleanString(value)
  return /^\d{4}-\d{2}-\d{2}$/.test(cleaned) ? cleaned : null
}

const defaultOfficeOptions = ["ITALY", "HONG KONG", "SINGAPORE", "MONACO", "FRANCE", "USA", "KOREA", "JAPAN", "VIETNAM"]
const fuelColumns: Array<{ key: FuelKey; label: string }> = [
  { key: "hsfo", label: "HSFO" },
  { key: "vlsfo", label: "VLSFO" },
  { key: "lsmgo", label: "LSMGO" },
]
const allFuelKeys = fuelColumns.map(({ key }) => key)
const monthLabels = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"]

function formatNumberString(value: unknown) {
  const match = cleanString(value)
    .replace(/[–—]/g, "-")
    .match(/\d[\d,]*(?:\.\d*)?/)
  if (!match) return ""
  const raw = match[0].replace(/,/g, "")
  const [integerRaw, decimalRaw = ""] = raw.split(".")
  const integer = (integerRaw || "0").replace(/^0+(?=\d)/, "") || "0"
  const formattedInteger = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",")
  if (raw.includes(".")) return `${formattedInteger}.${decimalRaw}`
  return formattedInteger
}

function formatIntegerString(value: unknown) {
  return formatNumberString(value)
}

function formatQuantityString(value: unknown) {
  const text = cleanString(value).replace(/[–—]/g, "-")
  if (!text.includes("-")) return formatIntegerString(text)
  const [leftRaw, ...rightRawParts] = text.split("-")
  const left = formatIntegerString(leftRaw)
  const rightRaw = rightRawParts.join("")
  const right = formatIntegerString(rightRaw)
  if (left && !right && text.trim().endsWith("-")) return left
  if (left && right) return `${left}-${right}`
  return left || right
}

function parseGradeValues(value: unknown) {
  const text = cleanString(value)
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
    if (key) map[key] = cleanString(match[2])
  })
  return { encoded, map: encoded ? map : {} }
}

function serializeGradeValues(map: Partial<Record<FuelKey, string>>) {
  return fuelColumns
    .map(({ key, label }) => {
      const value = cleanString(map[key])
      return value ? `${label}: ${value}` : ""
    })
    .filter(Boolean)
    .join(" / ")
}

function gradeValue(value: unknown, key: FuelKey, fallbackPlain = true) {
  const text = cleanString(value)
  const parsed = parseGradeValues(text)
  if (parsed.encoded) return cleanString(parsed.map[key])
  return fallbackPlain ? text : ""
}

function normalizeGradeField(value: unknown, keys: FuelKey[], options?: { numeric?: boolean; supplier?: boolean }) {
  const parsed = parseGradeValues(value)
  if (parsed.encoded) {
    const nextMap: Partial<Record<FuelKey, string>> = {}
    keys.forEach((key) => {
      const raw = parsed.map[key]
      const nextValue = options?.numeric
        ? formatIntegerString(raw)
        : options?.supplier
          ? displaySupplierName(raw)
          : cleanString(raw)
      if (nextValue) nextMap[key] = nextValue
    })
    return serializeGradeValues(nextMap) || null
  }
  const plain = options?.numeric
    ? formatIntegerString(value)
    : options?.supplier
      ? displaySupplierName(value)
      : cleanString(value)
  return plain || null
}

function normalizeSupplierField(value: unknown) {
  return normalizeGradeField(value, allFuelKeys, { supplier: true })
}

function primarySupplierName(value: unknown) {
  const text = cleanString(value)
  const parsed = parseGradeValues(text)
  if (parsed.encoded) return allFuelKeys.map((key) => cleanString(parsed.map[key])).find(Boolean) || ""
  return text
}

function monthCode(value: unknown) {
  const token = cleanString(value).toUpperCase().slice(0, 3)
  return monthLabels.includes(token) ? token : ""
}

function validDay(value: unknown) {
  const day = Number(cleanString(value))
  return Number.isInteger(day) && day >= 1 && day <= 31 ? String(day) : ""
}

function normalizeEta(value: unknown) {
  const text = cleanString(value)
    .toUpperCase()
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
  if (!text) return null

  const single = text.match(/^(\d{1,2})\s*([A-Z]{3,})$/)
  if (single) {
    const day = validDay(single[1])
    const month = monthCode(single[2])
    return day && month ? `${day} ${month}` : null
  }

  const sameMonth = text.match(/^(\d{1,2})\s*-\s*(\d{1,2})\s*([A-Z]{3,})$/)
  if (sameMonth) {
    const startDay = validDay(sameMonth[1])
    const endDay = validDay(sameMonth[2])
    const month = monthCode(sameMonth[3])
    return startDay && endDay && month ? `${startDay} - ${endDay} ${month}` : null
  }

  const crossMonth = text.match(/^(\d{1,2})\s*([A-Z]{3,})\s*-\s*(\d{1,2})\s*([A-Z]{3,})$/)
  if (crossMonth) {
    const startDay = validDay(crossMonth[1])
    const startMonth = monthCode(crossMonth[2])
    const endDay = validDay(crossMonth[3])
    const endMonth = monthCode(crossMonth[4])
    return startDay && startMonth && endDay && endMonth ? `${startDay} ${startMonth} - ${endDay} ${endMonth}` : null
  }

  return null
}

function editDistance(left: string, right: string) {
  const rows = Array.from({ length: left.length + 1 }, (_, index) => [index])
  for (let column = 1; column <= right.length; column += 1) rows[0][column] = column
  for (let row = 1; row <= left.length; row += 1) {
    for (let column = 1; column <= right.length; column += 1) {
      rows[row][column] = Math.min(
        rows[row - 1][column] + 1,
        rows[row][column - 1] + 1,
        rows[row - 1][column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1),
      )
    }
  }
  return rows[left.length][right.length]
}

function normalizeAccount(value: unknown, users: SpcUserOption[]) {
  const cleaned = cleanString(value).toUpperCase()
  if (!cleaned) return null
  const options = Array.from(new Set([...defaultOfficeOptions, ...users.map((user) => user.office.toUpperCase())].filter(Boolean)))
  const exact = options.find((option) => option === cleaned)
  if (exact) return exact
  const singular = cleaned.endsWith("S") ? options.find((option) => option === cleaned.slice(0, -1)) : null
  if (singular) return singular
  const prefix = options.find((option) => cleaned.startsWith(option))
  if (prefix) return prefix
  const closeMatches = options.filter((option) => editDistance(cleaned, option) <= 2)
  return closeMatches.length === 1 ? closeMatches[0] : null
}

function sameUsername(left: string | null | undefined, right: string | null | undefined) {
  return cleanString(left).toLowerCase() === cleanString(right).toLowerCase()
}

function hongKongDate(value: string | Date = new Date()) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10)
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Hong_Kong",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date)
}

function userChoiceLabel(user: Pick<SpcUserOption, "username" | "displayName">) {
  return `${user.displayName || user.username} | ${user.username}`
}

function compactPersonName(value: string | null | undefined) {
  const cleaned = cleanString(value).split("|")[0].trim()
  if (!cleaned) return ""
  const withoutDomain = cleaned.includes("@") ? cleaned.split("@")[0] : cleaned
  return withoutDomain.split(/\s+/)[0] || withoutDomain
}

function traderCodeName(value: string | null | undefined) {
  return cleanString(value).split("-")[0]?.trim() || ""
}

function findUserByUsername(users: SpcUserOption[], username: string | null | undefined) {
  const target = cleanString(username).toLowerCase()
  if (!target) return null
  return users.find((user) => user.username.toLowerCase() === target) || null
}

function resolveUserChoice(users: SpcUserOption[], input: unknown) {
  const value = cleanString(input)
  if (!value) return null
  const lowerValue = value.toLowerCase()
  const codeName = traderCodeName(value).toLowerCase()
  const pipeUsername = value.includes("|") ? cleanString(value.split("|").pop()).toLowerCase() : ""

  const exactMatch = users.find((user) => {
    const username = user.username.toLowerCase()
    const displayName = (user.displayName || user.username).toLowerCase()
    const label = userChoiceLabel(user).toLowerCase()
    return lowerValue === username || lowerValue === displayName || lowerValue === label || pipeUsername === username
  })
  if (exactMatch) return exactMatch

  const firstNameMatches = users.filter((user) => compactPersonName(user.displayName || user.username).toLowerCase() === lowerValue)
  if (firstNameMatches.length === 1) return firstNameMatches[0]
  if (codeName && codeName !== lowerValue) {
    const codeMatches = users.filter((user) => compactPersonName(user.displayName || user.username).toLowerCase() === codeName)
    if (codeMatches.length === 1) return codeMatches[0]
  }

  return null
}

function extractInitialFuel(text: string, aliases: string[]) {
  const pattern = new RegExp(`\\b(${aliases.join("|")})\\b\\s*([^/\\n]+)`, "i")
  const match = text.match(pattern)
  return match ? match[2].trim() : ""
}

function mapFixture(row: SpcFixtureRow): SpcFixture {
  const supplierName = normalizeSupplierField(row.supplier_name)
  const primarySupplier = primarySupplierName(supplierName)
  return {
    id: row.id,
    enquiryId: row.enquiry_id,
    enquiryNumber: row.enquiry?.enquiry_number || "",
    enquiryTitle: row.enquiry?.title || "",
    fixtureStatus: row.fixture_status,
    fixtureDate: row.fixture_date,
    supplierTraderUserId: row.supplier_trader_user_id,
    supplierTraderUsername: row.supplier_trader_username,
    supplierTraderDisplayName: row.supplier_trader_display_name,
    buyerTraderUserId: row.buyer_trader_user_id,
    buyerTraderUsername: row.buyer_trader_username,
    buyerTraderDisplayName: row.buyer_trader_display_name,
    account: row.account,
    commission: row.commission,
    earliestEta: row.earliest_eta,
    vesselName: row.vessel_name,
    vesselImo: row.vessel_imo,
    hsfo: row.hsfo,
    vlsfo: row.vlsfo,
    lsmgo: row.lsmgo,
    supplierName,
    supplierKey: primarySupplier ? supplierKey(primarySupplier) : row.supplier_key ? supplierKey(row.supplier_key) : null,
    price: row.price,
    barging: row.barging,
    completedAt: row.completed_at,
    completedByUsername: row.completed_by_username,
    completedByDisplayName: row.completed_by_display_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function sortFixtures(fixtures: SpcFixture[]) {
  return [...fixtures].sort((a, b) => {
    if (a.fixtureStatus !== b.fixtureStatus) {
      if (a.fixtureStatus === "pending") return -1
      if (b.fixtureStatus === "pending") return 1
    }
    const first = a.fixtureDate || a.completedAt || a.updatedAt || a.createdAt
    const second = b.fixtureDate || b.completedAt || b.updatedAt || b.createdAt
    return second.localeCompare(first)
  })
}

export async function listSpcFixtures(session: SpcSession, limit = 5000) {
  const context = createSpcAuditContext(session, undefined, "spc-fixtures")
  const supabase = createSpcAuditedSupabaseClient(context)
  const safeLimit = Math.min(Math.max(Number(limit || 5000), 1), 5000)
  const { data, error } = await supabase
    .from("spc_fixtures")
    .select(`
      *,
      enquiry:spc_enquiries!spc_fixtures_enquiry_id_fkey(
        enquiry_number,
        title
      )
    `)
    .order("created_at", { ascending: false })
    .limit(safeLimit)

  if (error) throw error
  return sortFixtures(((data || []) as unknown as SpcFixtureRow[]).map(mapFixture))
}

export async function ensurePendingSpcFixtureForEnquiry(
  enquiry: SpcFixtureEnquiryRow,
  session: SpcSession,
  request: Request,
) {
  const context = createSpcAuditContext(session, request, "spc-fixtures")
  const supabase = createSpcAuditedSupabaseClient(context)
  const users = await listActiveSpcUserOptions()
  const meta = readSpcEnquiryMeta(enquiry.notes)
  const supplierTrader = findUserByUsername(users, meta.stemSupplierTraderUsername)
  const buyerTrader = findUserByUsername(users, enquiry.created_by_username)
  const text = `${enquiry.product || ""} / ${formatSpcEnquiry(enquiry)}`
  const parsed = parseSpcEnquiryText(formatSpcEnquiry(enquiry))

  const { data: existing, error: existingError } = await supabase
    .from("spc_fixtures")
    .select("id, fixture_status, vessel_imo")
    .eq("enquiry_id", enquiry.id)
    .maybeSingle()

  if (existingError) throw existingError
  const existingFixture = existing as { fixture_status?: string; vessel_imo?: string | null } | null
  if (existingFixture?.fixture_status === "completed") return

  const initialSupplierName = normalizeSupplierField(meta.fixtureSupplier || enquiry.supplier_name)
  const initialPrimarySupplier = primarySupplierName(initialSupplierName)
  const payload = {
    enquiry_id: enquiry.id,
    fixture_status: "pending",
    fixture_date: hongKongDate(meta.outcomeAt || enquiry.updated_at || enquiry.created_at),
    supplier_trader_user_id: supplierTrader?.id || null,
    supplier_trader_username: supplierTrader?.username || cleanString(meta.stemSupplierTraderUsername),
    supplier_trader_display_name:
      supplierTrader?.displayName || cleanString(meta.stemSupplierTraderDisplayName) || cleanString(meta.stemSupplierTraderUsername),
    buyer_trader_user_id: buyerTrader?.id || null,
    buyer_trader_username: buyerTrader?.username || enquiry.created_by_username,
    buyer_trader_display_name: buyerTrader?.displayName || enquiry.created_by_display_name || enquiry.created_by_username,
    account: buyerTrader?.office || null,
    earliest_eta: optionalString(meta.eta || parsed.eta || enquiry.delivery_date),
    vessel_name: optionalString(enquiry.vessel_name || parsed.vesselName || enquiry.title),
    vessel_imo: cleanSpcImo(meta.imo || parsed.imo) || existingFixture?.vessel_imo || null,
    hsfo: optionalString(meta.hsfo || parsed.hsfo || extractInitialFuel(text, ["hsfo", "ifo"])),
    vlsfo: optionalString(meta.vlsfo || parsed.vlsfo || extractInitialFuel(text, ["vlsfo", "lsfo"])),
    lsmgo: optionalString(meta.lsmgo || parsed.lsmgo || extractInitialFuel(text, ["lsmgo", "mgo"])),
    supplier_name: initialSupplierName,
    supplier_key: initialPrimarySupplier ? supplierKey(initialPrimarySupplier) : null,
    price: optionalString(meta.price),
    barging: optionalString(meta.barging),
  }

  if (!payload.supplier_trader_username) throw new Error("Supplier trader is required.")
  if (!payload.buyer_trader_username) throw new Error("Buyer trader is required.")

  const { error } = await supabase
    .from("spc_fixtures")
    .upsert(payload, { onConflict: "enquiry_id" })

  if (error) throw error
}

async function loadFixtureRow(
  supabase: ReturnType<typeof createSpcAuditedSupabaseClient>,
  id: string,
) {
  const { data, error } = await supabase
    .from("spc_fixtures")
    .select("*")
    .eq("id", id)
    .single()
  if (error) throw error
  return data as unknown as SpcFixtureRow
}

async function loadMappedFixture(
  supabase: ReturnType<typeof createSpcAuditedSupabaseClient>,
  id: string,
) {
  const { data, error } = await supabase
    .from("spc_fixtures")
    .select(`
      *,
      enquiry:spc_enquiries!spc_fixtures_enquiry_id_fkey(
        id,
        enquiry_number,
        title,
        vessel_name,
        port,
        product,
        quantity,
        delivery_date,
        supplier_name,
        status,
        notes,
        created_by_username,
        created_by_display_name,
        created_at,
        updated_at
      )
    `)
    .eq("id", id)
    .single()
  if (error) throw error
  return mapFixture(data as unknown as SpcFixtureRow)
}

export async function updateSpcFixture(
  id: string,
  input: SpcFixtureInput,
  action: "save" | "complete",
  session: SpcSession,
  request: Request,
) {
  const fixtureId = cleanString(id)
  if (!fixtureId) throw new Error("Fixture id is required.")

  const context = createSpcAuditContext(session, request, "spc-fixtures")
  const supabase = createSpcAuditedSupabaseClient(context)
  const existing = await loadFixtureRow(supabase, fixtureId)

  if (
    existing.fixture_status === "pending" &&
    session.role !== "SUPPLIER TRADER" &&
    session.role !== "ADMIN"
  ) {
    throw new Error("Only supplier traders and admins can edit this new stem.")
  }

  const users = await listActiveSpcUserOptions()
  const supplierTrader = resolveUserChoice(users, input.supplierTrader)
  const buyerTrader = resolveUserChoice(users, input.buyerTrader)

  const allowExistingTraderNames = existing.fixture_status === "completed" && action === "save"
  if (!supplierTrader && !allowExistingTraderNames) throw new Error("Select a valid supplier trader.")
  if (!buyerTrader && !allowExistingTraderNames) throw new Error("Select a valid buyer trader.")

  const fixtureDate = cleanDate(input.fixtureDate) || existing.fixture_date || hongKongDate()
  const account = normalizeAccount(input.account, users)
  const earliestEta = normalizeEta(input.earliestEta)
  const vesselName = optionalString(input.vesselName)
  const hsfo = optionalString(formatQuantityString(input.hsfo))
  const vlsfo = optionalString(formatQuantityString(input.vlsfo))
  const lsmgo = optionalString(formatQuantityString(input.lsmgo))
  const activeFuelKeys = fuelColumns
    .filter(({ key }) => (key === "hsfo" ? hsfo : key === "vlsfo" ? vlsfo : lsmgo))
    .map(({ key }) => key)
  const supplierName = normalizeGradeField(input.supplierName, activeFuelKeys, { supplier: true })
  const price = normalizeGradeField(input.price, activeFuelKeys, { numeric: true })
  const barging = normalizeGradeField(input.barging, activeFuelKeys, { numeric: true })

  if (cleanString(input.account) && !account) throw new Error("Select a valid ACCT.")
  if (cleanString(input.earliestEta) && !earliestEta) throw new Error("Select a valid ETA.")

  if (action === "complete") {
    const missing: string[] = []
    if (!fixtureDate) missing.push("DATE")
    if (!supplierTrader?.username) missing.push("SUPPLIER TRADER")
    if (!buyerTrader?.username) missing.push("BUYER TRADER")
    if (!account) missing.push("ACCT")
    if (!earliestEta) missing.push("ETA")
    if (!vesselName) missing.push("VESSEL")
    if (activeFuelKeys.length === 0) missing.push("GRADE")
    activeFuelKeys.forEach((key) => {
      if (!gradeValue(supplierName, key)) missing.push(`SUPPLIER ${key.toUpperCase()}`)
      if (!formatIntegerString(gradeValue(price, key))) missing.push(`PRICE ${key.toUpperCase()}`)
    })
    if (missing.length > 0) throw new Error(`Complete ${missing.join(", ")} before completing.`)
  }

  const now = new Date().toISOString()
  const completed = action === "complete"
  const primarySupplier = activeFuelKeys.map((key) => gradeValue(supplierName, key)).find(Boolean) || cleanString(supplierName)
  const payload = {
    fixture_status: completed ? "completed" : existing.fixture_status,
    fixture_date: fixtureDate,
    supplier_trader_user_id: supplierTrader?.id || existing.supplier_trader_user_id,
    supplier_trader_username: supplierTrader?.username || existing.supplier_trader_username,
    supplier_trader_display_name: supplierTrader?.displayName || existing.supplier_trader_display_name,
    buyer_trader_user_id: buyerTrader?.id || existing.buyer_trader_user_id,
    buyer_trader_username: buyerTrader?.username || existing.buyer_trader_username,
    buyer_trader_display_name: buyerTrader?.displayName || existing.buyer_trader_display_name,
    account,
    commission: optionalString(input.commission),
    earliest_eta: earliestEta,
    vessel_name: vesselName,
    hsfo,
    vlsfo,
    lsmgo,
    supplier_name: supplierName || null,
    supplier_key: primarySupplier ? supplierKey(primarySupplier) : null,
    price,
    barging,
    completed_at: completed ? existing.completed_at || now : existing.completed_at,
    completed_by_username: completed ? session.username : existing.completed_by_username,
    completed_by_display_name: completed ? session.displayName || session.username : existing.completed_by_display_name,
    updated_at: now,
  }

  const { error } = await supabase
    .from("spc_fixtures")
    .update(payload)
    .eq("id", fixtureId)

  if (error) throw error

  if (primarySupplier) {
    const { error: enquiryError } = await supabase
      .from("spc_enquiries")
      .update({ supplier_name: primarySupplier, updated_at: now })
      .eq("id", existing.enquiry_id)
    if (enquiryError) throw enquiryError
  }

  return loadMappedFixture(supabase, fixtureId)
}

export async function deleteSpcFixture(
  id: string,
  session: SpcSession,
  request: Request,
) {
  const fixtureId = cleanString(id)
  if (!fixtureId) throw new Error("Fixture id is required.")

  const context = createSpcAuditContext(session, request, "spc-fixtures")
  const supabase = createSpcAuditedSupabaseClient(context)
  const existing = await loadFixtureRow(supabase, fixtureId)

  if (existing.fixture_status === "pending" && !sameUsername(session.username, existing.supplier_trader_username)) {
    throw new Error("Only the assigned supplier trader can edit this new stem.")
  }

  const { error } = await supabase
    .from("spc_fixtures")
    .delete()
    .eq("id", fixtureId)

  if (error) throw error
  return fixtureId
}
