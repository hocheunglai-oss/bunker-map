import type { SpcSession } from "@/lib/spcAuth"
import { hasSpcPagePermission } from "@/lib/spcAuth"
import { createSpcAuditContext, createSpcAuditedSupabaseClient } from "@/lib/spcAudit"
import { readSpcEnquiryMeta } from "@/lib/spcEnquiryText"
import {
  cleanSpcImo,
  normalizeSpcVesselIdentity,
  spcVesselIdentitiesMatch,
  spcVesselIdentityKeys,
  spcVesselIdentityKeysFromValues,
} from "@/lib/spcVesselIdentity"

type HistoryEnquiryRow = {
  id: string
  vessel_name: string | null
  status: string
  notes: string | null
  supplier_name: string | null
  created_at: string
  updated_at: string
}

type HistoryFixtureRow = {
  id: string
  enquiry_id: string
  fixture_status: string
  fixture_date: string | null
  vessel_name: string | null
  supplier_name: string | null
  supplier_trader_display_name: string | null
  completed_at: string | null
  created_at: string
  enquiry?: {
    vessel_name?: string | null
    notes?: string | null
  } | null
}

export type SpcPreviousFixedRecord = {
  id: string
  date: string | null
  supplier: string
  supplierTrader: string
}

export type SpcPreviousLostRecord = {
  id: string
  date: string
  reason: string
}

export type SpcVesselHistory = {
  fixed: SpcPreviousFixedRecord[]
  lost: SpcPreviousLostRecord[]
  visibility: {
    fixtures: boolean
    lost: boolean
  }
}

const ENQUIRY_SELECT = `
  id,
  vessel_name,
  status,
  notes,
  supplier_name,
  created_at,
  updated_at
`

const FIXTURE_SELECT = `
  id,
  enquiry_id,
  fixture_status,
  fixture_date,
  vessel_name,
  supplier_name,
  supplier_trader_display_name,
  completed_at,
  created_at,
  enquiry:spc_enquiries!spc_fixtures_enquiry_id_fkey(vessel_name, notes)
`

function vesselSearchPattern(value: string) {
  const normalized = normalizeSpcVesselIdentity(value)
  return normalized ? `%${normalized.split(" ").join("%")}%` : ""
}

function resultTimestamp(value: string | null | undefined) {
  const timestamp = Date.parse(value || "")
  return Number.isFinite(timestamp) ? timestamp : 0
}

function deduplicateById<T extends { id: string }>(rows: T[]) {
  return Array.from(new Map(rows.map((row) => [row.id, row])).values())
}

const CANDIDATE_PAGE_SIZE = 250

async function collectCandidatePages<T>(
  loadPage: (from: number, to: number) => Promise<{
    data: T[] | null
    error: unknown
  }>,
) {
  const rows: T[] = []

  for (let from = 0; ; from += CANDIDATE_PAGE_SIZE) {
    const result = await loadPage(from, from + CANDIDATE_PAGE_SIZE - 1)
    if (result.error) throw result.error

    const page = result.data || []
    rows.push(...page)
    if (page.length < CANDIDATE_PAGE_SIZE) return rows
  }
}

async function listCandidateEnquiries(
  supabase: ReturnType<typeof createSpcAuditedSupabaseClient>,
  vesselName: string,
  imo: string,
) {
  const namePattern = vesselSearchPattern(vesselName)
  const results = await Promise.all([
    namePattern
      ? collectCandidatePages<HistoryEnquiryRow>(async (from, to) => {
          const result = await supabase
            .from("spc_enquiries")
            .select(ENQUIRY_SELECT)
            .in("status", ["quoted", "cancelled"])
            .ilike("vessel_name", namePattern)
            .order("updated_at", { ascending: false })
            .order("id", { ascending: true })
            .range(from, to)
          return {
            data: (result.data || []) as unknown as HistoryEnquiryRow[],
            error: result.error,
          }
        })
      : Promise.resolve([] as HistoryEnquiryRow[]),
    imo
      ? collectCandidatePages<HistoryEnquiryRow>(async (from, to) => {
          const result = await supabase
            .from("spc_enquiries")
            .select(ENQUIRY_SELECT)
            .in("status", ["quoted", "cancelled"])
            .ilike("notes", `%${imo}%`)
            .order("updated_at", { ascending: false })
            .order("id", { ascending: true })
            .range(from, to)
          return {
            data: (result.data || []) as unknown as HistoryEnquiryRow[],
            error: result.error,
          }
        })
      : Promise.resolve([] as HistoryEnquiryRow[]),
  ])

  return deduplicateById(results.flat())
}

