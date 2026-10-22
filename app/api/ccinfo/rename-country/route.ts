import { NextResponse } from "next/server"
import { requireAdminPagePermission } from "@/lib/adminAuth"
import { createAdminAuditContext, createAdminAuditedSupabaseClient } from "@/lib/adminAudit"
import { CCINFO_CONFLICT_MESSAGE } from "@/lib/ccinfoSave"
import { isCcinfoCountryConflict } from "@/lib/ccinfoOperationErrors"

export const dynamic = "force-dynamic"

function reply(message: string, status: number) {
  return NextResponse.json({ message }, { status, headers: { "Cache-Control": "private, no-store" } })
}

function validVersion(value: unknown): value is string {
  if (typeof value !== "string") return false
  const parts = value.match(/^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?(?:Z|[+-](?:0\d|1[0-5]):[0-5]\d)$/)
  if (!parts || Number(parts[1]) < 1 || !Number.isFinite(Date.parse(value))) return false
  const date = new Date(0)
  date.setUTCFullYear(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]))
  return date.getUTCFullYear() === Number(parts[1]) && date.getUTCMonth() === Number(parts[2]) - 1 && date.getUTCDate() === Number(parts[3])
}

export async function POST(request: Request) {
  try {
    const session = await requireAdminPagePermission("ccinfo", "edit")
    const body: unknown = await request.json().catch(() => null)
    if (!body || typeof body !== "object" || Array.isArray(body)) return reply("Check the country name and try again.", 400)
    const input = body as Record<string, unknown>
    const name = typeof input.name === "string" ? input.name.trim().toUpperCase() : ""
    if (Object.keys(input).some((key) => !["id", "expectedUpdatedAt", "name"].includes(key)) ||
      typeof input.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.id) ||
      !validVersion(input.expectedUpdatedAt) || !name || Array.from(name).length > 200 || /[\u0000-\u001f\u007f-\u009f]/.test(name)) {
      return reply("Check the country name and try again.", 400)
    }
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return reply("The rename service is unavailable. Your edits are still here.", 503)
    const id = input.id.toLowerCase()
    // Ignore client identity, audit headers and Referer. This operation belongs
    // only to the signed-in user's CCINFO edit permission.
    const context = createAdminAuditContext(session, undefined, "ccinfo")
    const supabase = createAdminAuditedSupabaseClient(context, { useServiceRole: true })
    const { data, error } = await supabase.rpc("rename_ccinfo_country", {
      p_id: id, p_expected_updated_at: input.expectedUpdatedAt, p_name: name,
    })
    if (error) {
      if (isCcinfoCountryConflict(error)) return reply(CCINFO_CONFLICT_MESSAGE, 409)
      if (["40P01", "55P03"].includes(error.code || "")) return reply("Another change is being saved. No rename was saved; please try again shortly.", 409)
      if (error.code === "23505") return reply("Another country already uses this name. Please choose a different name.", 400)
      if (error.code === "23514") return reply("Some ports need a country check before this rename. No changes were saved.", 409)
      if (error.code === "22023") return reply("Check the country name and try again.", 400)
      return reply("The rename could not be completed. Your edits are still here. Reopen the country before retrying.", 500)
    }
    if (!data || data.id !== id || data.name !== name || !validVersion(data.updated_at) || data.updated_at === input.expectedUpdatedAt) {
      return reply("The rename could not be verified. Reopen the country to check its saved name before retrying.", 500)
    }
    return NextResponse.json({ record: { id: data.id, name: data.name, updated_at: data.updated_at } }, { headers: { "Cache-Control": "private, no-store" } })
  } catch (error) {
    const message = error instanceof Error ? error.message : ""
    if (message === "Unauthorized" || message === "Forbidden") return reply(message, message === "Unauthorized" ? 401 : 403)
    return reply("The rename could not be verified. Your edits are still here. Reopen the country before retrying.", 500)
  }
}
