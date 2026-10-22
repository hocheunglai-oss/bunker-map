import { NextResponse } from "next/server"
import { requireAdminPagePermissionForRequest } from "@/lib/adminAuth"
import { createAdminAuditContext, createAdminAuditedSupabaseClient } from "@/lib/adminAudit"
import { confirmedTaiwanRemarksSave, parseTaiwanRemarksSave, TAIWAN_REMARKS_CONFLICT } from "@/lib/taiwanRemarksSave"
import { readPriceSetterJsonBody } from "@/lib/priceSetterRequest"

export const dynamic = "force-dynamic"
const headers = { "Cache-Control": "private, no-store" }
const reply = (body: unknown, status = 200) => NextResponse.json(body, { status, headers })

export async function POST(request: Request) {
  try {
    const session = await requireAdminPagePermissionForRequest(request, "taiwan-remarks", "edit")
    // Baselines come from the browser's reviewed load, never a server reread.
    const payload = await readPriceSetterJsonBody(request, 40 * 1_048_576).catch(() => null)
    if (!payload || typeof payload !== "object" || !("changes" in payload) || !Array.isArray(payload.changes) || payload.changes.some((row: unknown) => !row || typeof row !== "object" || !("expected" in row))) {
      return reply({ code: "REMARKS_CONFLICT", message: TAIWAN_REMARKS_CONFLICT }, 409)
    }
    let changes
    try { changes = parseTaiwanRemarksSave(payload) }
    catch { return reply({ message: "Check the notice wording and reload its saved version. Your draft is still here." }, 400) }
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) throw Error("Remarks service unavailable")
    const client = createAdminAuditedSupabaseClient(createAdminAuditContext(session, undefined, "taiwan-remarks"), { useServiceRole: true })
    const { data, error } = await client.rpc("save_taiwan_remarks", { p_changes: changes })
    if (error) {
      if (
        error.message === "The saved remarks changed. Keep the draft and reload." &&
        ((error.code === "P0001" && error.details === "TAIWAN_REMARKS_CONFLICT") || error.code === "40001")
      ) return reply({ code: "REMARKS_CONFLICT", message: TAIWAN_REMARKS_CONFLICT }, 409)
      if (
        ["The remark save could not be confirmed.", "The remark audit could not be confirmed. No changes were saved."].includes(error.message) &&
        ((error.code === "P0001" && error.details === "TAIWAN_REMARKS_UNCONFIRMED") || error.code === "40001")
      ) return reply({ code: "REMARKS_UNCONFIRMED", message: "No changes were saved. Your draft is still here; try again." }, 409)
      if (["40P01", "55P03"].includes(error.code || "")) return reply({ message: "Another save or backup is in progress. Your draft is still here; try again shortly." }, 409)
      if (error.code === "22023") return reply({ message: "Check the notice wording and reload its saved version. Your draft is still here." }, 400)
      throw Error("Remarks save unconfirmed")
    }
    if (!confirmedTaiwanRemarksSave(data, changes)) throw Error("Remarks confirmation incomplete")
    return reply(data)
  } catch (error) {
    const message = error instanceof Error ? error.message : ""
    if (message === "Unauthorized" || message === "Forbidden") return reply({ message }, message === "Unauthorized" ? 401 : 403)
    return reply({ message: "The save could not be confirmed. Your draft is still here; retry to check whether it was saved." }, 503)
  }
}
