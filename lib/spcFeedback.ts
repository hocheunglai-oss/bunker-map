import type { SpcSession } from "@/lib/spcAuth"
import {
  createSpcAuditContext,
  createSpcAuditedSupabaseClient,
  type SpcAuditContext,
} from "@/lib/spcAudit"
import { normaliseSpcRole } from "@/lib/spcPages"
import {
  SPC_FEEDBACK_CATEGORIES,
  SPC_FEEDBACK_STATUSES,
  type SpcFeedbackCategory,
  type SpcFeedbackRecord,
  type SpcFeedbackStatus,
} from "@/lib/spcFeedbackShared"

type SpcFeedbackRow = {
  id: string
  category: SpcFeedbackCategory
  title: string
  message: string
  area: string
  status: SpcFeedbackStatus
  admin_response: string
  created_by_user_id: string
  created_by_username: string
  created_by_display_name: string
  reviewed_by_username: string | null
  reviewed_by_display_name: string | null
  created_at: string
  updated_at: string
}

function mapFeedback(row: SpcFeedbackRow): SpcFeedbackRecord {
  return {
    id: row.id,
    category: row.category,
    title: row.title,
    message: row.message,
    area: row.area,
    status: row.status,
    adminResponse: row.admin_response || "",
    createdByUsername: row.created_by_username,
    createdByDisplayName: row.created_by_display_name,
    reviewedByDisplayName: row.reviewed_by_display_name || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function cleanText(value: unknown, label: string, maximumLength: number, required = false) {
  const clean = typeof value === "string" ? value.trim() : ""
  if (required && !clean) throw new Error(`${label} is required.`)
  if (clean.length > maximumLength) throw new Error(`${label} is too long.`)
  if (/\u0000/.test(clean)) throw new Error(`${label} is invalid.`)
  return clean
}

export async function loadSpcFeedback(session: SpcSession, context: SpcAuditContext) {
  if (!session.userId || !session.username) throw new Error("Unauthorized")
  const client = createSpcAuditedSupabaseClient(context)
  let query = client
    .from("spc_feedback")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(250)

  if (normaliseSpcRole(session.role) !== "ADMIN") {
    query = query.eq("created_by_user_id", session.userId)
  }

  const { data, error } = await query
  if (error) throw error
  return ((data || []) as SpcFeedbackRow[]).map(mapFeedback)
}

export async function createSpcFeedback(
  session: SpcSession,
  request: Request,
  input: { category?: unknown; title?: unknown; message?: unknown; area?: unknown },
) {
  if (!session.userId || !session.username) throw new Error("Unauthorized")
  const category = cleanText(input.category, "Category", 40, true).toUpperCase()
  if (!SPC_FEEDBACK_CATEGORIES.includes(category as SpcFeedbackCategory)) {
    throw new Error("Category is invalid.")
  }

  const context = createSpcAuditContext(session, request, "spc-feedback", {
    action: "submit-feedback",
    targetType: "feedback",
  })
  const client = createSpcAuditedSupabaseClient(context)
  const { data, error } = await client
    .from("spc_feedback")
    .insert({
      category,
      title: cleanText(input.title, "Title", 120, true),
      message: cleanText(input.message, "Feedback", 4000, true),
      area: cleanText(input.area, "Area", 80),
      created_by_user_id: session.userId,
      created_by_username: session.username,
      created_by_display_name: session.displayName || session.username,
    })
    .select("*")
    .single()
  if (error) throw error
  return mapFeedback(data as SpcFeedbackRow)
}

export async function reviewSpcFeedback(
  session: SpcSession,
  request: Request,
  input: { id?: unknown; status?: unknown; adminResponse?: unknown },
) {
  if (!session.userId || !session.username) throw new Error("Unauthorized")
  if (normaliseSpcRole(session.role) !== "ADMIN") throw new Error("Forbidden")
  const id = cleanText(input.id, "Feedback record", 64, true)
  const status = cleanText(input.status, "Status", 40, true).toUpperCase()
  if (!SPC_FEEDBACK_STATUSES.includes(status as SpcFeedbackStatus)) {
    throw new Error("Status is invalid.")
  }

  const context = createSpcAuditContext(session, request, "spc-feedback", {
    action: "review-feedback",
    targetType: "feedback",
    targetId: id,
  })
  const client = createSpcAuditedSupabaseClient(context)
  const { data, error } = await client
    .from("spc_feedback")
    .update({
      status,
      admin_response: cleanText(input.adminResponse, "Response", 2000),
      reviewed_by_username: session.username,
      reviewed_by_display_name: session.displayName || session.username,
    })
    .eq("id", id)
    .select("*")
    .single()
  if (error) throw error
  return mapFeedback(data as SpcFeedbackRow)
}

export function createSpcFeedbackReadContext(session: SpcSession, request: Request) {
  return createSpcAuditContext(session, request, "spc-feedback", {
    action: "view-feedback",
    targetType: "feedback",
  })
}
