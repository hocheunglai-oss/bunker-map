import type { SpcSession } from "@/lib/spcAuth"
import { createSpcAuditContext, createSpcAuditedSupabaseClient } from "@/lib/spcAudit"
import {
  formatSpcEnquiry,
  readSpcEnquiryMeta,
  writeSpcEnquiryNotes,
  type SpcEnquiryMeta,
} from "@/lib/spcEnquiryText"
import { ensurePendingSpcFixtureForEnquiry } from "@/lib/spcFixtures"

export type SpcEnquiry = {
  id: string
  enquiryNumber: string
  title: string
  vesselName: string | null
  port: string | null
  product: string | null
  quantity: string | null
  deliveryDate: string | null
  supplierName: string | null
  status: string
  notes: string | null
  meta: SpcEnquiryMeta
  formattedText: string
  createdByUsername: string
  createdByDisplayName: string
  createdAt: string
  updatedAt: string
}

export type SaveSpcEnquiryInput = {
  title?: string
  vesselName?: string
  port?: string
  product?: string
  quantity?: string
  deliveryDate?: string
  supplierName?: string
  notes?: string
}

export type SpcEnquiryListOptions = {
  status?: string
  limit?: number
  updatedAfter?: string
}

export type SpcEnquiryOutcome = "stem" | "lost" | "postpone" | "cancel"

export type SpcEnquiryOutcomeInput = {
  outcome: SpcEnquiryOutcome
  lostReason?: string
  supplierTraderUsername?: string
  supplierTraderDisplayName?: string
}

export type SpcFixtureInput = {
  supplier?: string
  eta?: string
  hsfo?: string
  vlsfo?: string
  lsmgo?: string
  price?: string
  barging?: string
}

export type ReofferSpcEnquiryInput = SaveSpcEnquiryInput

