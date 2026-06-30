import type { SpcSession } from "@/lib/spcAuth"
import { createSpcAuditContext, createSpcAuditedSupabaseClient } from "@/lib/spcAudit"
import { formatSpcEnquiry } from "@/lib/spcEnquiryText"

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
}

export type SpcEnquiryOutcome = "stem" | "lost"

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

function mapEnquiry(row: SpcEnquiryRow): SpcEnquiry {
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
    formattedText: "",
    createdByUsername: row.created_by_username,
    createdByDisplayName: row.created_by_display_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
  mapped.formattedText = formatSpcEnquiry(mapped)
  return mapped
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
  const { data, error } = await supabase
    .from("spc_enquiries")
    .insert({
      title,
      vessel_name: cleanText(input.vesselName),
      port: cleanText(input.port),
      product: cleanText(input.product),
      quantity: cleanText(input.quantity),
      delivery_date: cleanText(input.deliveryDate),
      supplier_name: cleanText(input.supplierName),
      notes: cleanText(input.notes),
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
  outcome: SpcEnquiryOutcome,
  session: SpcSession,
  request: Request,
) {
  const enquiryId = cleanText(id)
  if (!enquiryId) throw new Error("Enquiry id is required.")

  const context = createSpcAuditContext(session, request, "spc-buyer-enquiries")
  const supabase = createSpcAuditedSupabaseClient(context)
  const status = outcome === "stem" ? "quoted" : "cancelled"

  const { data, error } = await supabase
    .from("spc_enquiries")
    .update({ status })
    .eq("id", enquiryId)
    .select("*")
    .single()

  if (error) throw error
  return mapEnquiry(data as SpcEnquiryRow)
}
