import type { SpcSession } from "@/lib/spcAuth"
import { createSpcAuditContext, createSpcAuditedSupabaseClient } from "@/lib/spcAudit"
import { formatSpcEnquiry, readSpcEnquiryMeta, type SpcEnquiryMeta } from "@/lib/spcEnquiryText"
import {
  addSpcHistoricalMatch,
  firstPreviousSpcIdentityMatch,
  spcVesselIdentityKeys,
  type SpcHistoricalMatch,
} from "@/lib/spcVesselIdentity"

export { firstPreviousSpcIdentityMatch } from "@/lib/spcVesselIdentity"

type EnquiryRow = {
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

type FixtureRow = {
  id: string
  fixture_date: string | null
  supplier_trader_display_name: string
  buyer_trader_display_name: string
  vessel_name: string | null
  supplier_name: string | null
  price: string | null
  barging: string | null
  completed_at: string | null
  created_at: string
  enquiry?: {
    vessel_name?: string | null
    notes?: string | null
  } | null
}

export type SpcTodayPreviousFixture = {
  date: string | null
  supplier: string
  price: string
  barging: string
  supplierTrader: string
}

export type SpcTodayPreviousLost = {
  date: string
  buyerReason: string
  supplierReason: string
  supplierReasonDetails: string
  spcComments: string
}

export type SpcTodayEnquiry = {
  id: string
  enquiryNumber: string
  vesselName: string
  status: string
  formattedText: string
  createdByDisplayName: string
  createdAt: string
  meta: SpcEnquiryMeta
  previousFixture: SpcTodayPreviousFixture | null
  previousLost: SpcTodayPreviousLost | null
}

function hongKongDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Hong_Kong",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date)
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value || ""
  return `${value("year")}-${value("month")}-${value("day")}`
}

function dayStartIso(date = new Date()) {
  return new Date(`${hongKongDateKey(date)}T00:00:00+08:00`).toISOString()
}

function fixtureResult(row: FixtureRow): SpcTodayPreviousFixture {
  return {
    date: row.fixture_date || row.completed_at,
    supplier: row.supplier_name || "",
    price: row.price || "",
    barging: row.barging || "",
    supplierTrader: row.supplier_trader_display_name || "",
  }
}

function lostResult(row: EnquiryRow): SpcTodayPreviousLost {
  const meta = readSpcEnquiryMeta(row.notes)
  return {
    date: meta.outcomeAt || row.updated_at || row.created_at,
    buyerReason: meta.lostReason || "UNKNOWN",
    supplierReason: meta.supplierLostReason || "",
    supplierReasonDetails: meta.supplierLostReasonDetails || "",
    spcComments: meta.spcComments || "",
  }
}

export async function listSpcTodayEnquiries(session: SpcSession, request: Request) {
  const start = dayStartIso()
  const context = createSpcAuditContext(session, request, "spc-today-enquiries", {
    action: "list-today-enquiries",
    targetType: "spc-enquiry",
    targetId: hongKongDateKey(),
  })
  const supabase = createSpcAuditedSupabaseClient(context)
  const [todayResult, fixtureResultSet, lostResultSet] = await Promise.all([
    supabase
      .from("spc_enquiries")
      .select("*")
      .gte("created_at", start)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(250),
    supabase
      .from("spc_fixtures")
      .select(`
        id,
        fixture_date,
        supplier_trader_display_name,
        buyer_trader_display_name,
        vessel_name,
        supplier_name,
        price,
        barging,
        completed_at,
        created_at,
        enquiry:spc_enquiries!spc_fixtures_enquiry_id_fkey(vessel_name, notes)
      `)
      .eq("fixture_status", "completed")
      .order("completed_at", { ascending: false, nullsFirst: false })
      .limit(1000),
    supabase
      .from("spc_enquiries")
      .select("*")
      .eq("status", "cancelled")
      .order("updated_at", { ascending: false })
      .limit(1000),
  ])

  if (todayResult.error) throw todayResult.error
  if (fixtureResultSet.error) throw fixtureResultSet.error
  if (lostResultSet.error) throw lostResultSet.error

  const fixtureByIdentity = new Map<string, SpcHistoricalMatch<SpcTodayPreviousFixture>[]>()
  ;((fixtureResultSet.data || []) as unknown as FixtureRow[]).forEach((row) => {
    const keys = spcVesselIdentityKeys(row.enquiry?.vessel_name || row.vessel_name, row.enquiry?.notes)
    const at = Date.parse(row.completed_at || row.created_at || row.fixture_date || "")
    if (Number.isFinite(at)) addSpcHistoricalMatch(fixtureByIdentity, keys, { at, value: fixtureResult(row) })
  })

  const lostByIdentity = new Map<string, SpcHistoricalMatch<SpcTodayPreviousLost>[]>()
  ;((lostResultSet.data || []) as EnquiryRow[]).forEach((row) => {
    const keys = spcVesselIdentityKeys(row.vessel_name, row.notes)
    const at = Date.parse(readSpcEnquiryMeta(row.notes).outcomeAt || row.updated_at || row.created_at)
    if (Number.isFinite(at)) addSpcHistoricalMatch(lostByIdentity, keys, { at, value: lostResult(row) })
  })

  return ((todayResult.data || []) as EnquiryRow[]).map<SpcTodayEnquiry>((row) => {
    const keys = spcVesselIdentityKeys(row.vessel_name, row.notes)
    return {
      id: row.id,
      enquiryNumber: row.enquiry_number,
      vesselName: row.vessel_name || row.title,
      status: row.status,
      formattedText: formatSpcEnquiry(row),
      createdByDisplayName: row.created_by_display_name || row.created_by_username,
      createdAt: row.created_at,
      meta: readSpcEnquiryMeta(row.notes),
      previousFixture: firstPreviousSpcIdentityMatch(fixtureByIdentity, keys, row.created_at),
      previousLost: firstPreviousSpcIdentityMatch(lostByIdentity, keys, row.created_at),
    }
  })
}