type SpcEnquiryRow = {
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

function cleanText(value: string | undefined) {
  const trimmed = value?.trim() || ""
  return trimmed || null
}

function cleanDateInput(value: string | undefined) {
  const trimmed = value?.trim() || ""
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : null
}

function mapEnquiry(row: SpcEnquiryRow): SpcEnquiry {
  const meta = readSpcEnquiryMeta(row.notes)
  const mapped = {
    id: row.id,
    enquiryNumber: row.enquiry_number,
    title: row.title,
    vesselName: row.vessel_name,
    port: row.port,
    product: row.product,
    quantity: row.quantity,
    deliveryDate: row.delivery_date,
    supplierName: row.supplier_name,
    status: row.status,
    notes: row.notes,
    meta,
    formattedText: "",
    createdByUsername: row.created_by_username,
    createdByDisplayName: row.created_by_display_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
  mapped.formattedText = formatSpcEnquiry(mapped)
  return mapped
}

async function loadSpcEnquiryRow(
  supabase: ReturnType<typeof createSpcAuditedSupabaseClient>,
  enquiryId: string,
) {
  const { data, error } = await supabase
    .from("spc_enquiries")
    .select("*")
    .eq("id", enquiryId)
    .single()

  if (error) throw error
  return data as SpcEnquiryRow
}

export async function listSpcEnquiries(session: SpcSession, options: SpcEnquiryListOptions = {}) {
  const context = createSpcAuditContext(session, undefined, "spc-buyer-enquiries")
  const supabase = createSpcAuditedSupabaseClient(context)
  const limit = Math.min(Math.max(Number(options.limit || 250), 1), 250)
  let query = supabase
    .from("spc_enquiries")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit)

  if (options.status) {
    query = query.eq("status", options.status)
  }

  if (options.updatedAfter) {
    query = query.gt("updated_at", options.updatedAfter)
  }

  const { data, error } = await query

  if (error) throw error
  return ((data || []) as unknown as SpcEnquiryRow[]).map(mapEnquiry)
}

export async function createSpcEnquiry(
  input: SaveSpcEnquiryInput,
  session: SpcSession,
  request: Request,
) {
  const title = cleanText(input.title)
  if (!title) throw new Error("Enquiry title is required.")
  if (!session.username) throw new Error("Authenticated username is required.")

  const context = createSpcAuditContext(session, request, "spc-buyer-enquiries")
  const supabase = createSpcAuditedSupabaseClient(context)
  const notes = cleanText(input.notes)
  const duplicateWindow = new Date(Date.now() - 120000).toISOString()
  const duplicateQuery = supabase
    .from("spc_enquiries")
    .select("*")
    .eq("created_by_username", session.username)
    .eq("status", "sent")
    .gte("created_at", duplicateWindow)
    .order("created_at", { ascending: false })
    .limit(1)

  const { data: duplicate, error: duplicateError } = notes
    ? await duplicateQuery.eq("notes", notes).maybeSingle()
    : await duplicateQuery.eq("title", title).maybeSingle()

  if (duplicateError) throw duplicateError
  if (duplicate) return mapEnquiry(duplicate as SpcEnquiryRow)

  const { data, error } = await supabase
    .from("spc_enquiries")
    .insert({
      title,
      vessel_name: cleanText(input.vesselName),
      port: cleanText(input.port),
      product: cleanText(input.product),
      quantity: cleanText(input.quantity),
      delivery_date: cleanDateInput(input.deliveryDate),
      supplier_name: cleanText(input.supplierName),
      notes,
      status: "sent",
      created_by_username: session.username,
      created_by_display_name: session.displayName || session.username,
    })
    .select("*")
    .single()

  if (error) throw error
  return mapEnquiry(data as SpcEnquiryRow)
}

export async function updateSpcEnquiryOutcome(
  id: string,
  input: SpcEnquiryOutcomeInput,
  session: SpcSession,
  request: Request,
) {
  const enquiryId = cleanText(id)
  if (!enquiryId) throw new Error("Enquiry id is required.")
  const outcome = input.outcome
  if (outcome !== "stem" && outcome !== "lost" && outcome !== "postpone" && outcome !== "cancel") {
    throw new Error("Outcome is required.")
  }
  if (outcome === "lost" && !cleanText(input.lostReason)) {
    throw new Error("Lost reason is required.")
  }
  if (outcome === "stem" && !cleanText(input.supplierTraderUsername)) {
    throw new Error("Supplier trader is required.")
  }

  const context = createSpcAuditContext(session, request, "spc-buyer-enquiries")
  const supabase = createSpcAuditedSupabaseClient(context)
  const existing = await loadSpcEnquiryRow(supabase, enquiryId)
  const status =
    outcome === "stem"
      ? "quoted"
      : outcome === "lost"
        ? "cancelled"
        : outcome === "cancel"
          ? "closed"
          : existing.status || "sent"
  const now = new Date().toISOString()
  const currentText = formatSpcEnquiry(existing)
  const nextMeta: SpcEnquiryMeta = {
    ...readSpcEnquiryMeta(existing.notes),
  }

  if (outcome === "lost") {
    nextMeta.outcomeAt = now
    nextMeta.lostReason = cleanText(input.lostReason) || undefined
    nextMeta.stemSupplierTraderUsername = undefined
    nextMeta.stemSupplierTraderDisplayName = undefined
    nextMeta.postponedAt = undefined
    nextMeta.cancelledAt = undefined
  } else if (outcome === "stem") {
    nextMeta.outcomeAt = now
    nextMeta.lostReason = undefined
    nextMeta.stemSupplierTraderUsername = cleanText(input.supplierTraderUsername) || undefined
    nextMeta.stemSupplierTraderDisplayName =
      cleanText(input.supplierTraderDisplayName) || cleanText(input.supplierTraderUsername) || undefined
    nextMeta.postponedAt = undefined
    nextMeta.cancelledAt = undefined
  } else if (outcome === "cancel") {
    nextMeta.outcomeAt = now
    nextMeta.cancelledAt = now
    nextMeta.lostReason = undefined
    nextMeta.stemSupplierTraderUsername = undefined
    nextMeta.stemSupplierTraderDisplayName = undefined
    nextMeta.postponedAt = undefined
  } else {
    nextMeta.postponedAt = now
  }

  const { data, error } = await supabase
    .from("spc_enquiries")
    .update({
      status,
      notes: writeSpcEnquiryNotes(currentText, nextMeta),
      updated_at: now,
    })
    .eq("id", enquiryId)
    .select("*")
    .single()

  if (error) throw error
  if (outcome === "stem") {
    await ensurePendingSpcFixtureForEnquiry(data as SpcEnquiryRow, session, request)
  }
  return mapEnquiry(data as SpcEnquiryRow)
}

export async function reofferSpcEnquiry(
  id: string,
  input: ReofferSpcEnquiryInput,
  session: SpcSession,
  request: Request,
) {
  const enquiryId = cleanText(id)
  if (!enquiryId) throw new Error("Enquiry id is required.")
  const title = cleanText(input.title)
  if (!title) throw new Error("Enquiry title is required.")
  if (!session.username) throw new Error("Authenticated username is required.")

  const context = createSpcAuditContext(session, request, "spc-buyer-enquiries")
  const supabase = createSpcAuditedSupabaseClient(context)
  const existing = await loadSpcEnquiryRow(supabase, enquiryId)
  const currentText = formatSpcEnquiry(existing)
  const providedNotes = cleanText(input.notes)
  const now = new Date().toISOString()
  const newMeta: SpcEnquiryMeta = {
    ...readSpcEnquiryMeta(providedNotes),
    outcomeAt: undefined,
    postponedAt: undefined,
    cancelledAt: undefined,
    lostReason: undefined,
    stemSupplierTraderUsername: undefined,
    stemSupplierTraderDisplayName: undefined,
  }

  const { data, error } = await supabase
    .from("spc_enquiries")
    .insert({
      title,
      vessel_name: cleanText(input.vesselName),
      port: cleanText(input.port),
      product: cleanText(input.product),
      quantity: cleanText(input.quantity),
      delivery_date: cleanDateInput(input.deliveryDate),
      supplier_name: cleanText(input.supplierName),
      notes: writeSpcEnquiryNotes(providedNotes || currentText, newMeta),
      status: "sent",
      created_by_username: session.username,
      created_by_display_name: session.displayName || session.username,
    })
    .select("*")
    .single()

  if (error) throw error

  const retiredMeta: SpcEnquiryMeta = {
    ...readSpcEnquiryMeta(existing.notes),
    outcomeAt: now,
    postponedAt: undefined,
    cancelledAt: now,
    lostReason: undefined,
    stemSupplierTraderUsername: undefined,
    stemSupplierTraderDisplayName: undefined,
  }

  const { error: retireError } = await supabase
    .from("spc_enquiries")
    .update({
      status: "closed",
      notes: writeSpcEnquiryNotes(currentText, retiredMeta),
      updated_at: now,
    })
    .eq("id", enquiryId)

  if (retireError) {
    console.error("Failed to retire reoffered SPC enquiry", retireError)
  }

  return mapEnquiry(data as SpcEnquiryRow)
}

export async function updateSpcEnquiryFixture(
  id: string,
  fixture: SpcFixtureInput,
  session: SpcSession,
  request: Request,
) {
  const enquiryId = cleanText(id)
  if (!enquiryId) throw new Error("Enquiry id is required.")

  const context = createSpcAuditContext(session, request, "spc-fixtures")
  const supabase = createSpcAuditedSupabaseClient(context)
  const existing = await loadSpcEnquiryRow(supabase, enquiryId)
  const currentText = formatSpcEnquiry(existing)
  const now = new Date().toISOString()
  const nextMeta: SpcEnquiryMeta = {
    ...readSpcEnquiryMeta(existing.notes),
    fixtureSupplier: cleanText(fixture.supplier) || undefined,
    eta: cleanText(fixture.eta) || undefined,
    hsfo: cleanText(fixture.hsfo) || undefined,
    vlsfo: cleanText(fixture.vlsfo) || undefined,
    lsmgo: cleanText(fixture.lsmgo) || undefined,
    price: cleanText(fixture.price) || undefined,
    barging: cleanText(fixture.barging) || undefined,
  }

  const { data, error } = await supabase
    .from("spc_enquiries")
    .update({
      supplier_name: nextMeta.fixtureSupplier || existing.supplier_name,
      notes: writeSpcEnquiryNotes(currentText, nextMeta),
      updated_at: now,
    })
    .eq("id", enquiryId)
    .select("*")
    .single()

  if (error) throw error
  return mapEnquiry(data as SpcEnquiryRow)
}
