import { NextResponse } from "next/server"
import { createAdminAuditContext } from "@/lib/adminAudit"
import { requireAdminPagePermission } from "@/lib/adminAuth"
import { unassignWhatsAppContact } from "@/lib/whatsapp"

export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  try {
    const session = await requireAdminPagePermission("whatsapp", "edit")
    const auditContext = createAdminAuditContext(session, request, "whatsapp")
    const body = (await request.json()) as { conversationId?: unknown; listType?: unknown }
    const conversationId = typeof body.conversationId === "string" ? body.conversationId.trim() : ""
    const listType = body.listType === "buyer" ? "buyer" : "supplier"

    if (!conversationId) {
      return NextResponse.json({ message: "Conversation id is required." }, { status: 400 })
    }

    const conversation = await unassignWhatsAppContact(conversationId, listType, auditContext)
    return NextResponse.json({ success: true, conversation })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to remove WhatsApp contact."
    const status = message === "Unauthorized" ? 401 : message === "Forbidden" ? 403 : 500
    return NextResponse.json({ message }, { status })
  }
}
