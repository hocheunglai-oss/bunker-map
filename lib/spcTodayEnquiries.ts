import { formatSpcEnquiry, readSpcEnquiryMeta, type SpcEnquiryMeta } from "@/lib/spcEnquiryText"
import {
  addSpcHistoricalMatch,
  firstPreviousSpcIdentityMatch,
  spcVesselIdentityKeys,
  spcVesselIdentityKeysFromValues,
  type SpcHistoricalMatch,
} from "@/lib/spcVesselIdentity"

export { firstPreviousSpcIdentityMatch } from "@/lib/spcVesselIdentity"

export type SpcRecordEnquiryRow = {
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

export type SpcRecordFixtureRow = {
  id: string
  fixture_date: string | null
  supplier_trader_display_name: string
  buyer_trader_display_name: string
  vessel_name: string | null
  vessel_imo: string | null
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

function fixtureResult(row: SpcRecordFixtureRow): SpcTodayPreviousFixture {
  return {
    date: row.fixture_date || row.completed_at,
    supplier: row.supplier_name || "",
    price: row.price || "",
    barging: row.barging || "",
    supplierTrader: row.supplier_trader_display_name || "",
  }
}

function lostResult(row: Pick<SpcRecordEnquiryRow, "notes" | "updated_at" | "created_at">): SpcTodayPreviousLost {
  const meta = readSpcEnquiryMeta(row.notes)
  return {
    date: meta.outcomeAt || row.updated_at || row.created_at,
    buyerReason: meta.lostReason || "UNKNOWN",
    supplierReason: meta.supplierLostReason || "",
    supplierReasonDetails: meta.supplierLostReasonDetails || "",
    spcComments: meta.spcComments || "",
  }
}

export type SpcRecordLostHistoryRow = Pick<SpcRecordEnquiryRow, "id" | "vessel_name" | "notes" | "created_at" | "updated_at">

// Inputs are the complete conservative candidates from one STABLE statement.
// Keep final Date.parse, metadata and Unicode identity semantics in TypeScript.
export function mapSpcTodayEnquiries(rows: SpcRecordEnquiryRow[], fixtures: SpcRecordFixtureRow[], lost: SpcRecordLostHistoryRow[]) {
  const fixtureByIdentity = new Map<string, SpcHistoricalMatch<SpcTodayPreviousFixture>[]>()
  fixtures.forEach((row) => {
    const keys = spcVesselIdentityKeysFromValues(
      row.vessel_name || row.enquiry?.vessel_name,
      row.vessel_imo,
    )
    const at = Date.parse(row.completed_at || row.created_at || row.fixture_date || "")
    if (Number.isFinite(at)) addSpcHistoricalMatch(fixtureByIdentity, keys, { at, value: fixtureResult(row) })
  })

  const lostByIdentity = new Map<string, SpcHistoricalMatch<SpcTodayPreviousLost>[]>()
  lost.forEach((row) => {
    const keys = spcVesselIdentityKeys(row.vessel_name, row.notes)
    const at = Date.parse(readSpcEnquiryMeta(row.notes).outcomeAt || row.updated_at || row.created_at)
    if (Number.isFinite(at)) addSpcHistoricalMatch(lostByIdentity, keys, { at, value: lostResult(row) })
  })

  return rows.map<SpcTodayEnquiry>((row) => {
    const keys = spcVesselIdentityKeys(row.vessel_name, row.notes)
    return {
      id: row.id,
      enquiryNumber: row.enquiry_number,
      vesselName: row.vessel_name || row.title,
      status: row.status,
      formattedText: formatSpcEnquiry({ ...row, vesselName: row.vessel_name, deliveryDate: row.delivery_date }),
      createdByDisplayName: row.created_by_display_name || row.created_by_username,
      createdAt: row.created_at,
      meta: readSpcEnquiryMeta(row.notes),
      previousFixture: firstPreviousSpcIdentityMatch(fixtureByIdentity, keys, row.created_at),
      previousLost: firstPreviousSpcIdentityMatch(lostByIdentity, keys, row.created_at),
    }
  })
}
