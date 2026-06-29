import { NextResponse } from "next/server"
import { requireSpcPagePermission } from "@/lib/spcAuth"
import { createSpcAuditContext } from "@/lib/spcAudit"
import { assignWhatsAppContact } from "@/lib/whatsapp"

export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  try {
    const session = await requireSpcPagePermission("spc-whatsapp", "edit")
    const auditContext = createSpcAuditContext(session, request, "spc-whatsapp")
    const body = (await request.json()) as {
      phone?: unknown
      displayName?: unknown
      company?: unknown
      contactId?: unknown
      assignedOrder?: unknown
      listType?: unknown
    }
    const phone = typeof body.phone === "string" ? body.phone.trim() : ""
    const displayName = typeof body.displayName === "string" ? body.displayName.trim() : ""
    const company = typeof body.company === "string" ? body.company.trim() : ""
    const contactId = typeof body.contactId === "string" ? body.contactId.trim() : ""
    const assignedOrder = Number(body.assignedOrder)
    const listType = body.listType === "buyer" ? "buyer" : "supplier"

    if (!phone) return NextResponse.json({ message: "Contact phone number is required." }, { status: 400 })

    const conversation = await assignWhatsAppContact({
      phone,
      displayName,
      company,
      contactId,
      assignedOrder: Number.isFinite(assignedOrder) ? assignedOrder : null,
      listType,
      auditContext,
    })

    return NextResponse.json({ success: true, conversation })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to assign WhatsApp contact."
    const status = message === "Unauthorized" ? 401 : message === "Forbidden" ? 403 : 500
    return NextResponse.json({ message }, { status })
  }
}
