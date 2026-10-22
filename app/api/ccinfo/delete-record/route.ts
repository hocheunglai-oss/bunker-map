import { NextResponse } from "next/server"
import { requireAdminPagePermission } from "@/lib/adminAuth"
import { createAdminAuditContext, createAdminAuditedSupabaseClient } from "@/lib/adminAudit"
import { CcinfoDeleteError, parseCcinfoDeleteReceipt, parseCcinfoDeleteRequest } from "@/lib/ccinfoDelete"
import { classifyCcinfoDeleteError } from "@/lib/ccinfoOperationErrors"

export const dynamic = "force-dynamic"
const reply = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } })
export async function POST(request: Request) {
  try {
    const session = await requireAdminPagePermission("ccinfo", "edit")
    const input = parseCcinfoDeleteRequest(await request.json().catch(() => null))
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return reply({ message: "The deletion service is unavailable. No deletion was confirmed." }, 503)
    const context = createAdminAuditContext(session, undefined, "ccinfo")
    const client = createAdminAuditedSupabaseClient(context, { useServiceRole: true })
    const { data, error } = await client.rpc("delete_ccinfo_record", {
      p_kind: input.kind, p_id: input.id, p_expected_updated_at: input.expectedUpdatedAt, p_delete_ports: input.deletePorts,
    })
    if (error) {
      const rejection = classifyCcinfoDeleteError(error)
      if (rejection === "conflict") return reply({ message: "The entry changed or was removed. Refresh it before deleting. Your draft is still here." }, 409)
      if (rejection === "unconfirmed") return reply({ code: "DELETE_UNCONFIRMED", message: "No entries were deleted. Keep your draft and try again." }, 409)
      if (error.code === "23514") return reply({ message: "Some ports need a country check before deletion. No entries were deleted." }, 409)
      if (["40P01", "55P03"].includes(error.code || "")) return reply({ message: "Another change is being saved. No entries were deleted; please retry shortly." }, 409)
      if (error.code === "22023") return reply({ message: "Check the entry and saved version before deleting." }, 400)
      return reply({ message: "The deletion could not be completed. No deletion was confirmed; keep your draft and refresh before retrying." }, 503)
    }
    return reply({ deletion: parseCcinfoDeleteReceipt(data, input) })
  } catch (error) {
    if (error instanceof CcinfoDeleteError) return reply({ message: error.message }, error.status)
    const message = error instanceof Error ? error.message : ""
    if (message === "Unauthorized" || message === "Forbidden") return reply({ message }, message === "Unauthorized" ? 401 : 403)
    return reply({ message: "The deletion could not be confirmed. Keep your draft and refresh the entry before retrying." }, 503)
  }
}
