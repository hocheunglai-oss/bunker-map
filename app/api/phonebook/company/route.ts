import { NextResponse } from "next/server"
import { requireAdminPagePermission } from "@/lib/adminAuth"
import { createAdminAuditContext, createAdminAuditedSupabaseClient } from "@/lib/adminAudit"
import { PHONEBOOK_COMPANY_CONFLICT, PHONEBOOK_UUID, validPhonebookCompanyVersion, validatePhonebookCompanySave } from "@/lib/phonebookCompanySave"

export const dynamic = "force-dynamic"
const headers = { "Cache-Control": "private, no-store" }
const reply = (message: string, status: number) => NextResponse.json({ message }, { status, headers })

export async function POST(request: Request) {
  try {
    const session = await requireAdminPagePermission("phonebook", "edit")
    const input = validatePhonebookCompanySave(await request.json().catch(() => null))
    if (!input) return reply("Check the company details and reopen the company before saving.", 400)
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return reply("Company saving is unavailable. Your edits are still here.", 503)
    const context = createAdminAuditContext(session, undefined, "phonebook")
    const supabase = createAdminAuditedSupabaseClient(context, { useServiceRole: true })
    const { data, error } = await supabase.rpc("save_phonebook_company", {
      p_id: input.id, p_expected_updated_at: input.expectedUpdatedAt, p_patch: input.patch,
    })
    if (error) {
      if (error.code === "40001") return reply(PHONEBOOK_COMPANY_CONFLICT, 409)
      if (["40P01", "55P03"].includes(error.code || "")) return reply("Another change is being saved. Please try again shortly.", 409)
      if (error.code === "23505") return reply("Another company already uses this name. Choose a different name.", 409)
      if (error.code === "23514") return reply("Some contacts have conflicting company links. No changes were saved; ask an administrator to check them.", 409)
      if (error.code === "22023") return reply("Check the company details and try again.", 400)
      return reply("The company could not be saved. Your edits are still here; reopen it before retrying.", 500)
    }
    if (!data?.company || data.company.id !== input.id || data.company.name !== input.patch.name
      || !validPhonebookCompanyVersion(data.company.updated_at) || data.company.updated_at === input.expectedUpdatedAt
      || !Array.isArray(data.contactIds) || data.contactIds.some((id: unknown) => typeof id !== "string" || !PHONEBOOK_UUID.test(id))
      || new Set(data.contactIds).size !== data.contactIds.length) {
      return reply("The save could not be verified. Reopen the company to check its saved details before retrying.", 500)
    }
    return NextResponse.json(data, { headers })
  } catch (error) {
    const message = error instanceof Error ? error.message : ""
    if (["Unauthorized", "Forbidden"].includes(message)) return reply(message, message === "Unauthorized" ? 401 : 403)
    return reply("The save could not be verified. Your edits are still here; reopen the company before retrying.", 500)
  }
}
