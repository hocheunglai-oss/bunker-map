import type { SpcSession } from "@/lib/spcAuth"
import { createSpcAuditContext, createSpcAuditedSupabaseClient } from "@/lib/spcAudit"
import { normaliseSpcRole } from "@/lib/spcPages"
import { formatSpcEnquiry, readSpcEnquiryMeta, writeSpcEnquiryNotes } from "@/lib/spcEnquiryText"

export type SpcLostReasonAudience = "BUYER TRADER" | "SUPPLIER TRADER"

export const DEFAULT_BUYER_LOST_REASONS = [
  "MINIMUM MARGIN",
  "CREDIT OR PAYMENT TERMS",
  "COVERAGE (SUPPLIER NOT COVERED)",
  "COVERAGE (LIMITED BY CUSTOMER)",
  "NOT TIMELY OFFERED",
  "DOUBLE TRADING",
  "T&C",
  "UNKNOWN",
] as const

export const DEFAULT_SUPPLIER_LOST_REASONS = [
  "SUPPLIER NO AVAILS",
  "SUPPLIER LATE RESPONSE",
  "LIMITED SUPPLIER POOL - SIZE",
  "LIMITED SUPPLIER POOL - SPECS",
  "LIMITED SUPPLIER POOL - SPECIAL REQUIREMENTS",
  "UNABLE TO MEET REQUIRED OFFER TIMING",
  "SUPPLIER WITHDREW",
  "CREDIT OR COMPLIANCE",
  "OTHER",
] as const

const FALLBACKS: Record<SpcLostReasonAudience, readonly string[]> = {
  "BUYER TRADER": DEFAULT_BUYER_LOST_REASONS,
  "SUPPLIER TRADER": DEFAULT_SUPPLIER_LOST_REASONS,
}

function cleanReason(value: unknown) {
  return typeof value === "string"
    ? value.trim().replace(/\s+/g, " ").toUpperCase().slice(0, 160)
    : ""
}

function cleanComment(value: unknown, maximumLength = 2_000) {
  return typeof value === "string" ? value.trim().slice(0, maximumLength) : ""
}

export async function listSpcLostReasons(
  session: SpcSession,
  request: Request,
  audience: SpcLostReasonAudience,
) {
  const context = createSpcAuditContext(session, request, "spc-lost-record", {
    action: "list-lost-reasons",
    targetType: "spc-lost-reason-options",
    targetId: audience,
  })
  const supabase = createSpcAuditedSupabaseClient(context)
  const { data, error } = await supabase
    .from("spc_lost_reason_options")
    .select("reason")
    .eq("audience", audience)
    .eq("is_active", true)
    .order("sort_order", { ascending: true })
    .order("reason", { ascending: true })

  if (error) {
    console.error("SPC lost reasons fallback used", error.message)
    return [...FALLBACKS[audience]]
  }
  const reasons = (data || []).map((row) => cleanReason(row.reason)).filter(Boolean)
  return reasons.length > 0 ? reasons : [...FALLBACKS[audience]]
}

export async function replaceSpcLostReasons(
  session: SpcSession,
  request: Request,
  audience: SpcLostReasonAudience,
  values: unknown,
) {
  if (normaliseSpcRole(session.role) !== "ADMIN") throw new Error("Forbidden")
  const reasons = Array.isArray(values)
    ? Array.from(new Set(values.map(cleanReason).filter(Boolean))).slice(0, 50)
    : []
  if (reasons.length === 0) throw new Error("At least one lost reason is required.")
  if (audience === "SUPPLIER TRADER" && !reasons.includes("OTHER")) {
    throw new Error("Supplier lost reasons must include OTHER.")
  }

  const context = createSpcAuditContext(session, request, "spc-lost-record", {
    action: "replace-lost-reasons",
    targetType: "spc-lost-reason-options",
    targetId: audience,
  })
  const supabase = createSpcAuditedSupabaseClient(context)
  const { data, error } = await supabase.rpc("replace_spc_lost_reason_options", {
    p_audience: audience,
    p_reasons: reasons,
  })
  if (error) throw error
  const savedReasons = Array.isArray(data)
    ? data
        .map((row) => cleanReason((row as { reason?: unknown }).reason))
        .filter(Boolean)
    : []
  return savedReasons.length > 0 ? savedReasons : reasons
}

export async function updateSpcLostRecordReview(
  session: SpcSession,
  request: Request,
  input: {
    id: unknown
    supplierLostReason: unknown
    supplierLostReasonDetails: unknown
    spcComments: unknown
  },
) {
  const role = normaliseSpcRole(session.role)
  if (role !== "SUPPLIER TRADER" && role !== "ADMIN") throw new Error("Forbidden")
  const id = cleanComment(input.id, 80)
  if (!id) throw new Error("Enquiry id is required.")
  const supplierLostReason = cleanReason(input.supplierLostReason)
  const supplierLostReasonDetails = cleanComment(input.supplierLostReasonDetails, 500)
  const spcComments = cleanComment(input.spcComments)
  if (supplierLostReason === "OTHER" && !supplierLostReasonDetails) {
    throw new Error("Please specify the supplier reason for OTHER.")
  }
  if (supplierLostReason !== "OTHER" && supplierLostReasonDetails) {
    throw new Error("Supplier reason details are only accepted for OTHER.")
  }

  const allowedReasons = await listSpcLostReasons(session, request, "SUPPLIER TRADER")
  if (supplierLostReason && !allowedReasons.includes(supplierLostReason)) {
    throw new Error("Select a valid supplier lost reason.")
  }

  const context = createSpcAuditContext(session, request, "spc-lost-record", {
    action: "review-lost-enquiry",
    targetType: "spc-enquiry",
    targetId: id,
  })
  const supabase = createSpcAuditedSupabaseClient(context)
  const { data: existing, error: loadError } = await supabase
    .from("spc_enquiries")
    .select("*")
    .eq("id", id)
    .eq("status", "cancelled")
    .single()
  if (loadError || !existing) throw loadError || new Error("Lost enquiry not found.")

  const now = new Date().toISOString()
  const meta = readSpcEnquiryMeta(existing.notes)
  const nextMeta = {
    ...meta,
    supplierLostReason: supplierLostReason || undefined,
    supplierLostReasonDetails: supplierLostReasonDetails || undefined,
    supplierLostReasonUpdatedAt: now,
    supplierLostReasonUpdatedByUsername: session.username || undefined,
    supplierLostReasonUpdatedByDisplayName: session.displayName || session.username || undefined,
    spcComments: spcComments || undefined,
    spcCommentsUpdatedAt: now,
    spcCommentsUpdatedByUsername: session.username || undefined,
    spcCommentsUpdatedByDisplayName: session.displayName || session.username || undefined,
  }
  const { data, error } = await supabase
    .from("spc_enquiries")
    .update({
      notes: writeSpcEnquiryNotes(formatSpcEnquiry(existing), nextMeta),
      updated_at: now,
    })
    .eq("id", id)
    .eq("updated_at", existing.updated_at)
    .select("*")
    .single()
  if (error) {
    if (error.code === "PGRST116") {
      throw new Error("This lost record changed while you were editing. Refresh and try again.")
    }
    throw error
  }
  return { id: data.id, meta: readSpcEnquiryMeta(data.notes), updatedAt: data.updated_at }
}
