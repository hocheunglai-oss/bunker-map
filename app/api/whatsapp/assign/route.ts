import { NextResponse } from "next/server"
import { createAdminAuditContext } from "@/lib/adminAudit"
import { requireAdminPagePermission } from "@/lib/adminAuth"
import { assignWhatsAppContact } from "@/lib/whatsapp"

export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  try {
    const session = await requireAdminPagePermission("whatsapp", "edit")
    const auditContext = createAdminAuditContext(session, request, "whatsapp")
    const body = (await request.json()) as {
      phone?: unknown
      displayName?: unknown
      company?: unknown
      contactId?: unknown
    }
    const phone = typeof body.phone === "string" ? body.phone.trim() : ""
    const displayName = typeof body.displayName === "string" ? body.displayName.trim() : ""
    const company = typeof body.company === "string" ? body.company.trim() : ""
    const contactId = typeof body.contactId === "string" ? body.contactId.trim() : ""

    if (!phone) return NextResponse.json({ message: "Contact phone number is required." }, { status: 400 })

    const conversation = await assignWhatsAppContact({
      phone,
      displayName,
      company,
      contactId,
      auditContext,
    })

    return NextResponse.json({ success: true, conversation })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to assign WhatsApp contact."
    const status = message === "Unauthorized" ? 401 : message === "Forbidden" ? 403 : 500
    return NextResponse.json({ message }, { status })
  }
}
