import { NextResponse } from "next/server"
import { requireAdminPagePermissionForRequest } from "@/lib/adminAuth"
import { createAdminAuditContext, createAdminAuditedSupabaseClient } from "@/lib/adminAudit"
import {
  OUTLOOK_GROUP_CONFLICT_MESSAGE,
  OUTLOOK_GROUP_EDIT_FIELDS,
  isOutlookGroupVersion,
  isSavedOutlookGroup,
  normalizeOutlookGroupFields,
  validateOutlookGroupFields,
  type OutlookGroupFields,
} from "@/lib/outlookGroupValidation"

export const dynamic = "force-dynamic"

function reply(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } })
}

export async function POST(request: Request) {
  try {
    const session = await requireAdminPagePermissionForRequest(request, "outlook-addressbook", "edit")
    const body: unknown = await request.json().catch(() => null)
    if (!body || typeof body !== "object" || Array.isArray(body)) return reply({ message: "Check the group details before saving." }, 400)
    const input = body as Record<string, unknown>
    if (Object.keys(input).some(key => !["action", "id", "expectedUpdatedAt", "changes"].includes(key)) ||
        (input.action !== "save" && input.action !== "delete") ||
        typeof input.id !== "string" || !input.id.trim() || input.id.length > 2048 || /[\u0000-\u001f\u007f]/.test(input.id) ||
        !isOutlookGroupVersion(input.expectedUpdatedAt)) {
      return reply({ message: "Reload the group before saving. Your edits have not been saved." }, 400)
    }
    let changes: Partial<OutlookGroupFields> = {}
    if (input.action === "save") {
      if (!input.changes || typeof input.changes !== "object" || Array.isArray(input.changes)) return reply({ message: "Check the group details before saving." }, 400)
      const supplied = input.changes as Record<string, unknown>
      const keys = Object.keys(supplied)
      if (!keys.length || keys.some(key => !(OUTLOOK_GROUP_EDIT_FIELDS as readonly string[]).includes(key))) {
        return reply({ message: "Only group name, source book, nickname and description can be edited." }, 400)
      }
      const validation = validateOutlookGroupFields(supplied as Partial<OutlookGroupFields>, "update")
      if (validation) return reply({ message: validation }, 400)
      const normalized = normalizeOutlookGroupFields({ name: "", source_book: "", nickname: null, description: null, ...supplied } as OutlookGroupFields)
      changes = Object.fromEntries(keys.map(key => [key, normalized[key as keyof OutlookGroupFields]]))
    } else if (Object.prototype.hasOwnProperty.call(input, "changes")) {
      return reply({ message: "A group delete cannot include edited fields." }, 400)
    }
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return reply({ message: "The group service is unavailable. Your edits are still here." }, 503)
    // The authenticated editor and fixed page supply audit identity. Ignore
    // caller-provided identity/audit headers and Referer, and never upsert.
    const context = createAdminAuditContext(session, undefined, "outlook-addressbook")
    const client = createAdminAuditedSupabaseClient(context, { useServiceRole: true })
    const table = client.from("shared_addressbook_groups")
    const mutation = input.action === "save" ? table.update(changes) : table.delete()
    const { data, error } = await mutation.eq("id", input.id).eq("updated_at", input.expectedUpdatedAt).select("*").maybeSingle()
    if (error) {
      if (error.code === "PGRST116") return reply({ message: OUTLOOK_GROUP_CONFLICT_MESSAGE }, 409)
      if (["23505", "23514", "22023"].includes(error.code || "")) return reply({ message: "Check the group details. This change could not be saved." }, 400)
      return reply({ message: "The group change could not be verified. Your edits are still here; reload before retrying." }, 500)
    }
    if (!data) return reply({ message: OUTLOOK_GROUP_CONFLICT_MESSAGE }, 409)
    if (!isSavedOutlookGroup(data, input.id, input.action === "save" ? input.expectedUpdatedAt : undefined) ||
        (input.action === "delete" && data.updated_at !== input.expectedUpdatedAt) ||
        (input.action === "save" && Object.entries(changes).some(([key, value]) => data[key as keyof typeof data] !== value))) {
      return reply({ message: "The group change could not be verified. Your edits are still here; reload before retrying." }, 500)
    }
    if (input.action === "delete") return reply({ deleted: { id: data.id, updated_at: data.updated_at } })
    return reply({ group: data })
  } catch (error) {
    const message = error instanceof Error ? error.message : ""
    if (message === "Unauthorized" || message === "Forbidden") return reply({ message }, message === "Unauthorized" ? 401 : 403)
    return reply({ message: "The group change could not be verified. Your edits are still here; reload before retrying." }, 500)
  }
}