async function listCandidateFixtures(
  supabase: ReturnType<typeof createSpcAuditedSupabaseClient>,
  vesselName: string,
  enquiryIds: string[],
) {
  const namePattern = vesselSearchPattern(vesselName)
  const enquiryIdBatches = Array.from(
    { length: Math.ceil(enquiryIds.length / 100) },
    (_, index) => enquiryIds.slice(index * 100, index * 100 + 100),
  )
  const results = await Promise.all([
    namePattern
      ? collectCandidatePages<HistoryFixtureRow>(async (from, to) => {
          const result = await supabase
            .from("spc_fixtures")
            .select(FIXTURE_SELECT)
            .eq("fixture_status", "completed")
            .ilike("vessel_name", namePattern)
            .order("completed_at", { ascending: false, nullsFirst: false })
            .order("id", { ascending: true })
            .range(from, to)
          return {
            data: (result.data || []) as unknown as HistoryFixtureRow[],
            error: result.error,
          }
        })
      : Promise.resolve([] as HistoryFixtureRow[]),
    ...enquiryIdBatches.map((ids) =>
      collectCandidatePages<HistoryFixtureRow>(async (from, to) => {
        const result = await supabase
          .from("spc_fixtures")
          .select(FIXTURE_SELECT)
          .eq("fixture_status", "completed")
          .in("enquiry_id", ids)
          .order("completed_at", { ascending: false, nullsFirst: false })
          .order("id", { ascending: true })
          .range(from, to)
        return {
          data: (result.data || []) as unknown as HistoryFixtureRow[],
          error: result.error,
        }
      }),
    ),
  ])

  return deduplicateById(results.flat())
}

export async function listSpcVesselHistory(
  session: SpcSession,
  request: Request,
  input: { vesselName?: string; imo?: string },
): Promise<SpcVesselHistory> {
  const vesselName = String(input.vesselName || "").trim().slice(0, 120)
  const imo = cleanSpcImo(input.imo)
  const targetKeys = spcVesselIdentityKeysFromValues(vesselName, imo)
  const visibility = {
    fixtures: hasSpcPagePermission(session, "spc-fixtures", "view"),
    lost: hasSpcPagePermission(session, "spc-lost-record", "view"),
  }

  if (targetKeys.length === 0 || (!visibility.fixtures && !visibility.lost)) {
    return { fixed: [], lost: [], visibility }
  }

  const context = createSpcAuditContext(session, request, "spc-buyer-enquiries", {
    action: "lookup-vessel-history",
    targetType: "spc-vessel",
    targetId: imo || normalizeSpcVesselIdentity(vesselName),
  })
  const supabase = createSpcAuditedSupabaseClient(context)
  const enquiries = await listCandidateEnquiries(supabase, vesselName, imo)
  const matchingEnquiries = enquiries.filter((row) =>
    spcVesselIdentitiesMatch(targetKeys, spcVesselIdentityKeys(row.vessel_name, row.notes)),
  )

  const fixtures = visibility.fixtures
    ? await listCandidateFixtures(supabase, vesselName, matchingEnquiries.map((row) => row.id))
    : []

  const fixed = fixtures
    .filter((row) => {
      const keys = spcVesselIdentityKeys(
        row.enquiry?.vessel_name || row.vessel_name,
        row.enquiry?.notes,
      )
      return spcVesselIdentitiesMatch(targetKeys, keys)
    })
    .sort((left, right) =>
      resultTimestamp(right.completed_at || right.fixture_date || right.created_at) -
      resultTimestamp(left.completed_at || left.fixture_date || left.created_at),
    )
    .slice(0, 3)
    .map<SpcPreviousFixedRecord>((row) => ({
      id: row.id,
      date: row.fixture_date || row.completed_at || row.created_at,
      supplier: row.supplier_name || "SUPPLIER NOT SET",
      supplierTrader: row.supplier_trader_display_name || "",
    }))

  const lost = visibility.lost
    ? matchingEnquiries
        .filter((row) => row.status === "cancelled")
        .sort((left, right) => resultTimestamp(right.updated_at) - resultTimestamp(left.updated_at))
        .slice(0, 3)
        .map<SpcPreviousLostRecord>((row) => {
          const meta = readSpcEnquiryMeta(row.notes)
          return {
            id: row.id,
            date: meta.outcomeAt || row.updated_at || row.created_at,
            reason: meta.lostReason || "UNKNOWN",
          }
        })
    : []

  return { fixed, lost, visibility }
}
