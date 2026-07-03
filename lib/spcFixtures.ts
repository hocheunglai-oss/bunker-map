import type { SpcSession } from "@/lib/spcAuth"
import { createSpcAuditContext, createSpcAuditedSupabaseClient } from "@/lib/spcAudit"
import {
  formatSpcEnquiry,
  parseSpcEnquiryText,
  readSpcEnquiryMeta,
} from "@/lib/spcEnquiryText"
import { displaySupplierName, supplierKey } from "@/lib/spcSupplierKeys"
import { listActiveSpcUserOptions, type SpcUserOption } from "@/lib/spcUsers"

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

function findUserByUsername(users: SpcUserOption[], username: string | null | undefined) {
  const target = cleanString(username).toLowerCase()
  if (!target) return null
  return users.find((user) => user.username.toLowerCase() === target) || null
}

function resolveUserChoice(users: SpcUserOption[], input: unknown) {
  const value = cleanString(input)
  if (!value) return null
  const lowerValue = value.toLowerCase()
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

  return null
}

function extractInitialFuel(text: string, aliases: string[]) {
  const pattern = new RegExp(`\\b(${aliases.join("|")})\\b\\s*([^/\\n]+)`, "i")
  const match = text.match(pattern)
  return match ? match[2].trim() : ""
}

function mapFixture(row: SpcFixtureRow): SpcFixture {
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
    hsfo: row.hsfo,
    vlsfo: row.vlsfo,
    lsmgo: row.lsmgo,
    supplierName: row.supplier_name,
    supplierKey: row.supplier_key,
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

export async function listSpcFixtures(session: SpcSession, limit = 500) {
  const context = createSpcAuditContext(session, undefined, "spc-fixtures")
  const supabase = createSpcAuditedSupabaseClient(context)
  const safeLimit = Math.min(Math.max(Number(limit || 500), 1), 500)
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
    .select("id, fixture_status")
    .eq("enquiry_id", enquiry.id)
    .maybeSingle()

  if (existingError) throw existingError
  if ((existing as { fixture_status?: string } | null)?.fixture_status === "completed") return

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
    hsfo: optionalString(meta.hsfo || parsed.hsfo || extractInitialFuel(text, ["hsfo", "ifo"])),
    vlsfo: optionalString(meta.vlsfo || parsed.vlsfo || extractInitialFuel(text, ["vlsfo", "lsfo"])),
    lsmgo: optionalString(meta.lsmgo || parsed.lsmgo || extractInitialFuel(text, ["lsmgo", "mgo"])),
    supplier_name: optionalString(meta.fixtureSupplier || enquiry.supplier_name),
    supplier_key: supplierKey(meta.fixtureSupplier || enquiry.supplier_name),
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
  const users = await listActiveSpcUserOptions()
  const supplierTrader = resolveUserChoice(users, input.supplierTrader)
  const buyerTrader = resolveUserChoice(users, input.buyerTrader)

  if (!supplierTrader) throw new Error("Select a valid supplier trader.")
  if (!buyerTrader) throw new Error("Select a valid buyer trader.")

  const supplierName = displaySupplierName(input.supplierName)
  const price = optionalString(input.price)
  if (action === "complete") {
    if (!supplierName) throw new Error("Supplier is required before completing.")
    if (!price) throw new Error("Buying price is required before completing.")
  }

  const now = new Date().toISOString()
  const completed = action === "complete"
  const payload = {
    fixture_status: completed ? "completed" : existing.fixture_status,
    fixture_date: cleanDate(input.fixtureDate) || existing.fixture_date || hongKongDate(),
    supplier_trader_user_id: supplierTrader.id,
    supplier_trader_username: supplierTrader.username,
    supplier_trader_display_name: supplierTrader.displayName,
    buyer_trader_user_id: buyerTrader.id,
    buyer_trader_username: buyerTrader.username,
    buyer_trader_display_name: buyerTrader.displayName,
    account: optionalString(input.account),
    commission: optionalString(input.commission),
    earliest_eta: optionalString(input.earliestEta),
    vessel_name: optionalString(input.vesselName),
    hsfo: optionalString(input.hsfo),
    vlsfo: optionalString(input.vlsfo),
    lsmgo: optionalString(input.lsmgo),
    supplier_name: supplierName || null,
    supplier_key: supplierName ? supplierKey(supplierName) : null,
    price,
    barging: optionalString(input.barging),
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

  if (supplierName) {
    const { error: enquiryError } = await supabase
      .from("spc_enquiries")
      .update({ supplier_name: supplierName, updated_at: now })
      .eq("id", existing.enquiry_id)
    if (enquiryError) throw enquiryError
  }

  return loadMappedFixture(supabase, fixtureId)
}
